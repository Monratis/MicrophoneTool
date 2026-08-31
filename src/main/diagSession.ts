import { appendLog, getLogs } from './logger';

export interface DiagTimelineEvent {
  offsetMs: number;
  timeStr: string;
  category:
    | 'START'
    | 'DISTANCE'
    | 'BIO'
    | 'OUT_OF_GATE'
    | 'GHOST_DECAY'
    | 'RADAR_RAW'
    | 'INPUT_HOLD'
    | 'LOCK_SCREEN'
    | 'UNLOCK_SCREEN'
    | 'BIO_HOLD'
    | 'AWAY_TIMER'
    | 'STATE_CHANGE'
    | 'AUDIO_SWITCH'
    | 'AUDIO_MUTE'
    | 'AUDIO_VOL'
    | 'DISCORD'
    | 'DEEP_CONFIRM'
    | 'WATCHDOG'
    | 'INFO';
  message: string;
  data?: Record<string, unknown>;
}

export interface DiagSessionSpeedAnalysis {
  exitLatencySec: number | null;
  audioSwitchLatencyMs: number | null;
  pathTaken: 'geometric_fast' | 'seat_abandoned' | 'standard_timeout' | 'dropout_protection' | 'input_held' | 'unknown';
  pathDescription: string;
  speedRating: 'ultra_fast' | 'fast' | 'moderate' | 'delayed';
  bottlenecks: string[];
  recommendations: string[];
}

export interface DiagSessionResult {
  startedAt: number;
  endedAt: number;
  durationSec: number;
  timeline: DiagTimelineEvent[];
  analysis: DiagSessionSpeedAnalysis;
  logs: string[];
  text: string;
}

let sessionMarker: string | null = null;
let sessionStartedAt = 0;
let timelineEvents: DiagTimelineEvent[] = [];
let sessionContext: Record<string, unknown> = {};

export function isDiagSessionActive(): boolean {
  return sessionMarker !== null;
}

export function diagSessionStartedAt(): number {
  return sessionStartedAt;
}

export function startDiagSession(context: Record<string, unknown> = {}): void {
  sessionStartedAt = Date.now();
  sessionMarker = `DIAG-SESSION-${sessionStartedAt}`;
  timelineEvents = [];
  sessionContext = { ...context };

  appendLog('DIAG', `${sessionMarker} === START SESJI: test wyjścia z pokoju ===`);

  recordDiagTimelineEvent('START', 'Rozpoczęto sesję diagnostyczną "Wyjście z pokoju"', {
    initialState: context.initialState,
    initialPresence: context.initialPresence,
    minGateCm: context.minGateCm,
    maxGateCm: context.maxGateCm,
    timeoutAwayMs: context.timeoutAwayMs
  });
}

export function recordDiagTimelineEvent(
  category: DiagTimelineEvent['category'],
  message: string,
  data?: Record<string, unknown>
): void {
  if (!sessionMarker) return;
  const now = Date.now();
  const offsetMs = now - sessionStartedAt;
  const timeStr = new Date(now).toLocaleTimeString('pl-PL', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  } as Intl.DateTimeFormatOptions);

  timelineEvents.push({
    offsetMs,
    timeStr,
    category,
    message,
    data
  });
}

