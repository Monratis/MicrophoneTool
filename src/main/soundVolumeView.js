import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';

const DOWNLOAD_URL = 'https://www.nirsoft.net/utils/soundvolumeview-x64.zip';

/**
 * Niskopoziomowy moduł narzędzia SoundVolumeView (NirSoft).
 * Zajmuje się: zapewnieniem binarki (pobranie z nirsoft.net, jeśli brak),
 * eksportem listy urządzeń, ustawianiem domyślnego urządzenia nagrywającego.
 */
export default class SoundVolumeView {
  constructor({ binDir, toolsDir, config }) {
    this.binDir = binDir;
    this.toolsDir = toolsDir;
    this.config = config;
    this.statusCb = null;
  }

  onStatus(cb) {
    this.statusCb = cb;
  }

  _emitStatus(msg) {
    if (this.statusCb) this.statusCb(msg);
  }

  get exePath() {
    return path.join(this.binDir, 'SoundVolumeView.exe');
  }

  /**
   * Zwraca ścieżkę do binarki, pobierając ją w razie potrzeby do userData/tools.
   * @returns {Promise<string|null>}
   */
  async ensure() {
    const candidates = [this.exePath, path.join(this.toolsDir, 'SoundVolumeView.exe')];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    if (!this.config.get('autoDownloadTools')) {
      return null;
    }
    this._emitStatus('Pobieram SoundVolumeView z nirsoft.net…');
    try {
      const out = await this._download();
      this._emitStatus('Narzędzie audio gotowe');
      return out;
    } catch (err) {
      console.error('[svv] download failed:', err.message);
      this._emitStatus('Nie udało się pobrać SoundVolumeView — pobierz ręcznie z nirsoft.net');
      return null;
    }
  }

  async _download() {
    fs.mkdirSync(this.toolsDir, { recursive: true });
    const res = await fetch(DOWNLOAD_URL, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => /soundvolumeview\.exe$/i.test(e.entryName));
    if (!entry) throw new Error('Brak SoundVolumeView.exe w archiwum');
    const out = path.join(this.toolsDir, 'SoundVolumeView.exe');
    fs.writeFileSync(out, entry.getData());
    return out;
  }

  _run(exe, args) {
    return new Promise((resolve) => {
      execFile(exe, args, { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout, stderr });
      });
    });
  }

  /**
   * Ustawia domyślne urządzenie nagrywające.
   */
  async setDefault(deviceName) {
    const exe = await this.ensure();
    if (!exe) {
      return { ok: false, stdout: '', stderr: 'Brak SoundVolumeView.exe' };
    }
    const res = await this._run(exe, ['/SetDefault', deviceName, 'all']);
    if (res.ok) {
      console.log(`[audio] Default recording device -> "${deviceName}"`);
    } else {
      console.error(`[audio] SetDefault failed for "${deviceName}":`, res.stderr);
    }
    return res;
  }

  /**
   * Eksportuje listę urządzeń i zwraca nagrywające (Type = Recording).
   * @returns {Promise<{name: string, isDefault: boolean}[]>}
   */
  async listRecordingDevices() {
    const exe = await this.ensure();
    if (!exe) return [];
    const tmp = path.join(os.tmpdir(), `svv-${Date.now()}-${process.pid}.csv`);
    try {
      const res = await this._run(exe, ['/scomma', tmp]);
      if (!res.ok || !fs.existsSync(tmp)) return [];
      const raw = fs.readFileSync(tmp);
      let text;
      try {
        text = iconv.decode(raw, 'cp1250');
      } catch (_) {
        text = raw.toString('latin1');
      }
      const rows = parseCsv(text);
      if (rows.length < 2) return [];
      const h = rows[0];
      const iName = h.indexOf('Name');
      const iType = h.indexOf('Type');
      const iDefault = h.indexOf('Default');
      const recs = [];
      for (const r of rows.slice(1)) {
        const type = (iType >= 0 ? r[iType] : '').trim().toLowerCase();
        if (type === 'recording') {
          recs.push({
            name: (iName >= 0 ? r[iName] : '').trim(),
            isDefault: iDefault >= 0 && (r[iDefault] || '').trim() !== ''
          });
        }
      }
      return recs.filter((d) => d.name);
    } catch (err) {
      console.error('[svv] listRecordingDevices error:', err.message);
      return [];
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    }
  }

  /**
   * Heurystyka dobrania nazw mikrofonów do roli biurko/słuchawki.
   * @returns {{micDeskName: string, micHeadsetName: string}}
   */
  resolveNames(devices) {
    const names = devices.map((d) => d.name);
    const noisy = /headset|headphone|słuchawk|microphone array|stereo mix|line in|what u hear|listen|monitor/i;
    const desk = names.find((n) => /quadcast|yet|blue\b|nano|rode|shure|hyperx|mic(rophone)?$/i.test(n))
      || names.find((n) => !noisy.test(n));
    const headset = names.find((n) => /headset|headphone|słuchawk/i.test(n))
      || names.find((n) => n !== desk && !/microphone array|stereo mix|line in|what u hear/i.test(n));
    return {
      micDeskName: desk || names[0] || '',
      micHeadsetName: headset || desk || names[0] || ''
    };
  }
}

/**
 * Prosty parser CSV z obsługą cudzysłowów i ",,".
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
  }
  return rows;
}