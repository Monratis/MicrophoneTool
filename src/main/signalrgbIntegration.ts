import { shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Config from './config';

/**
 * Integracja z SignalRGB wg oficjalnej dokumentacji Local API
 * (docs.signalrgb.com/developer/signalrgb-api):
 *   - REST: http://127.0.0.1:16038/api/v1 — WYMAGA SignalRGB Pro dla większości
 *     endpointów (bez Pro przychodzi 403 Forbidden).
 *   - Deep-linki signalrgb://effect/apply/<Nazwa>?parametry — oficjalny mechanizm
 *     launchu (używany przez ich stronę), działa bez Pro; jako JEDYNY przenosi
 *     parametry efektu (np. kolor Solid Color).
 * Strategia "max bez Pro": sonda REST z detekcją 403, akcje z fallbackiem na
 * deep-link, uczciwy status zamiast cichej porażki.
 */

interface SavedLightingState {
  effectName?: string;
  globalBrightness?: number;
  enabled?: boolean;
}

export interface SignalRGBActionResult {
  ok: boolean;
  /** rest = przez Local API, deeplink = signalrgb:// (bez Pro), none = nic nie wysłano */
  via?: 'rest' | 'deeplink' | 'none';
  reason?: string;
}

const PROBE_TTL_MS = 60_000;

export default class SignalRGBIntegration {
  private readonly config: Config | null;
  private previousState: SavedLightingState | null = null;
  private isAwayApplied = false;
  /** null = sonda jeszcze nie wykonana; wynik cache'owany na PROBE_TTL_MS */
  private restAvailable: boolean | null = null;
  private proRequired = false;
  private lastProbeAt = 0;
  /** Treść odmowy z API (np. "You must be a SignalRGB Pro user...") — dla UI */
  private lastProbeDetail = '';
  /** nazwa efektu -> ID z GET /lighting/effects (payload duży wg docs — raz na sesję) */
  private effectIdCache: Map<string, string> | null = null;

  constructor({ config }: { config: Config }) {
    this.config = config;
  }

  private getBaseUrl(): string {
    const port = (this.config && this.config.get('signalrgbPort')) || 16038;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  /**
   * Sonda dostępności REST przez GET /lighting. 403 = brak Pro (dokumentacja:
   * "The SignalRGB Local API requires SignalRGB Pro for most endpoints").
   */
  private async probeRest(): Promise<boolean> {
    const now = Date.now();
    if (this.restAvailable !== null && now - this.lastProbeAt < PROBE_TTL_MS) {
      return this.restAvailable;
    }
    this.lastProbeAt = now;
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting`, {
        signal: AbortSignal.timeout(1200)
      });
      if (res.ok) {
        this.restAvailable = true;
        this.proRequired = false;
        this.lastProbeDetail = '';
      } else if (res.status === 403) {
        this.restAvailable = false;
        this.proRequired = true;
        this.lastProbeDetail = await this.readErrorDetail(res);
      } else {
        this.restAvailable = false;
        this.lastProbeDetail = `HTTP ${res.status}`;
      }
    } catch {
      this.restAvailable = false;
      this.lastProbeDetail = '';
    }
    return this.restAvailable;
  }

  private async readErrorDetail(res: Response): Promise<string> {
    try {
      const json = (await res.json()) as { errors?: { detail?: string }[] };
      return json.errors?.[0]?.detail || '';
    } catch {
      return '';
    }
  }

  /** Pełny status dla UI: dostępność REST + powód odmowy (np. brak Pro). */
  async inspect(): Promise<{ restAvailable: boolean; proRequired: boolean; detail: string }> {
    const rest = await this.probeRest();
    return { restAvailable: rest, proRequired: this.proRequired, detail: this.lastProbeDetail };
  }

  getStatus(): { restAvailable: boolean; proRequired: boolean } {
    return { restAvailable: this.restAvailable === true, proRequired: this.proRequired };
  }

  /**
   * Lista zainstalowanych efektów odczytana Z DYSKU — darmowa alternatywa dla
   * GET /lighting/effects (403 bez Pro). SignalRGB trzyma efekty jako
   * pliki "<Nazwa>.html" w %LOCALAPPDATA%/VortxEngine/app-[wersja]/Signal-x64/
   * Effects/{Dynamic,Static}, a nazwa pliku odpowiada nazwie w deep-linku
   * signalrgb://effect/apply/<Nazwa>.
   */
  listLocalEffects(): string[] {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const vortxRoot = path.join(localAppData, 'VortxEngine');
    const names = new Set<string>();
    try {
      const appDirs = fs.readdirSync(vortxRoot).filter((d) => /^app-/i.test(d));
      for (const appDir of appDirs) {
        const effectsRoot = path.join(vortxRoot, appDir, 'Signal-x64', 'Effects');
        let subdirs: string[];
        try {
          subdirs = fs
            .readdirSync(effectsRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch {
          continue;
        }
        for (const sub of subdirs) {
          try {
            for (const file of fs.readdirSync(path.join(effectsRoot, sub))) {
              if (file.toLowerCase().endsWith('.html')) {
                names.add(file.slice(0, -5));
              }
            }
          } catch {
            /* pomiń nieczytelny podkatalog */
          }
        }
      }
    } catch {
      /* brak VortxEngine — lista niedostępna, UI zostaje free-text */
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'en'));
  }

  /**
   * Zapis stanu sprzed odejścia — możliwy WYŁĄCZNIE przez REST (GET /lighting).
   * Kształt odpowiedzi wg docs: data.attributes.name / global_brightness / enabled.
   */
  private async saveCurrentState(): Promise<void> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting`, {
        signal: AbortSignal.timeout(1200)
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: { id?: string; attributes?: { name?: string; enabled?: boolean; global_brightness?: number } };
      };
      const attrs = json.data?.attributes;
      this.previousState = {
        effectName: attrs?.name || (json.data?.id || '').replace(/\.html$/i, ''),
        globalBrightness: typeof attrs?.global_brightness === 'number' ? attrs.global_brightness : 100,
        enabled: typeof attrs?.enabled === 'boolean' ? attrs.enabled : true
      };
    } catch {
      /* bez REST nie ma z czego przywracać — fallback: signalrgbDeskEffect */
    }
  }

  /** GET /lighting/effects + mapowanie nazwy na nieprzezroczyste ID (efekty adresuje się po ID). */
  private async fetchEffectIdByName(name: string): Promise<string | null> {
    if (this.effectIdCache?.has(name)) return this.effectIdCache.get(name)!;
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting/effects`, {
        signal: AbortSignal.timeout(2500)
      });
      if (res.status === 403) this.proRequired = true;
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: { items?: { id?: string; attributes?: { name?: string } }[] };
      };
      const map = new Map<string, string>();
      for (const item of json.data?.items || []) {
        if (item.id && item.attributes?.name) map.set(item.attributes.name, item.id);
      }
      this.effectIdCache = map;
      return map.get(name) || null;
    } catch {
      return null;
    }
  }

  /** POST /lighting/effects/{id}/apply — wg docs bez body, identyfikator = ID. */
  private async applyRestByName(name: string): Promise<boolean> {
    const id = await this.fetchEffectIdByName(name);
    if (!id) return false;
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting/effects/${encodeURIComponent(id)}/apply`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok) {
        if (res.status === 403) this.proRequired = true;
        // 404 mogło wynikać z nieaktualnego cache efektów — następnym razem pobierz od nowa
        this.effectIdCache = null;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async setGlobalBrightness(val: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting/global_brightness`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_brightness: val }),
        signal: AbortSignal.timeout(1500)
      });
      if (res.status === 403) this.proRequired = true;
      return res.ok;
    } catch {
      return false;
    }
  }

  /** PATCH /lighting/enabled — docs: false = "all devices will receive black". */
  async setEnabled(enabled: boolean): Promise<boolean> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/lighting/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        signal: AbortSignal.timeout(1500)
      });
      if (res.status === 403) this.proRequired = true;
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Deep-link signalrgb://effect/apply/<Nazwa>?parametry — oficjalny mechanizm
   * launchu, nie przechodzi przez REST, więc nie podlega gatingowi Pro.
   * -silentlaunch- to udokumentowany parametr launchu bez przejmowania fokusu.
   */
  private launchDeepLink(effectName: string, params: Record<string, string> = {}): boolean {
    try {
      const enc = encodeURIComponent(effectName);
      const query = new URLSearchParams(params).toString();
      const url = `signalrgb://effect/apply/${enc}?${query}${query ? '&' : ''}-silentlaunch-`;
      void shell.openExternal(url).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parametry koloru dla efektu Solid Color. Nazwy parametrów w deep-linku są
   * case-sensitive, a społeczność raportuje i "color", i "Color" — wysyłamy obie
   * formy (nieznane parametry SignalRGB ignoruje), żeby kolor trafił niezależnie
   * od wersji efektu.
   */
  private solidColorParams(hex: string): Record<string, string> {
    const value = hex.replace(/^#/, '');
    return { color: value, Color: value };
  }

  async onAway(): Promise<SignalRGBActionResult> {
    if (!this.config || !this.config.get('signalrgbEnabled')) {
      return { ok: false, via: 'none', reason: 'Integracja SignalRGB wyłączona w ustawieniach' };
    }
    const action = this.config.get('signalrgbAwayAction') || 'solid_color';

    // Stan sprzed odejścia da się zapisać tylko przez REST — bez Pro przywracanie
    // polegnie na efekcie powrotu z signalrgbDeskEffect.
    const restOk = await this.probeRest();
    if (restOk) await this.saveCurrentState();

    try {
      if (action === 'turn_off') {
        if (restOk) {
          const ok = await this.setEnabled(false);
          if (ok) return { ok: true, via: 'rest' };
        }
        // Bez REST: czarny Solid Color daje ten sam efekt wizualny, co enabled:false
        // (dokumentacja: wtedy "all devices will receive black").
        return {
          ok: this.launchDeepLink('Solid Color', this.solidColorParams('#000000')),
          via: 'deeplink',
          reason: restOk ? undefined : 'REST niedostępny — użyto czarnego Solid Color (deep-link)'
        };
      }

      if (action === 'dim') {
        // Jasność istnieje wyłącznie w REST (PATCH global_brightness) — deep-linki
        // nie wystawiają jasności, więc bez Pro ta akcja jest niewykonalna.
        if (!restOk) {
          return {
            ok: false,
            via: 'none',
            reason: this.proRequired
              ? 'Przyciemnienie wymaga REST, a Local API bez SignalRGB Pro zwraca 403'
              : 'SignalRGB nie odpowiada na REST (apka uruchomiona?)'
          };
        }
        const brightness = Math.max(0, Math.min(100, Number(this.config.get('signalrgbAwayBrightness') ?? 0)));
        const ok = await this.setGlobalBrightness(brightness);
        return ok
          ? { ok: true, via: 'rest' }
          : { ok: false, reason: 'REST nie przyjął global_brightness' };
      }

      // solid_color: kolor/parametry przenosi WYŁĄCZNIE deep-link (REST apply
      // nie przyjmuje parametrów), więc to główna ścieżka — działa też bez Pro.
      // Efekt jest konfigurowalny (dowolny zainstalowany, nazwa case-sensitive),
      // domyślnie Solid Color; parametry koloru efekty bez niego po prostu ignorują.
      const effectName = (this.config.get('signalrgbAwayEffect') || '').trim() || 'Solid Color';
      const color = this.config.get('signalrgbAwayColor') || '#f59e0b';
      const launched = this.launchDeepLink(effectName, this.solidColorParams(color));
      return launched
        ? { ok: true, via: 'deeplink' }
        : { ok: false, reason: 'Nie udało się otworzyć deep-linku signalrgb://' };
    } finally {
      this.isAwayApplied = true;
    }
  }

  async onDesk(): Promise<SignalRGBActionResult> {
    if (!this.config || !this.config.get('signalrgbEnabled')) {
      return { ok: false, via: 'none', reason: 'Integracja SignalRGB wyłączona w ustawieniach' };
    }
    if (!this.config.get('signalrgbRestoreOnDesk')) {
      return { ok: true, via: 'none', reason: 'Przywracanie po powrocie wyłączone w ustawieniach' };
    }
    if (!this.isAwayApplied && !this.previousState) {
      return { ok: true, via: 'none', reason: 'Brak akcji odejścia do odwrócenia' };
    }

    const restOk = await this.probeRest();
    try {
      if (restOk) {
        // Kolejność wg docs: włącz canvas -> jasność -> efekt sprzed odejścia.
        if (this.previousState?.enabled === false) await this.setEnabled(true);
        if (typeof this.previousState?.globalBrightness === 'number') {
          await this.setGlobalBrightness(this.previousState.globalBrightness);
        }
        if (this.previousState?.effectName) {
          const applied = await this.applyRestByName(this.previousState.effectName);
          if (applied) {
            this.resetAwayState();
            return { ok: true, via: 'rest' };
          }
        }
      }

      // Fallback bez Pro (albo gdy REST-restore zawodzi): stały efekt powrotu
      // wskazany przez użytkownika w ustawieniach.
      const deskEffect = (this.config.get('signalrgbDeskEffect') || '').trim();
      if (deskEffect) {
        const launched = this.launchDeepLink(deskEffect);
        if (launched) {
          this.resetAwayState();
          return { ok: true, via: 'deeplink' };
        }
      }

      return {
        ok: false,
        reason: restOk
          ? 'Nie udało się odtworzyć zapisanego efektu przez REST'
          : 'Brak REST (Local API wymaga SignalRGB Pro) i nie ustawiono efektu powrotu'
      };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  private resetAwayState(): void {
    this.isAwayApplied = false;
    this.previousState = null;
  }
}
