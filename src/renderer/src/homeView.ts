// Widok glowny: live DOM (naglowek, karty mikrofonow, telemetria, radar-scope) + dashboard Home

import type { AppUI } from './app';
import { esc, STATE_LABEL } from './ui';

export function triggerOsdHud(
  app: AppUI,
  text: string,
  kindOrMuted: boolean | 'mute' | 'unmute' | 'listen' | 'ok' | 'miss' | 'blocked' | 'loading' | 'info' = false,
  durationMs = 2200,
  customTitle?: string
) {
  const el = document.getElementById('fc-osd-hud');
  if (!el) return;
  if (app.osdTimer) clearTimeout(app.osdTimer);

  const isMuted = kindOrMuted === true || kindOrMuted === 'mute';
  const kind = typeof kindOrMuted === 'string' ? kindOrMuted : (isMuted ? 'mute' : 'info');
  const isVoiceKind = ['listen', 'ok', 'miss', 'blocked', 'loading', 'info'].includes(kind);

  let extraClass = '';
  if (isMuted) extraClass += ' muted';
  if (isVoiceKind) extraClass += ` osd-voice osd-${kind}`;

  el.className = `fc-osd-hud visible${extraClass}`;

  if (isVoiceKind) {
    const title =
      customTitle ||
      (kind === 'listen'
        ? 'DeskSense · Słucham'
        : kind === 'ok'
          ? 'DeskSense · Wykonano'
          : kind === 'miss'
            ? 'DeskSense · Nierozpoznano'
            : kind === 'blocked'
              ? 'DeskSense · Zablokowano'
              : 'DeskSense');
    el.innerHTML = `<div class="osd-title">${esc(title)}</div><div class="osd-text">${esc(text)}</div>`;
  } else {
    el.innerHTML = `<span>${esc(text)}</span>`;
  }

  if (durationMs > 0) {
    app.osdTimer = setTimeout(() => {
      el.className = `fc-osd-hud${isMuted ? ' muted' : ''}`;
    }, durationMs);
  }
}

export function hideOsdHud(app: AppUI) {
  const el = document.getElementById('fc-osd-hud');
  if (!el) return;
  if (app.osdTimer) clearTimeout(app.osdTimer);
  el.className = `fc-osd-hud ${app.isMuted ? 'muted' : ''}`;
}

export function updateHeaderAndLiveDOM(app: AppUI) {
    if (!app.snap) return;
    const radar = app.snap.radar;
    const isOnline = Boolean(radar.connected || app.snap.ha?.connected);
    const label = radar.connected ? 'Radar: USB ✓' : (app.snap.ha?.connected ? 'Radar: HAOS ✓' : 'Radar: Brak połączenia');
    const radarBadge = document.getElementById('fc-header-radar-badge');
    if (radarBadge) {
      radarBadge.className = `fc-top-badge ${isOnline ? 'connected' : ''}`;
      radarBadge.innerHTML = `<span class="dot"></span> ${label}`;
    }

    const diagBtn = document.getElementById('fc-header-diag-btn');
    if (diagBtn) {
      diagBtn.className = `fc-diag-btn ${app.diagActive ? 'active' : ''}`;
      diagBtn.innerHTML = app.diagActive ? '⏹ Zakończ test' : '🧪 Wyjście z pokoju';
      diagBtn.setAttribute('title', app.diagActive
        ? 'Sesja diagnostyczna trwa — kliknij po powrocie, aby zobaczyć logi'
        : 'Wychodzisz z pokoju? Kliknij — aplikacja nagra logi do diagnozy wykrywania nieobecności');
    }

    const muteBtn = document.getElementById('fc-header-mute-btn');
    if (muteBtn) {
      muteBtn.className = `fc-mute-btn ${app.isMuted ? 'muted' : ''}`;
      muteBtn.innerHTML = app.isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny';
    }

    const cardMuteSwitch = document.getElementById('card-sw-mute');
    if (cardMuteSwitch) {
      cardMuteSwitch.className = `fc-switch ${!app.isMuted ? 'active' : ''}`;
      cardMuteSwitch.setAttribute('aria-checked', String(!app.isMuted));
    }

    const cardMuteBadge = document.getElementById('card-badge-mute');
    if (cardMuteBadge) {
      cardMuteBadge.className = `fc-badge ${app.isMuted ? 'amber' : 'success'}`;
      cardMuteBadge.textContent = app.isMuted ? 'Wyciszony 🔇' : 'Aktywny 🎙️';
    }

    updateActiveMicCards(app);
    updateTelemetryDOM(app);
  }

  /**
   * Żywe odświeżanie podświetlenia kart mikrofonów (zielona ramka "Domyślny ✓").
   * snapshot przychodzi po każdym przełączeniu, ale pełny render() jest zbyt
   * drogi — aktualizamy tylko klasy kart, selectów i badge'y.
   */
