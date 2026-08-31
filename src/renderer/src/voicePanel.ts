import { esc } from './ui';
import type { AppUI } from './app';
import type { VoiceRule, VoiceModelType, VoiceEngineType, VoiceWhisperModel, VoiceWhisperBackend, VoiceStatus } from './global';
import { haDomainBadge } from './integrationsPanels';

/** Sprawdza gotowość aktualnie wybranego w formularzu modelu i backendu */
export function isSelectedVoiceModelReady(ui: AppUI): boolean {
  const form = ui.form;
  const voiceStatus = ui.snap?.voice;
  if (!form || !voiceStatus) return false;
  const engine = (form.voiceEngine || 'whisper') as VoiceEngineType;
  if (engine === 'whisper') {
    const model = (form.voiceWhisperModel || 'whisper-base') as VoiceWhisperModel;
    const backend = (form.voiceWhisperBackend || 'auto') as VoiceWhisperBackend;
    const isModelDownloaded = Boolean(voiceStatus.installedModels?.whisper?.[model]);
    const resolvedBackend = backend === 'auto'
      ? (voiceStatus.gpuVendor === 'nvidia' ? (voiceStatus.detectedGpu?.includes('10') ? 'cuda11' : 'cuda12') : 'cpu_blas')
      : backend;
    const isBackendDownloaded = Boolean(voiceStatus.installedBackends?.[resolvedBackend] || voiceStatus.installedBackends?.[backend]);
    return isModelDownloaded && isBackendDownloaded;
  } else {
    const model = (form.voiceModel || 'pl-small') as VoiceModelType;
    if (model === 'custom') return Boolean(form.voiceCustomModelPath);
    return Boolean(voiceStatus.installedModels?.vosk?.[model]);
  }
}

