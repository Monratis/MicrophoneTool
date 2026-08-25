import { EventEmitter } from 'node:events';
import type RadarListener from './radarListener';
import type AudioController from './audioController';
import type DiscordIntegration from './discordIntegration';
import type SignalRGBIntegration from './signalrgbIntegration';
import type Config from './config';
import type { AppMode, DeviceState, DeskState } from '../shared/types';

/**
 * Spina radar z kontrolerem audio, integracją z Discordem, SignalRGB oraz
 * konfigurowalnymi zachowaniami stacjonarnymi/mobilnymi.
 */
export default class AppController extends EventEmitter {
  radar: RadarListener;
  audio: AudioController;
  config: Config;
  discord: DiscordIntegration | null;
  signalrgb: SignalRGBIntegration | null;

  mode: AppMode = 'auto';
  currentDevice: DeviceState | null = null;
  switching = false;
  private pendingState: DeviceState | null = null;
  private displaySleepTimer: NodeJS.Timeout | null = null;
  private isDisplaySleeping = false;
  private micRetryTimer: NodeJS.Timeout | null = null;
  private micRetryState: DeviceState | null = null;
  private micRetryAttempts = 0;
  private readonly MIC_RETRY_MS = 5000;
  /** Mikrofony wyciszone PRZEZ APLIKACJĘ przy odejściu — tylko te odciszamy przy powrocie */
  private readonly mutedByApp = new Set<string>();
  private driftTimer: NodeJS.Timeout | null = null;
  private lastDeviceSig: string | null = null;
  private prevDeviceIds: Set<string> | null = null;
  private desiredTarget: string | null = null;
  private desiredName: string | null = null;
  private desiredState: DeviceState | null = null;
  /** Stan, którego przełączenie FAKTYCZNIE się powiodło (watchdog działa tylko dla niego) */
  private lastAppliedOkState: DeviceState | null = null;

  constructor(
    radar: RadarListener,
    audio: AudioController,
    config: Config,
    discord: DiscordIntegration | null = null,
    signalrgb: SignalRGBIntegration | null = null
  ) {
    super();
    this.radar = radar;
    this.audio = audio;
    this.config = config;
    this.discord = discord;
    this.signalrgb = signalrgb;

    radar.on('desk', () => void this.onRadarState('desk'));
    radar.on('away', () => void this.onRadarState('away'));
    radar.on('status', (s) => this.emit('radarStatus', s));
    radar.on('error', (err) => this.emit('error', err));
  }

  async start(): Promise<void> {
    if (this.discord) {
      this.discord.start();
    }
    await this.radar.start();
  }

  async stop(): Promise<void> {
    this.clearDisplaySleepTimer();
    this.clearMicRetry();
    this.stopDriftWatch();
    if (this.discord) {
      this.discord.stop();
    }
    await this.radar.stop();
  }

  /**
   * Watchdog domyślnego mikrofonu: Windows potrafi po ponownym wykryciu
   * urządzenia (replug USB, budzenie) sam przestawić default lub rolę
   * komunikacyjną. Sprawdzamy co 10 s, ale reagujemy TYLKO gdy zmieniła się
   * lista urządzeń — świadoma zmiana użytkownika w Windows nie jest cofana.
   */
  private startDesiredWatch(state: DeviceState, displayName: string, target: string): void {
    this.desiredState = state;
    this.desiredName = displayName;
    this.desiredTarget = target;
    if (!this.driftTimer) {
      this.driftTimer = setInterval(() => void this.checkDrift(), 10000);
    }
  }

  private stopDriftWatch(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    this.lastDeviceSig = null;
    this.prevDeviceIds = null;
    this.desiredTarget = null;
    this.desiredName = null;
    this.desiredState = null;
  }