export function updateActiveMicCards(app: AppUI) {
    const isDeskActive = isMicActive(app, 'desk');
    const isHeadsetActive = isMicActive(app, 'headset');

    const apply = (
      cardId: string,
      selectId: string,
      badgeId: string,
      titleId: string,
      subId: string,
      active: boolean,
      idleLabel: string,
      activeColor: string
    ) => {
      const card = document.getElementById(cardId);
      if (card) {
        card.classList.toggle('highlight', active);
        card.classList.toggle('active-mic', active);
      }
      const select = document.getElementById(selectId);
      if (select) {
        select.classList.toggle('active-source', active);
      }
      const badge = document.getElementById(badgeId);
      if (badge) {
        badge.className = `fc-badge ${active ? 'calibrated' : 'muted'}`;
        badge.textContent = active ? 'Domyślny ✓' : idleLabel;
      }
      const titleEl = document.getElementById(titleId);
      const subEl = document.getElementById(subId);
      if (titleEl && subEl) {
        if (active) {
          if (app.isMuted) {
            titleEl.style.color = '#f59e0b';
            titleEl.textContent = 'Wyciszony 🔇';
            subEl.textContent = 'Mikrofon jest wyciszony w systemie';
          } else {
            titleEl.style.color = activeColor;
            titleEl.textContent = 'Aktywny 🎙️';
            subEl.textContent = 'Dźwięk przekazywany do aplikacji';
          }
        } else {
          titleEl.style.color = 'var(--fc-text-secondary)';
          titleEl.textContent = idleLabel;
          subEl.textContent = idleLabel === 'Gotowy' ? 'Mikrofon stacjonarny' : 'Mikrofon mobilny';
        }
      }
    };

    apply('card-mic-desk', 'sel-mic-desk', 'badge-mic-desk', 'status-title-desk', 'status-sub-desk', isDeskActive, 'Gotowy', 'var(--fc-accent-green)');
    apply('card-mic-headset', 'sel-mic-headset', 'badge-mic-headset', 'status-title-headset', 'status-sub-headset', isHeadsetActive, 'Rezerwa', '#38bdf8');
  }

