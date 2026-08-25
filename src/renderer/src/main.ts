import './styles.css';
import type { AudioDeviceItem, PushEvent, SerialPortInfo, Snapshot, UpdaterStatus } from './global';

const STATE_LABEL: Record<string, string> = { desk: 'Przy biurku (Stacjonarny)', away: 'Poza biurkiem (Mobilny)' };

// Escapowanie treści wstrzykiwanych do innerHTML (nazwy urządzeń, porty,
// komunikaty, dane z GitHub Releases) — bez tego możliwy HTML injection.
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const MODE_LABEL: Record<string, string> = {
  auto: 'Auto (radar)',
  desk: 'Stacjonarny',
  headset: 'Mobilny'
};

// ---------- Web Audio Chime Synthesizer ----------

// Jeden współdzielony kontekst — tworzenie nowego na każdy dzwonek wycieka
// (przeglądowe limity ~6 AudioContext; po kilku przełączeniach chime przestaje grać).
let sharedAudioCtx: AudioContext | null = null;

// Twardy sufit głośności chime — konfiguracja użytkownika nigdy nie
// przekroczy komfortowego poziomu (pełna skala = bolesny sygnał sinus).
const CHIME_MAX_GAIN = 0.35;

function playChime(state: 'desk' | 'away', volume = 0.2) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }
    const ctx = sharedAudioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    if (state === 'desk') {
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.08);
    } else {
      osc.frequency.setValueAtTime(783.99, now);
      osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.08);
    }

    const safeVol = Math.min(CHIME_MAX_GAIN, Math.max(0.01, volume));
    // Obwiednia z krótkim atakiem — skok do pełnej amplitudy słychać jako klik.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(safeVol, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  } catch (_) {}
}

// ---------- Application State & UI ----------

class AppUI {
  private root: HTMLElement;
  private snap: Snapshot | null = null;
  private form: Snapshot['config'] | null = null;
  private ports: SerialPortInfo[] = [];
  private audioDevices: AudioDeviceItem[] = [];
  private isMuted = false;
  private dirty = false;
  private saving = false;
  private refreshingPorts = false;
  private deviceInfo = '';
  private updater: UpdaterStatus = { status: 'idle', currentVersion: '' };
  private downloadProgress: { percent: number; speed: string } | null = null;
  private toasts: { id: number; message: string; error?: boolean }[] = [];
  private toastCounter = 0;
  private saveState = { text: '', kind: 'idle' };

  // Telemetria biometryczna na żywo i model adaptacyjny
  private telemetry: {
    presence?: boolean;
    distanceCm?: number;
    heartRate?: number;
    breathRate?: number;
    detectedPerson?: 'me' | 'other' | 'pet' | 'unknown';
    autoTuning?: {
      enabled: boolean;
      mode: 'learning' | 'tracking' | 'idle';
      speed: 'balanced' | 'fast' | 'conservative';
      noiseFloor: number;
      samplesCount: number;
      adaptedDistanceCenter: number;
      adaptedDistanceMin: number;
      adaptedDistanceMax: number;
      adaptedHeartRateAvg: number;
      adaptedBreathRateAvg: number;
      stabilityScore: number;
      lastAdaptedAt: number;
    };
  } = {
    distanceCm: 0,
    heartRate: 0,
    breathRate: 0,
    detectedPerson: 'unknown',
    autoTuning: {
      enabled: true,
      mode: 'tracking',
      speed: 'balanced',
      noiseFloor: 0,
      samplesCount: 0,
      adaptedDistanceCenter: 75,
      adaptedDistanceMin: 40,
      adaptedDistanceMax: 110,
      adaptedHeartRateAvg: 0,
      adaptedBreathRateAvg: 0,
      stabilityScore: 90,
      lastAdaptedAt: 0
    }
  };

  // Modale aplikacji
  private wizardOpen = false;
  private wizardStep: 1 | 2 | 3 | 4 = 1;
  private wizardCountdown = 0;
  private wizardInterval: any = null;
  private wizardSamples: { distances: number[]; heartRates: number[]; breathRates: number[] } = {
    distances: [],
    heartRates: [],
    breathRates: []
  };
  private wizardResults = {
    distance: 75,
    gateMin: 45,
    gateMax: 110,
    heartRateAvg: 68,
    heartRateMin: 55,
    heartRateMax: 78,
    breathRateAvg: 14
  };

