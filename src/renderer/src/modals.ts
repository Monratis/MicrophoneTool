// Modale: kalibracja VAD, wizard kalibracji radaru, sesja diagnostyczna, diag telemetrii

import type { AppUI } from './app';
import type { DiagSessionTimelineItem } from './global';
import { esc, playChime } from './ui';
import { isMicActive, updateHeaderAndLiveDOM } from './homeView';

  // ---------- VAD Auto-Calibration Assistant Methods ----------
export function openVadModal(app: AppUI, target: 'desk' | 'headset') {
    app.vadTarget = target;
    app.vadModalOpen = true;
    app.vadStep = 1;
    app.vadCountdown = 0;
    app.vadNoiseSamples = [];
    app.vadSpeechSamples = [];
    app.vadWarning = '';
    if (app.vadInterval) clearInterval(app.vadInterval);
    if (app.vadSampleInterval) clearInterval(app.vadSampleInterval);
    app.vadInterval = null;
    app.vadSampleInterval = null;
    app.render();
  }

export function closeVadModal(app: AppUI) {
    app.vadModalOpen = false;
    if (app.vadInterval) clearInterval(app.vadInterval);
    if (app.vadSampleInterval) clearInterval(app.vadSampleInterval);
    app.vadInterval = null;
    app.vadSampleInterval = null;
    app.render();
  }

export function runVadStep1(app: AppUI) {
    app.vadCountdown = 5;
    app.vadNoiseSamples = [];
    app.vadWarning = '';
    if (app.vadInterval) clearInterval(app.vadInterval);
    if (app.vadSampleInterval) clearInterval(app.vadSampleInterval);
    app.render();

    // Szybkie próbkowanie szumu tła 20x na sekundę (co 50ms)
    app.vadSampleInterval = setInterval(() => {
      const liveDb = app.vadTarget === 'desk' ? app.vuEngine.currentDeskDb : app.vuEngine.currentHeadDb;
      if (liveDb > -100) app.vadNoiseSamples.push(liveDb);
    }, 50);

    app.vadInterval = setInterval(() => {
      app.vadCountdown--;
      if (app.vadCountdown <= 0) {
        clearInterval(app.vadInterval);
        clearInterval(app.vadSampleInterval);
        app.vadInterval = null;
        app.vadSampleInterval = null;

        if (app.vadNoiseSamples.length === 0) {
          app.vadNoiseSamples.push(-70);
        }

        // Sortowanie próbek i pobranie 85. percentyla szumu otoczenia (uwzględnia szum wentylatorów i klikanie)
        const sorted = [...app.vadNoiseSamples].sort((a, b) => a - b);
        const p85Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85));
        const noiseP85 = Math.round(sorted[p85Idx]);

        if (noiseP85 > -25) {
          app.vadWarning = 'Wykryto zbyt głośny dźwięk podczas pomiaru ciszy. Upewnij się, że nie mówisz i powtórz krok 1.';
          app.render();
          return;
        }

        app.vadResults.noiseDb = Math.min(-35, Math.max(-95, noiseP85));
        playChime('desk', 0.2, app.selectedChimeStyle);
        app.vadStep = 2;
      }
      app.render();
    }, 1000);
  }

