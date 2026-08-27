/**
 * Cyfrowy procesor sygnału (DSP) i filtry wygładzające dla radaru mmWave (Seeed MR60BHA2 / HAOS).
 */

export class MedianFilter {
  private buffer: number[] = [];
  private size: number;

  constructor(size = 5) {
    this.size = Math.max(1, size);
  }

  setSize(size: number): void {
    this.size = Math.max(1, size);
    if (this.buffer.length > this.size) {
      this.buffer = this.buffer.slice(-this.size);
    }
  }

  push(val: number): number {
    this.buffer.push(val);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  reset(): void {
    this.buffer = [];
  }
}

export class ExponentialSmoothingFilter {
  private currentFloat = 0;
  private currentInt = 0;
  private alpha: number;
  private deadband: number;

  constructor(alpha = 0.16, deadband = 1.5) {
    this.alpha = alpha;
    this.deadband = deadband;
  }

  setAlpha(alpha: number): void {
    this.alpha = Math.max(0.02, Math.min(1.0, alpha));
  }

  setDeadband(deadband: number): void {
    this.deadband = Math.max(0, deadband);
  }

  push(val: number): number {
    if (val <= 0) return this.currentInt;
    if (this.currentFloat <= 0 || Math.abs(val - this.currentFloat) > 90) {
      this.currentFloat = val;
      this.currentInt = Math.round(val);
      return this.currentInt;
    }

    const delta = Math.abs(val - this.currentFloat);
    // Adaptacyjny współczynnik alpha przy nagłej zmianie fizjologicznej
    const effAlpha = delta > 25 ? Math.min(0.60, this.alpha * 2.2) : this.alpha;
    this.currentFloat = this.currentFloat + effAlpha * (val - this.currentFloat);

    // Histereza / martwa strefa (zapobiega drganiom o +-1 jednostkę przy spoczynku)
    if (Math.abs(this.currentFloat - this.currentInt) >= this.deadband) {
      this.currentInt = Math.round(this.currentFloat);
    }
    return this.currentInt;
  }

  reset(): void {
    this.currentFloat = 0;
    this.currentInt = 0;
  }
}

/**
 * 1D Kinematyczny Filtr Kalmana estymujący stan [pozycja x, prędkość v].
 * - Stan: x (pozycja w cm), v (prędkość w cm/s)
 * - Macierz kowariancji błędu P (2x2)
 * - Adaptacyjny szum procesu Q i szum pomiaru R
 */
export class KalmanStateTracker1D {
  private x = 0; // pozycja (cm)
  private v = 0; // prędkość (cm/s)
  private p11 = 10.0;
  private p12 = 0.0;
  private p21 = 0.0;
  private p22 = 10.0;

  private lastTimeMs = 0;
  private r = 4.0; // Szum pomiarowy radaru (cm^2)
  private qBase = 0.4; // Bazowy szum przyspieszenia (cm^2/s^4)
  private initialized = false;

  constructor(r = 4.0, qBase = 0.4) {
    this.r = r;
    this.qBase = qBase;
  }

  setParameters(r: number, qBase: number): void {
    this.r = Math.max(0.1, r);
    this.qBase = Math.max(0.01, qBase);
  }

