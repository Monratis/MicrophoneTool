import './styles.css';
import type { AudioDeviceItem, DiagSessionReport, PushEvent, RadarTelemetry, SerialPortInfo, Snapshot, UpdaterStatus } from './global';
import { normalizeVoicePhrase, type FlasherDependencies } from '../../shared/types';
import { esc, playChime, playVoiceFeedbackChime, playCustomAudioFile, type ChimeStyle, type TabType, type SettingsTab } from './ui';
import { LiveAudioEngine } from './liveAudioEngine';
import { renderHomeTab, triggerOsdHud, hideOsdHud, updateHeaderAndLiveDOM, updateRadarScopeDOM, updateTelemetryDOM } from './homeView';
import { renderSettingsTab } from './settingsPanels';
import { renderHaPickerModal, refreshDiscordRpcStatus } from './integrationsPanels';
import { renderLogsTab, renderAboutTab, refreshLogConsoleDOM } from './logsAbout';
import { closeVadModal, renderDiagModal, renderDiagSessionModal, renderVadModal, renderFlasherModal } from './modals';
import { renderVoiceCalibratorModal, renderVoiceDownloadSection, renderVoiceLiveStatus, isSelectedVoiceModelReady } from './voicePanel';
import { bindEvents, bindVoiceDynamic } from './events';


export class AppUI {
  root: HTMLElement;
  snap: Snapshot | null = null;
  form: Snapshot['config'] | null = null;
  ports: SerialPortInfo[] = [];
  audioDevices: AudioDeviceItem[] = [];
  isMuted = false;
  isMaximized = false;
  dirty = false;
  saving = false;
  autoSaveTimer: any = null;
  refreshingPorts = false;
  updater: UpdaterStatus = { status: 'idle', currentVersion: '' };
  downloadProgress: { percent: number; speed: string } | null = null;
  toasts: { id: number; message: string; error?: boolean; timer?: any; paused?: boolean }[] = [];
  toastCounter = 0;
  saveState = { text: 'Wszystkie ustawienia zapisane ✓', kind: 'saved' };

  // Voice Control State
  voiceDownloadProgress: { percent: number; speed?: string } | null = null;
  voiceCalibratorOpen = false;
  voiceLastRecognized = '';

  // Firmware Flasher State (XIAO ESP32-C6)
  flasherModalOpen = false;
  flasherLoading = false;
  flasherSelectedFile = '';
  flasherSelectedFileName = '';
  flasherSelectedFileSize = 0;
  flasherSelectedPort = '';
  flasherLogs: string[] = [];
  flasherSuccess: boolean | null = null;
  flasherDeps: FlasherDependencies | null = null;

  // Live Audio VU-Meter Engine
  vuEngine = new LiveAudioEngine();
  osdTimer: any = null;

  // Navigation tab
  currentTab: TabType = 'home';

  // Podsekcja ustawień (lewy panel nawigacji ustawień)
  settingsTab: SettingsTab = 'port';

  // QoL: Auto-Switch Snooze
  snoozeUntil: number | null = null;
  selectedChimeStyle: ChimeStyle = 'harmonic';

  // QoL: Log Filtering & Search
  logFilter: 'all' | 'radar' | 'voice' | 'haos' | 'audio' | 'discord' | 'error' = 'all';
  logSearch = '';

  // QoL: Discord Auto-Threshold Calibration Assistant
  vadModalOpen = false;
  vadTarget: 'desk' | 'headset' = 'desk';
  vadStep: 1 | 2 | 3 = 1;
  vadCountdown = 0;
  vadInterval: any = null;
  vadSampleInterval: any = null;
  vadNoiseSamples: number[] = [];
  vadSpeechSamples: number[] = [];
  vadResults = { noiseDb: -52, speechDb: -22, optimalGateDb: -42 };
  vadWarning = '';

