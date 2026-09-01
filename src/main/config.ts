import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { DEFAULT_CONFIG, type AppConfig } from '../shared/types';

export const DEFAULTS: AppConfig = DEFAULT_CONFIG;

const SENSITIVE_FIELDS: (keyof AppConfig)[] = [
  'haToken',
  'githubToken',
  'discordAccessToken',
  'discordRefreshToken',
  'discordClientSecret'
];

const XOR_KEY = 0x5a;

function isSafeStorageReady(): boolean {
  try {
    return Boolean(
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable()
    );
  } catch {
    return false;
  }
}

function xorObfuscate(str: string): string {
  const buf = Buffer.from(str, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= XOR_KEY ^ (i % 7);
  }
  return buf.toString('base64');
}

function xorDeobfuscate(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= XOR_KEY ^ (i % 7);
  }
  return buf.toString('utf8');
}

export function encryptSecret(val: string): string {
  if (!val || typeof val !== 'string' || !val.trim()) return '';
  if (val.startsWith('enc_dpapi:') || val.startsWith('enc_b64:')) return val;
  try {
    if (isSafeStorageReady()) {
      const buf = safeStorage.encryptString(val);
      return `enc_dpapi:${buf.toString('base64')}`;
    }
  } catch (err) {
    console.warn('[config] safeStorage encrypt failed, using fallback:', (err as Error).message);
  }
  return `enc_b64:${xorObfuscate(val)}`;
}

export function decryptSecret(val: string): string {
  if (!val || typeof val !== 'string' || !val.trim()) return '';
  if (val.startsWith('enc_dpapi:')) {
    try {
      if (isSafeStorageReady()) {
        const buf = Buffer.from(val.slice('enc_dpapi:'.length), 'base64');
        return safeStorage.decryptString(buf);
      }
    } catch (err) {
      console.warn('[config] safeStorage decrypt failed:', (err as Error).message);
    }
    return '';
  }
  if (val.startsWith('enc_b64:')) {
    try {
      return xorDeobfuscate(val.slice('enc_b64:'.length));
    } catch (err) {
      console.warn('[config] xor decrypt failed:', (err as Error).message);
    }
    return '';
  }
  return val;
}

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
            if (SENSITIVE_FIELDS.includes(k) && typeof parsed[k] === 'string') {
              sanitized[k] = decryptSecret(parsed[k] as string) as any;
            } else {
              sanitized[k] = parsed[k] as any;
            }
          }
        }
        // Zabezpieczenie przed ekstremalnie niskimi wartościami z przeszłości (np. 25 ms):
        if (typeof sanitized.timeoutAwayMs === 'number' && sanitized.timeoutAwayMs < 200) {
          sanitized.timeoutAwayMs = DEFAULTS.timeoutAwayMs;
        }
        if (typeof sanitized.timeoutDeskMs === 'number' && sanitized.timeoutDeskMs < 0) {
          sanitized.timeoutDeskMs = DEFAULTS.timeoutDeskMs;
        }
        if (Array.isArray(sanitized.voiceRules)) {
          const existingActionTypes = new Set(sanitized.voiceRules.map((r) => r.actionType));
          for (const defRule of DEFAULTS.voiceRules) {
            if (!existingActionTypes.has(defRule.actionType)) {
              sanitized.voiceRules.push({ ...defRule });
            }
          }
        }
        this.data = { ...DEFAULTS, ...sanitized };
        this.save(); // natychmiast czyści stary plik z usuniętych pól i zaszyfrowuje tokeny
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

      // Przygotuj kopię do serializacji z zaszyfrowanymi kluczami wrażliwymi
      const toSerialize: Record<string, unknown> = { ...this.data };
      for (const k of SENSITIVE_FIELDS) {
        if (typeof toSerialize[k] === 'string') {
          toSerialize[k] = encryptSecret(toSerialize[k] as string);
        }
      }

      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(toSerialize, null, 2), 'utf8');
      try {
        fs.renameSync(tempPath, this.filePath);
      } catch {
        fs.copyFileSync(tempPath, this.filePath);
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
    } catch (err) {
      console.error('[config] atomic save error:', (err as Error).message);
      try {
        const fallbackSerialize: Record<string, unknown> = { ...this.data };
        for (const k of SENSITIVE_FIELDS) {
          if (typeof fallbackSerialize[k] === 'string') {
            fallbackSerialize[k] = encryptSecret(fallbackSerialize[k] as string);
          }
        }
        fs.writeFileSync(this.filePath, JSON.stringify(fallbackSerialize, null, 2), 'utf8');
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

  /**
   * Wywoływane po app.whenReady() aby upewnić się, że safeStorage (DPAPI)
   * jest dostępne i zaktualizować szyfrowanie z fallbacku do DPAPI.
   */
  upgradeEncryption(): void {
    if (isSafeStorageReady()) {
      this.load();
      this.save();
    }
  }
}
