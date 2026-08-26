/// <reference types="vite/client" />
import type {
  Api,
  AudioDeviceItem,
  DetectResult,
  HomeAssistantStatus,
  PushEvent,
  RadarTelemetry,
  SerialPortInfo,
  Snapshot,
  UpdateInfo,
  UpdaterStatus
} from '../../shared/types';

export type {
  Api,
  AudioDeviceItem,
  DetectResult,
  HomeAssistantStatus,
  PushEvent,
  RadarTelemetry,
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