  update(z: number, nowMs = Date.now()): { position: number; velocity: number } {
    if (!this.initialized || this.lastTimeMs === 0) {
      this.x = z;
      this.v = 0;
      this.p11 = 5.0;
      this.p12 = 0.0;
      this.p21 = 0.0;
      this.p22 = 5.0;
      this.lastTimeMs = nowMs;
      this.initialized = true;
      return { position: this.x, velocity: this.v };
    }

    const dt = Math.min(1.0, Math.max(0.04, (nowMs - this.lastTimeMs) / 1000));
    this.lastTimeMs = nowMs;

    // 1. Predykcja stanu (Time Update: x = x + v*dt, v = v)
    const xPred = this.x + this.v * dt;
    const vPred = this.v;

    // Adaptacyjny szum procesu Q: w spoczynku znikomy, przy ruchu dynamicznie rośnie
    const innovation = z - xPred;
    const isMoving = Math.abs(innovation) > 8.0 || Math.abs(this.v) > 4.0;
    const qAcc = isMoving ? this.qBase * 15.0 : this.qBase;

    const q11 = 0.25 * dt * dt * dt * dt * qAcc;
    const q12 = 0.5 * dt * dt * dt * qAcc;
    const q21 = q12;
    const q22 = dt * dt * qAcc;

    // P_pred = F * P * F' + Q
    const p11Pred = this.p11 + dt * (this.p21 + this.p12) + dt * dt * this.p22 + q11;
    const p12Pred = this.p12 + dt * this.p22 + q12;
    const p21Pred = this.p21 + dt * this.p22 + q21;
    const p22Pred = this.p22 + q22;

    // 2. Korekta pomiarowa (Measurement Update)
    const rEff = isMoving ? this.r * 0.4 : this.r;
    const s = p11Pred + rEff;

    // Wzmocnienie Kalmana K = P_pred * H' * inv(S)
    const k1 = p11Pred / s;
    const k2 = p21Pred / s;

    // Aktualizacja stanu
    this.x = xPred + k1 * innovation;
    this.v = vPred + k2 * innovation;

    // Aktualizacja kowariancji błędu P = (I - K * H) * P_pred
    this.p11 = (1 - k1) * p11Pred;
    this.p12 = (1 - k1) * p12Pred;
    this.p21 = p21Pred - k2 * p11Pred;
    this.p22 = p22Pred - k2 * p12Pred;

    return { position: this.x, velocity: this.v };
  }

  getPosition(): number {
    return this.x;
  }

  getVelocity(): number {
    return this.v;
  }

  reset(): void {
    this.x = 0;
    this.v = 0;
    this.p11 = 10.0;
    this.p12 = 0.0;
    this.p21 = 0.0;
    this.p22 = 10.0;
    this.lastTimeMs = 0;
    this.initialized = false;
  }
}

export class DistanceFilter {
  private median: MedianFilter;
  private kalman: KalmanStateTracker1D;
  private currentFloat = 0;
  private currentInt = 0;
  private deadbandCm = 3.0; // Histereza 3.0 cm — całkowicie nieruchomy odczyt przy spoczynku
  private rawMode = false;
  private initialized = false;

  constructor(deadbandCm = 3.0, medianSize = 7) {
    this.median = new MedianFilter(medianSize);
    this.kalman = new KalmanStateTracker1D(4.0, 0.4);
    this.deadbandCm = deadbandCm;
  }

  setMode(mode: 'ultra' | 'balanced' | 'raw'): void {
    if (mode === 'ultra') {
      this.rawMode = false;
      this.median.setSize(7);
      this.kalman.setParameters(5.0, 0.25);
      this.deadbandCm = 3.5; // Histereza 3.5 cm — idealnie stabilne siedzenie przy biurku
    } else if (mode === 'balanced') {
      this.rawMode = false;
      this.median.setSize(5);
      this.kalman.setParameters(3.0, 0.6);
      this.deadbandCm = 2.5; // Histereza 2.5 cm
    } else {
      this.rawMode = true;
      this.median.setSize(1);
      this.kalman.setParameters(0.1, 10.0);
      this.deadbandCm = 0;
    }
  }

  setDeadband(cm: number): void {
    this.deadbandCm = Math.max(0, cm);
  }