  // Home Assistant (HAOS) State
  haTesting = false;
  haTestResult: { ok: boolean; message?: string; version?: string; error?: string } | null = null;
  haFetchingEntities = false;
  // Katalog encji HAOS (po "Wykryj & Pobierz encje") + stan otwartego pickera
  haCatalog: { entity_id: string; name: string; domain: string; deviceName?: string; areaName?: string; state?: string; unit?: string }[] = [];
  /** Otwarty picker encji: klucz pola configu lub indeks reguły głosowej, tytuł modalu i dozwolone domeny */
  haPicker: { key?: string; ruleIndex?: number; title: string; domains: string[] } | null = null;
  haPickerSearch = '';
  haPickerDomain = '';
  /** Widok wyszukiwarki: pokoje/obszary, urządzenia lub płaska lista encji */
  haPickerMode: 'areas' | 'devices' | 'entities' = 'areas';
  /** Pokój / obszar, do którego weszliśmy w widoku "Pokoje" ('' = poziom listy) */
  haPickerArea = '';
  /** Urządzenie, do którego weszliśmy w widoku "Urządzenia" ('' = poziom listy) */
  haPickerDevice = '';
  /** Trwa auto-pobieranie katalogu encji po otwarciu pickera */
  haFetchingPicker = false;
  haShowToken = false;
  // SignalRGB State
  signalrgbEffects: string[] = [];
  signalrgbCustomAway = false;
  signalrgbCustomDesk = false;

  // Telemetria biometryczna na żywo
  telemetry: RadarTelemetry = {
    distanceCm: 0,
    distanceTrusted: true,
    targetCount: undefined,
    heartRate: 0,
    breathRate: 0,
    illuminanceLux: undefined,
    detectedPerson: 'unknown'
  };

  diagModalOpen = false;
  logs: string[] = [];

  // Sesja diagnostyczna "Wyjście z pokoju"
  diagActive = false;
  diagSessionText = '';
  diagSessionReport: DiagSessionReport | null = null;
  diagReportModalOpen = false;

