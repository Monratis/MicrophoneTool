/// <reference types="vite/client" />
import type {
  Api,
  AudioDeviceItem,
  DetectResult,
  PushEvent,
  SerialPortInfo,
  Snapshot,
  UpdateInfo,
  UpdaterStatus
} from '../../shared/types';

export type {
  Api,
  AudioDeviceItem,
  DetectResult,
  PushEvent,
  SerialPortInfo,
  Snapshot,
  UpdateInfo,
  UpdaterStatus
};

declare global {
  interface Window {
    api: Api;
  }
}

export {};
