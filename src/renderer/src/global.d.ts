/// <reference types="vite/client" />

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
  isDefaultComm?: boolean;
  isMuted?: boolean;
  volume?: number;
}

export interface Snapshot {
  mode: 'auto' | 'desk' | 'headset';
  state: 'desk' | 'headset' | null;
  deviceName: string | null;
  radar: {
    connected: boolean;
    presence: boolean;
    pendingState: 'desk' | 'away';
    port: string;
  };
  telemetry?: {
    presence?: boolean;
    distanceCm?: number;
    heartRate?: number;
    breathRate?: number;
    detectedPerson?: 'me' | 'other' | 'pet' | 'unknown';
    autoTuning?: {
      enabled: boolean;
      mode: 'learning' | 'tracking' | 'idle';
      speed: 'balanced' | 'fast' | 'conservative';
      noiseFloor: number; // 0-100%
      samplesCount: number;
      adaptedDistanceCenter: number;
      adaptedDistanceMin: number;
      adaptedDistanceMax: number;
      adaptedHeartRateAvg: number;
      adaptedBreathRateAvg: number;
      stabilityScore: number; // 0-100%
      lastAdaptedAt: number;
    };
    lastUpdate?: number;
  };
  config: {
    port: string;
    baudRate: number;
    micDeskName: string;
    micHeadsetName: string;
    timeoutAwayMs: number;
    timeoutDeskMs: number;
    radarDistanceGateEnabled?: boolean;
    radarMinDistanceCm?: number;
    radarMaxDistanceCm?: number;
    radarSensitivity?: number;
    radarAutoTuningEnabled?: boolean;
    radarAutoTuningSpeed?: 'balanced' | 'fast' | 'conservative';
    radarAutoTuningNoiseFloor?: number;
    radarLearnedDistanceCenter?: number;
    radarLearnedDistanceVariance?: number;
    radarLearnedHeartRate?: number;
    radarLearnedBreathRate?: number;
    petFilterEnabled?: boolean;
    biometricsEnabled?: boolean;
    userHeartRateMin?: number;
    userHeartRateMax?: number;
    userSeatingDistanceMin?: number;
    userSeatingDistanceMax?: number;
    personMismatchAction?: 'ignore' | 'switch_anyway' | 'notify_only';
    switchMicOnAway?: boolean;
    switchMicOnDesk?: boolean;
    muteBehaviorOnAway?: 'none' | 'mute_stationary' | 'mute_all';
    unmuteOnDesk?: boolean;
    discordIntegration?: boolean;
    signalrgbEnabled?: boolean;
    signalrgbPort?: number;
    signalrgbAwayAction?: 'solid_color' | 'turn_off' | 'dim';
    signalrgbAwayColor?: string;
    signalrgbAwayBrightness?: number;
    signalrgbRestoreOnDesk?: boolean;
    sleepMonitorsOnAway?: boolean;
    sleepMonitorsDelayMs?: number;
    wakeMonitorsOnDesk?: boolean;
    audioChime?: boolean;
    audioChimeOnDesk?: boolean;
    audioChimeOnAway?: boolean;
    audioChimeVolume?: number;
    notifications?: boolean;
    autoStart: boolean;
    autoDownloadTools: boolean;
    globalShortcut?: string;
    githubRepo?: string;
    githubToken?: string;
  };
}

export interface UpdaterStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  updateInfo?: {
    version: string;
    tag: string;
    name: string;
    notes: string;
    publishedAt: string;
    url: string;
    asset?: {
      name: string;
      size: number;
      downloadUrl: string;
    };
  } | null;
  error?: string;
}

export interface PushEvent {
  type: 'snapshot' | 'toast' | 'switch' | 'updater:status' | 'updater:progress' | 'sensor:flash-progress' | 'sensor:flash-complete' | string;
  snapshot?: Snapshot;
  message?: string;
  error?: boolean;
  percent?: number;
  speed?: string;
  stage?: string;
  status?: string;
  state?: string;
  device?: string;
  updateInfo?: UpdaterStatus['updateInfo'];
  [key: string]: any;
}

interface DetectResult {
  devices: AudioDeviceItem[];
  recommended: { micDeskName: string; micHeadsetName: string };
  applied: boolean;
}

interface Api {
  getState: () => Promise<Snapshot>;
  getPorts: () => Promise<SerialPortInfo[]>;
  setMode: (mode: Snapshot['mode']) => Promise<Snapshot>;
  setPort: (port: string) => Promise<Snapshot>;
  updateConfig: (patch: Partial<Snapshot['config']>) => Promise<Snapshot>;
  detectDevices: () => Promise<DetectResult>;
  listDevices: () => Promise<AudioDeviceItem[]>;
  toggleMute: (target?: string) => Promise<{ ok: boolean; isMuted?: boolean }>;
  setMute: (target: string, mute: boolean) => Promise<{ ok: boolean; isMuted?: boolean }>;
  testDevice: (name: string) => Promise<Snapshot>;
  sleepDisplay: () => Promise<any>;
  wakeDisplay: () => Promise<any>;
  openConfigDir: () => Promise<boolean>;
  resetConfig: () => Promise<Snapshot>;
  resetAutoTuning: () => Promise<any>;
  closeWindow: () => void;

  // SignalRGB Integration
  signalrgbProbe: () => Promise<{ connected: boolean; status?: number; data?: any }>;
  signalrgbTestAway: () => Promise<boolean>;
  signalrgbTestDesk: () => Promise<boolean>;

  // GitHub Auto Updater & Token
  openGitHubTokenPage: () => Promise<boolean>;
  checkForUpdates: () => Promise<{ available: boolean; updateInfo?: any; error?: string; currentVersion: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; file?: string }>;
  installUpdate: () => Promise<void>;
  getUpdaterStatus: () => Promise<UpdaterStatus>;

  // Sensor USB Firmware Flasher & Recovery
  checkSensorFirmware: () => Promise<{ available: boolean; version?: string; name?: string; size?: number; error?: string; message?: string }>;
  flashSensorFromGitHub: () => Promise<{ ok: boolean; port?: string }>;
  flashSensorFromFile: () => Promise<{ ok?: boolean; canceled?: boolean; port?: string }>;

  // Diagnostic Logs
  getLogs: () => Promise<string[]>;
  clearLogs: () => Promise<boolean>;

  onEvent: (cb: (e: PushEvent) => void) => () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};