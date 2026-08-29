// Modale: kalibracja VAD, wizard kalibracji radaru, sesja diagnostyczna, diag telemetrii

import type { AppUI } from './app';
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
    app.save();
  }

  // Wizard Methods
export function openCalibrationWizard(app: AppUI) {
    app.wizardOpen = true;
    app.wizardStep = 1;
    app.wizardCountdown = 0;
    app.wizardWarning = '';
    if (app.wizardInterval) clearInterval(app.wizardInterval);
    app.wizardInterval = null;
    app.render();
  }

export function closeCalibrationWizard(app: AppUI) {
    app.wizardOpen = false;
    if (app.wizardInterval) clearInterval(app.wizardInterval);
    app.wizardInterval = null;
    app.render();
  }

export function runWizardStep1(app: AppUI) {
    app.wizardCountdown = 5;
    app.wizardWarning = '';
    app.wizardPresenceSeen = false;
    app.render();
    app.wizardInterval = setInterval(() => {
      app.wizardCountdown--;
      if (app.telemetry.presence === true) app.wizardPresenceSeen = true;
      if (app.wizardCountdown <= 0) {
        clearInterval(app.wizardInterval);
        app.wizardInterval = null;
        if (app.wizardPresenceSeen) {
          // Uczciwa walidacja: kalibracja pustego fotela nie ma sensu, gdy radar
          // wciąż widzi człowieka — blokujemy krok zamiast udawać sukces.
          app.wizardWarning = 'Radar nadal wykrywa obecność przy biurku — odsuń się dalej od sensora (2–3 m) i rozpocznij pomiar ponownie.';
          app.render();
          return;
        }
        playChime('desk', 0.2, app.selectedChimeStyle);
        app.wizardStep = 2;
      }
      app.render();
    }, 1000);
  }

export function runWizardStep2(app: AppUI) {
    app.wizardCountdown = 6;
    app.wizardSamples.distances = [];
    if (app.telemetry.distanceCm) app.wizardSamples.distances.push(app.telemetry.distanceCm);
    app.render();

    app.wizardInterval = setInterval(() => {
      app.wizardCountdown--;
      if (app.wizardCountdown <= 0) {
        clearInterval(app.wizardInterval);
        app.wizardInterval = null;

        const validDistances = app.wizardSamples.distances.filter((d) => d >= 30 && d <= 180);
        const avgDist = validDistances.length > 0
          ? Math.round(validDistances.reduce((a, b) => a + b, 0) / validDistances.length)
          : (app.telemetry.distanceCm || 75);

        app.wizardResults.distance = avgDist;
        app.wizardResults.gateMin = Math.max(30, avgDist - 25);
        app.wizardResults.gateMax = Math.min(200, avgDist + 35);

        playChime('desk', 0.2, app.selectedChimeStyle);
        app.wizardStep = 3;
      }
      app.render();
    }, 1000);
  }

