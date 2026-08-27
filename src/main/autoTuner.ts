export type AutoTuningSpeed = 'balanced' | 'fast' | 'conservative';

interface Sample {
  distanceCm: number;
  heartRate: number;
  breathRate: number;
  isSeated: boolean;
  rawPresence: boolean;
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
  private stableStreak = 0;
  private lastDistanceSample = 0;
  private lastCountAt = 0;
  private lastAdaptedAt = Date.now();
  private lastSavedAt = Date.now();
  private lastPersistedSig = '';

  constructor(config: Config) {
    this.config = config;

    let distCenter = Number(config.get('radarLearnedDistanceCenter') || 0);
    // Sanityzacja: jeśli historycznie zapisano dystans spoza realnego biurka (np. 141 cm ze ściany/tła), resetujemy do 0
    if (distCenter < 35 || distCenter > 120) {
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

  feedSample({ distanceCm, heartRate, breathRate, isSeated, rawPresence }: Sample): void {
    if (this.config.get('radarAutoTuningEnabled') === false) return;
    this.applySpeedConfig();

    const now = Date.now();

    // Uczymy się TYLKO w realnym korytarzu biurkowym (35 - 120 cm).
    // Odczyty powyżej 120 cm (stanie, tło, ściana) nie mogą zafałszować środka biurka.
    if (isSeated && distanceCm >= 35 && distanceCm <= 120) {
      // Licznik próbek: feedSample leci osobno dla dystansu/tętna/oddechu
      // (3× na jeden odczyt radaru) — throttling 250 ms liczy burst jako
      // JEDNĄ próbkę, inaczej kalibracja "gotowa" po ~7 prawdziwych odczytach.
      if (now - this.lastCountAt > 250) {
        this.lastCountAt = now;
        this.samplesCount++;
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

      if (this.lastDistanceSample > 0 && Math.abs(distanceCm - this.lastDistanceSample) <= 4) {
        this.stableStreak = Math.min(100, this.stableStreak + 2);
      } else {
        this.stableStreak = Math.max(0, this.stableStreak - 1);
      }
      this.lastDistanceSample = distanceCm;

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
      this.noiseSamplesCount++;
      const currentNoiseReading = rawPresence ? 80 : distanceCm > 0 ? 35 : 0;
      this.noiseFloor = this.noiseFloor + this.alphaNoise * (currentNoiseReading - this.noiseFloor);
      this.noiseFloor = Math.max(0, Math.min(100, this.noiseFloor));
    }

    if (now - this.lastSavedAt > 45000 && this.samplesCount >= 10) {
      this.persist();
      this.lastSavedAt = now;
    }
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
    const calculatedMin = Math.max(25, Math.round(this.distanceMean - margin));
    const calculatedMax = Math.min(180, Math.round(this.distanceMean + margin + 8));

    // Guardrails: Auto-Tuning może tylko ROZSZERZAĆ strefę fotela, a nie odcinać poprawne siedzenie
    return {
      minGateCm: Math.min(cfgMin, calculatedMin),
      maxGateCm: Math.max(cfgMax, calculatedMax),
      centerCm: Math.round(this.distanceMean),
      isCalibrated: this.samplesCount >= 15
    };
  }

  getAdaptedBiometrics(): {
    heartRateAvg: number;
    heartRateMin: number;
    heartRateMax: number;
    breathRateAvg: number;
    breathRateMin: number;
    breathRateMax: number;
    isCalibrated: boolean;
  } {
    const hr = Math.round(this.heartRateMean);
    const br = Math.round(this.breathRateMean);
    const cfgHrMin = Number(this.config.get('userHeartRateMin') ?? 55);
    const cfgHrMax = Number(this.config.get('userHeartRateMax') ?? 78);

    return {
      heartRateAvg: hr || 0,
      heartRateMin: hr > 0 ? Math.max(45, Math.min(cfgHrMin, hr - 15)) : cfgHrMin,
      heartRateMax: hr > 0 ? Math.min(130, Math.max(cfgHrMax, hr + 18)) : cfgHrMax,
      breathRateAvg: br || 0,
      breathRateMin: br > 0 ? Math.max(7, br - 5) : 10,
      breathRateMax: br > 0 ? Math.min(32, Math.max(26, br + 6)) : 22,
      isCalibrated: this.samplesCount >= 20 && hr > 0
    };
  }

  getStatus() {
    const gate = this.getDynamicGate();
    const bio = this.getAdaptedBiometrics();
    const enabled = this.config.get('radarAutoTuningEnabled') !== false;

    let mode: 'learning' | 'tracking' | 'idle' = 'idle';
    if (enabled) {
      mode = this.samplesCount < 20 ? 'learning' : 'tracking';
    }

    const stabilityScore = Math.min(
      100,
      Math.max(
        10,
        Math.round(
          (this.samplesCount >= 20 ? 50 : this.samplesCount * 2.5) +
            this.stableStreak * 0.5 -
            this.noiseFloor * 0.2
        )
      )
    );

    return {
      enabled,
      mode,
      speed: this.config.get('radarAutoTuningSpeed') || 'balanced',
      noiseFloor: Math.round(this.noiseFloor),
      samplesCount: this.samplesCount,
      adaptedDistanceCenter: gate.centerCm,
      adaptedDistanceMin: gate.minGateCm,
      adaptedDistanceMax: gate.maxGateCm,
      adaptedHeartRateAvg: bio.heartRateAvg,
      adaptedBreathRateAvg: bio.breathRateAvg,
      stabilityScore,
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
    this.stableStreak = 0;
    this.lastDistanceSample = 0;
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
