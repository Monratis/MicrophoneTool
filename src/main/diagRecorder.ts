/**
 * Rejestrator surowego strumienia radaru do analizy progów fuzji.
 *
 * Cel: kalibracja z danych, nie "na oko". Rejestruje KAŻDĄ poprawną ramkę
 * (dystans / tętno / oddech / surowy bit obecności) z timestampem — bez
 * throttlingu i bez dedupu, jakie stosuje telemetria UI. Na stopie liczy
 * statystyki, z których wprost czytają się progi firmware (kadencja bio,
 * rozkład drgań dystansu).
 */

export type DiagSampleKind = 'dist' | 'hr' | 'br' | 'presence';

import type { DiagRecordResult } from '../shared/types';

interface DiagSample {
  /** ms od startu nagrania */
  t: number;
  kind: DiagSampleKind;
  value: number;
}

const MAX_SAMPLES = 60000;

let samples: DiagSample[] = [];
let startedAt = 0;
let durationSec = 0;
let active = false;
let stopTimer: NodeJS.Timeout | null = null;

export function recordSample(kind: DiagSampleKind, value: number): void {
  if (!active) return;
  if (samples.length >= MAX_SAMPLES) return;
  samples.push({ t: Date.now() - startedAt, kind, value });
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

function buildResult(): DiagRecordResult {
  const totalSec = (Date.now() - startedAt) / 1000;
  const csvLines = ['t_s,rodzaj,wartosc'];
  for (const s of samples) {
    csvLines.push(`${(s.t / 1000).toFixed(3)},${s.kind},${s.value}`);
  }

  // --- Kadencja biometrii (hr+br łącznie, posortowane po czasie) ---
  const bio = samples.filter((s) => s.kind === 'hr' || s.kind === 'br').map((s) => s.t);
  const bioGaps: number[] = [];
  for (let i = 1; i < bio.length; i++) {
    const gap = bio[i] - bio[i - 1];
    if (gap > 0 && gap <= 10000) bioGaps.push(gap);
  }
  bioGaps.sort((a, b) => a - b);

  // --- Drgania dystansu: |delta| między kolejnymi ramkami (przerwy <= 2 s) ---
  const dist = samples.filter((s) => s.kind === 'dist');
  const distDeltas: number[] = [];
  for (let i = 1; i < dist.length; i++) {
    const gap = dist[i].t - dist[i - 1].t;
    if (gap > 0 && gap <= 2000) {
      distDeltas.push(Math.abs(dist[i].value - dist[i - 1].value));
    }
  }
  distDeltas.sort((a, b) => a - b);

  // --- Surowy bit obecności: czas w ON, liczba przejść ---
  const pres = samples.filter((s) => s.kind === 'presence');
  let onMs = 0;
  let transitions = 0;
  for (let i = 1; i < pres.length; i++) {
    const gap = pres[i].t - pres[i - 1].t;
    if (gap <= 5000) {
      if (pres[i - 1].value === 1) onMs += gap;
      if (pres[i].value !== pres[i - 1].value) transitions++;
    }
  }
  const presOnPct = pres.length > 1 ? Math.round((onMs / Math.max(1, totalSec * 1000)) * 100) : 0;

  const lines: string[] = [];
  lines.push(`Nagranie surowego strumienia radaru — ${totalSec.toFixed(0)} s, ${samples.length} ramek`);
  lines.push('');
  lines.push('BIOMETRIA (dowód zycia w fuzji FW):');
  lines.push(`  ramki bio: ${bio.length} (${bio.length > 0 && totalSec > 0 ? (bio.length / totalSec).toFixed(2) : '0'} Hz)`);
  if (bioGaps.length > 0) {
    lines.push(`  interwal miedzy ramkami: mediana ${(bioGaps[Math.floor(bioGaps.length / 2)] / 1000).toFixed(2)} s, p95 ${(pct(bioGaps, 95) / 1000).toFixed(2)} s, max ${(bioGaps[bioGaps.length - 1] / 1000).toFixed(2)} s`);
    const twoIn10sSafe = pct(bioGaps, 95) < 5000;
    lines.push(`  weryfikacja progu FW "2 ramki / 10 s": ${twoIn10sSafe ? 'BEZPIECZNY (p95 interwalu < 5 s)' : 'RYZYKO — siedzący człowiek może migać OFF; rozważ okno 15 s lub próg 1 ramka'}`);
  }
  lines.push('');
  lines.push('DYSTANS (drgania / próg netto fuzji):');
  lines.push(`  ramki dystansu: ${dist.length} (${dist.length > 0 && totalSec > 0 ? (dist.length / totalSec).toFixed(2) : '0'} Hz)`);
  if (distDeltas.length > 0) {
    lines.push(`  |delta| między ramkami: p50 ${pct(distDeltas, 50).toFixed(2)} cm, p95 ${pct(distDeltas, 95).toFixed(2)} cm, p99 ${pct(distDeltas, 99).toFixed(2)} cm`);
    const jitterShare = Math.round((distDeltas.filter((d) => d >= 2).length / distDeltas.length) * 100);
    lines.push(`  ramki z |delta| >= 2 cm: ${jitterShare}% (stary prog "krok = ruch" — im wyżej, tym latwiej odbiciu udawac ruch)`);
    const netShare = Math.round((distDeltas.filter((d) => d >= 5).length / distDeltas.length) * 100);
    lines.push(`  ramki z |delta| >= 5 cm: ${netShare}% (odniesienie dla progu netto FW)`);
  }
  lines.push('');
  lines.push('SUROWY BIT OBECNOŚCI:');
  lines.push(`  czas w ON: ~${presOnPct}% nagrania, przejścia ON<->OFF: ${transitions}`);

  return {
    active: false,
    durationSec,
    sampleCount: samples.length,
    summary: lines.join('\n'),
    csv: csvLines.join('\n')
  };
}

function stop(): DiagRecordResult {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  const result = buildResult();
  active = false;
  return result;
}

/**
 * Przełącznik nagrywania: pierwsze wywołanie startuje (domyślnie 5 min,
 * auto-stop), kolejne zatrzymuje i zwraca wynik.
 */
export function toggleRecording(durationSecArg = 300): DiagRecordResult {
  if (active) {
    return stop();
  }
  samples = [];
  durationSec = Math.max(30, Math.min(1800, Math.round(durationSecArg)));
  startedAt = Date.now();
  active = true;
  stopTimer = setTimeout(() => {
    stopTimer = null;
    active = false;
  }, durationSec * 1000);
  return { active: true, durationSec, sampleCount: 0, summary: '', csv: '' };
}
