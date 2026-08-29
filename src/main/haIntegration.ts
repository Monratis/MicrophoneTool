import { EventEmitter } from 'node:events';
import type Config from './config';
import type RadarListener from './radarListener';
import type { HomeAssistantStatus } from '../shared/types';
import { appendLog } from './logger';

interface HAEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

interface HAWSMessage {
  id?: number;
  type: string;
  ha_version?: string;
  message?: string;
  success?: boolean;
  event?: {
    event_type: string;
    data: {
      entity_id: string;
      new_state: HAEntityState | null;
      old_state: HAEntityState | null;
    };
  };
  result?: HAEntityState[];
}

/** Wiersz rejestru encji (config/entity_registry/list) — interesuje nas tylko powiązanie z urządzeniem. */
interface HAEntityRegistryEntry {
  entity_id: string;
  device_id?: string;
}

/** Wiersz rejestru urządzeń (config/device_registry/list). */
interface HADeviceRegistryEntry {
  id: string;
  name?: string;
  name_by_user?: string;
}

export default class HomeAssistantIntegration extends EventEmitter {
  private readonly config: Config;
  private readonly radar: RadarListener;
  /**
   * Akcje wywoływane z HAOS (przyciski button.*): pauza automatyki i mute
   * mikrofonu. Dowiązane z index.ts dopiero po zbudowaniu kontrolera —
   * dlatego setter zamiast konstruktora.
   */
  private commands: { snoozeToggle: () => void; muteToggle: () => void } | null = null;

  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private msgId = 1;

  public status: HomeAssistantStatus = {
    enabled: false,
    connected: false,
    version: undefined,
    error: undefined,
    activeSource: 'none'
  };

  constructor({ config, radar }: { config: Config; radar: RadarListener }) {
    super();
    this.config = config;
    this.radar = radar;
  }

  /** Dowiązanie akcji sterujących (pauza automatyki / mute) wołanych z przycisków HAOS. */
  setCommandHandlers(commands: { snoozeToggle: () => void; muteToggle: () => void }): void {
    this.commands = commands;
  }

  /** Usługa HA dobierana po domenie encji — wspólna dla automatyzacji i testów z UI. */
  private serviceForDomain(domain: string): { service: string } | null {
    switch (domain) {
      case 'automation': return { service: 'trigger' };
      case 'script': return { service: 'turn_on' };
      case 'button': return { service: 'press' };
      case 'scene': return { service: 'turn_on' };
      case 'input_boolean': return { service: 'toggle' };
      case 'switch': return { service: 'toggle' };
      default: return null;
    }
  }

