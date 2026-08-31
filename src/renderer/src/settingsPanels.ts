import type { AppUI } from './app';
import { esc, type SettingsTab } from './ui';
import { renderChimePanel, renderDiscordPanel, renderHaosPanel, renderSignalrgbPanel } from './integrationsPanels';
import { renderVoiceTab } from './voicePanel';
import { DEFAULT_CONFIG } from '../../shared/types';

  // ---------- SETTINGS TAB (LEWY PANEL USTAWIEŃ) ----------
export function renderSettingsTab(app: AppUI): string {
    const tabs: { id: SettingsTab; icon: string; label: string }[] = [
      { id: 'port', icon: '🔌', label: 'Port USB COM' },
      { id: 'timeouts', icon: '⏱️', label: 'Czasy Reakcji' },
      { id: 'voice', icon: '🎙️', label: 'Komendy Głosowe' },
      { id: 'biometrics', icon: '🐾', label: 'Zwierzęta & Biometria' },
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
              <button class="fc-settings-nav-btn ${app.settingsTab === t.id ? 'active' : ''}" data-settings-tab="${t.id}" role="tab" aria-selected="${app.settingsTab === t.id}" title="${t.label}">
                <span class="fc-settings-nav-icon">${t.icon}</span> ${t.label}
              </button>`).join('')}
          </nav>
          <div class="fc-settings-content">
            ${renderSettingsPanel(app)}
          </div>
        </div>
      </div>
    `;
  }

export function renderSettingsPanel(app: AppUI): string {
    switch (app.settingsTab) {
      case 'port': return renderPortPanel(app);
      case 'timeouts': return renderTimeoutsPanel(app);
      case 'voice': return renderVoiceTab(app);
      case 'biometrics': return renderBiometricsPanel(app);
      case 'discord': return renderDiscordPanel(app);
      case 'signalrgb': return renderSignalrgbPanel(app);
      case 'chime': return renderChimePanel(app);
      case 'haos': return renderHaosPanel(app);
      default: return '';
    }
  }

export function renderPortPanel(app: AppUI): string {
    const form = app.form!;
    const snap = app.snap!;
    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🔌 Port USB COM & Czułość Wiązki</div>
          <div>
            <label class="fc-micro-label">Port szeregowy radaru (XIAO ESP32-C6):</label>
            <select class="fc-select" id="sel-port" style="width: 100%; margin-top: 4px">
              <option value="auto" ${form.port === 'auto' ? 'selected' : ''}>auto (automatyczne wykrycie XIAO ESP32-C6)</option>
              ${app.ports.map((p) => `<option value="${esc(p.path)}" ${p.path === form.port ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`).join('')}
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
              <input type="range" class="fc-slider" id="rng-sensor-led-bri" min="0" max="100" step="5" value="${form.sensorLedBrightness ?? DEFAULT_CONFIG.sensorLedBrightness}" />
              <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-sensor-led-bri">${form.sensorLedBrightness ?? DEFAULT_CONFIG.sensorLedBrightness}%</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor — Stacjonarny (przy biurku)</div>
              <div class="fc-field-desc">Świeci, gdy jesteś przy biurku</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-led-desk" value="${esc(form.sensorLedDeskColor || DEFAULT_CONFIG.sensorLedDeskColor)}" title="Kolor diody w trybie Stacjonarnym" />
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor — Słuchawki (poza biurkiem)</div>
              <div class="fc-field-desc">Świeci, gdy mikrofon mobilny jest aktywny</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-led-away" value="${esc(form.sensorLedAwayColor || DEFAULT_CONFIG.sensorLedAwayColor)}" title="Kolor diody w trybie Słuchawki" />
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor — Mikrofon wyciszony</div>
              <div class="fc-field-desc">Nakładka koloru przy wyciszeniu (Ctrl+Shift+M)</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-led-mute" value="${esc(form.sensorLedMuteColor || DEFAULT_CONFIG.sensorLedMuteColor)}" title="Kolor diody przy wyciszonym mikrofonie" />
          </div>
        </div>

        <div class="fc-settings-group">
          <div class="fc-settings-group-title">📡 Telemetria na żywo & Urządzenie</div>
          <div class="fc-diag-grid">
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>📏 Dystans klatki piersiowej</span></div>
              <div class="fc-diag-item-val" id="card-val-distance">${app.telemetry.distanceCm ? `${app.telemetry.distanceCm} cm` : '—'}</div>
            </div>
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>💡 Światło otoczenia</span></div>
              <div class="fc-diag-item-val" id="card-val-lux">${typeof app.telemetry.illuminanceLux === 'number' ? `${app.telemetry.illuminanceLux} lx` : '—'}</div>
            </div>
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>🌡️ ESP32 / Firmware</span></div>
              <div class="fc-diag-item-val">${[app.telemetry.deviceInfo?.chipTempC ? `${app.telemetry.deviceInfo.chipTempC.toFixed(1)}°C` : '', app.telemetry.deviceInfo?.fwVersion ? `v${app.telemetry.deviceInfo.fwVersion}` : ''].filter(Boolean).join(' · ') || (snap.radar.connected ? '— (FW nie raportuje wersji)' : '—')}</div>
            </div>
            <div class="fc-diag-item">
              <div class="fc-diag-item-title"><span>⏱️ Czas pracy sensora (Uptime)</span></div>
              <div class="fc-diag-item-val">${typeof app.telemetry.deviceInfo?.uptimeSec === 'number' ? `${app.telemetry.deviceInfo.uptimeSec}s` : '—'}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

export function renderTimeoutsPanel(app: AppUI): string {
    const form = app.form!;
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
              <input type="number" class="fc-input" id="inp-timeout-away" value="${form.timeoutAwayMs ?? DEFAULT_CONFIG.timeoutAwayMs}" style="width: 90px" min="100" max="60000" step="100" />
              <span style="font-size: 11px; color: var(--fc-text-muted)">ms</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Opóźnienie powrotu (Desk)</div>
              <div class="fc-field-desc">Jak szybko po powrocie przełączyć na mikrofon stacjonarny</div>
            </div>
            <div style="display: flex; gap: 4px; align-items: center">
              <input type="number" class="fc-input" id="inp-timeout-desk" value="${form.timeoutDeskMs ?? DEFAULT_CONFIG.timeoutDeskMs}" style="width: 90px" min="0" max="10000" step="50" />
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
              <div class="fc-field-label">🔒 Czas blokady po dotknięciu myszy/klawiatury</div>
              <div class="fc-field-desc">Gwarantuje stan DESK przez zadany czas po naciśnięciu klawisza lub ruchu myszą (np. 1 s)</div>
            </div>
            <div style="display: flex; gap: 4px; align-items: center">
              <input type="number" class="fc-input" id="inp-input-hold-sec" value="${form.userInputPresenceHoldSec ?? DEFAULT_CONFIG.userInputPresenceHoldSec}" style="width: 90px" min="1" max="60" step="1" />
              <span style="font-size: 11px; color: var(--fc-text-muted)">sekund</span>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Filtr szumów & DSP</div>
              <div class="fc-field-desc">Stabilizacja odczytów radaru (filtr medianowy + EMA)</div>
            </div>
            <select class="fc-select fc-select-sm" id="sel-radar-smoothing" style="width: 180px">
              <option value="ultra" ${form.radarSmoothingMode === 'ultra' ? 'selected' : ''}>Ultra-Stabilny 🛡️</option>
              <option value="balanced" ${(form.radarSmoothingMode || DEFAULT_CONFIG.radarSmoothingMode) === 'balanced' ? 'selected' : ''}>Zbalansowany</option>
              <option value="raw" ${form.radarSmoothingMode === 'raw' ? 'selected' : ''}>Szybki / Surowy</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }

export function renderBiometricsPanel(app: AppUI): string {
    const form = app.form!;
    const person = app.telemetry.detectedPerson || 'unknown';
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
                <div class="fc-diag-item-val" id="card-val-heart">${app.telemetry.heartRate ? `${app.telemetry.heartRate} BPM` : '—'}</div>
              </div>
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🫁 Oddech live</span></div>
                <div class="fc-diag-item-val" id="card-val-breath">${app.telemetry.breathRate ? `${app.telemetry.breathRate} RPM` : '—'}</div>
              </div>
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>👤 Wykryta osoba</span></div>
                <span class="fc-badge blue" id="card-badge-person">${person === 'me' ? '👤 Człowiek ✓' : (person === 'pet' ? '🐾 Zwierzę' : '🔍 Skanowanie…')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
