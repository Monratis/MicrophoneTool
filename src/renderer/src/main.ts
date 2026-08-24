import './styles.css';
import type { AudioDeviceItem, PushEvent, SerialPortInfo, Snapshot, UpdaterStatus } from './global';

const STATE_LABEL: Record<string, string> = { desk: 'Przy biurku (Stacjonarny)', away: 'Poza biurkiem (Mobilny)' };
const MODE_LABEL: Record<string, string> = {
  auto: 'Auto (radar)',
  desk: 'Stacjonarny',
  headset: 'Mobilny'
};

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

// ---------- Web Audio Chime Synthesizer ----------

function playChime(state: 'desk' | 'away', volume = 0.2) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    if (state === 'desk') {
      // Pleasant upbeat two-tone chime (D5 -> A5)
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.08);
    } else {
      // Pleasant soft down-tone (G5 -> C5)
      osc.frequency.setValueAtTime(783.99, now);
      osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.08);
    }

    const safeVol = Math.min(1, Math.max(0.01, volume));
    gain.gain.setValueAtTime(safeVol, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  } catch (_) {}
}

// ---------- Application State ----------

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
  private updater: UpdaterStatus = { status: 'idle', currentVersion: '0.2.0' };
  private downloadProgress: { percent: number; speed: string } | null = null;
  private toasts: { id: number; message: string; error?: boolean }[] = [];
  private toastCounter = 0;
  private saveState = { text: '', kind: 'idle' };

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async init() {
    this.snap = await window.api.getState();
    this.form = { ...this.snap.config };
    this.ports = await window.api.getPorts();
    await this.loadAudioDevices();

    const upd = await window.api.getUpdaterStatus();
    if (upd) this.updater = upd;

    window.api.onEvent((e: PushEvent) => this.handleEvent(e));
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
      if (!this.dirty) {
        this.form = { ...e.snapshot.config };
      }
      this.loadAudioDevices().then(() => this.render());
      return;
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
      this.render();
    }

    if (e.type === 'updater:progress') {
      this.downloadProgress = {
        percent: e.percent || 0,
        speed: e.speed || ''
      };
      this.render();
    }
  }

  private pushToast(message: string, error = false) {
    const id = ++this.toastCounter;
    this.toasts.push({ id, message, error });
    this.renderToasts();
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.renderToasts();
    }, 4000);
  }

  private patchForm(patch: Partial<Snapshot['config']>) {
    if (!this.form) return;
    this.form = { ...this.form, ...patch };
    this.dirty = true;
    this.render();
  }

  private async save() {
    if (!this.form) return;
    this.saving = true;
    this.saveState = { text: 'Zapisywanie…', kind: 'idle' };
    this.render();

    try {
      const s = await window.api.updateConfig(this.form);
      this.snap = s;
      this.form = { ...s.config };
      this.dirty = false;
      this.saveState = { text: 'Zapisano ✓', kind: 'saved' };
      this.pushToast('Konfiguracja zapisana');
    } catch (err) {
      this.saveState = { text: 'Błąd zapisu', kind: 'error' };
      this.pushToast(`Błąd zapisu: ${String(err)}`, true);
    } finally {
      this.saving = false;
      this.render();
      setTimeout(() => {
        if (this.saveState.kind !== 'idle') {
          this.saveState = { text: '', kind: 'idle' };
          this.render();
        }
      }, 2500);
    }
  }

  private renderToasts() {
    let container = document.querySelector('.toasts');
    if (!container) return;
    container.innerHTML = this.toasts
      .map((t) => `<div class="toast ${t.error ? 'error' : ''}">${t.message}</div>`)
      .join('');
  }

  render() {
    if (!this.snap || !this.form) {
      this.root.innerHTML = `<div class="app" style="display:grid;place-items:center;color:var(--muted)">Wczytywanie…</div>`;
      return;
    }

    const state = this.snap.state;
    const radar = this.snap.radar;
    const isUnconfigured = !this.form.micDeskName && !this.form.micHeadsetName;

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
            <span class="ver-tag">v${this.updater.currentVersion}</span>
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
                    <p>Wybierz mikrofon stacjonarny i mobilny z list i kliknij <strong>Zapisz zmiany</strong>. Aplikacja nie wykonuje żadnych akcji dopóki sam ich nie wskażesz.</p>
                  </div>
                </div>`
              : ''
          }

          <!-- update banners -->
          ${
            this.updater.status === 'available' && this.updater.updateInfo
              ? `<div class="update-banner">
                  <div class="update-banner-icon">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                  <div class="update-banner-content">
                    <strong>Nowa wersja dostępna: v${this.updater.updateInfo.version}</strong>
                    <p>${this.updater.updateInfo.name || 'Nowe funkcje i poprawki wydajności'}</p>
                    <button class="btn btn-sm btn-primary" id="btn-download-update">Pobierz i zaktualizuj</button>
                  </div>
                </div>`
              : ''
          }

          ${
            this.updater.status === 'downloading'
              ? `<div class="update-banner downloading">
                  <div class="update-banner-content" style="width: 100%">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                      <strong>Pobieranie aktualizacji…</strong>
                      <span>${this.downloadProgress?.percent || 0}% (${this.downloadProgress?.speed || '...'})</span>
                    </div>
                    <div class="progress-bar">
                      <div class="progress-fill" style="width: ${this.downloadProgress?.percent || 0}%"></div>
                    </div>
                  </div>
                </div>`
              : ''
          }

          ${
            this.updater.status === 'downloaded'
              ? `<div class="update-banner ready">
                  <div class="update-banner-icon">✓</div>
                  <div class="update-banner-content">
                    <strong>Aktualizacja gotowa do instalacji!</strong>
                    <p>Kliknij poniżej, aby zrestartować aplikację.</p>
                    <button class="btn btn-sm btn-primary" id="btn-install-update">Zainstaluj i uruchom ponownie</button>
                  </div>
                </div>`
              : ''
          }

          <!-- status hero -->
          <section class="card">
            <h2>Status mikrofonu</h2>
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
                  <h1>${state ? STATE_LABEL[state] : (isUnconfigured ? 'Brak konfiguracji' : 'Oczekiwanie…')}</h1>
                  <button class="mute-pill ${this.isMuted ? 'muted' : ''}" id="btn-toggle-mute" title="Wycisz/Odcisz (skrót: Ctrl+Shift+M)">
                    ${this.isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny'}
                  </button>
                </div>
                <p>
                  Domyślny mikrofon: <strong>${this.snap.deviceName ?? (isUnconfigured ? 'Nie wybrano (skonfiguruj poniżej)' : '—')}</strong>
                </p>
                <div class="badges">
                  <span class="badge">${MODE_LABEL[this.snap.mode] || this.snap.mode}</span>
                  <span class="badge ${radar.connected ? 'live' : ''}">
                    ${radar.connected ? 'Radar: połączony' : 'Radar: brak połączenia'}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <!-- mode segmented -->
          <section class="card">
            <h2>Wymuszenie trybu</h2>
            <div class="segmented">
              <button class="${this.snap.mode === 'auto' ? 'active' : ''}" data-mode="auto">Auto (radar)</button>
              <button class="${this.snap.mode === 'desk' ? 'active' : ''}" data-mode="desk">🎙️ Stacjonarny</button>
              <button class="${this.snap.mode === 'headset' ? 'active' : ''}" data-mode="headset">🎧 Mobilny</button>
            </div>
          </section>

          <!-- audio devices selection -->
          <section class="card">
            <h2>Wybór mikrofonów Windows</h2>

            <div class="field">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px">
                <label style="margin: 0; font-weight: 600">🎙️ Mikrofon stacjonarny (przy biurku / USB / XLR)</label>
                ${
                  this.form.micDeskName
                    ? `<button class="text-btn" id="btn-test-desk">▶ Przetestuj</button>`
                    : ''
                }
              </div>
              <select class="select" id="sel-mic-desk">
                <option value="">-- Wybierz mikrofon stacjonarny --</option>
                ${this.audioDevices
                  .map(
                    (d) =>
                      `<option value="${d.name}" ${d.name === this.form!.micDeskName ? 'selected' : ''}>${d.name} ${d.isDefault ? '(Aktywny domyślny)' : ''}</option>`
                  )
                  .join('')}
                <option value="__custom__" ${this.form.micDeskName && !this.audioDevices.some((d) => d.name === this.form!.micDeskName) ? 'selected' : ''}>-- Wpisz własną nazwę ręcznie --</option>
              </select>
              <input
                class="input"
                id="inp-mic-desk"
                style="margin-top: 6px"
                value="${this.form.micDeskName || ''}"
                placeholder="Wybierz z listy powyżej lub wpisz nazwę (np. HyperX QuadCast 2)"
              />
            </div>

            <div class="field" style="margin-top: 14px">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px">
                <label style="margin: 0; font-weight: 600">🎧 Mikrofon mobilny (słuchawki / headset / Bluetooth)</label>
                ${
                  this.form.micHeadsetName
                    ? `<button class="text-btn" id="btn-test-headset">▶ Przetestuj</button>`
                    : ''
                }
              </div>
              <select class="select" id="sel-mic-headset">
                <option value="">-- Wybierz mikrofon mobilny --</option>
                ${this.audioDevices
                  .map(
                    (d) =>
                      `<option value="${d.name}" ${d.name === this.form!.micHeadsetName ? 'selected' : ''}>${d.name} ${d.isDefault ? '(Aktywny domyślny)' : ''}</option>`
                  )
                  .join('')}
                <option value="__custom__" ${this.form.micHeadsetName && !this.audioDevices.some((d) => d.name === this.form!.micHeadsetName) ? 'selected' : ''}>-- Wpisz własną nazwę ręcznie --</option>
              </select>
              <input
                class="input"
                id="inp-mic-headset"
                style="margin-top: 6px"
                value="${this.form.micHeadsetName || ''}"
                placeholder="Wybierz z listy powyżej lub wpisz nazwę (np. Headset / Słuchawki)"
              />
            </div>

            <div class="field" style="margin-top: 10px">
              <div class="port-line">
                <button class="btn btn-ghost" id="btn-detect-devices" style="flex: 1">
                  Wykryj i zaproponuj mikrofony
                </button>
              </div>
              ${this.deviceInfo ? `<p class="port-hint" style="white-space: pre-line">${this.deviceInfo}</p>` : ''}
            </div>
          </section>

          <!-- behaviors & automation -->
          <section class="card">
            <h2>⚙️ Konfiguracja zachowań automatycznych</h2>

            <h3 class="sub-heading">Gdy odchodzisz od biurka (Tryb mobilny):</h3>
            
            <div class="toggle-row">
              <div class="label">
                Przełączaj na mikrofon mobilny
                <small>automatycznie ustawia mikrofon słuchawek jako domyślny</small>
              </div>
              <button class="switch" id="sw-switch-away" role="switch" aria-checked="${this.form.switchMicOnAway ?? true}"></button>
            </div>

            <div class="field" style="margin-top: 10px">
              <label>Zachowanie wyciszania po odejściu:</label>
              <select class="select" id="sel-mute-behavior">
                <option value="none" ${(this.form.muteBehaviorOnAway || 'none') === 'none' ? 'selected' : ''}>Brak wyciszania (mikrofon mobilny od razu aktywny)</option>
                <option value="mute_stationary" ${this.form.muteBehaviorOnAway === 'mute_stationary' ? 'selected' : ''}>Wycisz tylko mikrofon stacjonarny</option>
                <option value="mute_all" ${this.form.muteBehaviorOnAway === 'mute_all' ? 'selected' : ''}>Wycisz wszystkie mikrofony (tryb prywatności po odejściu)</option>
              </select>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                Dźwięk powiadomienia w słuchawkach
                <small>cichy sygnał audio potwierdzający przejście w tryb mobilny</small>
              </div>
              <button class="switch" id="sw-chime-away" role="switch" aria-checked="${this.form.audioChimeOnAway ?? true}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                Usypiaj monitory po odejściu
                <small>gasi ekrany po upływie zadanego czasu bezruchu</small>
              </div>
              <button class="switch" id="sw-sleep-display" role="switch" aria-checked="${this.form.sleepMonitorsOnAway ?? false}"></button>
            </div>

            ${
              this.form.sleepMonitorsOnAway
                ? `<div class="field" style="margin-top: 8px; padding-left: 12px; border-left: 2px solid var(--accent)">
                    <div style="display: flex; justify-content: space-between">
                      <label>Czas oczekiwania przed uśpieniem ekranów</label>
                      <span class="slider-val">${Math.round((this.form.sleepMonitorsDelayMs ?? 15000) / 1000)} s</span>
                    </div>
                    <input type="range" class="slider" id="rng-sleep-delay" min="3000" max="60000" step="1000" value="${this.form.sleepMonitorsDelayMs ?? 15000}" />
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px">
                      <p class="hint" style="margin: 0">Monitory zgasną po tylu sekundach od odejścia od biurka.</p>
                      <button class="text-btn" id="btn-test-sleep">▶ Przetestuj uśpienie</button>
                    </div>
                  </div>`
                : ''
            }

            <h3 class="sub-heading" style="margin-top: 18px">Gdy wracasz do biurka (Tryb stacjonarny):</h3>

            <div class="toggle-row">
              <div class="label">
                Przełączaj na mikrofon stacjonarny
                <small>automatycznie przywraca główny mikrofon biurkowy</small>
              </div>
              <button class="switch" id="sw-switch-desk" role="switch" aria-checked="${this.form.switchMicOnDesk ?? true}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                Automatycznie odciszaj mikrofon stacjonarny
                <small>odcisza mikrofon przy siadaniu na fotelu</small>
              </div>
              <button class="switch" id="sw-unmute-desk" role="switch" aria-checked="${this.form.unmuteOnDesk ?? true}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                Automatycznie wybudzaj monitory
                <small>natychmiast włącza ekrany po wykryciu siadania na fotelu</small>
              </div>
              <button class="switch" id="sw-wake-desk" role="switch" aria-checked="${this.form.wakeMonitorsOnDesk ?? true}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                Dźwięk powiadomienia o powrocie
                <small>przyjemny dwuton potwierdzający aktywację mikrofonu stacjonarnego</small>
              </div>
              <button class="switch" id="sw-chime-desk" role="switch" aria-checked="${this.form.audioChimeOnDesk ?? true}"></button>
            </div>
          </section>

          <!-- radar section -->
          <section class="card">
            <h2>Radar mmWave <span class="badge">Seeed 60 GHz</span></h2>

            <div class="field">
              <label>Port COM</label>
              <div class="port-line">
                <select class="select" id="sel-port">
                  <option value="auto" ${this.form.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie Seeed ESP32-C6)</option>
                  ${this.ports
                    .map(
                      (p) =>
                        `<option value="${p.path}" ${p.path === this.form!.port ? 'selected' : ''}>${p.path}${p.manufacturer ? ` · ${p.manufacturer}` : ''}</option>`
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
              ${this.ports.length === 0 ? `<p class="port-hint">Brak portów szeregowych — podłącz radar przez USB.</p>` : ''}
            </div>

            <div class="row">
              <div class="field">
                <label>Baud rate</label>
                <select class="select" id="sel-baud">
                  ${BAUD_RATES.map((b) => `<option value="${b}" ${b === this.form!.baudRate ? 'selected' : ''}>${b}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Aktywny port</label>
                <input class="input" value="${radar.port || this.form.port}" disabled />
              </div>
            </div>
          </section>

          <!-- timing & presets -->
          <section class="card">
            <h2>Czułość i opóźnienia przełączania</h2>

            <div class="preset-bar">
              <span class="preset-label">Profile:</span>
              <button class="btn-preset" data-preset="100,2000">⚡ Gaming (100ms / 2s)</button>
              <button class="btn-preset" data-preset="300,3000">⚖️ Standard (300ms / 3s)</button>
              <button class="btn-preset" data-preset="1000,8000">☕ Spokojny (1s / 8s)</button>
            </div>

            <div class="field" style="margin-top: 10px">
              <div style="display: flex; justify-content: space-between">
                <label>Siadanie przy biurku (wejście do stacjonarnego)</label>
                <span class="slider-val">${this.form.timeoutDeskMs} ms</span>
              </div>
              <input type="range" class="slider" id="rng-timeout-desk" min="0" max="3000" step="50" value="${this.form.timeoutDeskMs}" />
              <p class="hint">Błyskawiczna reakcja po zajęciu miejsca przy biurku.</p>
            </div>

            <div class="field" style="margin-top: 10px">
              <div style="display: flex; justify-content: space-between">
                <label>Odejście od biurka (przejście w mobilny)</label>
                <span class="slider-val">${this.form.timeoutAwayMs} ms</span>
              </div>
              <input type="range" class="slider" id="rng-timeout-away" min="500" max="15000" step="250" value="${this.form.timeoutAwayMs}" />
              <p class="hint">Histereza zapobiegająca przełączeniom np. przy chwilowym sięgnięciu po napój.</p>
            </div>
          </section>

          <!-- audio chime -->
          <section class="card">
            <h2>🔔 Głośność i testy dźwięku powiadomień</h2>

            <div class="toggle-row">
              <div class="label">
                Główny przełącznik dźwięków
                <small>włącza/wyłącza sygnały dźwiękowe</small>
              </div>
              <button class="switch" id="sw-audio-chime" role="switch" aria-checked="${this.form.audioChime ?? true}"></button>
            </div>

            ${
              (this.form.audioChime ?? true)
                ? `<div class="field" style="margin-top: 12px">
                    <div style="display: flex; justify-content: space-between">
                      <label>Głośność sygnału</label>
                      <span class="slider-val">${Math.round((this.form.audioChimeVolume ?? 0.2) * 100)}%</span>
                    </div>
                    <input type="range" class="slider" id="rng-chime-volume" min="0.05" max="1.0" step="0.05" value="${this.form.audioChimeVolume ?? 0.2}" />
                    <div style="display: flex; gap: 10px; margin-top: 6px">
                      <button class="btn btn-ghost btn-sm" id="btn-preview-desk" style="flex: 1">▶ Dźwięk: Stacjonarny</button>
                      <button class="btn btn-ghost btn-sm" id="btn-preview-away" style="flex: 1">▶ Dźwięk: Mobilny</button>
                    </div>
                  </div>`
                : ''
            }
          </section>

          <!-- system & features -->
          <section class="card">
            <h2>Automatyzacja i system</h2>

            <div class="toggle-row">
              <div class="label">
                Powiadomienia Windows (Toast)
                <small>pokazuje dyskretny dymek systemowy przy zmianie mikrofonu</small>
              </div>
              <button class="switch" id="sw-notifications" role="switch" aria-checked="${this.form.notifications ?? true}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                Uruchamiaj przy starcie Windows
                <small>aplikacja startuje zminimalizowana w zasobniku systemowym</small>
              </div>
              <button class="switch" id="sw-autostart" role="switch" aria-checked="${this.form.autoStart}"></button>
            </div>

            <div class="toggle-row" style="margin-top: 10px">
              <div class="label">
                🎮 Integracja z Discord (Płynny strumień głosu)
                <small>błyskawicznie synchronizuje silnik audio Discorda przy zmianie mikrofonu, eliminując zacięcia i okienka</small>
              </div>
              <button class="switch" id="sw-discord" role="switch" aria-checked="${this.form.discordIntegration ?? true}"></button>
            </div>

            <div class="field" style="margin-top: 12px">
              <label>Globalny skrót klawiszowy wyciszenia</label>
              <input class="input" id="inp-shortcut" value="${this.form.globalShortcut || 'CommandOrControl+Shift+M'}" placeholder="CommandOrControl+Shift+M" />
              <p class="hint">Domyślnie: Ctrl+Shift+M (lub Cmd+Shift+M na Mac).</p>
            </div>
          </section>

          <!-- updates & config folder -->
          <section class="card">
            <h2>Aktualizacje i pliki</h2>

            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px">
              <div>
                <span style="font-weight: 600">Wersja aplikacji: v${this.updater.currentVersion}</span>
                <small style="display: block; color: var(--muted-2)">Automatyczne sprawdzanie wydań GitHub</small>
              </div>
              <button class="btn btn-ghost btn-sm" id="btn-check-updates" ${this.updater.status === 'checking' || this.updater.status === 'downloading' ? 'disabled' : ''}>
                ${this.updater.status === 'checking' ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
              </button>
            </div>

            <div class="field">
              <label>Repozytorium GitHub</label>
              <input class="input" id="inp-repo" value="${this.form.githubRepo || 'Monratis/MicrophoneTool'}" placeholder="Monratis/MicrophoneTool" />
            </div>

            <div style="margin-top: 10px">
              <button class="btn btn-ghost btn-sm" id="btn-open-config-folder" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                Otwórz folder konfiguracji (%APPDATA%\\Audio Switcher)
              </button>
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
        </div>

        <!-- toasts container -->
        <div class="toasts"></div>
      </div>
    `;

    this.bindEvents();
    this.renderToasts();
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

    // Segmented mode buttons
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

    // Mic Desk
    byId('sel-mic-desk')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val !== '__custom__') {
        this.patchForm({ micDeskName: val });
      }
    });
    byId('inp-mic-desk')?.addEventListener('input', (e) => {
      this.patchForm({ micDeskName: (e.target as HTMLInputElement).value });
    });
    byId('btn-test-desk')?.addEventListener('click', async () => {
      if (!this.form?.micDeskName) return;
      this.pushToast(`Przełączam na: ${this.form.micDeskName}…`);
      this.snap = await window.api.testDevice(this.form.micDeskName);
      await this.loadAudioDevices();
      this.render();
    });

    // Mic Headset
    byId('sel-mic-headset')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val !== '__custom__') {
        this.patchForm({ micHeadsetName: val });
      }
    });
    byId('inp-mic-headset')?.addEventListener('input', (e) => {
      this.patchForm({ micHeadsetName: (e.target as HTMLInputElement).value });
    });
    byId('btn-test-headset')?.addEventListener('click', async () => {
      if (!this.form?.micHeadsetName) return;
      this.pushToast(`Przełączam na: ${this.form.micHeadsetName}…`);
      this.snap = await window.api.testDevice(this.form.micHeadsetName);
      await this.loadAudioDevices();
      this.render();
    });

    // Detect devices
    byId('btn-detect-devices')?.addEventListener('click', async () => {
      this.deviceInfo = 'Skanowanie podłączonych mikrofonów…';
      this.render();
      const r = await window.api.detectDevices();
      await this.loadAudioDevices();
      if (r.devices.length === 0) {
        this.deviceInfo = 'Nie znaleziono aktywnych urządzeń nagrywających w systemie Windows.';
      } else {
        if (r.recommended.micDeskName || r.recommended.micHeadsetName) {
          this.form = {
            ...this.form!,
            micDeskName: r.recommended.micDeskName || this.form?.micDeskName || '',
            micHeadsetName: r.recommended.micHeadsetName || this.form?.micHeadsetName || ''
          };
          this.dirty = true;
          this.pushToast('Zaproponowano mikrofony — kliknij "Zapisz zmiany", aby zatwierdzić');
        }
        const list = r.devices.map((d) => d.name).slice(0, 4).join(' · ');
        this.deviceInfo = `Wykryto ${r.devices.length} mikrofonów Windows:\n${list}`;
      }
      this.render();
    });

    // Behaviors
    byId('sw-switch-away')?.addEventListener('click', () => {
      this.patchForm({ switchMicOnAway: !(this.form?.switchMicOnAway ?? true) });
    });
    byId('sel-mute-behavior')?.addEventListener('change', (e) => {
      this.patchForm({ muteBehaviorOnAway: (e.target as HTMLSelectElement).value as any });
    });
    byId('sw-chime-away')?.addEventListener('click', () => {
      this.patchForm({ audioChimeOnAway: !(this.form?.audioChimeOnAway ?? true) });
    });
    byId('sw-sleep-display')?.addEventListener('click', () => {
      this.patchForm({ sleepMonitorsOnAway: !(this.form?.sleepMonitorsOnAway ?? false) });
    });
    byId('rng-sleep-delay')?.addEventListener('input', (e) => {
      this.patchForm({ sleepMonitorsDelayMs: Number((e.target as HTMLInputElement).value) });
    });
    byId('btn-test-sleep')?.addEventListener('click', async () => {
      this.pushToast('Usypianie ekranów… (porusz myszką, aby wybudzić)');
      await window.api.sleepDisplay();
    });

    byId('sw-switch-desk')?.addEventListener('click', () => {
      this.patchForm({ switchMicOnDesk: !(this.form?.switchMicOnDesk ?? true) });
    });
    byId('sw-unmute-desk')?.addEventListener('click', () => {
      this.patchForm({ unmuteOnDesk: !(this.form?.unmuteOnDesk ?? true) });
    });
    byId('sw-wake-desk')?.addEventListener('click', () => {
      this.patchForm({ wakeMonitorsOnDesk: !(this.form?.wakeMonitorsOnDesk ?? true) });
    });
    byId('sw-chime-desk')?.addEventListener('click', () => {
      this.patchForm({ audioChimeOnDesk: !(this.form?.audioChimeOnDesk ?? true) });
    });

    // Radar
    byId('sel-port')?.addEventListener('change', async (e) => {
      const port = (e.target as HTMLSelectElement).value;
      const s = await window.api.setPort(port);
      this.snap = s;
      this.form = { ...s.config };
      this.render();
    });
    byId('btn-refresh-ports')?.addEventListener('click', async () => {
      this.refreshingPorts = true;
      this.render();
      this.ports = await window.api.getPorts();
      await this.loadAudioDevices();
      this.refreshingPorts = false;
      this.render();
    });
    byId('sel-baud')?.addEventListener('change', (e) => {
      this.patchForm({ baudRate: Number((e.target as HTMLSelectElement).value) });
    });

    // Timing Presets
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const val = (e.currentTarget as HTMLElement).getAttribute('data-preset');
        if (val) {
          const [desk, away] = val.split(',').map(Number);
          this.patchForm({ timeoutDeskMs: desk, timeoutAwayMs: away });
          this.pushToast(`Zastosowano profil: ${desk}ms wejście / ${away}ms wyjście`);
        }
      });
    });

    byId('rng-timeout-desk')?.addEventListener('input', (e) => {
      this.patchForm({ timeoutDeskMs: Number((e.target as HTMLInputElement).value) });
    });
    byId('rng-timeout-away')?.addEventListener('input', (e) => {
      this.patchForm({ timeoutAwayMs: Number((e.target as HTMLInputElement).value) });
    });

    // Chime
    byId('sw-audio-chime')?.addEventListener('click', () => {
      this.patchForm({ audioChime: !(this.form?.audioChime ?? true) });
    });
    byId('rng-chime-volume')?.addEventListener('input', (e) => {
      this.patchForm({ audioChimeVolume: Number((e.target as HTMLInputElement).value) });
    });
    byId('btn-preview-desk')?.addEventListener('click', () => {
      playChime('desk', this.form?.audioChimeVolume ?? 0.2);
    });
    byId('btn-preview-away')?.addEventListener('click', () => {
      playChime('away', this.form?.audioChimeVolume ?? 0.2);
    });

    // System
    byId('sw-notifications')?.addEventListener('click', () => {
      this.patchForm({ notifications: !(this.form?.notifications ?? true) });
    });
    byId('sw-autostart')?.addEventListener('click', () => {
      this.patchForm({ autoStart: !this.form?.autoStart });
    });
    byId('sw-discord')?.addEventListener('click', () => {
      this.patchForm({ discordIntegration: !(this.form?.discordIntegration ?? true) });
    });
    byId('inp-shortcut')?.addEventListener('input', (e) => {
      this.patchForm({ globalShortcut: (e.target as HTMLInputElement).value });
    });

    // Updater & Repo
    byId('btn-check-updates')?.addEventListener('click', async () => {
      this.pushToast('Sprawdzam dostępność wydań na GitHubie…');
      try {
        const res = await window.api.checkForUpdates();
        if (res.available) {
          this.pushToast(`Dostępna nowa wersja: ${res.updateInfo?.version || 'nowa'}`);
        } else {
          this.pushToast('Posiadasz najnowszą wersję ✓');
        }
      } catch (err) {
        this.pushToast(`Błąd sprawdzania aktualizacji: ${String(err)}`, true);
      }
    });
    byId('btn-download-update')?.addEventListener('click', async () => {
      this.pushToast('Rozpoczynam pobieranie aktualizacji…');
      await window.api.downloadUpdate();
    });
    byId('btn-install-update')?.addEventListener('click', async () => {
      await window.api.installUpdate();
    });
    byId('inp-repo')?.addEventListener('input', (e) => {
      this.patchForm({ githubRepo: (e.target as HTMLInputElement).value });
    });
    byId('btn-open-config-folder')?.addEventListener('click', async () => {
      await window.api.openConfigDir();
      this.pushToast('Otwarto folder konfiguracji w Eksploratorze');
    });

    // Footer
    byId('btn-reset')?.addEventListener('click', async () => {
      const s = await window.api.resetConfig();
      this.snap = s;
      this.form = { ...s.config };
      this.dirty = false;
      this.pushToast('Przywrócono domyślne ustawienia');
      this.render();
    });
    byId('btn-save')?.addEventListener('click', () => this.save());
  }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root');
  if (root) {
    const app = new AppUI(root);
    app.init();
  }
});
