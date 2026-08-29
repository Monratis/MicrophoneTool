export type AutoTuningSpeed = 'balanced' | 'fast' | 'conservative';

import { appendLog } from './logger';

interface Sample {
  distanceCm: number;
  heartRate: number;
  breathRate: number;
  isSeated: boolean;
}

import type Config from './config';

/**
 * Silnik adaptacyjnego Auto-Tuningu radaru Seeed mmWave 60GHz (MR60BHA2).
 */
export default class AutoTuner {
  private readonly config: Config;

  private alphaDist = 0.05;
  private alphaBio = 0.03;
  private alphaNoise = 0.08;

  private distanceMean: number;
  private distanceMad: number;
  private heartRateMean: number;
  private breathRateMean: number;
  private noiseFloor: number;

  private samplesCount: number;
  private noiseSamplesCount = 0;
  private lastCountAt = 0;
  private lastNoiseAt = 0;
  private awaySince = 0;
  private lastNoiseLogAt = 0;
  /** Kroczące okno flag "próbka siedzenia w wyuczonej strefie" — podstawa realnej stabilności modelu. */
  private gateWindow: boolean[] = [];
  private lastAdaptedAt = Date.now();
  private lastSavedAt = Date.now();
  private lastPersistedSig = '';

  constructor(config: Config) {
    this.config = config;

    let distCenter = Number(config.get('radarLearnedDistanceCenter') || 0);
    // Sanityzacja: jeśli historycznie zapisano dystans spoza realnego biurka (np. ze ściany/tła), resetujemy do 0.
    // Dolna granica 20 cm — sensor może być zamontowany blisko użytkownika (krótkie ramię).
    if (distCenter < 20 || distCenter > 120) {
      distCenter = 0;
    }
    this.distanceMean = distCenter;
    this.distanceMad = Number(config.get('radarLearnedDistanceVariance') || 0);
    this.heartRateMean = Number(config.get('radarLearnedHeartRate') || 0);
    this.breathRateMean = Number(config.get('radarLearnedBreathRate') || 0);
    this.noiseFloor = Number(config.get('radarAutoTuningNoiseFloor') || 0);

    this.samplesCount = this.distanceMean > 0 ? 50 : 0;

    this.applySpeedConfig();
  }

  private applySpeedConfig(): void {
    const speed = this.config.get('radarAutoTuningSpeed') || 'balanced';
    if (speed === 'fast') {
      this.alphaDist = 0.12;
      this.alphaBio = 0.08;
      this.alphaNoise = 0.15;
    } else if (speed === 'conservative') {
      this.alphaDist = 0.02;
      this.alphaBio = 0.015;
      this.alphaNoise = 0.03;
    } else {
      this.alphaDist = 0.05;
      this.alphaBio = 0.03;
      this.alphaNoise = 0.08;
    }
  }