export function runVadStep2(app: AppUI) {
    app.vadCountdown = 6;
    app.vadSpeechSamples = [];
    app.vadWarning = '';
    if (app.vadInterval) clearInterval(app.vadInterval);
    if (app.vadSampleInterval) clearInterval(app.vadSampleInterval);
    app.render();

    // Gęste próbkowanie głosu co 50ms — zbieramy tylko aktywne sylaby głosu (ponad szumem)
    app.vadSampleInterval = setInterval(() => {
      const liveDb = app.vadTarget === 'desk' ? app.vuEngine.currentDeskDb : app.vuEngine.currentHeadDb;
      if (liveDb > app.vadResults.noiseDb + 3) {
        app.vadSpeechSamples.push(liveDb);
      }
    }, 50);

    app.vadInterval = setInterval(() => {
      app.vadCountdown--;
      if (app.vadCountdown <= 0) {
        clearInterval(app.vadInterval);
        clearInterval(app.vadSampleInterval);
        app.vadInterval = null;
        app.vadSampleInterval = null;

        const avgSpeech = app.vadSpeechSamples.length > 0
          ? Math.round(app.vadSpeechSamples.reduce((a, b) => a + b, 0) / app.vadSpeechSamples.length)
          : -24;

        if (avgSpeech <= app.vadResults.noiseDb + 3 || app.vadSpeechSamples.length < 5) {
          app.vadWarning = 'Nie wykryto wyraźnego głosu. Mów głośniej i powtórz krok 2.';
          app.render();
          return;
        }

        app.vadResults.speechDb = Math.max(-35, avgSpeech);

        // Bazowy próg: współczynnik 0.28 (czuły punkt startowy blisko szumu)
        const baseThreshold = app.vadResults.noiseDb + (app.vadResults.speechDb - app.vadResults.noiseDb) * 0.28;

        // Margines bezpieczeństwa -3 dB (lepiej przepuścić ciut więcej niż uciąć początek/końcówkę słowa)
        const safeGate = Math.round(baseThreshold - 3);

        // Dolny strażnik: próg musi być co najmniej 3 dB ponad szumem tła, aby nie otwierał się w ciszy
        const minAllowedGate = Math.round(app.vadResults.noiseDb + 3);
        const finalGate = Math.max(minAllowedGate, safeGate);

        app.vadResults.optimalGateDb = Math.min(-10, Math.max(-95, finalGate));

        playChime('desk', 0.25, app.selectedChimeStyle);
        app.vadStep = 3;
      }
      app.render();
    }, 1000);
  }

export function applyVadResults(app: AppUI) {
    const val = app.vadResults.optimalGateDb;
    if (app.vadTarget === 'desk') {
      app.patchForm({ micDeskGateDb: val }, true);
      if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
      app.pushToast(`Zastosowano próg Discord dla Mikrofonu Biurkowego: ${val} dB ✓`);
    } else {
      app.patchForm({ micHeadsetGateDb: val }, true);
      if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val });
      }
      app.pushToast(`Zastosowano próg Discord dla Mikrofonu Mobilnego: ${val} dB ✓`);
    }

    closeVadModal(app);
    void app.save();
  }

  // ---------- MODAL: VAD Auto-Calibration Assistant Modal ----------
