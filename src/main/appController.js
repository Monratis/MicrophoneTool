import { EventEmitter } from 'node:events';

/**
 * Spina radar z kontrolerem audio oraz konfigurowalnymi zachowaniami stacjonarnymi/mobilnymi.
 * Tryby:
 *  'auto'     - automatyczne przełączanie wg stanu radaru
 *  'desk'     - wymuszenie mikrofonu stacjonarnego (biurko)
 *  'headset'  - wymuszenie mikrofonu mobilnego (słuchawki)
 */
export default class AppController extends EventEmitter {
  constructor(radar, audio, config) {
    super();
    this.radar = radar;
    this.audio = audio;
    this.config = config;
    this.mode = 'auto';
    this.currentDevice = null; // 'desk' | 'headset' | null
    this.switching = false;
    this._pendingState = null;
    this._displaySleepTimer = null;
    this._isDisplaySleeping = false;

    radar.on('desk', () => this._onRadarState('desk'));
    radar.on('away', () => this._onRadarState('away'));
    radar.on('status', (s) => this.emit('radarStatus', s));
    radar.on('error', (err) => this.emit('error', err));
  }

  async start() {
    await this.radar.start();
    // Nie wymuszaj sztucznego przełączania na starcie bez sygnału z radaru
  }

  async stop() {
    this._clearDisplaySleepTimer();
    await this.radar.stop();
  }

  setMode(mode) {
    if (!['auto', 'desk', 'headset'].includes(mode)) return;
    this.mode = mode;
    this.emit('mode', mode);
    if (mode !== 'auto') {
      this._applyDevice(mode === 'desk' ? 'desk' : 'headset');
    } else if (this.radar.state) {
      this._applyDevice(this.radar.state);
    }
  }

  async _onRadarState(state) {
    if (this.mode !== 'auto') return;
    await this._applyDevice(state);
  }

  _clearDisplaySleepTimer() {
    if (this._displaySleepTimer) {
      clearTimeout(this._displaySleepTimer);
      this._displaySleepTimer = null;
    }
  }

  async _applyDevice(state) {
    const stationaryMic = this.config.get('micDeskName');
    const mobileMic = this.config.get('micHeadsetName');

    // 1. Obsługa usypiania i wybudzania ekranów
    if (state === 'desk') {
      this._clearDisplaySleepTimer();
      const shouldWake = this.config.get('wakeMonitorsOnDesk') !== false;
      if (shouldWake && (this._isDisplaySleeping || this.config.get('sleepMonitorsOnAway'))) {
        this._isDisplaySleeping = false;
        await this.audio.wakeDisplay();
        this.emit('displayState', 'wake');
      }
    } else if (state === 'away') {
      this._clearDisplaySleepTimer();
      if (this.config.get('sleepMonitorsOnAway')) {
        const delay = Math.max(1000, Number(this.config.get('sleepMonitorsDelayMs')) || 15000);
        this._displaySleepTimer = setTimeout(async () => {
          this._displaySleepTimer = null;
          this._isDisplaySleeping = true;
          await this.audio.sleepDisplay();
          this.emit('displayState', 'sleep');
        }, delay);
      }
    }

    // 2. Obsługa przełączania i wyciszania mikrofonów
    if (this.currentDevice === state) return;
    if (this.switching) {
      this._pendingState = state;
      return;
    }
    this.switching = true;
    this.currentDevice = state;

    const targetMic = state === 'desk' ? stationaryMic : mobileMic;
    const shouldSwitch = state === 'desk'
      ? (this.config.get('switchMicOnDesk') !== false)
      : (this.config.get('switchMicOnAway') !== false);

    if (!targetMic) {
      // Mikrofon nie został jeszcze skonfigurowany przez użytkownika — nie wykonuj niepotrzebnych operacji
      this.emit('switch', { state, device: null, switched: false, unconfigured: true });
      this.switching = false;
      return;
    }

    this.emit('switch', { state, device: targetMic, switched: shouldSwitch });

    try {
      let ok = true;
      if (shouldSwitch && targetMic) {
        const res = await this.audio.setDefaultRecordingDevice(targetMic);
        ok = res.ok;
      }

      // Zachowania wyciszania przy powrocie do stacjonarnego
      if (state === 'desk') {
        if (this.config.get('unmuteOnDesk') !== false && stationaryMic) {
          await this.audio.setMute(stationaryMic, false);
        }
      }

      // Zachowania wyciszania przy odejściu (mobilny)
      if (state === 'away') {
        const muteMode = this.config.get('muteBehaviorOnAway') || 'none';
        if (muteMode === 'mute_stationary' && stationaryMic) {
          await this.audio.setMute(stationaryMic, true);
        } else if (muteMode === 'mute_all') {
          if (stationaryMic) await this.audio.setMute(stationaryMic, true);
          if (mobileMic) await this.audio.setMute(mobileMic, true);
        }
      }

      this.emit('switched', { state, device: targetMic, ok });
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.switching = false;
      if (this._pendingState && this._pendingState !== this.currentDevice) {
        const pending = this._pendingState;
        this._pendingState = null;
        this._applyDevice(pending);
      }
    }
  }
}