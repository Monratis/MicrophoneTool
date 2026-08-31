import { shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Config from './config';
import { appendLog } from './logger';

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
    const url = `${this.getBaseUrl()}/lighting`;
    try {
      appendLog('SIGNALRGB', `Sonda REST -> GET ${url}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(1200)
      });
      if (res.ok) {
        this.restAvailable = true;
        this.proRequired = false;
        this.lastProbeDetail = '';
        appendLog('SIGNALRGB', `Sonda REST: Połączono (HTTP ${res.status}) — SignalRGB Pro aktywne, pełne API REST dostępne`);
      } else if (res.status === 403) {
        this.restAvailable = false;
        this.proRequired = true;
        this.lastProbeDetail = await this.readErrorDetail(res);
        appendLog(
          'SIGNALRGB',
          `Sonda REST: Odmowa (HTTP 403 Forbidden) — brak licencji SignalRGB Pro. Przełączam na tryb darmowy (deep-link signalrgb://). Szczegóły: "${this.lastProbeDetail}"`
        );
      } else {
        this.restAvailable = false;
        this.lastProbeDetail = `HTTP ${res.status}`;
        appendLog('SIGNALRGB', `Sonda REST: Odpowiedź HTTP ${res.status} (${res.statusText})`);
      }
    } catch (err) {
      this.restAvailable = false;
      this.lastProbeDetail = '';
      appendLog('SIGNALRGB', `Sonda REST: Brak odpowiedzi z ${url} (${(err as Error).message})`);
    }
    return this.restAvailable;
  }

  private async readErrorDetail(res: Response): Promise<string> {
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as { errors?: { detail?: string; title?: string }[]; message?: string };
        return json.errors?.[0]?.detail || json.errors?.[0]?.title || json.message || text;
      } catch {
        return text || '';
      }
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
   * GET /lighting/effects (403 bez Pro). SignalRGB trzyma efekty w:
   * 1. %LOCALAPPDATA%/VortxEngine/app-[wersja]/Signal-x64/Effects/{Dynamic,Static}/<Nazwa>.html
   * 2. %LOCALAPPDATA%/WhirlwindFX/SignalRgb/cache/effects/[ID]/effect.html (<title>Nazwa</title>)
   * 3. Dokumentach użytkownika / WhirlwindFX / Effects
   * Nazwa pliku / tytuł odpowiada nazwie w deep-linku signalrgb://effect/apply/<Nazwa>.
   */
  listLocalEffects(): string[] {
    appendLog('SIGNALRGB', 'Skanowanie dysku w poszukiwaniu zainstalowanych efektów SignalRGB…');
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const userProfile = process.env.USERPROFILE || os.homedir();
    const names = new Set<string>();

    // 1. Wbudowane szablony efektów w VortxEngine
    const vortxRoot = path.join(localAppData, 'VortxEngine');
    try {
      const appDirs = fs.readdirSync(vortxRoot).filter((d) => /^app-/i.test(d));
      for (const appDir of appDirs) {
        const effectsRoot = path.join(vortxRoot, appDir, 'Signal-x64', 'Effects');
        let subdirs: string[] = [];
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
      /* brak VortxEngine */
    }

    // 2. Efekty pobrane z Marketplace / biblioteki w cache WhirlwindFX
    const cacheDir = path.join(localAppData, 'WhirlwindFX', 'SignalRgb', 'cache', 'effects');
    if (fs.existsSync(cacheDir)) {
      try {
        const effectDirs = fs.readdirSync(cacheDir);
        for (const d of effectDirs) {
          const htmlPath = path.join(cacheDir, d, 'effect.html');
          if (fs.existsSync(htmlPath)) {
            try {
              const content = fs.readFileSync(htmlPath, 'utf8');
              const match = content.match(/<title>(.*?)<\/title>/i);
              if (match && match[1]) {
                const name = match[1].trim();
                if (name) names.add(name);
              }
            } catch {
              /* pomiń uszkodzony plik efektu */
            }
          }
        }
      } catch {
        /* brak katalogu cache */
      }
    }

    // 3. Własne efekty użytkownika w Dokumentach i AppData
    const userEffectsDirs = [
      path.join(userProfile, 'Documents', 'WhirlwindFX', 'Effects'),
      path.join(userProfile, 'Documents', 'WhirlwindFX', 'SignalRgb', 'Effects'),
      path.join(appData, 'WhirlwindFX', 'SignalRgb', 'Effects'),
      path.join(localAppData, 'WhirlwindFX', 'SignalRgb', 'Effects')
    ];

    for (const dir of userEffectsDirs) {
      if (fs.existsSync(dir)) {
        try {
          for (const file of fs.readdirSync(dir)) {
            if (file.toLowerCase().endsWith('.html')) {
              names.add(file.slice(0, -5));
            }
          }
        } catch {
          /* pomiń */
        }
      }
    }

    // Gwarantowane domyślne efekty SignalRGB
    if (names.size === 0) {
      ['Solid Color', 'Neon Shift', 'Rainbow', 'Screen Ambience', 'Color Shift', 'Side To Side'].forEach((n) =>
        names.add(n)
      );
    }

    const sorted = Array.from(names).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    appendLog('SIGNALRGB', `Znaleziono ${sorted.length} zainstalowanych efektów SignalRGB`);
    return sorted;
  }

  /**
   * Ręczne/testowe zastosowanie wybranego efektu (z opcjonalnym kolorem).
   * Działa z Pro (REST) oraz bez Pro (deep-link).
   */
  async applyEffect(effectName: string, color?: string): Promise<SignalRGBActionResult> {
    const name = (effectName || '').trim();
    if (!name) {
      appendLog('SIGNALRGB', 'Próba zastosowania efektu z pustą nazwą');
      return { ok: false, reason: 'Brak nazwy efektu' };
    }
    appendLog('SIGNALRGB', `Ręczne/testowe zastosowanie efektu: "${name}"${color ? ` (kolor: ${color})` : ''}`);
    const restOk = await this.probeRest();
    if (restOk && !color) {
      const applied = await this.applyRestByName(name);
      if (applied) {
        appendLog('SIGNALRGB', `Efekt "${name}" zaaplikowany pomyślnie przez REST`);
        return { ok: true, via: 'rest' };
      }
      appendLog('SIGNALRGB', `Aplikowanie przez REST nie powiodło się dla "${name}" — próba przez deep-link`);
    }
    // Deep-link launch (obsługuje parametry koloru oraz działa bez Pro)
    const params = color ? this.solidColorParams(color) : {};
    const launched = this.launchDeepLink(name, params);
    const result: SignalRGBActionResult = launched
      ? { ok: true, via: 'deeplink' }
      : { ok: false, reason: 'Nie udało się otworzyć deep-linku signalrgb://' };
    appendLog(
      'SIGNALRGB',
      `Wynik zastosowania efektu "${name}": ${result.ok ? 'SUKCES' : 'BŁĄD'} (${result.via || 'none'}${result.reason ? ` — ${result.reason}` : ''})`
    );
    return result;
  }

  /**
   * Zapis stanu sprzed odejścia — możliwy WYŁĄCZNIE przez REST (GET /lighting).
   * Kształt odpowiedzi wg docs: data.attributes.name / global_brightness / enabled.
   */
  private async saveCurrentState(): Promise<void> {
    const url = `${this.getBaseUrl()}/lighting`;
    try {
      appendLog('SIGNALRGB', `Pobieranie bieżącego stanu oświetlenia -> GET ${url}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(1200)
      });
      if (!res.ok) {
        appendLog('SIGNALRGB', `Nie udało się pobrać bieżącego stanu oświetlenia: HTTP ${res.status}`);
        return;
      }
      const rawText = await res.text();
      let json: {
        data?: { id?: string; attributes?: { name?: string; enabled?: boolean; global_brightness?: number } };
      };
      try {
        json = JSON.parse(rawText);
      } catch {
        appendLog('SIGNALRGB', `Niepoprawna odpowiedź JSON z ${url}: ${rawText}`);
        return;
      }
      const attrs = json.data?.attributes;
      this.previousState = {
        effectName: attrs?.name || (json.data?.id || '').replace(/\.html$/i, ''),
        globalBrightness: typeof attrs?.global_brightness === 'number' ? attrs.global_brightness : 100,
        enabled: typeof attrs?.enabled === 'boolean' ? attrs.enabled : true
      };
      appendLog(
        'SIGNALRGB',
        `Zapisano stan oświetlenia sprzed odejścia: efekt="${this.previousState.effectName}", jasność=${this.previousState.globalBrightness}%, włączone=${this.previousState.enabled}`
      );
    } catch (err) {
      appendLog('SIGNALRGB', `Błąd podczas zapisu stanu oświetlenia: ${(err as Error).message}`);
    }
  }

  /** GET /lighting/effects + mapowanie nazwy na nieprzezroczyste ID (efekty adresuje się po ID). */
  private async fetchEffectIdByName(name: string): Promise<string | null> {
    if (this.effectIdCache?.has(name)) return this.effectIdCache.get(name)!;
    const url = `${this.getBaseUrl()}/lighting/effects`;
    try {
      appendLog('SIGNALRGB', `Pobieranie identyfikatora efektu "${name}" -> GET ${url}`);
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2500)
      });
      if (res.status === 403) this.proRequired = true;
      if (!res.ok) {
        appendLog('SIGNALRGB', `Błąd pobierania listy efektów: HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as {
        data?: { items?: { id?: string; attributes?: { name?: string } }[] };
      };
      const map = new Map<string, string>();
      for (const item of json.data?.items || []) {
        if (item.id && item.attributes?.name) map.set(item.attributes.name, item.id);
      }
      this.effectIdCache = map;
      const foundId = map.get(name) || null;
      appendLog('SIGNALRGB', `Zmapowano ${map.size} efektów REST. ID dla "${name}": ${foundId ?? 'NIE ZNALEZIONO'}`);
      return foundId;
    } catch (err) {
      appendLog('SIGNALRGB', `Wyjątek podczas pobierania listy efektów: ${(err as Error).message}`);
      return null;
    }
  }

  /** POST /lighting/effects/{id}/apply — wg docs bez body, identyfikator = ID. */
  private async applyRestByName(name: string): Promise<boolean> {
    const id = await this.fetchEffectIdByName(name);
    if (!id) {
      appendLog('SIGNALRGB', `Brak ID REST dla efektu "${name}" — pomijam wywołanie REST`);
      return false;
    }
    const url = `${this.getBaseUrl()}/lighting/effects/${encodeURIComponent(id)}/apply`;
    try {
      appendLog('SIGNALRGB', `Aplikowanie efektu REST "${name}" (${id}) -> POST ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok) {
        if (res.status === 403) this.proRequired = true;
        const errDetail = await this.readErrorDetail(res);
        appendLog('SIGNALRGB', `Błąd aplikowania efektu REST "${name}": HTTP ${res.status} ${errDetail}`);
        this.effectIdCache = null;
        return false;
      }
      appendLog('SIGNALRGB', `Pomyślnie zaaplikowano efekt REST "${name}" (${id})`);
      return true;
    } catch (err) {
      appendLog('SIGNALRGB', `Wyjątek podczas aplikowania efektu REST "${name}": ${(err as Error).message}`);
      return false;
    }
  }

  async setGlobalBrightness(val: number): Promise<boolean> {
    const url = `${this.getBaseUrl()}/lighting/global_brightness`;
    try {
      appendLog('SIGNALRGB', `Ustawianie jasności globalnej REST na ${val}% -> PATCH ${url}`);
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_brightness: val }),
        signal: AbortSignal.timeout(1500)
      });
      if (res.status === 403) this.proRequired = true;
      if (!res.ok) {
        const errDetail = await this.readErrorDetail(res);
        appendLog('SIGNALRGB', `Błąd ustawiania jasności: HTTP ${res.status} ${errDetail}`);
        return false;
      }
      appendLog('SIGNALRGB', `Pomyślnie ustawiono jasność globalną na ${val}%`);
      return true;
    } catch (err) {
      appendLog('SIGNALRGB', `Wyjątek podczas ustawiania jasności: ${(err as Error).message}`);
      return false;
    }
  }

  /** PATCH /lighting/enabled — docs: false = "all devices will receive black". */
  async setEnabled(enabled: boolean): Promise<boolean> {
    const url = `${this.getBaseUrl()}/lighting/enabled`;
    try {
      appendLog('SIGNALRGB', `Ustawianie stanu zasilania LED REST (${enabled ? 'ON' : 'OFF'}) -> PATCH ${url}`);
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        signal: AbortSignal.timeout(1500)
      });
      if (res.status === 403) this.proRequired = true;
      if (!res.ok) {
        const errDetail = await this.readErrorDetail(res);
        appendLog('SIGNALRGB', `Błąd ustawiania stanu zasilania: HTTP ${res.status} ${errDetail}`);
        return false;
      }
      appendLog('SIGNALRGB', `Pomyślnie ustawiono stan zasilania LED na ${enabled ? 'WŁĄCZONE' : 'WYŁĄCZONE'}`);
      return true;
    } catch (err) {
      appendLog('SIGNALRGB', `Wyjątek podczas ustawiania stanu zasilania: ${(err as Error).message}`);
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
      appendLog('SIGNALRGB', `Uruchamianie deep-link: ${url}`);
      void shell.openExternal(url).catch((err) => {
        appendLog('SIGNALRGB', `Błąd otwierania deep-link (${url}): ${(err as Error).message}`);
      });
      return true;
    } catch (err) {
      appendLog('SIGNALRGB', `Wyjątek przy tworzeniu deep-link: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Parametry koloru dla efektu Solid Color (i innych efektów obsługujących kolor).
   * SignalRGB (silnik Qt QColor) wymaga prefiksu '#' w wartości koloru, by poprawnie
   * zinterpretować kod HEX (np. #f59e0b). URLSearchParams zamienia '#' na '%23' w URL,
   * co Qt decyduje z powrotem do '#f59e0b'.
   * Wysyłamy popularne nazwy właściwości (color, Color, color1, col1), aby obsłużyć
   * różne szablony efektów SignalRGB.
   */
  private solidColorParams(hex: string): Record<string, string> {
    const raw = (hex || '').trim();
    if (!raw) return {};
    const formatted = raw.startsWith('#') ? raw : `#${raw}`;
    return {
      color: formatted,
      Color: formatted,
      color1: formatted,
      col1: formatted
    };
  }

  async onAway(): Promise<SignalRGBActionResult> {
    if (!this.config || !this.config.get('signalrgbEnabled')) {
      appendLog('SIGNALRGB', 'Zdarzenie ODEJŚCIE: Integracja SignalRGB wyłączona w ustawieniach');
      return { ok: false, via: 'none', reason: 'Integracja SignalRGB wyłączona w ustawieniach' };
    }
    const action = this.config.get('signalrgbAwayAction') || 'solid_color';
    appendLog('SIGNALRGB', `Zdarzenie ODEJŚCIE: Wykonywanie akcji "${action}"`);

    // Stan sprzed odejścia da się zapisać tylko przez REST — bez Pro przywracanie
    // polegnie na efekcie powrotu z signalrgbDeskEffect.
    const restOk = await this.probeRest();
    if (restOk) await this.saveCurrentState();

    try {
      if (action === 'turn_off') {
        if (restOk) {
          const ok = await this.setEnabled(false);
          if (ok) {
            appendLog('SIGNALRGB', 'Zgaszono oświetlenie przez REST (PATCH enabled: false)');
            return { ok: true, via: 'rest' };
          }
        }
        // Bez REST: czarny Solid Color daje ten sam efekt wizualny, co enabled:false
        // (dokumentacja: wtedy "all devices will receive black").
        appendLog('SIGNALRGB', 'Wyłączanie oświetlenia: wysyłam czarny Solid Color (#000000) przez deep-link');
        const ok = this.launchDeepLink('Solid Color', this.solidColorParams('#000000'));
        return {
          ok,
          via: 'deeplink',
          reason: restOk ? undefined : 'REST niedostępny — użyto czarnego Solid Color (deep-link)'
        };
      }

      if (action === 'dim') {
        // Jasność istnieje wyłącznie w REST (PATCH global_brightness) — deep-linki
        // nie wystawiają jasności, więc bez Pro ta akcja jest niewykonalna.
        if (!restOk) {
          const reason = this.proRequired
            ? 'Przyciemnienie wymaga REST, a Local API bez SignalRGB Pro zwraca 403'
            : 'SignalRGB nie odpowiada na REST (apka uruchomiona?)';
          appendLog('SIGNALRGB', `Niepowodzenie przyciemnienia: ${reason}`);
          return {
            ok: false,
            via: 'none',
            reason
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
      appendLog('SIGNALRGB', `Aplikowanie efektu odejścia "${effectName}" z kolorem "${color}"`);
      const launched = this.launchDeepLink(effectName, this.solidColorParams(color));
      const res: SignalRGBActionResult = launched
        ? { ok: true, via: 'deeplink' }
        : { ok: false, reason: 'Nie udało się otworzyć deep-linku signalrgb://' };
      appendLog('SIGNALRGB', `Wynik akcji odejścia: ${res.ok ? 'OK' : 'BŁĄD'} (via: ${res.via || 'none'})`);
      return res;
    } finally {
      this.isAwayApplied = true;
    }
  }

  async onDesk(): Promise<SignalRGBActionResult> {
    if (!this.config || !this.config.get('signalrgbEnabled')) {
      appendLog('SIGNALRGB', 'Zdarzenie BIURKO: Integracja SignalRGB wyłączona w ustawieniach');
      return { ok: false, via: 'none', reason: 'Integracja SignalRGB wyłączona w ustawieniach' };
    }
    const deskAction =
      this.config.get('signalrgbDeskAction') ||
      (this.config.get('signalrgbRestoreOnDesk') === false ? 'none' : 'effect');

    if (deskAction === 'none') {
      appendLog('SIGNALRGB', 'Zdarzenie BIURKO: Akcja oświetlenia wyłączona w ustawieniach');
      return { ok: true, via: 'none', reason: 'Akcja przy biurku wyłączona w ustawieniach' };
    }

    appendLog('SIGNALRGB', `Zdarzenie BIURKO: Wykonywanie akcji "${deskAction}"`);
    const restOk = await this.probeRest();

    // Tryb "Przywróć stan sprzed odejścia"
    if (deskAction === 'restore') {
      if (!this.isAwayApplied && !this.previousState) {
        appendLog('SIGNALRGB', 'Brak stanu sprzed odejścia do przywrócenia');
        return { ok: true, via: 'none', reason: 'Brak akcji odejścia do odwrócenia' };
      }
      try {
        if (restOk) {
          appendLog(
            'SIGNALRGB',
            `Przywracanie stanu sprzed odejścia: efekt="${this.previousState?.effectName}", jasność=${this.previousState?.globalBrightness}%, włączone=${this.previousState?.enabled}`
          );
          // Kolejność wg docs: włącz canvas -> jasność -> efekt sprzed odejścia.
          if (this.previousState?.enabled === false) await this.setEnabled(true);
          if (typeof this.previousState?.globalBrightness === 'number') {
            await this.setGlobalBrightness(this.previousState.globalBrightness);
          }
          if (this.previousState?.effectName) {
            const applied = await this.applyRestByName(this.previousState.effectName);
            if (applied) {
              this.resetAwayState();
              appendLog('SIGNALRGB', 'Stan sprzed odejścia przywrócony pomyślnie przez REST');
              return { ok: true, via: 'rest' };
            }
          }
        }
      } catch (err) {
        appendLog('SIGNALRGB', `Błąd przywracania stanu: ${(err as Error).message} — fallback do efektu biurka`);
      }
    }

    // Tryb "Ustaw konkretny efekt biurka" (lub fallback dla restore bez Pro)
    try {
      const deskEffect = (this.config.get('signalrgbDeskEffect') || '').trim() || 'Neon Shift';
      const deskColor = (this.config.get('signalrgbDeskColor') || '').trim();
      appendLog('SIGNALRGB', `Ustawianie efektu biurka "${deskEffect}"${deskColor ? ` (kolor: ${deskColor})` : ''}`);
      const params = deskColor ? this.solidColorParams(deskColor) : {};

      if (restOk && !deskColor) {
        if (this.previousState?.enabled === false) await this.setEnabled(true);
        const applied = await this.applyRestByName(deskEffect);
        if (applied) {
          this.resetAwayState();
          appendLog('SIGNALRGB', `Efekt biurka "${deskEffect}" zaaplikowany przez REST`);
          return { ok: true, via: 'rest' };
        }
      }

      const launched = this.launchDeepLink(deskEffect, params);
      if (launched) {
        this.resetAwayState();
        appendLog('SIGNALRGB', `Efekt biurka "${deskEffect}" zaaplikowany przez deep-link`);
        return { ok: true, via: 'deeplink' };
      }

      const reason = restOk
        ? 'Nie udało się odtworzyć zapisanego efektu przez REST'
        : 'Brak REST (Local API wymaga SignalRGB Pro) i nie udało się uruchomić deep-linku';
      appendLog('SIGNALRGB', `Niepowodzenie akcji biurka: ${reason}`);
      return {
        ok: false,
        reason
      };
    } catch (err) {
      appendLog('SIGNALRGB', `Wyjątek podczas akcji biurka: ${(err as Error).message}`);
      return { ok: false, reason: (err as Error).message };
    }
  }

  private resetAwayState(): void {
    this.isAwayApplied = false;
    this.previousState = null;
  }
}