export function renderVoiceTab(ui: AppUI): string {
  const form = ui.form;
  if (!form) return '<div class="fc-settings-panel"><p style="color: var(--fc-text-muted)">Ładowanie konfiguracji…</p></div>';

  const voiceEnabled = form.voiceEnabled ?? false;
  const voiceEngine = (form.voiceEngine || 'whisper') as VoiceEngineType;
  const voiceWhisperModel = (form.voiceWhisperModel || 'whisper-base') as VoiceWhisperModel;
  const voiceWhisperBackend = (form.voiceWhisperBackend || 'auto') as VoiceWhisperBackend;
  const voiceModel = (form.voiceModel || 'pl-small') as VoiceModelType;
  const voiceRequireWakeWord = form.voiceRequireWakeWord ?? true;
  const voiceOnlyAtDesk = form.voiceOnlyAtDesk ?? true;
  const voiceChime = form.voiceChimeFeedback ?? true;
  const rules = form.voiceRules || [];
  const voiceStatus = ui.snap?.voice;
  const detectedGpu = voiceStatus?.detectedGpu || '';
  const isModelReady = isSelectedVoiceModelReady(ui) || (voiceStatus?.modelReady ?? false);
  const wakePrefix = voiceRequireWakeWord ? (form.voiceWakeWord || 'ok').toUpperCase() : '';

  return `
    <div class="fc-settings-panel">
      <!-- Grupa 1: Główny Status & Silnik Mowy -->
      <div class="fc-settings-group">
        <div class="fc-settings-group-title">🎙️ Sterowanie Głosem (Komendy Offline)</div>

        <div class="fc-field-row">
          <div>
            <div class="fc-field-label">Włącz sterowanie głosem offline</div>
            <div class="fc-field-desc">W 100% lokalny silnik mowy AI. Zero chmury, brak opóźnień i ochrona prywatności.</div>
          </div>
          <button class="fc-switch ${voiceEnabled ? 'active' : ''}" id="sw-voice-enabled" aria-checked="${voiceEnabled}" role="switch"></button>
        </div>

        ${
          voiceEnabled
            ? `<div id="voice-status-block">${renderVoiceLiveStatus(ui)}</div>`
            : ''
        }
      </div>

      <!-- Grupa 2: Silnik, Model i Akceleracja Sprzętowa -->
      <div class="fc-settings-group">
        <div class="fc-settings-group-title">🧠 Silnik, Model i Akceleracja Sprzętowa</div>

        <!-- Wybór Silnika Mowy: Whisper vs Vosk -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
          <div class="fc-card-selectable ${voiceEngine === 'whisper' ? 'selected' : ''}" id="btn-engine-whisper" style="cursor: pointer; padding: 10px 12px; border: 1px solid ${voiceEngine === 'whisper' ? '#38bdf8' : 'rgba(255,255,255,0.08)'}; border-radius: 8px; background: ${voiceEngine === 'whisper' ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.02)'}; transition: all 0.15s ease;">
            <div style="font-weight: 700; font-size: 12px; color: ${voiceEngine === 'whisper' ? '#38bdf8' : 'var(--fc-text-primary)'}; margin-bottom: 2px;">
              🧠 OpenAI Whisper AI <span class="fc-badge calibrated" style="font-size: 9px; padding: 1px 4px;">Zalecany</span>
            </div>
            <div style="font-size: 11px; color: var(--fc-text-secondary); line-height: 1.3;">
              Wysoka inteligencja. Bezbłędne rozumienie każdego polskiego słowa i odmian gramatycznych.
            </div>
          </div>

          <div class="fc-card-selectable ${voiceEngine === 'vosk' ? 'selected' : ''}" id="btn-engine-vosk" style="cursor: pointer; padding: 10px 12px; border: 1px solid ${voiceEngine === 'vosk' ? '#38bdf8' : 'rgba(255,255,255,0.08)'}; border-radius: 8px; background: ${voiceEngine === 'vosk' ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.02)'}; transition: all 0.15s ease;">
            <div style="font-weight: 700; font-size: 12px; color: ${voiceEngine === 'vosk' ? '#38bdf8' : 'var(--fc-text-primary)'}; margin-bottom: 2px;">
              🚀 Vosk Fast (~45 MB)
            </div>
            <div style="font-size: 11px; color: var(--fc-text-secondary); line-height: 1.3;">
              Lekki streaming słowo po słowie, minimalne zużycie pamięci RAM.
            </div>
          </div>
        </div>

        <!-- Selektory Modeli -->
        <div id="row-whisper-model" style="display: ${voiceEngine === 'whisper' ? 'block' : 'none'};">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label class="fc-micro-label">Wybrany model OpenAI Whisper:</label>
            <span class="fc-badge ${isModelReady ? 'calibrated' : 'warning'}" id="badge-whisper-model-ready">
              ${isModelReady ? 'Zainstalowany ✓' : 'Wymaga pobrania'}
            </span>
          </div>
          <select class="fc-select" id="sel-whisper-model" style="width: 100%">
            <option value="whisper-base" ${voiceWhisperModel === 'whisper-base' ? 'selected' : ''}>🇵🇱 OpenAI Whisper Base (~148 MB - Zalecany) ${voiceStatus?.installedModels?.whisper?.['whisper-base'] ? '✓ Pobrany' : '⬇️ Wymaga pobrania'}</option>
            <option value="whisper-tiny" ${voiceWhisperModel === 'whisper-tiny' ? 'selected' : ''}>⚡ OpenAI Whisper Tiny (~77 MB - Najszybszy) ${voiceStatus?.installedModels?.whisper?.['whisper-tiny'] ? '✓ Pobrany' : '⬇️ Wymaga pobrania'}</option>
            <option value="whisper-small" ${voiceWhisperModel === 'whisper-small' ? 'selected' : ''}>🎓 OpenAI Whisper Small (~460 MB - Studyjna jakość) ${voiceStatus?.installedModels?.whisper?.['whisper-small'] ? '✓ Pobrany' : '⬇️ Wymaga pobrania'}</option>
            <option value="whisper-large-turbo" ${voiceWhisperModel === 'whisper-large-turbo' ? 'selected' : ''}>🏆 OpenAI Whisper Large v3 Turbo (~1.5 GB - Najlepszy polski, wymaga GPU NVIDIA) ${voiceStatus?.installedModels?.whisper?.['whisper-large-turbo'] ? '✓ Pobrany' : '⬇️ Wymaga pobrania'}</option>
          </select>

          <!-- Akceleracja Sprzętowa (GPU / CPU) -->
          <div id="row-whisper-backend" style="margin-top: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <label class="fc-micro-label">Akceleracja sprzętowa (GPU / CPU):</label>
              ${detectedGpu ? `<span style="font-size: 10.5px; color: #38bdf8; font-weight: 500;">🎮 ${esc(detectedGpu)}</span>` : ''}
            </div>
            <select class="fc-select" id="sel-whisper-backend" style="width: 100%">
              ${renderBackendOptions(voiceStatus, voiceWhisperBackend)}
            </select>
            <div id="voice-backend-hint">${renderBackendHint(voiceWhisperBackend, voiceStatus)}</div>
            ${voiceWhisperBackend !== 'auto' && voiceStatus?.installedBackends?.[voiceWhisperBackend] ? `<div style="margin-top: 6px;"><button class="btn btn-danger btn-sm" id="btn-delete-voice-backend" style="font-size: 11px;">🗑️ Usuń pakiet backendu (${esc(voiceWhisperBackend)})</button></div>` : ''}
          </div>

          <div class="fc-field-row" style="margin-top: 10px;">
            <div>
              <div class="fc-field-label">Zwolnij model z pamięci po bezczynności</div>
              <div class="fc-field-desc">Minuty bez komend, po których Whisper zwalnia RAM/VRAM. 0 = model zawsze w pamięci. Pierwsza komenda po przerwie ładuje model (~2 s).</div>
            </div>
            <input type="number" class="fc-input" id="inp-voice-idle-min" value="${esc(String(form.voiceIdleUnloadMin ?? 2))}" min="0" max="60" style="width: 70px; text-align: center;" title="Minuty" />
          </div>
        </div>

        <div id="row-vosk-model" style="display: ${voiceEngine === 'vosk' ? 'block' : 'none'};">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label class="fc-micro-label">Wybrany model Vosk:</label>
            <span class="fc-badge ${isModelReady ? 'calibrated' : 'warning'}" id="badge-vosk-model-ready">
              ${isModelReady ? 'Zainstalowany ✓' : 'Wymaga pobrania'}
            </span>
          </div>
          <select class="fc-select" id="sel-voice-model" style="width: 100%">
            <option value="pl-small" ${voiceModel === 'pl-small' ? 'selected' : ''}>🇵🇱 Polski lekki (Vosk Small PL ~45 MB) ${voiceStatus?.installedModels?.vosk?.['pl-small'] ? '✓ Pobrany' : '⬇️ Wymaga pobrania'}</option>
            <option value="en-small" ${voiceModel === 'en-small' ? 'selected' : ''}>🇬🇧 Angielski lekki (Vosk Small EN ~40 MB) ${voiceStatus?.installedModels?.vosk?.['en-small'] ? '✓ Pobrany' : '⬇️ Wymaga pobrania'}</option>
            <option value="custom" ${voiceModel === 'custom' ? 'selected' : ''}>📁 Własny folder modelu Vosk na dysku…</option>
          </select>
        </div>

        <div id="row-vosk-custom-path" style="display: ${voiceEngine === 'vosk' && voiceModel === 'custom' ? 'block' : 'none'}; margin-top: 8px;">
          <label class="fc-micro-label">Ścieżka do folderu z modelem Vosk:</label>
          <div style="display: flex; gap: 6px; margin-top: 4px">
            <input type="text" class="fc-input" id="inp-voice-custom-path" value="${esc(form.voiceCustomModelPath || '')}" placeholder="C:\\sciezka\\do\\modelu" style="flex: 1" />
            <button class="btn btn-secondary btn-sm" id="btn-pick-custom-model">Przeglądaj…</button>
          </div>
        </div>

        <!-- Stan pobierania / Status modelu -->
        <div style="margin-top: 10px" id="voice-download-section">
          ${renderVoiceDownloadSection(ui)}
        </div>
      </div>

      <!-- Grupa 3: Słowo Wywołania & Zabezpieczenia -->
      <div class="fc-settings-group">
        <div class="fc-settings-group-title">🛡️ Słowo Wywołania & Zabezpieczenia</div>

        <div class="fc-field-row">
          <div>
            <div class="fc-field-label">Wymagaj słowa wywołania (Wake Word)</div>
            <div class="fc-field-desc">Komendy działają wyłącznie po potwierdzonym słowie wywołania (ochrona przed przypadkową mową). Wyłączenie pozwala na natychmiastowe komendy bezpośrednie.</div>
          </div>
          <button class="fc-switch ${voiceRequireWakeWord ? 'active' : ''}" id="sw-voice-require-wake" aria-checked="${voiceRequireWakeWord}" role="switch"></button>
        </div>

        <div class="fc-field-row" id="row-voice-wake-word" style="display: ${voiceRequireWakeWord ? 'flex' : 'none'};">
          <div>
            <div class="fc-field-label">Słowo wywołujące (Wake Word)</div>
            <div class="fc-field-desc">Wybudza nasłuch na 4,5 s, np. <em>„OK wycisz mikrofon”</em> lub samo <em>„OK”</em>. Działa również <em>„DeskSense”</em>.</div>
          </div>
          <input type="text" class="fc-input" id="inp-voice-wake-word" value="${esc(form.voiceWakeWord || 'ok')}" maxlength="24" style="width: 90px; text-align: center; font-weight: 700; color: #38bdf8; height: 26px;" title="Słowo wywołujące nasłuch" />
        </div>

        <div class="fc-field-row">
          <div>
            <div class="fc-field-label">Aktywne tylko przy biurku (Radar DESK)</div>
            <div class="fc-field-desc">Blokuje komendy, gdy odejdziesz od biurka (brak fałszywych wywołań np. z TV lub rozmów w pokoju)</div>
          </div>
          <button class="fc-switch ${voiceOnlyAtDesk ? 'active' : ''}" id="sw-voice-only-desk" aria-checked="${voiceOnlyAtDesk}" role="switch"></button>
        </div>

        <div class="fc-field-row">
          <div>
            <div class="fc-field-label">Dźwięk potwierdzenia (Chime)</div>
            <div class="fc-field-desc">Odtwarza subtelny dźwięk po wykryciu słowa wywołania oraz po pomyślnym wykonaniu akcji</div>
          </div>
          <button class="fc-switch ${voiceChime ? 'active' : ''}" id="sw-voice-chime" aria-checked="${voiceChime}" role="switch"></button>
        </div>
      </div>

      <!-- Grupa 4: Twoje Własne Komendy -->
      <div class="fc-settings-group">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div class="fc-settings-group-title" style="margin-bottom: 0">⚡ Twoje Własne Komendy (${rules.length})</div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-sm" id="btn-open-voice-calibrator">🔴 Nagraj / Sprawdź wymowę</button>
            <button class="btn btn-primary btn-sm" id="btn-add-voice-rule">+ Dodaj komendę</button>
          </div>
        </div>

        <div class="fc-voice-rules-stack">
          ${
            rules.length === 0
              ? `
            <div style="padding: 24px 16px; text-align: center; color: var(--fc-text-muted); font-size: 12px; border: 1px dashed var(--fc-card-border); border-radius: var(--fc-radius-sm)">
              Brak zdefiniowanych komend. Kliknij <strong>„+ Dodaj komendę”</strong>, aby utworzyć pierwszą akcję.
            </div>
          `
              : rules.map((r, i) => renderVoiceRuleCard(r, i, wakePrefix, ui)).join('')
          }
        </div>
      </div>
    </div>
  `;
}

