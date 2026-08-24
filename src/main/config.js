import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  port: 'auto',
  baudRate: 115200,
  // Urządzenia wybrane przez użytkownika (domyślnie puste — użytkownik decyduje w GUI)
  micDeskName: '',              // Mikrofon stacjonarny
  micHeadsetName: '',           // Mikrofon mobilny
  // Czas reakcji
  timeoutAwayMs: 3000,
  timeoutDeskMs: 300,
  // Zachowania audio i przełączania
  switchMicOnAway: true,        // Przełącz na mikrofon mobilny po odejściu
  switchMicOnDesk: true,        // Przełącz na mikrofon stacjonarny po powrocie
  muteBehaviorOnAway: 'none',   // 'none' | 'mute_stationary' | 'mute_all'
  unmuteOnDesk: true,           // Automatycznie odcisz po powrocie do biurka
  // Integracja z Discordem
  discordIntegration: true,     // Błyskawiczne odświeżanie strumienia głosu w Discordzie
  // Zachowania ekranów
  sleepMonitorsOnAway: false,   // Usypiaj monitory po odejściu
  sleepMonitorsDelayMs: 15000,  // Czas oczekiwania przed uśpieniem ekranów (ms)
  wakeMonitorsOnDesk: true,     // Automatycznie wybudzaj monitory po powrocie
  // Dźwięki i powiadomienia
  audioChime: true,             // Dźwięk powiadomienia
  audioChimeOnDesk: true,       // Dźwięk przy powrocie
  audioChimeOnAway: true,       // Dźwięk przy odejściu
  audioChimeVolume: 0.2,        // Głośność (0.0 - 1.0)
  notifications: true,          // Dymki Windows Toast
  // Systemowe
  autoStart: false,
  autoDownloadTools: true,
  globalShortcut: 'CommandOrControl+Shift+M',
  githubRepo: 'Monratis/MicrophoneTool'
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
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = { ...DEFAULTS, ...parsed };
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[config] load error, restoring defaults:', err.message);
      this.data = { ...DEFAULTS };
      this.save();
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[config] atomic save error:', err.message);
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (innerErr) {
        console.error('[config] fallback save error:', innerErr.message);
      }
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