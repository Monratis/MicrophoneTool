import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../shared/types';

export const DEFAULTS: AppConfig = DEFAULT_CONFIG;

export default class Config {
  readonly filePath: string;
  data: AppConfig;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const sanitized: Partial<AppConfig> = {};
        for (const k of Object.keys(DEFAULTS) as (keyof AppConfig)[]) {
          if (k in parsed && parsed[k] !== undefined) {
            sanitized[k] = parsed[k] as any;
          }
        }
        // Zabezpieczenie przed ekstremalnie niskimi wartościami z przeszłości (np. 25 ms):
        if (typeof sanitized.timeoutAwayMs === 'number' && sanitized.timeoutAwayMs < 200) {
          sanitized.timeoutAwayMs = DEFAULTS.timeoutAwayMs;
        }
        if (typeof sanitized.timeoutDeskMs === 'number' && sanitized.timeoutDeskMs < 0) {
          sanitized.timeoutDeskMs = DEFAULTS.timeoutDeskMs;
        }
        this.data = { ...DEFAULTS, ...sanitized };
        this.save(); // natychmiast czyści stary plik z usuniętych pól
      } else {
        this.save();
      }
    } catch (err) {
      // Uszkodzony config NIE może zniknąć bez śladu — kopia .bak daje
      // użytkownikowi szansę odzyskania ustawień po naprawie pliku.
      console.error('[config] load error, backing up and restoring defaults:', (err as Error).message);
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      } catch (bakErr) {
        console.error('[config] backup failed:', (bakErr as Error).message);
      }
      this.data = { ...DEFAULTS };
      this.save();
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[config] atomic save error:', (err as Error).message);
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (innerErr) {
        console.error('[config] fallback save error:', (innerErr as Error).message);
      }
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.data[key];
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.data[key] = value;
    this.save();
  }
}
