import { EventEmitter } from 'node:events';
import path from 'node:path';
import SoundVolumeView from './soundVolumeView';

/**
 * Kontroler audio: deleguje do SoundVolumeView, sam zajmuje się
 * zapewnieniem binarki (auto-pobranie), wykrywaniem i dobieraniem nazw.
 */
export default class AudioController extends EventEmitter {
  constructor({ binDir, toolsDir, config }) {
    super();
    this.binDir = binDir;
    this.toolsDir = toolsDir;
    this.config = config;
    this.svv = new SoundVolumeView({ binDir, toolsDir, config });
    this.svv.onStatus((msg) => this.emit('toolStatus', msg));
  }

  /**
   * Ustawia domyślne urządzenie nagrywające.
   * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
   */
  setDefaultRecordingDevice(deviceName) {
    if (!deviceName) {
      return Promise.resolve({ ok: false, stdout: '', stderr: 'empty device name' });
    }
    return this.svv.setDefault(deviceName);
  }

  /**
   * Lista urządzeń nagrywających wykrytych przez SoundVolumeView.
   */
  listRecordingDevices() {
    return this.svv.listRecordingDevices();
  }

  /**
   * Przełącza wyciszenie mikrofonu.
   */
  toggleMute(target) {
    return this.svv.toggleMute(target);
  }

  /**
   * Ustawia wyciszenie mikrofonu.
   */
  setMute(target, mute) {
    return this.svv.setMute(target, mute);
  }

  /**
   * Dobiera nazwy mikrofonów biurkowego i słuchawek.
   */
  resolveNames(devices) {
    return this.svv.resolveNames(devices);
  }

  /**
   * Wyłącza/usypia połączone monitory.
   */
  sleepDisplay() {
    return this.svv.sleepDisplay();
  }

  /**
   * Wybudza połączone monitory.
   */
  wakeDisplay() {
    return this.svv.wakeDisplay();
  }

  /**
   * Ścieżka oczekiwanej binarki (do celów informacyjnych).
   */
  binaryPath() {
    return this.svv.nativeExePath;
  }
}