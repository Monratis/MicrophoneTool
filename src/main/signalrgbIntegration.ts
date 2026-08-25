import { shell } from 'electron';
import type Config from './config';

interface SavedLightingState {
  currentEffect?: string;
  currentPreset?: string;
  globalBrightness: number;
}

export default class SignalRGBIntegration {
  private readonly config: Config | null;
  private previousState: SavedLightingState | null = null;
  private isAwayApplied = false;

  constructor({ config }: { config: Config }) {
    this.config = config;
  }

  private getBaseUrl(): string {
    const port = (this.config && this.config.get('signalrgbPort')) || 16038;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  async probe(): Promise<{ connected: boolean; status?: number; data?: unknown }> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting`, {
        signal: AbortSignal.timeout(1200)
      });
      if (res.ok) {
        const data = await res.json();
        return { connected: true, data };
      }
      return { connected: false, status: res.status };
    } catch {
      return { connected: false };
    }
  }

  private async saveCurrentState(): Promise<void> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting`, {
        signal: AbortSignal.timeout(1200)
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        this.previousState = {
          currentEffect: (data.current_effect || data.effect) as string | undefined,
          currentPreset: (data.current_preset || data.preset) as string | undefined,
          globalBrightness: typeof data.global_brightness === 'number' ? data.global_brightness : 100
        };
      }
    } catch {
      // Ignoruj błąd jeśli SignalRGB nie odpowiada
    }
  }

  async onAway(): Promise<void> {
    if (!this.config || !this.config.get('signalrgbEnabled')) return;

    await this.saveCurrentState();

    const action = this.config.get('signalrgbAwayAction') || 'solid_color';
    const color = (this.config.get('signalrgbAwayColor') || '#f59e0b').replace(/^#/, '');
    const brightness = Number(this.config.get('signalrgbAwayBrightness') ?? 0);

    try {
      if (action === 'turn_off') {
        await this.setGlobalBrightness(0);
      } else if (action === 'dim') {
        await this.setGlobalBrightness(Math.max(0, Math.min(100, brightness)));
      } else if (action === 'solid_color') {
        const applied = await this.applyEffect('Solid Color', { color: `#${color}` });
        if (!applied) {
          shell
            .openExternal(`signalrgb://effect/apply/Solid%20Color?color=${color}&-silentlaunch-`)
            .catch(() => {});
        }
      }
      this.isAwayApplied = true;
    } catch (err) {
      console.warn('[signalrgb] onAway error:', (err as Error).message);
    }
  }

  async onDesk(): Promise<void> {
    if (!this.config || !this.config.get('signalrgbEnabled')) return;
    if (!this.config.get('signalrgbRestoreOnDesk')) return;
    if (!this.isAwayApplied && !this.previousState) return;

    try {
      const action = this.config.get('signalrgbAwayAction') || 'solid_color';

      if (action === 'turn_off' || action === 'dim') {
        const targetBrightness = this.previousState?.globalBrightness ?? 100;
        await this.setGlobalBrightness(targetBrightness);
      } else if (action === 'solid_color') {
        if (this.previousState?.currentEffect) {
          await this.applyEffect(this.previousState.currentEffect);
        } else {
          await this.setGlobalBrightness(100);
        }
      }

      this.isAwayApplied = false;
      this.previousState = null;
    } catch (err) {
      console.warn('[signalrgb] onDesk error:', (err as Error).message);
    }
  }

  async setGlobalBrightness(val: number): Promise<boolean> {
    try {
      await fetch(`${this.getBaseUrl()}/lighting/global_brightness`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_brightness: val }),
        signal: AbortSignal.timeout(1500)
      });
      return true;
    } catch {
      return false;
    }
  }

  async applyEffect(effectName: string, params: Record<string, unknown> = {}): Promise<boolean> {
    try {
      const enc = encodeURIComponent(effectName);
      const res = await fetch(`${this.getBaseUrl()}/lighting/effect/${enc}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(1500)
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
