import { appendLog, getLogs } from './logger';

/**
 * Sesja diagnostyczna "Wyjście z pokoju": użytkownik klika przycisk wychodząc,
 * aplikacja znacznikiem w ring bufferze wycina wszystkie logi od tego momentu.
 * Po powrocie drugi klik zwraca wycinek do modala (AI / notatnik).
 * Stan żyje w main process — przeżywa ponowne otwarcie okna ustawień.
 */

let sessionMarker: string | null = null;
let sessionStartedAt = 0;

export function isDiagSessionActive(): boolean {
  return sessionMarker !== null;
}

export function diagSessionStartedAt(): number {
  return sessionStartedAt;
}

export function startDiagSession(): void {
  sessionStartedAt = Date.now();
  sessionMarker = `DIAG-SESSION-${sessionStartedAt}`;
  appendLog('DIAG', `${sessionMarker} === START SESJI: test wyjścia z pokoju ===`);
}

export interface DiagSessionResult {
  startedAt: number;
  endedAt: number;
  logs: string[];
}

export function stopDiagSession(): DiagSessionResult | null {
  if (!sessionMarker) return null;
  const marker = sessionMarker;
  const startedAt = sessionStartedAt;
  sessionMarker = null;

  appendLog('DIAG', `${marker} === KONIEC SESJI ===`);

  // Wycinek od ostatniego wystąpienia markera (buffer mógł się zwinąć o 1000
  // najstarszych linii, ale marker startowy sesji jest zawsze młodszy).
  const all = getLogs();
  const idx = all.lastIndexOf(marker);
  const logs = idx >= 0 ? all.slice(idx) : all;

  return { startedAt, endedAt: Date.now(), logs };
}
