export type AppMode = 'auto' | 'desk' | 'headset';
export type DeskState = 'desk' | 'away';
export type DeviceState = 'desk' | 'headset';
export type DetectedPerson = 'me' | 'other' | 'pet' | 'unknown';

export interface AppConfig {
  port: string;
  baudRate: number;
  micDeskName: string;
  micHeadsetName: string;
  timeoutAwayMs: number;
  timeoutDeskMs: number;
  radarDistanceGateEnabled: boolean;
  radarMinDistanceCm: number;
  radarMaxDistanceCm: number;
  radarSensitivity: number;
  petFilterEnabled: boolean;
  biometricsEnabled: boolean;
  userHeartRateMin: number;
  userHeartRateMax: number;
  userSeatingDistanceMin: number;
  userSeatingDistanceMax: number;
  radarAutoTuningEnabled: boolean;
  radarAutoTuningSpeed: 'balanced' | 'fast' | 'conservative';
  radarAutoTuningNoiseFloor: number;
  radarLearnedDistanceCenter: number;
  radarLearnedDistanceVariance: number;
  radarLearnedHeartRate: number;
  radarLearnedBreathRate: number;
  personMismatchAction: 'ignore' | 'switch_anyway' | 'notify_only';
  switchMicOnAway: boolean;
  switchMicOnDesk: boolean;
  muteBehaviorOnAway: 'none' | 'mute_stationary' | 'mute_all';
  unmuteOnDesk: boolean;
  discordIntegration: boolean;
  signalrgbEnabled: boolean;
  signalrgbPort: number;
  signalrgbAwayAction: 'solid_color' | 'turn_off' | 'dim';
  signalrgbAwayColor: string;
  signalrgbAwayBrightness: number;
  signalrgbRestoreOnDesk: boolean;
  sleepMonitorsOnAway: boolean;
  sleepMonitorsDelayMs: number;
  wakeMonitorsOnDesk: boolean;
  audioChime: boolean;
  audioChimeOnDesk: boolean;
  audioChimeOnAway: boolean;
  audioChimeVolume: number;
  notifications: boolean;
  autoStart: boolean;
  autoDownloadTools: boolean;
  globalShortcut: string;
  githubRepo: string;
  githubToken: string;
}

export interface AutoTuningStatus {
  enabled: boolean;
  mode: 'learning' | 'tracking' | 'idle';
  speed: 'balanced' | 'fast' | 'conservative';
  noiseFloor: number;
  samplesCount: number;
  adaptedDistanceCenter: number;
  adaptedDistanceMin: number;
  adaptedDistanceMax: number;
  adaptedHeartRateAvg: number;
  adaptedBreathRateAvg: number;
  stabilityScore: number;
  lastAdaptedAt: number;
}

export interface RadarTelemetry {
  presence?: boolean;
  distanceCm?: number;
  heartRate?: number;
  breathRate?: number;
  detectedPerson?: DetectedPerson;
  autoTuning?: AutoTuningStatus;
  lastUpdate?: number;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface AudioDeviceItem {
  id?: string;
  name: string;
  isDefault: boolean;
  isMuted?: boolean;
  volume?: number;
}

export interface Snapshot {
  mode: AppMode;
  state: DeviceState | null;
  deviceName: string | null;
  radar: {
    connected: boolean;
    presence: boolean;
    pendingState: DeskState;
    port: string;
  };
  telemetry: RadarTelemetry;
  config: AppConfig;
}

export interface UpdaterStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  updateInfo?: UpdateInfo | null;
  downloadedFilePath?: string | null;
  error?: string;
}

export interface UpdateInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  asset: {
    id: number;
    name: string;
    size: number;
    apiUrl: string;
    downloadUrl: string;
  } | null;
}

export interface PushEvent {
  type: string;
  snapshot?: Snapshot;
  message?: string;
  error?: boolean;
  percent?: number;
  transferred?: number;
  total?: number;
  speed?: string;
  stage?: string;
  entry?: string;
  state?: DeviceState;
  device?: string | null;
  updateInfo?: UpdateInfo;
  status?: UpdaterStatus;
  [key: string]: unknown;
}

export interface DetectResult {
  devices: AudioDeviceItem[];
  recommended: { micDeskName: string; micHeadsetName: string };
}

export interface Api {
  getState: () => Promise<Snapshot>;
  getPorts: () => Promise<SerialPortInfo[]>;
  setMode: (mode: AppMode) => Promise<Snapshot>;
  setPort: (port: string) => Promise<Snapshot>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<Snapshot>;
  detectDevices: () => Promise<DetectResult>;
  listDevices: () => Promise<AudioDeviceItem[]>;
  toggleMute: (target?: string) => Promise<{ ok: boolean; isMuted?: boolean }>;
  setMute: (target: string, mute: boolean) => Promise<{ ok: boolean; isMuted?: boolean }>;
  testDevice: (name: string) => Promise<Snapshot>;
  sleepDisplay: () => Promise<unknown>;
  wakeDisplay: () => Promise<unknown>;
  openConfigDir: () => Promise<boolean>;
  resetConfig: () => Promise<Snapshot>;
  resetAutoTuning: () => Promise<AutoTuningStatus | null>;
  closeWindow: () => void;

  signalrgbProbe: () => Promise<{ connected: boolean; status?: number; data?: unknown }>;
  signalrgbTestAway: () => Promise<boolean>;
  signalrgbTestDesk: () => Promise<boolean>;

  openGitHubTokenPage: () => Promise<boolean>;
  checkForUpdates: () => Promise<{ available: boolean; updateInfo?: UpdateInfo | null; error?: string; currentVersion: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; file?: string } | null>;
  installUpdate: () => Promise<void | null>;
  getUpdaterStatus: () => Promise<UpdaterStatus | null>;

  checkSensorFirmware: () => Promise<{ available: boolean; version?: string; name?: string; size?: number; error?: string; message?: string }>;
  flashSensorFromGitHub: () => Promise<{ ok: boolean; port?: string }>;
  flashSensorFromFile: () => Promise<{ ok?: boolean; canceled?: boolean; port?: string }>;

  getLogs: () => Promise<string[]>;
  clearLogs: () => Promise<boolean>;

  onEvent: (cb: (e: PushEvent) => void) => () => void;
}
