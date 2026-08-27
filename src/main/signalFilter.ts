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

export class DistanceFilter {
  private median: MedianFilter;
  private currentFloat = 0;
  private currentInt = 0;
  private baseAlpha = 0.08;
  private deadbandCm = 3.5; // Histereza 3.5 cm — całkowicie nieruchomy odczyt przy spoczynku
  private rawMode = false;
  private initialized = false;

  // Dynamic Target Envelope (Obwiednia Ciała i Fotela)
  private envelopeHistory: number[] = [];
  private envelopeSize = 12; // okno ~6-10 sekund
  private envelopeFront = 0; // Leading Edge (klatka piersiowa / mostek)
  private envelopeBack = 0;  // Trailing Edge (oparcie fotela)
  private outOfEnvelopeStreak = 0;

  constructor(baseAlpha = 0.08, deadbandCm = 3.5, medianSize = 9) {
    this.median = new MedianFilter(medianSize);
    this.baseAlpha = baseAlpha;
    this.deadbandCm = deadbandCm;
  }

  setMode(mode: 'ultra' | 'balanced' | 'raw'): void {
    if (mode === 'ultra') {
      this.rawMode = false;
      this.median.setSize(9);
      this.envelopeSize = 14;
      this.baseAlpha = 0.06;
      this.deadbandCm = 3.5; // Histereza 3.5 cm — idealnie stabilne siedzenie przy biurku
    } else if (mode === 'balanced') {
      this.rawMode = false;
      this.median.setSize(7);
      this.envelopeSize = 10;
      this.baseAlpha = 0.12;
      this.deadbandCm = 2.5; // Histereza 2.5 cm
    } else {
      this.rawMode = true;
      this.median.setSize(1);
      this.baseAlpha = 1.0;
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

    // 1. Filtracja szumów i outlierów
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
      this.envelopeFront = medianVal;
      this.envelopeBack = medianVal;
      this.envelopeHistory = [medianVal];
      this.initialized = true;
      return this.currentInt;
    }

    // 3. Śledzenie Obwiedni Ciała i Fotela (Dynamic Target Envelope)
    this.envelopeHistory.push(medianVal);
    if (this.envelopeHistory.length > this.envelopeSize) {
      this.envelopeHistory.shift();
    }

    const sortedEnv = [...this.envelopeHistory].sort((a, b) => a - b);
    // Przednia krawędź (Leading Edge): dolny kwantyl (klatka piersiowa / mostek)
    const envMin = sortedEnv[Math.floor(sortedEnv.length * 0.15)] || sortedEnv[0];
    // Tylna krawędź (Trailing Edge): górny kwantyl (oparcie fotela)
    const envMax = sortedEnv[Math.floor(sortedEnv.length * 0.85)] || sortedEnv[sortedEnv.length - 1];
    const depthSpan = envMax - envMin;

    // 4. Rozpoznawanie: Czy odbicie jest wewnątrz fizycznej głębokości ciała i fotela (span <= 24 cm)?
    const isInsideBodyEnvelope = depthSpan <= 24 && Math.abs(medianVal - this.currentFloat) <= 22;

    let targetAnchor: number;

    if (isInsideBodyEnvelope) {
      this.outOfEnvelopeStreak = 0;
      this.envelopeFront = envMin;
      this.envelopeBack = envMax;

      // Gdy przeskakują prążki ciała/fotela (np. 74.6 <-> 80.4 <-> 86.1 cm),
      // kotwiczymy pozycję na przedniej krawędzi (mostek) z ultra-wysoką stabilnością
      targetAnchor = envMin;
    } else {
      // Sprawdzamy czy to trwałe przesunięcie w przestrzeni (np. odepchnięcie fotela o 30 cm)
      this.outOfEnvelopeStreak++;
      if (this.outOfEnvelopeStreak >= 4) {
        // Potwierdzony ruch: cała obwiednia przemieszcza się na nową pozycję
        targetAnchor = medianVal;
        this.envelopeFront = medianVal;
        this.envelopeBack = medianVal;
      } else {
        // Chwilowy skok: trzymamy bieżącą kotwicę
        targetAnchor = this.currentFloat;
      }
    }

    // 5. 3-Strefowy adaptacyjny EMA dla wyznaczonej kotwicy
    const delta = Math.abs(targetAnchor - this.currentFloat);
    let effAlpha = this.baseAlpha;
    if (isInsideBodyEnvelope || delta <= 5.0) {
      // Wewnątrz obwiedni ciała lub przy spoczynku — maksymalne zamrożenie drgań
      effAlpha = Math.max(0.03, this.baseAlpha * 0.4);
    } else if (delta <= 20.0) {
      // Płynna zmiana pozycji w fotelu
      effAlpha = this.baseAlpha;
    } else {
      // Prawdziwe wejście/wyjście lub przesunięcie fotela — szybka konwergencja
      effAlpha = Math.min(0.50, this.baseAlpha * 3.5);
    }

    this.currentFloat = this.currentFloat + effAlpha * (targetAnchor - this.currentFloat);

    // 6. Histereza / martwa strefa (tłumi szum fazowy i mikroruchy klatki piersiowej)
    if (Math.abs(this.currentFloat - this.currentInt) >= this.deadbandCm) {
      this.currentInt = Math.round(this.currentFloat);
    }

    return this.currentInt;
  }

  getEnvelope(): { front: number; back: number; span: number } {
    return {
      front: Math.round(this.envelopeFront),
      back: Math.round(this.envelopeBack),
      span: Math.max(0, Math.round(this.envelopeBack - this.envelopeFront))
    };
  }

  reset(): void {
    this.currentFloat = 0;
    this.currentInt = 0;
    this.initialized = false;
    this.envelopeHistory = [];
    this.envelopeFront = 0;
    this.envelopeBack = 0;
    this.outOfEnvelopeStreak = 0;
    this.median.reset();
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
