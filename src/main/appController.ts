import { EventEmitter } from 'node:events';
import { appendLog } from './logger';
import { recordDiagTimelineEvent } from './diagSession';
import type RadarListener from './radarListener';
import type AudioController from './audioController';
import type DiscordIntegration from './discordIntegration';
import type SignalRGBIntegration from './signalrgbIntegration';
import type HomeAssistantIntegration from './haIntegration';
import type ScreenManager from './screenManager';
import type Config from './config';
import type { AppMode, DeviceState, DeskState } from '../shared/types';

/**
 * Spina radar z kontrolerem audio, integracją z Discordem, SignalRGB oraz
 * konfigurowalnymi zachowaniami stacjonarnymi/mobilnymi i zarządzaniem ekranami.
 */
export default class AppController extends EventEmitter {
  radar: RadarListener;
  audio: AudioController;
  config: Config;
  screen: ScreenManager;
  discord: DiscordIntegration | null;
  signalrgb: SignalRGBIntegration | null;
  ha: HomeAssistantIntegration | null;

  mode: AppMode = 'auto';
  currentDevice: DeviceState | null = null;
  switching = false;
  /** Unix ms — do kiedy trwa pauza automatyki (snooze z UI); 0 = brak pauzy. */
  private snoozeUntilMs = 0;
  private pendingState: DeviceState | null = null;
  private micRetryTimer: NodeJS.Timeout | null = null;
  private micRetryState: DeviceState | null = null;
  private micRetryAttempts = 0;
  private readonly MIC_RETRY_MS = 5000;
  private driftTimer: NodeJS.Timeout | null = null;
  private lastDeviceSig: string | null = null;
  private prevDeviceIds: Set<string> | null = null;
  private desiredTarget: string | null = null;
  private desiredName: string | null = null;
  private desiredState: DeviceState | null = null;
  /** Stan, którego przełączenie FAKTYCZNIE się powiodło (watchdog działa tylko dla niego) */
  private lastAppliedOkState: DeviceState | null = null;
  /** Mikrofony wyciszone RĘCZNIE przez użytkownika — auto-przełączanie ich nie odcisza (ochrona przed gorącym mikrofonem) */
  private readonly userMuted = new Set<string>();
  /** Głośność (%) sprzed wyciszenia strategią "głośność 0%" — klucz: nazwa urządzenia */
  private readonly preMuteVolume = new Map<string, number>();

  constructor(
    radar: RadarListener,
    audio: AudioController,
    config: Config,
    screen: ScreenManager,
    discord: DiscordIntegration | null = null,
    signalrgb: SignalRGBIntegration | null = null,
    ha: HomeAssistantIntegration | null = null
  ) {
    super();
    this.radar = radar;
    this.audio = audio;
    this.config = config;
    this.screen = screen;
    this.discord = discord;
    this.signalrgb = signalrgb;
    this.ha = ha;

    radar.on('desk', () => void this.onRadarState('desk'));
    radar.on('away', () => void this.onRadarState('away'));
    radar.on('status', (s) => this.emit('radarStatus', s));
    radar.on('error', (err) => this.emit('error', err));

    this.screen.on('displayState', (s) => this.emit('displayState', s));
    this.screen.on('userActivity', () => {
      if (this.mode !== 'auto') {
        // W trybie wymuszonym radar nie odpala applyDevice, więc nikt inny
        // nie zdejmie wygaszacza — aktywność użytkownika robi to bezpośrednio.
        this.screen.hideScreensaver();
        return;
      }
      void this.onRadarState('desk');
    });

    if (this.discord) {
      this.discord.on('authenticated', () => {
        if (this.currentDevice) {
          this.applyDiscordGate(this.currentDevice);
          const targetMic =
            this.currentDevice === 'desk'
              ? this.config.get('micDeskName')
              : this.config.get('micHeadsetName');
          void this.syncDiscordDevice(targetMic);
        }
      });
    }
  }

