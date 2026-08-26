/**
 * Cyfrowy procesor sygnału (DSP) i filtry wygładzające dla radaru mmWave (Seeed MR60BHA2 / HAOS).
 */

export class MedianFilter {
  private buffer: number[] = [];
  private size: number;

  constructor(size = 5) {
    this.size = size;
  }

  setSize(size: number): void {
    this.size = Math.max(3, size);
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
    return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  reset(): void {
    this.buffer = [];
  }
}

export class ExponentialSmoothingFilter {
  private current = 0;
  private alpha: number;

  constructor(alpha = 0.18) {
    this.alpha = alpha;
  }

  setAlpha(alpha: number): void {
    this.alpha = Math.max(0.02, Math.min(1.0, alpha));
  }

  push(val: number): number {
    if (this.current <= 0 || Math.abs(val - this.current) > 130) {
      this.current = val;
    } else {
      const delta = Math.abs(val - this.current);
      // Adaptacyjny alpha: przy rzeczywistym odejściu/wstawaniu przyspiesz reakcję
      const effAlpha = delta > 40 ? Math.min(0.65, this.alpha * 2.2) : this.alpha;
      this.current = this.current + effAlpha * (val - this.current);
    }
    return Math.round(this.current);
  }

  reset(): void {
    this.current = 0;
  }
}

export class DistanceFilter {
  private current = 0;
  private alpha = 0.4;
  private stepThresholdCm = 15;

  constructor(alpha = 0.4, stepThresholdCm = 15) {
    this.alpha = alpha;
    this.stepThresholdCm = stepThresholdCm;
  }

  setMode(mode: 'ultra' | 'balanced' | 'raw'): void {
    if (mode === 'ultra') {
      this.alpha = 0.35;
      this.stepThresholdCm = 15;
    } else if (mode === 'balanced') {
      this.alpha = 0.6;
      this.stepThresholdCm = 10;
    } else {
      this.alpha = 1.0;
      this.stepThresholdCm = 0;
    }
  }

  push(valCm: number): number {
    if (valCm <= 0 || valCm > 600) return this.current;
    if (this.current <= 0) {
      this.current = valCm;
      return Math.round(this.current);
    }
    const delta = Math.abs(valCm - this.current);
    // Skokowa zmiana pozycji (np. podejście, siadanie, wstanie) — natychmiastowa reakcja w 1. klatce
    if (delta >= this.stepThresholdCm) {
      this.current = valCm;
    } else {
      // Drobne fluktuacje oddechowe/pozycyjne — płynne wygładzenie
      this.current = this.current + this.alpha * (valCm - this.current);
    }
    return Math.round(this.current);
  }

  reset(): void {
    this.current = 0;
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
    this.holdOffMs = Math.max(500, ms);
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