  feedSample({ distanceCm, heartRate, breathRate, isSeated }: Sample): void {
    if (this.config.get('radarAutoTuningEnabled') === false) return;
    this.applySpeedConfig();

    const now = Date.now();

    // Uczymy się w realnym korytarzu biurkowym (20 - 120 cm), także przy montażu
    // sensora blisko użytkownika. Odczyty powyżej 120 cm (stanie, tło, ściana)
    // nie mogą zafałszować środka biurka.
    if (isSeated && distanceCm >= 20 && distanceCm <= 120) {
      // Licznik próbek: feedSample leci osobno dla dystansu/tętna/oddechu
      // (3× na jeden odczyt radaru) — throttling 250 ms liczy burst jako
      // JEDNĄ próbkę, inaczej kalibracja "gotowa" po ~7 prawdziwych odczytach.
      if (now - this.lastCountAt > 250) {
        this.lastCountAt = now;
        this.samplesCount++;
        // Ocena dopasowania modelu: czy świeży odczyt mieści się w wyuczonej strefie.
        this.gateWindow.push(this.isInsideLearnedZone(distanceCm));
        if (this.gateWindow.length > 40) this.gateWindow.shift();
      }
      this.lastAdaptedAt = now;

      if (this.distanceMean === 0) {
        this.distanceMean = distanceCm;
        this.distanceMad = 12;
      } else {
        const diff = Math.abs(distanceCm - this.distanceMean);
        this.distanceMean = this.distanceMean + this.alphaDist * (distanceCm - this.distanceMean);
        this.distanceMad = this.distanceMad + this.alphaDist * (diff - this.distanceMad);
      }

      if (heartRate >= 48 && heartRate <= 115) {
        if (this.heartRateMean === 0) {
          this.heartRateMean = heartRate;
        } else {
          this.heartRateMean = this.heartRateMean + this.alphaBio * (heartRate - this.heartRateMean);
        }
      }

      if (breathRate >= 8 && breathRate <= 32) {
        if (this.breathRateMean === 0) {
          this.breathRateMean = breathRate;
        } else {
          this.breathRateMean = this.breathRateMean + this.alphaBio * (breathRate - this.breathRateMean);
        }
      }
    }

    if (!isSeated) {
      // Realny szum: udział odczytów w USTABILIZOWANEJ nieobecności (po 15 s od
      // przejścia w AWAY), w których radar widzi echo w strefie fotela.
      // Pierwsze sekundy nieobecności wykluczamy celowo — podejście do biurka
      // i wygaszanie obecności (bramki, bio-hold) samo z siebie generuje echa
      // w strefie i zawyżałoby wskaźnik. Echo poza strefą (chodzenie po pokoju)
      // jest neutralne — nie jest to fałszywa okupacja fotela.
      if (this.awaySince === 0) {
        this.awaySince = now;
      }
      if (now - this.awaySince >= 15000 && now - this.lastNoiseAt > 250) {
        this.lastNoiseAt = now;
        this.noiseSamplesCount++;
        const inZone = distanceCm > 0 && this.distanceMean > 0 && this.isInsideLearnedZone(distanceCm);
        const noiseEvent = inZone ? 100 : 0;
        this.noiseFloor = this.noiseFloor + this.alphaNoise * (noiseEvent - this.noiseFloor);
        this.noiseFloor = Math.max(0, Math.min(100, this.noiseFloor));
        // Log diagnostyczny: stały dystans godzinami = zamarznięte odbicie fotela;
        // zmienny dystans + biometria = zwierzak na fotelu.
        if (inZone && now - this.lastNoiseLogAt > 30000) {
          this.lastNoiseLogAt = now;
          appendLog(
            'RADAR-AUTO',
            `Fałszywe echo w strefie fotela: ${Math.round(distanceCm)} cm (szum ${Math.round(this.noiseFloor)}%, tętno ${heartRate || '—'}, oddech ${breathRate || '—'})`
          );
        }
      }
    } else {
      this.awaySince = 0;
    }

    if (now - this.lastSavedAt > 45000 && this.samplesCount >= 10) {
      this.persist();
      this.lastSavedAt = now;
    }
  }

  /** Czy odczyt mieści się w wyuczonej strefie fotela (środek ± adaptacyjny margines). */
  private isInsideLearnedZone(distanceCm: number): boolean {
    const margin = Math.max(12, this.distanceMad * 2);
    return Math.abs(distanceCm - this.distanceMean) <= margin;
  }