  /**
   * Synchronizacja wejścia Discorda z bieżącym mikrofonem. Porażka (brak
   * połączenia RPC, odrzucenie przez Discord) jest emitowana jako zdarzenie
   * 'discordSyncError' — index.ts pokazuje ją jako toast w UI.
   */
  private async syncDiscordDevice(deviceName: string | null): Promise<void> {
    if (!this.discord) return;
    const res = await this.discord.notifyDeviceChanged(deviceName);
    if (!res.ok) {
      this.emit('discordSyncError', { reason: res.reason, device: deviceName });
    }
  }

  async start(): Promise<void> {
    if (this.discord) {
      this.discord.start();
    }
    // Wykryj aktualnie aktywny mikrofon w Windows przy starcie aplikacji
    try {
      const def = await this.audio.getCurrentDefault();
      if (def?.name) {
        const stationaryMic = this.config.get('micDeskName') || '';
        const mobileMic = this.config.get('micHeadsetName') || '';
        const deskName = stationaryMic.trim().toLowerCase();
        const headName = mobileMic.trim().toLowerCase();
        const curName = def.name.toLowerCase();
        if (deskName && (curName.includes(deskName) || deskName.includes(curName))) {
          this.currentDevice = 'desk';
          this.lastAppliedOkState = 'desk';
          this.startDesiredWatch('desk', def.name, def.name);
          const volCfg = this.config.get('micDeskVolume');
          if (typeof volCfg === 'number' && volCfg >= 0) {
            void this.setDeviceVolume(def.name, volCfg);
          }
          if (this.config.get('unmuteOnDesk') !== false) {
            this.userMuted.delete(def.name);
            void this.applyDeviceMute(def.name, false);
            if (this.discord) {
              void this.discord.setInputMute(false).catch(() => false);
            }
          }
          if (mobileMic && mobileMic !== stationaryMic) {
            void this.applyDeviceMute(mobileMic, true);
          }
          this.applyDiscordGate('desk');
        } else if (headName && (curName.includes(headName) || headName.includes(curName))) {
          this.currentDevice = 'headset';
          this.lastAppliedOkState = 'headset';
          this.startDesiredWatch('headset', def.name, def.name);
          const volCfg = this.config.get('micHeadsetVolume');
          if (typeof volCfg === 'number' && volCfg >= 0 && !this.preMuteVolume.has(def.name)) {
            void this.setDeviceVolume(def.name, volCfg);
          }
          const awayMute = this.config.get('muteBehaviorOnAway') || 'mute_inactive';
          if (awayMute === 'none') {
            void this.applyDeviceMute(def.name, false);
          } else if (awayMute === 'mute_all') {
            void this.applyDeviceMute(def.name, true);
            if (stationaryMic) void this.applyDeviceMute(stationaryMic, true);
          } else {
            void this.applyDeviceMute(def.name, false);
            if (stationaryMic && stationaryMic !== mobileMic) {
              void this.applyDeviceMute(stationaryMic, true);
            }
          }
          this.applyDiscordGate('headset');
        }
      }
    } catch {
      /* ignore */
    }
    await this.radar.start();
  }

  async stop(): Promise<void> {
    this.screen.stop();
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
    this.manualSyncedDeviceId = null;
  }

  /** Urządzenie, dla którego ostatnio wysłano sync po ręcznej zmianie — blokada duplikatów co 10 s. */
  private manualSyncedDeviceId: string | null = null;