  private async checkDrift(): Promise<void> {
    if (!this.desiredTarget || !this.desiredState || !this.desiredName) return;
    // Watchdog działa wyłącznie gdy: (1) ostatnie przełączenie tego stanu
    // się powiodło, (2) użytkownik NIE wyłączył automatów dla tej strony.
    if (this.lastAppliedOkState !== this.desiredState) return;
    const shouldSwitchNow =
      this.desiredState === 'desk'
        ? this.config.get('switchMicOnDesk') !== false
        : this.config.get('switchMicOnAway') !== false;
    if (!shouldSwitchNow) return;
    try {
      const list = await this.audio.listRecordingDevices(true);
      const ids = new Set(list.map((d) => d.id || d.name));
      // Nowe urządzenie = kandydat na "auto-podkradnięcie" defaultu przez Windows
      let hasArrival = false;
      if (this.prevDeviceIds) {
        for (const id of ids) {
          if (!this.prevDeviceIds.has(id)) {
            hasArrival = true;
            break;
          }
        }
      }
      const sig = Array.from(ids).sort().join('|');
      const changed = this.lastDeviceSig !== null && sig !== this.lastDeviceSig;
      this.lastDeviceSig = sig;
      this.prevDeviceIds = ids;
      if (!changed || !hasArrival) return;

      const present = list.some((d) => d.id === this.desiredTarget || d.name === this.desiredName);
      if (!present) return;

      const current = await this.audio.getCurrentDefault();
      if (!current || !current.id) return;

      // Cofamy TYLKO gdy nowy przybysz podkradł default (automat Windowsa).
      // Świadoma zmiana użytkownika na istniejące urządzenie — nienaruszalna.
      const stolenByArrival =
        current.id !== this.desiredTarget && current.id !== this.desiredName && !this.prevDeviceIds.has(current.id);
      const lostCommRole = current.id === this.desiredTarget && current.isDefaultComm === false;
      if (!stolenByArrival && !lostCommRole) return;

      console.log(
        `[controller] Windows przestawił domyślny mikrofon (${stolenByArrival ? current.name : 'utrata roli comm'}) — przywracam ${this.desiredName}`
      );
      const res = await this.audio.setDefaultRecordingDevice(this.desiredTarget);
      // Pełna sekwencja zdarzeń jak przy zwykłym przełączeniu — chime też
      if (res.ok && this.desiredState) {
        this.emit('switch', { state: this.desiredState, device: this.desiredName, switched: true });
      }
      this.emit('switched', { state: this.desiredState, device: this.desiredName, ok: res.ok, switched: true });
    } catch {
      /* pomijanie cyklu — kolejny tick spróbuje ponownie */
    }
  }

  private clearMicRetry(): void {
    if (this.micRetryTimer) {
      clearTimeout(this.micRetryTimer);
      this.micRetryTimer = null;
    }
    this.micRetryState = null;
    this.micRetryAttempts = 0;
  }

  /**
   * Trzymanie się wybranego mikrofonu: gdy urządzenie jest chwilowo odłączone,
   * ponawiaj próbę co 5 s aż wróci — wtedy przełącz i wróć do normalnej pracy.
   */
  private scheduleMicRetry(state: DeviceState, displayName: string, target: string): void {
    if (this.micRetryState === state && this.micRetryTimer) return;
    this.clearMicRetry();
    this.micRetryState = state;
    this.micRetryAttempts = 0;

    const attempt = async (): Promise<void> => {
      this.micRetryTimer = null;
      // Rezygnuj gdy użytkownik wymusił inny tryb w międzyczasie
      if (this.mode !== 'auto' && this.mode !== state) {
        this.micRetryState = null;
        return;
      }
      // Nie ścigaj się z bieżącym applyDevice — przełóż próbę
      if (this.switching) {
        this.micRetryTimer = setTimeout(attempt, this.MIC_RETRY_MS);
        return;
      }
      this.micRetryAttempts++;
      // Backoff: nieobecne urządzenie potrafi być nieobecne długo
      // (słuchawki w plecaku) — nie meczemy COM co 5 s cały dzień.
      const delay = Math.min(this.MIC_RETRY_MS * Math.pow(2, this.micRetryAttempts - 1), 30000);
      try {
        const list = await this.audio.listRecordingDevices(true);
        const present = list.some((d) => d.id === target || d.name === target);
        if (!present) {
          this.micRetryTimer = setTimeout(attempt, delay);
          return;
        }
        const res = await this.audio.setDefaultRecordingDevice(target);
        if (!res.ok) {
          this.micRetryTimer = setTimeout(attempt, delay);
          return;
        }
        const retriedState = this.micRetryState;
        this.clearMicRetry();
        if (retriedState) {
          this.lastAppliedOkState = retriedState;
          this.emit('switch', { state: retriedState, device: displayName, switched: true });
          this.emit('switched', { state: retriedState, device: displayName, ok: true });
          this.startDesiredWatch(retriedState, displayName, target);
          this.applyDiscordGate(retriedState);
        }
      } catch {
        this.micRetryTimer = setTimeout(attempt, delay);
      }
    };

    this.micRetryTimer = setTimeout(attempt, this.MIC_RETRY_MS);
  }

