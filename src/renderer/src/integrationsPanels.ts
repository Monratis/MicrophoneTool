// Panele integracji: Discord, SignalRGB, Chime, Home Assistant (HAOS)

import type { AppUI } from './app';
import { esc } from './ui';
import { DEFAULT_CONFIG } from '../../shared/types';
import { formatAcceleratorDisplay } from './hotkeyRecorder';

let lastSrgbStatusFetch = 0;

export function renderDiscordPanel(app: AppUI): string {
    const form = app.form!;
    const snap = app.snap!;
    const gateVal = snap.state === 'desk'
      ? Math.max(-100, Math.min(0, form.micDeskGateDb ?? -45))
      : Math.max(-100, Math.min(0, form.micHeadsetGateDb ?? -45));

    const discord = snap.discord;
    let statusText = 'Brak połączenia — Discord nie uruchomiony ✗';
    let statusColor = '#ef4444';

    if (form.discordIntegration === false) {
      statusText = 'Integracja wyłączona';
      statusColor = 'var(--fc-text-dim)';
    } else if (discord?.ready) {
      if (discord.authenticated) {
        const badges: string[] = [];
        if (discord.inVoiceCall) badges.push('📞 W rozmowie');
        if (discord.muted) badges.push('🔇 Mute');
        if (discord.deaf) badges.push('🎧 Deaf');
        const badgeStr = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
        statusText = `Połączono${discord.user ? ` (@${discord.user})` : ''}${badgeStr} ✓`;
        statusColor = '#22c55e';
      } else {
        statusText = 'Połączono (wymagana autoryzacja OAuth) ⚠';
        statusColor = '#fbbf24';
      }
    } else if (discord?.connected) {
      statusText = 'Handshake w toku…';
      statusColor = '#fbbf24';
    }

    const isAuto = snap.state === 'desk' ? form.micDeskAutoThreshold : form.micHeadsetAutoThreshold;
    const rawGate = snap.state === 'desk' ? form.micDeskGateDb : form.micHeadsetGateDb;
    const gateLabel = isAuto
      ? 'Auto (Voice Isolation)'
      : rawGate === -1
        ? 'Push-to-Talk (PTT)'
        : `${gateVal} dB`;
    const gateColor = isAuto ? '#a855f7' : rawGate === -1 ? '#38bdf8' : '#fbbf24';

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
          <div style="display: flex; gap: 6px; flex-wrap: wrap">
            <button class="btn btn-secondary btn-sm" id="btn-discord-auth" style="flex: 1; min-width: 140px" title="Wywołaj okno autoryzacji OAuth w aplikacji Discord">🔐 Autoryzuj Discord</button>
            <button class="btn btn-primary btn-sm" id="btn-discord-fetch" style="flex: 1; min-width: 130px" title="Pobierz bieżący próg VAD i filtry DSP z aplikacji Discord">⬇️ Pobierz profil</button>
            <button class="btn btn-ghost btn-sm" id="btn-discord-sync" style="flex: 1; min-width: 130px" title="Wyślij bieżący profil głosu i przełącz urządzenie wejściowe w Discordzie">📤 Wyślij do Discorda</button>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Połączenie z Discordem</span>
            <strong id="discord-rpc-status-val" style="color: ${statusColor}">${statusText}</strong>
          </div>
          <div class="fc-field-row" style="border-top: 1px solid var(--fc-card-border); padding-top: 10px">
            <span class="fc-field-label">Aktywny próg Discord</span>
            <strong style="color: ${gateColor}">${gateLabel}</strong>
          </div>
        </div>
      </div>
    `;
  }

  /** Wiersz "Local API SignalRGB" w panelu — wykryty tier (REST vs deep-link only). */
export async function refreshSignalrgbStatus(_app: AppUI): Promise<void> {
    const now = Date.now();
    if (now - lastSrgbStatusFetch < 5000) return;
    lastSrgbStatusFetch = now;
    let el = document.getElementById('signalrgb-status-val');
    if (!el) return;
    try {
      const s = await window.api.signalrgbGetStatus();
      el = document.getElementById('signalrgb-status-val');
      if (!el) return; // render mógł podmienić DOM w trakcie zapytania
      if (s.restAvailable) {
        el.textContent = 'REST dostępny ✓ (pełne funkcje)';
        el.style.color = '#22c55e';
      } else if (s.proRequired) {
        el.textContent = 'Wymagane Pro — tylko deep-linki';
        el.title = s.detail || 'Local API zwraca 403 bez SignalRGB Pro';
        el.style.color = '#fbbf24';
      } else {
        el.textContent = 'Brak odpowiedzi (apka uruchomiona?)';
        el.style.color = '#ef4444';
      }
    } catch {
      const target = document.getElementById('signalrgb-status-val');
      if (target) {
        target.textContent = 'Błąd zapytania';
        target.style.color = '#ef4444';
      }
    }
  }

  /** Podpowiedzi i lista efektów z dysku SignalRGB (bez Pro) do obu pickerów. */
export async function refreshSignalrgbEffectList(app: AppUI): Promise<void> {
    try {
      const names = await window.api.signalrgbListEffects();
      if (Array.isArray(names) && names.length > 0) {
        app.signalrgbEffects = names;
        const countEl = document.getElementById('signalrgb-effects-count');
        if (countEl) countEl.textContent = `(wykryto: ${names.length})`;
        const target = document.getElementById('signalrgb-effects-list');
        if (target) {
          target.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
        }
      }
    } catch {
      /* lista niedostępna — inputy zostają free-text */
    }
  }

  /** Aktualizuje wiersz "Połączenie z Discordem" w panelu (element istnieje tylko tam). */
export async function refreshDiscordRpcStatus(_app: AppUI): Promise<void> {
    const val = document.getElementById('discord-rpc-status-val');
    if (!val) return;
    try {
      const s = await window.api.discordGetStatus();
      const target = document.getElementById('discord-rpc-status-val');
      if (!target) return; // render mógł podmienić DOM w trakcie zapytania
      if (s.ready) {
        const badges: string[] = [];
        if (s.inVoiceCall) badges.push('📞 W rozmowie');
        if (s.muted) badges.push('🔇 Mute');
        if (s.deaf) badges.push('🎧 Deaf');
        const badgeStr = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
        target.textContent = s.authenticated
          ? `Połączono${s.user ? ` (@${s.user})` : ''}${badgeStr} ✓`
          : 'Połączono (wymagana autoryzacja OAuth) ⚠';
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

export function renderSignalrgbPanel(app: AppUI): string {
    const form = app.form!;
    const effects =
      app.signalrgbEffects && app.signalrgbEffects.length > 0
        ? app.signalrgbEffects
        : ['Solid Color', 'Neon Shift', 'Rainbow', 'Screen Ambience', 'Color Shift', 'Side To Side'];

    const deskAction =
      form.signalrgbDeskAction ||
      (form.signalrgbRestoreOnDesk === false ? 'none' : 'effect');
    const awayAction = form.signalrgbAwayAction || 'solid_color';

    const curAway = (form.signalrgbAwayEffect || '').trim();
    const curDesk = (form.signalrgbDeskEffect || '').trim();

    const isAwayInList = !curAway || curAway === 'Solid Color' || effects.includes(curAway);
    const isDeskInList = !curDesk || curDesk === 'Neon Shift' || effects.includes(curDesk);

    const awayOptions = [
      `<option value="Solid Color" ${!curAway || curAway === 'Solid Color' ? 'selected' : ''}>Solid Color (z kolorem)</option>`,
      ...effects
        .filter((e) => e !== 'Solid Color')
        .map((e) => `<option value="${esc(e)}" ${curAway === e ? 'selected' : ''}>${esc(e)}</option>`),
      ...(!isAwayInList && curAway ? [`<option value="${esc(curAway)}" selected>Własny: ${esc(curAway)}</option>`] : []),
      `<option value="__custom__" ${app.signalrgbCustomAway ? 'selected' : ''}>✏️ Wpisz własną nazwę…</option>`
    ].join('');

    const deskOptions = [
      ...effects.map((e) => `<option value="${esc(e)}" ${(curDesk || 'Neon Shift') === e ? 'selected' : ''}>${esc(e)}</option>`),
      ...(!isDeskInList && curDesk ? [`<option value="${esc(curDesk)}" selected>Własny: ${esc(curDesk)}</option>`] : []),
      `<option value="__custom__" ${app.signalrgbCustomDesk ? 'selected' : ''}>✏️ Wpisz własną nazwę…</option>`
    ].join('');

    return `
      <div class="fc-settings-panel">
        <div class="fc-settings-group">
          <div class="fc-settings-group-title">🌈 SignalRGB LED Sync</div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Włącz synchronizację oświetlenia</div>
              <div class="fc-field-desc">Lokalne REST API SignalRGB (port ${form.signalrgbPort ?? DEFAULT_CONFIG.signalrgbPort})</div>
            </div>
            <button class="fc-switch ${form.signalrgbEnabled ? 'active' : ''}" id="sw-signalrgb" aria-checked="${form.signalrgbEnabled ?? false}" role="switch"></button>
          </div>
          <div class="fc-field-row">
            <span class="fc-field-label">Local API SignalRGB</span>
            <strong id="signalrgb-status-val" style="color: var(--fc-text-dim)">…</strong>
          </div>

          <div style="border-top: 1px solid var(--fc-card-border); margin: 10px 0 6px; padding-top: 8px">
            <div style="font-size: 11.5px; font-weight: 700; color: var(--fc-accent-green); margin-bottom: 8px">🖥️ Gdy jesteś przy biurku (Stan: BIURKO)</div>
          </div>

          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Akcja oświetlenia przy biurku</div>
              <div class="fc-field-desc">Wybierz stały efekt pracy przy biurku lub odtwórz stan sprzed odejścia</div>
            </div>
            <select class="fc-select fc-select-sm" id="sel-signalrgb-desk-action" style="width: 200px">
              <option value="effect" ${deskAction === 'effect' ? 'selected' : ''}>Ustaw wybrany efekt</option>
              <option value="restore" ${deskAction === 'restore' ? 'selected' : ''}>Przywróć stan sprzed odejścia (Pro)</option>
              <option value="none" ${deskAction === 'none' ? 'selected' : ''}>Brak akcji (nie zmieniaj)</option>
            </select>
          </div>

          ${deskAction === 'effect' ? `
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Efekt przy biurku</div>
              <div class="fc-field-desc">Efekt świetlny aktywowany, gdy usiądziesz przy biurku</div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center">
              ${app.signalrgbCustomDesk ? `
                <input type="text" class="fc-input fc-input-sm" id="inp-signalrgb-desk-effect-custom" list="signalrgb-effects-list" placeholder="np. Neon Shift" value="${esc(curDesk || 'Neon Shift')}" style="width: 155px; height: 30px; font-size: 11.5px" />
                <button class="btn btn-ghost btn-sm" id="btn-cancel-custom-desk" title="Wróć do listy rozwijanej" style="padding: 4px 8px">↩️</button>
              ` : `
                <select class="fc-select fc-select-sm" id="sel-signalrgb-desk-effect" style="width: 180px">
                  ${deskOptions}
                </select>
              `}
              <button class="btn btn-ghost btn-sm" id="btn-preview-signalrgb-desk" title="Sprawdź / przetestuj ten efekt na żywo w SignalRGB" style="padding: 4px 9px">▶️</button>
            </div>
          </div>
          ${(curDesk === 'Solid Color' || app.signalrgbCustomDesk) ? `
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor efektu przy biurku</div>
              <div class="fc-field-desc">Kolor przekazywany jako parametr dla efektu Solid Color</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-signalrgb-desk" value="${esc(form.signalrgbDeskColor || '#00e5ff')}" title="Kolor oświetlenia przy biurku" />
          </div>` : ''}
          ` : ''}

          <div style="border-top: 1px solid var(--fc-card-border); margin: 10px 0 6px; padding-top: 8px">
            <div style="font-size: 11.5px; font-weight: 700; color: #fbbf24; margin-bottom: 8px">🚶 Po odejściu od biurka (Stan: ODEJŚCIE)</div>
          </div>

          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Akcja po odejściu</div>
              <div class="fc-field-desc">Co zrobić z podświetleniem po wykryciu nieobecności</div>
            </div>
            <select class="fc-select fc-select-sm" id="sel-signalrgb-away-action" style="width: 200px">
              <option value="solid_color" ${awayAction === 'solid_color' ? 'selected' : ''}>Ustaw efekt / Kolor ostrzegawczy</option>
              <option value="turn_off" ${awayAction === 'turn_off' ? 'selected' : ''}>Zgaś całkowicie LED (Black)</option>
              <option value="dim" ${awayAction === 'dim' ? 'selected' : ''}>Przyciemnij oświetlenie (Pro)</option>
            </select>
          </div>

          ${awayAction === 'solid_color' ? `
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Efekt przy odejściu</div>
              <div class="fc-field-desc">Wybierz efekt z biblioteki SignalRGB. Kolor przekazywany jest jako parametr.</div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center">
              ${app.signalrgbCustomAway ? `
                <input type="text" class="fc-input fc-input-sm" id="inp-signalrgb-away-effect-custom" list="signalrgb-effects-list" placeholder="Nazwa efektu" value="${esc(curAway)}" style="width: 155px; height: 30px; font-size: 11.5px" />
                <button class="btn btn-ghost btn-sm" id="btn-cancel-custom-away" title="Wróć do listy rozwijanej" style="padding: 4px 8px">↩️</button>
              ` : `
                <select class="fc-select fc-select-sm" id="sel-signalrgb-away-effect" style="width: 180px">
                  ${awayOptions}
                </select>
              `}
              <button class="btn btn-ghost btn-sm" id="btn-preview-signalrgb-away" title="Sprawdź / przetestuj ten efekt na żywo w SignalRGB" style="padding: 4px 9px">▶️</button>
            </div>
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor ostrzegawczy</div>
              <div class="fc-field-desc">Kolor przekazany efektowi jako parametr (efekty bez parametru koloru go ignorują)</div>
            </div>
            <input type="color" class="fc-color-input" id="clr-signalrgb-away" value="${esc(form.signalrgbAwayColor || DEFAULT_CONFIG.signalrgbAwayColor)}" title="Kolor oświetlenia po odejściu" />
          </div>` : ''}

          ${awayAction === 'dim' ? `
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Poziom przyciemnienia</div>
            </div>
            <div class="fc-slider-row" style="width: 180px">
              <input type="range" class="fc-slider" id="rng-signalrgb-bri" min="0" max="100" step="5" value="${form.signalrgbAwayBrightness ?? DEFAULT_CONFIG.signalrgbAwayBrightness}" />
              <span style="font-size: 11px; font-weight: 600; color: #fff; width: 34px; text-align: right" id="val-signalrgb-bri">${form.signalrgbAwayBrightness ?? DEFAULT_CONFIG.signalrgbAwayBrightness}%</span>
            </div>
          </div>` : ''}

          <datalist id="signalrgb-effects-list">
            ${effects.map((e) => `<option value="${esc(e)}"></option>`).join('')}
          </datalist>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; padding: 4px 0">
            <span style="font-size: 10.5px; color: var(--fc-text-muted)">Zainstalowane efekty: <strong id="signalrgb-effects-count" style="color: var(--fc-text-primary)">${effects.length}</strong></span>
            <button class="text-btn" id="btn-refresh-signalrgb-effects" title="Przeskanuj ponownie bibliotekę SignalRGB w poszukiwaniu nowych efektów">🔄 Odśwież listę efektów</button>
          </div>

          <div style="font-size: 10.5px; color: var(--fc-text-muted); line-height: 1.5; margin-top: 4px">
            Bez SignalRGB Pro działają: wybór dowolnego efektu na biurko i odejście, „Kolor ostrzegawczy" oraz „Zgaś całkowicie" (czarny Solid Color). „Przyciemnij" oraz automatyczne przywracanie stanu sprzed odejścia wymagają REST z Pro.
          </div>

          <div style="display: flex; gap: 6px; margin-top: 10px">
            <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-desk" style="flex: 1">Test: Biurko</button>
            <button class="btn btn-ghost btn-sm" id="btn-test-signalrgb-away" style="flex: 1">Test: Odejście</button>
          </div>
        </div>
      </div>
    `;
  }

  /** Wiersz wyboru własnego pliku audio dla profilu (desk / headset). */
export function renderCustomAudioRow(_app: AppUI, variant: 'desk' | 'headset', label: string, desc: string, filePath: string): string {
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

export function renderChimePanel(app: AppUI): string {
    const form = app.form!;
    const chimeVol = Math.round((form.audioChimeVolume ?? DEFAULT_CONFIG.audioChimeVolume) * 100);
    const ssDelay = form.screensaverDelayMs ?? DEFAULT_CONFIG.screensaverDelayMs;
    const sleepDelay = form.sleepMonitorsDelayMs ?? DEFAULT_CONFIG.sleepMonitorsDelayMs;
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
                <option value="harmonic" ${app.selectedChimeStyle === 'harmonic' ? 'selected' : ''}>Harmoniczny dwuton</option>
                <option value="modern" ${app.selectedChimeStyle === 'modern' ? 'selected' : ''}>Modern sci-fi ping</option>
                <option value="soft_click" ${app.selectedChimeStyle === 'soft_click' ? 'selected' : ''}>Miękki klik studyjny</option>
                <option value="marimba" ${app.selectedChimeStyle === 'marimba' ? 'selected' : ''}>Ciepła marimba</option>
              </select>
              <button class="btn btn-ghost btn-sm" id="btn-test-chime" title="Przetestuj dźwięk">🔔</button>
            </div>
          </div>
          ${renderCustomAudioRow(app, 'desk', 'Własny dźwięk — Stacjonarny', 'Zagra przy przejściu na mikrofon biurkowy', form.audioFileDesk || '')}
          ${renderCustomAudioRow(app, 'headset', 'Własny dźwięk — Słuchawki', 'Zagra przy przejściu na mikrofon mobilny', form.audioFileHeadset || '')}
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
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Globalny przycisk wyciszenia (Hotkey / Mysz)</div>
              <div class="fc-field-desc">Wycisz lub odcisz mikrofon z dowolnego programu (kliknij, aby nagrać klawisz lub przycisk myszy)</div>
            </div>
            <div class="fc-hotkey-recorder" id="mute-hotkey-recorder-container">
              <button type="button" class="fc-hotkey-btn" id="btn-record-mute-hotkey" title="Kliknij, aby nagrać dowolny klawisz lub przycisk myszy">
                <span class="fc-hotkey-display" id="mute-hotkey-display">${formatAcceleratorDisplay(form.globalShortcut || 'CommandOrControl+Shift+M')}</span>
              </button>
              ${form.globalShortcut ? `<button type="button" class="btn btn-ghost btn-sm fc-hotkey-clear-btn" id="btn-clear-mute-hotkey" title="Usuń skrót" style="font-size: 11px; padding: 2px 7px; height: 26px;">✕</button>` : ''}
            </div>
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

// ---------- HAOS: Badge domeny encji + wyszukiwarka (picker) ----------

/** Klasa badge wg domeny encji — szybki wizualny rozróżniacz w liście. */
export function haDomainBadge(domain: string): string {
  if (domain === 'binary_sensor') return 'calibrated';
  if (domain === 'sensor') return 'blue';
  if (domain === 'light') return 'amber';
  if (domain === 'switch' || domain === 'input_boolean') return 'calibrated';
  if (domain === 'scene' || domain === 'script' || domain === 'automation') return 'blue';
  if (domain === 'media_player') return 'purple';
  if (domain === 'climate') return 'rose';
  return 'amber';
}

export function openHaPickerForRule(app: AppUI, ruleIndex: number): void {
  app.haPicker = {
    ruleIndex,
    title: 'Wybierz urządzenie lub encję Home Assistant',
    domains: [
      'light',
      'switch',
      'scene',
      'script',
      'automation',
      'button',
      'input_button',
      'input_boolean',
      'media_player',
      'cover',
      'climate',
      'fan',
      'lock',
      'vacuum'
    ]
  };
  app.haPickerSearch = '';
  app.haPickerDomain = '';
  app.haPickerArea = '';
  app.haPickerDevice = '';
  app.render();
  void ensureHaCatalog(app);
}

export function closeHaPicker(app: AppUI): void {
  app.haPicker = null;
  app.render();
}

const CATALOG_CACHE_KEY = 'desksense-ha-catalog';

/** Normalizacja tekstu do wyszukiwania: lower-case + bez polskich diakrytyków. */
function haNorm(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Ujednolica wynik haFetchEntities do katalogu pickera i cache'uje go w
 * localStorage — dzięki temu po restarcie apki wyszukiwarka działa od razu,
 * bez ponownego pobierania.
 */
export function applyHaCatalog(app: AppUI, res: Awaited<ReturnType<typeof window.api.haFetchEntities>>): void {
  app.haCatalog = [
    ...(res.binarySensors || []).map((s) => ({ entity_id: s.entity_id, name: s.name, domain: 'binary_sensor', deviceName: s.deviceName, areaName: s.areaName, state: s.state })),
    ...(res.sensors || []).map((s) => ({ entity_id: s.entity_id, name: s.name, domain: 'sensor', deviceName: s.deviceName, areaName: s.areaName, state: s.state, unit: s.unit })),
    ...(res.actions || []).map((a) => ({ entity_id: a.entity_id, name: a.name, domain: a.domain, deviceName: a.deviceName, areaName: a.areaName }))
  ];
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(app.haCatalog));
  } catch { /* brak localStorage — katalog zostaje tylko w pamięci */ }
}

/**
 * Gwarantuje, że picker ma skąd czytać: najpierw cache z localStorage,
 * a gdy pusto i token jest ustawiony — auto-pobranie encji z HAOS w tle.
 */
export async function ensureHaCatalog(app: AppUI): Promise<void> {
  if (app.haCatalog.length > 0 || app.haFetchingPicker || !app.haPicker) return;
  try {
    const cached = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || '[]') as typeof app.haCatalog;
    if (Array.isArray(cached) && cached.length > 0) {
      app.haCatalog = cached;
      app.render();
      return;
    }
  } catch { /* uszkodzony cache — pobierzemy od zera */ }
  if (!(app.form?.haToken || '').trim()) return; // lista pokaże podpowiedź o tokenie
  app.haFetchingPicker = true;
  app.render();
  try {
    const res = await window.api.haFetchEntities({ url: app.form?.haUrl, token: app.form?.haToken });
    if (res.ok) applyHaCatalog(app, res);
  } catch { /* nie blokuj pickera — podpowiedź zostaje */ }
  app.haFetchingPicker = false;
  app.render();
}

/** Chipki trybu (Pokoje/Urządzenia/Encje) + filtry domen w pickercie. */
export function renderHaPickerChips(app: AppUI): string {
  const viewChips = `
    <div style="display:flex; gap:6px; flex-wrap:wrap">
      <button class="fc-log-chip ${app.haPickerMode === 'areas' ? 'active' : ''}" data-ha-picker-view="areas">🏷️ Pokoje / Obszary</button>
      <button class="fc-log-chip ${app.haPickerMode === 'devices' ? 'active' : ''}" data-ha-picker-view="devices">📦 Urządzenia</button>
      <button class="fc-log-chip ${app.haPickerMode === 'entities' ? 'active' : ''}" data-ha-picker-view="entities">🔤 Wszystkie encje</button>
    </div>`;
  const domainChips = `
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px">
      <button class="fc-log-chip ${app.haPickerDomain === '' ? 'active' : ''}" data-ha-picker-domain="">Wszystkie domeny</button>
      ${(app.haPicker?.domains || []).map((d) => `<button class="fc-log-chip ${app.haPickerDomain === d ? 'active' : ''}" data-ha-picker-domain="${esc(d)}">${esc(d)}</button>`).join('')}
    </div>`;
  return viewChips + domainChips;
}

/** Wiersz pojedynczej encji w liście (wspólny dla widoku płaskiego, pokoju i urządzenia). */
function haEntityRow(app: AppUI, e: { entity_id: string; name: string; domain: string; deviceName?: string; areaName?: string; state?: string; unit?: string }): string {
  let currentValue = '';
  if (app.haPicker?.key) {
    currentValue = String((app.form as unknown as Record<string, unknown>)?.[app.haPicker.key] || '');
  } else if (app.haPicker?.ruleIndex !== undefined) {
    const r = app.form?.voiceRules?.[app.haPicker.ruleIndex];
    if (r?.actionPayload) {
      if (r.actionPayload.trim().startsWith('{')) {
        try {
          currentValue = (JSON.parse(r.actionPayload) as Record<string, unknown>).entity_id as string || '';
        } catch {
          currentValue = r.actionPayload.trim();
        }
      } else {
        currentValue = r.actionPayload.trim();
      }
    }
  }
  const isSelected = currentValue === e.entity_id;
  const stateInfo = (e.domain === 'sensor' || e.domain === 'binary_sensor') && e.state
    ? `<span style="font-size:10px; color:var(--fc-text-muted); flex-shrink:0">${esc(e.state)}${e.unit ? ` ${esc(e.unit)}` : ''}</span>`
    : '';
  const check = isSelected ? `<span style="color:var(--fc-accent-green); flex-shrink:0">✓</span>` : '';
  const metaParts: string[] = [e.entity_id];
  if (e.areaName) metaParts.push(`🏷️ ${e.areaName}`);
  if (e.deviceName) metaParts.push(`📦 ${e.deviceName}`);
  const metaText = metaParts.join(' · ');

  return `
    <button data-ha-entity="${esc(e.entity_id)}"
      style="width:100%; display:flex; align-items:center; gap:8px; padding:7px 10px; border:none; border-bottom:1px solid var(--fc-card-border); background:${isSelected ? 'rgba(34,197,94,0.08)' : 'transparent'}; cursor:pointer; text-align:left">
      <span class="fc-badge ${haDomainBadge(e.domain)}" style="flex-shrink:0">${esc(e.domain)}</span>
      <span style="display:flex; flex-direction:column; min-width:0; flex:1">
        <span style="font-size:11.5px; color:var(--fc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(e.name)}</span>
        <span style="font-size:10px; color:var(--fc-text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(metaText)}</span>
      </span>
      ${stateInfo}
      ${check}
    </button>
  `;
}

/** Filtrowana lista: pokoje/obszary / urządzenia / płaska lista encji. */
export function renderHaPickerList(app: AppUI): string {
  if (!app.haPicker) return '';
  if (app.haFetchingPicker) {
    return `<div style="padding:16px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">⏳ Pobieram encje z Home Assistanta…</div>`;
  }
  if (app.haCatalog.length === 0) {
    return `<div style="padding:16px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">
              Katalog encji jest pusty. Uzupełnij adres i token HAOS, a wyszukiwarka pobierze encje automatycznie
              (albo użyj "🔍 Wykryj & Pobierz encje z HAOS").
            </div>`;
  }
  const q = haNorm(app.haPickerSearch.trim());
  const matchesDomain = (e: { domain: string }): boolean => !app.haPickerDomain || e.domain === app.haPickerDomain;

  // 1. Widok "Pokoje / Obszary" — po wejściu do wybranego pokoju
  if (app.haPickerMode === 'areas' && app.haPickerArea) {
    const inside = app.haCatalog.filter((e) => matchesDomain(e) && (e.areaName || '(Bez pokoju)') === app.haPickerArea)
      .filter((e) => !q || haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q) || haNorm(e.deviceName || '').includes(q))
      .slice(0, 150);
    const back = `
      <button data-ha-picker-back-area="1"
        style="width:100%; display:flex; align-items:center; gap:6px; padding:7px 10px; border:none; border-bottom:1px solid var(--fc-card-border); background:rgba(255,255,255,0.03); cursor:pointer; text-align:left; font-size:11px; color:var(--fc-accent-blue)">
        ← Wszystkie pokoje / obszary (Aktualnie: <strong>${esc(app.haPickerArea)}</strong>)
      </button>`;
    const rows = inside.length > 0
      ? inside.map((e) => haEntityRow(app, e)).join('')
      : `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">Ten pokój nie zawiera encji w dozwolonych domenach.</div>`;
    return back + rows;
  }

  // 2. Widok "Pokoje / Obszary" — lista wszystkich pokoi
  if (app.haPickerMode === 'areas') {
    const entityHit = new Set<string>();
    if (q) {
      for (const e of app.haCatalog) {
        if (!matchesDomain(e)) continue;
        if (haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q) || haNorm(e.deviceName || '').includes(q)) {
          entityHit.add(e.areaName || '(Bez pokoju)');
        }
      }
    }
    const groups = new Map<string, { count: number; devices: Set<string>; domains: Set<string> }>();
    for (const e of app.haCatalog) {
      if (!matchesDomain(e)) continue;
      const key = e.areaName || '(Bez pokoju)';
      if (q && !haNorm(key).includes(q) && !entityHit.has(key)) continue;
      const g = groups.get(key) || { count: 0, devices: new Set<string>(), domains: new Set<string>() };
      g.count++;
      if (e.deviceName) g.devices.add(e.deviceName);
      g.domains.add(e.domain);
      groups.set(key, g);
    }
    if (groups.size === 0) {
      return `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">Brak pokoi / obszarów pasujących do zapytania.</div>`;
    }
    const keys = Array.from(groups.keys()).sort((a, b) => (a === '(Bez pokoju)' ? 1 : 0) - (b === '(Bez pokoju)' ? 1 : 0) || a.localeCompare(b, 'pl'));
    return keys.map((name) => {
      const g = groups.get(name)!;
      const badges = Array.from(g.domains).map((d) => `<span class="fc-badge ${haDomainBadge(d)}">${esc(d)}</span>`).join(' ');
      const deviceCount = g.devices.size;
      return `
        <button data-ha-area="${esc(name)}"
          style="width:100%; display:flex; align-items:center; gap:10px; padding:9px 12px; border:none; border-bottom:1px solid var(--fc-card-border); background:transparent; cursor:pointer; text-align:left; transition:background 0.1s ease;">
          <span style="font-size:16px; flex-shrink:0">${name === '(Bez pokoju)' ? '📦' : '🏷️'}</span>
          <span style="display:flex; flex-direction:column; min-width:0; flex:1">
            <span style="font-size:12px; font-weight:600; color:var(--fc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(name)}</span>
            <span style="font-size:10px; color:var(--fc-text-muted)">${deviceCount > 0 ? `${deviceCount} ${deviceCount === 1 ? 'urządzenie' : 'urządzeń'} · ` : ''}${g.count} ${g.count === 1 ? 'encja' : 'encji'}</span>
          </span>
          <span style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end">${badges}</span>
        </button>
      `;
    }).join('');
  }

  // 3. Wnętrze urządzenia (widok "Urządzenia" po wejściu)
  if (app.haPickerMode === 'devices' && app.haPickerDevice) {
    const inside = app.haCatalog.filter((e) => matchesDomain(e) && (e.deviceName || '(bez urządzenia)') === app.haPickerDevice)
      .filter((e) => !q || haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q))
      .slice(0, 120);
    const back = `
      <button data-ha-picker-back="1"
        style="width:100%; display:flex; align-items:center; gap:6px; padding:7px 10px; border:none; border-bottom:1px solid var(--fc-card-border); background:rgba(255,255,255,0.03); cursor:pointer; text-align:left; font-size:11px; color:var(--fc-accent-blue)">
        ← Wszystkie urządzenia (Aktualnie: <strong>${esc(app.haPickerDevice)}</strong>)
      </button>`;
    const rows = inside.length > 0
      ? inside.map((e) => haEntityRow(app, e)).join('')
      : `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">To urządzenie nie ma encji w dozwolonych domenach.</div>`;
    return back + rows;
  }

  // 4. Widok urządzeń: grupowanie encji wg nazwy urządzenia
  if (app.haPickerMode === 'devices') {
    const entityHit = new Set<string>();
    if (q) {
      for (const e of app.haCatalog) {
        if (!matchesDomain(e)) continue;
        if (haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q) || haNorm(e.areaName || '').includes(q)) {
          entityHit.add(e.deviceName || '(bez urządzenia)');
        }
      }
    }
    const groups = new Map<string, { count: number; area?: string; domains: Set<string> }>();
    for (const e of app.haCatalog) {
      if (!matchesDomain(e)) continue;
      const key = e.deviceName || '(bez urządzenia)';
      if (q && !haNorm(key).includes(q) && !entityHit.has(key)) continue;
      const g = groups.get(key) || { count: 0, area: e.areaName, domains: new Set<string>() };
      g.count++;
      if (e.areaName) g.area = e.areaName;
      g.domains.add(e.domain);
      groups.set(key, g);
    }
    if (groups.size === 0) {
      return `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">Brak urządzeń pasujących do zapytania.</div>`;
    }
    const keys = Array.from(groups.keys()).sort((a, b) => (a === '(bez urządzenia)' ? 1 : 0) - (b === '(bez urządzenia)' ? 1 : 0) || a.localeCompare(b, 'pl'));
    return keys.map((name) => {
      const g = groups.get(name)!;
      const badges = Array.from(g.domains).map((d) => `<span class="fc-badge ${haDomainBadge(d)}">${esc(d)}</span>`).join(' ');
      return `
        <button data-ha-device="${esc(name)}"
          style="width:100%; display:flex; align-items:center; gap:8px; padding:8px 10px; border:none; border-bottom:1px solid var(--fc-card-border); background:transparent; cursor:pointer; text-align:left">
          <span style="font-size:14px; flex-shrink:0">📦</span>
          <span style="display:flex; flex-direction:column; min-width:0; flex:1">
            <span style="font-size:11.5px; color:var(--fc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(name)}</span>
            <span style="font-size:10px; color:var(--fc-text-muted)">${g.area ? `🏷️ ${esc(g.area)} · ` : ''}${g.count} ${g.count === 1 ? 'encja' : 'encji'}</span>
          </span>
          <span style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end">${badges}</span>
        </button>
      `;
    }).join('');
  }

  // 5. Płaski widok encji (szuka po encji, urządzeniu i pokoju)
  const matches = app.haCatalog.filter((e) => matchesDomain(e))
    .filter((e) => !q || haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q) || haNorm(e.deviceName || '').includes(q) || haNorm(e.areaName || '').includes(q));
  if (matches.length === 0) {
    return `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">Brak encji pasujących do zapytania.</div>`;
  }
  const shown = matches.slice(0, 150);
  const more = matches.length > shown.length
    ? `<div style="padding:8px 10px; font-size:10.5px; color:var(--fc-text-muted); text-align:center">…i ${matches.length - shown.length} więcej — wpisz, żeby zawęzić</div>`
    : '';
  return shown.map((e) => haEntityRow(app, e)).join('') + more;
}