  getDynamicGate(): { minGateCm: number; maxGateCm: number; centerCm: number; isCalibrated: boolean } {
    const cfgMin = Number(this.config.get('radarMinDistanceCm') ?? 40);
    const cfgMax = Number(this.config.get('radarMaxDistanceCm') ?? 115);

    if (this.distanceMean <= 0) {
      return {
        minGateCm: cfgMin,
        maxGateCm: cfgMax,
        centerCm: 75,
        isCalibrated: false
      };
    }

    const margin = Math.max(18, Math.min(35, Math.round(this.distanceMad * 2.0 + 8)));
    const calculatedMin = Math.max(15, Math.round(this.distanceMean - margin));
    const calculatedMax = Math.min(180, Math.round(this.distanceMean + margin + 8));

    // Guardrails: Auto-Tuning może tylko ROZSZERZAĆ strefę fotela, a nie odcinać poprawne siedzenie
    return {
      minGateCm: Math.min(cfgMin, calculatedMin),
      maxGateCm: Math.max(cfgMax, calculatedMax),
      centerCm: Math.round(this.distanceMean),
      isCalibrated: this.samplesCount >= 15
    };
  }

  getStatus() {
    const gate = this.getDynamicGate();
    const enabled = this.config.get('radarAutoTuningEnabled') !== false;

    // Realna stabilność: odsetek ostatnich próbek siedzenia trafiających
    // w wyuczoną strefę. Zanim okno się napełni (>= 10 próbek) — model w nauce.
    let stabilityScore = 0;
    if (this.gateWindow.length >= 10) {
      const inGate = this.gateWindow.filter((hit) => hit).length;
      stabilityScore = Math.round((inGate / this.gateWindow.length) * 100);
    }

    return {
      enabled,
      noiseFloor: Math.round(this.noiseFloor),
      samplesCount: this.samplesCount,
      adaptedDistanceCenter: gate.centerCm,
      adaptedDistanceMin: gate.minGateCm,
      adaptedDistanceMax: gate.maxGateCm,
      adaptedHeartRateAvg: Math.round(this.heartRateMean),
      adaptedBreathRateAvg: Math.round(this.breathRateMean),
      stabilityScore,
      stabilityReady: this.gateWindow.length >= 10,
      lastAdaptedAt: this.lastAdaptedAt
    };
  }

  persist(): void {
    try {
      // Zapis tylko przy realnej zmianie wartości (EMA zawsze lekko dryfuje —
      // bez dedupu dysk dostawał zapis co 45 s w nieskończoność).
      const sig = `${Math.round(this.distanceMean)}|${Math.round(this.distanceMad)}|${Math.round(this.heartRateMean)}|${Math.round(this.breathRateMean)}|${Math.round(this.noiseFloor)}`;
      if (sig === this.lastPersistedSig) return;
      this.lastPersistedSig = sig;

      const data = this.config.data;
      if (this.distanceMean > 0) {
        data.radarLearnedDistanceCenter = Math.round(this.distanceMean);
        data.radarLearnedDistanceVariance = Math.round(this.distanceMad);
      }
      if (this.heartRateMean > 0) {
        data.radarLearnedHeartRate = Math.round(this.heartRateMean);
      }
      if (this.breathRateMean > 0) {
        data.radarLearnedBreathRate = Math.round(this.breathRateMean);
      }
      data.radarAutoTuningNoiseFloor = Math.round(this.noiseFloor);
      this.config.save();
    } catch (err) {
      console.warn('[auto-tuner] persist warning:', (err as Error).message);
    }
  }

  reset(): ReturnType<AutoTuner['getStatus']> {
    this.lastPersistedSig = '';
    this.distanceMean = 0;
    this.distanceMad = 0;
    this.heartRateMean = 0;
    this.breathRateMean = 0;
    this.noiseFloor = 0;
    this.samplesCount = 0;
    this.noiseSamplesCount = 0;
    this.gateWindow = [];
    this.lastCountAt = 0;
    this.lastNoiseAt = 0;
    this.awaySince = 0;
    this.lastNoiseLogAt = 0;
    this.lastAdaptedAt = Date.now();

    const data = this.config.data;
    data.radarLearnedDistanceCenter = 0;
    data.radarLearnedDistanceVariance = 0;
    data.radarLearnedHeartRate = 0;
    data.radarLearnedBreathRate = 0;
    data.radarAutoTuningNoiseFloor = 0;
    this.config.save();

    return this.getStatus();
  }
}
