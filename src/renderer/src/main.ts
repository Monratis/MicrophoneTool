import './styles.css';
import type { AudioDeviceItem, PushEvent, RadarTelemetry, SerialPortInfo, Snapshot, UpdaterStatus } from './global';

const STATE_LABEL: Record<string, string> = { desk: 'Przy biurku (Stacjonarny)', headset: 'Poza biurkiem (Mobilny)' };

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// ---------- Web Audio Chime Synthesizer with Sound Profiles ----------
let sharedAudioCtx: AudioContext | null = null;
const CHIME_MAX_GAIN = 0.35;

type ChimeStyle = 'harmonic' | 'modern' | 'soft_click' | 'marimba';

function playChime(state: 'desk' | 'headset' | 'away', volume = 0.2, style: ChimeStyle = 'harmonic') {
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
    const safeVol = Math.min(CHIME_MAX_GAIN, Math.max(0.01, volume));

    if (style === 'modern') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(state === 'desk' ? 880 : 1318, now);
      osc.frequency.exponentialRampToValueAtTime(state === 'desk' ? 1760 : 659, now + 0.09);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(safeVol * 0.9, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (style === 'soft_click') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(state === 'desk' ? 440 : 330, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(safeVol * 0.8, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (style === 'marimba') {
      [state === 'desk' ? 523.25 : 659.25, state === 'desk' ? 659.25 : 523.25].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.04);
        gain.gain.setValueAtTime(0.0001, now + idx * 0.04);
        gain.gain.linearRampToValueAtTime(safeVol * 0.6, now + idx * 0.04 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.04 + 0.18);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.04);
        osc.stop(now + idx * 0.04 + 0.22);
      });
    } else {
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
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(safeVol, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch (_) {}
}

/**
 * Odtwarzanie własnego pliku audio z dysku (mp3/wav/ogg) zamiast syntezowanego
 * chime. Strona w packaged app ma origin file://, więc file:// media gra bez
 * webSecurity. Zwraca false, gdy plik nieustawiony lub odtwarzacz zawodzi —
 * wtedy wywołujący ma spaść na syntezowany chime.
 */
function playCustomAudioFile(filePath: string, state: 'desk' | 'headset' | 'away', volume = 0.2): boolean {
  if (!filePath) return false;
  try {
    const normalized = filePath.replace(/\\/g, '/').split('?')[0].split('#')[0];
    const audio = new Audio(encodeURI(`file:///${normalized.replace(/^\//, '')}`));
    audio.volume = Math.min(1, Math.max(0.01, volume));
    void audio.play().catch(() => playChime(state, volume));
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- Live Audio Meter Engine (Real-Time VU-Meter & VAD Gate Tracker) ----------
class LiveAudioEngine {
  private audioCtx: AudioContext | null = null;
  private deskStream: MediaStream | null = null;
  private headStream: MediaStream | null = null;
  private deskAnalyser: AnalyserNode | null = null;
  private headAnalyser: AnalyserNode | null = null;
  private deskData: Float32Array<ArrayBuffer> | null = null;
  private headData: Float32Array<ArrayBuffer> | null = null;
  private animFrameId: number | null = null;
  private peakDesk = -100;
  private peakHead = -100;
  private peakDeskTimer = 0;
  private peakHeadTimer = 0;
  private deskSmoothedRms = 0;
  private headSmoothedRms = 0;

  // Gate thresholds in dB
  public deskGateDb = -45;
  public headGateDb = -45;

  // Live sampled dB for calibration wizard
  public currentDeskDb = -100;
  public currentHeadDb = -100;

  public isRunning = false;
  private lastDeskName = '';
  private lastHeadName = '';
  // Voice Activity Hangover Timers (eliminates flickering/jumping)
  private deskVoiceHangover = 0;
  private headVoiceHangover = 0;

  async start(deskName: string, headName: string) {
    this.lastDeskName = deskName;
    this.lastHeadName = headName;
    this.stop();

    if (document.visibilityState !== 'visible') {
      return;
    }

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') {
        void this.audioCtx.resume();
      }

      // Wymuś zażądanie uprawnień mikrofonowych (aby enumerateDevices zwróciło pełne etykiety)
      let initialStream: MediaStream | null = null;
      try {
        initialStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('[VU] Uprawnienia audio:', err);
      }

      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');

      if (initialStream) {
        initialStream.getTracks().forEach((t) => t.stop());
      }

      const findDeviceId = (name: string): string | undefined => {
        if (!name) return undefined;
        const n = name.toLowerCase().replace(/\s*\(domyślny\)/i, '').trim();
        const found = audioInputs.find((d) => {
          if (!d.label) return false;
          const l = d.label.toLowerCase();
          return l.includes(n) || n.includes(l);
        });
        return found?.deviceId;
      };

      const deskId = findDeviceId(deskName);
      const headId = findDeviceId(headName);

      // Desk stream z filtrem górnoprzepustowym (120 Hz — odcina dudnienie biurka i wentylatory jak w Discordzie)
      if (deskName) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: deskId ? { exact: deskId } : undefined,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          });
          this.deskStream = stream;
          const src = this.audioCtx.createMediaStreamSource(stream);
          const hpf = this.audioCtx.createBiquadFilter();
          hpf.type = 'highpass';
          hpf.frequency.value = 120;
          hpf.Q.value = 0.707;

          const analyser = this.audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.25;

          src.connect(hpf);
          hpf.connect(analyser);
          this.deskAnalyser = analyser;
          this.deskData = new Float32Array(analyser.fftSize);
        } catch (_) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            });
            this.deskStream = stream;
            const src = this.audioCtx.createMediaStreamSource(stream);
            const hpf = this.audioCtx.createBiquadFilter();
            hpf.type = 'highpass';
            hpf.frequency.value = 120;
            hpf.Q.value = 0.707;

            const analyser = this.audioCtx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.25;

            src.connect(hpf);
            hpf.connect(analyser);
            this.deskAnalyser = analyser;
            this.deskData = new Float32Array(analyser.fftSize);
          } catch (_) {}
        }
      }

      // Headset stream
      if (headName && headName !== deskName && headId) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { exact: headId },
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          });
          this.headStream = stream;
          const src = this.audioCtx.createMediaStreamSource(stream);
          const hpf = this.audioCtx.createBiquadFilter();
          hpf.type = 'highpass';
          hpf.frequency.value = 120;
          hpf.Q.value = 0.707;

          const analyser = this.audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.25;

          src.connect(hpf);
          hpf.connect(analyser);
          this.headAnalyser = analyser;
          this.headData = new Float32Array(analyser.fftSize);
        } catch (_) {}
      }

      this.isRunning = true;
      this.tick();
    } catch (_) {}
  }

  public restartWithLastDevices() {
    if (this.lastDeskName || this.lastHeadName) {
      void this.start(this.lastDeskName, this.lastHeadName);
    }
  }

  private tick = () => {
    const now = Date.now();

    // Process Desk Mic (32-bit Float RMS z Envelope Followerem jak w WebRTC/Discord)
    if (this.deskAnalyser && this.deskData) {
      this.deskAnalyser.getFloatTimeDomainData(this.deskData);
      let sum = 0;
      for (let i = 0; i < this.deskData.length; i++) {
        const v = this.deskData[i];
        sum += v * v;
      }
      const rawRms = Math.sqrt(sum / this.deskData.length);

      // Envelope Follower: szybki atak na mowę (15ms), płynny spadek (250ms)
      if (rawRms > this.deskSmoothedRms) {
        this.deskSmoothedRms = this.deskSmoothedRms + 0.45 * (rawRms - this.deskSmoothedRms);
      } else {
        this.deskSmoothedRms = this.deskSmoothedRms + 0.09 * (rawRms - this.deskSmoothedRms);
      }

      const db = this.deskSmoothedRms > 0.000005 ? Math.round(20 * Math.log10(this.deskSmoothedRms) * 10) / 10 : -100;
      const clampedDb = Math.max(-100, Math.min(0, db));
      this.currentDeskDb = clampedDb;
      const pct = clampedDb <= -95 ? 0 : Math.max(0, Math.min(100, ((clampedDb + 100) / 100) * 100));

      if (clampedDb > this.peakDesk || now > this.peakDeskTimer) {
        this.peakDesk = clampedDb;
        this.peakDeskTimer = now + 650;
      } else {
        this.peakDesk = Math.max(clampedDb, this.peakDesk - 0.7);
      }
      const peakPct = this.peakDesk <= -95 ? 0 : Math.max(0, Math.min(100, ((this.peakDesk + 100) / 100) * 100));

      this.updateDOM('desk', clampedDb, pct, peakPct, this.deskGateDb);
    }

    // Process Headset Mic
    if (this.headAnalyser && this.headData) {
      this.headAnalyser.getFloatTimeDomainData(this.headData);
      let sum = 0;
      for (let i = 0; i < this.headData.length; i++) {
        const v = this.headData[i];
        sum += v * v;
      }
      const rawRms = Math.sqrt(sum / this.headData.length);

      if (rawRms > this.headSmoothedRms) {
        this.headSmoothedRms = this.headSmoothedRms + 0.45 * (rawRms - this.headSmoothedRms);
      } else {
        this.headSmoothedRms = this.headSmoothedRms + 0.09 * (rawRms - this.headSmoothedRms);
      }

      const db = this.headSmoothedRms > 0.000005 ? Math.round(20 * Math.log10(this.headSmoothedRms) * 10) / 10 : -100;
      const clampedDb = Math.max(-100, Math.min(0, db));
      this.currentHeadDb = clampedDb;
      const pct = clampedDb <= -95 ? 0 : Math.max(0, Math.min(100, ((clampedDb + 100) / 100) * 100));

      if (clampedDb > this.peakHead || now > this.peakHeadTimer) {
        this.peakHead = clampedDb;
        this.peakHeadTimer = now + 650;
      } else {
        this.peakHead = Math.max(clampedDb, this.peakHead - 0.7);
      }
      const peakPct = this.peakHead <= -95 ? 0 : Math.max(0, Math.min(100, ((this.peakHead + 100) / 100) * 100));

      this.updateDOM('headset', clampedDb, pct, peakPct, this.headGateDb);
    }

    this.animFrameId = requestAnimationFrame(this.tick);
  };

  private updateDOM(target: 'desk' | 'headset', db: number, pct: number, peakPct: number, gateDb: number) {
    const bar = document.getElementById(`vu-bar-${target}`);
    const peak = document.getElementById(`vu-peak-${target}`);
    const text = document.getElementById(`vu-db-${target}`);
    const gateMarker = document.getElementById(`vu-gate-${target}`);
    const vadBadge = document.getElementById(`vad-badge-${target}`);

    if (bar) bar.style.width = `${pct}%`;
    if (peak) {
      peak.style.display = pct > 1 ? 'block' : 'none';
      peak.style.left = `${peakPct}%`;
    }

    // Update Gate Marker on VU track
    if (gateMarker) {
      const gatePct = Math.max(0, Math.min(100, ((gateDb + 100) / 100) * 100));
      gateMarker.style.left = `${gatePct}%`;
      gateMarker.title = `Próg Discord: ${gateDb} dB`;
    }

    // Histereza i bufor mowy (250ms hangover)
    const now = Date.now();
    const isAboveGate = db >= gateDb && db > -85;
    if (isAboveGate) {
      if (target === 'desk') this.deskVoiceHangover = now + 250;
      else this.headVoiceHangover = now + 250;
    }

    const isOpen = target === 'desk' ? now < this.deskVoiceHangover : now < this.headVoiceHangover;

    // Update Voice Activity Gate status badge
    if (vadBadge) {
      vadBadge.className = `fc-vad-status-badge ${isOpen ? 'open' : 'closed'}`;
      vadBadge.textContent = isOpen ? '🗣️ Głos aktywny' : '🔇 Szum odcięty';
    }

    if (text) {
      text.className = db >= -2 ? 'fc-vu-db-text clipping' : 'fc-vu-db-text';
      text.textContent = db <= -95 ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
    }
  }

  stop() {
    this.isRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.deskStream?.getTracks().forEach((t) => t.stop());
    this.headStream?.getTracks().forEach((t) => t.stop());
    this.deskStream = null;
    this.headStream = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}

// ---------- Application State & UI ----------

type TabType = 'home' | 'settings' | 'logs' | 'about';

type SettingsTab = 'port' | 'timeouts' | 'biometrics' | 'discord' | 'signalrgb' | 'chime' | 'haos';

class AppUI {
  private root: HTMLElement;
  private snap: Snapshot | null = null;
  private form: Snapshot['config'] | null = null;
  private ports: SerialPortInfo[] = [];
  private audioDevices: AudioDeviceItem[] = [];
  private isMuted = false;
  private isMaximized = false;
  private dirty = false;
  private saving = false;
  private autoSaveTimer: any = null;
  private refreshingPorts = false;
  private updater: UpdaterStatus = { status: 'idle', currentVersion: '' };
  private downloadProgress: { percent: number; speed: string } | null = null;
  private toasts: { id: number; message: string; error?: boolean; timer?: any; paused?: boolean }[] = [];
  private toastCounter = 0;
  private saveState = { text: 'Wszystkie ustawienia zapisane ✓', kind: 'saved' };

  // Live Audio VU-Meter Engine
  private vuEngine = new LiveAudioEngine();
  private osdTimer: any = null;

  // Navigation tab
  private currentTab: TabType = 'home';

  // Podsekcja ustawień (lewy panel nawigacji ustawień)
  private settingsTab: SettingsTab = 'port';

  // QoL: Auto-Switch Snooze
  private snoozeUntil: number | null = null;
  private selectedChimeStyle: ChimeStyle = 'harmonic';

  // QoL: Log Filtering & Search
  private logFilter: 'all' | 'radar' | 'haos' | 'audio' | 'discord' | 'error' = 'all';
  private logSearch = '';

  // QoL: Discord Auto-Threshold Calibration Assistant
  private vadModalOpen = false;
  private vadTarget: 'desk' | 'headset' = 'desk';
  private vadStep: 1 | 2 | 3 = 1;
  private vadCountdown = 0;
  private vadInterval: any = null;
  private vadSampleInterval: any = null;
  private vadNoiseSamples: number[] = [];
  private vadSpeechSamples: number[] = [];
  private vadResults = { noiseDb: -52, speechDb: -22, optimalGateDb: -42 };
  private vadWarning = '';

  // Home Assistant (HAOS) State
  private haTesting = false;
  private haTestResult: { ok: boolean; message?: string; version?: string; error?: string } | null = null;
  private haFetchingEntities = false;
  private haBinarySensors: { entity_id: string; name: string; state: string }[] = [];
  private haSensors: { entity_id: string; name: string; state: string; unit?: string }[] = [];
  private haShowToken = false;

  // Telemetria biometryczna na żywo
  private telemetry: RadarTelemetry = {
    distanceCm: 0,
    distanceTrusted: true,
    targetCount: undefined,
    heartRate: 0,
    breathRate: 0,
    illuminanceLux: undefined,
    detectedPerson: 'unknown',
    autoTuning: {
      enabled: true,
      noiseFloor: 0,
      samplesCount: 0,
      adaptedDistanceCenter: 0,
      adaptedDistanceMin: 0,
      adaptedDistanceMax: 0,
      adaptedHeartRateAvg: 0,
      adaptedBreathRateAvg: 0,
      stabilityScore: 0,
      stabilityReady: false,
      lastAdaptedAt: 0
    }
  };

  // Modale aplikacji
  private wizardOpen = false;
  private wizardStep: 1 | 2 | 3 = 1;
  private wizardCountdown = 0;
  private wizardInterval: any = null;
  private wizardWarning = '';
  private wizardPresenceSeen = false;
  private wizardSamples: { distances: number[] } = {
    distances: []
  };
  private wizardResults = {
    distance: 75,
    gateMin: 45,
    gateMax: 110
  };

  private diagModalOpen = false;
  private logs: string[] = [];

  // Sesja diagnostyczna "Wyjście z pokoju"
  private diagActive = false;
  private diagSessionText = '';
  private diagReportModalOpen = false;

