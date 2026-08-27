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
    if (val <= 0) return 0;
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

export class MovingAverageFilter {
  private buffer: number[] = [];
  private size: number;

  constructor(size = 5) {
    this.size = Math.max(1, size);
  }

  push(val: number): number {
    if (val <= 0) return 0;
    this.buffer.push(val);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    const sum = this.buffer.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / this.buffer.length);
  }

  reset(): void {
    this.buffer = [];
  }
}

export class DistanceFilter {
  private median: MedianFilter;

  constructor(size = 5) {
    this.median = new MedianFilter(size);
  }

  setMode(mode: 'ultra' | 'balanced' | 'raw'): void {
    if (mode === 'raw') {
      this.median.setSize(1);
    } else if (mode === 'balanced') {
      this.median.setSize(3);
    } else {
      this.median.setSize(5);
    }
  }

  push(valCm: number): number {
    if (valCm <= 0 || valCm > 800) return 0;
    return this.median.push(valCm);
  }

  reset(): void {
    this.median.reset();
  }
}

export class IlluminanceFilter {
  private buffer: number[] = [];
  private size = 5;

  constructor(size = 5) {
    this.size = Math.max(1, size);
  }

  push(valLux: number): number {
    if (valLux < 0 || valLux > 120000) return 0;
    this.buffer.push(valLux);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    const sum = this.buffer.reduce((acc, v) => acc + v, 0);
    return Math.round((sum / this.buffer.length) * 10) / 10;
  }

  reset(): void {
    this.buffer = [];
  }
}