  private bioModalOpen = false;
  private flasherModalOpen = false;
  private logsModalOpen = false;
  private logs: string[] = [];
  private sensorFlashing = false;
  private sensorFlashProgress = { percent: 0, stage: '', message: '' };

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async init() {
    this.snap = await window.api.getState();
    this.form = { ...this.snap.config };
    if (this.snap.telemetry) {
      this.telemetry = { ...this.snap.telemetry };
    }
    this.ports = await window.api.getPorts();
    await this.loadAudioDevices();

    const upd = await window.api.getUpdaterStatus();
    if (upd) this.updater = upd;

    window.api.onEvent((e: PushEvent) => this.handleEvent(e));

    // Polling urządzeń/portów co 3 s — podłączenie nowego mikrofonu musi
    // być widoczne na liście BEZ klikania "odśwież". Serwer ma cache 3 s,
    // więc koszt to jeden tani IPC; DOM ruszamy tylko przy faktycznej zmianie.
    this.lastDeviceSig = this.deviceListSig(this.audioDevices);
    this.lastPortSig = this.portListSig(this.ports);
    setInterval(() => {
      if (!this.snap) return;
      void this.pollHardwareLists();
    }, 3000);

    this.render();

    // Escape zamyka najwyższe otwarte modalne okno. Raz na dokumencie —
    // bindEvents odpala się przy każdym renderze i stackowałoby listenery.
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (this.wizardOpen) {
        ev.preventDefault();
        this.closeCalibrationWizard();
      } else if (this.bioModalOpen || this.flasherModalOpen || this.logsModalOpen) {
        ev.preventDefault();
        this.bioModalOpen = false;
        this.flasherModalOpen = false;
        this.logsModalOpen = false;
        this.render();
      }
    });

    this.render();
  }

  private async loadAudioDevices() {
    try {
      const devs = await window.api.listDevices();
      this.audioDevices = devs || [];
      const current = devs.find((d) => d.isDefault);
      if (current && typeof current.isMuted === 'boolean') {
        this.isMuted = current.isMuted;
      }
    } catch (_) {}
  }

  private handleEvent(e: PushEvent) {
    if (e.type === 'snapshot' && e.snapshot) {
      this.snap = e.snapshot;
      if (e.snapshot.telemetry) {
        this.telemetry = { ...e.snapshot.telemetry };
      }
      if (!this.dirty) {
        this.form = { ...e.snapshot.config };
      }
      // Punktowa aktualizacja — pełny rebuild widoku tylko przy akcjach użytkownika
      this.loadAudioDevices().then(() => {
        if (document.getElementById('state-title')) {
          this.applySnapshotToDOM();
        } else {
          this.scheduleRender();
        }
      });
      return;
    }

    if (e.type === 'telemetry') {
      const { type: _ignored, ...tel } = e;
      this.telemetry = { ...this.telemetry, ...tel };
      this.updateTelemetryDOM();

      if (this.wizardOpen && this.wizardCountdown > 0) {
        if (this.wizardStep === 2 && this.telemetry.distanceCm) {
          this.wizardSamples.distances.push(this.telemetry.distanceCm);
        } else if (this.wizardStep === 3) {
          if (this.telemetry.heartRate) this.wizardSamples.heartRates.push(this.telemetry.heartRate);
          if (this.telemetry.breathRate) this.wizardSamples.breathRates.push(this.telemetry.breathRate);
        }
      }
    }

    if (e.type === 'toast' && e.message) {
      this.pushToast(e.message, e.error);
    }

    if (e.type === 'switch' && e.state) {
      if (this.form && this.form.audioChime) {
        const shouldChime = e.state === 'desk' ? (this.form.audioChimeOnDesk !== false) : (this.form.audioChimeOnAway !== false);
        if (shouldChime) {
          playChime(e.state as 'desk' | 'away', this.form.audioChimeVolume ?? 0.2);
        }
      }
    }

    if (e.type === 'updater:status') {
      this.updater = {
        ...this.updater,
        status: (e.status as any) || this.updater.status,
        updateInfo: e.updateInfo !== undefined ? e.updateInfo : this.updater.updateInfo,
        error: e.error ? String(e.error) : undefined
      };
      // Tylko strefa bannerów + przycisk sprawdzania — reszta widoku nietknięta
      const zone = document.getElementById('update-zone');
      if (zone) {
        zone.innerHTML = this.buildUpdateZoneHtml();
        this.attachUpdateZoneEvents();
        const btn = document.getElementById('btn-check-updates') as HTMLButtonElement | null;
        if (btn) {
          btn.disabled = this.updater.status === 'checking' || this.updater.status === 'downloading';
          btn.textContent = this.updater.status === 'checking' ? 'Sprawdzanie…' : 'Sprawdź aktualizacje';
        }
      } else {
        this.render();
      }
    }

    if (e.type === 'updater:progress') {
      this.downloadProgress = {
        percent: e.percent || 0,
        speed: e.speed || ''
      };
      // Celowana aktualizacja paska — pełny render tutaj migałby kilkanaście
      // razy na sekundę podczas pobierania.
      const fill = document.getElementById('upd-progress-fill');
      const txt = document.getElementById('upd-progress-text');
      if (fill && txt) {
        fill.style.width = `${e.percent || 0}%`;
        txt.textContent = `${e.percent || 0}% (${e.speed || ''})`;
      } else {
        this.render();
      }
    }

    if (e.type === 'sensor:flash-progress') {
      this.sensorFlashing = (e.stage !== 'done' && e.stage !== 'error');
      this.sensorFlashProgress = {
        percent: e.percent || 0,
        stage: e.stage || '',
        message: e.message || ''
      };
      if (e.stage === 'error') {
        this.pushToast(e.message || 'Błąd wgrywania firmware', true);
      }
      // Celowana aktualizacja metra flashera (eventy lecą gęsto podczas zapisu)
      const fill = document.getElementById('flash-meter-fill');
      const pct = document.getElementById('flash-pct-text');
      const msg = document.getElementById('flash-msg-text');
      if (fill && pct) {
        fill.style.width = `${e.percent || 0}%`;
        pct.textContent = `${e.percent || 0}%`;
        if (msg && e.message) msg.textContent = e.message;
      } else {
        this.render();
      }
    }

    if (e.type === 'sensor:flash-complete') {
      this.sensorFlashing = false;
      this.pushToast('Firmware sensora został pomyślnie zaktualizowany przez USB! ✓');
      this.render();
    }

    if (e.type === 'log:entry' && (e.entry || e.message)) {
      const line = e.entry || e.message || '';
      this.logs.push(line);
      if (this.logs.length > 500) this.logs.shift();
      if (this.logsModalOpen) {
        const logConsole = document.getElementById('log-console');
        if (logConsole) {
          logConsole.textContent = this.logs.join('\n');
          logConsole.scrollTop = logConsole.scrollHeight;
        }
      }
    }
  }

  private updateTelemetryDOM() {
    const elDist = document.getElementById('tel-distance');
    const elHeart = document.getElementById('tel-heart');
    const elBreath = document.getElementById('tel-breath');
    const elPerson = document.getElementById('tel-person');

    if (elDist) elDist.textContent = this.telemetry.distanceCm ? `${this.telemetry.distanceCm} cm` : '—';
    if (elHeart) elHeart.textContent = this.telemetry.heartRate ? `${this.telemetry.heartRate} BPM` : '—';
    if (elBreath) elBreath.textContent = this.telemetry.breathRate ? `${this.telemetry.breathRate} RPM` : '—';

    if (elPerson) {
      const p = this.telemetry.detectedPerson || 'unknown';
      elPerson.className = `person-badge ${p}`;
      if (p === 'me') {
        elPerson.textContent = '👤 Zidentyfikowano: Właściciel ✓';
      } else if (p === 'pet') {
        elPerson.textContent = '🐾 Zwierzę (Kot/Pies - zignorowano)';
      } else if (p === 'other') {
        elPerson.textContent = '👥 Wykryto: Narzeczona / Inna osoba';
      } else {
        elPerson.textContent = '🔍 Oczekiwanie na biometrię…';
      }
    }

    const tun = this.telemetry.autoTuning;
    if (tun) {
      const elTunBadge = document.getElementById('tun-status-badge');
      const elTunStability = document.getElementById('tun-stability');
      const elTunDist = document.getElementById('tun-distance');
      const elTunDistGate = document.getElementById('tun-distance-gate');
      const elTunHeart = document.getElementById('tun-heart');
      const elTunBreath = document.getElementById('tun-breath');
      const elTunNoise = document.getElementById('tun-noise');
      const elTunNoiseDesc = document.getElementById('tun-noise-desc');

      if (elTunBadge) {
        elTunBadge.className = `tuning-badge ${tun.mode || 'tracking'}`;
        elTunBadge.textContent = (tun.mode === 'learning') ? 'Adaptacja w toku' : 'Aktywny ✓';
      }
      if (elTunStability) elTunStability.textContent = `${tun.stabilityScore ?? 92}%`;
      if (elTunDist) elTunDist.textContent = tun.adaptedDistanceCenter ? `${tun.adaptedDistanceCenter} cm` : '—';
      if (elTunDistGate) elTunDistGate.textContent = `Dynamiczna strefa: ${tun.adaptedDistanceMin || 40}–${tun.adaptedDistanceMax || 110} cm`;
      if (elTunHeart) elTunHeart.textContent = tun.adaptedHeartRateAvg ? `${tun.adaptedHeartRateAvg} BPM` : '—';
      if (elTunBreath) elTunBreath.textContent = tun.adaptedBreathRateAvg ? `Oddech: ${tun.adaptedBreathRateAvg} RPM` : 'Oddech: —';
      if (elTunNoise) {
        elTunNoise.className = `cell-val ${(tun.noiseFloor || 0) > 25 ? 'warning' : 'clean'}`;
        elTunNoise.textContent = `${tun.noiseFloor ?? 0}%`;
      }
      if (elTunNoiseDesc) {
        elTunNoiseDesc.textContent = (tun.noiseFloor || 0) < 15 ? 'Czyste otoczenie ✓' : 'Wykryto drobne zakłócenia';
      }
    }
  }

  private pushToast(message: string, error = false) {
    const id = ++this.toastCounter;
    // Limit stosu — lawina eventów nie może zasypać ekranu komunikatami
    if (this.toasts.length >= 4) {
      const oldest = this.toasts.shift();
      if (oldest) clearTimeout((oldest as any)._timer);
    }
    this.toasts.push({ id, message, error });
    this.renderToasts();
    const timer = setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.renderToasts();
    }, 4000);
    (this.toasts[this.toasts.length - 1] as any)._timer = timer;
  }

  private renderToasts() {
    const container = this.root.querySelector('.toasts');
    if (!container) return;
    container.innerHTML = this.toasts
      .map((t) => `<div class="toast ${t.error ? 'error' : ''}">${esc(t.message)}</div>`)
      .join('');
  }

  private patchForm(patch: Partial<Snapshot['config']>, reRender = true) {
    if (!this.form) return;
    this.form = { ...this.form, ...patch };
    this.dirty = true;
    this.saveState = { text: 'Niezapisane zmiany', kind: 'dirty' };

    if (reRender) {
      this.render();
    } else {
      const btnSave = document.getElementById('btn-save') as HTMLButtonElement | null;
      const saveStateEl = document.querySelector('.save-state') as HTMLElement | null;
      if (btnSave) btnSave.disabled = false;
      if (saveStateEl) {
        saveStateEl.className = 'save-state dirty';
        saveStateEl.textContent = 'Niezapisane zmiany';
      }
    }
  }

  private async save() {
    if (!this.form || this.saving) return;
    this.saving = true;
    this.saveState = { text: 'Zapisywanie…', kind: 'saving' };
    this.render();

    try {
      this.snap = await window.api.updateConfig(this.form);
      this.form = { ...this.snap.config };
      this.dirty = false;
      this.saveState = { text: 'Zapisano pomyślnie ✓', kind: 'saved' };
      this.pushToast('Ustawienia zostały zapisane');
      setTimeout(() => {
        if (!this.dirty) {
          this.saveState = { text: '', kind: 'idle' };
          this.render();
        }
      }, 2500);
    } catch (err: any) {
      this.saveState = { text: 'Błąd zapisu', kind: 'error' };
      this.pushToast(`Błąd zapisu: ${err.message}`, true);
    } finally {
      this.saving = false;
      this.render();
    }
  }

  // Wizard Methods
  private openCalibrationWizard() {
    this.wizardOpen = true;
    this.wizardStep = 1;
    this.wizardCountdown = 0;
    if (this.wizardInterval) clearInterval(this.wizardInterval);
    this.wizardInterval = null;
    this.render();
  }

  private closeCalibrationWizard() {
    this.wizardOpen = false;
    if (this.wizardInterval) clearInterval(this.wizardInterval);
    this.wizardInterval = null;
    this.render();
  }

  private runWizardStep1() {
    this.wizardCountdown = 5;
    this.render();
    this.wizardInterval = setInterval(() => {
      this.wizardCountdown--;
      if (this.wizardCountdown <= 0) {
        clearInterval(this.wizardInterval);
        this.wizardInterval = null;
        playChime('desk', 0.2);
        this.wizardStep = 2;
      }
      this.render();
    }, 1000);
  }

  private runWizardStep2() {
    this.wizardCountdown = 6;
    this.wizardSamples.distances = [];
    if (this.telemetry.distanceCm) this.wizardSamples.distances.push(this.telemetry.distanceCm);
    this.render();

    this.wizardInterval = setInterval(() => {
      this.wizardCountdown--;
      if (this.wizardCountdown <= 0) {
        clearInterval(this.wizardInterval);
        this.wizardInterval = null;

        const validDistances = this.wizardSamples.distances.filter((d) => d >= 30 && d <= 180);
        const avgDist = validDistances.length > 0
          ? Math.round(validDistances.reduce((a, b) => a + b, 0) / validDistances.length)
          : (this.telemetry.distanceCm || 75);

        this.wizardResults.distance = avgDist;
        this.wizardResults.gateMin = Math.max(30, avgDist - 25);
        this.wizardResults.gateMax = Math.min(200, avgDist + 35);

        playChime('desk', 0.2);
        this.wizardStep = 3;
      }
      this.render();
    }, 1000);
  }

  private runWizardStep3() {
    this.wizardCountdown = 8;
    this.wizardSamples.heartRates = [];
    this.wizardSamples.breathRates = [];
    if (this.telemetry.heartRate) this.wizardSamples.heartRates.push(this.telemetry.heartRate);
    if (this.telemetry.breathRate) this.wizardSamples.breathRates.push(this.telemetry.breathRate);
    this.render();

    this.wizardInterval = setInterval(() => {
      this.wizardCountdown--;
      if (this.wizardCountdown <= 0) {
        clearInterval(this.wizardInterval);
        this.wizardInterval = null;

        const validHr = this.wizardSamples.heartRates.filter((h) => h >= 45 && h <= 120);
        const avgHr = validHr.length > 0
          ? Math.round(validHr.reduce((a, b) => a + b, 0) / validHr.length)
          : (this.telemetry.heartRate || 68);

        const validRpm = this.wizardSamples.breathRates.filter((r) => r >= 8 && r <= 24);
        const avgRpm = validRpm.length > 0
          ? Math.round(validRpm.reduce((a, b) => a + b, 0) / validRpm.length)
          : (this.telemetry.breathRate || 14);

        this.wizardResults.heartRateAvg = avgHr;
        this.wizardResults.heartRateMin = Math.max(45, avgHr - 12);
        this.wizardResults.heartRateMax = Math.min(115, avgHr + 14);
        this.wizardResults.breathRateAvg = avgRpm;

        playChime('desk', 0.25);
        this.wizardStep = 4;
      }
      this.render();
    }, 1000);
  }

  private applyWizardCalibration() {
    this.patchForm({
      radarDistanceGateEnabled: true,
      radarMinDistanceCm: this.wizardResults.gateMin,
      radarMaxDistanceCm: this.wizardResults.gateMax,
      petFilterEnabled: true,
      biometricsEnabled: true,
      userHeartRateMin: this.wizardResults.heartRateMin,
      userHeartRateMax: this.wizardResults.heartRateMax,
      userSeatingDistanceMin: Math.max(30, this.wizardResults.distance - 15),
      userSeatingDistanceMax: this.wizardResults.distance + 20
    });

    this.closeCalibrationWizard();
    this.save();
    this.pushToast('Kalibracja sensora zakończona i zapisana ✓');
  }

  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRender = false;
  private lastDeviceSig = '';
  private lastPortSig = '';

  private deviceListSig(devices: AudioDeviceItem[]): string {
    return devices.map((d) => `${d.id || d.name}|${d.isDefault ? 1 : 0}`).sort().join(';');
  }

  private portListSig(ports: SerialPortInfo[]): string {
    return ports.map((p) => p.path).sort().join(';');
  }

  /** Odświeża listy sprzętu w tle; DOM tylko przy realnej zmianie. */
  private async pollHardwareLists(): Promise<void> {
    try {
      const devs = await window.api.listDevices();
      if (this.deviceListSig(devs || []) !== this.lastDeviceSig) {
        this.audioDevices = devs || [];
        this.lastDeviceSig = this.deviceListSig(this.audioDevices);
        this.refreshMicSelectOptions();
      }
      const ports = await window.api.getPorts();
      if (this.portListSig(ports) !== this.lastPortSig) {
        this.ports = ports;
        this.lastPortSig = this.portListSig(ports);
        const sel = document.getElementById('sel-port') as HTMLSelectElement | null;
        if (sel) {
          sel.innerHTML =
            `<option value="auto" ${this.form?.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie XIAO ESP32-C6)</option>` +
            this.ports
              .map(
                (p) =>
                  `<option value="${esc(p.path)}" ${p.path === this.form!.port ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`
              )
              .join('');
        }
      }
    } catch {
      /* pomijanie cyklu */
    }
  }

  /** Przebudowuje opcje selektów mikrofonów zachowując aktualny wybór. */
  private refreshMicSelectOptions(): void {
    if (!this.form) return;
    const form = this.form;
    const build = (id: string, savedName: string): void => {
      const sel = document.getElementById(id) as HTMLSelectElement | null;
      if (!sel) return;
      const current = savedName;
      sel.innerHTML =
        `<option value="" ${!current ? 'selected' : ''}>— Wybierz mikrofon z listy —</option>` +
        this.missingDeviceOption(current, this.audioDevices) +
        this.audioDevices
          .map(
            (d) =>
              `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === current ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`
          )
          .join('');
    };
    build('sel-mic-desk', form.micDeskName);
    build('sel-mic-headset', form.micHeadsetName);
  }

  /**
   * Render kolejkowany: snapshoty potrafią leć co ~2 s (status radaru),
   * a pełny rebuild DOM zamyka otwarte selecty, gubi kursor w polach
   * i przerywa hover. Kolejkujemy + odkładamy gdy użytkownik coś wpisuje.
   */
  private scheduleRender(): void {
    // Otwarty modal = żaden snapshot nie przebudowuje widoku pod spodem
    // (to źródło "migania" modala). Dane siedzą w this.snap/form —
    // zamknięcie modala i tak robi render().
    if (this.wizardOpen || this.bioModalOpen || this.flasherModalOpen || this.logsModalOpen) return;
    this.pendingRender = true;
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      const ae = document.activeElement as HTMLInputElement | null;
      const typing =
        !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae.type !== 'range';
      if (typing) {
        // Poczekaj aż użytkownik skończy edycję pola
        ae.addEventListener(
          'blur',
          () => {
            if (this.pendingRender) {
              this.pendingRender = false;
              this.render();
            }
          },
          { once: true }
        );
        return;
      }
      this.pendingRender = false;
      this.render();
    }, 400);
  }

  /** Izolowana strefa bannerów aktualizacji — przebudowywana osobno, bez ruszania reszty widoku. */
  private buildUpdateZoneHtml(): string {
    if (this.updater.status === 'available' && this.updater.updateInfo) {
      return `<div class="update-banner">
                  <div class="update-banner-icon">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                  <div class="update-banner-content">
                    <strong>Nowa wersja dostępna: v${esc(this.updater.updateInfo.version)}</strong>
                    <p>${esc(this.updater.updateInfo.name || 'Nowe funkcje i usprawnienia')}</p>
                    <button class="btn btn-sm btn-primary" id="btn-download-update">Pobierz i zaktualizuj</button>
                  </div>
                </div>`;
    }
    if (this.updater.status === 'downloading') {
      return `<div class="update-banner downloading">
                  <div class="update-banner-content" style="width: 100%">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                      <strong>Pobieranie aktualizacji…</strong>
                      <span id="upd-progress-text">${this.downloadProgress?.percent || 0}% (${this.downloadProgress?.speed || '...'})</span>
                    </div>
                    <div class="progress-bar">
                      <div class="progress-fill" id="upd-progress-fill" style="width: ${this.downloadProgress?.percent || 0}%"></div>
                    </div>
                  </div>
                </div>`;
    }
    if (this.updater.status === 'downloaded') {
      return `<div class="update-banner ready">
                  <div class="update-banner-icon">✓</div>
                  <div class="update-banner-content">
                    <strong>Aktualizacja gotowa do instalacji!</strong>
                    <p>Kliknij poniżej, aby zrestartować aplikację.</p>
                    <button class="btn btn-sm btn-primary" id="btn-install-update">Zainstaluj i uruchom ponownie</button>
                  </div>
                </div>`;
    }
    return '';
  }

  private attachUpdateZoneEvents(): void {
    document.getElementById('btn-download-update')?.addEventListener('click', async () => {
      this.pushToast('Rozpoczynam pobieranie aktualizacji…');
      try {
        await window.api.downloadUpdate();
      } catch (err: any) {
        this.pushToast(`Błąd pobierania: ${err.message}`, true);
      }
    });
    document.getElementById('btn-install-update')?.addEventListener('click', async () => {
      try {
        await window.api.installUpdate();
      } catch (err: any) {
        this.pushToast(`Nie można zainstalować: ${err.message}`, true);
      }
    });
  }

  /** Punktowa synchronizacja UI ze snapshotem — bez pełnego rebuildu widoku. */
  private applySnapshotToDOM(): void {
    if (!this.snap || !this.form) return;
    const snap = this.snap;
    const isUnconfigured = !this.form.micDeskName && !this.form.micHeadsetName;

    const title = document.getElementById('state-title');
    if (title) {
      title.textContent = snap.state ? STATE_LABEL[snap.state] : (isUnconfigured ? 'Brak konfiguracji' : 'Oczekiwanie…');
    }
    const dev = document.getElementById('device-name');
    if (dev) {
      dev.textContent = snap.deviceName ? snap.deviceName : (isUnconfigured ? 'Nie wybrano' : '—');
    }
    const radarBadge = document.getElementById('radar-badge');
    if (radarBadge) {
      radarBadge.textContent = snap.radar.connected ? 'Radar: połączony' : 'Radar: brak połączenia';
      radarBadge.className = `badge ${snap.radar.connected ? 'live' : ''}`;
    }
    document.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-mode') === snap.mode);
    });
    const pill = document.getElementById('btn-toggle-mute');
    if (pill) {
      pill.className = `mute-pill ${this.isMuted ? 'muted' : ''}`;
      pill.textContent = this.isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny';
    }
    // Synchronizacja wybranych opcji (gdy opcja istnieje na liście)
    const syncSelect = (id: string, val: string): void => {
      const sel = document.getElementById(id) as HTMLSelectElement | null;
      if (!sel) return;
      if (Array.from(sel.options).some((o) => o.value === val)) sel.value = val;
    };
    syncSelect('sel-mic-desk', this.form.micDeskName);
    syncSelect('sel-mic-headset', this.form.micHeadsetName);
    syncSelect('sel-port', this.form.port);
  }

  render() {
    if (!this.snap || !this.form) {
      this.root.innerHTML = `<div class="app" style="display:grid;place-items:center;color:var(--muted)">Wczytywanie…</div>`;
      return;
    }

    // Preserve scroll position so checkboxes/switches NEVER scroll to the top
    const oldScrollEl = this.root.querySelector('.scroll');
    const scrollPos = oldScrollEl ? oldScrollEl.scrollTop : 0;

    const state = this.snap.state;
    const radar = this.snap.radar;
    const isUnconfigured = !this.form.micDeskName && !this.form.micHeadsetName;
    const person = this.telemetry.detectedPerson || 'unknown';

    this.root.innerHTML = `
      <div class="app">
        <!-- titlebar -->
        <div class="titlebar">
          <div class="brand">
            <span class="logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
              </svg>
            </span>
            Auto Audio Switch
            <span class="ver-tag">v${esc(this.snap.version || this.updater.currentVersion)}</span>
          </div>
          <div class="win-btns">
            <button class="close" id="btn-close" title="Ukryj do zasobnika (Tray)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div class="scroll">
          <!-- unconfigured banner -->
          ${
            isUnconfigured
              ? `<div class="update-banner" style="border-color: rgba(245, 158, 11, 0.6); background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(217, 119, 6, 0.12))">
                  <div class="update-banner-icon" style="background: #f59e0b">⚠️</div>
                  <div class="update-banner-content">
                    <strong style="color: #fbbf24">Wybierz swoje mikrofony poniżej</strong>
                    <p>Wskaż mikrofon stacjonarny i mobilny z list rozwijanych i kliknij <strong>Zapisz zmiany</strong>.</p>
                  </div>
                </div>`
              : ''
          }

          <!-- update banner (izolowana strefa — odświezana punktowo) -->
          <div id="update-zone">${this.buildUpdateZoneHtml()}</div>

          <!-- status hero & mode segmented -->
          <section class="card">
            <div class="status-hero" data-state="${state || ''}">
              <div class="status-ring">
                <span class="pulse"></span>
                <span class="dot">
                  <svg viewBox="0 0 24 24" fill="none" stroke="${state === 'desk' ? '#0d0f14' : '#fff'}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="2" width="6" height="11" rx="3" />
                    <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                  </svg>
                </span>
              </div>
                <div class="status-meta">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
                  <h1 id="state-title">${state ? STATE_LABEL[state] : (isUnconfigured ? 'Brak konfiguracji' : 'Oczekiwanie…')}</h1>
                  <button class="mute-pill ${this.isMuted ? 'muted' : ''}" id="btn-toggle-mute" title="Wycisz/Odcisz (skrót: Ctrl+Shift+M)">
                    ${this.isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny'}
                  </button>
                </div>
                <p>
                  Domyślny mikrofon: <strong id="device-name">${this.snap.deviceName ? esc(this.snap.deviceName) : (isUnconfigured ? 'Nie wybrano' : '—')}</strong>
                </p>
                <div class="badges" style="margin-top: 6px">
                  <span class="badge">${MODE_LABEL[this.snap.mode] || this.snap.mode}</span>
                  <span class="badge ${radar.connected ? 'live' : ''}" id="radar-badge">
                    ${radar.connected ? 'Radar: połączony' : 'Radar: brak połączenia'}
                  </span>
                </div>
              </div>
            </div>

            <!-- segmented mode switcher -->
            <div class="segmented" style="margin-top: 12px">
              <button class="${this.snap.mode === 'auto' ? 'active' : ''}" data-mode="auto">Auto (radar)</button>
              <button class="${this.snap.mode === 'desk' ? 'active' : ''}" data-mode="desk">🎙️ Stacjonarny</button>
              <button class="${this.snap.mode === 'headset' ? 'active' : ''}" data-mode="headset">🎧 Mobilny</button>
            </div>
          </section>

          <!-- 2-COLUMN DESKTOP GRID -->
          <div class="grid-2col">
            <!-- LEFT COLUMN: RADAR INTELLIGENCE & AUTO-TUNING -->
            <div style="display: flex; flex-direction: column; gap: 12px">
              <!-- Radar card -->
              <section class="card">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <h2>📡 Inteligencja Radaru 60 GHz</h2>
                  <span id="tel-person" class="person-badge ${person}">
                    ${person === 'me' ? '👤 Właściciel ✓' : person === 'pet' ? '🐾 Zwierzę (zignorowano)' : person === 'other' ? '👥 Inna osoba' : '🔍 Oczekiwanie…'}
                  </span>
                </div>

                <div class="telemetry-grid" style="margin-top: 8px">
                  <div class="telemetry-card">
                    <div class="t-label">📏 Dystans klatki</div>
                    <div class="t-val live" id="tel-distance">${this.telemetry.distanceCm ? `${this.telemetry.distanceCm} cm` : '—'}</div>
                  </div>
                  <div class="telemetry-card">
                    <div class="t-label">🫀 Tętno (BPM)</div>
                    <div class="t-val" id="tel-heart">${this.telemetry.heartRate ? `${this.telemetry.heartRate} BPM` : '—'}</div>
                  </div>
                  <div class="telemetry-card">
                    <div class="t-label">🫁 Oddech (RPM)</div>
                    <div class="t-val" id="tel-breath">${this.telemetry.breathRate ? `${this.telemetry.breathRate} RPM` : '—'}</div>
                  </div>
                </div>

                <!-- Auto-Tuning Card -->
                <div class="autotuning-card" style="margin-top: 10px">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
                    <div style="display: flex; align-items: center; gap: 6px">
                      <span class="tuning-badge ${this.telemetry.autoTuning?.mode || 'tracking'}" id="tun-status-badge">
                        ${(this.telemetry.autoTuning?.mode === 'learning') ? 'Adaptacja w toku' : 'Aktywny ✓'}
                      </span>
                      <span style="font-size: 10.5px; color: var(--muted)">Stabilność: <strong id="tun-stability" style="color: var(--text)">${this.telemetry.autoTuning?.stabilityScore ?? 92}%</strong></span>
                    </div>
                    <button class="text-btn" id="btn-reset-autotuning" title="Resetuje wyuczone parametry i rozpoczyna naukę od nowa">↺ Zresetuj model</button>
                  </div>

                  <div class="autotuning-grid">
                    <div class="autotuning-cell">
                      <div class="cell-label">📏 Środek fotela</div>
                      <div class="cell-val" id="tun-distance">${this.telemetry.autoTuning?.adaptedDistanceCenter ? this.telemetry.autoTuning.adaptedDistanceCenter + ' cm' : '75 cm'}</div>
                      <div class="cell-sub" id="tun-distance-gate">Strefa: ${this.telemetry.autoTuning?.adaptedDistanceMin || 40}–${this.telemetry.autoTuning?.adaptedDistanceMax || 110} cm</div>
                    </div>
                    <div class="autotuning-cell">
                      <div class="cell-label">🫀 Tętno bazowe</div>
                      <div class="cell-val" id="tun-heart">${this.telemetry.autoTuning?.adaptedHeartRateAvg ? this.telemetry.autoTuning.adaptedHeartRateAvg + ' BPM' : '—'}</div>
                      <div class="cell-sub" id="tun-breath">Oddech: ${this.telemetry.autoTuning?.adaptedBreathRateAvg ? this.telemetry.autoTuning.adaptedBreathRateAvg + ' RPM' : '—'}</div>
                    </div>
                    <div class="autotuning-cell">
                      <div class="cell-label">🛡️ Szum tła pokoju</div>
                      <div class="cell-val ${((this.telemetry.autoTuning?.noiseFloor || 0) > 25) ? 'warning' : 'clean'}" id="tun-noise">
                        ${this.telemetry.autoTuning?.noiseFloor !== undefined ? this.telemetry.autoTuning.noiseFloor + '%' : '0%'}
                      </div>
                      <div class="cell-sub" id="tun-noise-desc">${((this.telemetry.autoTuning?.noiseFloor || 0) < 15) ? 'Czyste otoczenie ✓' : 'Wykryto szum'}</div>
                    </div>
                  </div>

                  <div class="field" style="margin-top: 8px">
                    <div style="display: flex; justify-content: space-between; align-items: center">
                      <label style="font-size: 11px">Szybkość adaptacji:</label>
                      <select class="select select-sm" id="sel-auto-tuning-speed" style="width: auto">
                        <option value="balanced" ${(this.form.radarAutoTuningSpeed || 'balanced') === 'balanced' ? 'selected' : ''}>⚖️ Zbalansowana</option>
                        <option value="fast" ${this.form.radarAutoTuningSpeed === 'fast' ? 'selected' : ''}>⚡ Szybka</option>
                        <option value="conservative" ${this.form.radarAutoTuningSpeed === 'conservative' ? 'selected' : ''}>🛡️ Konserwatywna</option>
                      </select>
                    </div>
                  </div>
                </div>

                <!-- Action Bar with Modal Triggers -->
                <div class="card-action-bar">
                  <button class="btn-feature accent" id="btn-open-wizard">✨ Asystent Kalibracji</button>
                  <button class="btn-feature" id="btn-open-bio-modal">🧬 Profil Biometrii</button>
                  <button class="btn-feature" id="btn-open-flasher-modal">⚡ Firmware Sensora (USB)</button>
                </div>
              </section>

              <!-- Port & Sensitivity Card -->
              <section class="card">
                <h2>⚙️ Port i Czułość Sensora</h2>

                <div class="field">
                  <label>Port COM Sensora</label>
                  <div class="port-line">
                    <select class="select" id="sel-port">
                      <option value="auto" ${this.form.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie XIAO ESP32-C6)</option>
                      ${this.ports
                        .map(
                          (p) =>
                            `<option value="${esc(p.path)}" ${p.path === this.form!.port ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`
                        )
                        .join('')}
                    </select>
                    <button class="icon-btn ${this.refreshingPorts ? 'spin' : ''}" id="btn-refresh-ports" title="Odśwież porty COM">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                        <polyline points="21 3 21 9 15 9" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div class="field" style="margin-top: 10px">
                  <div style="display: flex; justify-content: space-between">
                    <label>Czułość mikro-ruchów i oddechu</label>
                    <span class="slider-val">${this.form.radarSensitivity ?? 80}%</span>
                  </div>
                  <input type="range" class="slider" id="rng-radar-sens" min="20" max="100" step="5" value="${this.form.radarSensitivity ?? 80}" />
                </div>
              </section>
            </div>

            <!-- RIGHT COLUMN: AUDIO DEVICES & AUTOMATIONS -->
            <div style="display: flex; flex-direction: column; gap: 12px">
              <!-- Audio Devices Selection -->
              <section class="card">
                <h2>🎙️ Wybór Mikrofonów Windows</h2>

                <div class="field">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px">
                    <label style="margin: 0; font-weight: 600">🎙️ Mikrofon stacjonarny (biurko)</label>
                    ${this.form.micDeskName ? `<button class="text-btn" id="btn-test-desk">▶ Przetestuj</button>` : ''}
                  </div>
                  <select class="select" id="sel-mic-desk">
                    <option value="" ${!this.form.micDeskName ? 'selected' : ''}>— Wybierz mikrofon z listy —</option>
                    ${this.missingDeviceOption(this.form.micDeskName, this.audioDevices)}
                    ${this.audioDevices
                      .map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === this.form!.micDeskName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`)
                      .join('')}
                  </select>
                  ${
                    typeof this.form.micDeskVolume === 'number' && this.form.micDeskVolume >= 0
                      ? `<div style="display:flex; align-items:center; gap:8px; margin-top:6px">
                          <span style="font-size:10.5px; color:var(--muted)">🔊</span>
                          <input type="range" class="slider" id="rng-vol-desk" min="0" max="100" step="5" value="${this.form.micDeskVolume}" style="flex:1" />
                          <span class="slider-val" id="vol-desk-val">${this.form.micDeskVolume}%</span>
                        </div>`
                      : ''
                  }
                  <div style="display:flex; align-items:center; gap:8px; margin-top:6px">
                    <span style="font-size:10.5px; color:var(--muted)" title="Bramka VAD w Discordzie dla tego mikrofonu">🚪</span>
                    <input type="range" class="slider" id="rng-gate-desk" min="-90" max="0" step="5" value="${Math.max(-90, this.form.micDeskGateDb ?? -60)}" style="flex:1" />
                    <span class="slider-val" id="gate-desk-val">${(this.form.micDeskGateDb ?? -1) >= 0 ? this.form.micDeskGateDb + ' dB' : 'domyślna'}</span>
                  </div>
                  ${(this.form.micDeskGateDb ?? -1) < 0 ? `<small style="display:block; color:var(--muted); font-size:10px; margin-top:2px">Rusz suwak aby ustawić własną bramkę (do tej pory Discord używa swojej)</small>` : ''}
                  <select class="select select-sm" id="sel-krisp-desk" style="margin-top:6px">
                    <option value="default" ${(this.form.micDeskKrisp || 'default') === 'default' ? 'selected' : ''}>🔇 Wyciszenie szumów (Krisp): domyślne Discorda</option>
                    <option value="on" ${this.form.micDeskKrisp === 'on' ? 'selected' : ''}>🔇 Wyciszenie szumów (Krisp): włączone</option>
                    <option value="off" ${this.form.micDeskKrisp === 'off' ? 'selected' : ''}>🔇 Wyciszenie szumów (Krisp): wyłączone</option>
                  </select>
                  <select class="select select-sm" id="sel-agc-desk" style="margin-top:6px">
                    <option value="default" ${(this.form.micDeskAgc || 'default') === 'default' ? 'selected' : ''}>📈 AGC: domyślne Discorda</option>
                    <option value="on" ${this.form.micDeskAgc === 'on' ? 'selected' : ''}>📈 AGC: włączone</option>
                    <option value="off" ${this.form.micDeskAgc === 'off' ? 'selected' : ''}>📈 AGC: wyłączone</option>
                  </select>
                  <select class="select select-sm" id="sel-echo-desk" style="margin-top:6px">
                    <option value="default" ${(this.form.micDeskEcho || 'default') === 'default' ? 'selected' : ''}>↩️ Usuwanie echa: domyślne Discorda</option>
                    <option value="on" ${this.form.micDeskEcho === 'on' ? 'selected' : ''}>↩️ Usuwanie echa: włączone</option>
                    <option value="off" ${this.form.micDeskEcho === 'off' ? 'selected' : ''}>↩️ Usuwanie echa: wyłączone</option>
                  </select>
                </div>

                <div class="field" style="margin-top: 10px">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px">
                    <label style="margin: 0; font-weight: 600">🎧 Mikrofon mobilny (słuchawki)</label>
                    ${this.form.micHeadsetName ? `<button class="text-btn" id="btn-test-headset">▶ Przetestuj</button>` : ''}
                  </div>
                  <select class="select" id="sel-mic-headset">
                    <option value="" ${!this.form.micHeadsetName ? 'selected' : ''}>— Wybierz mikrofon z listy —</option>
                    ${this.missingDeviceOption(this.form.micHeadsetName, this.audioDevices)}
                    ${this.audioDevices
                      .map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === this.form!.micHeadsetName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`)
                      .join('')}
                  </select>
                  ${
                    typeof this.form.micHeadsetVolume === 'number' && this.form.micHeadsetVolume >= 0
                      ? `<div style="display:flex; align-items:center; gap:8px; margin-top:6px">
                          <span style="font-size:10.5px; color:var(--muted)">🔊</span>
                          <input type="range" class="slider" id="rng-vol-headset" min="0" max="100" step="5" value="${this.form.micHeadsetVolume}" style="flex:1" />
                          <span class="slider-val" id="vol-headset-val">${this.form.micHeadsetVolume}%</span>
                        </div>`
                      : ''
                  }
                  <div style="display:flex; align-items:center; gap:8px; margin-top:6px">
                    <span style="font-size:10.5px; color:var(--muted)" title="Bramka VAD w Discordzie dla tego mikrofonu">🚪</span>
                    <input type="range" class="slider" id="rng-gate-headset" min="-90" max="0" step="5" value="${Math.max(-90, this.form.micHeadsetGateDb ?? -60)}" style="flex:1" />
                    <span class="slider-val" id="gate-headset-val">${(this.form.micHeadsetGateDb ?? -1) >= 0 ? this.form.micHeadsetGateDb + ' dB' : 'domyślna'}</span>
                  </div>
                  ${(this.form.micHeadsetGateDb ?? -1) < 0 ? `<small style="display:block; color:var(--muted); font-size:10px; margin-top:2px">Rusz suwak aby ustawić własną bramkę (do tej pory Discord używa swojej)</small>` : ''}
                  <select class="select select-sm" id="sel-krisp-headset" style="margin-top:6px">
                    <option value="default" ${(this.form.micHeadsetKrisp || 'default') === 'default' ? 'selected' : ''}>🔇 Wyciszenie szumów (Krisp): domyślne Discorda</option>
                    <option value="on" ${this.form.micHeadsetKrisp === 'on' ? 'selected' : ''}>🔇 Wyciszenie szumów (Krisp): włączone</option>
                    <option value="off" ${this.form.micHeadsetKrisp === 'off' ? 'selected' : ''}>🔇 Wyciszenie szumów (Krisp): wyłączone</option>
                  </select>
                  <select class="select select-sm" id="sel-agc-headset" style="margin-top:6px">
                    <option value="default" ${(this.form.micHeadsetAgc || 'default') === 'default' ? 'selected' : ''}>📈 AGC: domyślne Discorda</option>
                    <option value="on" ${this.form.micHeadsetAgc === 'on' ? 'selected' : ''}>📈 AGC: włączone</option>
                    <option value="off" ${this.form.micHeadsetAgc === 'off' ? 'selected' : ''}>📈 AGC: wyłączone</option>
                  </select>
                  <select class="select select-sm" id="sel-echo-headset" style="margin-top:6px">
                    <option value="default" ${(this.form.micHeadsetEcho || 'default') === 'default' ? 'selected' : ''}>↩️ Usuwanie echa: domyślne Discorda</option>
                    <option value="on" ${this.form.micHeadsetEcho === 'on' ? 'selected' : ''}>↩️ Usuwanie echa: włączone</option>
                    <option value="off" ${this.form.micHeadsetEcho === 'off' ? 'selected' : ''}>↩️ Usuwanie echa: wyłączone</option>
                  </select>
                </div>

                <div style="margin-top: 10px">
                  <button class="btn btn-ghost btn-sm" id="btn-detect-devices" style="width: 100%">
                    🔍 Wykryj i dopasuj mikrofony
                  </button>
                  ${this.deviceInfo ? `<p class="hint" style="white-space: pre-line; margin-top: 6px">${esc(this.deviceInfo)}</p>` : ''}
                </div>
              </section>

              <!-- SignalRGB Integration -->
              <section class="card">
                <h2>🌈 SignalRGB (Oświetlenie & Klawiatura)</h2>

                <div class="toggle-row">
                  <div class="label">
                    Włącz integrację SignalRGB
                    <small>zmienia kolor klawiatury lub gasi LED-y po odejściu</small>
                  </div>
                  <button class="switch" id="sw-signalrgb" role="switch" aria-checked="${this.form.signalrgbEnabled ?? false}"></button>
                </div>

                ${
                  this.form.signalrgbEnabled
                    ? `<div style="margin-top: 10px; padding-left: 10px; border-left: 2px solid var(--accent)">
                        <div class="field">
                          <label>Akcja po odejściu (Tryb mobilny):</label>
                          <select class="select" id="sel-signalrgb-action">
                            <option value="solid_color" ${(this.form.signalrgbAwayAction || 'solid_color') === 'solid_color' ? 'selected' : ''}>Kolor na klawiaturze (sygnalizacja)</option>
                            <option value="turn_off" ${this.form.signalrgbAwayAction === 'turn_off' ? 'selected' : ''}>Zgaś całkowicie oświetlenie</option>
                            <option value="dim" ${this.form.signalrgbAwayAction === 'dim' ? 'selected' : ''}>Przyciemnij LED-y</option>
                          </select>
                        </div>

                        ${
                          (this.form.signalrgbAwayAction || 'solid_color') === 'solid_color'
                            ? `<div class="field" style="margin-top: 8px">
                                <label>Kolor sygnalizacji:</label>
                                <div style="display: flex; gap: 8px; align-items: center">
                                  <input type="color" id="inp-signalrgb-color-picker" value="${this.form.signalrgbAwayColor || '#f59e0b'}" style="width: 38px; height: 32px; border: none; background: transparent; cursor: pointer; border-radius: 6px" />
                                  <input class="input" id="inp-signalrgb-color-text" value="${this.form.signalrgbAwayColor || '#f59e0b'}" placeholder="#f59e0b" style="flex: 1" />
                                </div>
                              </div>`
                            : ''
                        }

                        <div class="toggle-row" style="margin-top: 8px">
                          <div class="label">
                            Przywracaj oświetlenie po powrocie
                            <small>przywraca poprzedni profil RGB</small>
                          </div>
                          <button class="switch" id="sw-signalrgb-restore" role="switch" aria-checked="${this.form.signalrgbRestoreOnDesk ?? true}"></button>
                        </div>

                        <div style="display: flex; gap: 8px; margin-top: 10px">
                          <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-away" style="flex: 1">Test: Mobilny</button>
                          <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-desk" style="flex: 1">Test: Biurko</button>
                        </div>
                      </div>`
                    : ''
                }
              </section>

              <!-- Automations & Timing -->
              <section class="card">
                <h2>⚡ Automatyzacja & Zachowania</h2>

                <div class="toggle-row">
                  <div class="label">
                    🎮 Integracja z Discord
                    <small>płynna synchronizacja silnika głosu bez zacięć</small>
                  </div>
                  <button class="switch" id="sw-discord" role="switch" aria-checked="${this.form.discordIntegration ?? true}"></button>
                </div>

                <div class="field" style="margin-top: 10px">
                  <label>Wyciszanie mikrofonów przy przełączeniu:</label>
                  <select class="select" id="sel-mute-behavior">
                    <option value="mute_inactive" ${(this.form.muteBehaviorOnAway || 'mute_inactive') === 'mute_inactive' ? 'selected' : ''}>Wyciszaj nieaktywny (zalecane)</option>
                    <option value="none" ${this.form.muteBehaviorOnAway === 'none' ? 'selected' : ''}>Nie steruj wyciszeniem</option>
                    <option value="mute_stationary" ${this.form.muteBehaviorOnAway === 'mute_stationary' ? 'selected' : ''}>Wyciszaj tylko stacjonarny przy odejściu</option>
                    <option value="mute_all" ${this.form.muteBehaviorOnAway === 'mute_all' ? 'selected' : ''}>Wyciszaj oba przy odejściu</option>
                  </select>
                  <small style="display:block; color: var(--muted); font-size: 10.5px; margin-top: 4px">Ręczne wyciszenie (np. w Discordzie) nigdy nie jest automatycznie odciągane.</small>
                </div>

                <div class="toggle-row" style="margin-top: 8px">
                  <div class="label">
                    Usypiaj ekrany po odejściu
                    <small>gasi monitory po zadanym czasie</small>
                  </div>
                  <button class="switch" id="sw-sleep-monitors" role="switch" aria-checked="${this.form.sleepMonitorsOnAway ?? false}"></button>
                </div>

                <div class="toggle-row" style="margin-top: 8px">
                  <div class="label">
                    Dźwięki powiadomień Chime
                    <small>dwuton przy siadaniu / odejściu</small>
                  </div>
                  <button class="switch" id="sw-audio-chime" role="switch" aria-checked="${this.form.audioChime ?? true}"></button>
                </div>

                <div class="toggle-row" style="margin-top: 8px">
                  <div class="label">
                    Uruchamiaj przy starcie Windows
                    <small>start w zasobniku systemowym</small>
                  </div>
                  <button class="switch" id="sw-autostart" role="switch" aria-checked="${this.form.autoStart}"></button>
                </div>
              </section>
            </div>
          </div>

          <!-- BOTTOM FULL-WIDTH CARD: APP UPDATES & CONFIG -->
          <section class="card" style="margin-top: 4px">
            <div style="display: flex; align-items: center; justify-content: space-between">
              <div>
                <strong style="font-size: 13px">Wersja aplikacji: v${esc(this.snap.version || this.updater.currentVersion)}</strong>
                <small style="display: block; color: var(--muted-2); margin-top: 2px">Automatyczne sprawdzanie wydań GitHub</small>
              </div>
              <div style="display: flex; gap: 8px">
                <button class="btn btn-ghost btn-sm" id="btn-open-config-folder">
                  📁 Folder konfiguracji
                </button>
                <button class="btn btn-primary btn-sm" id="btn-check-updates" ${this.updater.status === 'checking' || this.updater.status === 'downloading' ? 'disabled' : ''}>
                  ${this.updater.status === 'checking' ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
                </button>
              </div>
            </div>
          </section>
        </div>

        <!-- footer -->
        <div class="footer">
          <button class="btn btn-ghost" id="btn-reset">Domyślne</button>
          <button class="btn btn-primary" id="btn-save" ${this.saving || !this.dirty ? 'disabled' : ''}>
            ${this.saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
          <span class="save-state ${this.saveState.kind}">${this.saveState.text}</span>
          <div style="flex: 1"></div>
          <button class="btn btn-ghost btn-sm" id="btn-open-logs" style="margin-left: auto">📜 Logi debug</button>
        </div>

        <!-- MODALS -->
        ${this.wizardOpen ? this.renderWizardModal() : ''}
        ${this.bioModalOpen ? this.renderBioModal() : ''}
        ${this.flasherModalOpen ? this.renderFlasherModal() : ''}
        ${this.logsModalOpen ? this.renderLogsModal() : ''}

        <!-- toasts container -->
        <div class="toasts"></div>
      </div>
    `;

    // Restore scroll position immediately and after layout reflow
    const newScrollEl = this.root.querySelector('.scroll') as HTMLElement | null;
    if (newScrollEl && scrollPos > 0) {
      newScrollEl.scrollTop = scrollPos;
      requestAnimationFrame(() => {
        if (newScrollEl) newScrollEl.scrollTop = scrollPos;
      });
    }

    this.bindEvents();
    this.renderToasts();
  }

  // ---------- MODAL 1: Wizard Kalibracji ----------
  private renderWizardModal(): string {
    const step = this.wizardStep;
    const count = this.wizardCountdown;

    return `
      <div class="modal-overlay" id="wizard-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>✨ Kreator Kalibracji Sensora (Krok ${step} z 4)</h3>
            <button class="close" id="btn-wizard-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="wizard-steps">
              <div class="wizard-step-dot ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 3 ? (step === 3 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step === 4 ? 'done' : ''}"></div>
            </div>

            ${
              step === 1
                ? `<div>
                    <div class="wizard-icon-hero">🪑</div>
                    <h4 style="text-align: center; font-size: 15px; font-weight: 600; margin-bottom: 6px">Krok 1: Kalibracja pustego biurka</h4>
                    <p class="wizard-instruction">
                      Odejdź od biurka na 2–3 metry lub wyjdź z zasięgu radaru.<br/>
                      Upewnij się, że fotel jest pusty, aby radar zapamiętał szum tła otoczenia.
                    </p>
                    <div style="margin-top: 18px" class="wizard-progress-box">
                      ${
                        count > 0
                          ? `<div>
                              <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                                <strong>Skanowanie otoczenia…</strong>
                                <span>${count} s</span>
                              </div>
                              <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((5 - count) / 5) * 100}%"></div></div>
                            </div>`
                          : `<button class="btn btn-primary" id="btn-run-step-1" style="width: 100%">Rozpocznij skanowanie tła (5s)</button>`
                      }
                    </div>
                  </div>`
                : ''
            }

            ${
              step === 2
                ? `<div>
                    <div class="wizard-icon-hero">🧘</div>
                    <h4 style="text-align: center; font-size: 15px; font-weight: 600; margin-bottom: 6px">Krok 2: Pozycja w fotelu (Bramka zasięgu)</h4>
                    <p class="wizard-instruction">
                      Usiądź wygodnie w fotelu w swojej naturalnej pozycji do pracy lub grania.<br/>
                      Radar ustali Twoją strefę fotela i odetnie wszystko za Twoim oparciem.
                    </p>
                    <div style="margin-top: 18px" class="wizard-progress-box">
                      ${
                        count > 0
                          ? `<div>
                              <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                                <strong>Mierzenie dystansu klatki piersiowej…</strong>
                                <span>${count} s (${this.telemetry.distanceCm ? this.telemetry.distanceCm + ' cm' : 'namierzanie…'})</span>
                              </div>
                              <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((6 - count) / 6) * 100}%"></div></div>
                            </div>`
                          : `<button class="btn btn-primary" id="btn-run-step-2" style="width: 100%">Rozpocznij pomiar pozycji fotela (6s)</button>`
                      }
                    </div>
                  </div>`
                : ''
            }

            ${
              step === 3
                ? `<div>
                    <div class="wizard-icon-hero">🫀</div>
                    <h4 style="text-align: center; font-size: 15px; font-weight: 600; margin-bottom: 6px">Krok 3: Profil biometryczny (Tętno & Oddech)</h4>
                    <p class="wizard-instruction">
                      Siedź spokojnie i oddychaj naturalnie.<br/>
                      Radar sczytuje mikrofalami Twoje tętno spoczynkowe i rytm oddechowy.
                    </p>
                    <div style="margin-top: 18px" class="wizard-progress-box">
                      ${
                        count > 0
                          ? `<div>
                              <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                                <strong>Pobieranie wzorca biometrycznego…</strong>
                                <span>${count} s (${this.telemetry.heartRate ? this.telemetry.heartRate + ' BPM' : 'odczyt…'})</span>
                              </div>
                              <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((8 - count) / 8) * 100}%"></div></div>
                            </div>`
                          : `<button class="btn btn-primary" id="btn-run-step-3" style="width: 100%">Rozpocznij pomiar biometrii (8s)</button>`
                      }
                    </div>
                  </div>`
                : ''
            }

            ${
              step === 4
                ? `<div>
                    <div class="wizard-icon-hero">🎉</div>
                    <h4 style="text-align: center; font-size: 15px; font-weight: 600; margin-bottom: 6px">Kalibracja zakończona sukcesem!</h4>
                    <div class="telemetry-grid" style="margin-bottom: 12px">
                      <div class="telemetry-card">
                        <div class="t-label">📏 Strefa fotela</div>
                        <div class="t-val live">${this.wizardResults.distance} cm</div>
                        <small style="font-size: 10px; color: var(--muted)">Bramka: ${this.wizardResults.gateMin}–${this.wizardResults.gateMax} cm</small>
                      </div>
                      <div class="telemetry-card">
                        <div class="t-label">🫀 Tętno spoczynkowe</div>
                        <div class="t-val">${this.wizardResults.heartRateAvg} BPM</div>
                        <small style="font-size: 10px; color: var(--muted)">Zakres: ${this.wizardResults.heartRateMin}–${this.wizardResults.heartRateMax} BPM</small>
                      </div>
                    </div>
                  </div>`
                : ''
            }
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-wizard-cancel">Anuluj</button>
            ${
              step === 4
                ? `<button class="btn btn-primary btn-sm" id="btn-wizard-apply">Zastosuj i zapisz kalibrację ✓</button>`
                : `<span style="font-size: 11px; color: var(--muted)">Krok ${step} z 4</span>`
            }
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 2: Profil Biometryczny & Narzeczona ----------
  private renderBioModal(): string {
    return `
      <div class="modal-overlay" id="bio-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>🧬 Profil Biometryczny & Rozróżnianie Osób</h3>
            <button class="close" id="btn-bio-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="toggle-row">
              <div class="label">
                Włącz rozróżnianie osób (Ty vs Narzeczona / Goście)
                <small>sprawdza tętno i odległość siedzenia, by nie przełączać mikrofonu gdy usiądzie ktoś inny</small>
              </div>
              <button class="switch" id="sw-biometrics-modal" role="switch" aria-checked="${this.form?.biometricsEnabled ?? false}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                🐾 Filtr zwierząt domowych (Kot / Pies)
                <small>automatycznie ignoruje kota/psa na bazie oddechu (>22 RPM) i tętna (>125 BPM)</small>
              </div>
              <button class="switch" id="sw-pet-filter-modal" role="switch" aria-checked="${this.form?.petFilterEnabled ?? true}"></button>
            </div>

            <div style="margin-top: 12px; padding: 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius-sm)">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
                <strong style="font-size: 12px; color: var(--accent)">Twój profil biometryczny (Wzorzec):</strong>
                <button class="btn btn-sm btn-ghost" id="btn-quick-calibrate-bio">🎯 Skalibruj z aktualnych odczytów</button>
              </div>

              <div class="row">
                <div class="field">
                  <label>Twoje tętno spoczynkowe (min - max BPM)</label>
                  <div style="display: flex; gap: 8px">
                    <input class="input" type="number" id="inp-hr-min" value="${this.form?.userHeartRateMin ?? 55}" style="flex: 1" />
                    <input class="input" type="number" id="inp-hr-max" value="${this.form?.userHeartRateMax ?? 78}" style="flex: 1" />
                  </div>
                </div>
                <div class="field">
                  <label>Twoja odległość siedzenia (min - max cm)</label>
                  <div style="display: flex; gap: 8px">
                    <input class="input" type="number" id="inp-dist-min" value="${this.form?.userSeatingDistanceMin ?? 50}" style="flex: 1" />
                    <input class="input" type="number" id="inp-dist-max" value="${this.form?.userSeatingDistanceMax ?? 95}" style="flex: 1" />
                  </div>
                </div>
              </div>

              <div class="field" style="margin-top: 10px">
                <label>Gdy przy biurku usiądzie inna osoba (np. narzeczona):</label>
                <select class="select" id="sel-person-action">
                  <option value="ignore" ${(this.form?.personMismatchAction || 'ignore') === 'ignore' ? 'selected' : ''}>Pozostań w trybie mobilnym (nie przełączaj Twojego mikrofonu)</option>
                  <option value="notify_only" ${this.form?.personMismatchAction === 'notify_only' ? 'selected' : ''}>Przełącz i wyświetl powiadomienie (Rozpoznano inną osobę)</option>
                  <option value="switch_anyway" ${this.form?.personMismatchAction === 'switch_anyway' ? 'selected' : ''}>Przełącz normalnie na stacjonarny</option>
                </select>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-bio-cancel">Zamknij</button>
            <button class="btn btn-primary btn-sm" id="btn-bio-save">Zatwierdź profil ✓</button>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 3: Firmware Sensora & Tryb Ratunkowy ----------
  private renderFlasherModal(): string {
    return `
      <div class="modal-overlay" id="flasher-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>⚡ Firmware Sensora XIAO ESP32-C6 (USB Flasher)</h3>
            <button class="close" id="btn-flasher-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <p style="font-size: 12.5px; color: var(--text)">
              Aktualizacja odbywa się <strong>w 100% po kablu USB (Serial COM)</strong>.<br/>
              Urządzenie nie wymaga i nie korzysta z sieci Wi-Fi.
            </p>

            ${
              this.sensorFlashing
                ? `<div style="margin-top: 10px; padding: 14px; background: var(--panel-2); border: 1px solid var(--accent); border-radius: var(--radius-sm)">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px">
                      <strong id="flash-msg-text">${this.sensorFlashProgress.message || 'Wgrywanie firmware…'}</strong>
                      <span id="flash-pct-text">${this.sensorFlashProgress.percent}%</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" id="flash-meter-fill" style="width: ${this.sensorFlashProgress.percent}%"></div></div>
                  </div>`
                : `<div style="display: flex; flex-direction: column; gap: 10px; margin-top: 10px">
                    <button class="btn btn-primary" id="btn-modal-flash-gh" style="width: 100%">
                      ☁️ Pobierz i wgraj najnowszy firmware z GitHuba
                    </button>
                    <button class="btn btn-ghost" id="btn-modal-flash-file" style="width: 100%">
                      📁 Wybierz i wgraj skompilowany plik .bin
                    </button>
                  </div>`
            }

            <div class="unbrick-box">
              <strong style="color: #ef4444; font-size: 12px">🚨 Tryb Ratunkowy / Przywracanie Fabryczne (Unbrick)</strong>
              <p style="font-size: 11.5px; color: var(--muted); margin-top: 4px">
                Jeśli sensor nie reaguje lub uległ zawieszeniu, sprzętowy bootloader ROM w ESP32-C6 umożliwia pełne wyczyszczenie pamięci i wgranie czystego oprogramowania.
              </p>
              <button class="btn btn-sm btn-ghost" id="btn-emergency-unbrick" style="margin-top: 8px; border-color: rgba(239, 68, 68, 0.4); color: #ef4444" ${this.sensorFlashing ? 'disabled' : ''}>
                Wymuś czyszczenie i wgranie firmware fabrycznego
              </button>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-flasher-cancel">Zamknij</button>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 4: Debug Logs Modal ----------
  private renderLogsModal(): string {
    return `
      <div class="modal-overlay" id="logs-overlay">
        <div class="modal-dialog modal-lg" style="max-width: 700px">
          <div class="modal-header">
            <h3>📜 Logi Diagnostyczne & Debug</h3>
            <button class="close" id="btn-logs-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body" style="padding: 16px">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
              <span style="font-size: 11.5px; color: var(--muted)">Rejestr zdarzeń i telemetrii (${this.logs.length} wpisów):</span>
              <div style="display: flex; gap: 8px">
                <button class="btn btn-sm btn-ghost" id="btn-copy-logs">📋 Kopiuj logi</button>
                <button class="btn btn-sm btn-ghost" id="btn-clear-logs">🗑️ Wyczyść</button>
              </div>
            </div>

            <div id="log-console" style="background: #080a0f; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; height: 320px; overflow-y: auto; font-family: var(--font-mono); font-size: 11px; line-height: 1.45; color: #67e8f9; white-space: pre-wrap; word-break: break-all">${this.logs.length > 0 ? esc(this.logs.join('\n')) : 'Brak logów.'}</div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-logs-cancel">Zamknij</button>
          </div>
        </div>
      </div>
    `;
  }

  /** Gdy zapisany mikrofon jest chwilowo odłączony — pokaż go jako (odłączony), nie gub wyboru. */
  private missingDeviceOption(savedName: string, devices: AudioDeviceItem[]): string {
    if (!savedName || devices.some((d) => d.name === savedName)) return '';
    return `<option value="${esc(savedName)}" selected>${esc(savedName)} (odłączony)</option>`;
  }

  private bindEvents() {
    const byId = (id: string) => document.getElementById(id);

    byId('btn-close')?.addEventListener('click', () => window.api.closeWindow());

    byId('btn-toggle-mute')?.addEventListener('click', async () => {
      const res = await window.api.toggleMute();
      if (res && typeof res.isMuted === 'boolean') {
        this.isMuted = res.isMuted;
        this.pushToast(res.isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️');
        this.render();
      }
    });

    // Mode buttons
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const mode = (e.currentTarget as HTMLElement).getAttribute('data-mode') as Snapshot['mode'];
        if (mode) {
          const s = await window.api.setMode(mode);
          this.snap = s;
          this.render();
        }
      });
    });

    // Modal Triggers
    byId('btn-open-wizard')?.addEventListener('click', () => this.openCalibrationWizard());
    byId('btn-open-bio-modal')?.addEventListener('click', () => {
      this.bioModalOpen = true;
      this.render();
    });
    byId('btn-open-flasher-modal')?.addEventListener('click', () => {
      this.flasherModalOpen = true;
      this.render();
    });

    // Wizard Events
    byId('btn-wizard-close')?.addEventListener('click', () => this.closeCalibrationWizard());
    byId('btn-wizard-cancel')?.addEventListener('click', () => this.closeCalibrationWizard());
    byId('btn-run-step-1')?.addEventListener('click', () => this.runWizardStep1());
    byId('btn-run-step-2')?.addEventListener('click', () => this.runWizardStep2());
    byId('btn-run-step-3')?.addEventListener('click', () => this.runWizardStep3());
    byId('btn-wizard-apply')?.addEventListener('click', () => this.applyWizardCalibration());

    // Bio Modal Events
    byId('btn-bio-close')?.addEventListener('click', () => { this.bioModalOpen = false; this.render(); });
    byId('btn-bio-cancel')?.addEventListener('click', () => { this.bioModalOpen = false; this.render(); });
    byId('sw-biometrics-modal')?.addEventListener('click', () => {
      const val = !(this.form?.biometricsEnabled ?? false);
      // reRender=false: pełny rebuild przy każdym kliknięciu miga i gubi stan
      this.patchForm({ biometricsEnabled: val }, false);
      const sw = document.getElementById('sw-biometrics-modal');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });
    byId('sw-pet-filter-modal')?.addEventListener('click', () => {
      const val = !(this.form?.petFilterEnabled ?? true);
      this.patchForm({ petFilterEnabled: val }, false);
      const sw = document.getElementById('sw-pet-filter-modal');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });
    byId('btn-quick-calibrate-bio')?.addEventListener('click', () => {
      const curDist = this.telemetry.distanceCm || 75;
      const curHr = this.telemetry.heartRate || 68;
      this.patchForm({
        userSeatingDistanceMin: Math.max(30, curDist - 15),
        userSeatingDistanceMax: curDist + 20,
        userHeartRateMin: Math.max(45, curHr - 12),
        userHeartRateMax: curHr + 14
      });
      this.pushToast(`Skalibrowano profil: Dystans ${curDist}cm, Tętno ${curHr} BPM`);
    });
    // Pola tekstowe: reRender=false — inaczej pełny rebuild DOM po każdym
    // znaku ucina fokus w połowie wpisywania wartości. Zakresy sanityzowane.
    const bindNumberInput = (id: string, key: 'userHeartRateMin' | 'userHeartRateMax' | 'userSeatingDistanceMin' | 'userSeatingDistanceMax', min: number, max: number): void => {
      byId(id)?.addEventListener('input', (e) => {
        const raw = Number((e.target as HTMLInputElement).value);
        if (!Number.isFinite(raw) || raw === 0) return; // puste pole w trakcie edycji
        this.patchForm({ [key]: Math.max(min, Math.min(max, raw)) } as Partial<Snapshot['config']>, false);
      });
    };
    bindNumberInput('inp-hr-min', 'userHeartRateMin', 30, 150);
    bindNumberInput('inp-hr-max', 'userHeartRateMax', 40, 200);
    bindNumberInput('inp-dist-min', 'userSeatingDistanceMin', 10, 300);
    bindNumberInput('inp-dist-max', 'userSeatingDistanceMax', 10, 400);
    byId('sel-person-action')?.addEventListener('change', (e) => {
      this.patchForm({ personMismatchAction: (e.target as HTMLSelectElement).value as any }, false);
    });
    byId('btn-bio-save')?.addEventListener('click', () => {
      this.bioModalOpen = false;
      this.save();
    });

    // Flasher Modal Events
    byId('btn-flasher-close')?.addEventListener('click', () => { this.flasherModalOpen = false; this.render(); });
    byId('btn-flasher-cancel')?.addEventListener('click', () => { this.flasherModalOpen = false; this.render(); });
    byId('btn-modal-flash-gh')?.addEventListener('click', async () => {
      this.pushToast('Sprawdzanie i pobieranie firmware z GitHuba…');
      try {
        await window.api.flashSensorFromGitHub();
      } catch (err: any) {
        this.pushToast(`Błąd: ${err.message}`, true);
      }
    });
    byId('btn-modal-flash-file')?.addEventListener('click', async () => {
      try {
        await window.api.flashSensorFromFile();
      } catch (err: any) {
        this.pushToast(`Błąd: ${err.message}`, true);
      }
    });
    byId('btn-emergency-unbrick')?.addEventListener('click', async () => {
      this.pushToast('Uruchamianie procedury ratunkowej sensora (pełne czyszczenie flash)…');
      try {
        await window.api.flashSensorFromGitHub({ eraseAll: true });
      } catch (err: any) {
        this.pushToast(`Błąd: ${err.message}`, true);
      }
    });

    // Auto-Tuning controls
    byId('sw-auto-tuning')?.addEventListener('click', () => {
      this.patchForm({ radarAutoTuningEnabled: !(this.form?.radarAutoTuningEnabled ?? true) });
    });
    byId('sel-auto-tuning-speed')?.addEventListener('change', (e) => {
      this.patchForm({ radarAutoTuningSpeed: (e.target as HTMLSelectElement).value as any }, false);
    });
    byId('btn-reset-autotuning')?.addEventListener('click', async () => {
      const status = await window.api.resetAutoTuning();
      if (status) {
        this.telemetry.autoTuning = status;
        this.updateTelemetryDOM();
      }
      this.pushToast('Zresetowano model Auto-Tuningu');
    });

    // Port & Sensitivity
    byId('sel-port')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      this.patchForm({ port: val }, false);
    });
    byId('btn-refresh-ports')?.addEventListener('click', async () => {
      this.refreshingPorts = true;
      this.render();
      this.ports = await window.api.getPorts();
      this.refreshingPorts = false;
      this.render();
      this.pushToast('Odświeżono listę portów COM');
    });
    byId('rng-radar-sens')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ radarSensitivity: val }, false);
      const valEl = document.querySelector('#rng-radar-sens ~ .slider-val') || document.querySelector('.slider-val');
      if (valEl) valEl.textContent = `${val}%`;
    });

    // Audio Devices
    byId('sel-mic-desk')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      const opt = sel.selectedOptions[0];
      this.patchForm({ micDeskName: sel.value, micDeskId: opt?.getAttribute('data-id') || '' }, false);
    });
    byId('rng-vol-desk')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ micDeskVolume: val }, false);
      const valEl = document.getElementById('vol-desk-val');
      if (valEl) valEl.textContent = `${val}%`;
    });
    byId('rng-vol-desk')?.addEventListener('change', (e) => {
      // Ustawiamy dopiero po puszczeniu suwaka — 'input' przy każdym pikselu
      // zalałby daemon komendami.
      const val = Number((e.target as HTMLInputElement).value);
      const name = this.form?.micDeskName;
      if (name) void window.api.setVolume(name, val);
    });
    byId('rng-gate-desk')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ micDeskGateDb: val }, false);
      const valEl = document.getElementById('gate-desk-val');
      if (valEl) valEl.textContent = `${val} dB`;
    });
    byId('rng-gate-desk')?.addEventListener('change', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      // Live-apply tylko gdy stacjonarny jest teraz aktywny
      if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
    });
    byId('sel-krisp-desk')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'default' | 'on' | 'off';
      this.patchForm({ micDeskKrisp: mode }, false);
      if (mode !== 'default' && (this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    });
    byId('sel-agc-desk')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'default' | 'on' | 'off';
      this.patchForm({ micDeskAgc: mode }, false);
      if (mode !== 'default' && (this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    });
    byId('sel-echo-desk')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'default' | 'on' | 'off';
      this.patchForm({ micDeskEcho: mode }, false);
      if (mode !== 'default' && (this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ echo: mode === 'on' });
      }
    });
    byId('btn-test-desk')?.addEventListener('click', async () => {
      if (!this.form?.micDeskName) return;
      this.pushToast(`Przełączam na: ${this.form.micDeskName}…`);
      this.snap = await window.api.testDevice(this.form.micDeskName);
      await this.loadAudioDevices();
      this.render();
    });

    byId('sel-mic-headset')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      const opt = sel.selectedOptions[0];
      this.patchForm({ micHeadsetName: sel.value, micHeadsetId: opt?.getAttribute('data-id') || '' }, false);
    });
    byId('rng-vol-headset')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ micHeadsetVolume: val }, false);
      const valEl = document.getElementById('vol-headset-val');
      if (valEl) valEl.textContent = `${val}%`;
    });
    byId('rng-vol-headset')?.addEventListener('change', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      const name = this.form?.micHeadsetName;
      if (name) void window.api.setVolume(name, val);
    });
    byId('rng-gate-headset')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ micHeadsetGateDb: val }, false);
      const valEl = document.getElementById('gate-headset-val');
      if (valEl) valEl.textContent = `${val} dB`;
    });
    byId('rng-gate-headset')?.addEventListener('change', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      if ((this.snap?.state ?? 'headset') === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
    });
    byId('sel-krisp-headset')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'default' | 'on' | 'off';
      this.patchForm({ micHeadsetKrisp: mode }, false);
      if (mode !== 'default' && (this.snap?.state ?? 'headset') === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    });
    byId('sel-agc-headset')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'default' | 'on' | 'off';
      this.patchForm({ micHeadsetAgc: mode }, false);
      if (mode !== 'default' && (this.snap?.state ?? 'headset') === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    });
    byId('sel-echo-headset')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'default' | 'on' | 'off';
      this.patchForm({ micHeadsetEcho: mode }, false);
      if (mode !== 'default' && (this.snap?.state ?? 'headset') === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ echo: mode === 'on' });
      }
    });
    byId('btn-test-headset')?.addEventListener('click', async () => {
      if (!this.form?.micHeadsetName) return;
      this.pushToast(`Przełączam na: ${this.form.micHeadsetName}…`);
      this.snap = await window.api.testDevice(this.form.micHeadsetName);
      await this.loadAudioDevices();
      this.render();
    });

    byId('btn-detect-devices')?.addEventListener('click', async () => {
      this.deviceInfo = 'Skanowanie mikrofonów…';
      this.render();
      const r = await window.api.detectDevices();
      await this.loadAudioDevices();
      if (r.devices.length === 0) {
        this.deviceInfo = 'Nie znaleziono mikrofonów w systemie Windows.';
      } else {
        if (r.recommended.micDeskName || r.recommended.micHeadsetName) {
          this.form = {
            ...this.form!,
            micDeskName: r.recommended.micDeskName || this.form?.micDeskName || '',
            micHeadsetName: r.recommended.micHeadsetName || this.form?.micHeadsetName || ''
          };
          this.dirty = true;
          this.pushToast('Zaproponowano mikrofony — kliknij "Zapisz zmiany"');
        }
        const list = r.devices.map((d) => d.name).slice(0, 3).join(' · ');
        this.deviceInfo = `Wykryto ${r.devices.length} mikrofonów:\n${list}`;
      }
      this.render();
    });

    // SignalRGB
    byId('sw-signalrgb')?.addEventListener('click', () => {
      this.patchForm({ signalrgbEnabled: !(this.form?.signalrgbEnabled ?? false) }, true);
    });
    byId('sel-signalrgb-action')?.addEventListener('change', (e) => {
      this.patchForm({ signalrgbAwayAction: (e.target as HTMLSelectElement).value as any }, true);
    });
    byId('inp-signalrgb-color-picker')?.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      this.patchForm({ signalrgbAwayColor: val }, false);
      const textInput = document.getElementById('inp-signalrgb-color-text') as HTMLInputElement | null;
      if (textInput) textInput.value = val;
    });
    byId('inp-signalrgb-color-text')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLInputElement).value;
      this.patchForm({ signalrgbAwayColor: val }, false);
      const picker = document.getElementById('inp-signalrgb-color-picker') as HTMLInputElement | null;
      if (picker) picker.value = val;
    });
    byId('sw-signalrgb-restore')?.addEventListener('click', () => {
      const val = !(this.form?.signalrgbRestoreOnDesk ?? true);
      this.patchForm({ signalrgbRestoreOnDesk: val }, false);
      const sw = document.getElementById('sw-signalrgb-restore');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });
    byId('btn-test-signalrgb-away')?.addEventListener('click', async () => {
      this.pushToast('Testuję oświetlenie SignalRGB: Odeście (Mobilny)…');
      await window.api.signalrgbTestAway();
    });
    byId('btn-test-signalrgb-desk')?.addEventListener('click', async () => {
      this.pushToast('Testuję oświetlenie SignalRGB: Powrót (Biurko)…');
      await window.api.signalrgbTestDesk();
    });

    // Automations
    byId('sw-discord')?.addEventListener('click', () => {
      const val = !(this.form?.discordIntegration ?? true);
      this.patchForm({ discordIntegration: val }, false);
      const sw = document.getElementById('sw-discord');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });
    byId('sel-mute-behavior')?.addEventListener('change', (e) => {
      this.patchForm({ muteBehaviorOnAway: (e.target as HTMLSelectElement).value as any });
    });
    byId('sw-sleep-monitors')?.addEventListener('click', () => {
      const val = !(this.form?.sleepMonitorsOnAway ?? false);
      this.patchForm({ sleepMonitorsOnAway: val }, false);
      const sw = document.getElementById('sw-sleep-monitors');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });
    byId('sw-audio-chime')?.addEventListener('click', () => {
      const val = !(this.form?.audioChime ?? true);
      this.patchForm({ audioChime: val }, false);
      const sw = document.getElementById('sw-audio-chime');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });
    byId('sw-autostart')?.addEventListener('click', () => {
      const val = !(this.form?.autoStart ?? false);
      this.patchForm({ autoStart: val }, false);
      const sw = document.getElementById('sw-autostart');
      if (sw) sw.setAttribute('aria-checked', String(val));
    });

    // Updates & Config
    byId('btn-check-updates')?.addEventListener('click', async () => {
      this.pushToast('Sprawdzam aktualizacje…');
      try {
        const res = await window.api.checkForUpdates();
        if (res.available && res.updateInfo) {
          this.pushToast(`Dostępna nowa wersja: v${res.updateInfo.version}`);
        } else {
          this.pushToast('Aplikacja jest aktualna ✓');
        }
      } catch (err: any) {
        this.pushToast(`Błąd sprawdzania: ${err.message}`, true);
      }
    });

    // Przyciski strefy aktualizacji podpina attachUpdateZoneEvents()
    // (strefa przebudowuje się niezależnie od reszty widoku)

    byId('btn-open-config-folder')?.addEventListener('click', () => window.api.openConfigDir());

    // Debug Logs Modal Events
    byId('btn-open-logs')?.addEventListener('click', async () => {
      try {
        const l = await window.api.getLogs();
        if (Array.isArray(l)) this.logs = l;
      } catch (_) {}
      this.logsModalOpen = true;
      this.render();
      requestAnimationFrame(() => {
        const c = document.getElementById('log-console');
        if (c) c.scrollTop = c.scrollHeight;
      });
    });
    byId('btn-logs-close')?.addEventListener('click', () => { this.logsModalOpen = false; this.render(); });
    byId('btn-logs-cancel')?.addEventListener('click', () => { this.logsModalOpen = false; this.render(); });
    byId('btn-copy-logs')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.logs.join('\n'));
      this.pushToast('Logi skopiowane do schowka ✓');
    });
    byId('btn-clear-logs')?.addEventListener('click', async () => {
      await window.api.clearLogs();
      this.logs = [];
      const c = document.getElementById('log-console');
      if (c) c.textContent = 'Brak logów.';
      this.pushToast('Wyczyszczono logi');
    });

    // Footer actions
    byId('btn-reset')?.addEventListener('click', async () => {
      if (confirm('Przywrócić wszystkie ustawienia do wartości domyślnych?')) {
        this.snap = await window.api.resetConfig();
        this.form = { ...this.snap.config };
        this.dirty = false;
        this.pushToast('Przywrócono ustawienia domyślne');
        this.render();
      }
    });

    byId('btn-save')?.addEventListener('click', () => this.save());
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root');
  if (root) {
    const app = new AppUI(root);
    app.init();
  }
});
