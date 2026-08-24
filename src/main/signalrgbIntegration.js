import { shell } from 'electron';

export default class SignalRGBIntegration {
  constructor({ config }) {
    this.config = config;
    this.previousState = null;
    this.isAwayApplied = false;
  }

  getBaseUrl() {
    const port = (this.config && this.config.get('signalrgbPort')) || 16038;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  /**
   * Sprawdza czy SignalRGB i jego HTTP API są aktywne.
   */
  async probe() {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting`, {
        signal: AbortSignal.timeout(1200)
      });
      if (res.ok) {
        const data = await res.json();
        return { connected: true, data };
      }
      return { connected: false, status: res.status };
    } catch (_) {
      return { connected: false };
    }
  }

  /**
   * Pobiera aktualny stan oświetlenia (efekt, jasność), aby móc go przywrócić po powrocie.
   */
  async saveCurrentState() {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting`, {
        signal: AbortSignal.timeout(1200)
      });
      if (res.ok) {
        const data = await res.json();
        this.previousState = {
          currentEffect: data.current_effect || data.effect,
          currentPreset: data.current_preset || data.preset,
          globalBrightness: typeof data.global_brightness === 'number' ? data.global_brightness : 100
        };
      }
    } catch (_) {
      // Ignoruj błąd jeśli SignalRGB nie odpowiada
    }
  }

  /**
   * Wywoływane gdy użytkownik odchodzi od biurka (Tryb mobilny).
   */
  async onAway() {
    if (!this.config || !this.config.get('signalrgbEnabled')) return;

    // Zapisz aktualny stan przed zmianą
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
        // 1. Spróbuj przez REST API
        const applied = await this.applyEffect('Solid Color', { color: `#${color}` });
        if (!applied) {
          // 2. Fallback do protokołu URI
          shell.openExternal(`signalrgb://effect/apply/Solid%20Color?color=${color}&-silentlaunch-`).catch(() => {});
        }
      }
      this.isAwayApplied = true;
    } catch (err) {
      console.warn('[signalrgb] onAway error:', err.message);
    }
  }

  /**
   * Wywoływane gdy użytkownik wraca do biurka (Tryb stacjonarny).
   */
  async onDesk() {
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
          // Domyślny powrót do 100% jasności
          await this.setGlobalBrightness(100);
        }
      }

      this.isAwayApplied = false;
      this.previousState = null;
    } catch (err) {
      console.warn('[signalrgb] onDesk error:', err.message);
    }
  }

  async setGlobalBrightness(val) {
    try {
      await fetch(`${this.getBaseUrl()}/lighting/global_brightness`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_brightness: val }),
        signal: AbortSignal.timeout(1500)
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async applyEffect(effectName, params = {}) {
    try {
      const enc = encodeURIComponent(effectName);
      const res = await fetch(`${this.getBaseUrl()}/lighting/effect/${enc}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(1500)
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }
}