  /**
   * Wykrywa ręczną zmianę domyślnego mikrofonu w Windows (default różni się
   * od aplikowanego przez apkę, lista urządzeń bez zmian) i synchronizuje
   * Discord z wyborem użytkownika.
   */
  private async syncManualMicChange(): Promise<void> {
    if (this.switching) return;
    try {
      const current = await this.audio.getCurrentDefault();
      if (!current || !current.id) return;
      if (current.id === this.desiredTarget || current.name === this.desiredName) return;
      if (this.manualSyncedDeviceId === current.id) return;
      this.manualSyncedDeviceId = current.id;
      appendLog('AUDIO', `Ręczna zmiana domyślnego mikrofonu w Windows -> "${current.name}" — synchronizuję Discord`);
      void this.syncDiscordDevice(current.name ?? null);
    } catch {
      /* pomijanie cyklu — kolejny tick spróbuje ponownie */
    }
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
      // Zbiór sprzed tej iteracji — dopiero względem NIEGO da się wykryć przybysza
      const prevIds = this.prevDeviceIds;
      // Nowe urządzenie = kandydat na "auto-podkradnięcie" defaultu przez Windows
      let hasArrival = false;
      if (prevIds) {
        for (const id of ids) {
          if (!prevIds.has(id)) {
            hasArrival = true;
            break;
          }
        }
      }
      const sig = Array.from(ids).sort().join('|');
      const changed = this.lastDeviceSig !== null && sig !== this.lastDeviceSig;
      this.lastDeviceSig = sig;
      this.prevDeviceIds = ids;
      if (!changed) {
        // Lista urządzeń bez zmian — jedyna możliwa rozbieżność defaultu
        // to RĘCZNA zmiana użytkownika w Windows. Wyboru nie cofamy,
        // ale Discord ma dostać info o nowym aktywnym mikrofonie.
        await this.syncManualMicChange();
        return;
      }
      if (!hasArrival) return;

      const present = list.some((d) => d.id === this.desiredTarget || d.name === this.desiredName);
      if (!present) return;

      const current = await this.audio.getCurrentDefault();
      if (!current || !current.id) return;

      // Cofamy TYLKO gdy nowy przybysz podkradł default (automat Windowsa),
      // czyli default NIE jest żadnym znanym wcześniej urządzeniem.
      // Świadoma zmiana użytkownika na istniejące urządzenie — nienaruszalna.
      const stolenByArrival =
        current.id !== this.desiredTarget &&
        current.id !== this.desiredName &&
        prevIds !== null &&
        !prevIds.has(current.id);
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
    appendLog('APP-MODE', `Zmiana trybu pracy aplikacji na: ${mode.toUpperCase()}`);
    this.emit('mode', mode);
    if (mode !== 'auto') {
      void this.applyDevice(mode === 'desk' ? 'desk' : 'headset');
    } else if (this.radar.state) {
      void this.applyDevice(this.radar.state === 'desk' ? 'desk' : 'headset');
    }
  }

  /**
   * Pauza automatyki (snooze z UI): do upływu terminu radarowe zmiany stanu
   * są ignorowane — żadne przełączenie mikrofonu, ekranów czy diody nie
   * nastąpi z automatu. Ręczne akcje (tryb, test urządzenia, mute) działają.
   */
  setSnooze(minutes: number): void {
    const m = Math.max(0, Math.min(720, Math.round(minutes || 0)));
    this.snoozeUntilMs = m > 0 ? Date.now() + m * 60000 : 0;
    appendLog(
      'APP',
      m > 0
        ? `Pauza automatyki na ${m} min — radar nie będzie przełączał profili`
        : 'Pauza automatyki wyłączona — wznawiam reakcję na radar'
    );
  }

  isSnoozed(): boolean {
    return this.snoozeUntilMs > Date.now();
  }

  /** Aktualny koniec pauzy automatyki (unix ms); 0 = pauza nieaktywna. */
  getSnoozeUntil(): number {
    return this.isSnoozed() ? this.snoozeUntilMs : 0;
  }

  private async onRadarState(state: DeskState): Promise<void> {
    appendLog('RADAR-EVENT', `Radar zgłasza zmianę stanu -> ${state === 'desk' ? 'OBECNY (DESK)' : 'POZA FOTELEM (AWAY)'}`);
    if (this.isSnoozed()) {
      appendLog('RADAR-EVENT', `Pauza automatyki aktywna — pomijam przełączenie na "${state.toUpperCase()}"`);
      return;
    }
    if (this.mode !== 'auto') {
      appendLog('RADAR-EVENT', `Ignoruję zmianę z radaru, ponieważ tryb aplikacji jest wymuszony na "${this.mode.toUpperCase()}"`);
      return;
    }
    await this.applyDevice(state === 'desk' ? 'desk' : 'headset');
  }

