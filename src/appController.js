'use strict';

const { EventEmitter } = require('events');

/**
 * Spina radar z kontrolerem audio. Tryby:
 *  'auto'   - przełączanie wg stanu radaru
 *  'desk'   - wymuszenie mikrofonu biurkowego
 *  'headset' - wymuszenie mikrofonu słuchawek
 */
class AppController extends EventEmitter {
  constructor(radar, audio, config) {
    super();
    this.radar = radar;
    this.audio = audio;
    this.config = config;
    this.mode = 'auto';
    this.currentDevice = null; // 'desk' | 'headset' | null
    this.switching = false;

    radar.on('desk', () => this._onRadarState('desk'));
    radar.on('away', () => this._onRadarState('away'));
    radar.on('status', (s) => this.emit('radarStatus', s));
    radar.on('error', (err) => this.emit('error', err));
  }

  async start() {
    await this.radar.start();
    // Na starcie w trybie auto wymuś stan początkowy bez czekania na radar
    if (this.mode === 'auto') {
      await this._applyDevice(this.radar.state || 'away');
    }
  }

  async stop() {
    await this.radar.stop();
  }

  setMode(mode) {
    if (!['auto', 'desk', 'headset'].includes(mode)) return;
    this.mode = mode;
    this.emit('mode', mode);
    if (mode !== 'auto') {
      this._applyDevice(mode === 'desk' ? 'desk' : 'headset');
    } else {
      this._applyDevice(this.radar.state || 'away');
    }
  }

  async _onRadarState(state) {
    if (this.mode !== 'auto') return;
    await this._applyDevice(state);
  }

  async _applyDevice(state) {
    if (this.switching || this.currentDevice === state) return;
    this.switching = true;
    this.currentDevice = state;
    const name = state === 'desk'
      ? this.config.get('micDeskName')
      : this.config.get('micHeadsetName');
    this.emit('switch', { state, device: name });
    try {
      const res = await this.audio.setDefaultRecordingDevice(name);
      this.emit('switched', { state, device: name, ok: res.ok });
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.switching = false;
    }
  }
}

module.exports = AppController;