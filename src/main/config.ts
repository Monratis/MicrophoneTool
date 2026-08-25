import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/types';

export const DEFAULTS: AppConfig = {
  port: 'auto',
  baudRate: 115200,
  micDeskName: '',
  micDeskId: '',
  micHeadsetName: '',
  micHeadsetId: '',
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
  /** Application ID apki DeskSense (Discord Developer Portal) */
  discordClientId: '1238447097859145859',
  /**
   * Client Secret osadzony w apkce na stałe (decyzja właściciela — apka
   * dystrybuowana prywatnie, scope'y ograniczone do rpc.voice.*).
   * Nadpisywalne przez config.json użytkownika.
   */
  discordClientSecret: 'xwmeOcXQP496dX5EYgXBFFcNyEUo30Z3',
  discordRedirectUri: 'https://discord.com',
  timeoutAwayMs: 3000,
  timeoutDeskMs: 300,
  radarDistanceGateEnabled: true,
  radarMinDistanceCm: 40,
  radarMaxDistanceCm: 110,
  radarSensitivity: 80,
  petFilterEnabled: true,
  biometricsEnabled: false,
  userHeartRateMin: 55,
  userHeartRateMax: 78,
  userSeatingDistanceMin: 60,
  userSeatingDistanceMax: 90,
  radarAutoTuningEnabled: true,
  radarAutoTuningSpeed: 'balanced',
  radarAutoTuningNoiseFloor: 0,
  radarLearnedDistanceCenter: 0,
  radarLearnedDistanceVariance: 0,
  radarLearnedHeartRate: 0,
  radarLearnedBreathRate: 0,
  personMismatchAction: 'ignore',
  switchMicOnAway: true,
  switchMicOnDesk: true,
  muteBehaviorOnAway: 'mute_inactive',
  unmuteOnDesk: true,
  discordIntegration: true,
  signalrgbEnabled: false,
  signalrgbPort: 16038,
  signalrgbAwayAction: 'solid_color',
  signalrgbAwayColor: '#f59e0b',
  signalrgbAwayBrightness: 0,
  signalrgbRestoreOnDesk: true,
  sleepMonitorsOnAway: false,
  sleepMonitorsDelayMs: 15000,
  wakeMonitorsOnDesk: true,
  audioChime: true,
  audioChimeOnDesk: true,
  audioChimeOnAway: true,
  audioChimeVolume: 0.2,
  notifications: true,
  autoStart: false,
  autoDownloadTools: true,
  globalShortcut: 'CommandOrControl+Shift+M',
  githubRepo: 'Monratis/MicrophoneTool',
  githubToken: process.env.GITHUB_TOKEN || ''
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
