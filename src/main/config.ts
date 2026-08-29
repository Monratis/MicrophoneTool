import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/types';

export const DEFAULTS: AppConfig = {
  port: 'auto',
  baudRate: 115200,
  micDeskName: '',
  micHeadsetName: '',
  micDeskVolume: -1,
  micHeadsetVolume: -1,
  micDeskGateDb: -1,
  micHeadsetGateDb: -1,
  micDeskKrisp: 'default',
  micHeadsetKrisp: 'default',
  micDeskAgc: 'default',
  micHeadsetAgc: 'default',
  micDeskEcho: 'default',
  micHeadsetEcho: 'default',
  discordGateFollowMic: true,
  /** Application ID apki DeskSense (Discord Developer Portal); override: DISCORD_CLIENT_ID */
  discordClientId: process.env.DISCORD_CLIENT_ID || '1238447097859145859',
  /**
   * Client Secret osadzony w apkce na stałe (decyzja właściciela — apka
   * dystrybuowana prywatnie, scope'y ograniczone do rpc.voice.*).
   * Nadpisywalne przez config.json użytkownika lub DISCORD_CLIENT_SECRET.
   */
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || 'xwmeOcXQP496dX5EYgXBFFcNyEUo30Z3',
  discordRedirectUri: 'https://discord.com',
  discordAccessToken: '',
  discordRefreshToken: '',
  /** Unix ms — kiedy wygasa access token (proaktywny refresh z 24 h zapasem). */
  discordTokenExpiresAt: 0,
  timeoutAwayMs: 1500,
  timeoutDeskMs: 200,
  userInputPresenceEnabled: true,
  radarDistanceGateEnabled: true,
  radarMinDistanceCm: 40,
  radarMaxDistanceCm: 110,
  radarDeepAwayConfirm: true,
  radarDeepAwayMinMs: 600000,
  radarDeepAwayConfirmMs: 3000,
  petFilterEnabled: true,
  radarAutoTuningEnabled: true,
  radarAutoTuningSpeed: 'balanced',
  radarLearnedDistanceCenter: 0,
  radarLearnedDistanceVariance: 0,
  radarLearnedHeartRate: 0,
  radarLearnedBreathRate: 0,
  switchMicOnAway: true,
  switchMicOnDesk: true,
  muteBehaviorOnAway: 'mute_inactive',
  unmuteOnDesk: true,
  discordIntegration: true,
  signalrgbEnabled: false,
  signalrgbPort: 16038,
  signalrgbAwayAction: 'solid_color',
  signalrgbAwayColor: '#f59e0b',
  signalrgbAwayEffect: '',
  signalrgbAwayBrightness: 0,
  signalrgbRestoreOnDesk: true,
  signalrgbDeskEffect: '',
  screensaverOnAway: true,
  screensaverDelayMs: 60000,
  sleepMonitorsOnAway: false,
  sleepMonitorsDelayMs: 600000,
  wakeMonitorsOnDesk: true,
  audioChime: true,
  audioChimeOnDesk: true,
  audioChimeOnAway: true,
  audioChimeVolume: 0.2,
  audioChimeStyle: 'harmonic',
  audioFileDesk: '',
  audioFileHeadset: '',
  notifications: true,
  autoStart: false,
  globalShortcut: 'CommandOrControl+Shift+M',
  githubRepo: 'Monratis/MicrophoneTool',
  githubToken: process.env.GITHUB_TOKEN || '',
  haEnabled: false,
  haUrl: 'http://homeassistant.local:8123',
  haToken: '',
  haPresenceEntity: '',
  haDistanceEntity: '',
  haHeartRateEntity: '',
  haBreathRateEntity: '',
  haAutomationOnAway: '',
  haAutomationOnDesk: '',
  haButtonSnoozeEntity: '',
  haButtonMuteEntity: '',
  radarSmoothingMode: 'balanced',
  sensorLedEnabled: true,
  sensorLedBrightness: 25,
  sensorLedDeskColor: '#22c55e',
  sensorLedAwayColor: '#f59e0b',
  sensorLedMuteColor: '#ef4444'
};

export default class Config {
  readonly filePath: string;
  data: AppConfig;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppConfig>;
        this.data = { ...DEFAULTS, ...parsed };
      } else {
        this.save();
      }
    } catch (err) {
      // Uszkodzony config NIE może zniknąć bez śladu — kopia .bak daje
      // użytkownikowi szansę odzyskania ustawień po naprawie pliku.
      console.error('[config] load error, backing up and restoring defaults:', (err as Error).message);
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      } catch (bakErr) {
        console.error('[config] backup failed:', (bakErr as Error).message);
      }
      this.data = { ...DEFAULTS };
      this.save();
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[config] atomic save error:', (err as Error).message);
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (innerErr) {
        console.error('[config] fallback save error:', (innerErr as Error).message);
      }
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.data[key];
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.data[key] = value;
    this.save();
  }
}
