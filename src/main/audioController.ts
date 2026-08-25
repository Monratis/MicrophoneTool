import { EventEmitter } from 'node:events';
import SoundVolumeView from './soundVolumeView';
import type Config from './config';
import type { AudioDeviceItem } from '../shared/types';
import type { ExecResult } from './soundVolumeView';

/**
 * Kontroler audio: deleguje do SoundVolumeView, sam zajmuje się
 * zapewnieniem binarki (auto-pobranie), wykrywaniem i dobieraniem nazw.
 */
export default class AudioController extends EventEmitter {
  readonly binDir: string;
  readonly toolsDir: string;
  config: Config;
  svv: SoundVolumeView;

  constructor({ binDir, toolsDir, config }: { binDir: string; toolsDir: string; config: Config }) {
    super();
    this.binDir = binDir;
    this.toolsDir = toolsDir;
    this.config = config;
    this.svv = new SoundVolumeView({ binDir, toolsDir, config });
    this.svv.onStatus((msg) => this.emit('toolStatus', msg));
  }

  setDefaultRecordingDevice(deviceName: string): Promise<ExecResult> {
    if (!deviceName) {
      return Promise.resolve({ ok: false, stdout: '', stderr: 'empty device name' });
    }
    return this.svv.setDefault(deviceName);
  }

  listRecordingDevices(forceFresh = false): Promise<AudioDeviceItem[]> {
    return this.svv.listRecordingDevices(forceFresh);
  }

  toggleMute(target?: string): Promise<{ ok: boolean; isMuted?: boolean }> {
    return this.svv.toggleMute(target);
  }

  setMute(target: string, mute: boolean): Promise<{ ok: boolean; isMuted?: boolean }> {
    return this.svv.setMute(target, mute);
  }

  resolveNames(devices: AudioDeviceItem[]): { micDeskName: string; micHeadsetName: string } {
    return this.svv.resolveNames(devices);
  }

  sleepDisplay(): Promise<ExecResult | { ok: boolean }> {
    return this.svv.sleepDisplay();
  }

  wakeDisplay(): Promise<ExecResult | { ok: boolean }> {
    return this.svv.wakeDisplay();
  }

  binaryPath(): string {
    return this.svv.nativeExePath;
  }
}
