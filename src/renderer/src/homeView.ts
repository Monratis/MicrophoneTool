// Widok glowny: live DOM (naglowek, karty mikrofonow, telemetria, radar-scope) + dashboard Home

import type { AppUI } from './app';
import { esc, STATE_LABEL } from './ui';

export function triggerOsdHud(app: AppUI, text: string, isMuted: boolean) {
    const el = document.getElementById('fc-osd-hud');
    if (!el) return;
    if (app.osdTimer) clearTimeout(app.osdTimer);

    el.className = `fc-osd-hud visible ${isMuted ? 'muted' : ''}`;
    el.innerHTML = `<span>${text}</span>`;

    app.osdTimer = setTimeout(() => {
      el.className = `fc-osd-hud ${isMuted ? 'muted' : ''}`;
    }, 2200);
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
      active: boolean,
      idleLabel: string
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
    };

    apply('card-mic-desk', 'sel-mic-desk', 'badge-mic-desk', isDeskActive, 'Gotowy');
    apply('card-mic-headset', 'sel-mic-headset', 'badge-mic-headset', isHeadsetActive, 'Rezerwa');
  }

export function updateTelemetryDOM(app: AppUI) {
    const elDist = document.getElementById('card-val-distance');
    const elHeart = document.getElementById('card-val-heart');
    const elBreath = document.getElementById('card-val-breath');
    const elLux = document.getElementById('card-val-lux');
    const elPerson = document.getElementById('card-badge-person');

    if (elDist) {
      if (app.telemetry.distanceCm && app.telemetry.distanceCm > 0) {
        elDist.textContent =
          app.telemetry.distanceTrusted === false
            ? `${app.telemetry.distanceCm} cm (niepewny)`
            : `${app.telemetry.distanceCm} cm`;
      } else if (app.telemetry.presence === false) {
        elDist.textContent = '— (Brak celu)';
      } else {
        elDist.textContent = '—';
      }
    }
    if (elHeart) elHeart.textContent = app.telemetry.heartRate ? `${app.telemetry.heartRate} BPM` : '—';
    if (elBreath) elBreath.textContent = app.telemetry.breathRate ? `${app.telemetry.breathRate} RPM` : '—';
    if (elLux) {
      elLux.textContent = typeof app.telemetry.illuminanceLux === 'number' ? `${app.telemetry.illuminanceLux} lx` : '—';
    }

    if (elPerson) {
      const p = app.telemetry.detectedPerson || 'unknown';
      elPerson.className = `fc-badge ${p === 'me' ? 'calibrated' : (p === 'pet' ? 'amber' : 'blue')}`;
      if (p === 'me') {
        elPerson.textContent = '👤 Człowiek ✓';
      } else if (p === 'pet') {
        elPerson.textContent = '🐾 Zwierzę (Kot/Pies)';
      } else {
        elPerson.textContent = '🔍 Skanowanie…';
      }
    }

    // Update Live Radar Scope Visualizer
    updateRadarScopeDOM(app);

    const tun = app.telemetry.autoTuning;
    if (tun) {
      const elTunDist = document.getElementById('card-val-autotune-dist');
      const elTunStability = document.getElementById('card-badge-autotune-stability');
      const elTunZone = document.getElementById('card-val-autotune-zone');
      const elTunBio = document.getElementById('card-val-autotune-bio');
      if (elTunDist) elTunDist.textContent = tun.adaptedDistanceCenter ? `${tun.adaptedDistanceCenter} cm` : '—';
      if (elTunZone) elTunZone.textContent = autoTuneZoneLabel(app);
      if (elTunBio) elTunBio.textContent = autoTuneBioLabel(app);
      if (elTunStability) elTunStability.textContent = autoTuneStabilityLabel(app, tun);
    }
  }

  /** Wyuczona strefa fotela = adaptacyjna bramka górna (auto-tuning tylko poszerza config). */