export function updateTelemetryDOM(app: AppUI) {
    const t = app.telemetry;
    const is24G = t.sensorFreq === '24GHz' || (app.snap?.telemetry?.deviceInfo?.sensorModel?.includes('24G') ?? false);

    // Kafle na pulpicie głównym (Home)
    const elHomeDist = document.getElementById('home-val-distance');
    const elHomeHeart = document.getElementById('home-val-heart');
    const elHomeBreath = document.getElementById('home-val-breath');
    const elHomeLux = document.getElementById('home-val-lux');
    const elHomePerson = document.getElementById('home-val-person');
    const elHomeTargets = document.getElementById('home-val-targets');

    const elHomeMoving = document.getElementById('home-val-moving');
    const elHomeStill = document.getElementById('home-val-still');

    if (elHomeDist) {
      elHomeDist.textContent = t.distanceCm && t.distanceCm > 0 ? `${t.distanceCm} cm` : '—';
    }

    if (is24G) {
      if (elHomeMoving) {
        elHomeMoving.textContent = t.movingTarget ? (t.movingDistanceCm ? `Ruch (${t.movingDistanceCm} cm)` : 'Wykryto ruch') : 'Brak ruchu';
      }
      if (elHomeStill) {
        elHomeStill.textContent = t.stillTarget ? (t.stillDistanceCm ? `Statyka (${t.stillDistanceCm} cm)` : 'Wykryto obecność') : (t.presence ? 'Obecny ✓' : '—');
      }
    } else {
      if (elHomeHeart) {
        elHomeHeart.textContent = t.heartRate && t.heartRate > 0 ? `${t.heartRate} BPM` : '—';
      }
      if (elHomeBreath) {
        elHomeBreath.textContent = t.breathRate && t.breathRate > 0 ? `${t.breathRate} RPM` : '—';
      }
      if (elHomeLux) {
        elHomeLux.textContent = typeof t.illuminanceLux === 'number' ? `${t.illuminanceLux} lx` : '—';
      }
    }

    if (elHomePerson) {
      const p = t.detectedPerson || 'unknown';
      elHomePerson.textContent = p === 'me' ? 'Człowiek ✓' : (p === 'pet' ? 'Zwierzę' : (t.presence ? 'Człowiek ✓' : 'Brak celu'));
    }
    if (elHomeTargets) {
      elHomeTargets.textContent = t.presence ? `${t.targetCount ?? 1} cel w kadrze` : 'Brak celu';
    }

    // Elementy w zakładce Ustawienia (jeśli otwarta)
    const elDist = document.getElementById('card-val-distance');
    const elHeart = document.getElementById('card-val-heart');
    const elBreath = document.getElementById('card-val-breath');
    const elLux = document.getElementById('card-val-lux');
    const elPerson = document.getElementById('card-badge-person');

    if (elDist) {
      if (t.distanceCm && t.distanceCm > 0) {
        elDist.textContent =
          t.distanceTrusted === false
            ? `${t.distanceCm} cm (niepewny)`
            : `${t.distanceCm} cm`;
      } else if (t.presence === false) {
        elDist.textContent = '— (Brak celu)';
      } else {
        elDist.textContent = '—';
      }
    }
    if (elHeart) elHeart.textContent = is24G ? 'N/A (24GHz)' : (t.heartRate ? `${t.heartRate} BPM` : '—');
    if (elBreath) elBreath.textContent = is24G ? 'N/A (24GHz)' : (t.breathRate ? `${t.breathRate} RPM` : '—');
    if (elLux) {
      elLux.textContent = typeof t.illuminanceLux === 'number' ? `${t.illuminanceLux} lx` : (is24G ? 'N/A (24GHz)' : '—');
    }

    if (elPerson) {
      const p = t.detectedPerson || 'unknown';
      elPerson.className = `fc-badge ${p === 'me' ? 'calibrated' : (p === 'pet' ? 'amber' : 'blue')}`;
      if (p === 'me') {
        elPerson.textContent = '👤 Człowiek ✓';
      } else if (p === 'pet') {
        elPerson.textContent = '🐾 Zwierzę (Kot/Pies)';
      } else {
        elPerson.textContent = '🔍 Skanowanie…';
      }
    }

    // Update Live Radar Presence Banner
    updateRadarScopeDOM(app);
  }

export function updateRadarScopeDOM(app: AppUI) {
    const isPresent = Boolean(app.telemetry.presence || app.snap?.state === 'desk');

    const iconEl = document.getElementById('scope-presence-icon');
    const labelEl = document.getElementById('scope-presence-label');
    const badgeEl = document.getElementById('scope-live-badge');

    if (iconEl) {
      iconEl.innerHTML = isPresent ? '👤' : '🚶';
      iconEl.style.background = isPresent ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)';
      iconEl.style.borderColor = isPresent ? 'rgba(34, 197, 94, 0.4)' : 'rgba(245, 158, 11, 0.4)';
    }

    if (labelEl) {
      labelEl.style.color = isPresent ? 'var(--fc-accent-green)' : '#f59e0b';
      labelEl.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: ${isPresent ? 'var(--fc-accent-green)' : '#f59e0b'}; display: inline-block;"></span> ${isPresent ? 'WYKRYTO OBECNOŚĆ (DESK)' : 'BRAK OBECNOŚCI (AWAY)'}`;
    }

    if (badgeEl) {
      badgeEl.className = `fc-badge ${isPresent ? 'calibrated' : 'muted'}`;
      badgeEl.textContent = isPresent ? 'Przy biurku ✓' : 'Poza biurkiem';
    }
  }