/** Modal-wyszukiwarka encji HAOS (otwierany z pickerów komend głosowych). */
export function renderHaPickerModal(app: AppUI): string {
  const spec = app.haPicker!;
  return `
    <div class="modal-overlay" id="ha-picker-overlay">
      <div class="modal-dialog" style="max-width: 560px; width: 92%">
        <div class="modal-header">
          <h3>🔍 ${esc(spec.title)}</h3>
          <button class="close" id="btn-ha-picker-close" title="Zamknij">✕</button>
        </div>
        <div class="modal-body" style="padding-bottom: 12px">
          <input type="text" class="fc-input" id="inp-ha-picker-search" placeholder="Szukaj: encja, urządzenie, entity_id…" value="${esc(app.haPickerSearch)}" style="width:100%; height:32px; font-size:12px" autocomplete="off" />
          <div id="ha-picker-chips" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px">
            ${renderHaPickerChips(app)}
          </div>
          <div id="ha-picker-list" style="margin-top:8px; max-height:320px; overflow-y:auto; border:1px solid var(--fc-card-border); border-radius:var(--fc-radius-sm)">
            ${renderHaPickerList(app)}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderHaosPanel(app: AppUI): string {
  const form = app.form!;
  const snap = app.snap!;

  const areasCount = new Set(app.haCatalog.map((e) => e.areaName).filter(Boolean)).size;
  const devicesCount = new Set(app.haCatalog.map((e) => e.deviceName).filter(Boolean)).size;
  const actionEntitiesCount = app.haCatalog.filter((e) => e.domain !== 'sensor' && e.domain !== 'binary_sensor').length;

  const catalogStatusInfo = app.haCatalog.length > 0
    ? `
      <div style="margin-top: 14px; padding: 10px 14px; border-radius: var(--fc-radius-sm); background: rgba(34, 197, 94, 0.05); border: 1px solid rgba(34, 197, 94, 0.2); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
        <div style="font-size: 11.5px; color: var(--fc-text)">
          <span style="color: var(--fc-accent-green); font-weight: 600">✓ Katalog urządzeń zsynchronizowany:</span>
          ${areasCount > 0 ? `<strong>${areasCount}</strong> ${areasCount === 1 ? 'pokój' : 'pokojów'} · ` : ''}
          <strong>${devicesCount > 0 ? devicesCount : app.haCatalog.length}</strong> ${devicesCount === 1 ? 'urządzenie' : 'urządzeń'}
          (${actionEntitiesCount} encji wykonawczych)
        </div>
        <div style="font-size: 10.5px; color: var(--fc-text-muted)">
          Dostępne w pickerze komend głosowych
        </div>
      </div>
    `
    : `
      <div style="margin-top: 14px; padding: 10px 14px; border-radius: var(--fc-radius-sm); background: rgba(255, 255, 255, 0.02); border: 1px solid var(--fc-card-border); font-size: 11px; color: var(--fc-text-muted); line-height: 1.5">
        ℹ️ Po wpisaniu adresu i tokena kliknij <strong>„Pobierz katalog urządzeń z HAOS”</strong>, aby pobrać listę świateł, przełączników i urządzeń. Będą one natychmiast dostępne do wyboru w zakładce <strong>Komendy głosowe</strong>.
      </div>
    `;

  return `
    <div class="fc-settings-panel">
      <div class="fc-settings-group ${form.haEnabled ? 'highlight' : ''}">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--fc-card-border); padding-bottom: 8px">
          <div class="fc-settings-group-title" style="border: none; padding: 0">🏠 Home Assistant OS (HAOS)</div>
          <div style="display: flex; gap: 8px; align-items: center">
            <span class="fc-badge ${snap.ha?.connected ? 'calibrated' : (form.haEnabled ? 'amber' : 'muted')}" id="badge-ha-status">
              ${snap.ha?.connected ? `● Połączono (HAOS${snap.ha.version ? ` v${snap.ha.version}` : ''}) ✓` : (form.haEnabled ? (snap.ha?.error || 'Łączenie z HAOS…') : 'Wyłączony')}
            </span>
            <button class="fc-switch ${form.haEnabled ? 'active' : ''}" id="sw-ha-enabled" aria-checked="${form.haEnabled ?? false}" role="switch" title="Włącz integrację z Home Assistant"></button>
          </div>
        </div>

        <div style="font-size: 11px; color: var(--fc-text-secondary); line-height: 1.5">
          Połącz DeskSense z lokalną instancją Home Assistant, aby sterować światłem, scenami, klimatyzacją i urządzeniami domowymi za pomocą komend głosowych oraz automatyzacji.
        </div>

        <div class="fc-subgrid-2" style="gap: 10px; margin-top: 4px">
          <div>
            <label class="fc-micro-label">Adres URL Home Assistant:</label>
            <input type="text" class="fc-input" id="inp-ha-url" placeholder="http://homeassistant.local:8123" value="${esc(form.haUrl || 'http://homeassistant.local:8123')}" style="height: 30px; font-size: 11.5px" />
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <label class="fc-micro-label">Długoterminowy Token Dostępu (Bearer):</label>
              <button class="text-btn" id="btn-toggle-ha-token" style="font-size: 10px; color: var(--fc-accent-blue)">${app.haShowToken ? 'Ukryj 👁️' : 'Pokaż 👁️'}</button>
            </div>
            <input type="${app.haShowToken ? 'text' : 'password'}" class="fc-input" id="inp-ha-token" placeholder="Wklej Long-Lived Access Token z profilu HA…" value="${esc(form.haToken || '')}" style="height: 30px; font-size: 11.5px" />
          </div>
        </div>

        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 6px">
          <button class="btn btn-ghost btn-sm" id="btn-ha-test" style="font-size: 11px; padding: 5px 12px" ${app.haTesting ? 'disabled' : ''}>
            ${app.haTesting ? '⏳ Testuję połączenie…' : '🧪 Testuj połączenie'}
          </button>
          <button class="btn btn-primary btn-sm" id="btn-ha-fetch-entities" style="font-size: 11px; padding: 5px 12px" ${app.haFetchingEntities ? 'disabled' : ''}>
            ${app.haFetchingEntities ? '⏳ Pobieram katalog…' : '🔄 Pobierz katalog urządzeń z HAOS'}
          </button>
          <div id="ha-test-feedback" style="font-size: 11px; margin-left: 6px; color: ${app.haTestResult ? (app.haTestResult.ok ? 'var(--fc-accent-green)' : '#ef4444') : 'var(--fc-text-muted)'}">
            ${app.haTestResult ? esc(app.haTestResult.message || app.haTestResult.error || '') : ''}
          </div>
        </div>

        ${catalogStatusInfo}
      </div>
    </div>
  `;
}
