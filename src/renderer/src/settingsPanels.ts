// Panele ustawien: Port, Czasy, Biometria

import type { AppUI } from './app';
import { esc, type SettingsTab } from './ui';
import { autoTuneBioLabel, autoTuneStabilityLabel, autoTuneZoneLabel } from './homeView';
import { renderChimePanel, renderDiscordPanel, renderHaosPanel, renderSignalrgbPanel } from './integrationsPanels';

  // ---------- SETTINGS TAB (LEWY PANEL USTAWIEŃ) ----------
export function renderSettingsTab(app: AppUI): string {
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
            <span class="fc-field-label">Wyuczony środek fotela</span>
            <strong style="color: #fff" id="card-val-autotune-dist">${app.telemetry.autoTuning?.adaptedDistanceCenter ? app.telemetry.autoTuning.adaptedDistanceCenter + ' cm' : '—'}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Wyuczona biometria (tętno / oddech)</span>
            <strong style="color: #fff" id="card-val-autotune-bio">${autoTuneBioLabel(app)}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Wyuczona strefa (bramka górna)</span>
            <strong style="color: #fff" id="card-val-autotune-zone">${autoTuneZoneLabel(app)}</strong>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Stabilność modelu</span>
            <strong style="color: var(--fc-accent-blue)" id="card-badge-autotune-stability">${autoTuneStabilityLabel(app, app.telemetry.autoTuning)}</strong>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-reset-autotune" style="color: #ef4444; align-self: flex-start">↺ Reset wyuczonych parametrów</button>
        </div>
      </div>
    `;
  }
