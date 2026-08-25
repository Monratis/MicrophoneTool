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
    if (this.discord) {
      this.discord.stop();
    }
    await this.radar.stop();
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

  private async applyDevice(state: DeviceState): Promise<void> {
    const stationaryMic = this.config.get('micDeskName');
    const mobileMic = this.config.get('micHeadsetName');

    // 1. Obsługa usypiania i wybudzania ekranów
    if (state === 'desk') {
      this.clearDisplaySleepTimer();
      const shouldWake = this.config.get('wakeMonitorsOnDesk') !== false;
      if (shouldWake && (this.isDisplaySleeping || this.config.get('sleepMonitorsOnAway'))) {
        this.isDisplaySleeping = false;
        await this.audio.wakeDisplay();
        this.emit('displayState', 'wake');
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
        const res = await this.audio.setDefaultRecordingDevice(targetMic);
        ok = res.ok;
      }

      if (state === 'desk') {
        if (this.config.get('unmuteOnDesk') !== false && stationaryMic) {
          await this.audio.setMute(stationaryMic, false);
        }
      } else {
        const muteMode = this.config.get('muteBehaviorOnAway') || 'none';
        if (muteMode === 'mute_stationary' && stationaryMic) {
          await this.audio.setMute(stationaryMic, true);
        } else if (muteMode === 'mute_all') {
          if (stationaryMic) await this.audio.setMute(stationaryMic, true);
          if (mobileMic) await this.audio.setMute(mobileMic, true);
        }
      }

      if (this.discord) {
        void this.discord.notifyDeviceChanged(targetMic);
      }

      this.emit('switched', { state, device: targetMic, ok });
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