export function applyWizardCalibration(app: AppUI) {
    app.patchForm({
      radarDistanceGateEnabled: true,
      radarMinDistanceCm: app.wizardResults.gateMin,
      radarMaxDistanceCm: app.wizardResults.gateMax,
      petFilterEnabled: true
    });

    closeCalibrationWizard(app);
    app.save();
    app.pushToast('Kalibracja sensora zakończona i zapisana ✓');
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

  // ---------- MODAL 1: Wizard Kalibracji Radaru ----------
export function renderWizardModal(app: AppUI): string {
    const step = app.wizardStep;
    const count = app.wizardCountdown;

    return `
      <div class="modal-overlay" id="wizard-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>✨ Kreator Kalibracji Sensora (Krok ${step} z 3)</h3>
            <button class="close" id="btn-wizard-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div class="wizard-steps">
              <div class="wizard-step-dot ${step >= 1 ? (step === 1 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 2 ? (step === 2 ? 'active' : 'done') : ''}"></div>
              <div class="wizard-step-dot ${step >= 3 ? 'done' : ''}"></div>
            </div>

            ${app.wizardWarning ? `
              <div class="update-banner" style="border-color: rgba(239, 68, 68, 0.6); background: rgba(239, 68, 68, 0.12); margin-bottom: 12px">
                <div class="update-banner-icon" style="background: #ef4444">⚠️</div>
                <div class="update-banner-content">
                  <strong style="color: #fca5a5">Uwaga kalibracji</strong>
                  <p style="color: #fecaca; margin: 0">${esc(app.wizardWarning)}</p>
                </div>
              </div>
            ` : ''}

            ${step === 1 ? `
              <div>
                <div class="wizard-icon-hero">🪑</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 1: Weryfikacja pustego fotela</h4>
                <p class="wizard-instruction">
                  Odejdź od biurka na 2–3 metry lub wyjdź z zasięgu radaru.<br/>
                  Aplikacja sprawdzi, czy radar widzi już pusty fotel — dopiero wtedy przejdziemy do pomiaru pozycji siedzenia.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Skanowanie otoczenia…</strong>
                      <span>${count} s</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((5 - count) / 5) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-step-1" style="width: 100%">Rozpocznij skanowanie tła (5s)</button>`}
                </div>
              </div>` : ''}

            ${step === 2 ? `
              <div>
                <div class="wizard-icon-hero">🧘</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Krok 2: Pozycja w fotelu (Bramka zasięgu)</h4>
                <p class="wizard-instruction">
                  Usiądź wygodnie w fotelu w swojej naturalnej pozycji do pracy lub grania.<br/>
                  Radar ustali Twoją strefę fotela i odetnie wszystko za Twoim oparciem.
                </p>
                <div style="margin-top: 16px">
                  ${count > 0 ? `
                    <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px">
                      <strong>Mierzenie dystansu klatki piersiowej…</strong>
                      <span>${count} s (${app.telemetry.distanceCm ? app.telemetry.distanceCm + ' cm' : 'namierzanie…'})</span>
                    </div>
                    <div class="wizard-meter"><div class="wizard-meter-fill" style="width: ${((6 - count) / 6) * 100}%"></div></div>
                  ` : `<button class="btn btn-primary" id="btn-run-step-2" style="width: 100%">Rozpocznij pomiar pozycji fotela (6s)</button>`}
                </div>
              </div>` : ''}

            ${step === 3 ? `
              <div>
                <div class="wizard-icon-hero">🎉</div>
                <h4 style="text-align: center; font-size: 14px; font-weight: 600; margin-bottom: 6px">Kalibracja zakończona sukcesem!</h4>
                <div style="margin-top: 12px">
                  <div class="fc-card" style="text-align: center">
                    <div style="font-size: 11px; color: var(--fc-text-secondary)">📏 Strefa fotela</div>
                    <strong style="font-size: 16px; color: var(--fc-accent-green)">${app.wizardResults.distance} cm</strong>
                    <span style="font-size: 10px; color: var(--fc-text-muted)">Bramka: ${app.wizardResults.gateMin}–${app.wizardResults.gateMax} cm</span>
                  </div>
                </div>
              </div>` : ''}
          </div>

          <div class="modal-footer">
            ${step > 1 && step < 3 ? `<button class="btn btn-ghost btn-sm" id="btn-wizard-back">← Wstecz</button>` : ''}
            <button class="btn btn-ghost btn-sm" id="btn-wizard-cancel">Anuluj</button>
            ${step === 3 ? `<button class="btn btn-primary btn-sm" id="btn-wizard-apply">Zastosuj i zapisz kalibrację ✓</button>` : `<span style="font-size: 11px; color: var(--fc-text-muted)">Krok ${step} z 3</span>`}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- MODAL 4: QoL Diagnostics Hub Modal ----------
  /** Modal z logami zebranej sesji "Wyjście z pokoju" (kopiuj AI / notatnik). */
export function renderDiagSessionModal(app: AppUI): string {
    const lines = app.diagSessionText.split('\n').length;
    return `
      <div class="modal-overlay" id="diag-session-overlay">
        <div class="modal-dialog modal-lg">
          <div class="modal-header">
            <h3>🧪 Sesja diagnostyczna — raport "Wyjście z pokoju"</h3>
            <button class="close" id="btn-diag-session-close" title="Zamknij">✕</button>
          </div>

          <div class="modal-body">
            <div style="font-size: 11.5px; color: var(--fc-text-secondary); margin-bottom: 8px">
              Zebrano <strong>${lines}</strong> linii logów od momentu kliknięcia „Wyjście z pokoju”.
              Prześlij raport przy zgłaszaniu problemu z wykrywaniem nieobecności.
            </div>
            <pre class="fc-diag-session-log">${esc(app.diagSessionText)}</pre>
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
    app.diagSessionText = report.text;
    app.diagReportModalOpen = true;
    app.render();
  }