  setMode(mode: AppMode): void {
    if (!['auto', 'desk', 'headset'].includes(mode)) return;
    this.mode = mode;
    this.emit('mode', mode);
    if (mode !== 'auto') {
      void this.applyDevice(mode === 'desk' ? 'desk' : 'headset');
    } else if (this.radar.state) {
      void this.applyDevice(this.radar.state === 'desk' ? 'desk' : 'headset');
    }
  }

  private async onRadarState(state: DeskState): Promise<void> {
    if (this.mode !== 'auto') return;
    await this.applyDevice(state === 'desk' ? 'desk' : 'headset');
  }

  private clearDisplaySleepTimer(): void {
    if (this.displaySleepTimer) {
      clearTimeout(this.displaySleepTimer);
      this.displaySleepTimer = null;
    }
  }

  /**
   * Po ręcznym teście urządzenia ("▶ Przetestuj") aplikuj jego profil:
   * głośność + ustawienia głosowe Discorda — jak przy prawdziwym przełączeniu.
   */
  applyProfileForDevice(deviceName: string): void {
    if (!deviceName) return;
    const state: DeviceState =
      deviceName === this.config.get('micDeskName') ? 'desk' : 'headset';
    const volCfg = state === 'desk' ? this.config.get('micDeskVolume') : this.config.get('micHeadsetVolume');
    if (typeof volCfg === 'number' && volCfg >= 0) {
      void this.audio.setVolume(deviceName, volCfg);
    }
    this.applyDiscordGate(state);
  }

  /** Dopasowuje profil głosowy Discorda do specyfiki aktywnego mikrofonu. */
  private applyDiscordGate(state: DeviceState): void {    if (!this.discord || !this.config.get('discordGateFollowMic')) return;
    const rawGate = state === 'desk' ? this.config.get('micDeskGateDb') : this.config.get('micHeadsetGateDb');
    const krispRaw = state === 'desk' ? this.config.get('micDeskKrisp') : this.config.get('micHeadsetKrisp');
    const agcRaw = state === 'desk' ? this.config.get('micDeskAgc') : this.config.get('micHeadsetAgc');
    const echoRaw = state === 'desk' ? this.config.get('micDeskEcho') : this.config.get('micHeadsetEcho');
    const tri = (v: string | undefined): boolean | undefined => (v === 'on' ? true : v === 'off' ? false : undefined);
    // gate < 0 = "nie ustawione" — NIE wysyłamy obiektu mode, żeby nie
    // nadpisać trybu użytkownika (np. Push-to-Talk) ani auto-progu Discorda.
    const gate = typeof rawGate === 'number' && rawGate >= 0 ? rawGate : undefined;
    void this.discord.applyMicSettings({
      gateDb: gate,
      krisp: tri(krispRaw),
      agc: tri(agcRaw),
      echo: tri(echoRaw)
    });
  }