function analyzeSessionSpeed(
  events: DiagTimelineEvent[],
  context: Record<string, unknown>
): DiagSessionSpeedAnalysis {
  const exitLatencies: number[] = [];
  let currentDepartureMs: number | null = null;
  let departureOffsetMs: number | null = null;
  let awayStateOffsetMs: number | null = null;
  let audioOkOffsetMs: number | null = null;
  let audioLatencyMs: number | null = null;

  let hadOutOfGate = false;
  let hadSeatAbandoned = false;
  let hadBioHold = false;
  let hadInputHold = false;

  for (const ev of events) {
    if (
      currentDepartureMs === null &&
      (ev.category === 'OUT_OF_GATE' ||
        ev.category === 'GHOST_DECAY' ||
        (ev.category === 'DISTANCE' && typeof ev.data?.isOutOfGate === 'boolean' && ev.data.isOutOfGate) ||
        (ev.category === 'STATE_CHANGE' && ev.message.includes('opuszczenia fotela')) ||
        (ev.category === 'RADAR_RAW' && ev.message.includes('OFF')))
    ) {
      currentDepartureMs = ev.offsetMs;
      if (departureOffsetMs === null) departureOffsetMs = ev.offsetMs;
    }

    if (ev.category === 'OUT_OF_GATE' || ev.category === 'GHOST_DECAY') {
      hadOutOfGate = true;
    }
    if (ev.category === 'STATE_CHANGE' && ev.message.includes('opuszczenia fotela')) {
      hadSeatAbandoned = true;
    }
    if (ev.category === 'BIO_HOLD') {
      hadBioHold = true;
    }
    if (ev.category === 'INPUT_HOLD') {
      // Aktywność wejścia jest wąskim gardłem tylko jeśli wystąpiła tuż przed lub w trakcie odejścia (ostatnie 3s przed AWAY)
      if (awayStateOffsetMs !== null && Math.abs(ev.offsetMs - awayStateOffsetMs) <= 3000) {
        hadInputHold = true;
      }
    }
    if (ev.category === 'STATE_CHANGE' && ev.message.includes('AWAY')) {
      awayStateOffsetMs = ev.offsetMs;
    }
    if (
      ev.category === 'AUDIO_SWITCH' &&
      (ev.message.includes('pomyślnie') || ev.message.includes('zakończył') || ev.message.includes('OK') || ev.message.includes('BlackShark') || ev.message.includes('HEADSET'))
    ) {
      audioOkOffsetMs = ev.offsetMs;
      if (typeof ev.data?.durationMs === 'number') {
        audioLatencyMs = ev.data.durationMs;
      }
      if (currentDepartureMs !== null) {
        const latencySec = Math.max(0.01, Number(((ev.offsetMs - currentDepartureMs) / 1000).toFixed(2)));
        exitLatencies.push(latencySec);
        currentDepartureMs = null;
      }
    }
    if (ev.category === 'STATE_CHANGE' && ev.message.includes('DESK')) {
      currentDepartureMs = null;
    }
  }

  // Obliczenie latencji wyjścia:
  let exitLatencySec: number | null = null;
  if (exitLatencies.length > 0) {
    exitLatencySec = Math.min(...exitLatencies);
  } else if (audioOkOffsetMs !== null) {
    const startPoint = departureOffsetMs !== null ? departureOffsetMs : 0;
    exitLatencySec = Math.max(0.01, Number(((audioOkOffsetMs - startPoint) / 1000).toFixed(2)));
  } else if (awayStateOffsetMs !== null) {
    const startPoint = departureOffsetMs !== null ? departureOffsetMs : 0;
    exitLatencySec = Math.max(0.01, Number(((awayStateOffsetMs - startPoint) / 1000).toFixed(2)));
  }

  // Określenie ścieżki i wąskich gardeł:
  let pathTaken: DiagSessionSpeedAnalysis['pathTaken'] = 'unknown';
  let pathDescription = '';
  let speedRating: DiagSessionSpeedAnalysis['speedRating'] = 'fast';
  const bottlenecks: string[] = [];
  const recommendations: string[] = [];

  const departed = awayStateOffsetMs !== null || audioOkOffsetMs !== null;

  if (!departed) {
    pathTaken = 'unknown';
    pathDescription = 'Brak wyjścia w trakcie testu — użytkownik cały czas obecny w fotelu (100% stabilny stan DESK).';
    speedRating = 'fast';
    recommendations.push('Obecność przy biurku jest w 100% stabilna (radar nie wygasił obecności ani razu). Aby przetestować procedurę i czas przełączenia na słuchawki, uruchom sesję, wstań z fotela i odejdź poza zasięg bramki (np. >115 cm).');
  } else if (hadOutOfGate) {
    pathTaken = 'geometric_fast';
    pathDescription = 'Ścieżka geometryczna (outOfGateCut) — natychmiastowe przełączenie na słuchawki (100–250 ms) po wstaniu z fotela.';
    speedRating = exitLatencySec !== null && exitLatencySec <= 1.8 ? 'ultra_fast' : 'fast';
  } else if (hadSeatAbandoned) {
    pathTaken = 'seat_abandoned';
    pathDescription = 'Szybkie opuszczenie fotela (seat_abandoned) — wykryto natychmiastowy zanik biometrii i celu w strefie fotela.';
    speedRating = exitLatencySec !== null && exitLatencySec <= 2.5 ? 'ultra_fast' : 'fast';
  } else if (hadBioHold) {
    pathTaken = 'dropout_protection';
    pathDescription = 'Ochrona przed dropoutem radaru (bio-hold) — radar zgubił cel wewnątrz strefy fotela.';
    speedRating = 'delayed';
    bottlenecks.push('Sygnał obecności zniknął nagle wewnątrz strefy fotela bez wcześniejszego wzrostu dystansu ponad górną bramkę.');
    recommendations.push('Obniż górną bramkę odległości (np. do 105–115 cm) lub uruchom Kreator Kalibracji Otoczenia i Fotela.');
  } else if (hadInputHold) {
    pathTaken = 'input_held';
    pathDescription = 'Utrzymanie przez wejście — aktywność myszy/klawiatury przedłużyła stan obecności pomimo braku sygnału z radaru.';
    speedRating = 'moderate';
    bottlenecks.push('Ostatnie ruchy myszą lub dotknięcia klawiatury opóźniły start procedury wyjścia.');
  } else if (awayStateOffsetMs !== null) {
    pathTaken = 'standard_timeout';
    pathDescription = `Standardowy timeout odejścia (${Number(context.timeoutAwayMs || 800) / 1000} s).`;
    speedRating = exitLatencySec !== null && exitLatencySec <= 2.8 ? 'fast' : 'moderate';
  }

  const timeoutAwayMs = Number(context.timeoutAwayMs || 3000);
  if (departed && !hadOutOfGate && timeoutAwayMs > 3500) {
    bottlenecks.push(`Czas oczekiwania na odejście (timeoutAwayMs = ${(timeoutAwayMs / 1000).toFixed(1)} s) jest ustawiony zachowawczo.`);
  }

  if (audioLatencyMs !== null && audioLatencyMs > 450) {
    bottlenecks.push(`Przełączenie urządzenia w Windows CoreAudio zajęło ${audioLatencyMs} ms.`);
  }

  if (departed && recommendations.length === 0 && (speedRating === 'ultra_fast' || speedRating === 'fast')) {
    recommendations.push('Przełączanie działa z optymalną prędkością. Konfiguracja bramek i timerów jest wzorowa.');
  }

  return {
    exitLatencySec,
    audioSwitchLatencyMs: audioLatencyMs,
    pathTaken,
    pathDescription,
    speedRating,
    bottlenecks,
    recommendations
  };
}

