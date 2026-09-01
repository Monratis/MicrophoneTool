// Zakladka logow (filtry, konsola) i zakladka O aplikacji

import type { AppUI } from './app';
import { esc } from './ui';

  /**
   * Filtr logów wspólny dla konsoli i przycisków kopiowania — "Kopiuj RAW" /
   * "Kopiuj dla AI" zwracają dokładnie to, co użytkownik widzi w aktywnej
   * zakładce (Audio & VU, Discord & RGB itd.) plus wyszukiwarka.
   */
export function applyLogFilter(app: AppUI, logs: string[]): string[] {
  let filtered = logs;
  if (app.logFilter === 'radar') {
    filtered = filtered.filter((l) => {
      const lower = l.toLowerCase();
      return lower.includes('[radar') || lower.includes('[serial') || lower.includes('[dsp') || lower.includes('radar') || lower.includes('serial') || lower.includes('dsp');
    });
  } else if (app.logFilter === 'voice') {
    filtered = filtered.filter((l) => {
      const lower = l.toLowerCase();
      return l.includes('[VOICE') || lower.includes('voice') || lower.includes('vosk') || lower.includes('whisper') || lower.includes('mow') || lower.includes('komend') || lower.includes('wake') || lower.includes('spotter');
    });
  } else if (app.logFilter === 'haos') {
    filtered = filtered.filter((l) => l.includes('[HAOS]') || l.toLowerCase().includes('home assistant') || l.toLowerCase().includes('haos'));
  } else if (app.logFilter === 'audio') {
    filtered = filtered.filter((l) => {
      const lower = l.toLowerCase();
      return lower.includes('[audio') || lower.includes('[vu') || lower.includes('[mic') || lower.includes('audio') || lower.includes('mic') || lower.includes('sound') || lower.includes('głośn');
    });
  } else if (app.logFilter === 'discord') {
    filtered = filtered.filter((l) => {
      const lower = l.toLowerCase();
      return lower.includes('[discord') || lower.includes('[signalrgb') || lower.includes('discord') || lower.includes('signalrgb') || lower.includes('rgb');
    });
  } else if (app.logFilter === 'error') {
    filtered = filtered.filter((l) => {
      const lower = l.toLowerCase();
      return lower.includes('err') || lower.includes('błąd') || lower.includes('warn') || lower.includes('error') || lower.includes('fail') || lower.includes('awaria');
    });
  }

  if (app.logSearch) {
    const q = app.logSearch.toLowerCase();
    filtered = filtered.filter((l) => l.toLowerCase().includes(q));
  }
  return filtered;
}

export function refreshLogConsoleDOM(app: AppUI) {
  const c = document.getElementById('log-console');
  if (!c) return;

  const filtered = applyLogFilter(app, app.logs);

  c.textContent = filtered.length > 0 ? filtered.join('\n') : 'Brak pasujących logów dla zadanego filtru.';
  c.scrollTop = c.scrollHeight;
}

