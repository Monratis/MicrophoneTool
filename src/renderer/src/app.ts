import './styles.css';
import type { AudioDeviceItem, PushEvent, RadarTelemetry, SerialPortInfo, Snapshot, UpdaterStatus } from './global';
import { esc, playChime, playCustomAudioFile, type ChimeStyle, type TabType, type SettingsTab } from './ui';
import { LiveAudioEngine } from './liveAudioEngine';
import { renderHomeTab, triggerOsdHud, updateHeaderAndLiveDOM, updateRadarScopeDOM, updateTelemetryDOM } from './homeView';
import { renderSettingsTab } from './settingsPanels';
import { renderHaPickerModal } from './integrationsPanels';
import { renderLogsTab, renderAboutTab, refreshLogConsoleDOM } from './logsAbout';
import { closeCalibrationWizard, closeVadModal, renderDiagModal, renderDiagSessionModal, renderVadModal, renderWizardModal } from './modals';
import { bindEvents } from './events';


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
  logFilter: 'all' | 'radar' | 'haos' | 'audio' | 'discord' | 'error' = 'all';
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
  haCatalog: { entity_id: string; name: string; domain: string; deviceName?: string; state?: string; unit?: string }[] = [];
  /** Otwarty picker encji: klucz pola configu, tytuł modalu i dozwolone domeny */
  haPicker: { key: string; title: string; domains: string[] } | null = null;
  haPickerSearch = '';
  haPickerDomain = '';
  /** Widok wyszukiwarki: płaska lista encji albo nawigacja po urządzeniach */
  haPickerMode: 'entities' | 'devices' = 'devices';
  /** Urządzenie, do którego weszliśmy w widoku "Urządzenia" ('' = poziom listy) */
  haPickerDevice = '';
  /** Trwa auto-pobieranie katalogu encji po otwarciu pickera */
  haFetchingPicker = false;
  haShowToken = false;

  // Telemetria biometryczna na żywo
  telemetry: RadarTelemetry = {
    distanceCm: 0,
    distanceTrusted: true,
    targetCount: undefined,
    heartRate: 0,
    breathRate: 0,
    illuminanceLux: undefined,
    detectedPerson: 'unknown',
    autoTuning: {
      enabled: true,
      samplesCount: 0,
      adaptedDistanceCenter: 0,
      adaptedDistanceMin: 0,
      adaptedDistanceMax: 0,
      adaptedHeartRateAvg: 0,
      adaptedBreathRateAvg: 0,
      stabilityScore: 0,
      stabilityReady: false
    }
  };

  // Modale aplikacji
  wizardOpen = false;
  wizardStep: 1 | 2 | 3 = 1;
  wizardCountdown = 0;
  wizardInterval: any = null;
  wizardWarning = '';
  wizardPresenceSeen = false;
  wizardSamples: { distances: number[] } = {
    distances: []
  };
  wizardResults = {
    distance: 75,
    gateMin: 45,
    gateMax: 110
  };

  diagModalOpen = false;
  logs: string[] = [];

  // Sesja diagnostyczna "Wyjście z pokoju"
  diagActive = false;
  diagSessionText = '';
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
          closeCalibrationWizard(this);
        } else if (this.vadModalOpen) {
          ev.preventDefault();
          closeVadModal(this);
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
      }
      this.loadAudioDevices().then(() => {
        updateHeaderAndLiveDOM(this);
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
      updateTelemetryDOM(this);

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
    build('sel-mic-headset', form.micHeadsetName);
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
        ${this.wizardOpen ? renderWizardModal(this) : ''}
        ${this.vadModalOpen ? renderVadModal(this) : ''}
        ${this.diagModalOpen ? renderDiagModal(this) : ''}
        ${this.diagReportModalOpen ? renderDiagSessionModal(this) : ''}
        ${this.haPicker ? renderHaPickerModal(this) : ''}

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
