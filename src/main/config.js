import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  port: 'auto',
  baudRate: 115200,
  micDeskName: 'Microphone (HyperX QuadCast 2)',
  micHeadsetName: 'Microphone (Headset)',
  timeoutAwayMs: 3000,
  timeoutDeskMs: 300,
  mockMode: true,
  autoStart: false,
  autoDetectDevices: true,
  autoDownloadTools: true
};

export default class Config {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = { ...DEFAULTS, ...parsed };
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[config] load error:', err.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] save error:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}