  /**
   * Wywołanie usługi na encji HAOS (REST). Używane do odpalania automatyzacji
   * przy przejściach AWAY/DESK oraz przez przyciski "Testuj" w panelu HAOS.
   */
  async callService(entityId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    const url = this.normalizeHttpUrl();
    const token = (this.config.get('haToken') || '').trim();
    const trimmed = String(entityId || '').trim();

    if (!trimmed) {
      return { ok: false, error: 'Nie podano encji do wywołania' };
    }
    if (!token) {
      return { ok: false, error: 'Brak tokena dostępu (Long-Lived Access Token)' };
    }

    const domain = trimmed.split('.')[0];
    const svc = this.serviceForDomain(domain);
    if (!svc) {
      return { ok: false, error: `Nieobsługiwana domena "${domain}" (użyj automation/script/button/scene/input_boolean/switch)` };
    }

    try {
      const res = await fetch(`${url}/api/services/${domain}/${svc.service}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ entity_id: trimmed }),
        signal: AbortSignal.timeout(5000)
      });

      if (res.status === 401) {
        return { ok: false, error: 'Niepoprawny token dostępu (Błąd 401 Unauthorized)' };
      }
      if (res.status === 404) {
        return { ok: false, error: `Nie znaleziono encji ${trimmed} (Błąd 404)` };
      }
      if (!res.ok) {
        return { ok: false, error: `Home Assistant zwrócił status HTTP ${res.status}` };
      }

      appendLog('HAOS', `Wywołano usługę ${domain}/${svc.service} na [${trimmed}]`);
      return { ok: true, message: `Wywołano: ${trimmed} (${domain}/${svc.service})` };
    } catch (err) {
      const msg = (err as Error).message || 'Błąd sieci';
      return { ok: false, error: `Błąd wywołania usługi na ${url}: ${msg}` };
    }
  }

  /**
   * Przejście stanu obecności (desk/headset) — woła skonfigurowaną encję
   * automatyzacji, jeśli użytkownik ją ustawił. Ciche: błąd trafia tylko do
   * logów, nie blokuje przełączenia mikrofonu.
   */
  async onPresenceTransition(state: 'desk' | 'headset'): Promise<void> {
    if (!this.config.get('haEnabled')) return;
    const entityId = this.config.get(state === 'desk' ? 'haAutomationOnDesk' : 'haAutomationOnAway') || '';
    if (!entityId) return;
    const res = await this.callService(entityId);
    if (!res.ok) {
      appendLog('HAOS', `Automatyzacja przy ${state === 'desk' ? 'powrocie (DESK)' : 'odejściu (AWAY)'} nieudana: ${res.error}`);
    }
  }

  private normalizeHttpUrl(rawUrl?: string): string {
    let url = (rawUrl || this.config.get('haUrl') || 'http://homeassistant.local:8123').trim();
    if (!/^https?:\/\//i.test(url)) {
      url = `http://${url}`;
    }
    return url.replace(/\/+$/, '');
  }

  private getWsUrl(httpUrl: string): string {
    const parsed = new URL(httpUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}/api/websocket`;
  }

  public getStatus(): HomeAssistantStatus {
    const isEnabled = Boolean(this.config.get('haEnabled'));
    this.status.enabled = isEnabled;
    return { ...this.status };
  }

  /**
   * Test połączenia REST z Home Assistantem.
   */
  async testConnection(opts?: { url?: string; token?: string }): Promise<{
    ok: boolean;
    message?: string;
    version?: string;
    error?: string;
  }> {
    const url = this.normalizeHttpUrl(opts?.url);
    const token = (opts?.token ?? this.config.get('haToken') ?? '').trim();

    if (!token) {
      return { ok: false, error: 'Brak tokena dostępu (Long-Lived Access Token)' };
    }

    try {
      const res = await fetch(`${url}/api/`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(4000)
      });

      if (res.status === 401) {
        return { ok: false, error: 'Niepoprawny token dostępu (Błąd 401 Unauthorized)' };
      }

      if (!res.ok) {
        return { ok: false, error: `Home Assistant zwrócił status HTTP ${res.status}` };
      }

      const data = (await res.json()) as { message?: string; version?: string };
      return {
        ok: true,
        version: data.version,
        message: `Połączono z Home Assistant${data.version ? ` (v${data.version})` : ''}`
      };
    } catch (err) {
      const msg = (err as Error).message || 'Nieznany błąd sieci';
      return { ok: false, error: `Nie można połączyć z ${url}: ${msg}` };
    }
  }

  /**
   * Jednorazowe pobranie rejestrów encji/urządzeń przez WebSocket (REST ich
   * nie wystawia). Zwraca mapę entity_id -> nazwa urządzenia; null = rejestry
   * niedostępne (brak uprawnień / błąd) — UI wtedy pokazuje encje bez grupowania.
   */
  private fetchDeviceNameMap(httpUrl: string, token: string): Promise<Map<string, string> | null> {
    return new Promise((resolve) => {
      let settled = false;
      let ws: WebSocket | null = null;
      const finish = (value: Map<string, string> | null): void => {
        if (settled) return;
        settled = true;
        try { ws?.close(); } catch { /* ignore */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 8000);

      try {
        const WebSocketClass = typeof WebSocket !== 'undefined' ? WebSocket : (globalThis as any).WebSocket;
        if (!WebSocketClass) throw new Error('Brak WebSocket');
        ws = new WebSocketClass(this.getWsUrl(httpUrl)) as WebSocket;
      } catch {
        clearTimeout(timer);
        finish(null);
        return;
      }

      const entityToDevice = new Map<string, string>();
      const deviceNames = new Map<string, string>();
      let pending = 0;
      const send = (payload: Record<string, unknown>): void => {
        try { (ws as WebSocket).send(JSON.stringify(payload)); } catch { /* ignore */ }
      };

      (ws as WebSocket).onmessage = (event: MessageEvent): void => {
        try {
          const msg = JSON.parse(event.data as string) as HAWSMessage & { id?: number; result?: unknown[] };
          if (msg.type === 'auth_required') {
            send({ type: 'auth', access_token: token });
            return;
          }
          if (msg.type === 'auth_invalid') {
            clearTimeout(timer);
            finish(null);
            return;
          }
          if (msg.type === 'auth_ok') {
            send({ id: 1, type: 'config/entity_registry/list' });
            send({ id: 2, type: 'config/device_registry/list' });
            pending = 2;
            return;
          }
          if (msg.type === 'result' && Array.isArray(msg.result)) {
            if (msg.id === 1) {
              for (const e of msg.result as HAEntityRegistryEntry[]) {
                if (e.entity_id && e.device_id) entityToDevice.set(e.entity_id, e.device_id);
              }
            } else if (msg.id === 2) {
              for (const d of msg.result as HADeviceRegistryEntry[]) {
                if (d.id) deviceNames.set(d.id, d.name_by_user || d.name || d.id);
              }
            }
            pending--;
            if (pending <= 0) {
              clearTimeout(timer);
              const map = new Map<string, string>();
              for (const [entityId, deviceId] of entityToDevice) {
                const deviceName = deviceNames.get(deviceId);
                if (deviceName) map.set(entityId, deviceName);
              }
              finish(map);
            }
          }
        } catch {
          /* zignoruj uszkodzoną ramkę — timer domknie wynik */
        }
      };

      (ws as WebSocket).onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
    });
  }

  /**
   * Pobiera wszystkie encje z Home Assistanta i przygotowuje sugerowane mapowania.
   */
  async fetchEntities(opts?: { url?: string; token?: string }): Promise<{
    ok: boolean;
    message?: string;
    error?: string;
    binarySensors: { entity_id: string; name: string; state: string; deviceName?: string }[];
    sensors: { entity_id: string; name: string; state: string; unit?: string; deviceName?: string }[];
    actions: { entity_id: string; name: string; domain: string; deviceName?: string }[];
    recommended?: {
      presence?: string;
      distance?: string;
      heartRate?: string;
      breathRate?: string;
    };
  }> {
    const url = this.normalizeHttpUrl(opts?.url);
    const token = (opts?.token ?? this.config.get('haToken') ?? '').trim();

    if (!token) {
      return {
        ok: false,
        error: 'Brak tokena dostępu (Long-Lived Access Token)',
        binarySensors: [],
        sensors: [],
        actions: []
      };
    }

    try {
      const res = await fetch(`${url}/api/states`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(6000)
      });

      if (!res.ok) {
        return {
          ok: false,
          error: `Błąd pobierania encji: HTTP ${res.status}`,
          binarySensors: [],
          sensors: [],
          actions: []
        };
      }

      const states = (await res.json()) as HAEntityState[];

      // Rejestry (device/entity) pobierane osobno przez WebSocket — gdy się nie
      // uda (uprawnienia/timeout), encje wracają bez nazw urządzeń.
      const deviceNames = await this.fetchDeviceNameMap(url, token).catch(() => null);
      const deviceOf = (entityId: string): string | undefined => deviceNames?.get(entityId);

      const binarySensors: { entity_id: string; name: string; state: string; deviceName?: string }[] = [];
      const sensors: { entity_id: string; name: string; state: string; unit?: string; deviceName?: string }[] = [];
      const actions: { entity_id: string; name: string; domain: string; deviceName?: string }[] = [];
      const ACTION_DOMAINS = new Set(['button', 'automation', 'script', 'scene', 'input_boolean', 'switch']);

      for (const s of states) {
        const friendlyName = (s.attributes?.friendly_name as string) || s.entity_id;
        if (s.entity_id.startsWith('binary_sensor.')) {
          binarySensors.push({
            entity_id: s.entity_id,
            name: friendlyName,
            state: s.state,
            deviceName: deviceOf(s.entity_id)
          });
        } else if (s.entity_id.startsWith('sensor.')) {
          sensors.push({
            entity_id: s.entity_id,
            name: friendlyName,
            state: s.state,
            unit: s.attributes?.unit_of_measurement as string | undefined,
            deviceName: deviceOf(s.entity_id)
          });
        } else if (ACTION_DOMAINS.has(s.entity_id.split('.')[0])) {
          actions.push({
            entity_id: s.entity_id,
            name: friendlyName,
            domain: s.entity_id.split('.')[0],
            deviceName: deviceOf(s.entity_id)
          });
        }
      }

      // Sortowanie alfabetyczne po nazwie
      binarySensors.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
      sensors.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
      actions.sort((a, b) => a.name.localeCompare(b.name, 'pl'));

      // Heurystyka doboru rekomendowanych encji
      const recommended = this.detectRecommendedEntities(states);

      return {
        ok: true,
        binarySensors,
        sensors,
        actions,
        recommended,
        message: `Pobrano ${binarySensors.length} binarnych, ${sensors.length} numerycznych i ${actions.length} akcji`
      };
    } catch (err) {
      const msg = (err as Error).message || 'Błąd sieci';
      return {
        ok: false,
        error: `Błąd odpytywania encji: ${msg}`,
        binarySensors: [],
        sensors: [],
        actions: []
      };
    }
  }

  /**
   * Automatyczna detekcja sensora obecności, odległości, tętna i oddechu.
   */
  private detectRecommendedEntities(states: HAEntityState[]): {
    presence?: string;
    distance?: string;
    heartRate?: string;
    breathRate?: string;
  } {
    const result: {
      presence?: string;
      distance?: string;
      heartRate?: string;
      breathRate?: string;
    } = {};

    const scoreEntity = (s: HAEntityState, keywords: string[]): number => {
      const id = s.entity_id.toLowerCase();
      const fn = String(s.attributes?.friendly_name || '').toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (id.includes(kw)) score += 3;
        if (fn.includes(kw)) score += 2;
      }
      return score;
    };

    // 1. Obecność (binary_sensor)
    let bestPresenceScore = 0;
    for (const s of states) {
      if (!s.entity_id.startsWith('binary_sensor.')) continue;
      const dc = String(s.attributes?.device_class || '').toLowerCase();
      let score = 0;
      if (dc === 'occupancy' || dc === 'presence' || dc === 'motion') score += 5;
      score += scoreEntity(s, [
        'mr60',
        'seeed',
        'presence',
        'occupancy',
        'obecnosc',
        'biurko',
        'desk',
        'target',
        'radar',
        'has_target',
        'someone'
      ]);
      if (score > bestPresenceScore) {
        bestPresenceScore = score;
        result.presence = s.entity_id;
      }
    }

    // 2. Dystans (sensor)
    let bestDistScore = 0;
    for (const s of states) {
      if (!s.entity_id.startsWith('sensor.')) continue;
      const unit = String(s.attributes?.unit_of_measurement || '').toLowerCase();
      const dc = String(s.attributes?.device_class || '').toLowerCase();
      let score = 0;
      if (dc === 'distance') score += 5;
      if (unit === 'cm' || unit === 'm' || unit === 'mm') score += 4;
      score += scoreEntity(s, [
        'distance',
        'odleglosc',
        'dystans',
        'range',
        'mr60',
        'seeed',
        'biurko',
        'desk',
        'radar'
      ]);
      if (score > bestDistScore) {
        bestDistScore = score;
        result.distance = s.entity_id;
      }
    }

    // 3. Tętno (sensor)
    let bestHrScore = 0;
    for (const s of states) {
      if (!s.entity_id.startsWith('sensor.')) continue;
      const unit = String(s.attributes?.unit_of_measurement || '').toLowerCase();
      let score = 0;
      if (unit === 'bpm') score += 5;
      score += scoreEntity(s, [
        'heart',
        'tetno',
        'pulse',
        'puls',
        'bpm',
        'mr60',
        'seeed',
        'biurko',
        'desk',
        'radar'
      ]);
      if (score > bestHrScore) {
        bestHrScore = score;
        result.heartRate = s.entity_id;
      }
    }

    // 4. Oddech (sensor)
    let bestBrScore = 0;
    for (const s of states) {
      if (!s.entity_id.startsWith('sensor.')) continue;
      const unit = String(s.attributes?.unit_of_measurement || '').toLowerCase();
      let score = 0;
      if (unit === 'rpm' || unit === 'bpm') score += 4;
      score += scoreEntity(s, [
        'breath',
        'oddech',
        'respiratory',
        'rpm',
        'mr60',
        'seeed',
        'biurko',
        'desk',
        'radar'
      ]);
      if (score > bestBrScore) {
        bestBrScore = score;
        result.breathRate = s.entity_id;
      }
    }

    return result;
  }

  /**
   * Uruchomienie ciągłej integracji i nasłuchu WebSocket z Home Assistantem.
   */
  async start(): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    this.status.enabled = Boolean(this.config.get('haEnabled'));

    if (!this.status.enabled) {
      this.status.connected = false;
      this.status.activeSource = 'none';
      return;
    }

    await this.connectWs();
  }

  /**
   * Zatrzymanie integracji.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.status.connected = false;
    this.status.activeSource = 'none';
    this.emit('status', this.getStatus());
  }

  /**
   * Ponowne załadowanie konfiguracji (np. po zmianie adresu, tokena lub encji).
   */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async connectWs(): Promise<void> {
    if (!this.running || !this.config.get('haEnabled')) return;

    const token = (this.config.get('haToken') || '').trim();
    const httpUrl = this.normalizeHttpUrl();

    if (!token) {
      this.status.connected = false;
      this.status.error = 'Brak tokena dostępu';
      this.emit('status', this.getStatus());
      this.scheduleReconnect();
      return;
    }

    const wsUrl = this.getWsUrl(httpUrl);

    try {
      const WebSocketClass = typeof WebSocket !== 'undefined' ? WebSocket : (globalThis as any).WebSocket;
      if (!WebSocketClass) {
        throw new Error('Brak środowiska WebSocket w Node/Electron');
      }

      const ws = new WebSocketClass(wsUrl) as WebSocket;
      this.ws = ws;

      ws.onopen = () => {
        // Po otwarciu czekamy na komunikat auth_required
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as HAWSMessage;
          this.handleWsMessage(msg, token);
        } catch (err) {
          console.warn('[ha] błąd parsowania wiadomości WS:', (err as Error).message);
        }
      };

      ws.onerror = () => {
        console.warn('[ha] błąd połączenia WebSocket');
        this.status.connected = false;
        this.status.error = 'Błąd połączenia WebSocket';
        this.emit('status', this.getStatus());
      };

      ws.onclose = () => {
        this.status.connected = false;
        this.emit('status', this.getStatus());
        if (this.running && this.config.get('haEnabled')) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.status.connected = false;
      this.status.error = (err as Error).message;
      this.emit('status', this.getStatus());
      this.scheduleReconnect();
    }
  }

  private handleWsMessage(msg: HAWSMessage, token: string): void {
    if (msg.type === 'auth_required') {
      this.sendWs({
        type: 'auth',
        access_token: token
      });
      return;
    }

    if (msg.type === 'auth_ok') {
      this.reconnectAttempts = 0;
      this.status.connected = true;
      this.status.error = undefined;
      this.status.version = msg.ha_version;
      this.status.activeSource = 'ha';
      appendLog('HAOS', `Połączono pomyślnie z Home Assistant ${msg.ha_version ? `v${msg.ha_version} ` : ''}(WebSocket Live) ✓`);
      this.emit('status', this.getStatus());

      // 1. Subskrybuj zdarzenia zmian stanu
      this.sendWs({
        id: this.msgId++,
        type: 'subscribe_events',
        event_type: 'state_changed'
      });

      // 2. Pobierz aktualne stany wszystkich encji na start
      this.sendWs({
        id: this.msgId++,
        type: 'get_states'
      });
      return;
    }

    if (msg.type === 'auth_invalid') {
      this.status.connected = false;
      this.status.error = 'Nieprawidłowy token autoryzacji HAOS';
      appendLog('HAOS', 'Błąd autoryzacji: podany token HAOS został odrzucony');
      this.emit('status', this.getStatus());
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      return;
    }

    // Odpowiedź na get_states
    if (msg.type === 'result' && Array.isArray(msg.result)) {
      appendLog('HAOS', `Zsynchronizowano stan ${msg.result.length} encji z Home Assistant`);
      for (const s of msg.result) {
        // Wstępna synchronizacja: live=false, żeby stary timestamp przycisku
        // nie odpalił akcji (snooze/mute) przy każdym starcie aplikacji.
        this.processEntityState(s.entity_id, s, false);
      }
      return;
    }

    // Zdarzenie zmiany stanu na żywo
    if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
      const data = msg.event.data;
      if (data && data.new_state) {
        this.processEntityState(data.entity_id, data.new_state, true);
      }
    }
  }

  private lastDistanceLogTime = 0;
  private lastPresenceLogged: boolean | null = null;

  private processEntityState(entityId: string, stateObj: HAEntityState, live: boolean): void {
    const now = Date.now();
    const rawState = String(stateObj.state || '').trim().toLowerCase();

    // Ignoruj stany niedostępne/nieustalone (np. chwilowy restart ESP / sieci)
    if (rawState === 'unavailable' || rawState === 'unknown' || rawState === '') {
      return;
    }

    // 0. Przyciski HAOS sterujące apką — reakcja wyłącznie na żywe zdarzenia
    // (wciśnięcie button.* = zmiana stanu na timestamp); initial sync pomijany.
    if (live) {
      const snoozeButton = this.config.get('haButtonSnoozeEntity');
      const muteButton = this.config.get('haButtonMuteEntity');
      if (snoozeButton && entityId === snoozeButton && this.commands) {
        appendLog('HAOS', `Wciśnięto przycisk HAOS [${entityId}] -> przełączenie pauzy automatyki (snooze)`);
        this.commands.snoozeToggle();
        return;
      }
      if (muteButton && entityId === muteButton && this.commands) {
        appendLog('HAOS', `Wciśnięto przycisk HAOS [${entityId}] -> przełączenie wyciszenia mikrofonu`);
        this.commands.muteToggle();
        return;
      }
    }

    const presenceTarget = this.config.get('haPresenceEntity');
    const distanceTarget = this.config.get('haDistanceEntity');
    const heartTarget = this.config.get('haHeartRateEntity');
    const breathTarget = this.config.get('haBreathRateEntity');

    let processed = false;

    // 1. Encja obecności
    if (presenceTarget && entityId === presenceTarget) {
      const isPresent = ['on', 'true', '1', 'home', 'occupied', 'detected', 'someone'].includes(rawState);
      const isAway = ['off', 'false', '0', 'not_home', 'unoccupied', 'clear', 'nobody'].includes(rawState);

      if (isPresent || isAway) {
        if (this.lastPresenceLogged !== isPresent) {
          this.lastPresenceLogged = isPresent;
          appendLog('HAOS', `Encja obecności [${entityId}] = '${rawState}' (Wykryto: ${isPresent ? 'OBECNY' : 'BRAK OBECNOŚCI'})`);
        }
        this.radar.feedExternalTelemetry({ presence: isPresent, source: 'ha' });
        processed = true;
      }

      // Sprawdź czy encja obecności nie zawiera telemetrii w atrybutach
      const attrs = stateObj.attributes || {};
      if (typeof attrs.distance === 'number' && attrs.distance > 0) {
        const unit = String(attrs.unit_of_measurement || '').toLowerCase();
        let cm: number;
        if (unit === 'm') cm = Math.round(attrs.distance * 100);
        else if (unit === 'mm') cm = Math.round(attrs.distance / 10);
        else if (unit === 'cm') cm = Math.round(attrs.distance);
        else cm = attrs.distance < 10 ? Math.round(attrs.distance * 100) : Math.round(attrs.distance);

        if (cm > 0 && cm <= 800) {
          this.radar.feedExternalTelemetry({ distanceCm: cm, source: 'ha' });
        }
      }
      if (typeof attrs.heart_rate === 'number' || typeof attrs.bpm === 'number') {
        const bpm = Math.round(Number(attrs.heart_rate || attrs.bpm));
        if (bpm >= 30 && bpm <= 240) {
          this.radar.feedExternalTelemetry({ heartRate: bpm, source: 'ha' });
        }
      }
      if (typeof attrs.breath_rate === 'number' || typeof attrs.rpm === 'number') {
        const rpm = Math.round(Number(attrs.breath_rate || attrs.rpm));
        if (rpm >= 5 && rpm <= 70) {
          this.radar.feedExternalTelemetry({ breathRate: rpm, source: 'ha' });
        }
      }
    }

    // 2. Encja dystansu
    if (distanceTarget && entityId === distanceTarget) {
      const val = parseFloat(rawState);
      if (Number.isFinite(val)) {
        if (val > 0) {
          const unit = String(stateObj.attributes?.unit_of_measurement || '').toLowerCase();
          let cm: number;
          if (unit === 'm') {
            cm = Math.round(val * 100);
          } else if (unit === 'mm') {
            cm = Math.round(val / 10);
          } else if (unit === 'cm') {
            cm = Math.round(val);
          } else {
            cm = val < 10 ? Math.round(val * 100) : Math.round(val);
          }

          if (cm > 0 && cm <= 800) {
            if (now - this.lastDistanceLogTime > 2500) {
              this.lastDistanceLogTime = now;
              appendLog('HAOS', `Encja dystansu [${entityId}] = '${rawState}' (${cm} cm)`);
            }
            this.radar.feedExternalTelemetry({ distanceCm: cm, source: 'ha' });
            processed = true;
          }
        } else if (val === 0) {
          this.radar.feedExternalTelemetry({ distanceCm: 0, source: 'ha' });
          processed = true;
        }
      }
    }

    // 3. Encja tętna
    if (heartTarget && entityId === heartTarget) {
      const bpm = Math.round(parseFloat(rawState));
      if (Number.isFinite(bpm)) {
        if (bpm >= 30 && bpm <= 240) {
          this.radar.feedExternalTelemetry({ heartRate: bpm, source: 'ha' });
          processed = true;
        } else if (bpm === 0) {
          this.radar.feedExternalTelemetry({ heartRate: 0, source: 'ha' });
          processed = true;
        }
      }
    }

    // 4. Encja oddechu
    if (breathTarget && entityId === breathTarget) {
      const rpm = Math.round(parseFloat(rawState));
      if (Number.isFinite(rpm)) {
        if (rpm >= 5 && rpm <= 70) {
          this.radar.feedExternalTelemetry({ breathRate: rpm, source: 'ha' });
          processed = true;
        } else if (rpm === 0) {
          this.radar.feedExternalTelemetry({ breathRate: 0, source: 'ha' });
          processed = true;
        }
      }
    }

    if (processed) {
      this.status.activeSource = 'ha';
    }
  }

  private sendWs(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        console.warn('[ha] błąd wysyłania do WebSocket:', (err as Error).message);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer || !this.config.get('haEnabled')) return;
    const delay = this.reconnectAttempts < 3 ? 1500 : this.reconnectAttempts < 8 ? 3000 : 6000;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWs();
    }, delay);
  }
}