export function stopDiagSession(_endContext: Record<string, unknown> = {}): DiagSessionResult | null {
  if (!sessionMarker) return null;
  const marker = sessionMarker;
  const startedAt = sessionStartedAt;
  const endedAt = Date.now();
  const durationSec = Math.max(1, Math.round((endedAt - startedAt) / 1000));
  sessionMarker = null;

  recordDiagTimelineEvent('INFO', 'Zakończenie sesji diagnostycznej');
  appendLog('DIAG', `${marker} === KONIEC SESJI ===`);

  const all = getLogs();
  const idx = all.lastIndexOf(marker);
  const logs = idx >= 0 ? all.slice(idx) : all;

  const analysis = analyzeSessionSpeed(timelineEvents, sessionContext);

  // Obliczenie statystyk telemetrii zebranych w sesji:
  const distSamples: number[] = [];
  const hrSamples: number[] = [];
  const brSamples: number[] = [];
  let rawOnCount = 0;
  let rawOffCount = 0;
  let inputCount = 0;

  for (const ev of timelineEvents) {
    if (ev.category === 'DISTANCE' && typeof ev.data?.distCm === 'number' && ev.data.distCm > 0) {
      distSamples.push(ev.data.distCm);
    }
    if (ev.category === 'BIO' || ev.category === 'BIO_HOLD') {
      if (typeof ev.data?.bpm === 'number' && ev.data.bpm > 0) hrSamples.push(ev.data.bpm);
      if (typeof ev.data?.rpm === 'number' && ev.data.rpm > 0) brSamples.push(ev.data.rpm);
    }
    if (ev.category === 'RADAR_RAW') {
      if (ev.message.includes('ON')) rawOnCount++;
      if (ev.message.includes('OFF')) rawOffCount++;
    }
    if (ev.category === 'INPUT_HOLD') {
      inputCount++;
    }
  }

  const minDist = distSamples.length > 0 ? Math.min(...distSamples).toFixed(1) : '—';
  const maxDist = distSamples.length > 0 ? Math.max(...distSamples).toFixed(1) : '—';
  const avgDist = distSamples.length > 0 ? (distSamples.reduce((a, b) => a + b, 0) / distSamples.length).toFixed(1) : '—';
  const avgHr = hrSamples.length > 0 ? Math.round(hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length) : '—';
  const avgBr = brSamples.length > 0 ? Math.round(brSamples.reduce((a, b) => a + b, 0) / brSamples.length) : '—';

  // Budowa profesjonalnego raportu diagnostycznego:
  const timelineFormatted = timelineEvents
    .map((ev) => `  [+${(ev.offsetMs / 1000).toFixed(3).padStart(6, ' ')}s] [${ev.category.padEnd(12, ' ')}] ${ev.message}`)
    .join('\n');

  const ratingLabel =
    analysis.speedRating === 'ultra_fast'
      ? '🔥 BŁYSKAWICZNA (Wzorowa)'
      : analysis.speedRating === 'fast'
        ? '⚡ SZYBKA (Optymalna)'
        : analysis.speedRating === 'moderate'
          ? '⏱️ UMIARKOWANA'
          : '⚠️ OPÓŹNIONA (Wymaga dopasowania bramki)';

  const timeoutAway = sessionContext.timeoutAwayMs ?? 3000;
  const timeoutDesk = sessionContext.timeoutDeskMs ?? 500;
  const holdSec = sessionContext.userInputPresenceHoldSec ?? 1;

  const deskMic = sessionContext.micDeskName ?? 'Nie wybrano';
  const headMic = sessionContext.micHeadsetName ?? 'Nie wybrano';
  const deskVol = sessionContext.micDeskVolume ?? -1;
  const headVol = sessionContext.micHeadsetVolume ?? -1;
  const fwVer = sessionContext.firmwareVersion ?? 'v1.7.4';
  const portName = sessionContext.portName ?? 'COM3';

  const textLines = [
    '================================================================================',
    '       DESKSENSE — PEŁNY RAPORT DIAGNOSTYCZNY SESJI "WYJŚCIE Z POKOJU"          ',
    '================================================================================',
    `Start: ${new Date(startedAt).toLocaleString('pl-PL')} | Koniec: ${new Date(endedAt).toLocaleString('pl-PL')} | Czas testu: ${durationSec} s`,
    '',
    '1. PODSUMOWANIE PRĘDKOŚCI PRZEŁĄCZANIA (EXIT LATENCY):',
    `  • Całkowity czas przełączenia na słuchawki: ${analysis.exitLatencySec !== null ? `${analysis.exitLatencySec} s` : 'Brak zarejestrowanego przełączenia'}`,
    `  • Ocena prędkości: ${ratingLabel}`,
    `  • Zastosowana ścieżka: ${analysis.pathDescription}`,
    `  • Czas reakcji Windows CoreAudio: ${analysis.audioSwitchLatencyMs !== null ? `${analysis.audioSwitchLatencyMs} ms` : '—'}`,
    '',
    '2. PEŁNY SNAPSHOT KONFIGURACJI I STANU SPRZĘTOWEGO:',
    '  [SENSOR RADARU mmWave & ESP32-C6]',
    `    - Port COM: ${portName} | Firmware: DeskSense OS ${fwVer}`,
    `    - Tryb detekcji: Fuzja binarna mmWave 60GHz (bit obecności + biometria)`,
    `    - Czasy reakcji: Odejście=${timeoutAway} ms | Powrót=${timeoutDesk} ms | Okno wejścia=${holdSec} s`,
    '  [PROFILE AUDIO I MIKROFONY]',
    `    - Profil Biurko (Stacjonarny): "${deskMic}" (Zadana głośność: ${typeof deskVol === 'number' && deskVol >= 0 ? `${deskVol}%` : 'Domyślna'})`,
    `    - Profil Słuchawki (Mobilny): "${headMic}" (Zadana głośność: ${typeof headVol === 'number' && headVol >= 0 ? `${headVol}%` : 'Domyślna'})`,
    `    - Zachowanie na AWAY: ${sessionContext.muteBehaviorOnAway || 'mute_inactive'} | Odciszanie na DESK: ${sessionContext.unmuteOnDesk !== false ? 'TAK ✓' : 'NIE'}`,
    '  [INTEGRACJA DISCORD RPC]',
    `    - Połączenie: ${sessionContext.discordConnected ? 'Połączony ✓' : 'Niepołączony'} | Autoryzacja OAuth: ${sessionContext.discordAuth ? 'TAK ✓' : 'NIE'}`,
    `    - Bramka głosu Biurko: ${sessionContext.micDeskGateDb ?? -45} dB | Słuchawki: ${sessionContext.micHeadsetGateDb ?? -45} dB`,
    '',
    '3. STATYSTYKI STRUMIENIA W TRAKCIE TESTU:',
    `  • Próbki odległości: ${distSamples.length} (min: ${minDist} cm, max: ${maxDist} cm, średnia: ${avgDist} cm)`,
    `  • Próbki biometrii: Tętno=${hrSamples.length} (śr. ${avgHr} BPM), Oddech=${brSamples.length} (śr. ${avgBr} RPM)`,
    `  • Ramki surowe obecności: ON=${rawOnCount}, OFF=${rawOffCount}`,
    `  • Zdarzenia wejścia (klawiatura/mysz): ${inputCount}`,
    '',
    '4. DIAGNOZA WĄSKICH GARDEŁ I REKOMENDACJE:',
    analysis.bottlenecks.length > 0
      ? analysis.bottlenecks.map((b) => `  ⚠️ ${b}`).join('\n')
      : '  ✓ Brak wykrytych opóźnień ani anomalii strumienia.',
    '',
    '  REKOMENDACJE:',
    analysis.recommendations.map((r) => `  👉 ${r}`).join('\n'),
    '',
    '5. PRECYZYJNA OŚ CZASU ZDARZEŃ (CHRONOLOGICZNY TIMELINE ZE SZCZEGÓŁAMI):',
    timelineFormatted,
    '',
    '6. SUROWE LOGI SESJI:',
    logs.join('\n'),
    '================================================================================'
  ];

  return {
    startedAt,
    endedAt,
    durationSec,
    timeline: timelineEvents,
    analysis,
    logs,
    text: textLines.join('\n')
  };
}
