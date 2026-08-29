// Panele integracji: Discord, SignalRGB, Chime, Home Assistant (HAOS)

import type { AppUI } from './app';
import { esc } from './ui';

/** Throttle odpytywania stanow RPC — render potrafi zdarzyc sie kilkanascie razy na minute. */
let lastRpcStatusFetch = 0;

let lastSrgbStatusFetch = 0;

export function renderDiscordPanel(app: AppUI): string {
    const form = app.form!;
    const snap = app.snap!;
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

  /** Podpowiedzi nazw efektów z dysku VortxEngine (bez Pro) do obu pickerów. */
export async function refreshSignalrgbEffectList(_app: AppUI): Promise<void> {
    const el = document.getElementById('signalrgb-effects-list');
    if (!el) return;
    try {
      const names = await window.api.signalrgbListEffects();
      const target = document.getElementById('signalrgb-effects-list');
      if (!target) return; // render mógł podmienić DOM w trakcie zapytania
      target.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
    } catch {
      /* lista niedostępna — inputy zostają free-text */
    }
  }

  /** Aktualizuje wiersz "Połączenie z Discordem" w panelu (element istnieje tylko tam). */
export async function refreshDiscordRpcStatus(_app: AppUI): Promise<void> {
    const now = Date.now();
    if (now - lastRpcStatusFetch < 5000) return;
    lastRpcStatusFetch = now;
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

export function renderSignalrgbPanel(app: AppUI): string {
    const form = app.form!;
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
            <span class="fc-field-label">Local API SignalRGB</span>
            <strong id="signalrgb-status-val" style="color: var(--fc-text-dim)">…</strong>
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
              <div class="fc-field-label">Efekt przy odejściu (deep-link)</div>
              <div class="fc-field-desc">Dowolny zainstalowany efekt z biblioteki SignalRGB (nazwa dokładnie jak w apce). Kolor przenosimy jako parametr deep-linku. Puste = Solid Color.</div>
            </div>
            <input type="text" class="fc-input" id="inp-signalrgb-away-effect" list="signalrgb-effects-list" placeholder="Solid Color" value="${esc(form.signalrgbAwayEffect || '')}" style="width: 170px; height: 30px; font-size: 11.5px" />
          </div>
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Kolor ostrzegawczy</div>
              <div class="fc-field-desc">Kolor przekazany efektowi jako parametr (efekty bez parametru koloru go ignorują)</div>
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
          <div class="fc-field-row">
            <div>
              <div class="fc-field-label">Efekt powrotu (fallback bez Pro)</div>
              <div class="fc-field-desc">Gdy REST niedostępny (Local API wymaga SignalRGB Pro), przy powrocie aplikowany jest ten efekt przez deep-link. Puste = brak przywracania bez Pro.</div>
            </div>
            <input type="text" class="fc-input" id="inp-signalrgb-desk-effect" list="signalrgb-effects-list" placeholder="np. Neon Shift" value="${esc(form.signalrgbDeskEffect || '')}" style="width: 170px; height: 30px; font-size: 11.5px" />
          </div>
          <datalist id="signalrgb-effects-list"></datalist>
          <div style="font-size: 10.5px; color: var(--fc-text-muted); line-height: 1.5; margin-top: 2px">
            Bez SignalRGB Pro działają: „Kolor ostrzegawczy" (deep-link z kolorem) i „Zgaś całkowicie" (czarny Solid Color). „Przyciemnij" oraz odtwarzanie zapisanego stanu wymagają REST z Pro — apka wykrywa odmowę 403 i stosuje fallbacki.
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

// ---------- HAOS: specyfikacja pól z encjami + wyszukiwarka (picker) ----------

export interface HaFieldSpec {
  /** Klucz pola w AppConfig */
  key: string;
  /** Etykieta pola w panelu */
  label: string;
  /** Tytuł okna pickera */
  title: string;
  /** Domeny encji dozwolone dla tego pola (filtry w pickercie) */
  domains: string[];
  /** Placeholder pustego pola */
  placeholder: string;
}

export const HA_ENTITY_FIELDS = {
  presence: {
    key: 'haPresenceEntity',
    label: 'Encja Obecności',
    title: 'Wybierz encję obecności (binary_sensor)',
    domains: ['binary_sensor'],
    placeholder: 'Kliknij i wybierz binary_sensor obecności…'
  },
  distance: {
    key: 'haDistanceEntity',
    label: 'Encja Dystansu fotela (opcjonalna)',
    title: 'Wybierz encję dystansu (sensor)',
    domains: ['sensor'],
    placeholder: 'Kliknij i wybierz sensor dystansu…'
  },
  heart: {
    key: 'haHeartRateEntity',
    label: 'Encja Tętna BPM (opcjonalna)',
    title: 'Wybierz encję tętna (sensor)',
    domains: ['sensor'],
    placeholder: 'Kliknij i wybierz sensor tętna…'
  },
  breath: {
    key: 'haBreathRateEntity',
    label: 'Encja Oddechu RPM (opcjonalna)',
    title: 'Wybierz encję oddechu (sensor)',
    domains: ['sensor'],
    placeholder: 'Kliknij i wybierz sensor oddechu…'
  },
  autoAway: {
    key: 'haAutomationOnAway',
    label: 'Wołaj przy odejściu (AWAY)',
    title: 'Wybierz automatyzację/skrypt/przycisk wywoływany przy odejściu',
    domains: ['automation', 'script', 'button', 'scene', 'input_boolean', 'switch'],
    placeholder: 'Kliknij i wybierz automatyzację AWAY…'
  },
  autoDesk: {
    key: 'haAutomationOnDesk',
    label: 'Wołaj przy powrocie (DESK)',
    title: 'Wybierz automatyzację/skrypt/przycisk wywoływany przy powrocie',
    domains: ['automation', 'script', 'button', 'scene', 'input_boolean', 'switch'],
    placeholder: 'Kliknij i wybierz automatyzację DESK…'
  },
  btnSnooze: {
    key: 'haButtonSnoozeEntity',
    label: 'Przycisk HAOS -> Pauza automatyki (snooze 15 min / wznow)',
    title: 'Wybierz przycisk HAOS przełączający pauzę automatyki',
    domains: ['button', 'input_boolean', 'switch'],
    placeholder: 'Kliknij i wybierz przycisk snooze…'
  },
  btnMute: {
    key: 'haButtonMuteEntity',
    label: 'Przycisk HAOS -> Wyciszenie mikrofonu (toggle)',
    title: 'Wybierz przycisk HAOS przełączający wyciszenie mikrofonu',
    domains: ['button', 'input_boolean', 'switch'],
    placeholder: 'Kliknij i wybierz przycisk mute…'
  }
} satisfies Record<string, HaFieldSpec>;

export type HaFieldId = keyof typeof HA_ENTITY_FIELDS;

/** Klasa badge wg domeny encji — szybki wizualny rozróżniacz w liście. */
function haDomainBadge(domain: string): string {
  if (domain === 'binary_sensor') return 'calibrated';
  if (domain === 'sensor') return 'blue';
  if (domain === 'automation' || domain === 'script' || domain === 'scene') return 'blue';
  return 'amber';
}

/**
 * Pojedyncze pole encji HAOS: klikalny wiersz otwierający wyszukiwarkę
 * (zamiast wklejania entity_id) + krzyżyk czyszczący. testButton = opcjonalny
 * HTML dodatkowego przycisku obok (np. "▶" test usługi).
 */
export function renderHaEntityField(app: AppUI, fieldId: HaFieldId, testButton = ''): string {
  const spec = HA_ENTITY_FIELDS[fieldId];
  const raw = String((app.form as unknown as Record<string, unknown>)?.[spec.key] || '');
  const found = raw ? app.haCatalog.find((e) => e.entity_id === raw) : null;
  const inner = raw
    ? `<span style="display:flex; align-items:center; gap:6px; min-width:0">
         <span class="fc-badge ${haDomainBadge(found?.domain || raw.split('.')[0])}">${esc(found?.domain || raw.split('.')[0])}</span>
         <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(found?.name || raw)}</span>
       </span>
       <span style="color:var(--fc-text-muted)">▾</span>`
    : `<span style="color:var(--fc-text-muted)">${esc(spec.placeholder)}</span><span style="color:var(--fc-text-muted)">▾</span>`;
  return `
    <div>
      <label class="fc-micro-label">${esc(spec.label)}:</label>
      <div style="display:flex; gap:6px">
        <button class="fc-input" id="row-ha-${fieldId}" data-ha-field="${fieldId}" title="${esc(spec.title)}"
          style="flex:1; display:flex; align-items:center; justify-content:space-between; gap:8px; text-align:left; cursor:pointer; height:28px; font-size:11px; padding:0 8px; background:var(--fc-card-bg)">
          ${inner}
        </button>
        ${raw ? `<button class="btn btn-ghost btn-sm" id="clr-ha-${fieldId}" title="Wyczyść encję" style="font-size:10.5px; padding:4px 8px">✕</button>` : ''}
        ${testButton}
      </div>
    </div>
  `;
}

export function openHaPicker(app: AppUI, fieldId: HaFieldId): void {
  const spec = HA_ENTITY_FIELDS[fieldId];
  app.haPicker = { key: spec.key, title: spec.title, domains: [...spec.domains] };
  app.haPickerSearch = '';
  app.haPickerDomain = '';
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
    ...(res.binarySensors || []).map((s) => ({ entity_id: s.entity_id, name: s.name, domain: 'binary_sensor', deviceName: s.deviceName, state: s.state })),
    ...(res.sensors || []).map((s) => ({ entity_id: s.entity_id, name: s.name, domain: 'sensor', deviceName: s.deviceName, state: s.state, unit: s.unit })),
    ...(res.actions || []).map((a) => ({ entity_id: a.entity_id, name: a.name, domain: a.domain, deviceName: a.deviceName }))
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

/** Chipki trybu (Encje/Urządzenia) + filtry domen w pickercie. */
export function renderHaPickerChips(app: AppUI): string {
  const viewChips = `
    <div style="display:flex; gap:6px; flex-wrap:wrap">
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

/** Wiersz pojedynczej encji w liście (wspólny dla widoku płaskiego i urządzenia). */
function haEntityRow(app: AppUI, e: { entity_id: string; name: string; domain: string; state?: string; unit?: string }): string {
  const currentValue = String((app.form as unknown as Record<string, unknown>)?.[app.haPicker!.key] || '');
  const isSelected = currentValue === e.entity_id;
  const stateInfo = (e.domain === 'sensor' || e.domain === 'binary_sensor') && e.state
    ? `<span style="font-size:10px; color:var(--fc-text-muted); flex-shrink:0">${esc(e.state)}${e.unit ? ` ${esc(e.unit)}` : ''}</span>`
    : '';
  const check = isSelected ? `<span style="color:var(--fc-accent-green); flex-shrink:0">✓</span>` : '';
  return `
    <button data-ha-entity="${esc(e.entity_id)}"
      style="width:100%; display:flex; align-items:center; gap:8px; padding:7px 10px; border:none; border-bottom:1px solid var(--fc-card-border); background:${isSelected ? 'rgba(34,197,94,0.08)' : 'transparent'}; cursor:pointer; text-align:left">
      <span class="fc-badge ${haDomainBadge(e.domain)}" style="flex-shrink:0">${esc(e.domain)}</span>
      <span style="display:flex; flex-direction:column; min-width:0; flex:1">
        <span style="font-size:11.5px; color:var(--fc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(e.name)}</span>
        <span style="font-size:10px; color:var(--fc-text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(e.entity_id)}</span>
      </span>
      ${stateInfo}
      ${check}
    </button>
  `;
}

/** Filtrowana lista: płaska encje / urządzenia / wnętrze urządzenia. */
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

  // Wnętrze urządzenia (widok "Urządzenia" po wejściu)
  if (app.haPickerMode === 'devices' && app.haPickerDevice) {
    const inside = app.haCatalog.filter((e) => matchesDomain(e) && (e.deviceName || '(bez urządzenia)') === app.haPickerDevice)
      .filter((e) => !q || haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q))
      .slice(0, 120);
    const back = `
      <button data-ha-picker-back="1"
        style="width:100%; display:flex; align-items:center; gap:6px; padding:7px 10px; border:none; border-bottom:1px solid var(--fc-card-border); background:rgba(255,255,255,0.03); cursor:pointer; text-align:left; font-size:11px; color:var(--fc-accent-blue)">
        ← Wszystkie urządzenia
      </button>`;
    const rows = inside.length > 0
      ? inside.map((e) => haEntityRow(app, e)).join('')
      : `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">To urządzenie nie ma encji w dozwolonych domenach.</div>`;
    return back + rows;
  }

  // Widok urządzeń: grupowanie encji wg nazwy urządzenia. Wyszukiwanie trafia
  // zarówno w nazwę urządzenia, jak i w nazwę/entity_id dowolnej jego encji.
  if (app.haPickerMode === 'devices') {
    const entityHit = new Set<string>();
    if (q) {
      for (const e of app.haCatalog) {
        if (!matchesDomain(e)) continue;
        if (haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q)) {
          entityHit.add(e.deviceName || '(bez urządzenia)');
        }
      }
    }
    const groups = new Map<string, { count: number; domains: Set<string> }>();
    for (const e of app.haCatalog) {
      if (!matchesDomain(e)) continue;
      const key = e.deviceName || '(bez urządzenia)';
      if (q && !haNorm(key).includes(q) && !entityHit.has(key)) continue;
      const g = groups.get(key) || { count: 0, domains: new Set<string>() };
      g.count++;
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
            <span style="font-size:10px; color:var(--fc-text-muted)">${g.count} ${g.count === 1 ? 'encja' : 'encji'}</span>
          </span>
          <span style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end">${badges}</span>
        </button>
      `;
    }).join('');
  }

  // Płaski widok encji (szuka też po nazwie urządzenia)
  const matches = app.haCatalog.filter((e) => matchesDomain(e))
    .filter((e) => !q || haNorm(e.entity_id).includes(q) || haNorm(e.name).includes(q) || haNorm(e.deviceName || '').includes(q));
  if (matches.length === 0) {
    return `<div style="padding:14px; font-size:11.5px; color:var(--fc-text-muted); text-align:center">Brak encji pasujących do zapytania.</div>`;
  }
  const shown = matches.slice(0, 120);
  const more = matches.length > shown.length
    ? `<div style="padding:8px 10px; font-size:10.5px; color:var(--fc-text-muted); text-align:center">…i ${matches.length - shown.length} więcej — wpisz, żeby zawęzić</div>`
    : '';
  return shown.map((e) => haEntityRow(app, e)).join('') + more;
}

/** Modal-wyszukiwarka encji HAOS (otwierany z pól renderHaEntityField). */
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
                <button class="text-btn" id="btn-toggle-ha-token" style="font-size: 10px; color: var(--fc-accent-blue)">${app.haShowToken ? 'Ukryj 👁️' : 'Pokaż 👁️'}</button>
              </div>
              <input type="${app.haShowToken ? 'text' : 'password'}" class="fc-input" id="inp-ha-token" placeholder="Wklej Long-Lived Access Token z profilu HA…" value="${esc(form.haToken || '')}" style="height: 30px; font-size: 11.5px" />
            </div>
          </div>

          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <button class="btn btn-ghost btn-sm" id="btn-ha-test" style="font-size: 11px; padding: 4px 10px" ${app.haTesting ? 'disabled' : ''}>
              ${app.haTesting ? '⏳ Testuję połączenie…' : '🧪 Testuj połączenie'}
            </button>
            <button class="btn btn-primary btn-sm" id="btn-ha-fetch-entities" style="font-size: 11px; padding: 4px 10px" ${app.haFetchingEntities ? 'disabled' : ''}>
              ${app.haFetchingEntities ? '⏳ Pobieram encje…' : '🔍 Wykryj & Pobierz encje z HAOS'}
            </button>
            <div id="ha-test-feedback" style="font-size: 11px; margin-left: 6px; color: ${app.haTestResult ? (app.haTestResult.ok ? 'var(--fc-accent-green)' : '#ef4444') : 'var(--fc-text-muted)'}">
              ${app.haTestResult ? esc(app.haTestResult.message || app.haTestResult.error || '') : ''}
            </div>
          </div>

          <div class="fc-subgrid-2" style="gap: 10px; padding-top: 8px; border-top: 1px solid var(--fc-card-border)">
            ${renderHaEntityField(app, 'presence')}
            ${renderHaEntityField(app, 'distance')}
            ${renderHaEntityField(app, 'heart')}
            ${renderHaEntityField(app, 'breath')}
          </div>

          <div style="padding-top: 10px; border-top: 1px solid var(--fc-card-border)">
            <div class="fc-micro-label" style="margin-bottom: 6px">Automatyzacje & Przyciski (sterowanie w obie strony):</div>
            <div style="font-size: 11px; color: var(--fc-text-secondary); margin-bottom: 8px">
              DeskSense woła automatyzację/skrypt/przycisk przy zmianie obecności (usługę dobiera wg domeny), a wciśnięcie przycisku w HAOS steruje apką.
              Kliknij pole, aby wyszukać encję.
            </div>
            <div class="fc-subgrid-2" style="gap: 10px">
              ${renderHaEntityField(app, 'autoAway', `<button class="btn btn-ghost btn-sm" id="btn-ha-test-away" title="Wywołaj teraz usługę na tej encji" style="font-size:10.5px; padding:4px 8px">▶</button>`)}
              ${renderHaEntityField(app, 'autoDesk', `<button class="btn btn-ghost btn-sm" id="btn-ha-test-desk" title="Wywołaj teraz usługę na tej encji" style="font-size:10.5px; padding:4px 8px">▶</button>`)}
              ${renderHaEntityField(app, 'btnSnooze')}
              ${renderHaEntityField(app, 'btnMute')}
            </div>
          </div>
        </div>
      </div>
    `;
  }