// ---------- LOGS TAB WITH QoL SEARCH & FILTERS ----------
export function renderLogsTab(app: AppUI): string {
  const visibleLogs = applyLogFilter(app, app.logs);
  return `
    <div class="fc-tab-pane">
      <div class="fc-settings-view">
        <div class="fc-settings-group">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--fc-card-border); padding-bottom: 8px">
            <div class="fc-settings-group-title" style="border: none; padding: 0">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--fc-accent-blue)" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
              Konsola Diagnostyczna & Logi Live (${app.logs.length} wpisów, ${visibleLogs.length} widocznych)
            </div>
            <div style="display: flex; gap: 8px">
              <button class="btn btn-primary btn-sm" id="fc-btn-copy-diag-report" title="Wygeneruj zwięzły, pełny raport diagnostyczny dla asystenta AI / programisty" style="font-size: 11px; padding: 4px 9px">🤖 Kopiuj dla AI</button>
              <button class="btn btn-secondary btn-sm" id="fc-btn-open-notepad" title="Otwórz przefiltrowane logi (.txt) w Notatniku Windows" style="font-size: 11px; padding: 4px 9px">📝 Notatnik</button>
              <button class="btn btn-ghost btn-sm" id="fc-btn-copy-logs" title="Skopiuj widoczne logi wybranej zakładki do schowka" style="font-size: 11px; padding: 4px 9px">📋 Kopiuj RAW</button>
              <button class="btn btn-ghost btn-sm" id="fc-btn-clear-logs" title="Wyczyść historię logów" style="font-size: 11px; padding: 4px 9px">🗑️ Wyczyść</button>
            </div>
          </div>

          <div class="fc-log-toolbar">
            <div class="fc-log-chips">
              <button class="fc-log-chip ${app.logFilter === 'all' ? 'active' : ''}" data-log-filter="all">Wszystkie</button>
              <button class="fc-log-chip ${app.logFilter === 'radar' ? 'active' : ''}" data-log-filter="radar">📡 Radar & DSP</button>
              <button class="fc-log-chip ${app.logFilter === 'voice' ? 'active' : ''}" data-log-filter="voice">🎙️ Mowa & Vosk</button>
              <button class="fc-log-chip ${app.logFilter === 'haos' ? 'active' : ''}" data-log-filter="haos">🏠 HAOS</button>
              <button class="fc-log-chip ${app.logFilter === 'audio' ? 'active' : ''}" data-log-filter="audio">🎙️ Audio & VU</button>
              <button class="fc-log-chip ${app.logFilter === 'discord' ? 'active' : ''}" data-log-filter="discord">🎮 Discord & RGB</button>
              <button class="fc-log-chip ${app.logFilter === 'error' ? 'active' : ''}" data-log-filter="error">⚠️ Błędy</button>
            </div>
            <input type="text" class="fc-search-input" id="inp-log-search" placeholder="🔍 Szukaj w logach…" value="${esc(app.logSearch)}" />
          </div>

          <div id="log-console" style="background: #0d1117; border: 1px solid var(--fc-card-border); border-radius: var(--fc-radius-sm); padding: 12px; height: 350px; overflow-y: auto; font-family: monospace; font-size: 11.5px; line-height: 1.5; color: #38bdf8; white-space: pre-wrap; word-break: break-all">
            ${visibleLogs.length > 0 ? esc(visibleLogs.join('\n')) : 'Brak pasujących logów dla wybranego filtru.'}
          </div>
        </div>

          <div class="fc-settings-group">
            <div class="fc-settings-group-title">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--fc-accent-blue)" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Oficjalny Firmware & Konfiguracje (60GHz MR60BHA2 / 24GHz 101010001)
            </div>
            <p style="font-size: 12px; color: var(--fc-text-secondary); line-height: 1.5">
              Sensory działają natywnie na wsadzie DeskSense Native OS lub alternatywnym ESPHome (.yaml). W repozytorium znajdują się gotowe konfiguracje dla obu modeli radaru:
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px">
              <button class="btn btn-primary btn-sm" id="btn-open-flasher-modal" style="background: linear-gradient(135deg, #10b981 0%, #0284c7 100%); border: none; font-weight: 700;">⚡ Wgraj Firmware na ESP32-C6</button>
              <button class="btn btn-secondary btn-sm" id="btn-open-stock-bin">💾 Pobierz Binarki Firmware</button>
              <button class="btn btn-ghost btn-sm" id="btn-open-seeed-wiki">🧰 Web Flasher (ESPHOME)</button>
              <button class="btn btn-ghost btn-sm" id="btn-open-seeed-gh">🐙 Repozytorium GitHub</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- ABOUT TAB WITH HEALTH DIAGNOSTICS ----------
export function renderAboutTab(app: AppUI): string {
    const isRadarConnected = Boolean(app.snap?.radar?.connected);
    const sensorModel = app.snap?.telemetry?.deviceInfo?.sensorModel || 'Radar mmWave';
    const fwVersion = app.snap?.telemetry?.deviceInfo?.fwVersion ? ` FW v${app.snap.telemetry.deviceInfo.fwVersion}` : '';
    // To jest stan PRZEŁĄCZNIKA w opcjach, nie faktyczne połączenie RPC —
    // nazwa zmiennej miała to ukrywać.
    const isDiscordEnabled = Boolean(app.form?.discordIntegration);
    const isSignalrgbEnabled = Boolean(app.form?.signalrgbEnabled);

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
            <span class="fc-badge calibrated" style="margin-top: 8px">Wersja v${esc(app.snap?.version || app.updater.currentVersion || '0.3.0')}</span>
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
                <div class="fc-diag-item-val">${isRadarConnected ? `${esc(sensorModel)}${esc(fwVersion)} (${app.form?.port || 'USB COM'})` : 'Niepołączony'}</div>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title">
                  <span>🎙️ Audio Switcher Core</span>
                  <span class="fc-badge calibrated">Aktywny ✓</span>
                </div>
                <div class="fc-diag-item-val">${app.audioDevices.length} mikrofonów Windows</div>
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
                <div class="fc-diag-item-val">${isSignalrgbEnabled ? `Port ${app.form?.signalrgbPort ?? 16038} (Lokalny)` : 'Nieaktywny'}</div>
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
              <button class="btn btn-primary btn-sm" id="fc-btn-check-updates" ${app.updater.status === 'checking' || app.updater.status === 'downloading' ? 'disabled' : ''}>
                ${app.updater.status === 'checking' ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
              </button>
            </div>

            ${app.updater.status === 'available' && app.updater.updateInfo ? `
              <div class="update-banner ready" style="margin-top: 10px">
                <div class="update-banner-icon">✓</div>
                <div class="update-banner-content">
                  <strong>Dostępna nowa wersja: v${esc(app.updater.updateInfo.version)}</strong>
                  <p>${esc(app.updater.updateInfo.name || 'Nowe funkcje i poprawki')}</p>
                  <button class="btn btn-primary btn-sm" id="btn-download-update">Pobierz i zaktualizuj</button>
                </div>
              </div>
            ` : ''}

            ${app.updater.status === 'downloading' ? `
              <div class="update-banner downloading" style="margin-top: 10px">
                <div class="update-banner-content" style="width: 100%">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                    <strong>Pobieranie aktualizacji…</strong>
                    <span id="upd-progress-text">${app.downloadProgress?.percent || 0}% (${app.downloadProgress?.speed || '...'})</span>
                  </div>
                  <div class="progress-bar">
                    <div class="progress-fill" id="upd-progress-fill" style="width: ${app.downloadProgress?.percent || 0}%"></div>
                  </div>
                </div>
              </div>
            ` : ''}

            ${app.updater.status === 'downloaded' ? `
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