export function renderVadModal(app: AppUI): string {
    const isDesk = app.vadTarget === 'desk';
    const micName = isDesk ? (app.form?.micDeskName || 'Mikrofon Biurkowy') : (app.form?.micHeadsetName || 'Mikrofon Mobilny');
    const step = app.vadStep;
    const count = app.vadCountdown;

    return `
      <div class="modal-overlay" id="vad-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>🎯 Asystent Kalibracji Progu Discord VAD</h3>
            <button class="close" id="btn-vad-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div style="font-size: 12px; color: var(--fc-text-secondary); margin-bottom: 12px">
              Kalibracja dla: <strong style="color: ${isDesk ? 'var(--fc-accent-green)' : 'var(--fc-accent-blue)'}">${esc(micName)}</strong>
            </div>

            <div class="wizard-steps">
              <div class="wizard-step-dot ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 3 ? 'done' : ''}"></div>
            </div>

            ${app.vadWarning ? `
              <div class="update-banner" style="border-color: rgba(239, 68, 68, 0.6); background: rgba(239, 68, 68, 0.12); margin-bottom: 12px">
                <div class="update-banner-icon" style="background: #ef4444">⚠️</div>
                <div class="update-banner-content">
                  <strong style="color: #fca5a5">Uwaga kalibracji</strong>
                  <p style="color: #fecaca; margin: 0">${esc(app.vadWarning)}</p>
                </div>
              </div>
            ` : ''}

            ${step === 1 ? `
              <div>
                <div class="wizard-icon-hero">🤫</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 1: Pomiar szumu tła i klawiatury</h4>
                <p class="wizard-instruction">
                  Bądź cicho przez 5 sekund. Możesz normalnie pisać na klawiaturze lub kliknąć myszką, aby asystent precyzyjnie zmierzył i odciął te dźwięki.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Mierzenie profilu szumu otoczenia…</strong>
                      <span>${count} s (${isDesk ? app.vuEngine.currentDeskDb : app.vuEngine.currentHeadDb} dB)</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((5 - count) / 5) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-vad-1" style="width: 100%">Rozpocznij pomiar tła (5s)</button>`}
                </div>
              </div>` : ''}

            ${step === 2 ? `
              <div>
                <div class="wizard-icon-hero">🗣️</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 2: Pomiar Twojej naturalnej mowy</h4>
                <p class="wizard-instruction">
                  Powiedz 2-3 zdania swoim naturalnym głosem przez 6 sekund (np. <em>„Raz, dwa, trzy, test mikrofonu DeskSense, sprawdzamy głośność głosu i czułość bramki”</em>).
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Rejestrowanie próbek głosu…</strong>
                      <span>${count} s (${isDesk ? app.vuEngine.currentDeskDb : app.vuEngine.currentHeadDb} dB)</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((6 - count) / 6) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-vad-2" style="width: 100%">Rozpocznij próbkę głosu (6s)</button>`}
                </div>
              </div>` : ''}

            ${step === 3 ? `
              <div>
                <div class="wizard-icon-hero">🎉</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Obliczono optymalny próg bramki!</h4>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px">
                  <div class="fc-card">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">🤫 Szum otoczenia</div>
                    <strong style="font-size: 16px; color: #94a3b8">${app.vadResults.noiseDb} dB</strong>
                  </div>
                  <div class="fc-card">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">🗣️ Średni poziom głosu</div>
                    <strong style="font-size: 16px; color: #38bdf8">${app.vadResults.speechDb} dB</strong>
                  </div>
                </div>

                <div style="margin-top: 10px; padding: 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: var(--fc-radius-sm); text-align: center">
                  <div style="font-size: 11px; color: var(--fc-text-secondary)">Rekomendowany próg aktywacji głosu Discord (VAD):</div>
                  <div style="font-size: 24px; font-weight: 800; color: #fbbf24; margin: 4px 0">${app.vadResults.optimalGateDb} dB</div>
                  <div style="font-size: 10.5px; color: #4ade80">🛡️ Zastosowano bufor bezpieczeństwa -3 dB (zapewnia pełną słyszalność cichych końcówek słów i szeptu).</div>
                </div>
              </div>` : ''}
          </div>

          <div class="modal-footer">
            ${step === 2 ? `<button class="btn btn-ghost btn-sm" id="btn-vad-back">← Wstecz</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="btn-vad-cancel">Anuluj</button>
            ${step === 3 ? `<button class="btn btn-primary btn-sm" id="btn-vad-apply">Zastosuj i zapisz próg ✓</button>` : `<span style="font-size: 11px; color: var(--fc-text-muted)">Krok ${step} z 3</span>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 4: QoL Diagnostics Hub Modal ----------
  /** Modal z raportem z sesji "Wyjście z pokoju" — analiza prędkości, wąskich gardeł i timeline. */
export function renderDiagSessionModal(app: AppUI): string {
    const report = app.diagSessionReport;
    const analysis = report?.analysis;
    const timeline = report?.timeline || [];

    const exitLatency = analysis?.exitLatencySec;
    const ratingClass = analysis?.speedRating || 'moderate';
    const ratingLabel =
      analysis?.speedRating === 'ultra_fast'
        ? '🔥 Błyskawiczna (Wzorowa)'
        : analysis?.speedRating === 'fast'
          ? '⚡ Szybka (Optymalna)'
          : analysis?.speedRating === 'moderate'
            ? '⏱️ Umiarkowana'
            : '⚠️ Opóźniona';

    return `
      <div class="modal-overlay" id="diag-session-overlay">
        <div class="modal-dialog modal-lg" style="max-width: 620px">
          <div class="modal-header">
            <h3>⚡ Raport Testu Wyjścia z Pokoju (Prędkość Przełączania)</h3>
            <button class="close" id="btn-diag-session-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <!-- 1. KARTY BENCHMARKU PRĘDKOŚCI -->
            <div class="diag-benchmark-grid">
              <div class="diag-benchmark-card">
                <div style="font-size: 11px; color: var(--fc-text-secondary)">⚡ Czas do przełączenia</div>
                <div class="diag-benchmark-val ${ratingClass}">
                  ${exitLatency !== null && exitLatency !== undefined ? `${exitLatency} s` : '—'}
                </div>
                <div style="font-size: 10px; color: var(--fc-text-muted); margin-top: 2px">${ratingLabel}</div>
              </div>

              <div class="diag-benchmark-card">
                <div style="font-size: 11px; color: var(--fc-text-secondary)">🛣️ Wybrana ścieżka</div>
                <div style="font-size: 12.5px; font-weight: 700; color: #fff; margin-top: 4px; line-height: 1.3">
                  ${analysis?.pathTaken === 'geometric_fast' ? '⚡ Geometria (outOfGateCut)' : analysis?.pathTaken === 'seat_abandoned' ? '🚀 Błyskawiczne wyjście (Seat Loss)' : analysis?.pathTaken === 'dropout_protection' ? '⏱️ Ochrona dropoutu radaru' : analysis?.pathTaken === 'input_held' ? '⌨️ Utrzymanie wejściem' : '⏱️ Standardowy timeout'}
                </div>
                <div style="font-size: 10px; color: var(--fc-text-muted); margin-top: 2px">
                  ${analysis?.pathTaken === 'geometric_fast' ? 'Skrócony timer 100–250 ms' : analysis?.pathTaken === 'seat_abandoned' ? 'Zanik biometrii + strefy' : analysis?.pathTaken === 'dropout_protection' ? 'Bio-hold' : 'Timeout bazowy'}
                </div>
              </div>

              <div class="diag-benchmark-card">
                <div style="font-size: 11px; color: var(--fc-text-secondary)">🎙️ Windows CoreAudio</div>
                <div style="font-size: 14px; font-weight: 700; color: #4ade80; margin-top: 4px">
                  ${analysis?.audioSwitchLatencyMs !== null && analysis?.audioSwitchLatencyMs !== undefined ? `${analysis.audioSwitchLatencyMs} ms` : '—'}
                </div>
                <div style="font-size: 10px; color: var(--fc-text-muted); margin-top: 2px">AudioSwitcher daemon</div>
              </div>
            </div>

            <!-- 2. WĄSKIE GARDŁA & REKOMENDACJE -->
            <div style="margin-bottom: 12px; padding: 10px 12px; background: ${analysis?.bottlenecks && analysis.bottlenecks.length > 0 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(34, 197, 94, 0.08)'}; border: 1px solid ${analysis?.bottlenecks && analysis.bottlenecks.length > 0 ? 'rgba(245, 158, 11, 0.35)' : 'rgba(34, 197, 94, 0.25)'}; border-radius: var(--fc-radius-sm)">
              <strong style="font-size: 12px; color: ${analysis?.bottlenecks && analysis.bottlenecks.length > 0 ? '#fbbf24' : '#4ade80'}; display: block; margin-bottom: 4px">
                ${analysis?.bottlenecks && analysis.bottlenecks.length > 0 ? '🔍 Diagnoza wąskich gardeł prędkości:' : '✅ Wzorowa konfiguracja przełączania:'}
              </strong>
              ${analysis?.bottlenecks && analysis.bottlenecks.length > 0 ? `
                <ul style="margin: 0 0 6px 16px; padding: 0; font-size: 11px; color: var(--fc-text-secondary); line-height: 1.4">
                  ${analysis.bottlenecks.map((b: string) => `<li>${esc(b)}</li>`).join('')}
                </ul>
              ` : ''}
              ${analysis?.recommendations && analysis.recommendations.length > 0 ? `
                <div style="font-size: 11px; color: #f1f5f9; line-height: 1.4">
                  ${analysis.recommendations.map((r: string) => `<div>👉 <strong>${esc(r)}</strong></div>`).join('')}
                </div>
              ` : ''}
            </div>

            <!-- 3. PRECYZYJNA OŚ CZASU (TIMELINE) -->
            ${timeline.length > 0 ? `
              <div style="font-size: 11px; font-weight: 600; color: var(--fc-text-secondary); margin-bottom: 4px; display: flex; justify-content: space-between">
                <span>⏱️ Precyzyjna Oś Czasu (Timeline zdarzeń):</span>
                <span style="color: var(--fc-text-muted)">${timeline.length} zdarzeń</span>
              </div>
              <div class="diag-timeline-box" style="margin-bottom: 12px">
                ${timeline.map((ev: DiagSessionTimelineItem) => `
                  <div class="diag-timeline-row">
                    <span class="diag-timeline-time">+${(ev.offsetMs / 1000).toFixed(2)}s</span>
                    <span class="diag-timeline-cat ${ev.category.toLowerCase()}">${ev.category}</span>
                    <span style="color: #cbd5e1">${esc(ev.message)}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <!-- 4. SUROWE LOGI -->
            <details style="font-size: 11px; color: var(--fc-text-muted)">
              <summary style="cursor: pointer; padding: 4px 0; color: var(--fc-text-secondary)">📋 Pokaż pełny tekst raportu i surowe logi</summary>
              <pre class="fc-diag-session-log" style="margin-top: 6px; max-height: 140px">${esc(app.diagSessionText)}</pre>
            </details>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-diag-session-cancel">Zamknij</button>
            <button class="btn btn-secondary btn-sm" id="btn-diag-session-notepad" title="Otwórz raport w Notatniku Windows">📝 Notatnik</button>
            <button class="btn btn-primary btn-sm" id="btn-diag-session-copy" title="Skopiuj pełny raport do schowka (dla AI / programisty)">🤖 Kopiuj dla AI</button>
          </div>
        </div>
      </div>
    `;
  }

export function renderDiagModal(app: AppUI): string {
    return `
      <div class="modal-overlay" id="diag-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>🩺 Pełna Diagnostyka Systemu DeskSense</h3>
            <button class="close" id="btn-diag-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="fc-diag-grid">
              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>📡 Sensor mmWave</span> <span class="fc-badge ${app.snap?.radar.connected || app.snap?.ha?.connected ? 'calibrated' : 'amber'}">${app.snap?.radar.connected ? 'USB ✓' : (app.snap?.ha?.connected ? 'HAOS ✓' : 'Brak')}</span></div>
                <div class="fc-diag-item-val">Port: ${esc(app.form?.port || 'auto')}${app.snap?.radar.port && app.form?.port === 'auto' ? ` → ${esc(app.snap.radar.port)}` : ''}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Auto-wykrywanie po VID/PID (Seeed XIAO ESP32-C6, m.in. 0x303A:0x1001)</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🎙️ AudioSwitcher.exe</span> <span class="fc-badge ${app.audioDevices.length > 0 ? 'calibrated' : 'amber'}">${app.audioDevices.length > 0 ? 'Odpowiada ✓' : 'Brak urządzeń'}</span></div>
                <div class="fc-diag-item-val">Liczba urządzeń: ${app.audioDevices.length}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">CoreAudio daemon (stdin/stdout) + IPolicyConfig (COM)</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🎮 Discord RPC</span> <span class="fc-badge ${app.form?.discordIntegration ? 'blue' : 'muted'}">${app.form?.discordIntegration ? 'Włączony' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val"><strong id="discord-rpc-status-val" style="color: var(--fc-text-dim)">…</strong></div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Lokalne RPC przez named pipe Discorda</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🌈 SignalRGB API</span> <span class="fc-badge ${app.form?.signalrgbEnabled ? 'amber' : 'muted'}">${app.form?.signalrgbEnabled ? 'Włączony' : 'Wyłączony'}</span></div>
                <div class="fc-diag-item-val">Port: ${app.form?.signalrgbPort ?? 16038}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Lokalne REST API SignalRGB</span>
              </div>

              <div class="fc-diag-item">
                <div class="fc-diag-item-title"><span>🏠 Home Assistant (HAOS)</span> <span class="fc-badge ${app.snap?.ha?.connected ? 'calibrated' : (app.form?.haEnabled ? 'amber' : 'muted')}">${app.snap?.ha?.connected ? 'Połączony ✓' : (app.form?.haEnabled ? 'Łączenie…' : 'Wyłączony')}</span></div>
                <div class="fc-diag-item-val">${app.form?.haEnabled ? esc(app.form.haUrl || 'http://homeassistant.local:8123') : 'Wyłączona integracja'}</div>
                <span style="font-size: 10.5px; color: var(--fc-text-muted)">Encja: ${app.form?.haPresenceEntity ? esc(app.form.haPresenceEntity) : 'brak wybranej'}</span>
              </div>
            </div>

            <div style="margin-top: 12px; padding: 10px; background: var(--fc-bg-darker); border-radius: var(--fc-radius-sm); font-size: 11.5px; color: var(--fc-text-secondary)">
              <strong>💡 Wskazówka:</strong> Powyżej konfiguracja i dostępność modułów. Live logi znajdziesz w zakładce „Logi”, a do diagnozy przełączania użyj sesji „Wyjście z pokoju” (przycisk w nagłówku).
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn btn-ghost btn-sm" id="btn-diag-cancel">Zamknij</button>
          </div>
        </div>
      </div>
    `;
  }

  /** Start/stop sesji diagnostycznej; stop otwiera modal z zebranymi logami. */
export async function toggleDiagSession(app: AppUI): Promise<void> {
    if (!app.diagActive) {
      await window.api.diagStart();
      app.diagActive = true;
      app.pushToast('Sesja diagnostyczna rozpoczęta — nagrajmy, co się dzieje po wyjściu…');
      updateHeaderAndLiveDOM(app);
      return;
    }

    const report = await window.api.diagStop();
    app.diagActive = false;
    updateHeaderAndLiveDOM(app);
    if (!report) {
      app.pushToast('Brak aktywnej sesji diagnostycznej', true);
      return;
    }
    app.diagSessionReport = report;
    app.diagSessionText = report.text;
    app.diagReportModalOpen = true;
    app.render();
  }

  // ---------- Firmware Flasher Assistant ----------
export async function openFlasherModal(app: AppUI): Promise<void> {
  app.flasherModalOpen = true;
  app.flasherLoading = false;
  app.flasherLogs = ['[DeskSense Flasher] Gotowość do pracy. Sprawdzam środowisko systemowe...'];
  app.flasherSuccess = null;
  app.flasherSelectedPort = app.form?.port && app.form.port !== 'auto' ? app.form.port : (app.ports[0]?.path || '');
  app.render();

  try {
    const deps = await window.api.flasherCheckDeps();
    app.flasherDeps = deps;
    if (deps.esptool) {
      app.flasherLogs.push(`✓ Wykryto narzędzie esptool (${deps.pythonCmd})`);
    } else {
      app.flasherLogs.push('⚠️ Brak esptool. Zainstaluj w terminalu: pip install esptool');
    }
    if (deps.arduinoCli) {
      app.flasherLogs.push(`✓ Wykryto kompilator arduino-cli`);
    }
    app.render();
  } catch (e) {
    app.flasherLogs.push(`❌ Błąd sprawdzania narzędzi: ${(e as Error).message}`);
    app.render();
  }
}

export function closeFlasherModal(app: AppUI): void {
  if (app.flasherLoading) {
    void window.api.flasherCancel();
  }
  app.flasherModalOpen = false;
  app.render();
}

export function renderFlasherModal(app: AppUI): string {
  const deps = app.flasherDeps;
  const isFlashing = app.flasherLoading;

  return `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-flasher-title">
      <div class="modal-card" style="max-width: 680px; width: 95%;">
        <div class="modal-header">
          <div class="modal-title" id="modal-flasher-title" style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">⚡</span>
            <span>Wgrywanie Firmware (XIAO ESP32-C6 mmWave)</span>
          </div>
          <button class="modal-close" id="btn-flasher-close" ${isFlashing ? 'disabled' : ''} aria-label="Zamknij modal">✕</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 14px; max-height: 70vh; overflow-y: auto;">
          <!-- Krok 1: Weryfikacja środowiska -->
          <div class="fc-settings-group" style="padding: 12px; margin: 0;">
            <div style="font-size: 12.5px; font-weight: 700; color: #fff; margin-bottom: 6px;">1. Stan Narzędzi & Zależności</div>
            <div class="fc-diag-grid" style="grid-template-columns: 1fr 1fr; gap: 8px;">
              <div class="fc-diag-item" style="padding: 8px 10px;">
                <div class="fc-diag-item-title"><span>🐍 Python + esptool (.bin)</span></div>
                <div class="fc-diag-item-val" style="font-size: 13px;">
                  <span class="fc-badge ${deps?.esptool ? 'calibrated' : 'amber'}">
                    ${deps?.esptool ? 'Gotowy do wgrywania ✓' : (deps?.python ? 'Wymagane: pip install esptool' : 'Brak Pythona w PATH')}
                  </span>
                </div>
              </div>
              <div class="fc-diag-item" style="padding: 8px 10px;">
                <div class="fc-diag-item-title"><span>🛠️ Arduino CLI (.ino)</span></div>
                <div class="fc-diag-item-val" style="font-size: 13px;">
                  <span class="fc-badge ${deps?.arduinoCli ? 'calibrated' : 'muted'}">
                    ${deps?.arduinoCli ? 'Kompilator dostępny ✓' : 'Opcjonalny (dla plików .ino)'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Krok 2: Wybór pliku firmware -->
          <div class="fc-settings-group" style="padding: 12px; margin: 0;">
            <div style="font-size: 12.5px; font-weight: 700; color: #fff; margin-bottom: 6px;">2. Wybierz Plik Wsadu do Wgrania</div>
            
            <!-- Gotowe szablony -->
            ${deps?.stockFiles && deps.stockFiles.length > 0 ? `
              <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;">
                <span class="fc-micro-label">Dołączone gotowe wsady DeskSense:</span>
                ${deps.stockFiles.map((sf) => `
                  <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: rgba(13, 17, 23, 0.7); border: 1px solid ${app.flasherSelectedFile === sf.path ? 'var(--fc-accent-blue)' : 'var(--fc-card-border)'}; border-radius: 6px; cursor: pointer;" class="flasher-stock-pick" data-path="${esc(sf.path)}" data-name="${esc(sf.name)}">
                    <div>
                      <div style="font-size: 12px; font-weight: 600; color: #fff;">${esc(sf.name)}</div>
                      <div style="font-size: 10.5px; color: var(--fc-text-secondary);">${esc(sf.description)}</div>
                    </div>
                    <button class="btn btn-ghost btn-sm" style="font-size: 11px; padding: 2px 8px; pointer-events: none;">${app.flasherSelectedFile === sf.path ? 'Wybrany ✓' : 'Wybierz'}</button>
                  </div>
                `).join('')}
              </div>
            ` : ''}

            <!-- Przycisk własnego pliku -->
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 4px;">
              <button class="btn btn-secondary btn-sm" id="btn-flasher-browse" ${isFlashing ? 'disabled' : ''}>
                📁 Wybierz własny plik z dysku (.bin / .ino)…
              </button>
              <div style="font-size: 11.5px; color: var(--fc-accent-blue); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px;">
                ${app.flasherSelectedFileName ? `Wybrano: <strong>${esc(app.flasherSelectedFileName)}</strong>` : 'Nie wybrano pliku'}
              </div>
            </div>
          </div>

          <!-- Krok 3: Port COM & Parametry -->
          <div class="fc-settings-group" style="padding: 12px; margin: 0;">
            <div style="font-size: 12.5px; font-weight: 700; color: #fff; margin-bottom: 6px;">3. Port COM Mikrokontrolera</div>
            <div style="display: flex; gap: 10px; align-items: center;">
              <select class="fc-select" id="sel-flasher-port" ${isFlashing ? 'disabled' : ''} style="flex: 1;">
                <option value="">— Wybierz port COM do wgrania —</option>
                ${app.ports.map((p) => `<option value="${esc(p.path)}" ${p.path === app.flasherSelectedPort ? 'selected' : ''}>${esc(p.path)}${p.manufacturer ? ` · ${esc(p.manufacturer)}` : ''}</option>`).join('')}
              </select>
            </div>
          </div>

          <!-- Live Console Output -->
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span class="fc-micro-label">Konsola operacji flashowania:</span>
              ${isFlashing ? '<span style="font-size: 11px; color: #fbbf24; font-weight: 600;">⚡ Wgrywanie w toku…</span>' : ''}
            </div>
            <div id="flasher-console" style="background: #0d1117; border: 1px solid var(--fc-card-border); border-radius: var(--fc-radius-sm); padding: 10px; height: 160px; overflow-y: auto; font-family: monospace; font-size: 11px; line-height: 1.4; color: #38bdf8; white-space: pre-wrap; word-break: break-all;">
              ${app.flasherLogs.map(l => esc(l)).join('\n')}
            </div>
          </div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-ghost btn-sm" id="btn-flasher-cancel" ${isFlashing ? 'disabled' : ''}>Zamknij</button>
          <div style="display: flex; gap: 8px;">
            ${isFlashing ? `
              <button class="btn btn-secondary btn-sm" id="btn-flasher-abort" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.4);">⛔ Przerwij</button>
            ` : `
              <button class="btn btn-primary btn-sm" id="btn-flasher-start" ${!app.flasherSelectedFile || !app.flasherSelectedPort ? 'disabled' : ''} style="font-weight: 700; padding: 6px 14px;">
                ⚡ Rozpocznij Wgrywanie (Flash)
              </button>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}