  /**
   * Po ręcznym teście urządzenia ("▶ Przetestuj") aplikuj jego profil:
   * głośność + ustawienia głosowe Discorda — jak przy prawdziwym przełączeniu.
   */
  applyProfileForDevice(deviceName: string): void {
    if (!deviceName) return;
    const deskName = (this.config.get('micDeskName') || '').trim().toLowerCase();
    const isDesk = Boolean(
      deskName && (deviceName.toLowerCase().includes(deskName) || deskName.includes(deviceName.toLowerCase()))
    );
    const state: DeviceState = isDesk ? 'desk' : 'headset';
    this.currentDevice = state;
    this.lastAppliedOkState = state;
    this.startDesiredWatch(state, deviceName, deviceName);
    const volCfg = state === 'desk' ? this.config.get('micDeskVolume') : this.config.get('micHeadsetVolume');
    if (typeof volCfg === 'number' && volCfg >= 0) {
      void this.setDeviceVolume(deviceName, volCfg);
    }
    if (this.discord) {
      void this.syncDiscordDevice(deviceName).then(() => {
        void this.applyDiscordGate(state);
      });
    }
  }

  /**
   * Głośność mikrofonu: najpierw OS (daemon/SVV), a gdy urządzenie (np. BT headset)
   * nie wspiera IAudioEndpointVolume (E_NOINTERFACE) — fallback do głośności wejścia
   * w Discordzie (działa przez pipeline WebRTC).
   */
  async setDeviceVolume(target: string, percent: number): Promise<{ ok: boolean; volume?: number }> {
    // Podniesienie głośności na mikrofonie wyciszonym strategią 0% = jawne odciszenie
    if (percent > 0 && this.preMuteVolume.has(target)) {
      this.preMuteVolume.delete(target);
      this.userMuted.delete(target);
      if (this.discord) void this.discord.setInputMute(false).catch(() => false);
      appendLog('AUDIO-VOL', `Zmiana głośności na wyciszonym (0%) mikrofonie "${target}" — traktuję jako odciszenie`);
    }
    const res = await this.audio.setVolume(target, percent);
    if (!res.ok && this.discord) {
      const ok = await this.discord.applyInputVolume(percent);
      return ok ? { ok: true, volume: percent } : res;
    }
    return res;
  }

  /** Mute mikrofonu: OS, potem strategia "głośność 0%" (urządzenia bez węzła
   * mute w KS), a na końcu fallback do Discorda. */
  async setDeviceMute(target: string, mute: boolean): Promise<{ ok: boolean; isMuted?: boolean }> {
    const via = await this.applyDeviceMute(target, mute);
    if (via) {
      this.trackManualMute(target, mute);
      await this.linkPairMute(target, mute);
      if (this.discord && (via === 'volume' || !mute)) {
        // Warstwa Discord przy mute głośnością lub odciszeniu:
        // przy mute=false zawsze zdejmujemy mute z Discorda, przy mute=true chronimy przed AGC
        await this.discord.setInputMute(mute).catch(() => false);
      }
      return { ok: true, isMuted: mute };
    }
    if (this.discord) {
      const ok = await this.discord.setInputMute(mute);
      if (ok) {
        this.trackManualMute(target, mute);
        await this.linkPairMute(target, mute);
        return { ok: true, isMuted: mute };
      }
    }
    return { ok: false };
  }

