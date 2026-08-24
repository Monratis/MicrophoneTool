/**
 * Silnik adaptacyjnego Auto-Tuningu radaru Seeed mmWave 60GHz (MR60BHA2).
 * 
 * Odpowiada za dynamiczne uczenie się i dopasowywanie parametrów do warunków w pokoju:
 *  1. Dynamiczna Bramka Odległości (Adaptive Distance Centroid & MAD spread)
 *     - Śledzi naturalną pozycję użytkownika w fotelu (odchylanie się, przysuwanie).
 *     - Automatycznie wyznacza strefę min/max bez potrzeby ręcznego ustawiania suwaków.
 *  2. Profilowanie Szumu Tła Pokoju (Environmental Noise Floor & Ghost Filtering)
 *     - Gdy biurko jest puste, mierzy niepożądane odbicia mikrofalowe (firanki, wiatrak, klimatyzacja).
 *     - Wylicza procent szumu otoczenia (Noise Floor %) i dynamicznie koryguje odporność na fałszywe pobudzenia.
 *  3. Adaptacja Biometryczna (Resting Biometrics EWMA)
 *     - Płynnie uczy się tętna spoczynkowego i oddechu użytkownika w ciągu dnia.
 *     - Zwiększa precyzję rozróżniania użytkownika od narzeczonej lub zwierząt domowych.
 */

export default class AutoTuner {
  constructor(config) {
    this.config = config;

    // Współczynniki wygładzania wykładniczego (Exponential Moving Average)
    this.alphaDist = 0.05;
    this.alphaBio = 0.03;
    this.alphaNoise = 0.08;

    // Wyuczone parametry (wartości początkowe pobrane z konfiguracji lub zera)
    this.distanceMean = Number(config.get('radarLearnedDistanceCenter') || 0);
    this.distanceMad = Number(config.get('radarLearnedDistanceVariance') || 0);
    this.heartRateMean = Number(config.get('radarLearnedHeartRate') || 0);
    this.breathRateMean = Number(config.get('radarLearnedBreathRate') || 0);
    this.noiseFloor = Number(config.get('radarAutoTuningNoiseFloor') || 0);

    // Liczniki i stan
    this.samplesCount = (this.distanceMean > 0) ? 50 : 0;
    this.noiseSamplesCount = 0;
    this.stableStreak = 0;
    this.lastDistanceSample = 0;
    this.lastAdaptedAt = Date.now();
    this.lastSavedAt = Date.now();

    this._applySpeedConfig();
  }

