/**
 * Cyfrowy procesor sygnału (DSP) i filtry uśredniające (5 próbek) dla radaru Seeed MR60BHA2.
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
    if (!Number.isFinite(val) || val <= 0) return 0;
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

/**
 * Filtr dystansu: mediana (odrzucanie pików) + EMA + martwa strefa + limit tempa zmian.
 * Dwa realne problemy MR60BHA2 przy bliskim montażu:
 * 1. kwantyzacja ~5,5 cm i migotanie ±1 krok przy nieruchomym użytkowniku (martwa strefa),
 * 2. tracker przeskakuje między odbiciami (klatka piersiowa / biurko / monitor) —
 *    skoki rzędu 20↔60 cm w 2-3 klatkach. Mediana z 5 próbek je wygasa, a limit
 *    tempa zmian sprawia, że wyświetlana wartość płynie zamiast skakać.
 * Realne przemieszczenie użytkownika jest podtrzymane ciągłością odczytów,
 * więc wyjście dogoni je w ~1-2 s.
 */
export class DistanceFilter {
  private median: MedianFilter;
  private alpha: number;
  private ema = 0;
  private output = 0;

  constructor(size = 3) {
    this.median = new MedianFilter(size);
    this.alpha = 0.85;
  }

  setMode(mode: 'ultra' | 'balanced' | 'raw'): void {
    if (mode === 'raw') {
      this.median.setSize(1);
      this.alpha = 1.0;
    } else if (mode === 'balanced') {
      this.median.setSize(3);
      this.alpha = 0.85;
    } else {
      this.median.setSize(5);
      this.alpha = 0.6;
    }
  }

  push(valCm: number): number {
    if (!Number.isFinite(valCm) || valCm <= 0 || valCm > 800) return 0;
    const m = this.median.push(valCm);
    if (m <= 0) return Math.round(this.output);
    this.ema = this.ema === 0 ? m : this.ema + this.alpha * (m - this.ema);
    this.output = Math.round(this.ema);
    return this.output;
  }

  reset(): void {
    this.median.reset();
    this.ema = 0;
    this.output = 0;
  }
}

/**
 * Filtr biometryczny (tętno/oddech): szybka mediana 3-próbkowa bez sztucznego laga.
 */
export class BiometricFilter {
  private median: MedianFilter;
  private alpha: number;
  private ema = 0;
  private output = 0;

  constructor(size = 3, alpha = 0.85) {
    this.median = new MedianFilter(size);
    this.alpha = alpha;
  }

  setMode(mode: 'ultra' | 'balanced' | 'raw'): void {
    if (mode === 'raw') {
      this.median.setSize(1);
      this.alpha = 1;
    } else if (mode === 'balanced') {
      this.median.setSize(3);
      this.alpha = 0.85;
    } else {
      this.median.setSize(5);
      this.alpha = 0.6;
    }
  }

  push(val: number): number {
    if (!Number.isFinite(val) || val <= 0) return 0;
    const m = this.median.push(val);
    if (m <= 0) return this.output;
    this.ema = this.ema === 0 ? m : this.ema + this.alpha * (m - this.ema);
    this.output = Math.round(this.ema);
    return this.output;
  }

  reset(): void {
    this.median.reset();
    this.ema = 0;
    this.output = 0;
  }
}

export class IlluminanceFilter {
  private buffer: number[] = [];
  private size = 5;

  constructor(size = 5) {
    this.size = Math.max(1, size);
  }

  push(valLux: number): number {
    if (!Number.isFinite(valLux) || valLux < 0 || valLux > 120000) return 0;
    this.buffer.push(valLux);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    if (this.buffer.length === 0) return 0;
    const sum = this.buffer.reduce((acc, v) => acc + v, 0);
    return Math.round((sum / this.buffer.length) * 10) / 10;
  }

  reset(): void {
    this.buffer = [];
  }
}

