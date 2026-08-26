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

  // QoL: Ergonomics Session Timer & Auto-Switch Snooze
  private sessionSeconds = 0;
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
    heartRate: 0,
    breathRate: 0,
    illuminanceLux: undefined,
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
  private diagModalOpen = false;
  private logs: string[] = [];

  private lastDeviceSig = '';
  private lastPortSig = '';

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

    try {
      this.isMaximized = await window.api.isWindowMaximized();
    } catch (_) {}

    try {
      this.logs = (await window.api.getLogs()) || [];
    } catch (_) {}

    const upd = await window.api.getUpdaterStatus();
    if (upd) this.updater = upd;

    window.api.onEvent((e: PushEvent) => this.handleEvent(e));

    this.lastDeviceSig = this.deviceListSig(this.audioDevices);
    this.lastPortSig = this.portListSig(this.ports);

    // Initialize VAD gate thresholds in engine
    this.vuEngine.deskGateDb = this.form.micDeskGateDb ?? -45;
    this.vuEngine.headGateDb = this.form.micHeadsetGateDb ?? -45;

    // Start Live Audio VU-Meter if window is visible
    void this.vuEngine.start(this.form.micDeskName, this.form.micHeadsetName);

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

    // Session health ticker (every 1s)
    setInterval(() => {
      if (this.snap?.state === 'desk') {
        this.sessionSeconds++;
        this.updateSessionHUD();
      } else if (this.sessionSeconds > 0) {
        if (this.sessionSeconds > 120) {
          this.sessionSeconds = 0;
          this.updateSessionHUD();
        }
      }

      // Snooze timer tick
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

    this.render();

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (this.wizardOpen) {
          ev.preventDefault();
          this.closeCalibrationWizard();
        } else if (this.vadModalOpen) {
          ev.preventDefault();
          this.closeVadModal();
        } else if (this.bioModalOpen || this.diagModalOpen) {
          ev.preventDefault();
          this.bioModalOpen = false;
          this.diagModalOpen = false;
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
      if (!this.dirty) {
        this.form = { ...e.snapshot.config };
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
        } else if (this.wizardStep === 3) {
          if (this.telemetry.heartRate) this.wizardSamples.heartRates.push(this.telemetry.heartRate);
          if (this.telemetry.breathRate) this.wizardSamples.breathRates.push(this.telemetry.breathRate);
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
          playChime(e.state, this.form.audioChimeVolume ?? 0.2, this.selectedChimeStyle);
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

  private updateSessionHUD() {
    const el = document.getElementById('fc-header-health-timer');
    if (!el) return;
    const mins = Math.floor(this.sessionSeconds / 60);
    const isLong = mins >= 60;
    el.className = `fc-health-timer ${isLong ? 'warn' : ''}`;
    el.innerHTML = isLong ? `⚠️ W fotelu: ${mins} min (Zrób przerwę!)` : `🪑 W fotelu: ${mins} min`;
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

    this.updateTelemetryDOM();
    this.updateSessionHUD();
  }

  private updateTelemetryDOM() {
    const elDist = document.getElementById('card-val-distance');
    const elHeart = document.getElementById('card-val-heart');
    const elBreath = document.getElementById('card-val-breath');
    const elLux = document.getElementById('card-val-lux');
    const elPerson = document.getElementById('card-badge-person');

    if (elDist) {
      if (this.telemetry.distanceCm && this.telemetry.distanceCm > 0) {
        elDist.textContent = `${this.telemetry.distanceCm} cm`;
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
        elPerson.textContent = '👤 Właściciel ✓';
      } else if (p === 'pet') {
        elPerson.textContent = '🐾 Zwierzę (Kot/Pies)';
      } else if (p === 'other') {
        elPerson.textContent = '👥 Inna osoba';
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
      if (elTunDist) elTunDist.textContent = tun.adaptedDistanceCenter ? `${tun.adaptedDistanceCenter} cm` : '75 cm';
      if (elTunStability) elTunStability.textContent = `Stabilność: ${tun.stabilityScore ?? 92}% ✓`;
    }
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

    if (userPin && userBadge && userLine) {
      const curDist = this.telemetry.distanceCm;
      if (curDist && curDist > 0) {
        const userPct = Math.max(0, Math.min(100, (curDist / maxScale) * 100));
        const isInside = curDist >= minGate && curDist <= maxGate;

        userPin.style.display = 'flex';
        userPin.style.left = `${userPct}%`;

        userBadge.className = `fc-scope-user-badge ${isInside ? '' : 'outside'}`;
        userBadge.innerHTML = isInside ? `● Ty: ${curDist} cm ✓` : `⚠️ ${curDist} cm (Poza strefą)`;

        userLine.className = `fc-scope-user-line ${isInside ? '' : 'outside'}`;

        if (liveStatusText) {
          liveStatusText.innerHTML = isInside
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

  private refreshLogConsoleDOM() {
    const c = document.getElementById('log-console');
    if (!c) return;

    let filtered = this.logs;
    if (this.logFilter === 'radar') filtered = filtered.filter((l) => l.toLowerCase().includes('radar') || l.toLowerCase().includes('serial') || l.toLowerCase().includes('dsp'));
    if (this.logFilter === 'haos') filtered = filtered.filter((l) => l.toLowerCase().includes('haos') || l.toLowerCase().includes('ha'));
    if (this.logFilter === 'audio') filtered = filtered.filter((l) => l.toLowerCase().includes('audio') || l.toLowerCase().includes('mic') || l.toLowerCase().includes('vu'));
    if (this.logFilter === 'discord') filtered = filtered.filter((l) => l.toLowerCase().includes('discord') || l.toLowerCase().includes('vad') || l.toLowerCase().includes('signalrgb'));
    if (this.logFilter === 'error') filtered = filtered.filter((l) => l.toLowerCase().includes('err') || l.toLowerCase().includes('błąd') || l.toLowerCase().includes('warn') || l.toLowerCase().includes('error'));

    if (this.logSearch) {
      const q = this.logSearch.toLowerCase();
      filtered = filtered.filter((l) => l.toLowerCase().includes(q));
    }

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
      if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
      this.pushToast(`Zastosowano próg Discord dla Mikrofonu Biurkowego: ${val} dB ✓`);
    } else {
      this.patchForm({ micHeadsetGateDb: val }, true);
      if (this.snap?.state === 'headset' && this.form?.discordIntegration) {
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

        playChime('desk', 0.25, this.selectedChimeStyle);
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
            <!-- QoL: Ergonomics Session Timer -->
            <span class="fc-health-timer" id="fc-header-health-timer" title="Czas ciągłej obecności w fotelu (Wygoda & Zdrowie)">
              🪑 W fotelu: ${Math.floor(this.sessionSeconds / 60)} min
            </span>

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
        ${this.bioModalOpen ? this.renderBioModal() : ''}
        ${this.diagModalOpen ? this.renderDiagModal() : ''}

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

  // ---------- COMPLETE ALL-IN-ONE HOME DASHBOARD ----------
  private renderHomeTab(): string {
    if (!this.snap || !this.form) return '';
    const form = this.form;
    const snap = this.snap;
    const deskVol = this.initVolumePercent(form.micDeskName, form.micDeskVolume);
    const headVol = this.initVolumePercent(form.micHeadsetName, form.micHeadsetVolume);
    const person = this.telemetry.detectedPerson || 'unknown';
    const chimeVol = Math.round((form.audioChimeVolume ?? 0.2) * 100);

    const defaultMic = this.audioDevices.find((d) => d.isDefault)?.name;
    const isDeskActive = snap.state === 'desk' || (!snap.state && defaultMic && form.micDeskName && defaultMic.toLowerCase().includes(form.micDeskName.toLowerCase()));
    const isHeadsetActive = snap.state === 'headset' || (!snap.state && defaultMic && form.micHeadsetName && defaultMic.toLowerCase().includes(form.micHeadsetName.toLowerCase()));

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
            <div class="fc-card ${isDeskActive ? 'highlight active-mic' : ''}">
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

                <!-- Windows Volume Slider -->
                <div class="fc-slider-row" style="margin-top: 4px">
                  <span style="font-size: 10px; color: var(--fc-text-muted)" title="Głośność Windows">🔊 Głośność:</span>
                  <input type="range" class="fc-slider" id="rng-vol-desk" min="0" max="100" step="5" value="${deskVol}" />
                  <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-vol-desk">${deskVol}%</span>
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
                  <div class="fc-metric-large" id="metric-vol-desk">${deskVol} %</div>
                  <div class="fc-metric-sub">Głośność Windows</div>
                </div>
                <span class="fc-badge ${isDeskActive ? 'calibrated' : 'muted'}">${isDeskActive ? 'Domyślny ✓' : 'Gotowy'}</span>
              </div>
            </div>

            <!-- Card 2: Mikrofon Mobilny (Słuchawki / Headset) -->
            <div class="fc-card ${isHeadsetActive ? 'highlight active-mic' : ''}">
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

                <!-- Windows Volume Slider -->
                <div class="fc-slider-row" style="margin-top: 4px">
                  <span style="font-size: 10px; color: var(--fc-text-muted)" title="Głośność Windows">🔊 Głośność:</span>
                  <input type="range" class="fc-slider" id="rng-vol-headset" min="0" max="100" step="5" value="${headVol}" />
                  <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-vol-headset">${headVol}%</span>
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
                  <div class="fc-metric-large" id="metric-vol-headset">${headVol} %</div>
                  <div class="fc-metric-sub">Głośność Windows</div>
                </div>
                <span class="fc-badge ${isHeadsetActive ? 'calibrated' : 'muted'}">${isHeadsetActive ? 'Domyślny ✓' : 'Rezerwa'}</span>
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
              <span class="fc-info-badge" title="Pełny radar Seeed MR60BHA2 — regulacja granic fotela, odcinanie tła oraz czasy reakcji">?</span>
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

            <!-- Quick Presets -->
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--fc-card-border); padding-top: 8px">
              <span style="font-size: 11px; color: var(--fc-text-secondary)">Gotowe presety fotela:</span>
              <div class="fc-scope-presets">
                <button class="fc-preset-pill" id="preset-gate-close">🪑 Bliski (35–90 cm)</button>
                <button class="fc-preset-pill" id="preset-gate-std">🛋️ Standard (40–110 cm)</button>
                <button class="fc-preset-pill" id="preset-gate-deep">🎮 Głęboki (50–140 cm)</button>
                <button class="fc-preset-pill" id="preset-gate-fit" style="color: var(--fc-accent-green); border-color: rgba(114, 227, 57, 0.4)">🎯 Dopasuj do mnie</button>
              </div>
            </div>

            <!-- Dual Range Inputs directly under the Scope -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 8px">
              <div style="background: var(--fc-bg-darker); padding: 8px 10px; border-radius: var(--fc-radius-sm); border: 1px solid var(--fc-card-border)">
                <div class="fc-micro-label">
                  <span>Początek strefy fotela (Min):</span>
                  <strong style="color: #fff" id="lbl-gate-min">${minGate} cm</strong>
                </div>
                <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px">
                  <input type="range" class="fc-slider" id="rng-scope-gate-min" min="15" max="140" step="5" value="${minGate}" />
                  <input type="number" class="fc-input" id="inp-gate-min" value="${minGate}" style="width: 62px; height: 26px; font-size: 11px" min="10" max="200" />
                </div>
              </div>

              <div style="background: var(--fc-bg-darker); padding: 8px 10px; border-radius: var(--fc-radius-sm); border: 1px solid var(--fc-card-border)">
                <div class="fc-micro-label">
                  <span>Koniec strefy fotela (Max / Odcięcie):</span>
                  <strong style="color: #fff" id="lbl-gate-max">${maxGate} cm</strong>
                </div>
                <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px">
                  <input type="range" class="fc-slider" id="rng-scope-gate-max" min="40" max="200" step="5" value="${maxGate}" />
                  <input type="number" class="fc-input" id="inp-gate-max" value="${maxGate}" style="width: 62px; height: 26px; font-size: 11px" min="30" max="250" />
                </div>
              </div>
            </div>
          </div>

          <!-- Radar Subgrid: Connection, Sensitivity & Timeouts -->
          <div class="fc-card-grid" style="margin-top: 10px">
            <!-- Card: Port COM & Czułość Radaru -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon green">🔌</span>
                  <span class="fc-card-title">Port USB COM & Czułość Wiązki</span>
                </div>
                <button class="btn btn-ghost btn-sm" id="fc-btn-refresh-ports" style="font-size: 10px; padding: 2px 6px">Odśwież</button>
              </div>

              <div class="fc-card-body">
                <select class="fc-select" id="sel-port">
                  <option value="auto" ${form.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie XIAO ESP32-C6)</option>
                  ${this.ports.map((p) => `<option value="${esc(p.path)}" ${p.path === form.port ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`).join('')}
                </select>

                <div class="fc-slider-row" style="margin-top: 4px">
                  <span style="font-size: 10.5px; color: var(--fc-text-secondary)">Czułość wiązki:</span>
                  <input type="range" class="fc-slider" id="rng-radar-sens" min="20" max="100" step="5" value="${form.radarSensitivity ?? 80}" />
                  <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-radar-sens">${form.radarSensitivity ?? 80}%</span>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large" id="card-val-distance">${this.telemetry.distanceCm ? `${this.telemetry.distanceCm} cm` : '—'}</div>
                  <div class="fc-metric-sub">Dystans klatki piersiowej</div>
                </div>
                <span class="fc-badge ${snap.radar.connected ? 'calibrated' : (snap.ha?.connected ? 'calibrated' : 'muted')}">${snap.radar.connected ? 'USB Serial ✓' : (snap.ha?.connected ? 'HAOS Stream ✓' : 'Brak COM')}</span>
              </div>
            </div>

            <!-- Card: Czasy Reakcji & Histereza (Timeouts) -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon amber">⏱️</span>
                  <span class="fc-card-title">Czasy Reakcji (Timeouts)</span>
                </div>
                <span class="fc-badge success">Aktywny</span>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Opóźnienie odejścia (Away):</span>
                  <div style="display: flex; gap: 4px; align-items: center">
                    <input type="number" class="fc-input" id="inp-timeout-away" value="${form.timeoutAwayMs ?? 3000}" style="width: 80px; height: 26px; font-size: 11px" min="200" max="60000" step="100" />
                    <span style="font-size: 10.5px; color: var(--fc-text-muted)">ms</span>
                  </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Opóźnienie powrotu (Desk):</span>
                  <div style="display: flex; gap: 4px; align-items: center">
                    <input type="number" class="fc-input" id="inp-timeout-desk" value="${form.timeoutDeskMs ?? 800}" style="width: 80px; height: 26px; font-size: 11px" min="100" max="10000" step="100" />
                    <span style="font-size: 10.5px; color: var(--fc-text-muted)">ms</span>
                  </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Filtr szumów & DSP:</span>
                  <select class="fc-select fc-select-sm" id="sel-radar-smoothing" style="width: 140px">
                    <option value="ultra" ${(form.radarSmoothingMode || 'ultra') === 'ultra' ? 'selected' : ''}>Ultra-Stabilny 🛡️</option>
                    <option value="balanced" ${form.radarSmoothingMode === 'balanced' ? 'selected' : ''}>Zbalansowany</option>
                    <option value="raw" ${form.radarSmoothingMode === 'raw' ? 'selected' : ''}>Szybki / Surowy</option>
                  </select>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${Math.floor(this.sessionSeconds / 60)} min</div>
                  <div class="fc-metric-sub">Bieżąca sesja w fotelu</div>
                </div>
                <span class="fc-badge calibrated">Histereza OK ✓</span>
              </div>
            </div>
          </div>
        </section>


        <!-- ==================== SEKCJA 3: BIOMETRIA, TĘTNO & ADAPTACJA AI ==================== -->
        <section class="fc-section">
          <div class="fc-section-header">
            <div class="fc-section-title-wrap">
              <span class="fc-section-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fc-accent-red)" stroke-width="2.2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
                Biometria, Tętno & Model Adaptacyjny AI
              </span>
              <span class="fc-info-badge" title="Rozpoznawanie tętna klatki piersiowej, oddech oraz automatyczna filtracja zwierząt domowych">?</span>
            </div>
            <div class="fc-section-actions">
              <button class="btn btn-ghost btn-sm" id="btn-home-open-bio" style="font-size: 11px; padding: 4px 9px">🧬 Profil Biometryczny</button>
            </div>
          </div>

          <div class="fc-card-grid">
            <!-- Card: Biometria & Tętno -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon red">🫀</span>
                  <span class="fc-card-title">Biometria & Filtr Zwierząt</span>
                </div>
                <button class="fc-switch ${form.biometricsEnabled ? 'active' : ''}" id="sw-biometrics" aria-checked="${form.biometricsEnabled ?? false}" role="switch"></button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">🐾 Filtr psa / kota (>22 RPM):</span>
                  <button class="fc-switch ${form.petFilterEnabled ? 'active' : ''}" id="sw-pet-filter" aria-checked="${form.petFilterEnabled ?? true}" role="switch"></button>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Wzorzec tętna (BPM):</span>
                  <div style="display: flex; gap: 4px; align-items: center">
                    <input type="number" class="fc-input" id="inp-hr-min" value="${form.userHeartRateMin ?? 55}" style="width: 52px; height: 24px; font-size: 10.5px" min="35" max="120" />
                    <span style="font-size: 10px; color: var(--fc-text-muted)">–</span>
                    <input type="number" class="fc-input" id="inp-hr-max" value="${form.userHeartRateMax ?? 78}" style="width: 52px; height: 24px; font-size: 10.5px" min="50" max="150" />
                  </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Gdy usiądzie inna osoba:</span>
                  <select class="fc-select fc-select-sm" id="sel-person-action" style="width: 150px">
                    <option value="ignore" ${(form.personMismatchAction || 'ignore') === 'ignore' ? 'selected' : ''}>Pozostań w mobilnym</option>
                    <option value="notify_only" ${form.personMismatchAction === 'notify_only' ? 'selected' : ''}>Powiadom</option>
                    <option value="switch_anyway" ${form.personMismatchAction === 'switch_anyway' ? 'selected' : ''}>Przełącz mimo to</option>
                  </select>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large" id="card-val-heart">${this.telemetry.heartRate ? `${this.telemetry.heartRate} BPM` : '—'}</div>
                  <div class="fc-metric-sub">Tętno klatki piersiowej</div>
                </div>
                <span id="card-badge-person" class="fc-badge ${person === 'me' ? 'calibrated' : (person === 'pet' ? 'amber' : 'blue')}">
                  ${person === 'me' ? '👤 Właściciel ✓' : (person === 'pet' ? '🐾 Zwierzę' : (person === 'other' ? '👥 Inna osoba' : '🔍 Skanowanie…'))}
                </span>
              </div>
            </div>

            <!-- Card: Auto-Tuning AI -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon blue">🧠</span>
                  <span class="fc-card-title">Model Auto-Tuningu AI</span>
                </div>
                <button class="text-btn" id="btn-reset-autotune" style="color: #ef4444; font-size: 10.5px" title="Zresetuj wyuczone parametry">↺ Reset</button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Automatyczna adaptacja tła:</span>
                  <button class="fc-switch ${form.radarAutoTuningEnabled ? 'active' : ''}" id="sw-auto-tuning" aria-checked="${form.radarAutoTuningEnabled ?? true}" role="switch"></button>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Szum otoczenia:</span>
                  <strong style="color: var(--fc-accent-green)">${this.telemetry.autoTuning?.noiseFloor ?? 0}% (Czyste)</strong>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Oddech na żywo:</span>
                  <strong style="color: var(--fc-accent-blue)" id="card-val-breath">${this.telemetry.breathRate ? `${this.telemetry.breathRate} RPM` : '—'}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Światło otoczenia:</span>
                  <strong style="color: var(--fc-accent-amber)" id="card-val-lux">${typeof this.telemetry.illuminanceLux === 'number' ? `${this.telemetry.illuminanceLux} lx` : '—'}</strong>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large" id="card-val-autotune-dist">${this.telemetry.autoTuning?.adaptedDistanceCenter ? this.telemetry.autoTuning.adaptedDistanceCenter + ' cm' : '75 cm'}</div>
                  <div class="fc-metric-sub">Wyuczony środek fotela</div>
                </div>
                <span class="fc-badge calibrated" id="card-badge-autotune-stability">Stabilność: ${this.telemetry.autoTuning?.stabilityScore ?? 92}% ✓</span>
              </div>
            </div>
          </div>
        </section>


        <!-- ==================== SEKCJA 4: INTEGRACJE ZEWNĘTRZNE, SYSTEM & DŹWIĘKI ==================== -->
        <section class="fc-section">
          <div class="fc-section-header">
            <div class="fc-section-title-wrap">
              <span class="fc-section-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fc-accent-amber)" stroke-width="2.2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                Integracje Zewnętrzne, Dźwięki Chime & System
              </span>
              <span class="fc-info-badge" title="Sterowanie Discord Voice RPC, oświetleniem SignalRGB oraz syntezą dźwiękową Chime">?</span>
            </div>
          </div>

          <div class="fc-card-grid">
            <!-- Card: Discord Voice RPC -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon blue">🎮</span>
                  <span class="fc-card-title">Discord Voice RPC</span>
                </div>
                <button class="fc-switch ${form.discordIntegration ? 'active' : ''}" id="sw-discord" aria-checked="${form.discordIntegration ?? true}" role="switch"></button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Śledź aktywny mikrofon:</span>
                  <button class="fc-switch ${form.discordGateFollowMic !== false ? 'active' : ''}" id="sw-discord-follow" aria-checked="${form.discordGateFollowMic !== false}" role="switch"></button>
                </div>
                <div style="font-size: 10.5px; color: var(--fc-text-muted); margin-top: 2px">
                  Automatycznie aplikuje próg VAD, Krisp i AGC do Discorda w momencie gdy wstajesz lub siadasz.
                </div>
                <div style="display: flex; gap: 6px; margin-top: 8px">
                  <button class="btn btn-secondary btn-sm" id="btn-discord-auth" style="flex: 1; font-size: 10.5px; padding: 4px 6px" title="Wywołaj okno autoryzacji OAuth w aplikacji Discord">🔐 Autoryzuj Discord</button>
                  <button class="btn btn-ghost btn-sm" id="btn-discord-sync" style="flex: 1; font-size: 10.5px; padding: 4px 6px" title="Wyślij bieżący profil głosu i przełącz urządzenie wejściowe w Discordzie">🔄 Synchronizuj</button>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${snap.state === 'desk' ? `${deskGateVal} dB` : `${headGateVal} dB`}</div>
                  <div class="fc-metric-sub">Aktywny próg Discord</div>
                </div>
                <span class="fc-badge ${form.discordIntegration ? 'blue' : 'muted'}">${form.discordIntegration ? 'RPC Włączony ✓' : 'Wyłączony'}</span>
              </div>
            </div>

            <!-- Card: SignalRGB LED Sync -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon amber">🌈</span>
                  <span class="fc-card-title">SignalRGB LED Sync</span>
                </div>
                <button class="fc-switch ${form.signalrgbEnabled ? 'active' : ''}" id="sw-signalrgb" aria-checked="${form.signalrgbEnabled ?? false}" role="switch"></button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Po odejściu:</span>
                  <select class="fc-select fc-select-sm" id="sel-signalrgb-away-action" style="width: 150px">
                    <option value="turn_off" ${(form.signalrgbAwayAction || 'turn_off') === 'turn_off' ? 'selected' : ''}>Zgaś całkowicie LED</option>
                    <option value="dim" ${form.signalrgbAwayAction === 'dim' ? 'selected' : ''}>Przyciemnij</option>
                    <option value="solid_color" ${form.signalrgbAwayAction === 'solid_color' ? 'selected' : ''}>Kolor ostrzegawczy</option>
                  </select>
                </div>
                <div style="display: flex; gap: 6px; margin-top: 4px">
                  <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-away" style="flex: 1; padding: 3px 4px; font-size: 10px">Test: Odejście</button>
                  <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-desk" style="flex: 1; padding: 3px 4px; font-size: 10px">Test: Biurko</button>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${form.signalrgbEnabled ? 'RGB Sync' : 'Wyłączony'}</div>
                  <div class="fc-metric-sub">Oświetlenie PC</div>
                </div>
                <span class="fc-badge ${form.signalrgbEnabled ? 'calibrated' : 'muted'}">${form.signalrgbEnabled ? 'Aktywny ✓' : 'Rezerwa'}</span>
              </div>
            </div>

            <!-- Card: Home Assistant OS (HAOS) -->
            <div class="fc-card ${form.haEnabled ? 'highlight' : ''}" style="grid-column: span 2">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon blue">🏠</span>
                  <span class="fc-card-title">Home Assistant OS (HAOS) — Zewnętrzny Sensor</span>
                </div>
                <div style="display: flex; gap: 8px; align-items: center">
                  <span class="fc-badge ${snap.ha?.connected ? 'calibrated' : (form.haEnabled ? 'amber' : 'muted')}" id="badge-ha-status">
                    ${snap.ha?.connected ? `● Połączono (HAOS${snap.ha.version ? ` v${snap.ha.version}` : ''}) ✓` : (form.haEnabled ? (snap.ha?.error || 'Łączenie z HAOS…') : 'Wyłączony')}
                  </span>
                  <button class="fc-switch ${form.haEnabled ? 'active' : ''}" id="sw-ha-enabled" aria-checked="${form.haEnabled ?? false}" role="switch" title="Włącz pobieranie danych obecności z Home Assistant"></button>
                </div>
              </div>

              <div class="fc-card-body">
                <div style="font-size: 11px; color: var(--fc-text-secondary); margin-bottom: 8px">
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

                <div style="display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap">
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

                <!-- Entity mapping selection inputs with datalists / live suggestions -->
                <div class="fc-subgrid-2" style="gap: 10px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--fc-card-border)">
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

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large" id="metric-ha-source">${snap.ha?.activeSource === 'ha' ? 'Strumień HAOS ●' : (form.haEnabled ? 'Oczekiwanie' : 'USB Serial')}</div>
                  <div class="fc-metric-sub">Aktywne źródło radaru</div>
                </div>
                <span class="fc-badge ${form.haEnabled && snap.ha?.connected ? 'calibrated' : 'muted'}">${form.haEnabled && snap.ha?.connected ? 'WebSocket Live ✓' : (form.haEnabled ? 'Brak połączenia' : 'Wyłączony')}</span>
              </div>
            </div>

            <!-- Card: Dźwięki Chime & System Windows -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon green">🔔</span>
                  <span class="fc-card-title">Dźwięki Chime & System</span>
                </div>
                <button class="fc-switch ${form.audioChime ? 'active' : ''}" id="sw-audio-chime" aria-checked="${form.audioChime ?? true}" role="switch"></button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Styl dźwięku:</span>
                  <div style="display: flex; gap: 4px; align-items: center">
                    <select class="fc-select fc-select-sm" id="sel-chime-style" style="width: 130px">
                      <option value="harmonic" ${this.selectedChimeStyle === 'harmonic' ? 'selected' : ''}>Harmoniczny dwuton</option>
                      <option value="modern" ${this.selectedChimeStyle === 'modern' ? 'selected' : ''}>Modern sci-fi ping</option>
                      <option value="soft_click" ${this.selectedChimeStyle === 'soft_click' ? 'selected' : ''}>Miękki klik studyjny</option>
                      <option value="marimba" ${this.selectedChimeStyle === 'marimba' ? 'selected' : ''}>Ciepła marimba</option>
                    </select>
                    <button class="btn btn-ghost btn-sm" id="btn-test-chime" title="Przetestuj dźwięk" style="padding: 2px 6px">🔔</button>
                  </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Autostart z Windows:</span>
                  <button class="fc-switch ${form.autoStart ? 'active' : ''}" id="sw-autostart" aria-checked="${form.autoStart ?? false}" role="switch"></button>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                  <span style="font-size: 11px; color: var(--fc-text-secondary)">Usypiaj monitory po odejściu:</span>
                  <button class="fc-switch ${form.sleepMonitorsOnAway ? 'active' : ''}" id="sw-sleep-monitors" aria-checked="${form.sleepMonitorsOnAway ?? false}" role="switch"></button>
                </div>
              </div>

              <div class="fc-card-footer">
                <div>
                  <div class="fc-metric-large">${chimeVol}%</div>
                  <div class="fc-metric-sub">Głośność powiadomień</div>
                </div>
                <span class="fc-badge ${form.autoStart ? 'calibrated' : 'muted'}">${form.autoStart ? 'Autostart ON' : 'Ręczny start'}</span>
              </div>
            </div>
          </div>
        </section>
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
              Oficjalny Stock Firmware Seeed MR60BHA2 (XIAO ESP32-C6)
            </div>
            <p style="font-size: 12px; color: var(--fc-text-secondary); line-height: 1.5">
              Sensor działa natywnie na fabrycznym firmware Seeed Studio. W razie potrzeby przywrócenia lub ponownego wgrania oprogramowania, skorzystaj z oficjalnych zasobów producenta:
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px">
              <button class="btn btn-primary btn-sm" id="btn-open-stock-bin">💾 Pobierz Stock Firmware (.factory.bin)</button>
              <button class="btn btn-ghost btn-sm" id="btn-open-seeed-wiki">📖 Poradnik & Web Flasher (Wiki Seeed)</button>
              <button class="btn btn-ghost btn-sm" id="btn-open-seeed-gh">🐙 Repozytorium GitHub Seeed</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- ABOUT TAB WITH HEALTH DIAGNOSTICS ----------
  private renderAboutTab(): string {
    const isRadarConnected = Boolean(this.snap?.radar?.connected);
    const isDiscordConnected = Boolean(this.form?.discordIntegration);
    const isSignalrgbConnected = Boolean(this.form?.signalrgbEnabled);

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
                  <span class="fc-badge ${isDiscordConnected ? 'blue' : 'muted'}">${isDiscordConnected ? 'Włączony' : 'Wyłączony'}</span>
                </div>
                <div class="fc-diag-item-val">${isDiscordConnected ? 'Port 6463 (Local IPC)' : 'Wyłączony w opcjach'}</div>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🌈 SignalRGB LED API</span> <span class="fc-badge ${isSignalrgbConnected ? 'amber' : 'muted'}">${isSignalrgbConnected ? 'Włączony' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val">${isSignalrgbConnected ? `Port ${this.form?.signalrgbPort || 80} (Lokalny)` : 'Nieaktywny'}</div>
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
            <h3>✨ Kreator Kalibracji Sensora (Krok ${step} z 4)</h3>
            <button class="close" id="btn-wizard-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="wizard-steps">
              <div class="wizard-step-dot ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 3 ? (step === 3 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 4 ? 'done' : ''}"></div>
            </div>

            ${step === 1 ? `
              <div>
                <div class="wizard-icon-hero">🪑</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 1: Kalibracja pustego fotela</h4>
                <p class="wizard-instruction">
                  Odejdź od biurka na 2–3 metry lub wyjdź z zasięgu radaru.<br/>
                  Upewnij się, że fotel jest pusty, aby radar zapamiętał szum tła otoczenia.
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
                <div class="wizard-icon-hero">🫀</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 3: Profil biometryczny (Tętno & Oddech)</h4>
                <p class="wizard-instruction">
                  Siedź spokojnie i oddychaj naturalnie.<br/>
                  Radar sczytuje mikrofalami Twoje tętno spoczynkowe i rytm oddechowy.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Pobieranie wzorca biometrycznego…</strong>
                      <span>${count} s (${this.telemetry.heartRate ? this.telemetry.heartRate + ' BPM' : 'odczyt…'})</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((8 - count) / 8) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-step-3" style="width: 100%">Rozpocznij pomiar biometrii (8s)</button>`}
                </div>
              </div>` : ''}

            ${step === 4 ? `
              <div>
                <div class="wizard-icon-hero">🎉</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Kalibracja zakończona sukcesem!</h4>
                <div style="grid-template-columns: 1fr 1fr; display: grid; gap: 8px; margin-top: 12px">
                  <div class="fc-card">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">📏 Strefa fotela</div>
                    <strong style="font-size: 16px; color: var(--fc-accent-green)">${this.wizardResults.distance} cm</strong>
                    <span style="font-size: 10px; color: var(--fc-text-muted)">Bramka: ${this.wizardResults.gateMin}–${this.wizardResults.gateMax} cm</span>
                  </div>
                  <div class="fc-card">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">🫀 Tętno bazowe</div>
                    <strong style="font-size: 16px; color: #fff">${this.wizardResults.heartRateAvg} BPM</strong>
                    <span style="font-size: 10px; color: var(--fc-text-muted)">Zakres: ${this.wizardResults.heartRateMin}–${this.wizardResults.heartRateMax} BPM</span>
                  </div>
                </div>
              </div>` : ''}
          </div>

          <div class="modal-footer">
            ${step > 1 && step < 4 ? `<button class="btn btn-ghost btn-sm" id="btn-wizard-back">← Wstecz</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="btn-wizard-cancel">Anuluj</button>
            ${step === 4 ? `<button class="btn btn-primary btn-sm" id="btn-wizard-apply">Zastosuj i zapisz kalibrację ✓</button>` : `<span style="font-size: 11px; color: var(--fc-text-muted)">Krok ${step} z 4</span>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 2: Bio Modal ----------
  private renderBioModal(): string {
    return `
      <div class="modal-overlay" id="bio-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>🧬 Profil Biometryczny & Rozróżnianie Osób</h3>
            <button class="close" id="btn-bio-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="fc-field-row">
              <div>
                <div class="fc-field-label">Włącz rozróżnianie osób (Właściciel vs Goście)</div>
                <div class="fc-field-desc">Weryfikuje wzorzec tętna i odległość siedzenia</div>
              </div>
              <button class="fc-switch ${this.form?.biometricsEnabled ? 'active' : ''}" id="sw-biometrics-modal" aria-checked="${this.form?.biometricsEnabled ?? false}" role="switch"></button>
            </div>

            <div class="fc-field-row" style="margin-top: 8px">
              <div>
                <div class="fc-field-label">🐾 Filtr zwierząt domowych (Kot / Pies)</div>
                <div class="fc-field-desc">Ignoruje zwierzęta na bazie oddechu (>22 RPM) i tętna (>125 BPM)</div>
              </div>
              <button class="fc-switch ${this.form?.petFilterEnabled ? 'active' : ''}" id="sw-pet-filter-modal" aria-checked="${this.form?.petFilterEnabled ?? true}" role="switch"></button>
            </div>

            <div style="margin-top: 10px; padding: 14px; background: var(--fc-bg-darker); border: 1px solid var(--fc-card-border); border-radius: var(--fc-radius-sm)">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
                <strong style="font-size: 12px; color: var(--fc-accent-green)">Twój wzorzec biometryczny:</strong>
                <button class="btn btn-ghost btn-sm" id="btn-quick-calibrate-bio">🎯 Skalibruj z aktualnych odczytów</button>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px">
                <div>
                  <label class="fc-micro-label">Twoje tętno spoczynkowe (Min - Max BPM):</label>
                  <div style="display: flex; gap: 6px; margin-top: 4px">
                    <input class="fc-input" type="number" id="modal-inp-hr-min" value="${this.form?.userHeartRateMin ?? 55}" style="flex: 1" min="35" max="120" />
                    <input class="fc-input" type="number" id="modal-inp-hr-max" value="${this.form?.userHeartRateMax ?? 78}" style="flex: 1" min="50" max="150" />
                  </div>
                </div>
                <div>
                  <label class="fc-micro-label">Odległość siedzenia (Min - Max cm):</label>
                  <div style="display: flex; gap: 6px; margin-top: 4px">
                    <input class="fc-input" type="number" id="modal-inp-dist-min" value="${this.form?.userSeatingDistanceMin ?? 50}" style="flex: 1" min="20" max="180" />
                    <input class="fc-input" type="number" id="modal-inp-dist-max" value="${this.form?.userSeatingDistanceMax ?? 95}" style="flex: 1" min="30" max="220" />
                  </div>
                </div>
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


  // ---------- MODAL 4: QoL Diagnostics Hub Modal ----------
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
                <div class="fc-diag-item-val">Port: ${this.form?.port || 'auto'}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">VID: 0x303A, PID: 0x1001 (Seeed XIAO ESP32-C6)</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🎙️ AudioSwitcher.exe</span> <span class="fc-badge calibrated">CoreAudio Daemon ✓</span></div>
                <div class="fc-diag-item-val">Liczba urządzeń: ${this.audioDevices.length}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">IPolicyConfig Native COM Hook</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🎮 Discord RPC</span> <span class="fc-badge ${this.form?.discordIntegration ? 'blue' : 'muted'}">${this.form?.discordIntegration ? 'Gotowy' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val">Local IPC Socket</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">discord-rpc://127.0.0.1:6463</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🌈 SignalRGB API</span> <span class="fc-badge ${this.form?.signalrgbEnabled ? 'amber' : 'muted'}">${this.form?.signalrgbEnabled ? 'Aktywny' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val">Port: ${this.form?.signalrgbPort || 80}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Lokalne REST API SignalRGB</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🏠 Home Assistant (HAOS)</span> <span class="fc-badge ${this.snap?.ha?.connected ? 'calibrated' : (this.form?.haEnabled ? 'amber' : 'muted')}">${this.snap?.ha?.connected ? 'Połączony ✓' : (this.form?.haEnabled ? 'Łączenie…' : 'Wyłączony')}</span></div>
                <div class="fc-diag-item-val">${this.form?.haEnabled ? esc(this.form.haUrl || 'http://homeassistant.local:8123') : 'Wyłączona integracja'}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Encja: ${this.form?.haPresenceEntity ? esc(this.form.haPresenceEntity) : 'brak wybranej'}</span>
              </div>
            </div>

            <div style="margin-top: 12px; padding: 10px; background: var(--fc-bg-darker); border-radius: var(--fc-radius-sm); font-size: 11.5px; color: var(--fc-text-secondary)">
              <strong>💡 Status sesji:</strong> Siedzisz przy biurku od <strong>${Math.floor(this.sessionSeconds / 60)} minut</strong>. Wszystkie wątki IPC i demony działają w trybie optymalnym.
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

    // QoL: Cancel Snooze
    byId('btn-cancel-snooze')?.addEventListener('click', () => {
      this.snoozeUntil = null;
      this.pushToast('Wznowiono automatyczne przełączanie mikrofonu ✓');
      this.render();
    });

    // QoL: Quick Snooze in Master Card
    byId('sel-quick-snooze')?.addEventListener('change', (e) => {
      const mins = Number((e.target as HTMLSelectElement).value);
      if (mins > 0) {
        this.snoozeUntil = Date.now() + mins * 60000;
        this.pushToast(`Wstrzymano automatyczne przełączanie na ${mins} minut ⏸️`);
      } else {
        this.snoozeUntil = null;
        this.pushToast('Wznowiono auto-switching ✓');
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
    byId('btn-home-open-bio')?.addEventListener('click', () => { this.bioModalOpen = true; this.render(); });
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
      if (s && typeof s.thresholdDb === 'number') {
        this.patchForm({ micDeskGateDb: s.thresholdDb });
        this.vuEngine.deskGateDb = s.thresholdDb;
        this.pushToast(`Pobrano próg z Discorda dla biurka: ${s.thresholdDb} dB ✓`);
      } else {
        this.pushToast('Nie udało się pobrać progu z Discorda — upewnij się, że autoryzowano OAuth Discorda.', true);
      }
    });

    byId('btn-vad-sync-headset')?.addEventListener('click', async () => {
      const s = await window.api.discordGetVoiceSettings();
      if (s && typeof s.thresholdDb === 'number') {
        this.patchForm({ micHeadsetGateDb: s.thresholdDb });
        this.vuEngine.headGateDb = s.thresholdDb;
        this.pushToast(`Pobrano próg z Discorda dla słuchawek: ${s.thresholdDb} dB ✓`);
      } else {
        this.pushToast('Nie udało się pobrać progu z Discorda — upewnij się, że autoryzowano OAuth Discorda.', true);
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
      if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -55 });
      }
      this.pushToast('Ustawiono próg VAD: -55 dB (Cichy pokój)');
    });
    byId('preset-vad-desk-std')?.addEventListener('click', () => {
      this.patchForm({ micDeskGateDb: -45 }, true);
      if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -45 });
      }
      this.pushToast('Ustawiono próg VAD: -45 dB (Zbalansowany)');
    });
    byId('preset-vad-desk-noisy')?.addEventListener('click', () => {
      this.patchForm({ micDeskGateDb: -35 }, true);
      if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -35 });
      }
      this.pushToast('Ustawiono próg VAD: -35 dB (Głośna klawiatura / Tło)');
    });

    // Quick VAD Presets Headset
    byId('preset-vad-headset-quiet')?.addEventListener('click', () => {
      this.patchForm({ micHeadsetGateDb: -55 }, true);
      if (this.snap?.state === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -55 });
      }
      this.pushToast('Ustawiono próg VAD: -55 dB (Ciche otoczenie)');
    });
    byId('preset-vad-headset-std')?.addEventListener('click', () => {
      this.patchForm({ micHeadsetGateDb: -45 }, true);
      if (this.snap?.state === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -45 });
      }
      this.pushToast('Ustawiono próg VAD: -45 dB (Zbalansowany)');
    });
    byId('preset-vad-headset-noisy')?.addEventListener('click', () => {
      this.patchForm({ micHeadsetGateDb: -35 }, true);
      if (this.snap?.state === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -35 });
      }
      this.pushToast('Ustawiono próg VAD: -35 dB (Głośne tło)');
    });

    // Form inputs (Mic desk & headset)
    const onDeskMicSelect = (sel: HTMLSelectElement) => {
      const opt = sel.selectedOptions[0];
      const name = sel.value;
      const vol = this.initVolumePercent(name, undefined);
      this.patchForm({ micDeskName: name, micDeskId: opt?.getAttribute('data-id') || '', micDeskVolume: vol });
      const elRng = byId('rng-vol-desk') as HTMLInputElement | null;
      const elVal = byId('val-vol-desk');
      const elMetric = byId('metric-vol-desk');
      if (elRng) elRng.value = String(vol);
      if (elVal) elVal.textContent = `${vol}%`;
      if (elMetric) elMetric.textContent = `${vol} %`;
      void this.vuEngine.start(name, this.form?.micHeadsetName || '');
    };

    byId('sel-mic-desk')?.addEventListener('change', (e) => onDeskMicSelect(e.target as HTMLSelectElement));

    byId('rng-vol-desk')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ micDeskVolume: val });
      const el = byId('val-vol-desk');
      const metric = byId('metric-vol-desk');
      if (el) el.textContent = `${val}%`;
      if (metric) metric.textContent = `${val} %`;
    });
    byId('rng-vol-desk')?.addEventListener('change', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      const name = this.form?.micDeskName;
      if (name) void window.api.setVolume(name, val);
    });

    const onHeadsetMicSelect = (sel: HTMLSelectElement) => {
      const opt = sel.selectedOptions[0];
      const name = sel.value;
      const vol = this.initVolumePercent(name, undefined);
      this.patchForm({ micHeadsetName: name, micHeadsetId: opt?.getAttribute('data-id') || '', micHeadsetVolume: vol });
      const elRng = byId('rng-vol-headset') as HTMLInputElement | null;
      const elVal = byId('val-vol-headset');
      const elMetric = byId('metric-vol-headset');
      if (elRng) elRng.value = String(vol);
      if (elVal) elVal.textContent = `${vol}%`;
      if (elMetric) elMetric.textContent = `${vol} %`;
      void this.vuEngine.start(this.form?.micDeskName || '', name);
    };

    byId('sel-mic-headset')?.addEventListener('change', (e) => onHeadsetMicSelect(e.target as HTMLSelectElement));

    byId('rng-vol-headset')?.addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.patchForm({ micHeadsetVolume: val });
      const el = byId('val-vol-headset');
      const metric = byId('metric-vol-headset');
      if (el) el.textContent = `${val}%`;
      if (metric) metric.textContent = `${val} %`;
    });
    byId('rng-vol-headset')?.addEventListener('change', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      const name = this.form?.micHeadsetName;
      if (name) void window.api.setVolume(name, val);
    });

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
      if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
    });

    const updateDeskKrisp = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micDeskKrisp: mode });
      if (mode !== 'default' && (this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    };
    byId('settings-krisp-desk')?.addEventListener('change', (e) => updateDeskKrisp((e.target as HTMLSelectElement).value as any));

    const updateDeskAgc = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micDeskAgc: mode });
      if (mode !== 'default' && (this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    };
    byId('settings-agc-desk')?.addEventListener('change', (e) => updateDeskAgc((e.target as HTMLSelectElement).value as any));

    byId('settings-echo-desk')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      this.patchForm({ micDeskEcho: mode });
      if (mode !== 'default' && (this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
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
      if (this.snap?.state === 'headset' && this.form?.discordIntegration) {
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
          if ((this.snap?.state ?? 'desk') === 'desk' && this.form?.discordIntegration) {
            void window.api.discordApplyVoice({ gateDb: clampedDb });
          }
        } else {
          this.vuEngine.headGateDb = clampedDb;
          this.patchForm({ micHeadsetGateDb: clampedDb }, false);
          if (this.snap?.state === 'headset' && this.form?.discordIntegration) {
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
      if (mode !== 'default' && this.snap?.state === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    };
    byId('settings-krisp-headset')?.addEventListener('change', (e) => updateHeadsetKrisp((e.target as HTMLSelectElement).value as any));

    const updateHeadsetAgc = (mode: 'default' | 'on' | 'off') => {
      this.patchForm({ micHeadsetAgc: mode });
      if (mode !== 'default' && this.snap?.state === 'headset' && this.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    };
    byId('settings-agc-headset')?.addEventListener('change', (e) => updateHeadsetAgc((e.target as HTMLSelectElement).value as any));

    byId('settings-echo-headset')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      this.patchForm({ micHeadsetEcho: mode });
      if (mode !== 'default' && this.snap?.state === 'headset' && this.form?.discordIntegration) {
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
      const isDesk = (this.snap?.state ?? 'desk') === 'desk';
      const gateDb = isDesk ? (this.form?.micDeskGateDb ?? -36) : (this.form?.micHeadsetGateDb ?? -32);
      const krisp = isDesk ? this.form?.micDeskKrisp === 'on' : this.form?.micHeadsetKrisp === 'on';
      const agc = isDesk ? this.form?.micDeskAgc === 'on' : this.form?.micHeadsetAgc === 'on';
      const echo = isDesk ? this.form?.micDeskEcho === 'on' : this.form?.micHeadsetEcho === 'on';

      const ok = await window.api.discordApplyVoice({ gateDb, krisp, agc, echo });
      if (ok) {
        this.pushToast(`Zsynchronizowano profil głosu Discord: ${gateDb} dB ✓`);
      } else {
        this.pushToast('Discord nie przyjął zmian profilu (kliknij "Autoryzuj Discord")', true);
      }
    });

    // Radar sensitivity sync
    const syncRadarSens = (val: number) => {
      this.patchForm({ radarSensitivity: val });
      const elVal = byId('val-radar-sens');
      const rng1 = byId('rng-radar-sens') as HTMLInputElement | null;
      if (elVal) elVal.textContent = `${val}%`;
      if (rng1 && Number(rng1.value) !== val) rng1.value = String(val);
    };

    byId('rng-radar-sens')?.addEventListener('input', (e) => syncRadarSens(Number((e.target as HTMLInputElement).value)));

    byId('sw-biometrics')?.addEventListener('click', () => {
      const val = !(this.form?.biometricsEnabled ?? false);
      this.patchForm({ biometricsEnabled: val }, false);
      const btn = byId('sw-biometrics');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    byId('sw-pet-filter')?.addEventListener('click', () => {
      const val = !(this.form?.petFilterEnabled ?? true);
      this.patchForm({ petFilterEnabled: val }, false);
      const btn = byId('sw-pet-filter');
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
      this.patchForm({ signalrgbAwayAction: (e.target as HTMLSelectElement).value as any });
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

    // Radar Gate Min/Max Sync
    const syncGateMin = (v: number) => {
      if (isNaN(v)) return;
      this.patchForm({ radarMinDistanceCm: v });
      const inp = byId('inp-gate-min') as HTMLInputElement | null;
      const rng = byId('rng-scope-gate-min') as HTMLInputElement | null;
      const lbl = byId('lbl-gate-min');
      if (inp && Number(inp.value) !== v) inp.value = String(v);
      if (rng && Number(rng.value) !== v) rng.value = String(v);
      if (lbl) lbl.textContent = `${v} cm`;
      this.updateRadarScopeDOM();
    };

    const syncGateMax = (v: number) => {
      if (isNaN(v)) return;
      this.patchForm({ radarMaxDistanceCm: v });
      const inp = byId('inp-gate-max') as HTMLInputElement | null;
      const rng = byId('rng-scope-gate-max') as HTMLInputElement | null;
      const lbl = byId('lbl-gate-max');
      if (inp && Number(inp.value) !== v) inp.value = String(v);
      if (rng && Number(rng.value) !== v) rng.value = String(v);
      if (lbl) lbl.textContent = `${v} cm`;
      this.updateRadarScopeDOM();
    };

    byId('inp-gate-min')?.addEventListener('input', (e) => syncGateMin(Number((e.target as HTMLInputElement).value)));
    byId('rng-scope-gate-min')?.addEventListener('input', (e) => syncGateMin(Number((e.target as HTMLInputElement).value)));
    byId('inp-gate-max')?.addEventListener('input', (e) => syncGateMax(Number((e.target as HTMLInputElement).value)));
    byId('rng-scope-gate-max')?.addEventListener('input', (e) => syncGateMax(Number((e.target as HTMLInputElement).value)));

    // Radar Presets
    byId('preset-gate-close')?.addEventListener('click', () => {
      syncGateMin(35);
      syncGateMax(90);
      this.pushToast('Ustawiono preset: Bliski fotel (35–90 cm)');
    });
    byId('preset-gate-std')?.addEventListener('click', () => {
      syncGateMin(40);
      syncGateMax(110);
      this.pushToast('Ustawiono preset: Standardowe biurko (40–110 cm)');
    });
    byId('preset-gate-deep')?.addEventListener('click', () => {
      syncGateMin(50);
      syncGateMax(140);
      this.pushToast('Ustawiono preset: Głębokie biurko (50–140 cm)');
    });
    byId('preset-gate-fit')?.addEventListener('click', () => {
      const cur = this.telemetry.distanceCm || 75;
      const minVal = Math.max(25, cur - 25);
      const maxVal = Math.min(200, cur + 30);
      syncGateMin(minVal);
      syncGateMax(maxVal);
      this.pushToast(`Dopasowano bramkę do Twojej pozycji (${cur} cm): ${minVal}–${maxVal} cm ✓`);
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
    byId('sel-mute-behavior')?.addEventListener('change', (e) => {
      this.patchForm({ muteBehaviorOnAway: (e.target as HTMLSelectElement).value as any });
    });
    byId('inp-hr-min')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v)) this.patchForm({ userHeartRateMin: v });
    });
    byId('inp-hr-max')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v)) this.patchForm({ userHeartRateMax: v });
    });
    byId('sel-person-action')?.addEventListener('change', (e) => {
      this.patchForm({ personMismatchAction: (e.target as HTMLSelectElement).value as any });
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
      this.patchForm({ sleepMonitorsOnAway: val }, false);
      const btn = byId('sw-sleep-monitors');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
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
    byId('sel-chime-style')?.addEventListener('change', (e) => {
      this.selectedChimeStyle = (e.target as HTMLSelectElement).value as ChimeStyle;
      playChime('desk', this.form?.audioChimeVolume ?? 0.2, this.selectedChimeStyle);
      this.pushToast(`Wybrano i przetestowano styl powiadomienia Chime`);
    });
    byId('btn-test-chime')?.addEventListener('click', () => {
      playChime('desk', this.form?.audioChimeVolume ?? 0.2, this.selectedChimeStyle);
    });

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

      // Kluczowe zdarzenia audio, przełączania, błędów i radar-event z całej sesji
      const keyEvents = logsToInclude.filter((l) =>
        /\[(AUDIO-|SWITCH-|APP-|RADAR-EVENT|WARN|ERROR)/i.test(l)
      );

      // Ostatnie próbki telemetryczne dla podglądu działania radaru
      const recentTelemetry = logsToInclude.filter((l) => /\[RADAR-/i.test(l)).slice(-60);

      const report = [
        `# Raport Diagnostyczny DeskSense (dla Agenta AI / Programisty)`,
        `Data wygenerowania: ${new Date().toLocaleString('pl-PL')}`,
        `Wersja: v${snap?.version || '0.3.0'} | Tryb pracy: ${snap?.mode || 'auto'} | Aktywny profil: ${snap?.state === 'desk' ? 'Stacjonarny (Biurko)' : 'Mobilny (Słuchawki)'}`,
        ``,
        `## 📡 Radar mmWave & Stan Obecności`,
        `- Aktywne źródło: ${snap?.ha?.activeSource === 'ha' ? 'Home Assistant OS' : 'USB COM Port'}`,
        `- Stan obecności (Presence): ${snap?.radar?.presence ? 'OBECNY PRZY BIURKU (true)' : 'POZA FOTELEM (false)'}`,
        `- Dystans live: ${this.telemetry.distanceCm ?? '--'} cm (strefa: ${form?.radarMinDistanceCm ?? 40} - ${form?.radarMaxDistanceCm ?? 110} cm, bramka: ${form?.radarDistanceGateEnabled ? 'WŁ' : 'WYŁ'})`,
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
        `## ⚡ Oś Czasu Kluczowych Zdarzeń (Przełączanie, Audio, Zmiany Stanu) [${keyEvents.length} wpisów]`,
        '```',
        keyEvents.length > 0 ? keyEvents.join('\n') : 'Brak zarejestrowanych zdarzeń przełączania w buforze.',
        '```',
        ``,
        `## 🌊 Ostatnia Próbka Strumienia Radaru (Ostatnie 60 ramek)`,
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
        if (!logs || logs.length === 0) {
          this.pushToast('Brak logów do skopiowania');
          return;
        }
        const textToCopy = logs.join('\r\n');
        await window.api.copyToClipboard(textToCopy);
        this.pushToast(`Skopiowano WSZYSTKIE logi RAW (${logs.length} linii) do schowka! 📋`);
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

    // Oficjalny Stock Firmware Seeed
    byId('btn-open-stock-bin')?.addEventListener('click', () => {
      void window.api.openExternal('https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/seeedstudio-mr60bha2-kit-esp32c6.factory.bin');
      this.pushToast('Otwieram pobieranie pliku fabrycznego (.bin)…');
    });
    byId('btn-open-seeed-wiki')?.addEventListener('click', () => {
      void window.api.openExternal('https://wiki.seeedstudio.com/xiao_esp32c6_mr60bha2/');
      this.pushToast('Otwieram dokumentację i Web Flasher Seeed…');
    });
    byId('btn-open-seeed-gh')?.addEventListener('click', () => {
      void window.api.openExternal('https://github.com/Seeed-Studio/Seeed_Arduino_MR60BHA2');
      this.pushToast('Otwieram repozytorium GitHub Seeed…');
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
    byId('btn-run-step-3')?.addEventListener('click', () => this.runWizardStep3());
    byId('btn-wizard-apply')?.addEventListener('click', () => this.applyWizardCalibration());

    // Bio Modal
    byId('btn-bio-close')?.addEventListener('click', () => { this.bioModalOpen = false; this.render(); });
    byId('btn-bio-cancel')?.addEventListener('click', () => { this.bioModalOpen = false; this.render(); });
    byId('bio-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'bio-overlay') { this.bioModalOpen = false; this.render(); }
    });
    byId('sw-biometrics-modal')?.addEventListener('click', () => {
      const val = !(this.form?.biometricsEnabled ?? false);
      this.patchForm({ biometricsEnabled: val }, false);
      const btn = byId('sw-biometrics-modal');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-pet-filter-modal')?.addEventListener('click', () => {
      const val = !(this.form?.petFilterEnabled ?? true);
      this.patchForm({ petFilterEnabled: val }, false);
      const btn = byId('sw-pet-filter-modal');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
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
      const inpHrMin = byId('modal-inp-hr-min') as HTMLInputElement | null;
      const inpHrMax = byId('modal-inp-hr-max') as HTMLInputElement | null;
      const inpDistMin = byId('modal-inp-dist-min') as HTMLInputElement | null;
      const inpDistMax = byId('modal-inp-dist-max') as HTMLInputElement | null;
      if (inpHrMin) inpHrMin.value = String(Math.max(45, curHr - 12));
      if (inpHrMax) inpHrMax.value = String(curHr + 14);
      if (inpDistMin) inpDistMin.value = String(Math.max(30, curDist - 15));
      if (inpDistMax) inpDistMax.value = String(curDist + 20);
      this.pushToast(`Skalibrowano profil: Dystans ${curDist}cm, Tętno ${curHr} BPM`);
    });
    byId('btn-bio-save')?.addEventListener('click', () => {
      const inpHrMin = Number((byId('modal-inp-hr-min') as HTMLInputElement)?.value);
      const inpHrMax = Number((byId('modal-inp-hr-max') as HTMLInputElement)?.value);
      const inpDistMin = Number((byId('modal-inp-dist-min') as HTMLInputElement)?.value);
      const inpDistMax = Number((byId('modal-inp-dist-max') as HTMLInputElement)?.value);
      this.patchForm({
        userHeartRateMin: !isNaN(inpHrMin) ? inpHrMin : this.form?.userHeartRateMin,
        userHeartRateMax: !isNaN(inpHrMax) ? inpHrMax : this.form?.userHeartRateMax,
        userSeatingDistanceMin: !isNaN(inpDistMin) ? inpDistMin : this.form?.userSeatingDistanceMin,
        userSeatingDistanceMax: !isNaN(inpDistMax) ? inpDistMax : this.form?.userSeatingDistanceMax
      });
      this.bioModalOpen = false;
      this.save();
    });


    // Diagnostics Modal
    byId('btn-diag-close')?.addEventListener('click', () => { this.diagModalOpen = false; this.render(); });
    byId('btn-diag-cancel')?.addEventListener('click', () => { this.diagModalOpen = false; this.render(); });
    byId('diag-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'diag-overlay') { this.diagModalOpen = false; this.render(); }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root');
  if (root) {
    const app = new AppUI(root);
    app.init();
  }
});