  _applySpeedConfig() {
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
      // balanced
      this.alphaDist = 0.05;
      this.alphaBio = 0.03;
      this.alphaNoise = 0.08;
    }
  }

  /**
   * Podaje nową próbkę telemetrii do adaptacyjnego modelu.
   * @param {Object} sample { distanceCm, heartRate, breathRate, rawPresence, isSeated }
   */
  feedSample({ distanceCm, heartRate, breathRate, isSeated, rawPresence }) {
    if (this.config.get('radarAutoTuningEnabled') === false) return;
    this._applySpeedConfig();

    const now = Date.now();

    // 1. Adaptacja podczas obecności przy biurku (Target Seated)
    if (isSeated && distanceCm > 25 && distanceCm < 220) {
      this.samplesCount++;
      this.lastAdaptedAt = now;

      // Inicjalizacja pierwszej próbki
      if (this.distanceMean === 0) {
        this.distanceMean = distanceCm;
        this.distanceMad = 15;
      } else {
        // EWMA dla środka odległości
        const diff = Math.abs(distanceCm - this.distanceMean);
        this.distanceMean = this.distanceMean + this.alphaDist * (distanceCm - this.distanceMean);
        this.distanceMad = this.distanceMad + this.alphaDist * (diff - this.distanceMad);
      }

      // Śledzenie stabilności pozycji (stabilny odczyt ±4cm)
      if (this.lastDistanceSample > 0 && Math.abs(distanceCm - this.lastDistanceSample) <= 4) {
        this.stableStreak = Math.min(100, this.stableStreak + 2);
      } else {
        this.stableStreak = Math.max(0, this.stableStreak - 1);
      }
      this.lastDistanceSample = distanceCm;

      // Adaptacja tętna spoczynkowego (tylko w realistycznym zakresie spoczynkowym człowieka 48-115 BPM)
      if (heartRate >= 48 && heartRate <= 115) {
        if (this.heartRateMean === 0) {
          this.heartRateMean = heartRate;
        } else {
          this.heartRateMean = this.heartRateMean + this.alphaBio * (heartRate - this.heartRateMean);
        }
      }

      // Adaptacja oddechu (tylko w zakresie człowieka 9-22 RPM)
      if (breathRate >= 9 && breathRate <= 22) {
        if (this.breathRateMean === 0) {
          this.breathRateMean = breathRate;
        } else {
          this.breathRateMean = this.breathRateMean + this.alphaBio * (breathRate - this.breathRateMean);
        }
      }
    }

    // 2. Profilowanie szumu tła gdy biurko jest puste (Empty Desk Noise Profiling)
    if (!isSeated) {
      this.noiseSamplesCount++;
      // Jeśli radar raportuje fałszywy cel podczas braku obecności -> zmierz szum tła
      const currentNoiseReading = rawPresence ? 80 : (distanceCm > 0 ? 35 : 0);
      this.noiseFloor = this.noiseFloor + this.alphaNoise * (currentNoiseReading - this.noiseFloor);
      this.noiseFloor = Math.max(0, Math.min(100, this.noiseFloor));
    }

    // 3. Okresowe utrwalanie wyuczonych parametrów w konfiguracji (co 45 sekund)
    if (now - this.lastSavedAt > 45000 && this.samplesCount >= 10) {
      this.persist();
      this.lastSavedAt = now;
    }
  }

  /**
   * Zwraca dynamiczne granice bramki odległości (w cm).
   */
  getDynamicGate() {
    if (this.distanceMean <= 0) {
      return {
        minGateCm: Number(this.config.get('radarMinDistanceCm') || 40),
        maxGateCm: Number(this.config.get('radarMaxDistanceCm') || 110),
        centerCm: 75,
        isCalibrated: false
      };
    }

    const margin = Math.max(16, Math.min(38, Math.round(this.distanceMad * 2.0 + 8)));
    const minGateCm = Math.max(25, Math.round(this.distanceMean - margin));
    const maxGateCm = Math.min(180, Math.round(this.distanceMean + margin + 6));

    return {
      minGateCm,
      maxGateCm,
      centerCm: Math.round(this.distanceMean),
      isCalibrated: this.samplesCount >= 15
    };
  }

  /**
   * Zwraca wyuczony profil biometryczny użytkownika.
   */
  getAdaptedBiometrics() {
    const hr = Math.round(this.heartRateMean);
    const br = Math.round(this.breathRateMean);
    return {
      heartRateAvg: hr || 0,
      heartRateMin: hr > 0 ? Math.max(45, hr - 13) : Number(this.config.get('userHeartRateMin') || 55),
      heartRateMax: hr > 0 ? Math.min(125, hr + 15) : Number(this.config.get('userHeartRateMax') || 78),
      breathRateAvg: br || 0,
      breathRateMin: br > 0 ? Math.max(8, br - 4) : 10,
      breathRateMax: br > 0 ? Math.min(24, br + 4) : 20,
      isCalibrated: this.samplesCount >= 20 && hr > 0
    };
  }

  /**
   * Zwraca kompleksowy stan auto-tuningu do telemetrii UI.
   */
  getStatus() {
    const gate = this.getDynamicGate();
    const bio = this.getAdaptedBiometrics();
    const enabled = this.config.get('radarAutoTuningEnabled') !== false;

    let mode = 'idle';
    if (enabled) {
      mode = this.samplesCount < 20 ? 'learning' : 'tracking';
    }

    const stabilityScore = Math.min(100, Math.max(10, Math.round(
      (this.samplesCount >= 20 ? 50 : this.samplesCount * 2.5) +
      (this.stableStreak * 0.5) -
      (this.noiseFloor * 0.2)
    )));

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

  /**
   * Zapisuje wyuczone parametry do pliku config.
   */
  persist() {
    try {
      if (this.distanceMean > 0) {
        this.config.set('radarLearnedDistanceCenter', Math.round(this.distanceMean));
        this.config.set('radarLearnedDistanceVariance', Math.round(this.distanceMad));
      }
      if (this.heartRateMean > 0) {
        this.config.set('radarLearnedHeartRate', Math.round(this.heartRateMean));
      }
      if (this.breathRateMean > 0) {
        this.config.set('radarLearnedBreathRate', Math.round(this.breathRateMean));
      }
      this.config.set('radarAutoTuningNoiseFloor', Math.round(this.noiseFloor));
    } catch (err) {
      console.warn('[auto-tuner] persist warning:', err.message);
    }
  }

  /**
   * Resetuje nauczony model do stanu fabrycznego.
   */
  reset() {
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

    this.config.set('radarLearnedDistanceCenter', 0);
    this.config.set('radarLearnedDistanceVariance', 0);
    this.config.set('radarLearnedHeartRate', 0);
    this.config.set('radarLearnedBreathRate', 0);
    this.config.set('radarAutoTuningNoiseFloor', 0);

    return this.getStatus();
  }
}