export function isMicActive(app: AppUI, target: 'desk' | 'headset'): boolean {
    if (!app.snap || !app.form) return target === 'desk';
    if (app.snap.state === target) return true;
    if (!app.snap.state) {
      const defaultMic = app.audioDevices.find((d) => d.isDefault)?.name;
      const configuredName = target === 'desk' ? app.form.micDeskName : app.form.micHeadsetName;
      if (
        defaultMic &&
        configuredName &&
        (defaultMic.toLowerCase().includes(configuredName.toLowerCase()) ||
          configuredName.toLowerCase().includes(defaultMic.toLowerCase()))
      ) {
        return true;
      }
      return target === 'desk';
    }
    return false;
  }

  // ---------- COMPLETE ALL-IN-ONE HOME DASHBOARD ----------
export function renderHomeTab(app: AppUI): string {
    if (!app.snap || !app.form) return '';
    const form = app.form;
    const snap = app.snap;

    const isDeskActive = isMicActive(app, 'desk');
    const isHeadsetActive = isMicActive(app, 'headset');

    // VAD values (zgodne z zakresem Discorda: -100 dB do 0 dB)
    const deskGateVal = Math.max(-100, Math.min(0, form.micDeskGateDb ?? -45));
    const deskGatePct = Math.max(0, Math.min(100, ((deskGateVal + 100) / 100) * 100));

    const headGateVal = Math.max(-100, Math.min(0, form.micHeadsetGateDb ?? -45));
    const headGatePct = Math.max(0, Math.min(100, ((headGateVal + 100) / 100) * 100));

    const is24G = app.telemetry.sensorFreq === '24GHz' || (snap.telemetry?.deviceInfo?.sensorModel?.includes('24G') ?? false);

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
          </div>

          <div class="fc-card-grid">
            <!-- Card 1: Mikrofon Biurkowy (Stacjonarny) -->
            <div class="fc-card ${isDeskActive ? 'highlight active-mic' : ''}" id="card-mic-desk">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon green">🎙️</span>
                  <span class="fc-card-title">Mikrofon Biurkowy (Stacjonarny)</span>
                </div>
                <button class="fc-card-more" id="card-btn-test-desk" title="Przełącz i przetestuj ten mikrofon">▶ Aktywuj</button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-size: 10.5px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px;">Główny mikrofon (Priorytet 1):</span>
                  <select class="fc-select ${isDeskActive ? 'active-source' : ''}" id="sel-mic-desk">
                    <option value="" ${!form.micDeskName ? 'selected' : ''}>— Wybierz mikrofon Windows —</option>
                    ${app.missingDeviceOption(form.micDeskName, app.audioDevices)}
                    ${app.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micDeskName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                  </select>
                </div>

                <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">Zapasowy / Fallback (Priorytet 2 — gdy główny odłączony):</span>
                  <select class="fc-select" id="sel-mic-desk-fallback" style="font-size: 11px; padding: 4px 8px; height: 28px;">
                    <option value="" ${!form.micDeskFallbackName ? 'selected' : ''}>— Brak zapasowego (opcjonalny) —</option>
                    ${app.missingDeviceOption(form.micDeskFallbackName || '', app.audioDevices)}
                    ${app.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micDeskFallbackName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                  </select>
                </div>

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

                <!-- Per-Microphone Voice Filters & Auto-VAD Helper -->
                <div class="fc-mic-extras">
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <div class="fc-micro-label">
                      <span>🎮 Próg Discord:</span>
                      <strong style="color: ${form.micDeskAutoThreshold ? '#a855f7' : form.micDeskGateDb === -1 ? '#38bdf8' : '#fbbf24'}" id="val-gate-desk">${form.micDeskAutoThreshold ? 'Auto (Voice Isolation)' : form.micDeskGateDb === -1 ? 'Push-to-Talk (PTT)' : `${deskGateVal} dB`}</strong>
                    </div>
                    <div style="display: flex; gap: 4px">
                      <button class="fc-preset-pill" id="btn-vad-sync-desk" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); padding: 2px 7px" title="Pobierz aktualny próg z Discorda">⬇️ Z Discorda</button>
                      <button class="fc-preset-pill" id="btn-vad-calibrate-desk" style="color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); padding: 2px 7px" title="Automatycznie zmierz szum pokoju i Twój głos">🎯 Auto-Dopasuj</button>
                    </div>
                  </div>
                  <input type="range" class="fc-slider" id="rng-gate-desk" min="-100" max="0" step="1" value="${deskGateVal}" />

                  <!-- Quick VAD Presets -->
                  <div style="display: flex; gap: 4px; margin-top: 3px; flex-wrap: wrap">
                    <button class="fc-preset-pill ${form.micDeskAutoThreshold ? 'active' : ''}" id="preset-vad-desk-auto" style="font-size: 9.5px; padding: 2px 6px; ${form.micDeskAutoThreshold ? 'background: rgba(168, 85, 247, 0.2); color: #c084fc; border-color: #a855f7;' : 'color: #c084fc; border-color: rgba(168, 85, 247, 0.4);'}" title="Automatyczna czułość wejścia Discorda (Voice Isolation / Auto VAD)">🤖 Auto (Voice Isolation)</button>
                    <button class="fc-preset-pill ${!form.micDeskAutoThreshold && deskGateVal === -55 ? 'active' : ''}" id="preset-vad-desk-quiet" style="font-size: 9.5px; padding: 2px 5px">🤫 -55 dB</button>
                    <button class="fc-preset-pill ${!form.micDeskAutoThreshold && deskGateVal === -45 ? 'active' : ''}" id="preset-vad-desk-std" style="font-size: 9.5px; padding: 2px 5px">⚖️ -45 dB</button>
                    <button class="fc-preset-pill ${!form.micDeskAutoThreshold && deskGateVal === -35 ? 'active' : ''}" id="preset-vad-desk-noisy" style="font-size: 9.5px; padding: 2px 5px">⌨️ -35 dB</button>
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
                  <div class="fc-metric-large" id="status-title-desk" style="color: ${isDeskActive ? (app.isMuted ? '#f59e0b' : 'var(--fc-accent-green)') : 'var(--fc-text-secondary)'}">
                    ${isDeskActive ? (app.isMuted ? 'Wyciszony 🔇' : 'Aktywny 🎙️') : 'Gotowy'}
                  </div>
                  <div class="fc-metric-sub" id="status-sub-desk">
                    ${isDeskActive ? (app.isMuted ? 'Mikrofon jest wyciszony w systemie' : 'Dźwięk przekazywany do aplikacji') : 'Mikrofon stacjonarny'}
                  </div>
                </div>
                <span class="fc-badge ${isDeskActive ? 'calibrated' : 'muted'}" id="badge-mic-desk">${isDeskActive ? 'Domyślny ✓' : 'Gotowy'}</span>
              </div>
            </div>

            <!-- Card 2: Mikrofon Mobilny (Słuchawki / Headset) -->
            <div class="fc-card ${isHeadsetActive ? 'highlight active-mic' : ''}" id="card-mic-headset">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon blue">🎧</span>
                  <span class="fc-card-title">Mikrofon Mobilny (Słuchawki)</span>
                </div>
                <button class="fc-card-more" id="card-btn-test-headset" title="Przełącz i przetestuj ten mikrofon">▶ Aktywuj</button>
              </div>

              <div class="fc-card-body">
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-size: 10.5px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px;">Główny mikrofon (Priorytet 1):</span>
                  <select class="fc-select ${isHeadsetActive ? 'active-source' : ''}" id="sel-mic-headset">
                    <option value="" ${!form.micHeadsetName ? 'selected' : ''}>— Wybierz mikrofon Windows —</option>
                    ${app.missingDeviceOption(form.micHeadsetName, app.audioDevices)}
                    ${app.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micHeadsetName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                  </select>
                </div>

                <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">Zapasowy / Fallback (Priorytet 2 — gdy główny odłączony):</span>
                  <select class="fc-select" id="sel-mic-headset-fallback" style="font-size: 11px; padding: 4px 8px; height: 28px;">
                    <option value="" ${!form.micHeadsetFallbackName ? 'selected' : ''}>— Brak zapasowego (opcjonalny) —</option>
                    ${app.missingDeviceOption(form.micHeadsetFallbackName || '', app.audioDevices)}
                    ${app.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micHeadsetFallbackName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                  </select>
                </div>

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

                <!-- Per-Microphone Voice Filters & Auto-VAD Helper -->
                <div class="fc-mic-extras">
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <div class="fc-micro-label">
                      <span>🎮 Próg Discord:</span>
                      <strong style="color: ${form.micHeadsetAutoThreshold ? '#a855f7' : form.micHeadsetGateDb === -1 ? '#38bdf8' : '#fbbf24'}" id="val-gate-headset">${form.micHeadsetAutoThreshold ? 'Auto (Voice Isolation)' : form.micHeadsetGateDb === -1 ? 'Push-to-Talk (PTT)' : `${headGateVal} dB`}</strong>
                    </div>
                    <div style="display: flex; gap: 4px">
                      <button class="fc-preset-pill" id="btn-vad-sync-headset" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); padding: 2px 7px" title="Pobierz aktualny próg z Discorda">⬇️ Z Discorda</button>
                      <button class="fc-preset-pill" id="btn-vad-calibrate-headset" style="color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); padding: 2px 7px" title="Automatycznie zmierz szum i Twój głos">🎯 Auto-Dopasuj</button>
                    </div>
                  </div>
                  <input type="range" class="fc-slider" id="rng-gate-headset" min="-100" max="0" step="1" value="${headGateVal}" />

                  <!-- Quick VAD Presets -->
                  <div style="display: flex; gap: 4px; margin-top: 3px; flex-wrap: wrap">
                    <button class="fc-preset-pill ${form.micHeadsetAutoThreshold ? 'active' : ''}" id="preset-vad-headset-auto" style="font-size: 9.5px; padding: 2px 6px; ${form.micHeadsetAutoThreshold ? 'background: rgba(168, 85, 247, 0.2); color: #c084fc; border-color: #a855f7;' : 'color: #c084fc; border-color: rgba(168, 85, 247, 0.4);'}" title="Automatyczna czułość wejścia Discorda (Voice Isolation / Auto VAD)">🤖 Auto (Voice Isolation)</button>
                    <button class="fc-preset-pill ${!form.micHeadsetAutoThreshold && headGateVal === -55 ? 'active' : ''}" id="preset-vad-headset-quiet" style="font-size: 9.5px; padding: 2px 5px">🤫 -55 dB</button>
                    <button class="fc-preset-pill ${!form.micHeadsetAutoThreshold && headGateVal === -45 ? 'active' : ''}" id="preset-vad-headset-std" style="font-size: 9.5px; padding: 2px 5px">⚖️ -45 dB</button>
                    <button class="fc-preset-pill ${!form.micHeadsetAutoThreshold && headGateVal === -35 ? 'active' : ''}" id="preset-vad-headset-noisy" style="font-size: 9.5px; padding: 2px 5px">⌨️ -35 dB</button>
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
                  <div class="fc-metric-large" id="status-title-headset" style="color: ${isHeadsetActive ? (app.isMuted ? '#f59e0b' : '#38bdf8') : 'var(--fc-text-secondary)'}">
                    ${isHeadsetActive ? (app.isMuted ? 'Wyciszony 🔇' : 'Aktywny 🎙️') : 'Gotowy'}
                  </div>
                  <div class="fc-metric-sub" id="status-sub-headset">
                    ${isHeadsetActive ? (app.isMuted ? 'Mikrofon jest wyciszony w systemie' : 'Dźwięk przekazywany do aplikacji') : 'Mikrofon mobilny'}
                  </div>
                </div>
                <span class="fc-badge ${isHeadsetActive ? 'calibrated' : 'muted'}" id="badge-mic-headset">${isHeadsetActive ? 'Domyślny ✓' : 'Gotowy'}</span>
              </div>
            </div>

            <!-- Card 3: Tryb Pracy & Reguły Automatyki -->
            <div class="fc-card">
              <div class="fc-card-header">
                <div class="fc-card-title-group">
                  <span class="fc-card-icon amber">🎚️</span>
                  <span class="fc-card-title">Tryb & Reguły Przełączania</span>
                </div>
                <button class="fc-switch ${!app.isMuted ? 'active' : ''}" id="card-sw-mute" aria-checked="${!app.isMuted}" role="switch" title="Wycisz/Odcisz"></button>
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
                    <option value="0" ${!app.snoozeUntil ? 'selected' : ''}>Brak (Aktywna)</option>
                    <option value="15" ${app.snoozeUntil && Math.round((app.snoozeUntil - Date.now()) / 60000) <= 20 ? 'selected' : ''}>Pauza 15 min</option>
                    <option value="30" ${app.snoozeUntil && Math.round((app.snoozeUntil - Date.now()) / 60000) > 20 && Math.round((app.snoozeUntil - Date.now()) / 60000) <= 45 ? 'selected' : ''}>Pauza 30 min</option>
                    <option value="60" ${app.snoozeUntil && Math.round((app.snoozeUntil - Date.now()) / 60000) > 45 ? 'selected' : ''}>Pauza 1 godzina</option>
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
                <span class="fc-badge ${app.isMuted ? 'amber' : 'success'}" id="card-badge-mute">${app.isMuted ? 'Wyciszony 🔇' : 'Aktywny 🎙️'}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- ==================== SEKCJA 2: TELEMETRIA SENSORÓW & STAN OBECNOŚCI ==================== -->
        <section class="fc-section">
          <div class="fc-section-header">
            <div class="fc-section-title-wrap">
              <span class="fc-section-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fc-accent-green)" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="M12 2v6"/><path d="M12 18v4"/><path d="M4.93 19.07l4.24-4.24"/></svg>
                Telemetria Sensorów & Stan Obecności na Żywo
              </span>
            </div>
          </div>

          <!-- BANNER GŁÓWNY: STAN OBECNOŚCI -->
          <div class="fc-radar-scope-box" style="padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; gap: 16px; border-radius: 12px; background: rgba(13, 17, 23, 0.7); border: 1px solid var(--fc-card-border); margin-bottom: 10px;">
            <div style="display: flex; align-items: center; gap: 14px;">
              <div id="scope-presence-icon" style="width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 22px; background: ${snap.state === 'desk' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)'}; border: 1px solid ${snap.state === 'desk' ? 'rgba(34, 197, 94, 0.4)' : 'rgba(245, 158, 11, 0.4)'}; transition: all 0.3s ease;">
                ${snap.state === 'desk' ? '👤' : '🚶'}
              </div>
              <div>
                <div id="scope-presence-label" style="font-size: 15px; font-weight: 700; color: ${snap.state === 'desk' ? 'var(--fc-accent-green)' : '#f59e0b'}; display: flex; align-items: center; gap: 8px;">
                  <span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: ${snap.state === 'desk' ? 'var(--fc-accent-green)' : '#f59e0b'}; display: inline-block;"></span>
                  ${snap.state === 'desk' ? 'WYKRYTO OBECNOŚĆ (DESK)' : 'BRAK OBECNOŚCI (AWAY)'}
                </div>
                <div style="font-size: 11.5px; color: var(--fc-text-secondary); margin-top: 2px;">
                  ${is24G ? 'Radar mmWave 24 GHz · Błyskawiczna reakcja strefowa (1–2s)' : 'Fuzja radaru mmWave 60 GHz + czujników biometrycznych'}
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 10px;">
              <span id="scope-live-badge" class="fc-badge ${snap.state === 'desk' ? 'calibrated' : 'muted'}" style="font-size: 11.5px; padding: 4px 12px; font-weight: 600;">
                ${snap.state === 'desk' ? 'Przy biurku ✓' : 'Poza biurkiem'}
              </span>
            </div>
          </div>

          <!-- KAFLE TELEMETRII (DOPASOWANE DYNAMICZNIE DO 24GHz / 60GHz) -->
          <div class="fc-subgrid-5">
            <!-- Kafel 1: Dystans -->
            <div class="fc-telemetry-tile">
              <div class="fc-telemetry-tile-header">
                <span style="font-size: 13px;">📏</span>
                <span class="fc-telemetry-tile-title">Dystans</span>
              </div>
              <div class="fc-telemetry-tile-val" id="home-val-distance">
                ${app.telemetry.distanceCm && app.telemetry.distanceCm > 0 ? `${app.telemetry.distanceCm} cm` : '—'}
              </div>
              <div class="fc-telemetry-tile-sub">Odległość do radaru</div>
            </div>

            ${is24G ? `
              <!-- Kafel 2 (24G): Ruch -->
              <div class="fc-telemetry-tile">
                <div class="fc-telemetry-tile-header">
                  <span style="font-size: 13px;">🏃</span>
                  <span class="fc-telemetry-tile-title">Cel Ruchomy</span>
                </div>
                <div class="fc-telemetry-tile-val" id="home-val-moving" style="color: #38bdf8; font-size: 15px;">
                  ${app.telemetry.movingTarget ? (app.telemetry.movingDistanceCm ? `Ruch (${app.telemetry.movingDistanceCm} cm)` : 'Wykryto ruch') : 'Brak ruchu'}
                </div>
                <div class="fc-telemetry-tile-sub">Strefa ruchu 24 GHz</div>
              </div>

              <!-- Kafel 3 (24G): Statyka -->
              <div class="fc-telemetry-tile">
                <div class="fc-telemetry-tile-header">
                  <span style="font-size: 13px;">🧘</span>
                  <span class="fc-telemetry-tile-title">Cel Statyczny</span>
                </div>
                <div class="fc-telemetry-tile-val" id="home-val-still" style="color: var(--fc-accent-green); font-size: 15px;">
                  ${app.telemetry.stillTarget ? (app.telemetry.stillDistanceCm ? `Statyka (${app.telemetry.stillDistanceCm} cm)` : 'Wykryto obecność') : (snap.state === 'desk' ? 'Obecny ✓' : '—')}
                </div>
                <div class="fc-telemetry-tile-sub">Strefa bezruchu</div>
              </div>

              <!-- Kafel 4 (24G): Czas Reakcji -->
              <div class="fc-telemetry-tile">
                <div class="fc-telemetry-tile-header">
                  <span style="font-size: 13px;">⚡</span>
                  <span class="fc-telemetry-tile-title">Czas Reakcji</span>
                </div>
                <div class="fc-telemetry-tile-val" id="home-val-speed" style="color: #fbbf24; font-size: 15px;">
                  ⚡ 1–2s
                </div>
                <div class="fc-telemetry-tile-sub">Brak bufora 30s</div>
              </div>
            ` : `
              <!-- Kafel 2 (60G): Tętno -->
              <div class="fc-telemetry-tile">
                <div class="fc-telemetry-tile-header">
                  <span style="font-size: 13px;">❤️</span>
                  <span class="fc-telemetry-tile-title">Tętno</span>
                </div>
                <div class="fc-telemetry-tile-val" id="home-val-heart" style="color: #f87171;">
                  ${app.telemetry.heartRate && app.telemetry.heartRate > 0 ? `${app.telemetry.heartRate} BPM` : '—'}
                </div>
                <div class="fc-telemetry-tile-sub">Biometria 60 GHz</div>
              </div>

              <!-- Kafel 3 (60G): Oddech -->
              <div class="fc-telemetry-tile">
                <div class="fc-telemetry-tile-header">
                  <span style="font-size: 13px;">🫁</span>
                  <span class="fc-telemetry-tile-title">Oddech</span>
                </div>
                <div class="fc-telemetry-tile-val" id="home-val-breath" style="color: #38bdf8;">
                  ${app.telemetry.breathRate && app.telemetry.breathRate > 0 ? `${app.telemetry.breathRate} RPM` : '—'}
                </div>
                <div class="fc-telemetry-tile-sub">Częstotliwość oddechu</div>
              </div>

              <!-- Kafel 4 (60G): Oświetlenie -->
              <div class="fc-telemetry-tile">
                <div class="fc-telemetry-tile-header">
                  <span style="font-size: 13px;">💡</span>
                  <span class="fc-telemetry-tile-title">Oświetlenie</span>
                </div>
                <div class="fc-telemetry-tile-val" id="home-val-lux" style="color: #fbbf24;">
                  ${typeof app.telemetry.illuminanceLux === 'number' ? `${app.telemetry.illuminanceLux} lx` : '—'}
                </div>
                <div class="fc-telemetry-tile-sub">Czujnik BH1750</div>
              </div>
            `}

            <!-- Kafel 5: Cel / Obiekt -->
            <div class="fc-telemetry-tile">
              <div class="fc-telemetry-tile-header">
                <span style="font-size: 13px;">🎯</span>
                <span class="fc-telemetry-tile-title">Klasyfikacja</span>
              </div>
              <div class="fc-telemetry-tile-val" id="home-val-person" style="font-size: 16px; color: #c084fc;">
                ${app.telemetry.detectedPerson === 'me' ? 'Człowiek ✓' : (app.telemetry.detectedPerson === 'pet' ? 'Zwierzę' : (snap.state === 'desk' ? 'Człowiek ✓' : 'Brak celu'))}
              </div>
              <div class="fc-telemetry-tile-sub" id="home-val-targets">${snap.state === 'desk' ? `${app.telemetry.targetCount ?? 1} cel w kadrze` : 'Brak celu'}</div>
            </div>
          </div>
        </section>
      </div>
    `;
  }