  push(valCm: number): number {
    // Zero-Loss: Nieprawidłowe lub zerowe wartości nie niszczą buforów i zwracają ostatnią stabilną odległość
    if (valCm <= 0 || valCm > 600) return this.currentInt;

    if (this.rawMode) {
      this.currentFloat = valCm;
      this.currentInt = Math.round(valCm);
      this.initialized = true;
      return this.currentInt;
    }

    // 1. Filtracja szumów i outlierów (Median Window)
    // Mediana z 5-7 próbek w 100% eliminuje chwilowe odbicia od klawiatury (50 cm) lub ściany (150 cm)
    let candidate = valCm;
    if (this.initialized && this.currentFloat > 0) {
      const jump = Math.abs(valCm - this.currentFloat);
      if (jump > 55) {
        candidate = valCm > this.currentFloat ? this.currentFloat + 40 : Math.max(10, this.currentFloat - 40);
      }
    }
    const medianVal = this.median.push(candidate);

    // 2. Inicjalizacja początkowa
    if (!this.initialized || this.currentFloat <= 0) {
      this.currentFloat = medianVal;
      this.currentInt = Math.round(medianVal);
      this.kalman.update(medianVal);
      this.initialized = true;
      return this.currentInt;
    }

    // 3. 1D Kinematyczny Filtr Kalmana (estymacja pozycji i prędkości)
    const kalmanState = this.kalman.update(medianVal);
    this.currentFloat = kalmanState.position;

    // 4. Histereza / martwa strefa (tłumi szum fazowy i mikroruchy klatki piersiowej)
    if (Math.abs(this.currentFloat - this.currentInt) >= this.deadbandCm) {
      this.currentInt = Math.round(this.currentFloat);
    }

    return this.currentInt;
  }

  getEnvelope(): { front: number; back: number; span: number; velocity: number } {
    const pos = Math.round(this.currentFloat);
    return {
      front: pos > 0 ? Math.max(10, pos - 6) : 0,
      back: pos > 0 ? pos + 12 : 0,
      span: pos > 0 ? 18 : 0,
      velocity: Math.round(this.kalman.getVelocity() * 10) / 10
    };
  }

  reset(): void {
    this.currentFloat = 0;
    this.currentInt = 0;
    this.initialized = false;
    this.median.reset();
    this.kalman.reset();
  }
}

export class IlluminanceFilter {
  private currentFloat = 0;
  private currentOutput = 0;
  private alpha = 0.15;
  private deadbandLux = 2.0;

  constructor(alpha = 0.15, deadbandLux = 2.0) {
    this.alpha = alpha;
    this.deadbandLux = deadbandLux;
  }

  push(valLux: number): number {
    if (valLux < 0 || valLux > 120000) return this.currentOutput;
    if (this.currentFloat <= 0) {
      this.currentFloat = valLux;
      this.currentOutput = Math.round(valLux * 10) / 10;
      return this.currentOutput;
    }

    const delta = Math.abs(valLux - this.currentFloat);
    const effAlpha = delta > 40 ? 0.6 : this.alpha;
    this.currentFloat = this.currentFloat + effAlpha * (valLux - this.currentFloat);

    if (Math.abs(this.currentFloat - this.currentOutput) >= this.deadbandLux) {
      this.currentOutput = Math.round(this.currentFloat * 10) / 10;
    }

    return this.currentOutput;
  }

  reset(): void {
    this.currentFloat = 0;
    this.currentOutput = 0;
  }
}

export class PresenceDebounceFilter {
  private currentPresence = false;
  private holdOffTimer: NodeJS.Timeout | null = null;
  private positiveStreak = 0;
  private holdOffMs: number;

  constructor(holdOffMs = 2500) {
    this.holdOffMs = holdOffMs;
  }

  setHoldOffMs(ms: number): void {
    this.holdOffMs = Math.max(800, ms);
  }

  process(rawPresent: boolean, onStateChange: (effective: boolean) => void): boolean {
    if (rawPresent) {
      this.positiveStreak++;
      if (this.holdOffTimer) {
        clearTimeout(this.holdOffTimer);
        this.holdOffTimer = null;
      }
      // Reaguj natychmiast
      if (!this.currentPresence && this.positiveStreak >= 1) {
        this.currentPresence = true;
        onStateChange(true);
      }
      return this.currentPresence;
    } else {
      this.positiveStreak = 0;
      if (this.currentPresence) {
        // Jeśli obecność spada do false, uruchom hold-off timer (odporność na flappowanie)
        if (!this.holdOffTimer) {
          this.holdOffTimer = setTimeout(() => {
            this.holdOffTimer = null;
            this.currentPresence = false;
            onStateChange(false);
          }, this.holdOffMs);
        }
      }
      return this.currentPresence;
    }
  }

  reset(): void {
    if (this.holdOffTimer) {
      clearTimeout(this.holdOffTimer);
      this.holdOffTimer = null;
    }
    this.currentPresence = false;
    this.positiveStreak = 0;
  }
}