export function autoTuneZoneLabel(app: AppUI): string {
    const tun = app.telemetry.autoTuning;
    if (!tun?.adaptedDistanceCenter) return '—';
    return `${tun.adaptedDistanceMin}–${tun.adaptedDistanceMax} cm`;
  }

  /** Wyuczone średnie tętno/oddech — dowód, że radar widzi użytkownika biologicznie. */
export function autoTuneBioLabel(app: AppUI): string {
    const tun = app.telemetry.autoTuning;
    if (!tun?.adaptedHeartRateAvg && !tun?.adaptedBreathRateAvg) return '—';
    const hr = tun?.adaptedHeartRateAvg ? `${tun.adaptedHeartRateAvg} BPM` : '—';
    const br = tun?.adaptedBreathRateAvg ? `${tun.adaptedBreathRateAvg} RPM` : '—';
    return `${hr} · ${br}`;
  }

export function autoTuneStabilityLabel(_app: AppUI, tun: { stabilityScore?: number; stabilityReady?: boolean } | undefined): string {
    if (!tun?.stabilityReady) return 'Nauka…';
    return `Stabilność: ${tun.stabilityScore ?? 0}% ✓`;
  }

export function updateRadarScopeDOM(app: AppUI) {
    if (!app.form) return;
    const minGate = app.form.radarMinDistanceCm ?? 40;
    const maxGate = app.form.radarMaxDistanceCm ?? 110;
    const maxScale = 200;

    const deadPct = Math.max(0, Math.min(100, (minGate / maxScale) * 100));
    const activeLeftPct = deadPct;
    const activeWidthPct = Math.max(2, Math.min(100 - deadPct, ((maxGate - minGate) / maxScale) * 100));
    const cutoffLeftPct = Math.min(100, (maxGate / maxScale) * 100);

    const deadZone = document.getElementById('scope-dead-zone');
    const activeZone = document.getElementById('scope-active-zone');
    const cutoffZone = document.getElementById('scope-cutoff-zone');
    const userPin = document.getElementById('scope-user-pin');
    const userBadge = document.getElementById('scope-user-badge');
    const userLine = document.getElementById('scope-user-line');
    const liveStatusText = document.getElementById('scope-live-status-text');
    const minHandle = document.getElementById('scope-handle-min');
    const maxHandle = document.getElementById('scope-handle-max');

    if (deadZone) deadZone.style.width = `${deadPct}%`;
    if (activeZone) {
      activeZone.style.left = `${activeLeftPct}%`;
      activeZone.style.width = `${activeWidthPct}%`;
      activeZone.innerHTML = `<span>STREFA FOTELA (${minGate}–${maxGate} cm)</span>`;
    }
    if (cutoffZone) {
      cutoffZone.style.left = `${cutoffLeftPct}%`;
      cutoffZone.style.width = `${Math.max(0, 100 - cutoffLeftPct)}%`;
    }
    if (minHandle) minHandle.style.left = `${deadPct}%`;
    if (maxHandle) maxHandle.style.left = `${cutoffLeftPct}%`;

    if (userPin && userBadge && userLine) {
      const curDist = app.telemetry.distanceCm;
      if (curDist && curDist > 0) {
        const userPct = Math.max(0, Math.min(100, (curDist / maxScale) * 100));
        const isInside = curDist >= minGate && curDist <= maxGate;

        userPin.style.display = 'flex';
        userPin.style.left = `${userPct}%`;

        userBadge.className = `fc-scope-user-badge ${isInside ? '' : 'outside'}`;
        userBadge.innerHTML =
          app.telemetry.distanceTrusted === false
            ? `⚠️ Cel niepewny: ${curDist} cm (kot?)`
            : isInside
              ? `● Ty: ${curDist} cm ✓`
              : `⚠️ ${curDist} cm (Poza strefą)`;

        userLine.className = `fc-scope-user-line ${isInside ? '' : 'outside'}`;

        if (liveStatusText) {
          liveStatusText.innerHTML =
            app.telemetry.distanceTrusted === false
              ? `<strong style="color: #f59e0b">⚠️ Cel niejednoznaczny: ${curDist} cm</strong> <span style="color: var(--fc-text-muted)">(kot? — bramka wstrzymana)</span>`
              : isInside
                ? `<strong style="color: var(--fc-accent-green)">● Obecność: ${curDist} cm</strong> <span style="color: var(--fc-text-secondary)">(W aktywnej strefie fotela ✓)</span>`
                : `<strong style="color: #f59e0b">⚠️ Wykryto poza strefą: ${curDist} cm</strong> <span style="color: var(--fc-text-muted)">(Ignorowane tło)</span>`;
        }
      } else {
        userPin.style.display = 'none';
        if (liveStatusText) {
          liveStatusText.innerHTML = `<span style="color: var(--fc-text-muted)">Brak wykrycia człowieka w kadrze radaru</span>`;
        }
      }
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

    // Dynamic gate geometry
    const minGate = form.radarMinDistanceCm ?? 40;
    const maxGate = form.radarMaxDistanceCm ?? 110;
    const curDist = app.telemetry.distanceCm;
    const isInside = curDist ? (curDist >= minGate && curDist <= maxGate) : false;

    // VAD values (zgodne z zakresem Discorda: -100 dB do 0 dB)
    const deskGateVal = Math.max(-100, Math.min(0, form.micDeskGateDb ?? -45));
    const deskGatePct = Math.max(0, Math.min(100, ((deskGateVal + 100) / 100) * 100));

    const headGateVal = Math.max(-100, Math.min(0, form.micHeadsetGateDb ?? -45));
    const headGatePct = Math.max(0, Math.min(100, ((headGateVal + 100) / 100) * 100));

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
            <div class="fc-section-actions">
              <button class="btn btn-ghost btn-sm" id="btn-home-detect-mics" style="font-size: 11px; padding: 4px 9px">🔍 Auto-wykryj mikrofony</button>
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
                <select class="fc-select ${isDeskActive ? 'active-source' : ''}" id="sel-mic-desk">
                  <option value="" ${!form.micDeskName ? 'selected' : ''}>— Wybierz mikrofon Windows —</option>
                  ${app.missingDeviceOption(form.micDeskName, app.audioDevices)}
                  ${app.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micDeskName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                </select>

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
                      <strong style="color: #fbbf24" id="val-gate-desk">${deskGateVal} dB</strong>
                    </div>
                    <div style="display: flex; gap: 4px">
                      <button class="fc-preset-pill" id="btn-vad-sync-desk" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); padding: 2px 7px" title="Pobierz aktualny próg z Discorda">⬇️ Z Discorda</button>
                      <button class="fc-preset-pill" id="btn-vad-calibrate-desk" style="color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); padding: 2px 7px" title="Automatycznie zmierz szum pokoju i Twój głos">🎯 Auto-Dopasuj</button>
                    </div>
                  </div>
                  <input type="range" class="fc-slider" id="rng-gate-desk" min="-100" max="0" step="1" value="${deskGateVal}" />

                  <!-- Quick VAD Presets -->
                  <div style="display: flex; gap: 4px; margin-top: 3px">
                    <button class="fc-preset-pill" id="preset-vad-desk-quiet" style="font-size: 9.5px; padding: 2px 5px">🤫 -55 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-desk-std" style="font-size: 9.5px; padding: 2px 5px">⚖️ -45 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-desk-noisy" style="font-size: 9.5px; padding: 2px 5px">⌨️ -35 dB</button>
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
                  <div class="fc-metric-large">${form.micDeskVolume ?? 100} %</div>
                  <div class="fc-metric-sub">Głośność profilu (aplikowana przy przełączeniu)</div>
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
                <select class="fc-select ${isHeadsetActive ? 'active-source' : ''}" id="sel-mic-headset">
                  <option value="" ${!form.micHeadsetName ? 'selected' : ''}>— Wybierz mikrofon Windows —</option>
                  ${app.missingDeviceOption(form.micHeadsetName, app.audioDevices)}
                  ${app.audioDevices.map((d) => `<option value="${esc(d.name)}" data-id="${esc(d.id || '')}" ${d.name === form.micHeadsetName ? 'selected' : ''}>${esc(d.name)}${d.isDefault ? ' (Domyślny)' : ''}</option>`).join('')}
                </select>

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
                      <strong style="color: #fbbf24" id="val-gate-headset">${headGateVal} dB</strong>
                    </div>
                    <div style="display: flex; gap: 4px">
                      <button class="fc-preset-pill" id="btn-vad-sync-headset" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); padding: 2px 7px" title="Pobierz aktualny próg z Discorda">⬇️ Z Discorda</button>
                      <button class="fc-preset-pill" id="btn-vad-calibrate-headset" style="color: #fbbf24; border-color: rgba(245, 158, 11, 0.4); padding: 2px 7px" title="Automatycznie zmierz szum i Twój głos">🎯 Auto-Dopasuj</button>
                    </div>
                  </div>
                  <input type="range" class="fc-slider" id="rng-gate-headset" min="-100" max="0" step="1" value="${headGateVal}" />

                  <!-- Quick VAD Presets -->
                  <div style="display: flex; gap: 4px; margin-top: 3px">
                    <button class="fc-preset-pill" id="preset-vad-headset-quiet" style="font-size: 9.5px; padding: 2px 5px">🤫 -55 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-headset-std" style="font-size: 9.5px; padding: 2px 5px">⚖️ -45 dB</button>
                    <button class="fc-preset-pill" id="preset-vad-headset-noisy" style="font-size: 9.5px; padding: 2px 5px">⌨️ -35 dB</button>
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
                  <div class="fc-metric-large">${form.micHeadsetVolume ?? 100} %</div>
                  <div class="fc-metric-sub">Głośność profilu (aplikowana przy przełączeniu)</div>
                </div>
                <span class="fc-badge ${isHeadsetActive ? 'calibrated' : 'muted'}" id="badge-mic-headset">${isHeadsetActive ? 'Domyślny ✓' : 'Rezerwa'}</span>
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
                    <option value="15" ${app.snoozeUntil ? 'selected' : ''}>Pauza 15 min</option>
                    <option value="30">Pauza 30 min</option>
                    <option value="60">Pauza 1 godzina</option>
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


        <!-- ==================== SEKCJA 2: RADAR MMWAVE 60 GHZ & KORYTARZ ZASIĘGU NA ŻYWO ==================== -->
        <section class="fc-section">
          <div class="fc-section-header">
            <div class="fc-section-title-wrap">
              <span class="fc-section-title">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fc-accent-green)" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="M12 2v6"/><path d="M12 18v4"/><path d="M4.93 19.07l4.24-4.24"/></svg>
                Radar mmWave 60 GHz & Wizualny Korytarz Zasięgu
              </span>
              <span class="fc-info-badge" title="Wizualizacja strefy fotela na żywo — przeciągnij uchwyty, aby zmienić granice; pozostałe ustawienia radaru znajdziesz w zakładce Ustawienia">?</span>
            </div>
            <div class="fc-section-actions">
              <button class="btn btn-ghost btn-sm" id="btn-home-open-wizard" style="font-size: 11px; padding: 4px 9px">✨ Kreator Kalibracji</button>
            </div>
          </div>

          <!-- FULL INTERACTIVE RADAR SCOPE CORRIDOR (0-200 CM) ON HOME DASHBOARD -->
          <div class="fc-radar-scope-box">
            <div class="fc-scope-header">
              <div>
                <strong style="font-size: 13px; color: #fff; display: flex; align-items: center; gap: 6px">
                  <span>📡</span> Korytarz Zasięgu Radaru na Żywo (0–200 cm)
                </strong>
                <div style="font-size: 11px; margin-top: 2px" id="scope-live-status-text">
                  ${curDist && curDist > 0 ? (
                    isInside
                      ? `<strong style="color: var(--fc-accent-green)">● Obecność: ${curDist} cm</strong> <span style="color: var(--fc-text-secondary)">(W aktywnej strefie fotela ✓)</span>`
                      : `<strong style="color: #f59e0b">⚠️ Wykryto poza strefą: ${curDist} cm</strong> <span style="color: var(--fc-text-muted)">(Ignorowane tło)</span>`
                  ) : `<span style="color: var(--fc-text-muted)">Brak wykrycia człowieka w kadrze radaru</span>`}
                </div>
              </div>
              <span class="fc-badge ${form.radarDistanceGateEnabled !== false ? 'calibrated' : 'muted'}">
                ${form.radarDistanceGateEnabled !== false ? 'Bramka Dystansu Aktywna ✓' : 'Bramka Wyłączona'}
              </span>
            </div>

            <div class="fc-scope-track-container">
              <div class="fc-scope-track">
                <div class="fc-scope-grid-lines"></div>
                <div class="fc-scope-dead-zone" id="scope-dead-zone" style="width: ${(minGate / 200) * 100}%">
                  <span>Martwa strefa</span>
                </div>
                <div class="fc-scope-active-zone" id="scope-active-zone" style="left: ${(minGate / 200) * 100}%; width: ${((maxGate - minGate) / 200) * 100}%">
                  <span>STREFA FOTELA (${minGate}–${maxGate} cm)</span>
                </div>
                <div class="fc-scope-cutoff-zone" id="scope-cutoff-zone" style="left: ${(maxGate / 200) * 100}%; width: ${Math.max(0, 100 - (maxGate / 200) * 100)}%">
                  <span>Ignorowane tło</span>
                </div>
                <div class="fc-scope-handle min" id="scope-handle-min" style="left: ${(minGate / 200) * 100}%" title="Przeciągnij, aby ustawić początek strefy fotela"></div>
                <div class="fc-scope-handle max" id="scope-handle-max" style="left: ${(maxGate / 200) * 100}%" title="Przeciągnij, aby ustawić koniec strefy fotela"></div>
              </div>

              <div class="fc-scope-user-pin" id="scope-user-pin" style="left: ${curDist ? (curDist / 200) * 100 : 0}%; display: ${curDist && curDist > 0 ? 'flex' : 'none'}">
                <div class="fc-scope-user-badge ${isInside ? '' : 'outside'}" id="scope-user-badge">
                  ${isInside ? `● Ty: ${curDist} cm ✓` : `⚠️ ${curDist} cm (Poza strefą)`}
                </div>
                <div class="fc-scope-user-line ${isInside ? '' : 'outside'}" id="scope-user-line"></div>
              </div>

              <div class="fc-scope-ticks">
                <span>0 cm (Sensor)</span>
                <span>50 cm</span>
                <span>100 cm</span>
                <span>150 cm</span>
                <span>200 cm (Maks)</span>
              </div>
            </div>

            <!-- Interaktywna regulacja strefy fotela (drag handles) -->
            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--fc-card-border); padding-top: 8px; margin-top: 4px">
              <span style="font-size: 11px; color: var(--fc-text-secondary)">Przeciągnij uchwyty na grafice, aby dopasować strefę fotela (zakres: ${minGate}–${maxGate} cm)</span>
              <button class="btn btn-ghost btn-sm" id="btn-scope-reset-gate" style="font-size: 10.5px; padding: 3px 8px" title="Przywróć domyślną strefę fotela 40–110 cm">↺ Reset (40–110 cm)</button>
            </div>
          </div>
        </section>
      </div>
    `;
  }