  private async applyDevice(state: DeviceState): Promise<void> {
    const stationaryMic = this.config.get('micDeskName');
    const mobileMic = this.config.get('micHeadsetName');

    // 1. Obsługa usypiania i wybudzania ekranów
    if (state === 'desk') {
      this.clearDisplaySleepTimer();
      const shouldWake = this.config.get('wakeMonitorsOnDesk') !== false;
      // Wybudzaj tylko gdy ekrany faktycznie uśpione (wcześniej budzono przy
      // każdym powrocie na desk, gdy tylko sleepMonitorsOnAway był włączony).
      if (shouldWake && this.isDisplaySleeping) {
        this.isDisplaySleeping = false;
        // Równolegle do przełączenia mikrofonu — wybudzanie monitora
        // (spawn procesu = setki ms) NIE może blokować switcha.
        void this.audio
          .wakeDisplay()
          .then(() => this.emit('displayState', 'wake'))
          .catch(() => {});
      }

      if (this.signalrgb) {
        void this.signalrgb.onDesk();
      }
    } else {
      this.clearDisplaySleepTimer();
      if (this.config.get('sleepMonitorsOnAway')) {
        const delay = Math.max(1000, Number(this.config.get('sleepMonitorsDelayMs')) || 15000);
        this.displaySleepTimer = setTimeout(() => {
          this.displaySleepTimer = null;
          this.isDisplaySleeping = true;
          void this.audio.sleepDisplay().then(() => this.emit('displayState', 'sleep'));
        }, delay);
      }

      if (this.signalrgb) {
        void this.signalrgb.onAway();
      }
    }

    // 2. Obsługa przełączania i wyciszania mikrofonów
    if (this.currentDevice === state) return;
    if (this.switching) {
      this.pendingState = state;
      return;
    }
    this.switching = true;
    this.currentDevice = state;

    const targetMic = state === 'desk' ? stationaryMic : mobileMic;
    // Preferuj ID endpointu — stabilne nawet gdy Windows zmieni nazwę urządzenia
    const targetId = state === 'desk' ? this.config.get('micDeskId') : this.config.get('micHeadsetId');
    const target = targetId && targetId.trim() ? targetId.trim() : targetMic;
    const shouldSwitch =
      state === 'desk'
        ? this.config.get('switchMicOnDesk') !== false
        : this.config.get('switchMicOnAway') !== false;

    if (!targetMic) {
      this.emit('switch', { state, device: null, switched: false, unconfigured: true });
      this.switching = false;
      return;
    }

    this.emit('switch', { state, device: targetMic, switched: shouldSwitch });

    try {
      let ok = true;
      if (shouldSwitch && targetMic) {
        const res = await this.audio.setDefaultRecordingDevice(target);
        ok = res.ok;
        // Urządzenie chwilowo nieobecne → trzymaj się wyboru i ponawiaj aż wróci
        if (!ok) {
          this.lastAppliedOkState = null;
          this.scheduleMicRetry(state, targetMic, target);
        } else {
          this.lastAppliedOkState = state;
          this.clearMicRetry();
          this.startDesiredWatch(state, targetMic, target);
          this.applyDiscordGate(state);
        }
      }

      // Głośność wybranego mikrofonu (jeśli skonfigurowana)
      const volCfg = state === 'desk' ? this.config.get('micDeskVolume') : this.config.get('micHeadsetVolume');
      if (targetMic && typeof volCfg === 'number' && volCfg >= 0) {
        void this.audio.setVolume(targetMic, volCfg);
      }

      // Operacje mute niezależne od siebie → równolegle (jeden round-trip
      // daemona zamiast łańcuszka sekwencyjnych).
      // GATE: gdy użytkownik wyłączył automatyczne przełączanie po danej
      // stronie, nie dotykamy też wyciszeń — apka w ogóle nie ingeruje.
      const muteTasks: Promise<unknown>[] = [];

      if (shouldSwitch) {
        if (state === 'desk') {
        // Odciszamy WYŁĄCZNIE to, co sama wyciszyłyśmy przy odejściu.
        // Ręczny mute użytkownika (Discord/spotkanie) jest nienaruszalny —
        // auto-odciszanie go to pułapka gorącego mikrofonu.
        const muteMode = this.config.get('muteBehaviorOnAway') || 'mute_inactive';
        if (this.config.get('unmuteOnDesk') !== false && muteMode !== 'none' && this.mutedByApp.size > 0) {
          for (const name of Array.from(this.mutedByApp)) {
            muteTasks.push(
              this.audio.setMute(name, false).catch(() => {
                /* urządzenie mogło zniknąć */
              })
            );
          }
        }
        this.mutedByApp.clear();

        // Para mikrofonów: aktywny stacjonarny → wycisz mobilny
        if (muteMode !== 'none' && mobileMic && mobileMic !== stationaryMic) {
          muteTasks.push(
            this.audio.setMute(mobileMic, true).then(() => {
              this.mutedByApp.add(mobileMic);
            })
          );
        }
      } else {
        const muteMode = this.config.get('muteBehaviorOnAway') || 'mute_inactive';
        // Aktywny mobilny → wycisz stacjonarny (domyślna polityka pary)
        if ((muteMode === 'mute_inactive' || muteMode === 'mute_stationary') && stationaryMic && stationaryMic !== mobileMic) {
          muteTasks.push(
            this.audio.setMute(stationaryMic, true).then(() => {
              this.mutedByApp.add(stationaryMic);
            })
          );
        } else if (muteMode === 'mute_all') {
          for (const name of [stationaryMic, mobileMic]) {
            if (!name) continue;
            muteTasks.push(
              this.audio.setMute(name, true).then(() => {
                this.mutedByApp.add(name);
              })
            );
          }
        }
      }
      }
      await Promise.all(muteTasks);

      if (this.discord) {
        void this.discord.notifyDeviceChanged(targetMic);
      }

      this.emit('switched', { state, device: targetMic, ok, switched: shouldSwitch });
    } catch (err) {
      this.emit('error', err as Error);
    } finally {
      this.switching = false;
      if (this.pendingState && this.pendingState !== this.currentDevice) {
        const pending = this.pendingState;
        this.pendingState = null;
        void this.applyDevice(pending);
      }
    }
  }
}
