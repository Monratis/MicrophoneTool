// Silnik Live Audio (VU-metr + sledzenie bramki VAD w czasie rzeczywistym).

// ---------- Live Audio Meter Engine (Real-Time VU-Meter & VAD Gate Tracker) ----------
export class LiveAudioEngine {
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
  // Throttle: VU nie potrzebuje 60 fps — ~30 fps to o połowę mniej rAF + DOM (mniej CPU)
  private lastTickMs = 0;
  private readonly VU_TICK_MS = 33;

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
    if (!this.isRunning) return;
    const now = Date.now();
    // Throttle ~30 fps — VU nie wymaga płynności 60 fps, oszczędza CPU/DOM
    if (now - this.lastTickMs < this.VU_TICK_MS) {
      this.animFrameId = requestAnimationFrame(this.tick);
      return;
    }
    this.lastTickMs = now;

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