  /** OS mute; gdy urządzenie nie wspiera mute (E_NOINTERFACE) — strategia głośność-0. */
  private async applyDeviceMute(target: string, mute: boolean): Promise<'os' | 'volume' | null> {
    if (mute && !this.preMuteVolume.has(target)) {
      const cur = await this.audio.getVolume(target).catch(() => ({ ok: true, volume: undefined as number | undefined }));
      if (typeof cur.volume === 'number' && cur.volume > 0) {
        this.preMuteVolume.set(target, cur.volume);
      }
    }
    const res = await this.audio.setMute(target, mute);
    if (res.ok) {
      if (!mute) {
        const restore = this.preMuteVolume.get(target) ?? this.restoreVolumeFor(target);
        this.preMuteVolume.delete(target);
        if (typeof restore === 'number' && restore > 0) {
          void this.audio.setVolume(target, restore);
        }
      }
      return 'os';
    }
    return (await this.muteViaVolume(target, mute)) ? 'volume' : null;
  }

  /**
   * Strategia mute dla urządzeń bez węzła mute w topologii KS (HyperX QuadCast,
   * BlackShark Chat): mute = głośność 0% (dolny stopień attenuatora KS), unmute =
   * przywrócenie głośności zapamiętanej sprzed wyciszenia (fallback: profil
   * z configu, ostatecznie 100%).
   */
  private async muteViaVolume(target: string, mute: boolean): Promise<boolean> {
    if (!target) return false;
    try {
      if (mute) {
        const cur = await this.audio.getVolume(target);
        if (!cur.ok) return false;
        const setRes = await this.audio.setVolume(target, 0);
        if (!setRes.ok) return false;
        this.preMuteVolume.set(target, typeof cur.volume === 'number' ? cur.volume : 100);
        appendLog(
          'AUDIO-MUTE',
          `Wyciszone przez głośność 0% (urządzenie bez węzła mute): "${target}" (do przywrócenia: ${this.preMuteVolume.get(target)}%)`
        );
        return true;
      }

      const wasMutedByUs = this.preMuteVolume.has(target);
      const cur = await this.audio.getVolume(target).catch(() => ({ ok: true, volume: undefined as number | undefined }));
      const current = typeof cur.volume === 'number' ? cur.volume : 100;
      const restore = this.preMuteVolume.get(target) ?? this.restoreVolumeFor(target);
      this.preMuteVolume.delete(target);
      const setRes = await this.audio.setVolume(target, restore);
      if (!setRes.ok) return false;
      if (wasMutedByUs || current === 0) {
        appendLog('AUDIO-MUTE', `Odciszone (przywrócono głośność ${restore}%): "${target}"`);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Głośność do przywrócenia po odciszeniu: profil aktywnego urządzenia z configu. */
  private restoreVolumeFor(target: string): number {
    const t = target.trim().toLowerCase();
    const desk = (this.config.get('micDeskName') || '').trim().toLowerCase();
    const head = (this.config.get('micHeadsetName') || '').trim().toLowerCase();
    if (desk && t === desk) {
      const v = this.config.get('micDeskVolume');
      if (typeof v === 'number' && v >= 0) return v;
    }
    if (head && t === head) {
      const v = this.config.get('micHeadsetVolume');
      if (typeof v === 'number' && v >= 0) return v;
    }
    return 100;
  }

  /**
   * Toggle mute z odczytem stanu z TROCH źródeł. Odczyt OS (`isMuted` z
   * enumeracji) jest martwy na urządzeniach bez węzła mute w topologii KS
   * (HyperX QuadCast / BlackShark Chat — E_NOINTERFACE, isMuted zawsze false),
   * co sprawiało, że toggle zawsze liczył "niezmutowany -> zmutuj" i nigdy
   * nie odciszał. Prawdziwy stan: Discord RPC, potem intencja użytkownika
   * (userMuted), na końcu odczyt OS.
   */
  async toggleDeviceMute(target?: string): Promise<{ ok: boolean; isMuted?: boolean }> {
    const resolved = target || this.activeMicName();
    let muted: boolean | null = null;

    const devices = await this.audio.listRecordingDevices(true).catch(() => []);
    const dev = resolved
      ? devices.find((d) => d.name === resolved || (d.id && d.id === resolved))
      : (devices.find((d) => d.isDefault) || devices[0]);
    const targetName = dev?.name || resolved || '';

    if (dev && typeof dev.isMuted === 'boolean') muted = dev.isMuted;

    if (muted === false && this.discord) {
      const cur = await this.discord.getInputMute().catch(() => null);
      if (typeof cur === 'boolean') muted = cur;
    }
    if (muted === false && targetName) {
      muted = this.userMuted.has(targetName);
    }
    // Strategia głośność-0: 0% na urządzeniu bez odczytu mute = wyciszone
    if (muted === false && dev && typeof dev.volume === 'number' && dev.volume === 0) {
      muted = true;
    }
    if (muted === null) muted = false;

    return await this.setDeviceMute(targetName, !muted);
  }

  /** Nazwa aktywnego mikrofonu wg bieżącego stanu (do powiązania pary przy toggle). */
  private activeMicName(): string {
    return this.currentDevice === 'desk'
      ? (this.config.get('micDeskName') || '')
      : (this.config.get('micHeadsetName') || '');
  }

  /**
   * Ręczna zmiana mute: zapamiętaj intencję użytkownika (userMuted), żeby
   * auto-przełączanie nigdy nie odciszyło ręcznie wyciszonego mikrofonu
   * (ochrona przed "gorącym mikrofonem").
   */
  private trackManualMute(target: string, mute: boolean): void {
    if (mute) this.userMuted.add(target);
    else this.userMuted.delete(target);
  }

  /**
   * Powiązane wyciszenie pary: ręczny mute/odciszenie jednego mikrofonu
   * (stacjonarnego lub słuchawek) jest przenoszone na drugi — "jeśli
   * stacjonarny off, to słuchawki mute i vice versa". Oba mikrofoniki pary
   * zawsze pozostają w tym samym stanie wyciszenia przy sterowaniu ręcznym.
   */
  private async linkPairMute(target: string, mute: boolean): Promise<void> {
    const other = this.pairCounterpart(target);
    if (!other || other.trim().toLowerCase() === target.trim().toLowerCase()) return;
    const via = await this.applyDeviceMute(other, mute).catch(() => null);
    if (via) {
      if (mute) this.userMuted.add(other);
      else this.userMuted.delete(other);
      appendLog(
        'AUDIO-MUTE',
        `Powiązany mute pary: "${other}" -> ${mute ? 'WYCISZONY' : 'ODCISZONY'} (${via === 'os' ? 'OS' : 'głośność 0%'}) (po "${target}")`
      );
    }
  }

  /** Drugi mikrofon z pary (stacjonarny ↔ słuchawki) dla danego urządzenia. */
  private pairCounterpart(target: string): string | null {
    const desk = (this.config.get('micDeskName') || '').trim().toLowerCase();
    const head = (this.config.get('micHeadsetName') || '').trim().toLowerCase();
    const t = target.trim().toLowerCase();
    if (!desk || !head) return null;
    if (t.includes(desk) || desk.includes(t)) return this.config.get('micHeadsetName') || null;
    if (t.includes(head) || head.includes(t)) return this.config.get('micDeskName') || null;
    return null;
  }

  /** Dopasowuje profil głosowy Discorda do specyfiki aktywnego mikrofonu. */
  async applyDiscordGate(state: DeviceState): Promise<boolean> {
    if (!this.discord || !this.config.get('discordGateFollowMic')) return false;
    const isAuto = state === 'desk' ? this.config.get('micDeskAutoThreshold') : this.config.get('micHeadsetAutoThreshold');
    const rawGate = state === 'desk' ? this.config.get('micDeskGateDb') : this.config.get('micHeadsetGateDb');
    const krispRaw = state === 'desk' ? this.config.get('micDeskKrisp') : this.config.get('micHeadsetKrisp');
    const agcRaw = state === 'desk' ? this.config.get('micDeskAgc') : this.config.get('micHeadsetAgc');
    const echoRaw = state === 'desk' ? this.config.get('micDeskEcho') : this.config.get('micHeadsetEcho');
    const tri = (v: string | undefined): boolean | undefined => (v === 'on' ? true : v === 'off' ? false : undefined);
    // Wartości dB są ujemne (np. -45 dB). Prawidłowy zakres progu bramki to -100 dB do 0 dB (-1 = nie steruj).
    const gate =
      typeof rawGate === 'number' && Number.isFinite(rawGate) && rawGate <= 0 && rawGate >= -100 && rawGate !== -1
        ? rawGate
        : undefined;
    return await this.discord.applyMicSettings({
      autoThreshold: isAuto === true,
      gateDb: isAuto ? undefined : gate,
      krisp: tri(krispRaw),
      agc: tri(agcRaw),
      echo: tri(echoRaw)
    });
  }

  private async applyDevice(state: DeviceState): Promise<void> {
    const stationaryMic = this.config.get('micDeskName');
    const mobileMic = this.config.get('micHeadsetName');

    // 1. Obsługa wygaszania i usypiania ekranów oraz SignalRGB i diody sensora
    if (state === 'desk') {
      this.screen.onDesk();
      this.radar.updateLed('desk');
      if (this.signalrgb) {
        void this.signalrgb.onDesk();
      }
    } else {
      this.screen.onAway();
      this.radar.updateLed('away');
      if (this.signalrgb) {
        void this.signalrgb.onAway();
      }
    }

    // 3. Obsługa przełączania i wyciszania mikrofonów
    if (this.currentDevice === state) {
      appendLog('SWITCH-ENG', `Profil "${state.toUpperCase()}" jest już aktywny — pomijam przełączanie.`);
      return;
    }
    if (this.switching) {
      appendLog('SWITCH-ENG', `Przełączanie w toku — kolejkuje przejście na "${state.toUpperCase()}"`);
      this.pendingState = state;
      return;
    }
    this.switching = true;

    // Automatyzacje HAOS na realnym przejściu AWAY/DESK — dopiero gdy stan
    // faktycznie zmienia cel przełączenia (bez duplikatów przy retry/pending).
    if (this.ha) {
      void this.ha.onPresenceTransition(state);
    }
    this.currentDevice = state;

    const targetMic = state === 'desk' ? stationaryMic : mobileMic;
    const shouldSwitch =
      state === 'desk'
        ? this.config.get('switchMicOnDesk') !== false
        : this.config.get('switchMicOnAway') !== false;

    appendLog('SWITCH-ENG', `Wykonywanie profilu "${state.toUpperCase()}": mikrofon="${targetMic || 'BRAK'}", auto-switch=${shouldSwitch ? 'TAK' : 'NIE'}`);

    if (!targetMic) {
      appendLog('SWITCH-ENG', `UWAGA: Brak skonfigurowanego mikrofonu dla profilu "${state.toUpperCase()}".`);
      this.emit('switch', { state, device: null, switched: false, unconfigured: true });
      this.switching = false;
      return;
    }

    this.emit('switch', { state, device: targetMic, switched: shouldSwitch });

    try {
      let ok = true;
      if (shouldSwitch) {
        appendLog('APP', `Przełączam mikrofon domyślny -> "${targetMic}" (Profil: ${state.toUpperCase()})`);
        const t0 = Date.now();
        recordDiagTimelineEvent(
          'AUDIO_SWITCH',
          `Rozpoczęto przełączanie domyślnego mikrofonu w Windows -> "${targetMic}" (Profil: ${state.toUpperCase()})`,
          { state, targetMic }
        );
        const res = await this.audio.setDefaultRecordingDevice(targetMic);
        const switchDurationMs = Date.now() - t0;
        ok = res.ok;
        recordDiagTimelineEvent(
          'AUDIO_SWITCH',
          `AudioSwitcher ${ok ? 'pomyślnie przełączył' : 'błąd przełączenia'} na "${targetMic}" w ${switchDurationMs} ms (Windows CoreAudio)`,
          { durationMs: switchDurationMs, ok, targetMic }
        );
        if (ok) {
          this.currentDevice = state;
          this.lastAppliedOkState = state;
          this.clearMicRetry();
          this.startDesiredWatch(state, targetMic, targetMic);
        } else {
          this.scheduleMicRetry(state, targetMic, targetMic);
        }
      } else {
        appendLog(
          'APP',
          `Automatyczne przełączanie mikrofonu w systemie dla trybu ${state.toUpperCase()} jest wyłączone w opcjach.`
        );
        this.currentDevice = state;
      }

      // Zarządzanie wyciszeniem zgodnie z konfiguracją (unmuteOnDesk / muteBehaviorOnAway).
      if (state === 'desk') {
        if (this.config.get('unmuteOnDesk') !== false) {
          this.userMuted.delete(targetMic);
          if (stationaryMic) this.userMuted.delete(stationaryMic);
          await this.applyDeviceMute(targetMic, false).catch(() => {});
          if (stationaryMic && stationaryMic !== targetMic) {
            await this.applyDeviceMute(stationaryMic, false).catch(() => {});
          }
          // Przywróć dokładnie poziom głośności sprzed wyciszenia (lub z profilu, jeśli skonfigurowano):
          const remembered = this.preMuteVolume.get(targetMic) ?? (stationaryMic ? this.preMuteVolume.get(stationaryMic) : undefined);
          const deskVol = this.config.get('micDeskVolume');
          const restoreVol = typeof remembered === 'number' && remembered > 0
            ? remembered
            : (typeof deskVol === 'number' && deskVol >= 0 ? deskVol : undefined);

          this.preMuteVolume.delete(targetMic);
          if (stationaryMic) this.preMuteVolume.delete(stationaryMic);

          if (typeof restoreVol === 'number') {
            await this.audio.setVolume(targetMic, restoreVol).catch(() => {});
            if (stationaryMic && stationaryMic !== targetMic) {
              await this.audio.setVolume(stationaryMic, restoreVol).catch(() => {});
            }
          }
          // Ponowne potwierdzenie odciszenia w OS po ustawieniu głośności
          await this.audio.setMute(targetMic, false).catch(() => {});
          if (this.discord) {
            await this.discord.setInputMute(false).catch(() => false);
          }
        }
        if (mobileMic && mobileMic !== targetMic && (!stationaryMic || mobileMic.toLowerCase() !== stationaryMic.toLowerCase())) {
          await this.applyDeviceMute(mobileMic, true).catch(() => {});
        }
      } else {
        const awayMute = this.config.get('muteBehaviorOnAway') || 'mute_inactive';
        if (awayMute === 'none') {
          if (mobileMic && !this.userMuted.has(mobileMic)) {
            await this.applyDeviceMute(mobileMic, false).catch(() => {});
          }
        } else if (awayMute === 'mute_all') {
          if (stationaryMic) {
            await this.applyDeviceMute(stationaryMic, true).catch(() => {});
          }
          if (mobileMic) {
            await this.applyDeviceMute(mobileMic, true).catch(() => {});
          }
        } else {
          // 'mute_stationary' lub 'mute_inactive'
          if (stationaryMic) {
            await this.applyDeviceMute(stationaryMic, true).catch(() => {});
          }
          if (mobileMic && mobileMic !== targetMic && !this.userMuted.has(mobileMic)) {
            await this.applyDeviceMute(mobileMic, false).catch(() => {});
          }
        }
      }

      // Głośność wybranego mikrofonu (jeśli skonfigurowana)
      const volCfg = state === 'desk' ? this.config.get('micDeskVolume') : this.config.get('micHeadsetVolume');
      if (typeof volCfg === 'number' && volCfg >= 0) {
        await this.setDeviceVolume(targetMic, volCfg);
      }

      // Powiadomienie Discorda o aktywnym urządzeniu oraz aplikacja profilu głosu
      if (this.discord) {
        await this.syncDiscordDevice(targetMic);
        await this.applyDiscordGate(state);
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