  private lastDeviceSig = '';
  private lastPortSig = '';

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async init() {
    try {
      if (window.api && typeof window.api.getState === 'function') {
        this.snap = await window.api.getState();
      }
    } catch (err) {
      console.error('[DeskSense] Błąd pobierania stanu początkowego:', err);
    }

    // Sesja diag żyje w main process — odśwież przycisk po restarcie okna
    try {
      const st = await window.api.diagStatus();
      this.diagActive = st.active;
    } catch (_) {}

    if (this.snap) {
      this.form = { ...this.snap.config };
      if (this.snap.telemetry) {
        this.telemetry = { ...this.snap.telemetry };
      }
      // Styl chime i pauza automatyki żyją w main (config/snapshot) —
      // odzyskujemy je po restarcie okna zamiast udawać domyślne.
      this.selectedChimeStyle = this.form.audioChimeStyle || 'harmonic';
      this.snoozeUntil = this.snap.snoozeUntil > 0 ? this.snap.snoozeUntil : null;
    }

    try {
      if (window.api && typeof window.api.getPorts === 'function') {
        this.ports = (await window.api.getPorts()) || [];
      }
    } catch (err) {
      console.error('[DeskSense] Błąd pobierania listy portów:', err);
    }

    try {
      await this.loadAudioDevices();
    } catch (err) {
      console.error('[DeskSense] Błąd ładowania urządzeń audio:', err);
    }

    try {
      if (window.api && typeof window.api.isWindowMaximized === 'function') {
        this.isMaximized = await window.api.isWindowMaximized();
      }
    } catch (_) {}

    try {
      if (window.api && typeof window.api.getLogs === 'function') {
        this.logs = (await window.api.getLogs()) || [];
      }
    } catch (_) {}

    try {
      if (window.api && typeof window.api.getUpdaterStatus === 'function') {
        const upd = await window.api.getUpdaterStatus();
        if (upd) this.updater = upd;
      }
    } catch (_) {}

    try {
      if (window.api && typeof window.api.onEvent === 'function') {
        window.api.onEvent((e: PushEvent) => this.handleEvent(e));
      }
    } catch (err) {
      console.error('[DeskSense] Błąd rejestracji push:event:', err);
    }

    this.lastDeviceSig = this.deviceListSig(this.audioDevices);
    this.lastPortSig = this.portListSig(this.ports);

    // Initialize VAD gate thresholds in engine
    if (this.form) {
      this.vuEngine.deskGateDb = this.form.micDeskGateDb ?? -45;
      this.vuEngine.headGateDb = this.form.micHeadsetGateDb ?? -45;
      // Start Live Audio VU-Meter if window is visible
      void this.vuEngine.start(this.form.micDeskName, this.form.micHeadsetName);
    }

    // Bluetooth & Window Visibility Lifecycle Management
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.vuEngine.restartWithLastDevices();
      } else {
        if (this.dirty) void this.save();
        this.vuEngine.stop();
      }
    });

    window.addEventListener('beforeunload', () => {
      if (this.dirty) {
        void this.save();
      }
      this.vuEngine.stop();
    });

    // Snooze timer tick
    setInterval(() => {
      if (this.snoozeUntil && Date.now() > this.snoozeUntil) {
        this.snoozeUntil = null;
        this.pushToast('Pauza automatyki zakończona — wznowiono auto-switching ✓');
        this.render();
      }
    }, 1000);

    // Hardware polling
    setInterval(() => {
      if (!this.snap || document.visibilityState !== 'visible') return;
      void this.pollHardwareLists();
    }, 3000);

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'F12' || ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'i')) {
        ev.preventDefault();
        try {
          window.api?.toggleDevTools?.();
        } catch (_) {}
      } else if (ev.key === 'Escape') {
        if (this.wizardOpen) {
          ev.preventDefault();
          this.closeCalibrationWizard();
        } else if (this.vadModalOpen) {
          ev.preventDefault();
          this.closeVadModal();
        } else if (this.diagModalOpen || this.diagReportModalOpen) {
          ev.preventDefault();
          this.diagModalOpen = false;
          this.diagReportModalOpen = false;
          this.render();
        }
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        if (this.dirty && !this.saving) {
          void this.save();
        }
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

  private triggerOsdHud(text: string, isMuted: boolean) {
    const el = document.getElementById('fc-osd-hud');
    if (!el) return;
    if (this.osdTimer) clearTimeout(this.osdTimer);

    el.className = `fc-osd-hud visible ${isMuted ? 'muted' : ''}`;
    el.innerHTML = `<span>${text}</span>`;

    this.osdTimer = setTimeout(() => {
      el.className = `fc-osd-hud ${isMuted ? 'muted' : ''}`;
    }, 2200);
  }

  private handleEvent(e: PushEvent) {
    if (e.type === 'window:visibility') {
      const isVisible = Boolean(e.visible);
      if (isVisible) {
        this.vuEngine.restartWithLastDevices();
        void this.pollHardwareLists();
        // Snapshot jest pushowany tylko do widocznego okna — po otwarciu z tray
        // dociągamy aktualny stan (m.in. podświetlenie aktywnej karty mikrofonu).
        if (window.api && typeof window.api.getState === 'function') {
          void window.api.getState().then((s) => {
            if (!s) return;
            this.snap = s;
            if (s.telemetry) this.telemetry = { ...s.telemetry };
            if (!this.dirty) this.form = { ...s.config };
            this.loadAudioDevices().then(() => this.updateHeaderAndLiveDOM());
          });
        }
      } else {
        if (this.dirty) void this.save();
        this.vuEngine.stop();
      }
      return;
    }

    if (e.type === 'snapshot' && e.snapshot) {
      this.snap = e.snapshot;
      if (e.snapshot.telemetry) {
        this.telemetry = { ...e.snapshot.telemetry };
      }
      this.snoozeUntil = e.snapshot.snoozeUntil > 0 ? e.snapshot.snoozeUntil : null;
      if (!this.dirty) {
        this.form = { ...e.snapshot.config };
        this.selectedChimeStyle = this.form.audioChimeStyle || 'harmonic';
      }
      this.loadAudioDevices().then(() => {
        this.updateHeaderAndLiveDOM();
      });
      return;
    }

    if (e.type === 'devices:changed' && Array.isArray(e.devices)) {
      this.audioDevices = e.devices as AudioDeviceItem[];
      this.lastDeviceSig = this.deviceListSig(this.audioDevices);
      this.refreshMicSelectOptions();
      if (e.added && e.added.length) {
        this.pushToast(`Wykryto nowy mikrofon: ${e.added.join(', ')}`);
      }
      if (e.removed && e.removed.length) {
        this.pushToast(`Odłączono mikrofon: ${e.removed.join(', ')}`);
      }
      void this.vuEngine.start(this.form?.micDeskName || '', this.form?.micHeadsetName || '');
      return;
    }

    if (e.type === 'ports:changed' && Array.isArray(e.ports)) {
      this.ports = e.ports as SerialPortInfo[];
      this.lastPortSig = this.portListSig(this.ports);
      this.refreshPortSelectOptions();
      return;
    }

    if (e.type === 'telemetry') {
      const { type: _ignored, ...tel } = e;
      this.telemetry = { ...this.telemetry, ...tel };
      this.updateTelemetryDOM();

      if (this.wizardOpen && this.wizardCountdown > 0) {
        if (this.wizardStep === 2 && this.telemetry.distanceCm) {
          this.wizardSamples.distances.push(this.telemetry.distanceCm);
        }
      }
    }

    if (e.type === 'window:state' && typeof e.isMaximized === 'boolean') {
      this.isMaximized = e.isMaximized;
      const winMaxBtn = document.getElementById('fc-win-max');
      if (winMaxBtn) {
        winMaxBtn.title = this.isMaximized ? 'Przywróć okno' : 'Maksymalizuj okno';
        winMaxBtn.innerHTML = this.isMaximized
          ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/></svg>`
          : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
      }
    }

    if (e.type === 'toast' && e.message) {
      this.pushToast(e.message, e.error);
    }

    if (e.type === 'switch' && e.state) {
      if (this.form && this.form.audioChime) {
        const shouldChime = e.state === 'desk' ? (this.form.audioChimeOnDesk !== false) : (this.form.audioChimeOnAway !== false);
        if (shouldChime) {
          const vol = this.form.audioChimeVolume ?? 0.2;
          const customFile = e.state === 'desk'
            ? (this.form.audioFileDesk || '')
            : (this.form.audioFileHeadset || '');
          if (customFile) {
            playCustomAudioFile(customFile, e.state, vol);
          } else {
            playChime(e.state, vol, this.selectedChimeStyle);
          }
        }
      }
      this.triggerOsdHud(
        e.state === 'desk' ? '🎙️ Przełączono: Mikrofon Biurkowy' : '🎧 Przełączono: Mikrofon Mobilny',
        this.isMuted
      );
    }

    if (e.type === 'updater:status') {
      this.updater = {
        ...this.updater,
        status: (e.status as any) || this.updater.status,
        updateInfo: e.updateInfo !== undefined ? e.updateInfo : this.updater.updateInfo,
        error: e.error ? String(e.error) : undefined
      };
      if (this.currentTab === 'about') this.render();
    }

    if (e.type === 'updater:progress') {
      this.downloadProgress = {
        percent: e.percent || 0,
        speed: e.speed || ''
      };
      const fill = document.getElementById('upd-progress-fill');
      const txt = document.getElementById('upd-progress-text');
      if (fill && txt) {
        fill.style.width = `${e.percent || 0}%`;
        txt.textContent = `${e.percent || 0}% (${e.speed || ''})`;
      }
    }


    if (e.type === 'log:entry' && (e.entry || e.message)) {
      const line = e.entry || e.message || '';
      this.logs.push(line);
      if (this.logs.length > 5000) this.logs.shift();
      this.refreshLogConsoleDOM();
    }
  }

  private updateHeaderAndLiveDOM() {
    if (!this.snap) return;
    const radar = this.snap.radar;
    const isOnline = Boolean(radar.connected || this.snap.ha?.connected);
    const label = radar.connected ? 'Radar: USB ✓' : (this.snap.ha?.connected ? 'Radar: HAOS ✓' : 'Radar: Brak połączenia');
    const radarBadge = document.getElementById('fc-header-radar-badge');
    if (radarBadge) {
      radarBadge.className = `fc-top-badge ${isOnline ? 'connected' : ''}`;
      radarBadge.innerHTML = `<span class="dot"></span> ${label}`;
    }

    const diagBtn = document.getElementById('fc-header-diag-btn');
    if (diagBtn) {
      diagBtn.className = `fc-diag-btn ${this.diagActive ? 'active' : ''}`;
      diagBtn.innerHTML = this.diagActive ? '⏹ Zakończ test' : '🧪 Wyjście z pokoju';
      diagBtn.setAttribute('title', this.diagActive
        ? 'Sesja diagnostyczna trwa — kliknij po powrocie, aby zobaczyć logi'
        : 'Wychodzisz z pokoju? Kliknij — aplikacja nagra logi do diagnozy wykrywania nieobecności');
    }

    const muteBtn = document.getElementById('fc-header-mute-btn');
    if (muteBtn) {
      muteBtn.className = `fc-mute-btn ${this.isMuted ? 'muted' : ''}`;
      muteBtn.innerHTML = this.isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny';
    }

    const cardMuteSwitch = document.getElementById('card-sw-mute');
    if (cardMuteSwitch) {
      cardMuteSwitch.className = `fc-switch ${!this.isMuted ? 'active' : ''}`;
      cardMuteSwitch.setAttribute('aria-checked', String(!this.isMuted));
    }

    const cardMuteBadge = document.getElementById('card-badge-mute');
    if (cardMuteBadge) {
      cardMuteBadge.className = `fc-badge ${this.isMuted ? 'amber' : 'success'}`;
      cardMuteBadge.textContent = this.isMuted ? 'Wyciszony 🔇' : 'Aktywny 🎙️';
    }

    this.updateActiveMicCards();
    this.updateTelemetryDOM();
  }

  /**
   * Żywe odświeżanie podświetlenia kart mikrofonów (zielona ramka "Domyślny ✓").
   * snapshot przychodzi po każdym przełączeniu, ale pełny render() jest zbyt
   * drogi — aktualizamy tylko klasy kart, selectów i badge'y.
   */
  private updateActiveMicCards() {
    const isDeskActive = this.isMicActive('desk');
    const isHeadsetActive = this.isMicActive('headset');

    const apply = (
      cardId: string,
      selectId: string,
      badgeId: string,
      active: boolean,
      idleLabel: string
    ) => {
      const card = document.getElementById(cardId);
      if (card) {
        card.classList.toggle('highlight', active);
        card.classList.toggle('active-mic', active);
      }
      const select = document.getElementById(selectId);
      if (select) {
        select.classList.toggle('active-source', active);
      }
      const badge = document.getElementById(badgeId);
      if (badge) {
        badge.className = `fc-badge ${active ? 'calibrated' : 'muted'}`;
        badge.textContent = active ? 'Domyślny ✓' : idleLabel;
      }
    };

    apply('card-mic-desk', 'sel-mic-desk', 'badge-mic-desk', isDeskActive, 'Gotowy');
    apply('card-mic-headset', 'sel-mic-headset', 'badge-mic-headset', isHeadsetActive, 'Rezerwa');
  }

  private updateTelemetryDOM() {
    const elDist = document.getElementById('card-val-distance');
    const elHeart = document.getElementById('card-val-heart');
    const elBreath = document.getElementById('card-val-breath');
    const elLux = document.getElementById('card-val-lux');
    const elPerson = document.getElementById('card-badge-person');

    if (elDist) {
      if (this.telemetry.distanceCm && this.telemetry.distanceCm > 0) {
        elDist.textContent =
          this.telemetry.distanceTrusted === false
            ? `${this.telemetry.distanceCm} cm (niepewny)`
            : `${this.telemetry.distanceCm} cm`;
      } else if (this.telemetry.presence === false) {
        elDist.textContent = '— (Brak celu)';
      } else {
        elDist.textContent = '—';
      }
    }
    if (elHeart) elHeart.textContent = this.telemetry.heartRate ? `${this.telemetry.heartRate} BPM` : '—';
    if (elBreath) elBreath.textContent = this.telemetry.breathRate ? `${this.telemetry.breathRate} RPM` : '—';
    if (elLux) {
      elLux.textContent = typeof this.telemetry.illuminanceLux === 'number' ? `${this.telemetry.illuminanceLux} lx` : '—';
    }

    if (elPerson) {
      const p = this.telemetry.detectedPerson || 'unknown';
      elPerson.className = `fc-badge ${p === 'me' ? 'calibrated' : (p === 'pet' ? 'amber' : 'blue')}`;
      if (p === 'me') {
        elPerson.textContent = '👤 Człowiek ✓';
      } else if (p === 'pet') {
        elPerson.textContent = '🐾 Zwierzę (Kot/Pies)';
      } else {
        elPerson.textContent = '🔍 Skanowanie…';
      }
    }

    // Update Live Radar Scope Visualizer
    this.updateRadarScopeDOM();

    const tun = this.telemetry.autoTuning;
    if (tun) {
      const elTunDist = document.getElementById('card-val-autotune-dist');
      const elTunStability = document.getElementById('card-badge-autotune-stability');
      const elTunNoise = document.getElementById('card-val-autotune-noise');
      const elTunZone = document.getElementById('card-val-autotune-zone');
      const elTunBio = document.getElementById('card-val-autotune-bio');
      if (elTunDist) elTunDist.textContent = tun.adaptedDistanceCenter ? `${tun.adaptedDistanceCenter} cm` : '—';
      if (elTunZone) elTunZone.textContent = this.autoTuneZoneLabel();
      if (elTunBio) elTunBio.textContent = this.autoTuneBioLabel();
      if (elTunNoise) {
        elTunNoise.textContent = this.autoTuneNoiseLabel(tun.noiseFloor ?? 0);
        elTunNoise.style.color = (tun.noiseFloor ?? 0) >= 40 ? 'var(--fc-accent-amber)' : 'var(--fc-accent-green)';
      }
      if (elTunStability) elTunStability.textContent = this.autoTuneStabilityLabel(tun);
    }
  }

  /** Etykieta szumu: % odczytów w nieobecności z echem w strefie fotela. */
  private autoTuneNoiseLabel(noiseFloor: number): string {
    const v = Math.round(noiseFloor);
    if (v < 15) return `${v}% (Czyste)`;
    if (v < 40) return `${v}% (Sporadyczne odbicia)`;
    return `${v}% (Silne odbicia)`;
  }

  /** Wyuczona strefa fotela = adaptacyjna bramka górna (auto-tuning tylko poszerza config). */
  private autoTuneZoneLabel(): string {
    const tun = this.telemetry.autoTuning;
    if (!tun?.adaptedDistanceCenter) return '—';
    return `${tun.adaptedDistanceMin}–${tun.adaptedDistanceMax} cm`;
  }

  /** Wyuczone średnie tętno/oddech — dowód, że radar widzi użytkownika biologicznie. */
  private autoTuneBioLabel(): string {
    const tun = this.telemetry.autoTuning;
    if (!tun?.adaptedHeartRateAvg && !tun?.adaptedBreathRateAvg) return '—';
    const hr = tun?.adaptedHeartRateAvg ? `${tun.adaptedHeartRateAvg} BPM` : '—';
    const br = tun?.adaptedBreathRateAvg ? `${tun.adaptedBreathRateAvg} RPM` : '—';
    return `${hr} · ${br}`;
  }

  private autoTuneStabilityLabel(tun: { stabilityScore?: number; stabilityReady?: boolean } | undefined): string {
    if (!tun?.stabilityReady) return 'Nauka…';
    return `Stabilność: ${tun.stabilityScore ?? 0}% ✓`;
  }

  private updateRadarScopeDOM() {
    if (!this.form) return;
    const minGate = this.form.radarMinDistanceCm ?? 40;
    const maxGate = this.form.radarMaxDistanceCm ?? 110;
    const maxScale = 200;

    const deadPct = Math.max(0, Math.min(100, (minGate / maxScale) * 100));
    const activeLeftPct = deadPct;
    const activeWidthPct = Math.max(2, Math.min(100 - deadPct, ((maxGate - minGate) / maxScale) * 100));
    const cutoffLeftPct = Math.min(100, (maxGate / maxScale) * 100);

    const deadZone = document.getElementById('scope-dead-zone');
    const activeZone = document.getElementById('scope-active-zone');
    const cutoffZone = document.getElementById('scope-cutoff-zone');
    const userPin = document.getElementById('scope-user-pin');
    const userBadge = document.getElementById('scope-user-badge');
    const userLine = document.getElementById('scope-user-line');
    const liveStatusText = document.getElementById('scope-live-status-text');
    const minHandle = document.getElementById('scope-handle-min');
    const maxHandle = document.getElementById('scope-handle-max');

    if (deadZone) deadZone.style.width = `${deadPct}%`;
    if (activeZone) {
      activeZone.style.left = `${activeLeftPct}%`;
      activeZone.style.width = `${activeWidthPct}%`;
      activeZone.innerHTML = `<span>STREFA FOTELA (${minGate}–${maxGate} cm)</span>`;
    }
    if (cutoffZone) {
      cutoffZone.style.left = `${cutoffLeftPct}%`;
      cutoffZone.style.width = `${Math.max(0, 100 - cutoffLeftPct)}%`;
    }
    if (minHandle) minHandle.style.left = `${deadPct}%`;
    if (maxHandle) maxHandle.style.left = `${cutoffLeftPct}%`;

    if (userPin && userBadge && userLine) {
      const curDist = this.telemetry.distanceCm;
      if (curDist && curDist > 0) {
        const userPct = Math.max(0, Math.min(100, (curDist / maxScale) * 100));
        const isInside = curDist >= minGate && curDist <= maxGate;

        userPin.style.display = 'flex';
        userPin.style.left = `${userPct}%`;

        userBadge.className = `fc-scope-user-badge ${isInside ? '' : 'outside'}`;
        userBadge.innerHTML =
          this.telemetry.distanceTrusted === false
            ? `⚠️ Cel niepewny: ${curDist} cm (kot?)`
            : isInside
              ? `● Ty: ${curDist} cm ✓`
              : `⚠️ ${curDist} cm (Poza strefą)`;

        userLine.className = `fc-scope-user-line ${isInside ? '' : 'outside'}`;

        if (liveStatusText) {
          liveStatusText.innerHTML =
            this.telemetry.distanceTrusted === false
              ? `<strong style="color: #f59e0b">⚠️ Cel niejednoznaczny: ${curDist} cm</strong> <span style="color: var(--fc-text-muted)">(kot? — bramka wstrzymana)</span>`
              : isInside
                ? `<strong style="color: var(--fc-accent-green)">● Obecność: ${curDist} cm</strong> <span style="color: var(--fc-text-secondary)">(W aktywnej strefie fotela ✓)</span>`
                : `<strong style="color: #f59e0b">⚠️ Wykryto poza strefą: ${curDist} cm</strong> <span style="color: var(--fc-text-muted)">(Ignorowane tło)</span>`;
        }
      } else {
        userPin.style.display = 'none';
        if (liveStatusText) {
          liveStatusText.innerHTML = `<span style="color: var(--fc-text-muted)">Brak wykrycia człowieka w kadrze radaru</span>`;
        }
      }
    }
  }

  /**
   * Filtr logów wspólny dla konsoli i przycisków kopiowania — "Kopiuj RAW" /
   * "Kopiuj dla AI" zwracają dokładnie to, co użytkownik widzi w aktywnej
   * zakładce (Audio & VU, Discord & RGB itd.) plus wyszukiwarka.
   */
  private applyLogFilter(logs: string[]): string[] {
    let filtered = logs;
    if (this.logFilter === 'radar') filtered = filtered.filter((l) => l.toLowerCase().includes('radar') || l.toLowerCase().includes('serial') || l.toLowerCase().includes('dsp'));
    if (this.logFilter === 'haos') filtered = filtered.filter((l) => l.includes('[HAOS]'));
    if (this.logFilter === 'audio') filtered = filtered.filter((l) => l.toLowerCase().includes('audio') || l.toLowerCase().includes('mic') || l.toLowerCase().includes('vu'));
    if (this.logFilter === 'discord') filtered = filtered.filter((l) => l.toLowerCase().includes('discord') || l.toLowerCase().includes('vad') || l.toLowerCase().includes('signalrgb'));
    if (this.logFilter === 'error') filtered = filtered.filter((l) => l.toLowerCase().includes('err') || l.toLowerCase().includes('błąd') || l.toLowerCase().includes('warn') || l.toLowerCase().includes('error'));

    if (this.logSearch) {
      const q = this.logSearch.toLowerCase();
      filtered = filtered.filter((l) => l.toLowerCase().includes(q));
    }
    return filtered;
  }

  private refreshLogConsoleDOM() {
    const c = document.getElementById('log-console');
    if (!c) return;

    const filtered = this.applyLogFilter(this.logs);

    c.textContent = filtered.length > 0 ? filtered.join('\n') : 'Brak pasujących logów dla zadanego filtru.';
    c.scrollTop = c.scrollHeight;
  }

  private pushToast(message: string, error = false) {
    const id = ++this.toastCounter;
    if (this.toasts.length >= 4) {
      const oldest = this.toasts.shift();
      if (oldest?.timer) clearTimeout(oldest.timer);
    }
    const item = { id, message, error, timer: null as any, paused: false };
    this.toasts.push(item);
    this.renderToasts();

    const startTimer = () => {
      item.timer = setTimeout(() => {
        if (!item.paused) {
          this.toasts = this.toasts.filter((t) => t.id !== id);
          this.renderToasts();
        }
      }, 3500);
    };

    startTimer();
  }

  private renderToasts() {
    const container = this.root.querySelector('.toasts');
    if (!container) return;
    container.innerHTML = this.toasts
      .map((t) => `<div class="toast ${t.error ? 'error' : ''}" data-toast-id="${t.id}" title="Kliknij, aby zamknąć powiadomienie">${esc(t.message)}</div>`)
      .join('');

    // Add hover pause and click to dismiss
    container.querySelectorAll('.toast').forEach((el) => {
      const tid = Number((el as HTMLElement).getAttribute('data-toast-id'));
      const toastObj = this.toasts.find((t) => t.id === tid);

      el.addEventListener('mouseenter', () => {
        if (toastObj) {
          toastObj.paused = true;
          if (toastObj.timer) clearTimeout(toastObj.timer);
        }
      });

      el.addEventListener('mouseleave', () => {
        if (toastObj) {
          toastObj.paused = false;
          toastObj.timer = setTimeout(() => {
            this.toasts = this.toasts.filter((t) => t.id !== tid);
            this.renderToasts();
          }, 2000);
        }
      });

      el.addEventListener('click', () => {
        this.toasts = this.toasts.filter((t) => t.id !== tid);
        this.renderToasts();
      });
    });
  }

  private patchForm(patch: Partial<Snapshot['config']>, reRender = false) {
    if (!this.form) return;
    this.form = { ...this.form, ...patch };
    this.dirty = true;
    this.saveState = { text: 'Zapisywanie zmian…', kind: 'saving' };

    const saveStateEl = document.getElementById('fc-save-state-text');
    const btnSave = document.getElementById('fc-btn-save') as HTMLButtonElement | null;
    if (saveStateEl) {
      saveStateEl.className = 'fc-save-state saving';
      saveStateEl.textContent = 'Zapisywanie zmian…';
    }
    if (btnSave) btnSave.disabled = false;

    if (patch.micDeskGateDb !== undefined) {
      this.vuEngine.deskGateDb = patch.micDeskGateDb;
    }
    if (patch.micHeadsetGateDb !== undefined) {
      this.vuEngine.headGateDb = patch.micHeadsetGateDb;
    }
    if (patch.audioChimeStyle !== undefined) {
      this.selectedChimeStyle = patch.audioChimeStyle;
    }

    // Debounced Auto-Save (1.5s after last modification)
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      if (this.dirty && !this.saving) {
        void this.save();
      }
    }, 1500);

    if (reRender) {
      this.render();
    } else {
      this.updateRadarScopeDOM();
    }
  }

  private async save() {
    if (!this.form || this.saving) return;
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.saving = true;
    this.saveState = { text: 'Zapisywanie…', kind: 'saving' };

    const saveStateEl = document.getElementById('fc-save-state-text');
    if (saveStateEl) {
      saveStateEl.className = 'fc-save-state saving';
      saveStateEl.textContent = 'Zapisywanie…';
    }

    try {
      this.snap = await window.api.updateConfig(this.form);
      this.form = { ...this.snap.config };
      this.dirty = false;
      this.saveState = { text: 'Wszystkie ustawienia zapisane ✓', kind: 'saved' };
      if (saveStateEl) {
        saveStateEl.className = 'fc-save-state saved';
        saveStateEl.textContent = 'Wszystkie ustawienia zapisane ✓';
      }
      const btnSave = document.getElementById('fc-btn-save') as HTMLButtonElement | null;
      if (btnSave) btnSave.disabled = true;

      void this.vuEngine.start(this.form.micDeskName, this.form.micHeadsetName);
    } catch (err: any) {
      this.saveState = { text: 'Błąd zapisu', kind: 'error' };
      this.pushToast(`Błąd zapisu: ${err.message}`, true);
    } finally {
      this.saving = false;
    }
  }

  // ---------- VAD Auto-Calibration Assistant Methods ----------
  private openVadModal(target: 'desk' | 'headset') {
    this.vadTarget = target;
    this.vadModalOpen = true;
    this.vadStep = 1;
    this.vadCountdown = 0;
    this.vadNoiseSamples = [];
    this.vadSpeechSamples = [];
    this.vadWarning = '';
    if (this.vadInterval) clearInterval(this.vadInterval);
    if (this.vadSampleInterval) clearInterval(this.vadSampleInterval);
    this.vadInterval = null;
    this.vadSampleInterval = null;
    this.render();
  }

  private closeVadModal() {
    this.vadModalOpen = false;
    if (this.vadInterval) clearInterval(this.vadInterval);
    if (this.vadSampleInterval) clearInterval(this.vadSampleInterval);
    this.vadInterval = null;
    this.vadSampleInterval = null;
    this.render();
  }

  private runVadStep1() {
    this.vadCountdown = 5;
    this.vadNoiseSamples = [];
    this.vadWarning = '';
    if (this.vadInterval) clearInterval(this.vadInterval);
    if (this.vadSampleInterval) clearInterval(this.vadSampleInterval);
    this.render();

    // Szybkie próbkowanie szumu tła 20x na sekundę (co 50ms)
    this.vadSampleInterval = setInterval(() => {
      const liveDb = this.vadTarget === 'desk' ? this.vuEngine.currentDeskDb : this.vuEngine.currentHeadDb;
      if (liveDb > -100) this.vadNoiseSamples.push(liveDb);
    }, 50);

    this.vadInterval = setInterval(() => {
      this.vadCountdown--;
      if (this.vadCountdown <= 0) {
        clearInterval(this.vadInterval);
        clearInterval(this.vadSampleInterval);
        this.vadInterval = null;
        this.vadSampleInterval = null;

        if (this.vadNoiseSamples.length === 0) {
          this.vadNoiseSamples.push(-70);
        }

        // Sortowanie próbek i pobranie 85. percentyla szumu otoczenia (uwzględnia szum wentylatorów i klikanie)
        const sorted = [...this.vadNoiseSamples].sort((a, b) => a - b);
        const p85Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85));
        const noiseP85 = Math.round(sorted[p85Idx]);

        if (noiseP85 > -25) {
          this.vadWarning = 'Wykryto zbyt głośny dźwięk podczas pomiaru ciszy. Upewnij się, że nie mówisz i powtórz krok 1.';
          this.render();
          return;
        }

        this.vadResults.noiseDb = Math.min(-35, Math.max(-95, noiseP85));
        playChime('desk', 0.2, this.selectedChimeStyle);
        this.vadStep = 2;
      }
      this.render();
    }, 1000);
  }

  private runVadStep2() {
    this.vadCountdown = 6;
    this.vadSpeechSamples = [];
    this.vadWarning = '';
    if (this.vadInterval) clearInterval(this.vadInterval);
    if (this.vadSampleInterval) clearInterval(this.vadSampleInterval);
    this.render();

    // Gęste próbkowanie głosu co 50ms — zbieramy tylko aktywne sylaby głosu (ponad szumem)
    this.vadSampleInterval = setInterval(() => {
      const liveDb = this.vadTarget === 'desk' ? this.vuEngine.currentDeskDb : this.vuEngine.currentHeadDb;
      if (liveDb > this.vadResults.noiseDb + 3) {
        this.vadSpeechSamples.push(liveDb);
      }
    }, 50);

    this.vadInterval = setInterval(() => {
      this.vadCountdown--;
      if (this.vadCountdown <= 0) {
        clearInterval(this.vadInterval);
        clearInterval(this.vadSampleInterval);
        this.vadInterval = null;
        this.vadSampleInterval = null;

        const avgSpeech = this.vadSpeechSamples.length > 0
          ? Math.round(this.vadSpeechSamples.reduce((a, b) => a + b, 0) / this.vadSpeechSamples.length)
          : -24;

        if (avgSpeech <= this.vadResults.noiseDb + 3 || this.vadSpeechSamples.length < 5) {
          this.vadWarning = 'Nie wykryto wyraźnego głosu. Mów głośniej i powtórz krok 2.';
          this.render();
          return;
        }

        this.vadResults.speechDb = Math.max(-35, avgSpeech);

        // Bazowy próg: współczynnik 0.28 (czuły punkt startowy blisko szumu)
        const baseThreshold = this.vadResults.noiseDb + (this.vadResults.speechDb - this.vadResults.noiseDb) * 0.28;

        // Margines bezpieczeństwa -3 dB (lepiej przepuścić ciut więcej niż uciąć początek/końcówkę słowa)
        const safeGate = Math.round(baseThreshold - 3);

        // Dolny strażnik: próg musi być co najmniej 3 dB ponad szumem tła, aby nie otwierał się w ciszy
        const minAllowedGate = Math.round(this.vadResults.noiseDb + 3);
        const finalGate = Math.max(minAllowedGate, safeGate);

        this.vadResults.optimalGateDb = Math.min(-10, Math.max(-95, finalGate));

        playChime('desk', 0.25, this.selectedChimeStyle);
        this.vadStep = 3;
      }
      this.render();
    }, 1000);
  }

  private applyVadResults() {
    const val = this.vadResults.optimalGateDb;
    if (this.vadTarget === 'desk') {
      this.patchForm({ micDeskGateDb: val }, true);
      if (this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
      this.pushToast(`Zastosowano próg Discord dla Mikrofonu Biurkowego: ${val} dB ✓`);
    } else {
      this.patchForm({ micHeadsetGateDb: val }, true);
      if (this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
      this.pushToast(`Zastosowano próg Discord dla Mikrofonu Mobilnego: ${val} dB ✓`);
    }

    this.closeVadModal();
    this.save();
  }

  // Wizard Methods
  private openCalibrationWizard() {
    this.wizardOpen = true;
    this.wizardStep = 1;
    this.wizardCountdown = 0;
    this.wizardWarning = '';
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
    this.wizardWarning = '';
    this.wizardPresenceSeen = false;
    this.render();
    this.wizardInterval = setInterval(() => {
      this.wizardCountdown--;
      if (this.telemetry.presence === true) this.wizardPresenceSeen = true;
      if (this.wizardCountdown <= 0) {
        clearInterval(this.wizardInterval);
        this.wizardInterval = null;
        if (this.wizardPresenceSeen) {
          // Uczciwa walidacja: kalibracja pustego fotela nie ma sensu, gdy radar
          // wciąż widzi człowieka — blokujemy krok zamiast udawać sukces.
          this.wizardWarning = 'Radar nadal wykrywa obecność przy biurku — odsuń się dalej od sensora (2–3 m) i rozpocznij pomiar ponownie.';
          this.render();
          return;
        }
        playChime('desk', 0.2, this.selectedChimeStyle);
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

        playChime('desk', 0.2, this.selectedChimeStyle);
        this.wizardStep = 3;
      }
      this.render();
    }, 1000);
  }

  private applyWizardCalibration() {
    this.patchForm({
      radarDistanceGateEnabled: true,
      radarMinDistanceCm: this.wizardResults.gateMin,
      radarMaxDistanceCm: this.wizardResults.gateMax,
      petFilterEnabled: true
    });

    this.closeCalibrationWizard();
    this.save();
    this.pushToast('Kalibracja sensora zakończona i zapisana ✓');
  }

  private deviceListSig(devices: AudioDeviceItem[]): string {
    return devices.map((d) => `${d.id || d.name}|${d.isDefault ? 1 : 0}`).sort().join(';');
  }

  private portListSig(ports: SerialPortInfo[]): string {
    return ports.map((p) => p.path).sort().join(';');
  }

  private async pollHardwareLists(): Promise<void> {
    try {
      const devs = await window.api.listDevices();
      if (this.deviceListSig(devs || []) !== this.lastDeviceSig) {
        this.audioDevices = devs || [];
        this.lastDeviceSig = this.deviceListSig(this.audioDevices);
        this.refreshMicSelectOptions();
        void this.vuEngine.start(this.form?.micDeskName || '', this.form?.micHeadsetName || '');
      }
      const ports = await window.api.getPorts();
      if (this.portListSig(ports) !== this.lastPortSig) {
        this.ports = ports;
        this.lastPortSig = this.portListSig(ports);
        this.refreshPortSelectOptions();
      }
    } catch {}
  }

  private refreshMicSelectOptions(): void {
    if (!this.form) return;
    const form = this.form;
    const build = (id: string, savedName: string): void => {
      const sel = document.getElementById(id) as HTMLSelectElement | null;
      if (!sel) return;
      sel.innerHTML =
        `<option value="" ${!savedName ? 'selected' : ''}>— Wybierz mikrofon —</option>` +
        this.missingDeviceOption(savedName, this.audioDevices) +
        this.audioDevices
          .map(
            (d) =>
              `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === savedName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`
          )
          .join('');
    };
    build('sel-mic-desk', form.micDeskName);
    build('sel-mic-headset', form.micHeadsetName);
  }

  private refreshPortSelectOptions(): void {
    const sel = document.getElementById('sel-port') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML =
      `<option value="auto" ${this.form?.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie XIAO ESP32-C6)</option>` +
      this.ports
        .map(
          (p) =>
            `<option value="${esc(p.path)}" ${p.path === this.form!.port ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`
        )
        .join('');
  }

  private missingDeviceOption(savedName: string, devices: AudioDeviceItem[]): string {
    if (!savedName || devices.some((d) => d.name === savedName)) return '';
    return `<option value="${esc(savedName)}" selected>${esc(savedName)} (odłączony)</option>`;
  }

  private initVolumePercent(micName: string, cfgVal: number | undefined): number {
    if (typeof cfgVal === 'number' && cfgVal >= 0) return cfgVal;
    const dev = this.audioDevices.find((d) => d.name === micName);
    if (dev && typeof dev.volume === 'number' && dev.volume >= 0 && dev.volume <= 100) {
      return Math.round(dev.volume);
    }
    return 100;
  }

  render() {
    if (!this.snap || !this.form) {
      this.root.innerHTML = `
        <div class="app" style="display: flex; align-items: center; justify-content: center; height: 100%; background: #1c2229; color: #94a3b8; font-family: sans-serif;">
          <div style="text-align: center; padding: 24px;">
            <div style="font-size: 32px; margin-bottom: 12px;">🎙️</div>
            <div style="font-size: 15px; color: #f1f5f9; font-weight: 600; margin-bottom: 6px;">DeskSense — Inicjalizacja…</div>
            <div style="font-size: 12px; color: #64748b; margin-bottom: 16px;">Trwa łączenie z usługą audio i sensorem mmWave</div>
            <button id="btn-fallback-reload" style="padding: 6px 14px; background: #2d3744; color: #f1f5f9; border: 1px solid #3b4756; border-radius: 6px; cursor: pointer; font-size: 12px;">Odśwież połączenie</button>
          </div>
        </div>
      `;
      document.getElementById('btn-fallback-reload')?.addEventListener('click', () => {
        void this.init();
      });
      return;
    }

    const contentEl = this.root.querySelector('.fc-content');
    const scrollPos = contentEl ? contentEl.scrollTop : 0;

    const radar = this.snap.radar;
    const isUnconfigured = !this.form.micDeskName && !this.form.micHeadsetName;
    const isSnoozed = this.snoozeUntil && Date.now() < this.snoozeUntil;
    const snoozeLeftMin = isSnoozed ? Math.ceil((this.snoozeUntil! - Date.now()) / 60000) : 0;

    this.root.innerHTML = `
      <div class="app">
        <!-- FLOATING OSD HUD (MUTE & STATUS OVERLAY) -->
        <div class="fc-osd-hud" id="fc-osd-hud"></div>

        <!-- TOP TITLEBAR (Fan Control Style Header) -->
        <header class="fc-titlebar" id="fc-titlebar">
          <div class="brand">
            <span class="logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </span>
            <span class="brand-title">DeskSense</span>
            <span class="profile-tag">v${esc(this.snap.version || this.updater.currentVersion)}</span>
          </div>

          <div class="top-tools">
            <!-- QoL: Snooze Pill -->
            ${isSnoozed ? `
              <button class="fc-snooze-pill" id="btn-cancel-snooze" title="Kliknij, aby wznowić automatyczne przełączanie">
                ⏸️ Pauza: ${snoozeLeftMin}m [Wznów]
              </button>
            ` : ''}

            <span class="fc-top-badge ${radar.connected || this.snap?.ha?.connected ? 'connected' : ''}" id="fc-header-radar-badge">
              <span class="dot"></span>
              ${radar.connected ? 'Radar: USB ✓' : (this.snap?.ha?.connected ? 'Radar: HAOS ✓' : 'Radar: Brak połączenia')}
            </span>

            <button class="fc-diag-btn ${this.diagActive ? 'active' : ''}" id="fc-header-diag-btn"
              title="${this.diagActive ? 'Sesja diagnostyczna trwa — kliknij po powrocie, aby zobaczyć logi' : 'Wychodzisz z pokoju? Kliknij — aplikacja nagra logi do diagnozy wykrywania nieobecności'}">
              ${this.diagActive ? '⏹ Zakończ test' : '🧪 Wyjście z pokoju'}
            </button>

            <button class="fc-mute-btn ${this.isMuted ? 'muted' : ''}" id="fc-header-mute-btn" title="Wycisz/Odcisz mikrofon (Skrót: Ctrl+Shift+M)">
              ${this.isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny'}
            </button>

            <button class="fc-icon-btn ${this.refreshingPorts ? 'spin' : ''}" id="fc-btn-refresh-all" title="Odśwież urządzenia audio i porty COM">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>

            <!-- Window Control Buttons -->
            <div class="fc-win-btns">
              <button id="fc-win-min" title="Minimalizuj okno">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <button id="fc-win-max" title="${this.isMaximized ? 'Przywróć okno' : 'Maksymalizuj okno'}">
                ${this.isMaximized
                  ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="12" height="12" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/></svg>`
                  : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`}
              </button>
              <button class="close" id="fc-win-close" title="Schowaj do paska zasobnika (Tray)">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
              </button>
            </div>
          </div>
        </header>

        <!-- BODY WITH LEFT SIDEBAR (Fan Control Navigation Rail) -->
        <div class="fc-body">
          <nav class="fc-sidebar" role="tablist" aria-label="Główne menu nawigacji">
            <button class="fc-nav-item ${this.currentTab === 'home' ? 'active' : ''}" data-tab="home" role="tab" aria-selected="${this.currentTab === 'home'}" title="Główny Pulpit (Wszystkie ustawienia)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              <span>Pulpit</span>
            </button>

            <button class="fc-nav-item ${this.currentTab === 'settings' ? 'active' : ''}" data-tab="settings" role="tab" aria-selected="${this.currentTab === 'settings'}" title="Ustawienia: port COM, czasy reakcji, filtr zwierząt i integracje">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span>Ustawienia</span>
            </button>

            <button class="fc-nav-item ${this.currentTab === 'logs' ? 'active' : ''}" data-tab="logs" role="tab" aria-selected="${this.currentTab === 'logs'}" title="Logi & Narzędzia USB">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              <span>Logi</span>
            </button>

            <button class="fc-nav-item ${this.currentTab === 'about' ? 'active' : ''}" data-tab="about" role="tab" aria-selected="${this.currentTab === 'about'}" title="Diagnostyka & Aktualizacje">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <span>Info</span>
            </button>
          </nav>

          <main class="fc-content">
            ${isUnconfigured ? `
              <div class="update-banner" style="border-color: rgba(245, 158, 11, 0.6); background: rgba(245, 158, 11, 0.12)">
                <div class="update-banner-icon" style="background: #f59e0b">⚠️</div>
                <div class="update-banner-content">
                  <strong style="color: #fbbf24">Wybierz swoje mikrofony</strong>
                  <p>Wskaż mikrofon stacjonarny i mobilny w kasetkach poniżej lub użyj <strong>Auto-wykrywania</strong>.</p>
                </div>
              </div>` : ''}

            ${this.currentTab === 'home' ? this.renderHomeTab() : ''}
            ${this.currentTab === 'settings' ? this.renderSettingsTab() : ''}
            ${this.currentTab === 'logs' ? this.renderLogsTab() : ''}
            ${this.currentTab === 'about' ? this.renderAboutTab() : ''}
          </main>
        </div>

        <!-- BOTTOM STATUS BAR (Auto-Save Indicator & Profile Export) -->
        <footer class="fc-bottom-bar">
          <button class="btn btn-ghost btn-sm" id="fc-btn-reset-defaults" title="Przywróć domyślne ustawienia">↺ Domyślne</button>
          <button class="btn btn-primary btn-sm" id="fc-btn-save" ${this.saving || !this.dirty ? 'disabled' : ''} title="Ręczny zapis (Ctrl+S)">
            ${this.saving ? 'Zapisywanie…' : 'Zapisz teraz'}
          </button>
          <span class="fc-save-state ${this.saveState.kind}" id="fc-save-state-text">${this.saveState.text}</span>
          <div style="flex: 1"></div>
          <button class="text-btn" id="fc-btn-copy-profile" title="Skopiuj profil do schowka (JSON)">📋 Kopiuj JSON</button>
          <button class="text-btn" id="fc-btn-open-conf-dir">📁 Folder konfiguracji</button>
        </footer>

        <!-- MODALS -->
        ${this.wizardOpen ? this.renderWizardModal() : ''}
        ${this.vadModalOpen ? this.renderVadModal() : ''}
        ${this.diagModalOpen ? this.renderDiagModal() : ''}
        ${this.diagReportModalOpen ? this.renderDiagSessionModal() : ''}

        <!-- TOASTS CONTAINER (with A11y role) -->
        <div class="toasts" role="status" aria-live="polite"></div>
      </div>
    `;

    const newContentEl = this.root.querySelector('.fc-content') as HTMLElement | null;
    if (newContentEl && scrollPos > 0) {
      newContentEl.scrollTop = scrollPos;
    }

    this.bindEvents();
    this.renderToasts();
  }

  private isMicActive(target: 'desk' | 'headset'): boolean {
    if (!this.snap || !this.form) return target === 'desk';
    if (this.snap.state === target) return true;
    if (!this.snap.state) {
      const defaultMic = this.audioDevices.find((d) => d.isDefault)?.name;
      const configuredName = target === 'desk' ? this.form.micDeskName : this.form.micHeadsetName;
      if (
        defaultMic &&
        configuredName &&
        (defaultMic.toLowerCase().includes(configuredName.toLowerCase()) ||
          configuredName.toLowerCase().includes(defaultMic.toLowerCase()))
      ) {
        return true;
      }
      return target === 'desk';
    }
    return false;
  }

  // ---------- COMPLETE ALL-IN-ONE HOME DASHBOARD ----------
  private renderHomeTab(): string {
    if (!this.snap || !this.form) return '';
    const form = this.form;
    const snap = this.snap;

    const isDeskActive = this.isMicActive('desk');
    const isHeadsetActive = this.isMicActive('headset');

    // Dynamic gate geometry
    const minGate = form.radarMinDistanceCm ?? 40;
    const maxGate = form.radarMaxDistanceCm ?? 110;
    const curDist = this.telemetry.distanceCm;
    const isInside = curDist ? (curDist >= minGate && curDist <= maxGate) : false;

    // VAD values (zgodne z zakresem Discorda: -100 dB do 0 dB)
    const deskGateVal = Math.max(-100, Math.min(0, form.micDeskGateDb ?? -45));
    const deskGatePct = Math.max(0, Math.min(100, ((deskGateVal + 100) / 100) * 100));

    const headGateVal = Math.max(-100, Math.min(0, form.micHeadsetGateDb ?? -45));
    const headGatePct = Math.max(0, Math.min(100, ((headGateVal + 100) / 100) * 100));

    return `
      <div class="fc-tab-pane">

        <!-- ==================== SEKCJA 1: KONTROLA MIKROFONÓW & FILTRY DSP ==================== -->
        <section class="fc-section">
          <div class="fc-section-header">
            <div class="fc-section-title-wrap">
              <span class="fc-section-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fc-accent-blue)" stroke-width="2.2"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>
                Kontrola Mikrofonów, Live VU-Meter & Filtry DSP
              </span>
              <span class="fc-info-badge" title="Pełne sterowanie mikrofonem stacjonarnym i mobilnym, poziom wejściowy w 60 FPS oraz filtry Krisp/AGC">?</span>
            </div>
            <div class="fc-section-actions">
              <button class="btn btn-ghost btn-sm" id="btn-home-detect-mics" style="font-size: 11px; padding: 4px 9px">🔍 Auto-wykryj mikrofony</button>
            </div>
          </div>

          <div class="fc-card-grid">
            <!-- Card 1: Mikrofon Biurkowy (Stacjonarny) -->
            <div class="fc-card ${isDeskActive ? 'highlight active-mic' : ''}" id="card-mic-desk">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon green">🎙️</span>
                  <span class="fc-card-title">Mikrofon Biurkowy (Stacjonarny)</span>
                </div>
                <button class="fc-card-more" id="card-btn-test-desk" title="Przełącz i przetestuj ten mikrofon">▶ Aktywuj</button>
              </div>

              <div class="fc-card-body">
                <select class="fc-select ${isDeskActive ? 'active-source' : ''}" id="sel-mic-desk">
                  <option value="" ${!form.micDeskName ? 'selected' : ''}>— Wybierz mikrofon Windows —</option>
                  ${this.missingDeviceOption(form.micDeskName, this.audioDevices)}
                  ${this.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micDeskName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                </select>

                <!-- LIVE VU-METER BAR (DESK) WITH VAD GATE MARKER -->
                <div class="fc-vu-meter-box" id="vu-box-desk">
                  <div class="fc-vu-header">
                    <span class="fc-vu-title"><span style="color: #10b981">●</span> Live VU & Próg VAD:</span>
                    <div class="fc-vu-header-right">
                      <span id="vad-badge-desk" class="fc-vad-status-badge closed">🔇 Szum odcięty</span>
                      <span class="fc-vu-db-text" id="vu-db-desk">-100.0 dB</span>
                    </div>
                  </div>
                  <div class="fc-vu-track">
                    <div class="fc-vu-bar" id="vu-bar-desk"></div>
                    <div class="fc-vu-peak" id="vu-peak-desk"></div>
                    <div class="fc-vu-gate-marker" id="vu-gate-desk" style="left: ${deskGatePct}%" title="Próg bramki Discord: ${deskGateVal} dB"></div>
                  </div>
                  <div class="fc-vu-scale">
                    <span>-100</span>
                    <span>-75</span>
                    <span>-50</span>
                    <span>-25</span>
                    <span>0 dB</span>
                  </div>
                </div>

                <!-- Per-Microphone Voice Filters & Auto-VAD Helper -->
                <div class="fc-mic-extras">
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <div class="fc-micro-label">
                      <span>🎮 Próg Discord:</span>
                      <strong style="color: #fbbf24" id="val-gate-desk">${deskGateVal} dB</strong>
                    </div>
                    <div style="display: flex; gap: 4px">
                      <button class="fc-preset-pill" id="btn-vad-sync-desk" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); padding: 2px 7px" title="Pobierz aktualny próg z Discorda">⬇️ Z Discorda</button>
                      <button class="fc-preset-pill" id="btn-vad-calibrate-desk" style="color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); padding: 2px 7px" title="Automatycznie zmierz szum pokoju i Twój głos">🎯 Auto-Dopasuj</button>
                    </div>
                  </div>
                  <input type="range" class="fc-slider" id="rng-gate-desk" min="-100" max="0" step="1" value="${deskGateVal}" />

                  <!-- Quick VAD Presets -->
                  <div style="display: flex; gap: 4px; margin-top: 3px">
                    <button class="fc-preset-pill" id="preset-vad-desk-quiet" style="font-size: 9.5px; padding: 2px 5px">🤫 -55 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-desk-std" style="font-size: 9.5px; padding: 2px 5px">⚖️ -45 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-desk-noisy" style="font-size: 9.5px; padding: 2px 5px">⌨️ -35 dB</button>
                  </div>

                  <!-- Complete DSP Filters -->
                  <div class="fc-subgrid-3" style="margin-top: 4px">
                    <div>
                      <label class="fc-micro-label" style="font-size: 9px">Krisp AI:</label>
                      <select class="fc-select fc-select-sm" id="settings-krisp-desk">
                        <option value="default" ${(form.micDeskKrisp || 'default') === 'default' ? 'selected' : ''}>Domyślny</option>
                        <option value="on" ${form.micDeskKrisp === 'on' ? 'selected' : ''}>ON ✓</option>
                        <option value="off" ${form.micDeskKrisp === 'off' ? 'selected' : ''}>OFF</option>
                      </select>
                    </div>
                    <div>
                      <label class="fc-micro-label" style="font-size: 9px">AGC Wzmocnienie:</label>
                      <select class="fc-select fc-select-sm" id="settings-agc-desk">
                        <option value="default" ${(form.micDeskAgc || 'default') === 'default' ? 'selected' : ''}>Domyślny</option>
                        <option value="on" ${form.micDeskAgc === 'on' ? 'selected' : ''}>ON</option>
                        <option value="off" ${form.micDeskAgc === 'off' ? 'selected' : ''}>OFF</option>
                      </select>
                    </div>
                    <div>
                      <label class="fc-micro-label" style="font-size: 9px">Echo Cancel:</label>
                      <select class="fc-select fc-select-sm" id="settings-echo-desk">
                        <option value="default" ${(form.micDeskEcho || 'default') === 'default' ? 'selected' : ''}>Domyślny</option>
                        <option value="on" ${form.micDeskEcho === 'on' ? 'selected' : ''}>ON</option>
                        <option value="off" ${form.micDeskEcho === 'off' ? 'selected' : ''}>OFF</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${form.micDeskVolume ?? 100} %</div>
                  <div class="fc-metric-sub">Głośność profilu (aplikowana przy przełączeniu)</div>
                </div>
                <span class="fc-badge ${isDeskActive ? 'calibrated' : 'muted'}" id="badge-mic-desk">${isDeskActive ? 'Domyślny ✓' : 'Gotowy'}</span>
              </div>
            </div>

            <!-- Card 2: Mikrofon Mobilny (Słuchawki / Headset) -->
            <div class="fc-card ${isHeadsetActive ? 'highlight active-mic' : ''}" id="card-mic-headset">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon blue">🎧</span>
                  <span class="fc-card-title">Mikrofon Mobilny (Słuchawki)</span>
                </div>
                <button class="fc-card-more" id="card-btn-test-headset" title="Przełącz i przetestuj ten mikrofon">▶ Aktywuj</button>
              </div>

              <div class="fc-card-body">
                <select class="fc-select ${isHeadsetActive ? 'active-source' : ''}" id="sel-mic-headset">
                  <option value="" ${!form.micHeadsetName ? 'selected' : ''}>— Wybierz mikrofon Windows —</option>
                  ${this.missingDeviceOption(form.micHeadsetName, this.audioDevices)}
                  ${this.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micHeadsetName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                </select>

                <!-- LIVE VU-METER BAR (HEADSET) WITH VAD GATE MARKER -->
                <div class="fc-vu-meter-box" id="vu-box-headset">
                  <div class="fc-vu-header">
                    <span class="fc-vu-title"><span style="color: #38bdf8">●</span> Live VU & Próg VAD:</span>
                    <div class="fc-vu-header-right">
                      <span id="vad-badge-headset" class="fc-vad-status-badge closed">🔇 Szum odcięty</span>
                      <span class="fc-vu-db-text" id="vu-db-headset">-100.0 dB</span>
                    </div>
                  </div>
                  <div class="fc-vu-track">
                    <div class="fc-vu-bar" id="vu-bar-headset"></div>
                    <div class="fc-vu-peak" id="vu-peak-headset"></div>
                    <div class="fc-vu-gate-marker" id="vu-gate-headset" style="left: ${headGatePct}%" title="Próg bramki Discord: ${headGateVal} dB"></div>
                  </div>
                  <div class="fc-vu-scale">
                    <span>-100</span>
                    <span>-75</span>
                    <span>-50</span>
                    <span>-25</span>
                    <span>0 dB</span>
                  </div>
                </div>

                <!-- Per-Microphone Voice Filters & Auto-VAD Helper -->
                <div class="fc-mic-extras">
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <div class="fc-micro-label">
                      <span>🎮 Próg Discord:</span>
                      <strong style="color: #fbbf24" id="val-gate-headset">${headGateVal} dB</strong>
                    </div>
                    <div style="display: flex; gap: 4px">
                      <button class="fc-preset-pill" id="btn-vad-sync-headset" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); padding: 2px 7px" title="Pobierz aktualny próg z Discorda">⬇️ Z Discorda</button>
                      <button class="fc-preset-pill" id="btn-vad-calibrate-headset" style="color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); padding: 2px 7px" title="Automatycznie zmierz szum i Twój głos">🎯 Auto-Dopasuj</button>
                    </div>
                  </div>
                  <input type="range" class="fc-slider" id="rng-gate-headset" min="-100" max="0" step="1" value="${headGateVal}" />

                  <!-- Quick VAD Presets -->
                  <div style="display: flex; gap: 4px; margin-top: 3px">
                    <button class="fc-preset-pill" id="preset-vad-headset-quiet" style="font-size: 9.5px; padding: 2px 5px">🤫 -55 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-headset-std" style="font-size: 9.5px; padding: 2px 5px">⚖️ -45 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-headset-noisy" style="font-size: 9.5px; padding: 2px 5px">⌨️ -35 dB</button>
                  </div>

                  <!-- Complete DSP Filters -->
                  <div class="fc-subgrid-3" style="margin-top: 4px">
                    <div>
                      <label class="fc-micro-label" style="font-size: 9px">Krisp AI:</label>
                      <select class="fc-select fc-select-sm" id="settings-krisp-headset">
                        <option value="default" ${(form.micHeadsetKrisp || 'default') === 'default' ? 'selected' : ''}>Domyślny</option>
                        <option value="on" ${form.micHeadsetKrisp === 'on' ? 'selected' : ''}>ON ✓</option>
                        <option value="off" ${form.micHeadsetKrisp === 'off' ? 'selected' : ''}>OFF</option>
                      </select>
                    </div>
                    <div>
                      <label class="fc-micro-label" style="font-size: 9px">AGC Wzmocnienie:</label>
                      <select class="fc-select fc-select-sm" id="settings-agc-headset">
                        <option value="default" ${(form.micHeadsetAgc || 'default') === 'default' ? 'selected' : ''}>Domyślny</option>
                        <option value="on" ${form.micHeadsetAgc === 'on' ? 'selected' : ''}>ON</option>
                        <option value="off" ${form.micHeadsetAgc === 'off' ? 'selected' : ''}>OFF</option>
                      </select>
                    </div>
                    <div>
                      <label class="fc-micro-label" style="font-size: 9px">Echo Cancel:</label>
                      <select class="fc-select fc-select-sm" id="settings-echo-headset">
                        <option value="default" ${(form.micHeadsetEcho || 'default') === 'default' ? 'selected' : ''}>Domyślny</option>
                        <option value="on" ${form.micHeadsetEcho === 'on' ? 'selected' : ''}>ON</option>
                        <option value="off" ${form.micHeadsetEcho === 'off' ? 'selected' : ''}>OFF</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${form.micHeadsetVolume ?? 100} %</div>
                  <div class="fc-metric-sub">Głośność profilu (aplikowana przy przełączeniu)</div>
                </div>
                <span class="fc-badge ${isHeadsetActive ? 'calibrated' : 'muted'}" id="badge-mic-headset">${isHeadsetActive ? 'Domyślny ✓' : 'Rezerwa'}</span>
              </div>
            </div>

            <!-- Card 3: Tryb Pracy & Reguły Automatyki -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon amber">🎚️</span>
                  <span class="fc-card-title">Tryb & Reguły Przełączania</span>
                </div>
                <button class="fc-switch ${!this.isMuted ? 'active' : ''}" id="card-sw-mute" aria-checked="${!this.isMuted}" role="switch" title="Wycisz/Odcisz"></button>
              </div>

              <div class="fc-card-body">
                <div class="fc-segmented" role="radiogroup" aria-label="Wybór trybu pracy">
                  <button class="${snap.mode === 'auto' ? 'active' : ''}" data-mode="auto" role="radio" aria-checked="${snap.mode === 'auto'}">Auto</button>
                  <button class="${snap.mode === 'desk' ? 'active' : ''}" data-mode="desk" role="radio" aria-checked="${snap.mode === 'desk'}">Stacjonarny</button>
                  <button class="${snap.mode === 'headset' ? 'active' : ''}" data-mode="headset" role="radio" aria-checked="${snap.mode === 'headset'}">Mobilny</button>
                </div>

                <!-- Snooze Dropdown -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Pauza automatyki:</span>
                  <select class="fc-select fc-select-sm" id="sel-quick-snooze" style="width: 140px">
                    <option value="0" ${!this.snoozeUntil ? 'selected' : ''}>Brak (Aktywna)</option>
                    <option value="15" ${this.snoozeUntil ? 'selected' : ''}>Pauza 15 min</option>
                    <option value="30">Pauza 30 min</option>
                    <option value="60">Pauza 1 godzina</option>
                  </select>
                </div>

                <!-- Complete Switching Rules -->
                <div class="fc-mic-extras" style="margin-top: 4px; gap: 5px">
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <span style="font-size: 10.5px; color: var(--fc-text-secondary)">Przełącz na stacjonarny po powrocie:</span>
                    <button class="fc-switch ${form.switchMicOnDesk !== false ? 'active' : ''}" id="sw-switch-desk" aria-checked="${form.switchMicOnDesk !== false}" role="switch"></button>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <span style="font-size: 10.5px; color: var(--fc-text-secondary)">Przełącz na mobilny po odejściu:</span>
                    <button class="fc-switch ${form.switchMicOnAway !== false ? 'active' : ''}" id="sw-switch-away" aria-checked="${form.switchMicOnAway !== false}" role="switch"></button>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <span style="font-size: 10.5px; color: var(--fc-text-secondary)">Automatycznie odciszaj po powrocie:</span>
                    <button class="fc-switch ${form.unmuteOnDesk !== false ? 'active' : ''}" id="sw-unmute-desk" aria-checked="${form.unmuteOnDesk !== false}" role="switch"></button>
                  </div>
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <span style="font-size: 10.5px; color: var(--fc-text-secondary)">Wyciszanie po odejściu:</span>
                    <select class="fc-select fc-select-sm" id="sel-mute-behavior" style="width: 140px">
                      <option value="none" ${(form.muteBehaviorOnAway || 'none') === 'none' ? 'selected' : ''}>Brak wyciszania</option>
                      <option value="mute_stationary" ${form.muteBehaviorOnAway === 'mute_stationary' ? 'selected' : ''}>Wycisz stacjonarny</option>
                      <option value="mute_all" ${form.muteBehaviorOnAway === 'mute_all' ? 'selected' : ''}>Wycisz wszystkie</option>
                    </select>
                  </div>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${snap.state ? STATE_LABEL[snap.state].split(' ')[0] : '—'}</div>
                  <div class="fc-metric-sub">${snap.state ? STATE_LABEL[snap.state] : 'Oczekiwanie'}</div>
                </div>
                <span class="fc-badge ${this.isMuted ? 'amber' : 'success'}" id="card-badge-mute">${this.isMuted ? 'Wyciszony 🔇' : 'Aktywny 🎙️'}</span>
              </div>
            </div>
          </div>
        </section>


        <!-- ==================== SEKCJA 2: RADAR MMWAVE 60 GHZ & KORYTARZ ZASIĘGU NA ŻYWO ==================== -->
        <section class="fc-section">
          <div class="fc-section-header">
            <div class="fc-section-title-wrap">
              <span class="fc-section-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fc-accent-green)" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="M12 2v6"/><path d="M12 18v4"/><path d="M4.93 19.07l4.24-4.24"/></svg>
                Radar mmWave 60 GHz & Wizualny Korytarz Zasięgu
              </span>
              <span class="fc-info-badge" title="Wizualizacja strefy fotela na żywo — przeciągnij uchwyty, aby zmienić granice; pozostałe ustawienia radaru znajdziesz w zakładce Ustawienia">?</span>
            </div>
            <div class="fc-section-actions">
              <button class="btn btn-ghost btn-sm" id="btn-home-open-wizard" style="font-size: 11px; padding: 4px 9px">✨ Kreator Kalibracji</button>
            </div>
          </div>

          <!-- FULL INTERACTIVE RADAR SCOPE CORRIDOR (0-200 CM) ON HOME DASHBOARD -->
          <div class="fc-radar-scope-box">
            <div class="fc-scope-header">
              <div>
                <strong style="font-size: 13px; color: #fff; display: flex; align-items: center; gap: 6px">
                  <span>📡</span> Korytarz Zasięgu Radaru na Żywo (0–200 cm)
                </strong>
                <div style="font-size: 11px; margin-top: 2px" id="scope-live-status-text">
                  ${curDist && curDist > 0 ? (
                    isInside
                      ? `<strong style="color: var(--fc-accent-green)">● Obecność: ${curDist} cm</strong> <span style="color: var(--fc-text-secondary)">(W aktywnej strefie fotela ✓)</span>`
                      : `<strong style="color: #f59e0b">⚠️ Wykryto poza strefą: ${curDist} cm</strong> <span style="color: var(--fc-text-muted)">(Ignorowane tło)</span>`
                  ) : `<span style="color: var(--fc-text-muted)">Brak wykrycia człowieka w kadrze radaru</span>`}
                </div>
              </div>
              <span class="fc-badge ${form.radarDistanceGateEnabled !== false ? 'calibrated' : 'muted'}">
                ${form.radarDistanceGateEnabled !== false ? 'Bramka Dystansu Aktywna ✓' : 'Bramka Wyłączona'}
              </span>
            </div>

            <div class="fc-scope-track-container">
              <div class="fc-scope-track">
                <div class="fc-scope-grid-lines"></div>
                <div class="fc-scope-dead-zone" id="scope-dead-zone" style="width: ${(minGate / 200) * 100}%">
                  <span>Martwa strefa</span>
                </div>
                <div class="fc-scope-active-zone" id="scope-active-zone" style="left: ${(minGate / 200) * 100}%; width: ${((maxGate - minGate) / 200) * 100}%">
                  <span>STREFA FOTELA (${minGate}–${maxGate} cm)</span>
                </div>
                <div class="fc-scope-cutoff-zone" id="scope-cutoff-zone" style="left: ${(maxGate / 200) * 100}%; width: ${Math.max(0, 100 - (maxGate / 200) * 100)}%">
                  <span>Ignorowane tło</span>
                </div>
                <div class="fc-scope-handle min" id="scope-handle-min" style="left: ${(minGate / 200) * 100}%" title="Przeciągnij, aby ustawić początek strefy fotela"></div>
                <div class="fc-scope-handle max" id="scope-handle-max" style="left: ${(maxGate / 200) * 100}%" title="Przeciągnij, aby ustawić koniec strefy fotela"></div>
              </div>

              <div class="fc-scope-user-pin" id="scope-user-pin" style="left: ${curDist ? (curDist / 200) * 100 : 0}%; display: ${curDist && curDist > 0 ? 'flex' : 'none'}">
                <div class="fc-scope-user-badge ${isInside ? '' : 'outside'}" id="scope-user-badge">
                  ${isInside ? `● Ty: ${curDist} cm ✓` : `⚠️ ${curDist} cm (Poza strefą)`}
                </div>
                <div class="fc-scope-user-line ${isInside ? '' : 'outside'}" id="scope-user-line"></div>
              </div>

              <div class="fc-scope-ticks">
                <span>0 cm (Sensor)</span>
                <span>50 cm</span>
                <span>100 cm</span>
                <span>150 cm</span>
                <span>200 cm (Maks)</span>
              </div>
            </div>

            <!-- Interaktywna regulacja strefy fotela (drag handles) -->
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--fc-card-border); padding-top: 8px; margin-top: 4px">
              <span style="font-size: 11px; color: var(--fc-text-secondary)">Przeciągnij uchwyty na grafice, aby dopasować strefę fotela (zakres: ${minGate}–${maxGate} cm)</span>
              <button class="btn btn-ghost btn-sm" id="btn-scope-reset-gate" style="font-size: 10.5px; padding: 3px 8px" title="Przywróć domyślną strefę fotela 40–110 cm">↺ Reset (40–110 cm)</button>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  // ---------- SETTINGS TAB (LEWY PANEL USTAWIEŃ) ----------
  private renderSettingsTab(): string {
    const tabs: { id: SettingsTab; icon: string; label: string }[] = [
      { id: 'port', icon: '🔌', label: 'Port USB COM' },
      { id: 'timeouts', icon: '⏱️', label: 'Czasy Reakcji' },
      { id: 'biometrics', icon: '🐾', label: 'Zwierzęta & Tuning' },
      { id: 'discord', icon: '🎮', label: 'Discord Voice RPC' },
      { id: 'signalrgb', icon: '🌈', label: 'SignalRGB' },
      { id: 'chime', icon: '🔔', label: 'Dźwięki & Ekrany' },
      { id: 'haos', icon: '🏠', label: 'Home Assistant' }
    ];

    return `
      <div class="fc-tab-pane">
        <div class="fc-settings-layout">
          <nav class="fc-settings-nav" role="tablist" aria-label="Kategorie ustawień">
            ${tabs.map((t) => `
              <button class="fc-settings-nav-btn ${this.settingsTab === t.id ? 'active' : ''}" data-settings-tab="${t.id}" role="tab" aria-selected="${this.settingsTab === t.id}" title="${t.label}">
                <span class="fc-settings-nav-icon">${t.icon}</span> ${t.label}
              </button>`).join('')}
          </nav>
          <div class="fc-settings-content">
            ${this.renderSettingsPanel()}
          </div>
        </div>
      </div>
    `;
  }

  private renderSettingsPanel(): string {
    switch (this.settingsTab) {
      case 'port': return this.renderPortPanel();
      case 'timeouts': return this.renderTimeoutsPanel();
      case 'biometrics': return this.renderBiometricsPanel();
      case 'discord': return this.renderDiscordPanel();
      case 'signalrgb': return this.renderSignalrgbPanel();
      case 'chime': return this.renderChimePanel();
      case 'haos': return this.renderHaosPanel();
      default: return '';
    }
  }

  private renderPortPanel(): string {
    const form = this.form!;
    const snap = this.snap!;
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🔌 Port USB COM & Czułość Wiązki</div>
          <div>
            <label class="fc-micro-label">Port szeregowy radaru (XIAO ESP32-C6):</label>
            <select class="fc-select" id="sel-port" style="width: 100%; margin-top: 4px">
              <option value="auto" ${form.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie XIAO ESP32-C6)</option>
              ${this.ports.map((p) => `<option value="${esc(p.path)}" ${p.path === form.port ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`).join('')}
            </select>
          </div>
          <div class="fc-field-row">
            <button class="btn btn-ghost btn-sm" id="fc-btn-refresh-ports">🔄 Odśwież porty</button>
            <span class="fc-badge ${snap.radar.connected ? 'calibrated' : (snap.ha?.connected ? 'calibrated' : 'muted')}">${snap.radar.connected ? 'USB Serial ✓' : (snap.ha?.connected ? 'HAOS Stream ✓' : 'Brak COM')}</span>
          </div>
        </div>
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">💡 Dioda Statusowa Sensora (WS2812 RGB)</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Włącz diodę na obudowie sensora</div>
              <div class="fc-field-desc">Sygnalizuje status: zielony (przy biurku), bursztynowy (poza), czerwony (mute)</div>
            </div>
            <button class="fc-switch ${form.sensorLedEnabled !== false ? 'active' : ''}" id="sw-sensor-led" aria-checked="${form.sensorLedEnabled !== false}" role="switch"></button>
          </div>
          <div>
            <label class="fc-micro-label">Jasność diody (tryb nocny / stealth):</label>
            <div class="fc-slider-row">
              <input type="range" class="fc-slider" id="rng-sensor-led-bri" min="0" max="100" step="5" value="${form.sensorLedBrightness ?? 25}" />
              <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-sensor-led-bri">${form.sensorLedBrightness ?? 25}%</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor — Stacjonarny (przy biurku)</div>
              <div class="fc-field-desc">Świeci, gdy jesteś przy biurku</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-led-desk" value="${esc(form.sensorLedDeskColor || '#22c55e')}" title="Kolor diody w trybie Stacjonarnym" />
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor — Słuchawki (poza biurkiem)</div>
              <div class="fc-field-desc">Świeci, gdy mikrofon mobilny jest aktywny</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-led-away" value="${esc(form.sensorLedAwayColor || '#f59e0b')}" title="Kolor diody w trybie Słuchawki" />
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor — Mikrofon wyciszony</div>
              <div class="fc-field-desc">Nakładka koloru przy wyciszeniu (Ctrl+Shift+M)</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-led-mute" value="${esc(form.sensorLedMuteColor || '#ef4444')}" title="Kolor diody przy wyciszonym mikrofonie" />
          </div>
        </div>

        <div class="fc-settings-group">
          <div class="fc-settings-group-title">📡 Telemetria na żywo & Urządzenie</div>
          <div class="fc-diag-grid">
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>📏 Dystans klatki piersiowej</span></div>
              <div class="fc-diag-item-val" id="card-val-distance">${this.telemetry.distanceCm ? `${this.telemetry.distanceCm} cm` : '—'}</div>
            </div>
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>💡 Światło otoczenia</span></div>
              <div class="fc-diag-item-val" id="card-val-lux">${typeof this.telemetry.illuminanceLux === 'number' ? `${this.telemetry.illuminanceLux} lx` : '—'}</div>
            </div>
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>🌡️ ESP32 / Firmware</span></div>
              <div class="fc-diag-item-val">${[this.telemetry.deviceInfo?.chipTempC ? `${this.telemetry.deviceInfo.chipTempC.toFixed(1)}°C` : '', this.telemetry.deviceInfo?.fwVersion ? `v${this.telemetry.deviceInfo.fwVersion}` : ''].filter(Boolean).join(' · ') || (snap.radar.connected ? '— (FW nie raportuje wersji)' : '—')}</div>
            </div>
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>⏱️ Czas pracy sensora (Uptime)</span></div>
              <div class="fc-diag-item-val">${typeof this.telemetry.deviceInfo?.uptimeSec === 'number' ? `${this.telemetry.deviceInfo.uptimeSec}s` : '—'}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderTimeoutsPanel(): string {
    const form = this.form!;
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">⏱️ Czasy Reakcji (Timeouts)</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Opóźnienie odejścia (Away)</div>
              <div class="fc-field-desc">Jak szybko po wyjściu z fotela przełączyć na mikrofon mobilny</div>
            </div>
            <div style="display: flex; gap: 4px; align-items: center">
              <input type="number" class="fc-input" id="inp-timeout-away" value="${form.timeoutAwayMs ?? 3000}" style="width: 90px" min="200" max="60000" step="100" />
              <span style="font-size: 11px; color: var(--fc-text-muted)">ms</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Opóźnienie powrotu (Desk)</div>
              <div class="fc-field-desc">Jak szybko po powrocie przełączyć na mikrofon stacjonarny</div>
            </div>
            <div style="display: flex; gap: 4px; align-items: center">
              <input type="number" class="fc-input" id="inp-timeout-desk" value="${form.timeoutDeskMs ?? 800}" style="width: 90px" min="100" max="10000" step="100" />
              <span style="font-size: 11px; color: var(--fc-text-muted)">ms</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">⌨️ Aktywność klawiatury i myszy</div>
              <div class="fc-field-desc">Zapobiega fałszywemu wygaszaniu obecności podczas pisania i klikania</div>
            </div>
            <button class="fc-switch ${form.userInputPresenceEnabled !== false ? 'active' : ''}" id="sw-user-input-presence" aria-checked="${form.userInputPresenceEnabled !== false}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Filtr szumów & DSP</div>
              <div class="fc-field-desc">Stabilizacja odczytów radaru (filtr medianowy + EMA)</div>
            </div>
            <select class="fc-select fc-select-sm" id="sel-radar-smoothing" style="width: 180px">
              <option value="ultra" ${(form.radarSmoothingMode || 'ultra') === 'ultra' ? 'selected' : ''}>Ultra-Stabilny 🛡️</option>
              <option value="balanced" ${form.radarSmoothingMode === 'balanced' ? 'selected' : ''}>Zbalansowany</option>
              <option value="raw" ${form.radarSmoothingMode === 'raw' ? 'selected' : ''}>Szybki / Surowy</option>
            </select>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">🛡️ Potwierdzanie powrotu (ochrona przed odbiciami)</div>
              <div class="fc-field-desc">Po długiej nieobecności bit obecności musi się ustabilizować, zanim przełączymy mikrofon — krótkie błyski odbić nie przełączają. Aktywność klawiatury/myszy potwierdza natychmiast.</div>
            </div>
            <button class="fc-switch ${form.radarDeepAwayConfirm !== false ? 'active' : ''}" id="sw-deep-away" aria-checked="${form.radarDeepAwayConfirm !== false}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Próg "długiej nieobecności"</span>
            <div style="display: flex; gap: 4px; align-items: center">
              <input type="number" class="fc-input" id="inp-deep-away-min" value="${Math.round((form.radarDeepAwayMinMs ?? 600000) / 60000)}" style="width: 70px" min="1" max="240" step="1" />
              <span style="font-size: 11px; color: var(--fc-text-muted)">min</span>
            </div>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Czas stabilizacji obecności</span>
            <div style="display: flex; gap: 4px; align-items: center">
              <input type="number" class="fc-input" id="inp-deep-away-confirm" value="${Math.round((form.radarDeepAwayConfirmMs ?? 3000) / 1000)}" style="width: 70px" min="1" max="30" step="1" />
              <span style="font-size: 11px; color: var(--fc-text-muted)">s</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">🔬 Pomiar sensora (kalibracja progów)</div>
              <div class="fc-field-desc">Nagrywa 5 minut surowego strumienia (dystans / tętno / oddech / obecność) i liczy statystyki do strojenia progu fuzji. Klik ponownie = wcześniejszy stop.</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="btn-diag-record">Start</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderBiometricsPanel(): string {
    const form = this.form!;
    const person = this.telemetry.detectedPerson || 'unknown';
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🐾 Filtr Zwierząt</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">🐾 Filtr psa / kota (tętno &gt;125 BPM)</div>
              <div class="fc-field-desc">Ignoruje zwierzęta na bazie oddechu i tętna</div>
            </div>
            <button class="fc-switch ${form.petFilterEnabled ? 'active' : ''}" id="sw-pet-filter" aria-checked="${form.petFilterEnabled ?? true}" role="switch"></button>
          </div>
          <div style="border-top: 1px solid var(--fc-card-border); padding-top: 10px">
            <div class="fc-diag-grid" style="grid-template-columns: repeat(3, 1fr)">
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🫀 Tętno live</span></div>
                <div class="fc-diag-item-val" id="card-val-heart">${this.telemetry.heartRate ? `${this.telemetry.heartRate} BPM` : '—'}</div>
              </div>
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🫁 Oddech live</span></div>
                <div class="fc-diag-item-val" id="card-val-breath">${this.telemetry.breathRate ? `${this.telemetry.breathRate} RPM` : '—'}</div>
              </div>
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>👤 Wykryta osoba</span></div>
                <span class="fc-badge blue" id="card-badge-person">${person === 'me' ? '👤 Człowiek ✓' : (person === 'pet' ? '🐾 Zwierzę' : '🔍 Skanowanie…')}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="fc-settings-group">
          <div class="fc-settings-group-title">📡 Auto-tuning radaru</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Automatyczna adaptacja fotela</div>
              <div class="fc-field-desc">Uczy się pozycji Twojego fotela i poszerza górną bramkę dystansu, gdy siedzisz dalej niż domyślny limit</div>
            </div>
            <button class="fc-switch ${form.radarAutoTuningEnabled ? 'active' : ''}" id="sw-auto-tuning" aria-checked="${form.radarAutoTuningEnabled ?? true}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Tempo uczenia modelu</span>
            <select class="fc-select fc-select-sm" id="sel-autotune-speed" style="width: 180px">
              <option value="balanced" ${(form.radarAutoTuningSpeed || 'balanced') === 'balanced' ? 'selected' : ''}>Zbalansowany</option>
              <option value="fast" ${form.radarAutoTuningSpeed === 'fast' ? 'selected' : ''}>Szybki (szybka adaptacja)</option>
              <option value="conservative" ${form.radarAutoTuningSpeed === 'conservative' ? 'selected' : ''}>Konserwatywny (wolny, stabilny)</option>
            </select>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Fałszywe echa w nieobecności</span>
            <strong id="card-val-autotune-noise" style="color: var(--fc-accent-green)">${this.autoTuneNoiseLabel(this.telemetry.autoTuning?.noiseFloor ?? 0)}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Wyuczony środek fotela</span>
            <strong style="color: #fff" id="card-val-autotune-dist">${this.telemetry.autoTuning?.adaptedDistanceCenter ? this.telemetry.autoTuning.adaptedDistanceCenter + ' cm' : '—'}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Wyuczona biometria (tętno / oddech)</span>
            <strong style="color: #fff" id="card-val-autotune-bio">${this.autoTuneBioLabel()}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Wyuczona strefa (bramka górna)</span>
            <strong style="color: #fff" id="card-val-autotune-zone">${this.autoTuneZoneLabel()}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Stabilność modelu</span>
            <strong style="color: var(--fc-accent-blue)" id="card-badge-autotune-stability">${this.autoTuneStabilityLabel(this.telemetry.autoTuning)}</strong>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-reset-autotune" style="color: #ef4444; align-self: flex-start">↺ Reset wyuczonych parametrów</button>
        </div>
      </div>
    `;
  }

  private renderDiscordPanel(): string {
    const form = this.form!;
    const snap = this.snap!;
    const gateVal = snap.state === 'desk'
      ? Math.max(-100, Math.min(0, form.micDeskGateDb ?? -45))
      : Math.max(-100, Math.min(0, form.micHeadsetGateDb ?? -45));
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🎮 Discord Voice RPC</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Włącz integrację Discord</div>
              <div class="fc-field-desc">RPC + sterowanie profilem głosu (próg VAD, Krisp, AGC, Echo)</div>
            </div>
            <button class="fc-switch ${form.discordIntegration ? 'active' : ''}" id="sw-discord" aria-checked="${form.discordIntegration ?? true}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Śledź aktywny mikrofon</div>
              <div class="fc-field-desc">Automatycznie aplikuje profil głosu przy zmianie mikrofonu</div>
            </div>
            <button class="fc-switch ${form.discordGateFollowMic !== false ? 'active' : ''}" id="sw-discord-follow" aria-checked="${form.discordGateFollowMic !== false}" role="switch"></button>
          </div>
          <div style="display: flex; gap: 6px">
            <button class="btn btn-secondary btn-sm" id="btn-discord-auth" style="flex: 1" title="Wywołaj okno autoryzacji OAuth w aplikacji Discord">🔐 Autoryzuj Discord</button>
            <button class="btn btn-ghost btn-sm" id="btn-discord-sync" style="flex: 1" title="Wyślij bieżący profil głosu i przełącz urządzenie wejściowe w Discordzie">🔄 Synchronizuj profil</button>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Połączenie z Discordem</span>
            <strong id="discord-rpc-status-val" style="color: var(--fc-text-dim)">…</strong>
          </div>
          <div class="fc-field-row" style="border-top: 1px solid var(--fc-card-border); padding-top: 10px">
            <span class="fc-field-label">Aktywny próg Discord</span>
            <strong style="color: #fbbf24">${gateVal} dB</strong>
          </div>
        </div>
      </div>
    `;
  }

  /** Throttle odpytywania stanu RPC — render potrafi się zdarzyć kilkanaście razy na minutę. */
  private lastRpcStatusFetch = 0;

  /** Aktualizuje wiersz "Połączenie z Discordem" w panelu (element istnieje tylko tam). */
  private async refreshDiscordRpcStatus(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRpcStatusFetch < 5000) return;
    this.lastRpcStatusFetch = now;
    const val = document.getElementById('discord-rpc-status-val');
    if (!val) return;
    try {
      const s = await window.api.discordGetStatus();
      const target = document.getElementById('discord-rpc-status-val');
      if (!target) return; // render mógł podmienić DOM w trakcie zapytania
      if (s.ready) {
        target.textContent = s.authenticated
          ? `Połączono${s.user ? ` (@${s.user})` : ''} ✓`
          : 'Połączono (bez autoryzacji OAuth) ⚠';
        target.style.color = s.authenticated ? '#22c55e' : '#fbbf24';
      } else if (s.connected) {
        target.textContent = 'Handshake w toku…';
        target.style.color = '#fbbf24';
      } else {
        target.textContent = 'Brak połączenia — Discord nie uruchomiony ✗';
        target.style.color = '#ef4444';
      }
    } catch {
      const target = document.getElementById('discord-rpc-status-val');
      if (target) {
        target.textContent = 'Brak połączenia ✗';
        target.style.color = '#ef4444';
      }
    }
  }

  private renderSignalrgbPanel(): string {
    const form = this.form!;
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🌈 SignalRGB LED Sync</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Włącz synchronizację oświetlenia</div>
              <div class="fc-field-desc">Lokalne REST API SignalRGB (port ${form.signalrgbPort ?? 16038})</div>
            </div>
            <button class="fc-switch ${form.signalrgbEnabled ? 'active' : ''}" id="sw-signalrgb" aria-checked="${form.signalrgbEnabled ?? false}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Po odejściu od biurka</div>
            </div>
            <select class="fc-select fc-select-sm" id="sel-signalrgb-away-action" style="width: 180px">
              <option value="turn_off" ${(form.signalrgbAwayAction || 'turn_off') === 'turn_off' ? 'selected' : ''}>Zgaś całkowicie LED</option>
              <option value="dim" ${form.signalrgbAwayAction === 'dim' ? 'selected' : ''}>Przyciemnij</option>
              <option value="solid_color" ${form.signalrgbAwayAction === 'solid_color' ? 'selected' : ''}>Kolor ostrzegawczy</option>
            </select>
          </div>
          ${(form.signalrgbAwayAction || 'solid_color') === 'solid_color' ? `
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor ostrzegawczy</div>
              <div class="fc-field-desc">Kolor efektu Solid Color po odejściu</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-signalrgb-away" value="${esc(form.signalrgbAwayColor || '#f59e0b')}" title="Kolor oświetlenia po odejściu" />
          </div>` : ''}
          ${form.signalrgbAwayAction === 'dim' ? `
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Poziom przyciemnienia</div>
            </div>
            <div class="fc-slider-row" style="width: 180px">
              <input type="range" class="fc-slider" id="rng-signalrgb-bri" min="0" max="100" step="5" value="${form.signalrgbAwayBrightness ?? 0}" />
              <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-signalrgb-bri">${form.signalrgbAwayBrightness ?? 0}%</span>
            </div>
          </div>` : ''}
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Przywróć oświetlenie po powrocie</div>
              <div class="fc-field-desc">Odtwarza efekt i jasność zapamiętane sprzed odejścia</div>
            </div>
            <button class="fc-switch ${form.signalrgbRestoreOnDesk !== false ? 'active' : ''}" id="sw-signalrgb-restore" aria-checked="${form.signalrgbRestoreOnDesk !== false}" role="switch"></button>
          </div>
          <div style="display: flex; gap: 6px">
            <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-away" style="flex: 1">Test: Odejście</button>
            <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-desk" style="flex: 1">Test: Biurko</button>
          </div>
        </div>
      </div>
    `;
  }

  /** Wiersz wyboru własnego pliku audio dla profilu (desk / headset). */
  private renderCustomAudioRow(variant: 'desk' | 'headset', label: string, desc: string, filePath: string): string {
    const fileName = filePath ? filePath.split('\\').pop() || filePath : '';
    return `
      <div class="fc-field-row">
        <div style="min-width: 0">
          <div class="fc-field-label">${label}</div>
          <div class="fc-field-desc" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="${esc(filePath)}">
            ${filePath ? `🎵 ${esc(fileName)}` : esc(desc)}
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center">
          <button class="btn btn-ghost btn-sm" id="btn-pick-audio-${variant}" title="Wskaż plik audio z dysku (mp3/wav/ogg)">📁</button>
          <button class="btn btn-ghost btn-sm" id="btn-test-audio-${variant}" title="Odtwórz plik" ${filePath ? '' : 'disabled'}>▶️</button>
          <button class="btn btn-ghost btn-sm" id="btn-clear-audio-${variant}" title="Usuń plik — wróć do syntezowanego chime" ${filePath ? '' : 'disabled'}>✖</button>
        </div>
      </div>
    `;
  }

  private renderChimePanel(): string {
    const form = this.form!;
    const chimeVol = Math.round((form.audioChimeVolume ?? 0.2) * 100);
    const ssDelay = form.screensaverDelayMs ?? 60000;
    const sleepDelay = form.sleepMonitorsDelayMs ?? 600000;
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🔔 Dźwięki Chime & System</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Powiadomienia dźwiękowe (Chime)</div>
              <div class="fc-field-desc">Syntezowany dźwięk przy przełączaniu mikrofonu</div>
            </div>
            <button class="fc-switch ${form.audioChime ? 'active' : ''}" id="sw-audio-chime" aria-checked="${form.audioChime ?? true}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Dźwięk przy powrocie (Stacjonarny)</div>
              <div class="fc-field-desc">Chime przy przejściu na mikrofon biurkowy</div>
            </div>
            <button class="fc-switch ${form.audioChimeOnDesk !== false ? 'active' : ''}" id="sw-chime-desk" aria-checked="${form.audioChimeOnDesk !== false}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Dźwięk przy odejściu (Mobilny)</div>
              <div class="fc-field-desc">Chime przy przejściu na mikrofon mobilny</div>
            </div>
            <button class="fc-switch ${form.audioChimeOnAway !== false ? 'active' : ''}" id="sw-chime-away" aria-checked="${form.audioChimeOnAway !== false}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Styl dźwięku</div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center">
              <select class="fc-select fc-select-sm" id="sel-chime-style" style="width: 170px">
                <option value="harmonic" ${this.selectedChimeStyle === 'harmonic' ? 'selected' : ''}>Harmoniczny dwuton</option>
                <option value="modern" ${this.selectedChimeStyle === 'modern' ? 'selected' : ''}>Modern sci-fi ping</option>
                <option value="soft_click" ${this.selectedChimeStyle === 'soft_click' ? 'selected' : ''}>Miękki klik studyjny</option>
                <option value="marimba" ${this.selectedChimeStyle === 'marimba' ? 'selected' : ''}>Ciepła marimba</option>
              </select>
              <button class="btn btn-ghost btn-sm" id="btn-test-chime" title="Przetestuj dźwięk">🔔</button>
            </div>
          </div>
          ${this.renderCustomAudioRow('desk', 'Własny dźwięk — Stacjonarny', 'Zagra przy przejściu na mikrofon biurkowy', form.audioFileDesk || '')}
          ${this.renderCustomAudioRow('headset', 'Własny dźwięk — Słuchawki', 'Zagra przy przejściu na mikrofon mobilny', form.audioFileHeadset || '')}
          <div class="fc-field-row">
            <span class="fc-field-label">Głośność</span>
            <div class="fc-slider-row" style="flex: 1; max-width: 260px">
              <input type="range" class="fc-slider" id="rng-chime-volume" min="0" max="100" step="5" value="${chimeVol}" />
              <span style="font-size: 11px; font-weight: 600; color: #fff; width: 40px; text-align: right" id="val-chime-volume">${chimeVol}%</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Autostart z Windows</div>
              <div class="fc-field-desc">Uruchamiaj DeskSense razem z systemem</div>
            </div>
            <button class="fc-switch ${form.autoStart ? 'active' : ''}" id="sw-autostart" aria-checked="${form.autoStart ?? false}" role="switch"></button>
          </div>
        </div>

        <div class="fc-settings-group ${form.sleepMonitorsOnAway ? 'highlight' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--fc-card-border); padding-bottom: 8px">
            <div>
              <div class="fc-settings-group-title" style="border: none; padding: 0">🖥️ Zarządzanie Ekranami & Wygaszacz</div>
              <div style="font-size: 11px; color: var(--fc-text-secondary); margin-top: 2px">Czarny wygaszacz działa zawsze niezależnie; przełącznik poniżej włącza dodatkowo sprzętowe uśpienie matryc (DPMS) po zadanym czasie</div>
            </div>
            <button class="fc-switch ${form.sleepMonitorsOnAway ? 'active' : ''}" id="sw-sleep-monitors" aria-checked="${form.sleepMonitorsOnAway ?? false}" role="switch" title="Sprzętowe uśpienie i wybudzanie monitorów (DPMS) po odejściu"></button>
          </div>

          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Czarny wygaszacz ekranu</div>
              <div class="fc-field-desc">Błyskawiczne zaciemnienie wszystkich monitorów (0 ms wybudzanie, bez wyłączania matryc). Działa niezależnie od DPMS poniżej.</div>
            </div>
            <div style="display: flex; gap: 8px; align-items: center">
              <select class="fc-select fc-select-sm" id="sel-screensaver-delay" style="width: 130px" ${form.screensaverOnAway === false ? 'disabled' : ''}>
                <option value="30000" ${ssDelay === 30000 ? 'selected' : ''}>po 30 sek</option>
                <option value="60000" ${ssDelay === 60000 ? 'selected' : ''}>po 1 minucie</option>
                <option value="120000" ${ssDelay === 120000 ? 'selected' : ''}>po 2 minutach</option>
                <option value="180000" ${ssDelay === 180000 ? 'selected' : ''}>po 3 minutach</option>
                <option value="300000" ${ssDelay === 300000 ? 'selected' : ''}>po 5 minutach</option>
              </select>
              <button class="fc-switch ${form.screensaverOnAway ? 'active' : ''}" id="sw-screensaver" aria-checked="${form.screensaverOnAway ?? true}" role="switch"></button>
            </div>
          </div>

          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Sprzętowe uśpienie zasilania (DPMS)</div>
              <div class="fc-field-desc">Fizyczne uśpienie zasilania wyświetlaczy (standby) przy długiej nieobecności</div>
            </div>
            <select class="fc-select fc-select-sm" id="sel-sleep-monitors-delay" style="width: 130px" ${!form.sleepMonitorsOnAway ? 'disabled' : ''}>
              <option value="180000" ${sleepDelay === 180000 ? 'selected' : ''}>po 3 minutach</option>
              <option value="300000" ${sleepDelay === 300000 ? 'selected' : ''}>po 5 minutach</option>
              <option value="600000" ${sleepDelay === 600000 ? 'selected' : ''}>po 10 minutach</option>
              <option value="900000" ${sleepDelay === 900000 ? 'selected' : ''}>po 15 minutach</option>
              <option value="1200000" ${sleepDelay === 1200000 ? 'selected' : ''}>po 20 minutach</option>
              <option value="1800000" ${sleepDelay === 1800000 ? 'selected' : ''}>po 30 minutach</option>
              <option value="3600000" ${sleepDelay === 3600000 ? 'selected' : ''}>po 1 godzinie</option>
            </select>
          </div>

          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Wybudzaj monitory po powrocie</div>
              <div class="fc-field-desc">Automatyczne wybudzenie sprzętowe monitorów po wykryciu obecności przy biurku</div>
            </div>
            <button class="fc-switch ${form.wakeMonitorsOnDesk !== false ? 'active' : ''}" id="sw-wake-monitors" aria-checked="${form.wakeMonitorsOnDesk !== false}" role="switch" ${!form.sleepMonitorsOnAway ? 'disabled' : ''}></button>
          </div>

          <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px">
            <button class="btn btn-ghost btn-sm" id="btn-test-screensaver" style="font-size: 11px; padding: 4px 10px">
              🖥️ Przetestuj czarny wygaszacz
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderHaosPanel(): string {
    const form = this.form!;
    const snap = this.snap!;
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group ${form.haEnabled ? 'highlight' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--fc-card-border); padding-bottom: 8px">
            <div class="fc-settings-group-title" style="border: none; padding: 0">🏠 Home Assistant OS (HAOS)</div>
            <div style="display: flex; gap: 8px; align-items: center">
              <span class="fc-badge ${snap.ha?.connected ? 'calibrated' : (form.haEnabled ? 'amber' : 'muted')}" id="badge-ha-status">
                ${snap.ha?.connected ? `● Połączono (HAOS${snap.ha.version ? ` v${snap.ha.version}` : ''}) ✓` : (form.haEnabled ? (snap.ha?.error || 'Łączenie z HAOS…') : 'Wyłączony')}
              </span>
              <button class="fc-switch ${form.haEnabled ? 'active' : ''}" id="sw-ha-enabled" aria-checked="${form.haEnabled ?? false}" role="switch" title="Włącz pobieranie danych obecności z Home Assistant"></button>
            </div>
          </div>

          <div style="font-size: 11px; color: var(--fc-text-secondary)">
            Pobieraj stan obecności, dystans, tętno i oddech z sensora mmWave / ESPHome podłączonego bezpośrednio do Home Assistanta (przez Wi-Fi/LAN).
          </div>

          <div class="fc-subgrid-2" style="gap: 10px">
            <div>
              <label class="fc-micro-label">Adres URL Home Assistant:</label>
              <input type="text" class="fc-input" id="inp-ha-url" placeholder="http://homeassistant.local:8123" value="${esc(form.haUrl || 'http://homeassistant.local:8123')}" style="height: 30px; font-size: 11.5px" />
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center">
                <label class="fc-micro-label">Długoterminowy Token Dostępu (Bearer):</label>
                <button class="text-btn" id="btn-toggle-ha-token" style="font-size: 10px; color: var(--fc-accent-blue)">${this.haShowToken ? 'Ukryj 👁️' : 'Pokaż 👁️'}</button>
              </div>
              <input type="${this.haShowToken ? 'text' : 'password'}" class="fc-input" id="inp-ha-token" placeholder="Wklej Long-Lived Access Token z profilu HA…" value="${esc(form.haToken || '')}" style="height: 30px; font-size: 11.5px" />
            </div>
          </div>

          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <button class="btn btn-ghost btn-sm" id="btn-ha-test" style="font-size: 11px; padding: 4px 10px" ${this.haTesting ? 'disabled' : ''}>
              ${this.haTesting ? '⏳ Testuję połączenie…' : '🧪 Testuj połączenie'}
            </button>
            <button class="btn btn-primary btn-sm" id="btn-ha-fetch-entities" style="font-size: 11px; padding: 4px 10px" ${this.haFetchingEntities ? 'disabled' : ''}>
              ${this.haFetchingEntities ? '⏳ Pobieram encje…' : '🔍 Wykryj & Pobierz encje z HAOS'}
            </button>
            <div id="ha-test-feedback" style="font-size: 11px; margin-left: 6px; color: ${this.haTestResult ? (this.haTestResult.ok ? 'var(--fc-accent-green)' : '#ef4444') : 'var(--fc-text-muted)'}">
              ${this.haTestResult ? esc(this.haTestResult.message || this.haTestResult.error || '') : ''}
            </div>
          </div>

          <div class="fc-subgrid-2" style="gap: 10px; padding-top: 8px; border-top: 1px solid var(--fc-card-border)">
            <div>
              <label class="fc-micro-label">Encja Obecności (binary_sensor):</label>
              <input type="text" class="fc-input" id="inp-ha-presence" list="ha-presence-list" placeholder="np. binary_sensor.seeed_mr60bha2_presence" value="${esc(form.haPresenceEntity || '')}" style="height: 28px; font-size: 11px" />
              <datalist id="ha-presence-list">
                ${this.haBinarySensors.map(e => `<option value="${esc(e.entity_id)}">${esc(e.name)} (${esc(e.state)})</option>`).join('')}
              </datalist>
            </div>
            <div>
              <label class="fc-micro-label">Encja Dystansu fotela (opcjonalna):</label>
              <input type="text" class="fc-input" id="inp-ha-distance" list="ha-sensors-list" placeholder="np. sensor.seeed_mr60bha2_distance" value="${esc(form.haDistanceEntity || '')}" style="height: 28px; font-size: 11px" />
            </div>
            <div>
              <label class="fc-micro-label">Encja Tętna BPM (opcjonalna):</label>
              <input type="text" class="fc-input" id="inp-ha-heart" list="ha-sensors-list" placeholder="np. sensor.seeed_mr60bha2_heart_rate" value="${esc(form.haHeartRateEntity || '')}" style="height: 28px; font-size: 11px" />
            </div>
            <div>
              <label class="fc-micro-label">Encja Oddechu RPM (opcjonalna):</label>
              <input type="text" class="fc-input" id="inp-ha-breath" list="ha-sensors-list" placeholder="np. sensor.seeed_mr60bha2_breath_rate" value="${esc(form.haBreathRateEntity || '')}" style="height: 28px; font-size: 11px" />
              <datalist id="ha-sensors-list">
                ${this.haSensors.map(e => `<option value="${esc(e.entity_id)}">${esc(e.name)} (${esc(e.state)}${e.unit ? ` ${esc(e.unit)}` : ''})</option>`).join('')}
              </datalist>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- LOGS TAB WITH QoL SEARCH & FILTERS ----------
  private renderLogsTab(): string {
    return `
      <div class="fc-tab-pane">
        <div class="fc-settings-view">
          <div class="fc-settings-group">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--fc-card-border); padding-bottom: 8px">
              <div class="fc-settings-group-title" style="border: none; padding: 0">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--fc-accent-blue)" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                Konsola Diagnostyczna & Logi Live (${this.logs.length} wpisów)
              </div>
              <div style="display: flex; gap: 8px">
                <button class="btn btn-primary btn-sm" id="fc-btn-copy-diag-report" title="Wygeneruj zwięzły, pełny raport diagnostyczny dla asystenta AI / programisty" style="font-size: 11px; padding: 4px 9px">🤖 Kopiuj dla AI</button>
                <button class="btn btn-secondary btn-sm" id="fc-btn-open-notepad" title="Otwórz wszystkie surowe logi (.txt) w Notatniku Windows" style="font-size: 11px; padding: 4px 9px">📝 Notatnik</button>
                <button class="btn btn-ghost btn-sm" id="fc-btn-copy-logs" title="Skopiuj wszystkie surowe logi RAW do schowka" style="font-size: 11px; padding: 4px 9px">📋 Kopiuj RAW</button>
                <button class="btn btn-ghost btn-sm" id="fc-btn-clear-logs" title="Wyczyść historię logów" style="font-size: 11px; padding: 4px 9px">🗑️ Wyczyść</button>
              </div>
            </div>

            <div class="fc-log-toolbar">
              <div class="fc-log-chips">
                <button class="fc-log-chip ${this.logFilter === 'all' ? 'active' : ''}" data-log-filter="all">Wszystkie</button>
                <button class="fc-log-chip ${this.logFilter === 'radar' ? 'active' : ''}" data-log-filter="radar">📡 Radar & DSP</button>
                <button class="fc-log-chip ${this.logFilter === 'haos' ? 'active' : ''}" data-log-filter="haos">🏠 HAOS</button>
                <button class="fc-log-chip ${this.logFilter === 'audio' ? 'active' : ''}" data-log-filter="audio">🎙️ Audio & VU</button>
                <button class="fc-log-chip ${this.logFilter === 'discord' ? 'active' : ''}" data-log-filter="discord">🎮 Discord & RGB</button>
                <button class="fc-log-chip ${this.logFilter === 'error' ? 'active' : ''}" data-log-filter="error">⚠️ Błędy</button>
              </div>
              <input type="text" class="fc-search-input" id="inp-log-search" placeholder="🔍 Szukaj w logach…" value="${esc(this.logSearch)}" />
            </div>

            <div id="log-console" style="background: #0d1117; border: 1px solid var(--fc-card-border); border-radius: var(--fc-radius-sm); padding: 12px; height: 350px; overflow-y: auto; font-family: monospace; font-size: 11.5px; line-height: 1.5; color: #38bdf8; white-space: pre-wrap; word-break: break-all">
              ${this.logs.length > 0 ? esc(this.logs.join('\n')) : 'Oczekiwanie na zdarzenia…'}
            </div>
          </div>

          <div class="fc-settings-group">
            <div class="fc-settings-group-title">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--fc-accent-blue)" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Oficjalny Firmware & Flasher MR60BHA2 (XIAO ESP32-C6)
            </div>
            <p style="font-size: 12px; color: var(--fc-text-secondary); line-height: 1.5">
              Sensor działa natywnie na fabrycznym firmware Seeed Studio lub alternatywnym ESPHome. Do przywrócenia lub ponownego wgrania oprogramowania użyj poniższych zasobów:
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px">
              <button class="btn btn-primary btn-sm" id="btn-open-stock-bin">💾 Pobierz Binarki Firmware (Releases)</button>
              <button class="btn btn-ghost btn-sm" id="btn-open-seeed-wiki">🧰 Web Flasher (ESPHOME)</button>
              <button class="btn btn-ghost btn-sm" id="btn-open-seeed-gh">🐙 Repozytorium GitHub (ESPHome)</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- ABOUT TAB WITH HEALTH DIAGNOSTICS ----------
  private renderAboutTab(): string {
    const isRadarConnected = Boolean(this.snap?.radar?.connected);
    // To jest stan PRZEŁĄCZNIKA w opcjach, nie faktyczne połączenie RPC —
    // nazwa zmiennej miała to ukrywać.
    const isDiscordEnabled = Boolean(this.form?.discordIntegration);
    const isSignalrgbEnabled = Boolean(this.form?.signalrgbEnabled);

    return `
      <div class="fc-tab-pane">
        <div class="fc-settings-view">
          <div class="fc-settings-group" style="text-align: center; padding: 28px 20px">
            <div style="width: 56px; height: 56px; border-radius: 14px; margin: 0 auto 12px auto; display: grid; place-items: center; background: linear-gradient(135deg, #10b981 0%, #0284c7 100%); box-shadow: 0 0 20px rgba(16, 185, 129, 0.4)">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </div>
            <h2 style="font-size: 20px; font-weight: 700; color: #fff">DeskSense</h2>
            <p style="font-size: 12px; color: var(--fc-text-secondary); margin-top: 4px">Automatyczne przełączanie mikrofonu w oparciu o obecność mmWave</p>
            <span class="fc-badge calibrated" style="margin-top: 8px">Wersja v${esc(this.snap?.version || this.updater.currentVersion || '0.3.0')}</span>
          </div>

          <div class="fc-settings-group">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--fc-card-border); padding-bottom: 8px">
              <div class="fc-settings-group-title" style="border: none; padding: 0">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--fc-accent-green)" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                Stan Komponentów & Diagnostyka (Health Hub)
              </div>
              <button class="btn btn-ghost btn-sm" id="btn-run-full-diag">🩺 Szczegółowa Diagnostyka</button>
            </div>

            <div class="fc-diag-grid">
              <div class="fc-diag-item">
                <div class="fc-diag-item-title">
                  <span>📡 Sensor Radar mmWave</span>
                  <span class="fc-badge ${isRadarConnected ? 'calibrated' : 'amber'}">${isRadarConnected ? 'Połączony ✓' : 'Brak COM'}</span>
                </div>
                <div class="fc-diag-item-val">${isRadarConnected ? (this.form?.port || 'USB COM') : 'Niepołączony'}</div>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title">
                  <span>🎙️ Audio Switcher Core</span>
                  <span class="fc-badge calibrated">Aktywny ✓</span>
                </div>
                <div class="fc-diag-item-val">${this.audioDevices.length} mikrofonów Windows</div>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title">
                  <span>🎮 Discord Voice RPC</span>
                  <span class="fc-badge ${isDiscordEnabled ? 'blue' : 'muted'}">${isDiscordEnabled ? 'Włączony' : 'Wyłączony'}</span>
                </div>
                <div class="fc-diag-item-val">${isDiscordEnabled ? 'Lokalne RPC (named pipe Discorda)' : 'Wyłączony w opcjach'}</div>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🌈 SignalRGB LED API</span> <span class="fc-badge ${isSignalrgbEnabled ? 'amber' : 'muted'}">${isSignalrgbEnabled ? 'Włączony' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val">${isSignalrgbEnabled ? `Port ${this.form?.signalrgbPort ?? 16038} (Lokalny)` : 'Nieaktywny'}</div>
              </div>
            </div>
          </div>

          <div class="fc-settings-group">
            <div class="fc-settings-group-title">Aktualizacje Oprogramowania (GitHub Releases)</div>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div>
                <strong style="color: #fff">Sprawdzanie nowych wydań</strong>
                <p style="font-size: 11px; color: var(--fc-text-muted); margin-top: 2px">Aplikacja automatycznie weryfikuje dostępność nowych wersji</p>
              </div>
              <button class="btn btn-primary btn-sm" id="fc-btn-check-updates" ${this.updater.status === 'checking' || this.updater.status === 'downloading' ? 'disabled' : ''}>
                ${this.updater.status === 'checking' ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
              </button>
            </div>

            ${this.updater.status === 'available' && this.updater.updateInfo ? `
              <div class="update-banner ready" style="margin-top: 10px">
                <div class="update-banner-icon">✓</div>
                <div class="update-banner-content">
                  <strong>Dostępna nowa wersja: v${esc(this.updater.updateInfo.version)}</strong>
                  <p>${esc(this.updater.updateInfo.name || 'Nowe funkcje i poprawki')}</p>
                  <button class="btn btn-primary btn-sm" id="btn-download-update">Pobierz i zaktualizuj</button>
                </div>
              </div>
            ` : ''}

            ${this.updater.status === 'downloading' ? `
              <div class="update-banner downloading" style="margin-top: 10px">
                <div class="update-banner-content" style="width: 100%">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                    <strong>Pobieranie aktualizacji…</strong>
                    <span id="upd-progress-text">${this.downloadProgress?.percent || 0}% (${this.downloadProgress?.speed || '...'})</span>
                  </div>
                  <div class="progress-bar">
                    <div class="progress-fill" id="upd-progress-fill" style="width: ${this.downloadProgress?.percent || 0}%"></div>
                  </div>
                </div>
              </div>
            ` : ''}

            ${this.updater.status === 'downloaded' ? `
              <div class="update-banner ready" style="margin-top: 10px">
                <div class="update-banner-icon">✓</div>
                <div class="update-banner-content">
                  <strong>Aktualizacja została pobrana i jest gotowa!</strong>
                  <p>Zainstaluj nową wersję i zrestartuj program.</p>
                  <button class="btn btn-primary btn-sm" id="btn-install-update">Zainstaluj i zrestartuj</button>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL: VAD Auto-Calibration Assistant Modal ----------
  private renderVadModal(): string {
    const isDesk = this.vadTarget === 'desk';
    const micName = isDesk ? (this.form?.micDeskName || 'Mikrofon Biurkowy') : (this.form?.micHeadsetName || 'Mikrofon Mobilny');
    const step = this.vadStep;
    const count = this.vadCountdown;

    return `
      <div class="modal-overlay" id="vad-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>🎯 Asystent Kalibracji Progu Discord VAD</h3>
            <button class="close" id="btn-vad-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div style="font-size: 12px; color: var(--fc-text-secondary); margin-bottom: 12px">
              Kalibracja dla: <strong style="color: ${isDesk ? 'var(--fc-accent-green)' : 'var(--fc-accent-blue)'}">${esc(micName)}</strong>
            </div>

            <div class="wizard-steps">
              <div class="wizard-step-dot ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 3 ? 'done' : ''}"></div>
            </div>

            ${this.vadWarning ? `
              <div class="update-banner" style="border-color: rgba(239, 68, 68, 0.6); background: rgba(239, 68, 68, 0.12); margin-bottom: 12px">
                <div class="update-banner-icon" style="background: #ef4444">⚠️</div>
                <div class="update-banner-content">
                  <strong style="color: #fca5a5">Uwaga kalibracji</strong>
                  <p style="color: #fecaca; margin: 0">${esc(this.vadWarning)}</p>
                </div>
              </div>
            ` : ''}

            ${step === 1 ? `
              <div>
                <div class="wizard-icon-hero">🤫</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 1: Pomiar szumu tła i klawiatury</h4>
                <p class="wizard-instruction">
                  Bądź cicho przez 5 sekund. Możesz normalnie pisać na klawiaturze lub kliknąć myszką, aby asystent precyzyjnie zmierzył i odciął te dźwięki.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Mierzenie profilu szumu otoczenia…</strong>
                      <span>${count} s (${isDesk ? this.vuEngine.currentDeskDb : this.vuEngine.currentHeadDb} dB)</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((5 - count) / 5) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-vad-1" style="width: 100%">Rozpocznij pomiar tła (5s)</button>`}
                </div>
              </div>` : ''}

            ${step === 2 ? `
              <div>
                <div class="wizard-icon-hero">🗣️</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 2: Pomiar Twojej naturalnej mowy</h4>
                <p class="wizard-instruction">
                  Powiedz 2-3 zdania swoim naturalnym głosem przez 6 sekund (np. <em>„Raz, dwa, trzy, test mikrofonu DeskSense, sprawdzamy głośność głosu i czułość bramki”</em>).
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Rejestrowanie próbek głosu…</strong>
                      <span>${count} s (${isDesk ? this.vuEngine.currentDeskDb : this.vuEngine.currentHeadDb} dB)</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((6 - count) / 6) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-vad-2" style="width: 100%">Rozpocznij próbkę głosu (6s)</button>`}
                </div>
              </div>` : ''}

            ${step === 3 ? `
              <div>
                <div class="wizard-icon-hero">🎉</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Obliczono optymalny próg bramki!</h4>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px">
                  <div class="fc-card">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">🤫 Szum otoczenia</div>
                    <strong style="font-size: 16px; color: #94a3b8">${this.vadResults.noiseDb} dB</strong>
                  </div>
                  <div class="fc-card">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">🗣️ Średni poziom głosu</div>
                    <strong style="font-size: 16px; color: #38bdf8">${this.vadResults.speechDb} dB</strong>
                  </div>
                </div>

                <div style="margin-top: 10px; padding: 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: var(--fc-radius-sm); text-align: center">
                  <div style="font-size: 11px; color: var(--fc-text-secondary)">Rekomendowany próg aktywacji głosu Discord (VAD):</div>
                  <div style="font-size: 24px; font-weight: 800; color: #fbbf24; margin: 4px 0">${this.vadResults.optimalGateDb} dB</div>
                  <div style="font-size: 10.5px; color: #4ade80">🛡️ Zastosowano bufor bezpieczeństwa -3 dB (zapewnia pełną słyszalność cichych końcówek słów i szeptu).</div>
                </div>
              </div>` : ''}
          </div>

          <div class="modal-footer">
            ${step === 2 ? `<button class="btn btn-ghost btn-sm" id="btn-vad-back">← Wstecz</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="btn-vad-cancel">Anuluj</button>
            ${step === 3 ? `<button class="btn btn-primary btn-sm" id="btn-vad-apply">Zastosuj i zapisz próg ✓</button>` : `<span style="font-size: 11px; color: var(--fc-text-muted)">Krok ${step} z 3</span>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 1: Wizard Kalibracji Radaru ----------
  private renderWizardModal(): string {
    const step = this.wizardStep;
    const count = this.wizardCountdown;

    return `
      <div class="modal-overlay" id="wizard-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>✨ Kreator Kalibracji Sensora (Krok ${step} z 3)</h3>
            <button class="close" id="btn-wizard-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="wizard-steps">
              <div class="wizard-step-dot ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 3 ? 'done' : ''}"></div>
            </div>

            ${this.wizardWarning ? `
              <div class="update-banner" style="border-color: rgba(239, 68, 68, 0.6); background: rgba(239, 68, 68, 0.12); margin-bottom: 12px">
                <div class="update-banner-icon" style="background: #ef4444">⚠️</div>
                <div class="update-banner-content">
                  <strong style="color: #fca5a5">Uwaga kalibracji</strong>
                  <p style="color: #fecaca; margin: 0">${esc(this.wizardWarning)}</p>
                </div>
              </div>
            ` : ''}

            ${step === 1 ? `
              <div>
                <div class="wizard-icon-hero">🪑</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 1: Weryfikacja pustego fotela</h4>
                <p class="wizard-instruction">
                  Odejdź od biurka na 2–3 metry lub wyjdź z zasięgu radaru.<br/>
                  Aplikacja sprawdzi, czy radar widzi już pusty fotel — dopiero wtedy przejdziemy do pomiaru pozycji siedzenia.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Skanowanie otoczenia…</strong>
                      <span>${count} s</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((5 - count) / 5) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-step-1" style="width: 100%">Rozpocznij skanowanie tła (5s)</button>`}
                </div>
              </div>` : ''}

            ${step === 2 ? `
              <div>
                <div class="wizard-icon-hero">🧘</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 2: Pozycja w fotelu (Bramka zasięgu)</h4>
                <p class="wizard-instruction">
                  Usiądź wygodnie w fotelu w swojej naturalnej pozycji do pracy lub grania.<br/>
                  Radar ustali Twoją strefę fotela i odetnie wszystko za Twoim oparciem.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Mierzenie dystansu klatki piersiowej…</strong>
                      <span>${count} s (${this.telemetry.distanceCm ? this.telemetry.distanceCm + ' cm' : 'namierzanie…'})</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((6 - count) / 6) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-step-2" style="width: 100%">Rozpocznij pomiar pozycji fotela (6s)</button>`}
                </div>
              </div>` : ''}

            ${step === 3 ? `
              <div>
                <div class="wizard-icon-hero">🎉</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Kalibracja zakończona sukcesem!</h4>
                <div style="margin-top: 12px">
                  <div class="fc-card" style="text-align: center">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">📏 Strefa fotela</div>
                    <strong style="font-size: 16px; color: var(--fc-accent-green)">${this.wizardResults.distance} cm</strong>
                    <span style="font-size: 10px; color: var(--fc-text-muted)">Bramka: ${this.wizardResults.gateMin}–${this.wizardResults.gateMax} cm</span>
                  </div>
                </div>
              </div>` : ''}
          </div>

          <div class="modal-footer">
            ${step > 1 && step < 3 ? `<button class="btn btn-ghost btn-sm" id="btn-wizard-back">← Wstecz</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="btn-wizard-cancel">Anuluj</button>
            ${step === 3 ? `<button class="btn btn-primary btn-sm" id="btn-wizard-apply">Zastosuj i zapisz kalibrację ✓</button>` : `<span style="font-size: 11px; color: var(--fc-text-muted)">Krok ${step} z 3</span>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 4: QoL Diagnostics Hub Modal ----------
  /** Modal z logami zebranej sesji "Wyjście z pokoju" (kopiuj AI / notatnik). */
  private renderDiagSessionModal(): string {
    const lines = this.diagSessionText.split('\n').length;
    return `
      <div class="modal-overlay" id="diag-session-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>🧪 Sesja diagnostyczna — raport "Wyjście z pokoju"</h3>
            <button class="close" id="btn-diag-session-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div style="font-size: 11.5px; color: var(--fc-text-secondary); margin-bottom: 8px">
              Zebrano <strong>${lines}</strong> linii logów od momentu kliknięcia „Wyjście z pokoju”.
              Prześlij raport przy zgłaszaniu problemu z wykrywaniem nieobecności.
            </div>
            <pre class="fc-diag-session-log">${esc(this.diagSessionText)}</pre>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-diag-session-cancel">Zamknij</button>
            <button class="btn btn-secondary btn-sm" id="btn-diag-session-notepad" title="Otwórz raport w Notatniku Windows">📝 Notatnik</button>
            <button class="btn btn-primary btn-sm" id="btn-diag-session-copy" title="Skopiuj pełny raport do schowka (dla AI / programisty)">🤖 Kopiuj dla AI</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderDiagModal(): string {
    return `
      <div class="modal-overlay" id="diag-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>🩺 Pełna Diagnostyka Systemu DeskSense</h3>
            <button class="close" id="btn-diag-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="fc-diag-grid">
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>📡 Sensor mmWave</span> <span class="fc-badge ${this.snap?.radar.connected || this.snap?.ha?.connected ? 'calibrated' : 'amber'}">${this.snap?.radar.connected ? 'USB ✓' : (this.snap?.ha?.connected ? 'HAOS ✓' : 'Brak')}</span></div>
                <div class="fc-diag-item-val">Port: ${esc(this.form?.port || 'auto')}${this.snap?.radar.port && this.form?.port === 'auto' ? ` → ${esc(this.snap.radar.port)}` : ''}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Auto-wykrywanie po VID/PID (Seeed XIAO ESP32-C6, m.in. 0x303A:0x1001)</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🎙️ AudioSwitcher.exe</span> <span class="fc-badge ${this.audioDevices.length > 0 ? 'calibrated' : 'amber'}">${this.audioDevices.length > 0 ? 'Odpowiada ✓' : 'Brak urządzeń'}</span></div>
                <div class="fc-diag-item-val">Liczba urządzeń: ${this.audioDevices.length}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">CoreAudio daemon (stdin/stdout) + IPolicyConfig (COM)</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🎮 Discord RPC</span> <span class="fc-badge ${this.form?.discordIntegration ? 'blue' : 'muted'}">${this.form?.discordIntegration ? 'Włączony' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val"><strong id="discord-rpc-status-val" style="color: var(--fc-text-dim)">…</strong></div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Lokalne RPC przez named pipe Discorda</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🌈 SignalRGB API</span> <span class="fc-badge ${this.form?.signalrgbEnabled ? 'amber' : 'muted'}">${this.form?.signalrgbEnabled ? 'Włączony' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val">Port: ${this.form?.signalrgbPort ?? 16038}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Lokalne REST API SignalRGB</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🏠 Home Assistant (HAOS)</span> <span class="fc-badge ${this.snap?.ha?.connected ? 'calibrated' : (this.form?.haEnabled ? 'amber' : 'muted')}">${this.snap?.ha?.connected ? 'Połączony ✓' : (this.form?.haEnabled ? 'Łączenie…' : 'Wyłączony')}</span></div>
                <div class="fc-diag-item-val">${this.form?.haEnabled ? esc(this.form.haUrl || 'http://homeassistant.local:8123') : 'Wyłączona integracja'}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Encja: ${this.form?.haPresenceEntity ? esc(this.form.haPresenceEntity) : 'brak wybranej'}</span>
              </div>
            </div>

            <div style="margin-top: 12px; padding: 10px; background: var(--fc-bg-darker); border-radius: var(--fc-radius-sm); font-size: 11.5px; color: var(--fc-text-secondary)">
              <strong>💡 Wskazówka:</strong> Powyżej konfiguracja i dostępność modułów. Live logi znajdziesz w zakładce „Logi”, a do diagnozy przełączania użyj sesji „Wyjście z pokoju” (przycisk w nagłówku).
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-diag-cancel">Zamknij</button>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- EVENT BINDINGS ----------
  private bindEvents() {
    const byId = (id: string) => document.getElementById(id);

    // Navigation Tabs
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.currentTarget as HTMLElement).getAttribute('data-tab') as TabType;
        if (tab && tab !== this.currentTab) {
          this.currentTab = tab;
          this.render();
        }
      });
    });

    // Window Controls
    byId('fc-win-close')?.addEventListener('click', () => window.api.closeWindow());
    byId('fc-win-min')?.addEventListener('click', () => window.api.minimizeWindow());
    byId('fc-win-max')?.addEventListener('click', async () => {
      await window.api.maximizeWindow();
      this.isMaximized = !this.isMaximized;
    });

    // Settings Sub-Navigation (lewy panel ustawień)
    document.querySelectorAll<HTMLElement>('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.currentTarget as HTMLElement).getAttribute('data-settings-tab') as SettingsTab;
        if (tab && tab !== this.settingsTab) {
          this.settingsTab = tab;
          this.render();
        }
      });
    });

    // Double-click on Titlebar to Maximize/Restore
    byId('fc-titlebar')?.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.top-tools, button, select, input')) return;
      void window.api.maximizeWindow();
    });

    // Header Controls
    byId('fc-header-mute-btn')?.addEventListener('click', async () => {
      const res = await window.api.toggleMute();
      if (res && typeof res.isMuted === 'boolean') {
        this.isMuted = res.isMuted;
        this.pushToast(res.isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️');
        this.triggerOsdHud(res.isMuted ? '🔇 Mikrofon Wyciszony' : '🎙️ Mikrofon Aktywny', res.isMuted);
        this.updateHeaderAndLiveDOM();
      }
    });

    byId('fc-btn-refresh-all')?.addEventListener('click', async () => {
      this.refreshingPorts = true;
      this.render();
      await this.pollHardwareLists();
      this.refreshingPorts = false;
      this.render();
      this.pushToast('Odświeżono urządzenia audio i porty COM');
    });

    // QoL: Cancel Snooze — pauza żyje w main (AppController), IPC ją ustawia
    byId('btn-cancel-snooze')?.addEventListener('click', async () => {
      try {
        const s = await window.api.setSnooze(0);
        this.snap = s;
        this.snoozeUntil = null;
        this.pushToast('Wznowiono automatyczne przełączanie mikrofonu ✓');
      } catch {
        this.pushToast('Nie udało się wznowić automatyki', true);
      }
      this.render();
    });

    // QoL: Quick Snooze in Master Card — main jest źródłem prawdy pauzy
    byId('sel-quick-snooze')?.addEventListener('change', async (e) => {
      const mins = Number((e.target as HTMLSelectElement).value);
      try {
        const s = await window.api.setSnooze(mins);
        this.snap = s;
        this.snoozeUntil = s.snoozeUntil > 0 ? s.snoozeUntil : null;
        this.pushToast(mins > 0 ? `Wstrzymano automatyczne przełączanie na ${mins} min ⏸️` : 'Wznowiono automatyczne przełączanie ✓');
      } catch {
        this.pushToast('Nie udało się zmienić pauzy automatyki', true);
      }
      this.render();
    });

    // Section Contextual Actions
    byId('btn-home-detect-mics')?.addEventListener('click', async () => {
      this.pushToast('Wykrywam mikrofony…');
      const r = await window.api.detectDevices();
      await this.loadAudioDevices();
      if (r.recommended.micDeskName || r.recommended.micHeadsetName) {
        this.patchForm({
          micDeskName: r.recommended.micDeskName || this.form?.micDeskName || '',
          micHeadsetName: r.recommended.micHeadsetName || this.form?.micHeadsetName || ''
        }, true);
        void this.vuEngine.start(this.form?.micDeskName || '', this.form?.micHeadsetName || '');
        this.pushToast('Dopasowano optymalne mikrofony — zapisano automatycznie ✓');
      }
    });
    byId('btn-home-open-wizard')?.addEventListener('click', () => this.openCalibrationWizard());
    byId('btn-reset-autotune')?.addEventListener('click', async () => {
      if (confirm('Czy na pewno chcesz zresetować wyuczone parametry modelu AI?')) {
        const status = await window.api.resetAutoTuning();
        if (status) this.telemetry.autoTuning = status;
        this.pushToast('Zresetowano model Auto-Tuningu ✓');
        this.render();
      }
    });

    // Mode segmented buttons
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

    // Card Actions
    byId('card-btn-test-desk')?.addEventListener('click', async () => {
      if (!this.form?.micDeskName) return;
      this.pushToast(`Aktywuję: ${this.form.micDeskName}…`);
      this.snap = await window.api.testDevice(this.form.micDeskName);
      await this.loadAudioDevices();
      this.triggerOsdHud(`🎙️ Aktywny: ${this.form.micDeskName}`, false);
      this.render();
    });

    byId('card-btn-test-headset')?.addEventListener('click', async () => {
      if (!this.form?.micHeadsetName) return;
      this.pushToast(`Aktywuję: ${this.form.micHeadsetName}…`);
      this.snap = await window.api.testDevice(this.form.micHeadsetName);
      await this.loadAudioDevices();
      this.triggerOsdHud(`🎧 Aktywny: ${this.form.micHeadsetName}`, false);
      this.render();
    });

    byId('card-sw-mute')?.addEventListener('click', async () => {
      const res = await window.api.toggleMute();
      if (res && typeof res.isMuted === 'boolean') {
        this.isMuted = res.isMuted;
        this.triggerOsdHud(res.isMuted ? '🔇 Mikrofon Wyciszony' : '🎙️ Mikrofon Aktywny', res.isMuted);
        this.updateHeaderAndLiveDOM();
      }
    });

    // VAD Auto-Calibration Modal & Discord Sync triggers
    byId('btn-vad-calibrate-desk')?.addEventListener('click', () => this.openVadModal('desk'));
    byId('btn-vad-calibrate-headset')?.addEventListener('click', () => this.openVadModal('headset'));

    byId('btn-vad-sync-desk')?.addEventListener('click', async () => {
      const s = await window.api.discordGetVoiceSettings();
      if (s) {
        const patch: Partial<Snapshot['config']> = {};
        if (typeof s.thresholdDb === 'number') {
          patch.micDeskGateDb = s.thresholdDb;
          this.vuEngine.deskGateDb = s.thresholdDb;
        }
        if (typeof s.krisp === 'boolean') patch.micDeskKrisp = s.krisp ? 'on' : 'off';
        if (typeof s.agc === 'boolean') patch.micDeskAgc = s.agc ? 'on' : 'off';
        if (typeof s.echo === 'boolean') patch.micDeskEcho = s.echo ? 'on' : 'off';
        this.patchForm(patch, true);
        this.pushToast(`Pobrano profil głosu z Discorda dla biurka ✓`);
      } else {
        this.pushToast('Nie udało się pobrać profilu z Discorda — upewnij się, że autoryzowano OAuth Discorda.', true);
      }
    });

    byId('btn-vad-sync-headset')?.addEventListener('click', async () => {
      const s = await window.api.discordGetVoiceSettings();
      if (s) {
        const patch: Partial<Snapshot['config']> = {};
        if (typeof s.thresholdDb === 'number') {
          patch.micHeadsetGateDb = s.thresholdDb;
          this.vuEngine.headGateDb = s.thresholdDb;
        }
        if (typeof s.krisp === 'boolean') patch.micHeadsetKrisp = s.krisp ? 'on' : 'off';
        if (typeof s.agc === 'boolean') patch.micHeadsetAgc = s.agc ? 'on' : 'off';
        if (typeof s.echo === 'boolean') patch.micHeadsetEcho = s.echo ? 'on' : 'off';
        this.patchForm(patch, true);
        this.pushToast(`Pobrano profil głosu z Discorda dla słuchawek ✓`);
      } else {
        this.pushToast('Nie udało się pobrać profilu z Discorda — upewnij się, że autoryzowano OAuth Discorda.', true);
      }
    });

    byId('btn-vad-close')?.addEventListener('click', () => this.closeVadModal());
    byId('btn-vad-cancel')?.addEventListener('click', () => this.closeVadModal());
    byId('btn-vad-back')?.addEventListener('click', () => {
      this.vadStep = 1;
      this.vadWarning = '';
      this.render();
    });
    byId('vad-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'vad-overlay') this.closeVadModal();
    });
    byId('btn-run-vad-1')?.addEventListener('click', () => this.runVadStep1());
    byId('btn-run-vad-2')?.addEventListener('click', () => this.runVadStep2());
    byId('btn-vad-apply')?.addEventListener('click', () => this.applyVadResults());

    // Quick VAD Presets Desk
    byId('preset-vad-desk-quiet')?.addEventListener('click', () => {
      this.patchForm({ micDeskGateDb: -55 }, true);
      if (this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -55 });
      }
      this.pushToast('Ustawiono próg VAD: -55 dB (Cichy pokój)');
    });
    byId('preset-vad-desk-std')?.addEventListener('click', () => {
      this.patchForm({ micDeskGateDb: -45 }, true);
      if (this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -45 });
      }
      this.pushToast('Ustawiono próg VAD: -45 dB (Zbalansowany)');
    });
    byId('preset-vad-desk-noisy')?.addEventListener('click', () => {
      this.patchForm({ micDeskGateDb: -35 }, true);
      if (this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -35 });
      }
      this.pushToast('Ustawiono próg VAD: -35 dB (Głośna klawiatura / Tło)');
    });

    // Quick VAD Presets Headset
    byId('preset-vad-headset-quiet')?.addEventListener('click', () => {
      this.patchForm({ micHeadsetGateDb: -55 }, true);
      if (this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -55 });
      }
      this.pushToast('Ustawiono próg VAD: -55 dB (Ciche otoczenie)');
    });
    byId('preset-vad-headset-std')?.addEventListener('click', () => {
      this.patchForm({ micHeadsetGateDb: -45 }, true);
      if (this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -45 });
      }
      this.pushToast('Ustawiono próg VAD: -45 dB (Zbalansowany)');
    });
    byId('preset-vad-headset-noisy')?.addEventListener('click', () => {
      this.patchForm({ micHeadsetGateDb: -35 }, true);
      if (this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -35 });
      }
      this.pushToast('Ustawiono próg VAD: -35 dB (Głośne tło)');
    });

    // Form inputs (Mic desk & headset)
    const onDeskMicSelect = (sel: HTMLSelectElement) => {
      const name = sel.value;
      const vol = this.initVolumePercent(name, this.form?.micDeskVolume);
      this.patchForm({ micDeskName: name, micDeskVolume: vol });
      void this.vuEngine.start(name, this.form?.micHeadsetName || '');
    };

    byId('sel-mic-desk')?.addEventListener('change', (e) => onDeskMicSelect(e.target as HTMLSelectElement));

    const onHeadsetMicSelect = (sel: HTMLSelectElement) => {
      const name = sel.value;
      const vol = this.initVolumePercent(name, this.form?.micHeadsetVolume);
      this.patchForm({ micHeadsetName: name, micHeadsetVolume: vol });
      void this.vuEngine.start(this.form?.micDeskName || '', name);
    };

    byId('sel-mic-headset')?.addEventListener('change', (e) => onHeadsetMicSelect(e.target as HTMLSelectElement));

    // Desk Voice Filters
    byId('rng-gate-desk')?.addEventListener('input', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      this.patchForm({ micDeskGateDb: val });
      const el = byId('val-gate-desk');
      if (el) el.textContent = `${val} dB`;
      this.vuEngine.deskGateDb = val;
      const marker = byId('vu-gate-desk');
      if (marker) {
        const pct = Math.max(0, Math.min(100, ((val + 100) / 100) * 100));
        marker.style.left = `${pct}%`;
        marker.title = `Próg bramki Discord: ${val} dB`;
      }
    });
    byId('rng-gate-desk')?.addEventListener('change', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      if (this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
    });

    const updateDeskKrisp = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micDeskKrisp: mode });
      if (mode !== 'default' && this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    };
    byId('settings-krisp-desk')?.addEventListener('change', (e) => updateDeskKrisp((e.target as HTMLSelectElement).value as any));

    const updateDeskAgc = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micDeskAgc: mode });
      if (mode !== 'default' && this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    };
    byId('settings-agc-desk')?.addEventListener('change', (e) => updateDeskAgc((e.target as HTMLSelectElement).value as any));

    byId('settings-echo-desk')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      this.patchForm({ micDeskEcho: mode });
      if (mode !== 'default' && this.isMicActive('desk') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ echo: mode === 'on' });
      }
    });

    // Headset Voice Filters
    byId('rng-gate-headset')?.addEventListener('input', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      this.patchForm({ micHeadsetGateDb: val });
      const el = byId('val-gate-headset');
      if (el) el.textContent = `${val} dB`;
      this.vuEngine.headGateDb = val;
      const marker = byId('vu-gate-headset');
      if (marker) {
        const pct = Math.max(0, Math.min(100, ((val + 100) / 100) * 100));
        marker.style.left = `${pct}%`;
        marker.title = `Próg bramki Discord: ${val} dB`;
      }
    });
    byId('rng-gate-headset')?.addEventListener('change', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      if (this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
    });

    // Click on VU track to set VAD Gate directly
    const bindVuClick = (boxId: string, sliderId: string, valId: string, markerId: string, isDesk: boolean) => {
      const box = byId(boxId);
      const track = box?.querySelector('.fc-vu-track') as HTMLElement | null;
      if (!track) return;
      track.style.cursor = 'pointer';
      track.title = 'Kliknij, aby ustawić próg bramki głosu';
      track.addEventListener('click', (e) => {
        const rect = track.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const db = Math.round(-100 + pct * 100);
        const clampedDb = Math.max(-100, Math.min(0, db));

        const rng = byId(sliderId) as HTMLInputElement | null;
        const valEl = byId(valId);
        const marker = byId(markerId);

        if (rng) rng.value = String(clampedDb);
        if (valEl) valEl.textContent = `${clampedDb} dB`;
        if (marker) marker.style.left = `${pct * 100}%`;

        if (isDesk) {
          this.vuEngine.deskGateDb = clampedDb;
          this.patchForm({ micDeskGateDb: clampedDb }, false);
          if (this.isMicActive('desk') && this.form?.discordIntegration) {
            void window.api.discordApplyVoice({ gateDb: clampedDb });
          }
        } else {
          this.vuEngine.headGateDb = clampedDb;
          this.patchForm({ micHeadsetGateDb: clampedDb }, false);
          if (this.isMicActive('headset') && this.form?.discordIntegration) {
            void window.api.discordApplyVoice({ gateDb: clampedDb });
          }
        }
        this.pushToast(`Ustawiono próg głosu: ${clampedDb} dB`);
      });
    };

    bindVuClick('vu-box-desk', 'rng-gate-desk', 'val-gate-desk', 'vu-gate-desk', true);
    bindVuClick('vu-box-headset', 'rng-gate-headset', 'val-gate-headset', 'vu-gate-headset', false);

    const updateHeadsetKrisp = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micHeadsetKrisp: mode });
      if (mode !== 'default' && this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    };
    byId('settings-krisp-headset')?.addEventListener('change', (e) => updateHeadsetKrisp((e.target as HTMLSelectElement).value as any));

    const updateHeadsetAgc = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micHeadsetAgc: mode });
      if (mode !== 'default' && this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    };
    byId('settings-agc-headset')?.addEventListener('change', (e) => updateHeadsetAgc((e.target as HTMLSelectElement).value as any));

    byId('settings-echo-headset')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      this.patchForm({ micHeadsetEcho: mode });
      if (mode !== 'default' && this.isMicActive('headset') && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ echo: mode === 'on' });
      }
    });

    // Discord Integration Toggles
    byId('sw-discord')?.addEventListener('click', () => {
      const val = !(this.form?.discordIntegration ?? true);
      this.patchForm({ discordIntegration: val }, false);
      const btn = byId('sw-discord');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-discord-follow')?.addEventListener('click', () => {
      const val = !(this.form?.discordGateFollowMic !== false);
      this.patchForm({ discordGateFollowMic: val }, false);
      const btn = byId('sw-discord-follow');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    byId('btn-discord-auth')?.addEventListener('click', async () => {
      const ok = await window.api.discordAuthorize();
      if (ok) {
        this.pushToast('Wysłano zapytanie o autoryzację OAuth — zatwierdź popup w Discordzie 🎮');
      } else {
        this.pushToast('Nie udało się uruchomić autoryzacji (czy Discord jest włączony?)', true);
      }
    });

    byId('btn-discord-sync')?.addEventListener('click', async () => {
      const isDesk = this.isMicActive('desk');
      const rawGate = isDesk ? this.form?.micDeskGateDb : this.form?.micHeadsetGateDb;
      const gateDb =
        typeof rawGate === 'number' && Number.isFinite(rawGate) && rawGate <= 0 && rawGate >= -100 && rawGate !== -1
          ? rawGate
          : undefined;
      const krispMode = isDesk ? this.form?.micDeskKrisp : this.form?.micHeadsetKrisp;
      const agcMode = isDesk ? this.form?.micDeskAgc : this.form?.micHeadsetAgc;
      const echoMode = isDesk ? this.form?.micDeskEcho : this.form?.micHeadsetEcho;
      const tri = (v: string | undefined): boolean | undefined => (v === 'on' ? true : v === 'off' ? false : undefined);

      const ok = await window.api.discordApplyVoice({
        gateDb,
        krisp: tri(krispMode),
        agc: tri(agcMode),
        echo: tri(echoMode)
      });
      if (ok) {
        this.pushToast(`Zsynchronizowano profil głosu Discord (${isDesk ? 'Biurko' : 'Słuchawki'}) ✓`);
      } else {
        this.pushToast('Discord nie przyjął zmian profilu (kliknij "Autoryzuj Discord")', true);
      }
    });

    // Status połączenia RPC w panelu Discord — odświeżany przy każdym renderze
    // panelu (element istnieje tylko w tym panelu), z throttlingiem zapytań.
    void this.refreshDiscordRpcStatus();

    // Sensor LED switch & brightness sync
    byId('sw-sensor-led')?.addEventListener('click', () => {
      const val = !(this.form?.sensorLedEnabled !== false);
      this.patchForm({ sensorLedEnabled: val }, false);
      const btn = byId('sw-sensor-led');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    const syncSensorLedBri = (val: number) => {
      this.patchForm({ sensorLedBrightness: val });
      const elVal = byId('val-sensor-led-bri');
      const rng = byId('rng-sensor-led-bri') as HTMLInputElement | null;
      if (elVal) elVal.textContent = `${val}%`;
      if (rng && Number(rng.value) !== val) rng.value = String(val);
    };

    byId('rng-sensor-led-bri')?.addEventListener('input', (e) => syncSensorLedBri(Number((e.target as HTMLInputElement).value)));

    // Color pickery diody: zapis + natychmiastowe przepięcie koloru na sensorze
    const bindLedColor = (inputId: string, key: 'sensorLedDeskColor' | 'sensorLedAwayColor' | 'sensorLedMuteColor') => {
      byId(inputId)?.addEventListener('input', (e) => {
        const val = (e.target as HTMLInputElement).value;
        this.patchForm({ [key]: val });
        void window.api.refreshLed();
      });
    };
    bindLedColor('clr-led-desk', 'sensorLedDeskColor');
    bindLedColor('clr-led-away', 'sensorLedAwayColor');
    bindLedColor('clr-led-mute', 'sensorLedMuteColor');

    byId('sw-pet-filter')?.addEventListener('click', () => {
      const val = !(this.form?.petFilterEnabled ?? true);
      this.patchForm({ petFilterEnabled: val }, false);
      const btn = byId('sw-pet-filter');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    byId('sw-user-input-presence')?.addEventListener('click', () => {
      const val = !(this.form?.userInputPresenceEnabled !== false);
      this.patchForm({ userInputPresenceEnabled: val }, false);
      const btn = byId('sw-user-input-presence');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    byId('sw-auto-tuning')?.addEventListener('click', () => {
      const val = !(this.form?.radarAutoTuningEnabled ?? true);
      this.patchForm({ radarAutoTuningEnabled: val }, false);
      const btn = byId('sw-auto-tuning');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sel-autotune-speed')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as 'balanced' | 'fast' | 'conservative';
      this.patchForm({ radarAutoTuningSpeed: val }, false);
      this.pushToast(`Tempo uczenia auto-tuningu: ${val === 'fast' ? 'szybki' : val === 'conservative' ? 'konserwatywny' : 'zbalansowany'}`);
    });

    byId('sw-signalrgb')?.addEventListener('click', () => {
      const val = !(this.form?.signalrgbEnabled ?? false);
      this.patchForm({ signalrgbEnabled: val }, false);
      const btn = byId('sw-signalrgb');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sel-signalrgb-away-action')?.addEventListener('change', (e) => {
      // Re-render: kolor i przyciemnienie są warunkowe względem wybranej akcji
      this.patchForm({ signalrgbAwayAction: (e.target as HTMLSelectElement).value as any }, true);
    });
    byId('clr-signalrgb-away')?.addEventListener('input', (e) => {
      this.patchForm({ signalrgbAwayColor: (e.target as HTMLInputElement).value });
    });
    byId('rng-signalrgb-bri')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.patchForm({ signalrgbAwayBrightness: v });
      const el = byId('val-signalrgb-bri');
      if (el) el.textContent = `${v}%`;
    });
    byId('sw-signalrgb-restore')?.addEventListener('click', () => {
      const val = !(this.form?.signalrgbRestoreOnDesk !== false);
      this.patchForm({ signalrgbRestoreOnDesk: val }, false);
      const btn = byId('sw-signalrgb-restore');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('btn-test-signalrgb-away')?.addEventListener('click', async () => {
      this.pushToast('Testuję oświetlenie SignalRGB: Odejście…');
      await window.api.signalrgbTestAway();
    });
    byId('btn-test-signalrgb-desk')?.addEventListener('click', async () => {
      this.pushToast('Testuję oświetlenie SignalRGB: Powrót…');
      await window.api.signalrgbTestDesk();
    });

    // Home Assistant (HAOS) Integration Handlers
    byId('sw-ha-enabled')?.addEventListener('click', () => {
      const val = !(this.form?.haEnabled ?? false);
      this.patchForm({ haEnabled: val }, true);
      this.pushToast(val ? 'Włączono integrację Home Assistant (HAOS) 🏠' : 'Wyłączono integrację Home Assistant');
    });

    byId('inp-ha-url')?.addEventListener('input', (e) => {
      this.patchForm({ haUrl: (e.target as HTMLInputElement).value });
    });

    byId('inp-ha-token')?.addEventListener('input', (e) => {
      this.patchForm({ haToken: (e.target as HTMLInputElement).value });
    });

    byId('btn-toggle-ha-token')?.addEventListener('click', () => {
      this.haShowToken = !this.haShowToken;
      const inp = byId('inp-ha-token') as HTMLInputElement | null;
      const btn = byId('btn-toggle-ha-token');
      if (inp) inp.type = this.haShowToken ? 'text' : 'password';
      if (btn) btn.textContent = this.haShowToken ? 'Ukryj 👁️' : 'Pokaż 👁️';
    });

    byId('btn-ha-test')?.addEventListener('click', async () => {
      const url = (byId('inp-ha-url') as HTMLInputElement | null)?.value || this.form?.haUrl;
      const token = (byId('inp-ha-token') as HTMLInputElement | null)?.value || this.form?.haToken;
      this.haTesting = true;
      this.haTestResult = null;
      const fb = byId('ha-test-feedback');
      if (fb) {
        fb.style.color = 'var(--fc-text-muted)';
        fb.textContent = '⏳ Sprawdzam połączenie…';
      }
      try {
        const res = await window.api.haTestConnection({ url, token });
        this.haTestResult = res;
        if (fb) {
          fb.style.color = res.ok ? 'var(--fc-accent-green)' : '#ef4444';
          fb.textContent = res.ok ? `✓ ${res.message || 'Połączono pomyślnie!'}` : `❌ ${res.error || 'Błąd połączenia'}`;
        }
        this.pushToast(res.ok ? 'Połączenie z Home Assistantem nawiązane poprawnie ✓' : `Błąd HAOS: ${res.error}`, !res.ok);
      } catch (err: any) {
        this.haTestResult = { ok: false, error: err.message };
        if (fb) {
          fb.style.color = '#ef4444';
          fb.textContent = `❌ ${err.message}`;
        }
        this.pushToast(`Błąd testu HAOS: ${err.message}`, true);
      } finally {
        this.haTesting = false;
      }
    });

    byId('btn-ha-fetch-entities')?.addEventListener('click', async () => {
      const url = (byId('inp-ha-url') as HTMLInputElement | null)?.value || this.form?.haUrl;
      const token = (byId('inp-ha-token') as HTMLInputElement | null)?.value || this.form?.haToken;
      this.haFetchingEntities = true;
      const fb = byId('ha-test-feedback');
      if (fb) {
        fb.style.color = 'var(--fc-accent-blue)';
        fb.textContent = '⏳ Pobieram encje z Home Assistanta…';
      }
      try {
        const res = await window.api.haFetchEntities({ url, token });
        if (res.ok) {
          this.haBinarySensors = res.binarySensors || [];
          this.haSensors = res.sensors || [];

          const patch: Partial<Snapshot['config']> = {};
          if (res.recommended?.presence && !this.form?.haPresenceEntity) {
            patch.haPresenceEntity = res.recommended.presence;
          }
          if (res.recommended?.distance && !this.form?.haDistanceEntity) {
            patch.haDistanceEntity = res.recommended.distance;
          }
          if (res.recommended?.heartRate && !this.form?.haHeartRateEntity) {
            patch.haHeartRateEntity = res.recommended.heartRate;
          }
          if (res.recommended?.breathRate && !this.form?.haBreathRateEntity) {
            patch.haBreathRateEntity = res.recommended.breathRate;
          }
          if (Object.keys(patch).length > 0) {
            this.patchForm(patch, true);
          } else {
            this.render();
          }
          this.pushToast(`Pobrano ${this.haBinarySensors.length} binarnych i ${this.haSensors.length} sensorów z HAOS ✓`);
        } else {
          if (fb) {
            fb.style.color = '#ef4444';
            fb.textContent = `❌ ${res.error || 'Błąd pobierania'}`;
          }
          this.pushToast(`Błąd pobierania encji: ${res.error}`, true);
        }
      } catch (err: any) {
        this.pushToast(`Błąd pobierania encji z HAOS: ${err.message}`, true);
      } finally {
        this.haFetchingEntities = false;
      }
    });

    byId('inp-ha-presence')?.addEventListener('input', (e) => {
      this.patchForm({ haPresenceEntity: (e.target as HTMLInputElement).value });
    });
    byId('inp-ha-distance')?.addEventListener('input', (e) => {
      this.patchForm({ haDistanceEntity: (e.target as HTMLInputElement).value });
    });
    byId('inp-ha-heart')?.addEventListener('input', (e) => {
      this.patchForm({ haHeartRateEntity: (e.target as HTMLInputElement).value });
    });
    byId('inp-ha-breath')?.addEventListener('input', (e) => {
      this.patchForm({ haBreathRateEntity: (e.target as HTMLInputElement).value });
    });

    // Radar Gate Drag Handles (interaktywna regulacja strefy fotela na grafice)
    const bindScopeHandleDrag = (handleId: string, which: 'min' | 'max') => {
      const handle = byId(handleId);
      const track = document.querySelector('.fc-scope-track') as HTMLElement | null;
      if (!handle || !track) return;
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        track.classList.add('dragging');
        const move = (ev: PointerEvent) => {
          const rect = track.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
          const cm = Math.max(10, Math.min(200, Math.round((pct * 200) / 5) * 5));
          if (which === 'min') {
            const max = (this.form?.radarMaxDistanceCm ?? 110) - 10;
            const v = Math.max(10, Math.min(cm, max));
            this.patchForm({ radarMinDistanceCm: v });
          } else {
            const min = (this.form?.radarMinDistanceCm ?? 40) + 10;
            const v = Math.max(min, Math.min(cm, 200));
            this.patchForm({ radarMaxDistanceCm: v });
          }
        };
        const up = (ev: PointerEvent) => {
          const el = ev.currentTarget as HTMLElement;
          track.classList.remove('dragging');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    };
    bindScopeHandleDrag('scope-handle-min', 'min');
    bindScopeHandleDrag('scope-handle-max', 'max');

    byId('btn-scope-reset-gate')?.addEventListener('click', () => {
      this.patchForm({ radarMinDistanceCm: 40, radarMaxDistanceCm: 110 });
      this.pushToast('Przywrócono domyślną strefę fotela (40–110 cm)');
    });

    // Radar port & timeouts
    byId('sel-port')?.addEventListener('change', (e) => {
      this.patchForm({ port: (e.target as HTMLSelectElement).value });
    });
    byId('fc-btn-refresh-ports')?.addEventListener('click', async () => {
      this.ports = await window.api.getPorts();
      this.refreshPortSelectOptions();
      this.pushToast('Odświeżono listę portów COM');
    });
    byId('inp-timeout-away')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v)) this.patchForm({ timeoutAwayMs: v });
    });
    byId('inp-timeout-desk')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v)) this.patchForm({ timeoutDeskMs: v });
    });
    byId('sel-radar-smoothing')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as 'ultra' | 'balanced' | 'raw';
      this.patchForm({ radarSmoothingMode: val }, false);
      this.pushToast(`Filtr DSP: ${val === 'ultra' ? 'Ultra-Stabilny 🛡️' : val === 'balanced' ? 'Zbalansowany' : 'Szybki'}`);
    });
    byId('sw-deep-away')?.addEventListener('click', () => {
      const val = !(this.form?.radarDeepAwayConfirm !== false);
      this.patchForm({ radarDeepAwayConfirm: val }, false);
      const btn = byId('sw-deep-away');
      if (btn) {
        btn.classList.toggle('active', val);
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('inp-deep-away-min')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v) && v >= 1) this.patchForm({ radarDeepAwayMinMs: Math.round(v * 60000) });
    });
    byId('inp-deep-away-confirm')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v) && v >= 1) this.patchForm({ radarDeepAwayConfirmMs: Math.round(v * 1000) });
    });
    byId('btn-diag-record')?.addEventListener('click', async () => {
      const btn = byId('btn-diag-record');
      try {
        const res = await window.api.diagRecord();
        if (res.active) {
          if (btn) btn.textContent = `Stop (${Math.round(res.durationSec / 60)} min)`;
          this.pushToast(`Nagrywam surowy strumień przez ${Math.round(res.durationSec / 60)} min — pracuj normalnie lub wykonaj testowany scenariusz`);
          return;
        }
        if (btn) btn.textContent = 'Start';
        await window.api.openTextInNotepad(`${res.summary}\n\n=== CSV ===\n${res.csv}`);
        this.pushToast(`Pomiar gotowy: ${res.sampleCount} ramek — raport otwarty w Notatniku`);
      } catch {
        if (btn) btn.textContent = 'Start';
        this.pushToast('Pomiar sensora nieudany — sprawdź logi');
      }
    });
    byId('sel-mute-behavior')?.addEventListener('change', (e) => {
      this.patchForm({ muteBehaviorOnAway: (e.target as HTMLSelectElement).value as any });
    });

    // Mic Switching rules
    byId('sw-switch-desk')?.addEventListener('click', () => {
      const val = !(this.form?.switchMicOnDesk !== false);
      this.patchForm({ switchMicOnDesk: val }, false);
      const btn = byId('sw-switch-desk');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-switch-away')?.addEventListener('click', () => {
      const val = !(this.form?.switchMicOnAway !== false);
      this.patchForm({ switchMicOnAway: val }, false);
      const btn = byId('sw-switch-away');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-unmute-desk')?.addEventListener('click', () => {
      const val = !(this.form?.unmuteOnDesk !== false);
      this.patchForm({ unmuteOnDesk: val }, false);
      const btn = byId('sw-unmute-desk');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    // System & Chime
    byId('sw-autostart')?.addEventListener('click', () => {
      const val = !(this.form?.autoStart ?? false);
      this.patchForm({ autoStart: val }, false);
      const btn = byId('sw-autostart');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-sleep-monitors')?.addEventListener('click', () => {
      const val = !(this.form?.sleepMonitorsOnAway ?? false);
      this.patchForm({ sleepMonitorsOnAway: val }, true);
    });
    byId('sw-screensaver')?.addEventListener('click', () => {
      const val = !(this.form?.screensaverOnAway ?? true);
      this.patchForm({ screensaverOnAway: val }, false);
      const btn = byId('sw-screensaver');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sel-screensaver-delay')?.addEventListener('change', (e) => {
      const v = Number((e.target as HTMLSelectElement).value) || 60000;
      this.patchForm({ screensaverDelayMs: v }, false);
    });
    byId('sel-sleep-monitors-delay')?.addEventListener('change', (e) => {
      const v = Number((e.target as HTMLSelectElement).value) || 600000;
      this.patchForm({ sleepMonitorsDelayMs: v }, false);
    });
    byId('sw-wake-monitors')?.addEventListener('click', () => {
      const val = !(this.form?.wakeMonitorsOnDesk ?? true);
      this.patchForm({ wakeMonitorsOnDesk: val }, false);
      const btn = byId('sw-wake-monitors');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('btn-test-screensaver')?.addEventListener('click', async () => {
      this.pushToast('Uruchamiam test czarnego wygaszacza (ruch myszy zdejmuje ekran)…');
      try {
        await window.api.screensaverStart();
      } catch (err) {
        this.pushToast(`Błąd testu wygaszacza: ${(err as Error).message}`, true);
      }
    });
    byId('sw-audio-chime')?.addEventListener('click', () => {
      const val = !(this.form?.audioChime ?? true);
      this.patchForm({ audioChime: val }, false);
      const btn = byId('sw-audio-chime');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-chime-desk')?.addEventListener('click', () => {
      const val = !(this.form?.audioChimeOnDesk !== false);
      this.patchForm({ audioChimeOnDesk: val }, false);
      const btn = byId('sw-chime-desk');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-chime-away')?.addEventListener('click', () => {
      const val = !(this.form?.audioChimeOnAway !== false);
      this.patchForm({ audioChimeOnAway: val }, false);
      const btn = byId('sw-chime-away');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sel-chime-style')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as ChimeStyle;
      // Styl trafia do configu — bez zapisu wybór "resetował" się po restarcie
      this.patchForm({ audioChimeStyle: val });
      playChime('desk', this.form?.audioChimeVolume ?? 0.2, this.selectedChimeStyle);
      this.pushToast('Wybrano i przetestowano styl powiadomienia Chime');
    });
    byId('btn-test-chime')?.addEventListener('click', () => {
      playChime('desk', this.form?.audioChimeVolume ?? 0.2, this.selectedChimeStyle);
    });
    byId('rng-chime-volume')?.addEventListener('input', (e) => {
      const v = Math.max(0, Math.min(100, Number((e.target as HTMLInputElement).value)));
      this.patchForm({ audioChimeVolume: v / 100 });
      const elVal = byId('val-chime-volume');
      if (elVal) elVal.textContent = `${v}%`;
      playChime('desk', v / 100, this.selectedChimeStyle);
    });

    // Własne pliki audio (Stacjonarny / Słuchawki) — wybór, test, czyszczenie
    const bindCustomAudio = (variant: 'desk' | 'headset') => {
      const configKey = variant === 'desk' ? 'audioFileDesk' : 'audioFileHeadset';
      byId(`btn-pick-audio-${variant}`)?.addEventListener('click', async () => {
        const picked = await window.api.pickAudioFile();
        if (!picked) return;
        this.patchForm({ [configKey]: picked });
        this.render();
        playCustomAudioFile(picked, variant === 'desk' ? 'desk' : 'headset', this.form?.audioChimeVolume ?? 0.2);
        this.pushToast('Ustawiono własny dźwięk — przetestowany 🎵');
      });
      byId(`btn-test-audio-${variant}`)?.addEventListener('click', () => {
        const file = variant === 'desk' ? this.form?.audioFileDesk : this.form?.audioFileHeadset;
        if (file) playCustomAudioFile(file, variant === 'desk' ? 'desk' : 'headset', this.form?.audioChimeVolume ?? 0.2);
      });
      byId(`btn-clear-audio-${variant}`)?.addEventListener('click', () => {
        this.patchForm({ [configKey]: '' });
        this.render();
        this.pushToast('Przywrócono syntezowany chime 🔔');
      });
    };
    bindCustomAudio('desk');
    bindCustomAudio('headset');

    // Logs Filtering & Search
    document.querySelectorAll<HTMLElement>('[data-log-filter]').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        const filter = (e.currentTarget as HTMLElement).getAttribute('data-log-filter') as any;
        if (filter) {
          this.logFilter = filter;
          document.querySelectorAll('[data-log-filter]').forEach((c) => c.classList.remove('active'));
          (e.currentTarget as HTMLElement).classList.add('active');
          this.refreshLogConsoleDOM();
        }
      });
    });

    byId('inp-log-search')?.addEventListener('input', (e) => {
      this.logSearch = (e.target as HTMLInputElement).value;
      this.refreshLogConsoleDOM();
    });

    byId('fc-btn-copy-diag-report')?.addEventListener('click', async () => {
      const snap = this.snap;
      const form = this.form;
      const fullLogs = await window.api.getLogs();
      const logsToInclude = fullLogs && fullLogs.length > 0 ? fullLogs : this.logs;
      // Raport domyślnie zawiera to, co użytkownik widzi w konsoli logów
      // (aktywna zakładka: Audio & VU, Discord & RGB itd. + wyszukiwarka).
      const visibleLogs = this.applyLogFilter(logsToInclude);
      const filterNames: Record<string, string> = {
        all: 'Wszystkie',
        radar: 'Radar & DSP',
        haos: 'HAOS',
        audio: 'Audio & VU',
        discord: 'Discord & RGB',
        error: 'Błędy'
      };
      const activeFilterName = filterNames[this.logFilter] || 'Wszystkie';

      // Kluczowe zdarzenia audio, przełączania, błędów i radar-event z widocznego zbioru
      const keyEvents = visibleLogs.filter((l) =>
        /\[(AUDIO-|SWITCH-|APP-|RADAR-EVENT|WARN|ERROR)/i.test(l)
      );

      // Ostatnie próbki telemetryczne dla podglądu działania radaru —
      // 200 ramek z odfiltrowanym szumem (duplikaty lux, powtórki bez zmiany wartości).
      const stripTs = (l: string) => l.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/\x1B\[[0-9;]*m/g, '').trim();
      const isNoiseRaw = (l: string) => /bh1750\.sensor|Illuminance|illuminance/i.test(l);
      const dspVal = (l: string) => {
        const m = l.match(/\[RADAR-DSP\]\s*(Tętno|Oddech|Dystans|Światło):\s*([\d.]+)/);
        return m ? `${m[1]}:${m[2]}` : null;
      };
      const filteredTelemetry: string[] = [];
      let lastRawNorm = '';
      let lastDspSig: string | null = null;
      for (const l of logsToInclude) {
        // Zdarzenia kluczowe zawsze wchodzą (rzadkie, nośne)
        if (/\[(RADAR-EVENT|RADAR-AMBIG|SWITCH-|AUDIO-|WARN|ERROR|APP-)/i.test(l)) {
          filteredTelemetry.push(l);
          continue;
        }
        // Przetworzony sygnał: trzymamy tylko gdy zmieniła się wartość wyjściowa
        if (/\[RADAR-DSP/i.test(l)) {
          const sig = dspVal(l);
          if (sig && sig !== lastDspSig) {
            filteredTelemetry.push(l);
            lastDspSig = sig;
          }
          continue;
        }
        // Surowe ramki: bez luxa i bez identycznych powtórek
        if (/\[RADAR-RAW/i.test(l)) {
          if (isNoiseRaw(l)) continue;
          const norm = stripTs(l);
          if (norm && norm !== lastRawNorm) {
            filteredTelemetry.push(l);
            lastRawNorm = norm;
          }
          continue;
        }
      }
      const recentTelemetry = filteredTelemetry.slice(-200);

      const report = [
        `# Raport Diagnostyczny DeskSense (dla Agenta AI / Programisty)`,
        `Data wygenerowania: ${new Date().toLocaleString('pl-PL')}`,
        `Wersja: v${snap?.version || '0.3.0'} | Tryb pracy: ${snap?.mode || 'auto'} | Aktywny profil: ${snap?.state === 'desk' ? 'Stacjonarny (Biurko)' : 'Mobilny (Słuchawki)'}`,
        ``,
        `## 📡 Radar mmWave & Stan Obecności`,
        `- Aktywne źródło: ${snap?.ha?.activeSource === 'ha' ? 'Home Assistant OS' : 'USB COM Port'}`,
        `- Stan obecności (Presence): ${snap?.radar?.presence ? 'OBECNY PRZY BIURKU (true)' : 'POZA FOTELEM (false)'}`,
        `- Dystans live: ${this.telemetry.distanceCm ?? '--'} cm (strefa: ${form?.radarMinDistanceCm ?? 40} - ${form?.radarMaxDistanceCm ?? 110} cm, bramka: ${form?.radarDistanceGateEnabled ? 'WŁ' : 'WYŁ'})${this.telemetry.distanceTrusted === false ? ' | CEL NIEPEWNY (kot?)' : ''} | Cele: ${this.telemetry.targetCount ?? '—'}`,
        `- Biometria live: Tętno: ${this.telemetry.heartRate ?? '--'} BPM | Oddech: ${this.telemetry.breathRate ?? '--'} RPM`,
        `- Oświetlenie: ${typeof this.telemetry.illuminanceLux === 'number' ? `${this.telemetry.illuminanceLux} lx` : '--'}`,
        `- Port USB: ${snap?.radar?.port || form?.port || 'auto'} (baud: ${form?.baudRate || 115200})`,
        ``,
        `## 🎙️ Konfiguracja Audio & Urządzenia Windows`,
        `- Profil Stacjonarny (Biurko): "${form?.micDeskName || 'nie wybrano'}" (Głośność: ${form?.micDeskVolume ?? 100}%, Auto-Switch: ${form?.switchMicOnDesk !== false ? 'TAK' : 'NIE'})`,
        `- Profil Mobilny (Słuchawki): "${form?.micHeadsetName || 'nie wybrano'}" (Głośność: ${form?.micHeadsetVolume ?? 100}%, Auto-Switch: ${form?.switchMicOnAway !== false ? 'TAK' : 'NIE'})`,
        `- Aktualnie domyślny mikrofon Windows: "${this.audioDevices.find((d) => d.isDefault)?.name || 'brak'}"`,
        `- Wykryte mikrofony w systemie (${this.audioDevices.length}):`,
        ...this.audioDevices.map(
          (d) => `  * "${d.name}" [ID: ${d.id || 'n/a'}] ${d.isDefault ? ' ⭐ [DOMYŚLNY]' : ''} ${d.isMuted ? ' 🔇 [MUTED]' : ' 🔊 [UNMUTED]'} (vol: ${d.volume ?? '--'}%)`
        ),
        ``,
        `## 🔌 Integracje Zewnętrzne`,
        `- Home Assistant: ${form?.haEnabled ? `Włączony (${snap?.ha?.connected ? 'Połączono' : 'Brak połączenia'})` : 'Wyłączony'}`,
        `- Discord: ${form?.discordIntegration ? 'Włączony' : 'Wyłączony'} (Auto-Próg VAD: ${form?.discordGateFollowMic ? 'TAK' : 'NIE'})`,
        `- SignalRGB: ${form?.signalrgbEnabled ? 'Włączony' : 'Wyłączony'}`,
        ``,
        `## ⚡ Oś Czasu Kluczowych Zdarzeń (Przełączanie, Audio, Zmiany Stanu) [${keyEvents.length} wpisów, widok logów: ${activeFilterName}]`,
        '```',
        keyEvents.length > 0 ? keyEvents.join('\n') : 'Brak zarejestrowanych zdarzeń przełączania w buforze.',
        '```',
        ``,
        `## 🌊 Ostatnia Próbka Strumienia Radaru (Ostatnie 200 ramek, bez szumu)`,
        '```',
        recentTelemetry.length > 0 ? recentTelemetry.join('\n') : 'Brak ramek telemetrycznych.',
        '```'
      ].join('\n');

      await window.api.copyToClipboard(report);
      this.pushToast('Skopiowano idealny raport diagnostyczny dla Agenta AI! 🤖📋');
    });

    byId('fc-btn-open-notepad')?.addEventListener('click', async () => {
      const ok = await window.api.openLogsInNotepad();
      if (ok) {
        this.pushToast('Otwarto wszystkie surowe logi w Notatniku 📝');
      } else {
        this.pushToast('Nie udało się uruchomić Notatnika', true);
      }
    });

    byId('fc-btn-copy-logs')?.addEventListener('click', async () => {
      try {
        const fullLogs = await window.api.getLogs();
        const logs = fullLogs && fullLogs.length > 0 ? fullLogs : this.logs;
        // Kopiujemy to, co widoczne w konsoli (aktywna zakładka + wyszukiwarka)
        const visible = this.applyLogFilter(logs || []);
        if (!visible || visible.length === 0) {
          this.pushToast('Brak logów do skopiowania dla aktywnego filtru');
          return;
        }
        await window.api.copyToClipboard(visible.join('\r\n'));
        const scope = this.logFilter === 'all' && !this.logSearch ? 'WSZYSTKIE' : 'widoczne (aktywny filtr)';
        this.pushToast(`Skopiowano logi RAW — ${scope} (${visible.length} linii) 📋`);
      } catch (err: any) {
        this.pushToast(`Błąd kopiowania: ${err.message}`, true);
      }
    });
    byId('fc-btn-clear-logs')?.addEventListener('click', async () => {
      await window.api.clearLogs();
      this.logs = [];
      this.refreshLogConsoleDOM();
      this.pushToast('Wyczyszczono logi');
    });

    // Firmware & Flasher MR60BHA2 (limengdu/MR60BHA2_ESPHome_external_components)
    byId('btn-open-stock-bin')?.addEventListener('click', () => {
      void window.api.openExternal('https://github.com/limengdu/MR60BHA2_ESPHome_external_components/releases');
      this.pushToast('Otwieram Releases z binarkami firmware…');
    });
    byId('btn-open-seeed-wiki')?.addEventListener('click', () => {
      void window.api.openExternal('https://limengdu.github.io/MR60BHA2_ESPHome_external_components/');
      this.pushToast('Otwieram Web Flasher ESPHome…');
    });
    byId('btn-open-seeed-gh')?.addEventListener('click', () => {
      void window.api.openExternal('https://github.com/limengdu/MR60BHA2_ESPHome_external_components');
      this.pushToast('Otwieram repozytorium GitHub ESPHome…');
    });

    // Updates & About
    byId('fc-btn-check-updates')?.addEventListener('click', async () => {
      this.pushToast('Sprawdzam aktualizacje na GitHubie…');
      try {
        const res = await window.api.checkForUpdates();
        if (res.available && res.updateInfo) {
          this.pushToast(`Dostępna nowa wersja: v${res.updateInfo.version}`);
        } else {
          this.pushToast('Aplikacja jest aktualna ✓');
        }
      } catch (err: any) {
        this.pushToast(`Błąd: ${err.message}`, true);
      }
    });

    byId('btn-download-update')?.addEventListener('click', async () => {
      this.pushToast('Pobieranie aktualizacji…');
      try {
        await window.api.downloadUpdate();
      } catch (err: any) {
        this.pushToast(`Błąd pobierania: ${err.message}`, true);
      }
    });

    byId('btn-install-update')?.addEventListener('click', async () => {
      try {
        await window.api.installUpdate();
      } catch (err: any) {
        this.pushToast(`Błąd instalacji: ${err.message}`, true);
      }
    });

    byId('btn-run-full-diag')?.addEventListener('click', () => {
      this.diagModalOpen = true;
      this.render();
    });

    byId('fc-btn-open-conf-dir')?.addEventListener('click', () => window.api.openConfigDir());

    // QoL: Profile JSON Export
    byId('fc-btn-copy-profile')?.addEventListener('click', async () => {
      if (!this.form) return;
      await window.api.copyToClipboard(JSON.stringify(this.form, null, 2));
      this.pushToast('Konfiguracja profilu skopiowana do schowka (JSON) ✓');
    });

    // Save & Reset bottom bar
    byId('fc-btn-save')?.addEventListener('click', () => this.save());
    byId('fc-btn-reset-defaults')?.addEventListener('click', async () => {
      if (confirm('Przywrócić wszystkie ustawienia do wartości domyślnych?')) {
        this.snap = await window.api.resetConfig();
        this.form = { ...this.snap.config };
        this.dirty = false;
        this.pushToast('Przywrócono ustawienia domyślne ✓');
        this.render();
      }
    });

    // Wizard Modals
    byId('btn-wizard-close')?.addEventListener('click', () => this.closeCalibrationWizard());
    byId('btn-wizard-cancel')?.addEventListener('click', () => this.closeCalibrationWizard());
    byId('btn-wizard-back')?.addEventListener('click', () => {
      if (this.wizardStep > 1) {
        this.wizardStep--;
        if (this.wizardInterval) clearInterval(this.wizardInterval);
        this.wizardInterval = null;
        this.wizardCountdown = 0;
        this.render();
      }
    });
    byId('wizard-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'wizard-overlay') this.closeCalibrationWizard();
    });
    byId('btn-run-step-1')?.addEventListener('click', () => this.runWizardStep1());
    byId('btn-run-step-2')?.addEventListener('click', () => this.runWizardStep2());
    byId('btn-wizard-apply')?.addEventListener('click', () => this.applyWizardCalibration());

    // Diagnostics Modal
    byId('btn-diag-close')?.addEventListener('click', () => { this.diagModalOpen = false; this.render(); });
    byId('btn-diag-cancel')?.addEventListener('click', () => { this.diagModalOpen = false; this.render(); });
    byId('diag-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'diag-overlay') { this.diagModalOpen = false; this.render(); }
    });

    // Sesja diagnostyczna "Wyjście z pokoju"
    byId('fc-header-diag-btn')?.addEventListener('click', () => void this.toggleDiagSession());
    byId('btn-diag-session-close')?.addEventListener('click', () => { this.diagReportModalOpen = false; this.render(); });
    byId('btn-diag-session-cancel')?.addEventListener('click', () => { this.diagReportModalOpen = false; this.render(); });
    byId('diag-session-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'diag-session-overlay') { this.diagReportModalOpen = false; this.render(); }
    });
    byId('btn-diag-session-copy')?.addEventListener('click', async () => {
      await window.api.copyToClipboard(this.diagSessionText);
      this.pushToast('Raport skopiowany do schowka 🤖');
    });
    byId('btn-diag-session-notepad')?.addEventListener('click', async () => {
      const ok = await window.api.openTextInNotepad(this.diagSessionText);
      this.pushToast(ok ? 'Otwarto raport w Notatniku 📝' : 'Nie udało się uruchomić Notatnika', !ok);
    });
  }

  /** Start/stop sesji diagnostycznej; stop otwiera modal z zebranymi logami. */
  private async toggleDiagSession(): Promise<void> {
    if (!this.diagActive) {
      await window.api.diagStart();
      this.diagActive = true;
      this.pushToast('Sesja diagnostyczna rozpoczęta — nagrajmy, co się dzieje po wyjściu…');
      this.updateHeaderAndLiveDOM();
      return;
    }

    const report = await window.api.diagStop();
    this.diagActive = false;
    this.updateHeaderAndLiveDOM();
    if (!report) {
      this.pushToast('Brak aktywnej sesji diagnostycznej', true);
      return;
    }
    this.diagSessionText = report.text;
    this.diagReportModalOpen = true;
    this.render();
  }
}

function bootstrap() {
  const root = document.getElementById('root');
  if (root) {
    const app = new AppUI(root);
    void app.init().catch((err) => {
      console.error('[DeskSense] Błąd krytyczny podczas startu AppUI:', err);
    });
  } else {
    console.error('[DeskSense] Nie znaleziono kontenera #root w dokumencie HTML.');
  }
}

// Obsługa błędów globalnych w rendererze
window.addEventListener('error', (e) => {
  console.error('[DeskSense Renderer Error]:', e.error || e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[DeskSense Renderer Unhandled Rejection]:', e.reason);
});

// Bezpieczne uruchomienie: jeśli DOM jest już załadowany (np. skrypty modułowe), uruchom od razu
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
