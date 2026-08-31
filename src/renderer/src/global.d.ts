/// <reference types="vite/client" />
import {
  DEFAULT_CONFIG,
  type Api,
  type AudioDeviceItem,
  type DetectResult,
  type DiagSessionReport,
  type DiagSessionTimelineItem,
  type DiagSessionAnalysis,
  type DiscordStatus,
  type DiscordVoiceSettings,
  type HomeAssistantStatus,
  type PushEvent,
  type RadarTelemetry,
  type SerialPortInfo,
  type Snapshot,
  type UpdateInfo,
  type UpdaterStatus
} from '../../shared/types';

export {
  DEFAULT_CONFIG,
  type Api,
  type AudioDeviceItem,
  type DetectResult,
  type DiagSessionReport,
  type DiagSessionTimelineItem,
  type DiagSessionAnalysis,
  type DiscordStatus,
  type DiscordVoiceSettings,
  type HomeAssistantStatus,
  type PushEvent,
  type RadarTelemetry,
  type SerialPortInfo,
  type Snapshot,
  type UpdateInfo,
  type UpdaterStatus
};

declare global {
  interface Window {
    api: Api;
  }
}

export {};