/** Krótka etykieta trybu Auto zależna od wykrytego GPU */
function renderAutoBackendHint(vendor?: string): string {
  if (vendor === 'nvidia') return 'NVIDIA CUDA';
  if (vendor === 'amd') return 'CPU OpenBLAS (AMD)';
  if (vendor === 'intel') return 'CPU OpenBLAS (Intel)';
  return 'Zalecany';
}

/** Opcje selektora akceleracji — lista wykrytych kart + CPU + Auto */
function renderBackendOptions(voiceStatus: VoiceStatus | undefined, selected: VoiceWhisperBackend): string {
  const gpus = voiceStatus?.gpus || [];
  const installed = voiceStatus?.installedBackends || {};
  const opts: string[] = [];

  opts.push(`<option value="auto" ${selected === 'auto' ? 'selected' : ''}>🪄 Automatyczny (${esc(renderAutoBackendHint(voiceStatus?.gpuVendor))})</option>`);

  for (const gpu of gpus) {
    const isNvidia = /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(gpu);
    if (isNvidia) {
      const legacy = /\b(gtx|geforce gtx)\s*(9\d\d|10\d\d)\b/.test(gpu);
      const val = legacy ? 'cuda11' : 'cuda12';
      opts.push(`<option value="${val}" ${selected === val ? 'selected' : ''}>🚀 ${esc(gpu)} (GPU CUDA) ${installed[val] ? '✓ Zainstalowany' : '⬇️ Wymaga pobrania'}</option>`);
    } else {
      // AMD / Intel / inne — brak akceleracji GPU w whisper.cpp (opcja tylko informacyjna)
      opts.push(`<option value="cpu_blas" disabled>🔴 ${esc(gpu)} — brak akceleracji GPU (CPU)</option>`);
    }
  }

  // Fallback: wybrany backend CUDA, ale nie wykryto NVIDIA (migracja configu / eGPU)
  if ((selected === 'cuda12' || selected === 'cuda11') && !gpus.some((g) => /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(g))) {
    opts.push(`<option value="${selected}" selected>🚀 NVIDIA GPU (${selected === 'cuda12' ? 'CUDA 12.x' : 'CUDA 11.8'}) ${installed[selected] ? '✓ Zainstalowany' : '⬇️ Wymaga pobrania'}</option>`);
  }

  opts.push(`<option value="cpu_blas" ${selected === 'cpu_blas' ? 'selected' : ''}>⚡ CPU Wielowątkowy (OpenBLAS — AMD Ryzen / Intel Core) ${installed['cpu_blas'] ? '✓ Zainstalowany' : '⬇️ Wymaga pobrania (20 MB)'}</option>`);
  opts.push(`<option value="cpu" ${selected === 'cpu' ? 'selected' : ''}>🍃 CPU Standard (Lekki pakiet) ${installed['cpu'] ? '✓ Zainstalowany' : '⬇️ Wymaga pobrania (8 MB)'}</option>`);
  opts.push(`<option value="hip" disabled ${selected === 'hip' ? 'selected' : ''}>🔴 AMD GPU (ROCm/HIP) — pakiet w przygotowaniu</option>`);

  return opts.join('');
}

