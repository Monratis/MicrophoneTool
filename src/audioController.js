'use strict';

const { execFile } = require('child_process');
const path = require('path');

/**
 * Steruje domyślnym urządzeniem nagrywającym w systemie Windows
 * przez wywołanie narzędzia SoundVolumeView.exe (NirSoft) z ./bin/.
 */
class AudioController {
  constructor(binDir) {
    this.binDir = binDir || path.join(__dirname, '..', 'bin');
    this.exePath = path.join(this.binDir, 'SoundVolumeView.exe');
  }

  /**
   * Ustawia domyślne urządzenie nagrywające.
   * @param {string} deviceName nazwa urządzenia dokładnie jak w SoundVolumeView
   * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
   */
  setDefaultRecordingDevice(deviceName) {
    if (!deviceName) {
      return Promise.resolve({ ok: false, stdout: '', stderr: 'empty device name' });
    }
    return new Promise((resolve) => {
      const args = ['/SetDefault', deviceName, 'all'];
      execFile(this.exePath, args, { windowsHide: true }, (error, stdout, stderr) => {
        const ok = !error;
        if (!ok) {
          console.error(`[audio] SetDefault failed for "${deviceName}":`, error ? error.message : stderr);
        } else {
          console.log(`[audio] Default recording device -> "${deviceName}"`);
        }
        resolve({ ok, stdout, stderr });
      });
    });
  }
}

module.exports = AudioController;
