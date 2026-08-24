/// <reference types="vite/client" />

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
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
    mockMode: boolean;
    autoStart: boolean;
    autoDetectDevices: boolean;
    autoDownloadTools: boolean;
  };
}

export interface PushEvent {
  type: 'snapshot' | 'toast' | string;
  snapshot?: Snapshot;
  message?: string;
  error?: boolean;
}

interface DetectResult {
  devices: { name: string; isDefault: boolean }[];
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
  resetConfig: () => Promise<Snapshot>;
  closeWindow: () => void;
  onEvent: (cb: (e: PushEvent) => void) => () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};