/** Notka kontekstowa pod selektorem — pokazuje opcje dostępne dla wybranego backendu */
export function renderBackendHint(selected: VoiceWhisperBackend, voiceStatus?: VoiceStatus): string {
  const vendor = voiceStatus?.gpuVendor;
  const detectedGpu = voiceStatus?.detectedGpu || '';
  const hint = (text: string, color = 'var(--fc-text-muted)') => `<div style="font-size: 10.5px; color: ${color}; margin-top: 6px;">${text}</div>`;

  if (selected === 'auto') {
    if (vendor === 'nvidia') {
      return hint('Automatycznie użyje dedykowanej karty NVIDIA (CUDA) — nic nie musisz ustawiać. GPU niedostępne? Przełączy się na CPU OpenBLAS.');
    }
    if (vendor === 'amd' || vendor === 'intel') {
      return hint('Brak akceleracji GPU dla tej karty — automatycznie wybrany CPU OpenBLAS (AVX2/AVX-512).');
    }
    return hint('Automatycznie dobierze najszybszy dostępny backend.');
  }

  if (selected === 'cuda12' || selected === 'cuda11') {
    if (/\brtx\s*50\d\d\b/i.test(detectedGpu)) {
      return hint('Karta RTX 50xx (Blackwell) wymaga cuBLAS 12.8+, którego whisper.cpp nie wydaje — wybierz CPU OpenBLAS.', '#f59e0b');
    }
    return hint('Akceleracja GPU (CUDA) — błyskawiczna odpowiedź. Runtime wbudowany, wymagany tylko sterownik NVIDIA. W razie problemów wybierz CPU.');
  }

  if (selected === 'cpu_blas' || selected === 'cpu') {
    return hint('Obliczenia na procesorze — CPU OpenBLAS (wielowątkowy) lub CPU standard (lekki).');
  }

  return '';
}

export interface VoiceHaPayloadParsed {
  entity_id: string;
  service?: string;
  brightness?: number;
  color?: string;
  temperature?: number;
}

export function parseVoiceHaPayload(raw?: string): VoiceHaPayloadParsed {
  if (!raw || !raw.trim()) {
    return { entity_id: '' };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        entity_id: String(parsed.entity_id || '').trim(),
        service: parsed.service ? String(parsed.service).trim() : undefined,
        brightness: parsed.brightness !== undefined ? Number(parsed.brightness) : (parsed.brightness_pct !== undefined ? Number(parsed.brightness_pct) : undefined),
        color: parsed.color ? String(parsed.color) : undefined,
        temperature: parsed.temperature !== undefined ? Number(parsed.temperature) : undefined
      };
    } catch {
      return { entity_id: trimmed };
    }
  }
  return { entity_id: trimmed };
}

export function stringifyVoiceHaPayload(data: VoiceHaPayloadParsed): string {
  if (!data.entity_id) return '';
  const domain = data.entity_id.split('.')[0];
  const service = data.service || (domain === 'light' ? 'turn_on' : domain === 'scene' || domain === 'script' ? 'turn_on' : domain === 'automation' ? 'trigger' : domain === 'button' || domain === 'input_button' ? 'press' : 'toggle');

  const payload: Record<string, unknown> = {
    entity_id: data.entity_id,
    service
  };

  if (domain === 'light') {
    if (service === 'turn_on' || service === 'toggle') {
      if (data.brightness !== undefined && data.brightness > 0) {
        payload.brightness = data.brightness;
      }
      if (data.color && data.color !== 'none') {
        payload.color = data.color;
      }
    }
  } else if (domain === 'climate') {
    if (data.temperature !== undefined) {
      payload.temperature = data.temperature;
    }
  }

  return JSON.stringify(payload);
}