  lastDeviceSig = '';
  lastPortSig = '';

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
      if (window.api && typeof window.api.signalrgbListEffects === 'function') {
        this.signalrgbEffects = (await window.api.signalrgbListEffects()) || [];
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
        if (this.vadModalOpen) {
          ev.preventDefault();
          closeVadModal(this);
        } else if (this.haPicker) {
          ev.preventDefault();
          this.haPicker = null;
          this.render();
        } else if (this.voiceCalibratorOpen) {
          ev.preventDefault();
          this.voiceCalibratorOpen = false;
          this.render();
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

  async loadAudioDevices() {
    try {
      const devs = await window.api.listDevices();
      this.audioDevices = devs || [];
      const current = devs.find((d) => d.isDefault);
      if (current && typeof current.isMuted === 'boolean') {
        this.isMuted = current.isMuted;
      }
    } catch (_) {}
  }

  handleEvent(e: PushEvent) {
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
            this.loadAudioDevices().then(() => updateHeaderAndLiveDOM(this));
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
        if (typeof this.form.micDeskGateDb === 'number') {
          this.vuEngine.deskGateDb = this.form.micDeskGateDb;
        }
        if (typeof this.form.micHeadsetGateDb === 'number') {
          this.vuEngine.headGateDb = this.form.micHeadsetGateDb;
        }
      }
      this.loadAudioDevices().then(() => {
        updateHeaderAndLiveDOM(this);
        if (this.currentTab === 'settings' && this.settingsTab === 'discord') {
          void refreshDiscordRpcStatus(this);
        }
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

    if (e.type === 'navigate:tab' && (e as any).tab) {
      const tab = (e as any).tab as string;
      const settingsSubTabs: SettingsTab[] = ['port', 'timeouts', 'voice', 'biometrics', 'discord', 'signalrgb', 'chime', 'haos'];
      if (settingsSubTabs.includes(tab as SettingsTab)) {
        this.currentTab = 'settings';
        this.settingsTab = tab as SettingsTab;
        this.render();
      } else if (['home', 'settings', 'logs', 'about'].includes(tab)) {
        this.currentTab = tab as TabType;
        this.render();
      }
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
      updateTelemetryDOM(this);
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
      triggerOsdHud(this, 
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


    if (e.type === 'voice:listening') {
      const duration = (e as any).durationMs || 4500;
      triggerOsdHud(this, 'Słucham komendy…', 'listen', duration);
    }

    if (e.type === 'voice:listening_timeout') {
      hideOsdHud(this);
    }

    if (e.type === 'voice:understood') {
      const label = String((e as any).actionLabel || (e as any).name || 'Zrozumiałem');
      triggerOsdHud(this, label, 'ok', 2800);
    }

    if (e.type === 'voice:miss') {
      triggerOsdHud(this, 'Nie zrozumiałem komendy — powtórz proszę', 'miss', 2800);
    }

    if (e.type === 'voice:blocked') {
      const name = String((e as any).name || 'komendę');
      triggerOsdHud(this, `Zablokowano „${name}” — poza biurkiem`, 'blocked', 2800);
    }

    if (e.type === 'voice:status' && e.voiceStatus) {
      if (this.snap) {
        this.snap.voice = e.voiceStatus as any;
      }
      // Koniec pobierania — wyczyść lokalny progres, inaczej pasek zostaje na 100%
      if ((e.voiceStatus as any).state !== 'downloading' && this.voiceDownloadProgress) {
        this.voiceDownloadProgress = null;
      }
      const readyBadge = document.getElementById('badge-whisper-model-ready');
      if (readyBadge) {
        const isReady = isSelectedVoiceModelReady(this);
        readyBadge.className = `fc-badge ${isReady ? 'calibrated' : 'warning'}`;
        readyBadge.textContent = isReady ? 'Zainstalowany ✓' : 'Wymaga pobrania';
      }
      const voskBadge = document.getElementById('badge-vosk-model-ready');
      if (voskBadge) {
        const isReady = isSelectedVoiceModelReady(this);
        voskBadge.className = `fc-badge ${isReady ? 'calibrated' : 'warning'}`;
        voskBadge.textContent = isReady ? 'Zainstalowany ✓' : 'Wymaga pobrania';
      }
      // Celowany refresh żywego statusu (bez pełnego re-renderu) gdy otwarta karta głosowa
      if (this.currentTab === 'settings' && this.settingsTab === 'voice') {
        const statusBlock = document.getElementById('voice-status-block');
        if (statusBlock) statusBlock.innerHTML = renderVoiceLiveStatus(this);
        const dlSection = document.getElementById('voice-download-section');
        if (dlSection) {
          dlSection.innerHTML = renderVoiceDownloadSection(this);
          bindVoiceDynamic(this);
        }
      }
      return;
    }

    if (e.type === 'voice:downloadProgress') {
      this.voiceDownloadProgress = {
        percent: typeof e.percent === 'number' ? e.percent : 0,
        speed: typeof e.speed === 'string' ? e.speed : ''
      };
      const fill = document.getElementById('fc-voice-progress-fill');
      const meta = document.getElementById('fc-voice-progress-meta');
      if (fill) fill.style.width = `${this.voiceDownloadProgress.percent}%`;
      if (meta) meta.innerHTML = `<span>Pobieranie i przygotowanie: <strong>${this.voiceDownloadProgress.percent}%</strong></span><span>${esc(this.voiceDownloadProgress.speed)}</span>`;
      return;
    }

    if (e.type === 'voice:recognized' && e.text) {
      this.voiceLastRecognized = String(e.text);
      const transcriptEl = document.getElementById('voice-calibrator-transcript');
      const useBtn = document.getElementById('btn-use-recognized-phrase') as HTMLButtonElement | null;
      if (transcriptEl) {
        let matchBadge = '';
        if (e.matchedRule && typeof e.matchedRule === 'object') {
          const r = e.matchedRule as { name?: string; confidence?: number };
          if (r.name) {
            matchBadge = `<div style="margin-top: 6px; font-size: 11.5px; color: #10b981; display: flex; align-items: center; gap: 6px;">
              <span>🎯</span>
              <span>Zrozumiano jako: <strong>${esc(r.name)}</strong> (${r.confidence ?? 100}% trafności)</span>
            </div>`;
          }
        }
        transcriptEl.innerHTML = `<strong style="color: var(--accent); font-size: 15px;">„${esc(e.text)}”</strong>${matchBadge}`;
      }
      if (useBtn) {
        useBtn.disabled = false;
      }
      return;
    }

    if (e.type === 'flasher:start') {
      this.flasherLoading = true;
      this.flasherLogs = ['Rozpoczynanie wgrywania...'];
      this.flasherSuccess = null;
      this.render();
      return;
    }

    if (e.type === 'flasher:log') {
      const payload = e as any;
      if (payload.text) {
        this.flasherLogs.push(payload.text);
        const elConsole = document.getElementById('flasher-console');
        if (elConsole) {
          elConsole.textContent = this.flasherLogs.join('\n');
          elConsole.scrollTop = elConsole.scrollHeight;
        }
      }
      return;
    }

    if (e.type === 'flasher:done') {
      const payload = e as any;
      this.flasherLoading = false;
      this.flasherSuccess = Boolean(payload.success);
      if (payload.success) {
        this.pushToast('✓ Firmware został pomyślnie wgrany na XIAO ESP32-C6!');
      } else {
        this.pushToast(`❌ Błąd wgrywania: ${payload.error || 'Nieznany błąd'}`, true);
      }
      this.render();
      return;
    }

    if (e.type === 'voice:partial' && e.text) {
      const transcriptEl = document.getElementById('voice-calibrator-transcript');
      if (transcriptEl) {
        transcriptEl.innerHTML = `<em style="color: var(--fc-text-secondary);">${esc(e.text)}…</em>`;
      }
      return;
    }

    if (e.type === 'voice:audioLevel') {
      const level = typeof e.level === 'number' ? e.level : 0;
      const db = typeof e.db === 'number' ? e.db : -60;
      const dev = typeof e.device === 'string' ? e.device : 'Mikrofon';

      const vuFill = document.getElementById('voice-calibrator-vu-fill');
      const dbBadge = document.getElementById('voice-calibrator-db-badge');
      const devEl = document.getElementById('voice-calibrator-dev');
      const vadBadge = document.getElementById('voice-calibrator-vad-badge');

      if (vuFill) vuFill.style.width = `${Math.min(100, Math.max(0, level))}%`;
      if (dbBadge) dbBadge.textContent = `${db > -59 ? db.toFixed(1) : '-60'} dB`;
      if (devEl && devEl.textContent !== dev) devEl.textContent = dev;

      if (vadBadge && e.vad && typeof e.vad === 'object') {
        const v = e.vad as { speech?: boolean; prob?: number };
        if (v.speech) {
          vadBadge.textContent = `🎙️ AI VAD: Mowa (${Math.round(v.prob ?? 100)}%)`;
          vadBadge.style.background = 'rgba(16, 185, 129, 0.2)';
          vadBadge.style.color = '#10b981';
        } else {
          vadBadge.textContent = 'AI VAD: Cisza';
          vadBadge.style.background = 'rgba(255, 255, 255, 0.06)';
          vadBadge.style.color = 'var(--fc-text-secondary)';
        }
      }

      // Animate waveform bars on live audio level
      for (let i = 0; i < 9; i++) {
        const bar = document.getElementById(`vbar-${i}`);
        if (bar) {
          const factor = (i === 4 ? 1.0 : (i === 3 || i === 5) ? 0.8 : (i === 2 || i === 6) ? 0.6 : 0.4);
          const height = Math.max(4, Math.min(32, (level * 0.32) * factor));
          bar.style.height = `${height}px`;
        }
      }
      return;
    }

    if (e.type === 'voice:playChime') {
      const vol = this.form?.audioChimeVolume ?? 0.2;
      const chimeType = ((e as { chimeType?: string }).chimeType || 'action') as 'wake' | 'action' | 'miss';
      playVoiceFeedbackChime(chimeType, vol);
      return;
    }

    if (e.type === 'log:entry' && (e.entry || e.message)) {
      const line = e.entry || e.message || '';
      this.logs.push(line);
      if (this.logs.length > 5000) this.logs.shift();
      refreshLogConsoleDOM(this);
    }
  }

  pushToast(message: string, error = false) {
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

  renderToasts() {
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

  patchForm(patch: Partial<Snapshot['config']>, reRender = false) {
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
      updateRadarScopeDOM(this);
    }
  }

  async save() {
    if (!this.form || this.saving) return;

    // Walidacja unikalności fraz wywołania komend głosowych
    if (this.form.voiceRules && this.form.voiceRules.length > 0) {
      const seen = new Map<string, string>();
      for (const r of this.form.voiceRules) {
        if (!r.enabled) continue;
        const norm = normalizeVoicePhrase(r.phrase || '');
        if (!norm) continue;
        if (seen.has(norm)) {
          const existingName = seen.get(norm)!;
          this.saving = false;
          this.saveState = { text: 'Błąd: Zduplikowana fraza komendy!', kind: 'error' };
          const saveStateEl = document.getElementById('fc-save-state-text');
          if (saveStateEl) {
            saveStateEl.className = 'fc-save-state error';
            saveStateEl.textContent = 'Błąd: Zduplikowana fraza!';
          }
          this.pushToast(
            `🚫 Nie można zapisać: wykryto identyczną frazę wywołania „${r.phrase}” w komendach: „${existingName}” oraz „${r.name}”. Każda komenda musi mieć unikalną frazę.`,
            true
          );
          if (this.currentTab === 'settings' && this.settingsTab === 'voice') {
            this.render();
          }
          return;
        }
        seen.set(norm, r.name || 'Komenda');
      }
    }

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

  deviceListSig(devices: AudioDeviceItem[]): string {
    return devices.map((d) => `${d.id || d.name}|${d.isDefault ? 1 : 0}`).sort().join(';');
  }

  portListSig(ports: SerialPortInfo[]): string {
    return ports.map((p) => p.path).sort().join(';');
  }

  async pollHardwareLists(): Promise<void> {
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

  refreshMicSelectOptions(): void {
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
    build('sel-mic-desk-fallback', form.micDeskFallbackName || '');
    build('sel-mic-headset', form.micHeadsetName);
    build('sel-mic-headset-fallback', form.micHeadsetFallbackName || '');
  }

  refreshPortSelectOptions(): void {
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

  missingDeviceOption(savedName: string, devices: AudioDeviceItem[]): string {
    if (!savedName || devices.some((d) => d.name === savedName)) return '';
    return `<option value="${esc(savedName)}" selected>${esc(savedName)} (odłączony)</option>`;
  }

  initVolumePercent(micName: string, cfgVal: number | undefined): number {
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

            <button class="fc-mute-btn ${this.isMuted ? 'muted' : ''}" id="fc-header-mute-btn" title="Wycisz/Odcisz mikrofon (Skrót: ${esc((this.form?.globalShortcut || 'CommandOrControl+Shift+M').replace('CommandOrControl', 'Ctrl'))})">
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
              <div class="update-banner" style="border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.08); margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px">
                <div style="display: flex; align-items: center; gap: 12px">
                  <div class="update-banner-icon" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); width: 28px; height: 28px; font-size: 13px">⚠️</div>
                  <div class="update-banner-content">
                    <strong style="color: #fbbf24; font-size: 12px; margin-bottom: 2px">Wybierz mikrofony robocze</strong>
                    <div style="font-size: 11px; color: var(--fc-text-secondary); line-height: 1.3">Wskaż mikrofon stacjonarny i mobilny w kartach poniżej lub kliknij automatyczne wykrywanie.</div>
                  </div>
                </div>
                <button class="btn btn-secondary btn-sm" id="btn-banner-detect-mics" style="border-color: rgba(245, 158, 11, 0.5); color: #fbbf24; font-weight: 600; white-space: nowrap; padding: 4px 10px; font-size: 11px">🔍 Auto-wykryj</button>
              </div>` : ''}

            ${this.currentTab === 'home' ? renderHomeTab(this) : ''}
            ${this.currentTab === 'settings' ? renderSettingsTab(this) : ''}
            ${this.currentTab === 'logs' ? renderLogsTab(this) : ''}
            ${this.currentTab === 'about' ? renderAboutTab(this) : ''}
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
        ${this.vadModalOpen ? renderVadModal(this) : ''}
        ${this.diagModalOpen ? renderDiagModal(this) : ''}
        ${this.diagReportModalOpen ? renderDiagSessionModal(this) : ''}
        ${this.haPicker ? renderHaPickerModal(this) : ''}
        ${this.voiceCalibratorOpen ? renderVoiceCalibratorModal(this) : ''}
        ${this.flasherModalOpen ? renderFlasherModal(this) : ''}

        <!-- TOASTS CONTAINER (with A11y role) -->
        <div class="toasts" role="status" aria-live="polite"></div>
      </div>
    `;

    const newContentEl = this.root.querySelector('.fc-content') as HTMLElement | null;
    if (newContentEl && scrollPos > 0) {
      newContentEl.scrollTop = scrollPos;
    }

    bindEvents(this);
    this.renderToasts();
  }

}
