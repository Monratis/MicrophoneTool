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
  config: {
    port: string;
    baudRate: number;
    micDeskName: string;
    micHeadsetName: string;
    timeoutAwayMs: number;
    timeoutDeskMs: number;
    switchMicOnAway?: boolean;
    switchMicOnDesk?: boolean;
    muteBehaviorOnAway?: 'none' | 'mute_stationary' | 'mute_all';
    unmuteOnDesk?: boolean;
    discordIntegration?: boolean;
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
  type: 'snapshot' | 'toast' | 'switch' | 'updater:status' | 'updater:progress' | string;
  snapshot?: Snapshot;
  message?: string;
  error?: boolean;
  percent?: number;
  speed?: string;
  status?: string;
  state?: string;
  device?: string;
  updateInfo?: UpdaterStatus['updateInfo'];
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
  closeWindow: () => void;

  // GitHub Auto Updater
  checkForUpdates: () => Promise<{ available: boolean; updateInfo?: any; error?: string; currentVersion: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; file?: string }>;
  installUpdate: () => Promise<void>;
  getUpdaterStatus: () => Promise<UpdaterStatus>;

  onEvent: (cb: (e: PushEvent) => void) => () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};