function renderHaPayloadInput(rule: VoiceRule, index: number, ui?: AppUI): string {
  const cfg = parseVoiceHaPayload(rule.actionPayload);
  const found = cfg.entity_id ? ui?.haCatalog?.find((e) => e.entity_id === cfg.entity_id) : null;
  const domain = cfg.entity_id ? cfg.entity_id.split('.')[0] : '';
  const service = cfg.service || (domain === 'light' ? 'turn_on' : domain === 'scene' || domain === 'script' ? 'turn_on' : domain === 'automation' ? 'trigger' : domain === 'button' || domain === 'input_button' ? 'press' : 'toggle');

  if (!cfg.entity_id) {
    return `
      <div style="flex: 2; min-width: 260px;">
        <label class="fc-micro-label">Urządzenie / Encja Home Assistant:</label>
        <div style="display: flex; gap: 6px;">
          <button type="button" class="fc-input btn-open-ha-rule-picker" data-index="${index}"
            style="flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; cursor: pointer; height: 28px; font-size: 11px; padding: 0 10px; background: var(--fc-card-bg); border-style: dashed;">
            <span style="color: var(--fc-text-muted)">🔍 Wybierz urządzenie / encję…</span>
            <span style="color: var(--fc-accent-blue); font-size: 10px;">Otwórz picker ▾</span>
          </button>
        </div>
      </div>
    `;
  }

  // Mamy wybraną encję/urządzenie
  const entityLabel = found?.name || cfg.entity_id;
  const deviceLabel = found?.deviceName ? `<span style="font-size: 10px; color: var(--fc-text-muted); margin-left: 4px;">(${esc(found.deviceName)})</span>` : '';
  const isLight = domain === 'light';
  const isSwitch = domain === 'switch' || domain === 'input_boolean';
  const isScene = domain === 'scene';
  const isScript = domain === 'script';
  const isAutomation = domain === 'automation';
  const isButton = domain === 'button' || domain === 'input_button';
  const isMedia = domain === 'media_player';
  const isCover = domain === 'cover';
  const isClimate = domain === 'climate';

  // Opcje akcji dla danego typu urządzenia
  let serviceOptionsHtml = '';
  if (isLight) {
    serviceOptionsHtml = `
      <option value="turn_on" ${service === 'turn_on' ? 'selected' : ''}>💡 Włącz światło</option>
      <option value="turn_off" ${service === 'turn_off' ? 'selected' : ''}>🌑 Wyłącz światło</option>
      <option value="toggle" ${service === 'toggle' ? 'selected' : ''}>🔄 Przełącz (włącz / wyłącz)</option>
    `;
  } else if (isSwitch) {
    serviceOptionsHtml = `
      <option value="toggle" ${service === 'toggle' ? 'selected' : ''}>🔄 Przełącz stan</option>
      <option value="turn_on" ${service === 'turn_on' ? 'selected' : ''}>⚡ Włącz</option>
      <option value="turn_off" ${service === 'turn_off' ? 'selected' : ''}>🔌 Wyłącz</option>
    `;
  } else if (isScene) {
    serviceOptionsHtml = `<option value="turn_on" selected>🎬 Aktywuj scenę</option>`;
  } else if (isScript) {
    serviceOptionsHtml = `<option value="turn_on" selected>▶️ Uruchom skrypt</option>`;
  } else if (isAutomation) {
    serviceOptionsHtml = `
      <option value="trigger" ${service === 'trigger' ? 'selected' : ''}>⚡ Wyzwól (trigger)</option>
      <option value="turn_on" ${service === 'turn_on' ? 'selected' : ''}>✓ Włącz automatyzację</option>
      <option value="turn_off" ${service === 'turn_off' ? 'selected' : ''}>✕ Wyłącz automatyzację</option>
    `;
  } else if (isButton) {
    serviceOptionsHtml = `<option value="press" selected>🔘 Wciśnij przycisk</option>`;
  } else if (isMedia) {
    serviceOptionsHtml = `
      <option value="media_play_pause" ${service === 'media_play_pause' ? 'selected' : ''}>⏯️ Play / Pause</option>
      <option value="volume_up" ${service === 'volume_up' ? 'selected' : ''}>🔊 Głośniej</option>
      <option value="volume_down" ${service === 'volume_down' ? 'selected' : ''}>🔉 Ciszej</option>
      <option value="volume_mute" ${service === 'volume_mute' ? 'selected' : ''}>🔇 Mute toggle</option>
      <option value="media_next_track" ${service === 'media_next_track' ? 'selected' : ''}>⏭️ Następny utwór</option>
      <option value="turn_off" ${service === 'turn_off' ? 'selected' : ''}>🌑 Wyłącz</option>
    `;
  } else if (isCover) {
    serviceOptionsHtml = `
      <option value="open_cover" ${service === 'open_cover' ? 'selected' : ''}>🔼 Otwórz</option>
      <option value="close_cover" ${service === 'close_cover' ? 'selected' : ''}>🔽 Zamknij</option>
      <option value="stop_cover" ${service === 'stop_cover' ? 'selected' : ''}>⏹️ Zatrzymaj</option>
      <option value="toggle" ${service === 'toggle' ? 'selected' : ''}>🔄 Przełącz</option>
    `;
  } else if (isClimate) {
    serviceOptionsHtml = `
      <option value="set_temperature" ${service === 'set_temperature' ? 'selected' : ''}>🌡️ Ustaw temperaturę</option>
      <option value="turn_on" ${service === 'turn_on' ? 'selected' : ''}>⚡ Włącz</option>
      <option value="turn_off" ${service === 'turn_off' ? 'selected' : ''}>🌑 Wyłącz</option>
    `;
  } else {
    serviceOptionsHtml = `
      <option value="${esc(service)}" selected>${esc(service)}</option>
      <option value="toggle">toggle</option>
      <option value="turn_on">turn_on</option>
      <option value="turn_off">turn_off</option>
    `;
  }

  // Parametry światła (jasność + kolor) — proste, przejrzyste opcje
  const showLightControls = isLight && (service === 'turn_on' || service === 'toggle');
  const brightness = cfg.brightness !== undefined ? cfg.brightness : 100;
  const hasBrightness = cfg.brightness !== undefined;
  const activeColor = cfg.color || '';

  const lightControlsHtml = showLightControls ? `
    <div style="margin-top: 8px; padding: 8px 10px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--fc-card-border); border-radius: var(--fc-radius-sm); display: flex; flex-direction: column; gap: 8px;">
      <!-- Jasność -->
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fc-text-secondary);">
          <span>☀️ Jasność:</span>
          <strong style="color: var(--fc-text-primary);" id="ha-rule-bri-val-${index}">${hasBrightness ? `${brightness}%` : 'Domyślna'}</strong>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="range" min="5" max="100" step="5" value="${brightness}" class="fc-rule-ha-brightness-slider" data-index="${index}" style="width: 110px; cursor: pointer;" title="Ustaw jasność" />
          <div style="display: flex; gap: 3px;">
            <button type="button" class="fc-log-chip ${brightness === 25 && hasBrightness ? 'active' : ''} btn-ha-rule-bri" data-index="${index}" data-bri="25" style="padding: 1px 5px; font-size: 10px;">25%</button>
            <button type="button" class="fc-log-chip ${brightness === 50 && hasBrightness ? 'active' : ''} btn-ha-rule-bri" data-index="${index}" data-bri="50" style="padding: 1px 5px; font-size: 10px;">50%</button>
            <button type="button" class="fc-log-chip ${brightness === 100 && hasBrightness ? 'active' : ''} btn-ha-rule-bri" data-index="${index}" data-bri="100" style="padding: 1px 5px; font-size: 10px;">100%</button>
            <button type="button" class="fc-log-chip ${!hasBrightness ? 'active' : ''} btn-ha-rule-bri" data-index="${index}" data-bri="none" title="Bez zmiany jasności" style="padding: 1px 5px; font-size: 10px;">Auto</button>
          </div>
        </div>
      </div>

      <!-- Kolor światła -->
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 6px;">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fc-text-secondary);">
          <span>🎨 Kolor:</span>
          ${activeColor && activeColor !== 'none' ? `<span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${esc(activeColor)}; border: 1px solid rgba(255,255,255,0.4);"></span>` : '<span style="font-size: 10px; color: var(--fc-text-muted);">Domyślny</span>'}
        </div>
        <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#ef4444' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#ef4444" title="Czerwony" style="background: #ef4444;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#f97316' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#f97316" title="Pomarańczowy" style="background: #f97316;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#eab308' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#eab308" title="Żółty" style="background: #eab308;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#22c55e' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#22c55e" title="Zielony" style="background: #22c55e;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#38bdf8' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#38bdf8" title="Niebieski" style="background: #38bdf8;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#a855f7' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#a855f7" title="Fioletowy" style="background: #a855f7;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#ffb74d' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#ffb74d" title="Ciepła biel" style="background: #ffb74d;"></button>
          <button type="button" class="fc-rule-ha-color-dot ${activeColor === '#ffffff' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="#ffffff" title="Zimna biel" style="background: #ffffff;"></button>
          <label class="fc-rule-ha-color-picker-label" title="Własny kolor (Color Picker)">
            <input type="color" class="fc-rule-ha-color-input" data-index="${index}" value="${activeColor && activeColor !== 'none' ? activeColor : '#ffffff'}" />
            <span>🎨</span>
          </label>
          <button type="button" class="fc-log-chip ${!activeColor || activeColor === 'none' ? 'active' : ''} btn-ha-rule-color" data-index="${index}" data-color="none" title="Bez zmiany koloru" style="padding: 1px 5px; font-size: 10px;">Bez koloru</button>
        </div>
      </div>
    </div>
  ` : '';

  return `
    <div style="flex: 2.2; min-width: 280px; display: flex; flex-direction: column; gap: 4px;">
      <label class="fc-micro-label">Urządzenie & Akcja Home Assistant:</label>
      
      <div style="display: flex; gap: 6px; align-items: center;">
        <!-- Karta wybranego urządzenia -->
        <button type="button" class="fc-input btn-open-ha-rule-picker" data-index="${index}"
          title="Kliknij, aby zmienić wybrane urządzenie"
          style="flex: 1.3; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 6px; text-align: left; cursor: pointer; height: 28px; font-size: 11px; padding: 0 8px; background: var(--fc-card-bg);">
          <span style="display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden;">
            <span class="fc-badge ${haDomainBadge(domain)}" style="flex-shrink: 0; font-size: 9.5px; padding: 1px 4px;">${esc(domain)}</span>
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;">${esc(entityLabel)}</span>
            ${deviceLabel}
          </span>
          <span style="color: var(--fc-text-muted); font-size: 10px; flex-shrink: 0;">Zmień ▾</span>
        </button>

        <!-- Dropdown akcji -->
        <select class="fc-select sel-ha-rule-service" data-index="${index}" style="flex: 1; height: 28px; font-size: 11px; padding: 2px 6px;">
          ${serviceOptionsHtml}
        </select>

        <!-- Przycisk usunięcia encji -->
        <button type="button" class="btn btn-ghost btn-sm btn-clear-ha-rule" data-index="${index}" title="Wyczyść urządzenie" style="font-size: 10px; padding: 4px 6px;">✕</button>
      </div>

      ${lightControlsHtml}
    </div>
  `;
}

function renderVoiceRuleCard(rule: VoiceRule, index: number, wakeWordPrefix: string, ui?: AppUI): string {
  return `
    <div class="fc-voice-rule-card ${rule.enabled ? '' : 'disabled'}" data-rule-index="${index}">
      <div class="fc-voice-rule-head">
        <div style="display: flex; align-items: center; gap: 8px;">
          <button class="fc-switch ${rule.enabled ? 'active' : ''} rule-enable-switch" data-index="${index}" style="transform: scale(0.85); transform-origin: left center;" role="switch" title="Włącz / wyłącz komendę"></button>
          <input type="text" class="fc-input rule-name-input" data-index="${index}" value="${esc(rule.name)}" placeholder="Nazwa komendy…" style="font-weight: 600; width: 200px; font-size: 11.5px; height: 26px; padding: 2px 8px;" />
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-ghost btn-sm btn-test-voice-rule" data-index="${index}" title="Przetestuj wykonanie tej akcji">▶ Testuj</button>
          <button class="btn btn-danger btn-sm btn-delete-voice-rule" data-index="${index}" title="Usuń komendę">🗑️</button>
        </div>
      </div>

      <div class="fc-voice-rule-grid">
        <div style="flex: 1.2; min-width: 200px;">
          <label class="fc-micro-label">Fraza wywołująca (co mówisz):</label>
          <div class="fc-voice-phrase-wrapper">
            <span class="fc-voice-phrase-prefix">${wakeWordPrefix ? `„${esc(wakeWordPrefix)}…”` : '„…'}</span>
            <input type="text" class="fc-input rule-phrase-input" data-index="${index}" value="${esc(rule.phrase)}" placeholder="np. przełącz na słuchawki" />
          </div>
        </div>

        <div style="flex: 1.2; min-width: 180px;">
          <label class="fc-micro-label">Akcja do wykonania:</label>
          <select class="fc-select rule-action-select" data-index="${index}" style="width: 100%">
            <optgroup label="🎙️ DeskSense & Audio">
              <option value="switch_desk" ${rule.actionType === 'switch_desk' ? 'selected' : ''}>Przełącz na mikrofon biurkowy</option>
              <option value="switch_headset" ${rule.actionType === 'switch_headset' ? 'selected' : ''}>Przełącz na słuchawki</option>
              <option value="switch_auto" ${rule.actionType === 'switch_auto' ? 'selected' : ''}>Włącz tryb automatyczny (Radar)</option>
              <option value="toggle_mute" ${rule.actionType === 'toggle_mute' ? 'selected' : ''}>Wycisz / Odcisz mikrofon</option>
              <option value="mute" ${rule.actionType === 'mute' ? 'selected' : ''}>Wycisz mikrofon</option>
              <option value="unmute" ${rule.actionType === 'unmute' ? 'selected' : ''}>Odcisz mikrofon</option>
            </optgroup>
            <optgroup label="🖥️ Ekran & System">
              <option value="sleep_display" ${rule.actionType === 'sleep_display' ? 'selected' : ''}>Uśpij monitory (Zgaś ekrany)</option>
              <option value="screensaver" ${rule.actionType === 'screensaver' ? 'selected' : ''}>Włącz czarny wygaszacz</option>
              <option value="snooze" ${rule.actionType === 'snooze' ? 'selected' : ''}>Drzemka obecności (Pauza)</option>
            </optgroup>
            <optgroup label="🚀 Aplikacje & Skrypty">
              <option value="run_app" ${rule.actionType === 'run_app' ? 'selected' : ''}>Uruchom program (.exe / .bat / skrót)</option>
              <option value="kill_process" ${rule.actionType === 'kill_process' ? 'selected' : ''}>Zamknij aplikację / proces (.exe)</option>
              <option value="shell_cmd" ${rule.actionType === 'shell_cmd' ? 'selected' : ''}>Polecenie PowerShell / CMD</option>
              <option value="open_url" ${rule.actionType === 'open_url' ? 'selected' : ''}>Otwórz stronę WWW / link</option>
            </optgroup>
            <optgroup label="🏠 Home Assistant">
              <option value="ha_service" ${rule.actionType === 'ha_service' ? 'selected' : ''}>Wywołaj urządzenie / encję HA</option>
            </optgroup>
          </select>
        </div>

        ${renderPayloadInput(rule, index, ui)}
      </div>
    </div>
  `;
}

function renderPayloadInput(rule: VoiceRule, index: number, ui?: AppUI): string {
  const t = rule.actionType;
  if (t === 'run_app') {
    return `
      <div style="flex: 1.5; min-width: 220px;">
        <label class="fc-micro-label">Ścieżka do pliku programu:</label>
        <div style="display: flex; gap: 4px;">
          <input type="text" class="fc-input rule-payload-input" data-index="${index}" value="${esc(rule.actionPayload || '')}" placeholder="C:\\Program Files\\...\\app.exe" style="flex: 1;" />
          <button type="button" class="btn btn-secondary btn-sm btn-pick-rule-app" data-index="${index}">Wybierz…</button>
        </div>
      </div>
    `;
  }
  if (t === 'kill_process') {
    return `
      <div style="flex: 1.2; min-width: 180px;">
        <label class="fc-micro-label">Nazwa procesu do zamknięcia:</label>
        <input type="text" class="fc-input rule-payload-input" data-index="${index}" value="${esc(rule.actionPayload || '')}" placeholder="np. Spotify.exe lub Discord.exe" style="width: 100%;" />
      </div>
    `;
  }
  if (t === 'shell_cmd') {
    return `
      <div style="flex: 1.5; min-width: 200px;">
        <label class="fc-micro-label">Polecenie PowerShell / CMD:</label>
        <input type="text" class="fc-input rule-payload-input" data-index="${index}" value="${esc(rule.actionPayload || '')}" placeholder="np. Stop-Process -Name 'calc' -Force" style="width: 100%;" />
      </div>
    `;
  }
  if (t === 'open_url') {
    return `
      <div style="flex: 1.5; min-width: 200px;">
        <label class="fc-micro-label">Adres URL do otwarcia:</label>
        <input type="text" class="fc-input rule-payload-input" data-index="${index}" value="${esc(rule.actionPayload || '')}" placeholder="https://youtube.com lub spotify:..." style="width: 100%;" />
      </div>
    `;
  }
  if (t === 'ha_service') {
    return renderHaPayloadInput(rule, index, ui);
  }
  if (t === 'snooze') {
    return `
      <div style="flex: 0.8; min-width: 120px;">
        <label class="fc-micro-label">Czas drzemki (minuty):</label>
        <input type="number" class="fc-input rule-payload-input" data-index="${index}" value="${esc(rule.actionPayload || '10')}" min="1" max="180" style="width: 100%;" />
      </div>
    `;
  }
  return '';
}

/** Żywy blok statusu (karta statusu + ostatnio rozpoznana fraza) — odświeżany przez voice:status */
export function renderVoiceLiveStatus(ui: AppUI): string {
  const form = ui.form;
  const voiceStatus = ui.snap?.voice;
  const voiceEngine = (form?.voiceEngine || 'whisper') as VoiceEngineType;
  const voiceWhisperModel = (form?.voiceWhisperModel || 'whisper-base') as VoiceWhisperModel;
  const voiceModel = (form?.voiceModel || 'pl-small') as VoiceModelType;
  const isDownloading = voiceStatus?.state === 'downloading' || Boolean(ui.voiceDownloadProgress);
  const isLoading = voiceStatus?.state === 'loading';
  const requireWakeWord = form?.voiceRequireWakeWord ?? true;

  const wakeWord = (form?.voiceWakeWord || 'ok').trim() || 'ok';
  const statusTitle = isLoading
    ? '🔄 <strong>Przeładowywanie silnika mowy…</strong>'
    : voiceStatus?.state === 'listening'
      ? '🗣️ <strong>Słucham Twojej komendy…</strong>'
      : voiceStatus?.running
        ? (requireWakeWord
            ? `👂 Czuwanie na słowo: <strong>„${esc(wakeWord)}”</strong> lub <strong>„DeskSense”</strong>`
            : '👂 Nasłuch bezpośredni (komendy bez słowa wywołania)')
        : '⏸️ Nasłuch zatrzymany';
  const statusSub = isLoading
    ? 'Ładuję model i backend do pamięci — potrwa chwilę…'
    : voiceStatus?.running
      ? `Aktywny silnik: <strong>${voiceEngine === 'whisper' ? 'OpenAI Whisper AI' : 'Vosk Fast'}</strong> (${voiceEngine === 'whisper' ? voiceWhisperModel : voiceModel}) · ${voiceEngine === 'whisper' ? (voiceStatus?.modelLoaded === false ? 'model zwolniony (ładuję przy komendzie)' : 'model w pamięci') : 'streaming na żywo'}`
      : 'Włącz nasłuch lub pobierz model, aby aktywować sterowanie';
  const statusBadge = isLoading
    ? '<span class="fc-badge warning" style="font-size: 10px;">Ładowanie…</span>'
    : voiceStatus?.running
      ? '<span class="fc-badge calibrated" style="font-size: 10px;">Gotowy do nasłuchu ✓</span>'
      : isDownloading
        ? '<span class="fc-badge warning" style="font-size: 10px;">Pobieranie…</span>'
        : '<span class="fc-badge muted" style="font-size: 10px;">Nieaktywny</span>';

  return `
    <div class="fc-voice-live-status ${isLoading ? 'loading' : voiceStatus?.state === 'listening' ? 'listening' : voiceStatus?.running ? 'active' : 'idle'}">
      <div class="fc-voice-status-left">
        <span class="fc-voice-indicator-dot"></span>
        <div class="fc-voice-status-info">
          <div class="fc-voice-status-title" id="voice-status-title">${statusTitle}</div>
          <div class="fc-voice-status-sub" id="voice-status-sub">${statusSub}</div>
        </div>
      </div>
      <div class="fc-voice-status-right" id="voice-status-badge">${statusBadge}</div>
    </div>
    ${isLoading ? `<div class="fc-voice-loading-bar" style="margin-top: 8px;"><div class="fc-voice-loading-fill"></div></div>` : ''}
    ${renderVoiceLastHeard(ui)}
  `;
}

/** Ostatnio rozpoznana fraza + wykonana akcja */
function renderVoiceLastHeard(ui: AppUI): string {
  const voiceStatus = ui.snap?.voice;
  if (!voiceStatus?.lastPhrase) return '';
  return `
    <div class="fc-voice-last-heard" style="margin-top: 10px; padding: 8px 12px; background: rgba(56, 189, 248, 0.06); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 6px; font-size: 11.5px; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <span style="color: var(--fc-text-muted)">Ostatnio rozpoznano:</span>
        <strong style="color: #38bdf8; margin-left: 6px;">„${esc(voiceStatus.lastPhrase)}”</strong>
      </div>
      ${voiceStatus.lastAction ? `<span class="fc-badge calibrated" style="font-size: 10px;">${esc(voiceStatus.lastAction)}</span>` : ''}
    </div>
  `;
}

/** Sekcja pobierania modelu (pasek postępu albo karta statusu modelu) */
export function renderVoiceDownloadSection(ui: AppUI): string {
  const form = ui.form;
  const voiceStatus = ui.snap?.voice;
  const voiceEngine = (form?.voiceEngine || 'whisper') as VoiceEngineType;
  const voiceWhisperModel = (form?.voiceWhisperModel || 'whisper-base') as VoiceWhisperModel;
  const voiceWhisperBackend = (form?.voiceWhisperBackend || 'auto') as VoiceWhisperBackend;
  const voiceModel = (form?.voiceModel || 'pl-small') as VoiceModelType;
  const isDownloading = voiceStatus?.state === 'downloading' || Boolean(ui.voiceDownloadProgress);
  const downloadPct = ui.voiceDownloadProgress?.percent ?? voiceStatus?.downloadProgress?.percent ?? 0;
  const downloadSpeed = ui.voiceDownloadProgress?.speed ?? voiceStatus?.downloadProgress?.speed ?? '';
  const isModelReady = isSelectedVoiceModelReady(ui) || (voiceStatus?.modelReady ?? false);

  if (isDownloading) {
    return `
      <div class="fc-voice-progress-box">
        <div class="fc-voice-progress-bar">
          <div class="fc-voice-progress-fill" id="fc-voice-progress-fill" style="width: ${downloadPct}%;"></div>
        </div>
        <div class="fc-voice-progress-meta" id="fc-voice-progress-meta">
          <span>Pobieranie i przygotowanie: <strong>${downloadPct}%</strong></span>
          <span>${esc(downloadSpeed)}</span>
        </div>
        <button class="btn btn-ghost btn-sm" id="btn-cancel-voice-download" style="font-size: 11px; margin-top: 6px; align-self: flex-end;">✕ Anuluj pobieranie</button>
      </div>
    `;
  }

  return `
    <div id="voice-model-status-card" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; background: ${isModelReady ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)'}; border: 1px solid ${isModelReady ? 'rgba(34, 197, 94, 0.25)' : 'rgba(245, 158, 11, 0.3)'};">
      <div style="font-size: 12px; color: ${isModelReady ? '#22c55e' : '#f59e0b'};">
        ${isModelReady ? `<span>✓ Zestaw <strong>${esc(voiceEngine === 'whisper' ? voiceWhisperModel : voiceModel)}</strong> (${esc(voiceEngine === 'whisper' ? voiceWhisperBackend : 'CPU')}) jest zainstalowany i gotowy.</span>` : `<div>⚠️ Wybrana konfiguracja <strong>${esc(voiceEngine === 'whisper' ? voiceWhisperModel : voiceModel)}</strong> wymaga pobrania.</div>`}
      </div>
      <div style="display: flex; gap: 6px; align-items: center;">
        <button class="btn ${isModelReady ? 'btn-ghost' : 'btn-primary'} btn-sm" id="btn-download-voice-model" style="font-size: 11px; white-space: nowrap;">
          ${isModelReady ? '🔄 Pobierz / zaktualizuj' : '⬇️ Pobierz brakujące pliki'}
        </button>
        ${isModelReady ? `<button class="btn btn-danger btn-sm" id="btn-delete-voice-model" style="font-size: 11px; white-space: nowrap;" title="Usuń pobrany model z dysku">🗑️ Usuń model</button>` : ''}
      </div>
    </div>
  `;
}

export function renderVoiceCalibratorModal(_ui: AppUI): string {
  return `
    <div class="modal-overlay" id="modal-voice-calibrator">
      <div class="modal-dialog" style="max-width: 520px;">
        <div class="modal-header">
          <h3 style="display: flex; align-items: center; gap: 8px;">
            <span style="color: #ef4444;">🔴</span> Kalibrator i Nauka Wymowy na Żywo
          </h3>
          <button class="close" id="btn-close-voice-calibrator" title="Zamknij">✕</button>
        </div>

        <div class="modal-body">
          <div style="font-size: 11.5px; color: var(--fc-text-secondary); margin-bottom: 12px; line-height: 1.4;">
            Mów do mikrofonu — poniższy wskaźnik pokazuje na żywo odbierany sygnał audio, a silnik mowy transkrybuje Twój głos w czasie rzeczywistym.
          </div>

          <div class="fc-calibrator-visualizer">
            <div class="fc-waveform-bars" id="voice-waveform-bars">
              <span class="fc-vbar" id="vbar-0"></span><span class="fc-vbar" id="vbar-1"></span><span class="fc-vbar" id="vbar-2"></span>
              <span class="fc-vbar" id="vbar-3"></span><span class="fc-vbar" id="vbar-4"></span><span class="fc-vbar" id="vbar-5"></span>
              <span class="fc-vbar" id="vbar-6"></span><span class="fc-vbar" id="vbar-7"></span><span class="fc-vbar" id="vbar-8"></span>
            </div>

            <!-- Live VU Meter Track -->
            <div style="width: 100%; max-width: 320px; height: 6px; background: rgba(255, 255, 255, 0.08); border-radius: 3px; overflow: hidden; margin: 8px 0;">
              <div id="voice-calibrator-vu-fill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981 0%, #38bdf8 70%, #ef4444 100%); transition: width 0.08s ease-out; border-radius: 3px;"></div>
            </div>

            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; max-width: 320px; font-size: 10.5px; color: var(--fc-text-secondary); margin-bottom: 4px;">
              <span id="voice-calibrator-dev-label">🎙️ <strong id="voice-calibrator-dev" style="color: var(--fc-text-primary);">Wykrywanie…</strong></span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span id="voice-calibrator-vad-badge" style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--fc-text-secondary); transition: all 0.15s ease;">AI VAD: Cisza</span>
                <span id="voice-calibrator-db-badge" style="font-family: monospace; color: #38bdf8;">-60 dB</span>
              </div>
            </div>

            <div class="fc-calibrator-status-text" id="voice-calibrator-status">
              Nasłuch na żywo aktywny… Powiedz coś do mikrofonu!
            </div>
          </div>

          <div class="fc-calibrator-transcript-box">
            <label class="fc-micro-label">Rozpoznana fraza w locie:</label>
            <div class="fc-calibrator-transcript-val" id="voice-calibrator-transcript">
              <em>(Czekam na Twój głos…)</em>
            </div>
          </div>

          <div class="fc-calibrator-tip">
            <strong>💡 Przykładowe zdania testowe:</strong>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
              <code style="background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-size: 11px;">„OK wycisz mikrofon”</code>
              <code style="background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-size: 11px;">„Okej przełącz na słuchawki”</code>
              <code style="background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; color: #38bdf8; font-size: 11px;">„OK zgaś ekrany”</code>
            </div>
          </div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; gap: 8px;">
          <button class="btn btn-ghost btn-sm" id="btn-close-voice-calibrator-2">Zamknij</button>
          <button class="btn btn-primary btn-sm" id="btn-use-recognized-phrase" disabled>
            + Użyj rozpoznanej frazy jako nową komendę
          </button>
        </div>
      </div>
    </div>
  `;
}
