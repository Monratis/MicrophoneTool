export type AppMode = 'auto' | 'desk' | 'headset';
export type DeskState = 'desk' | 'away';
export type DeviceState = 'desk' | 'headset';
export type DetectedPerson = 'me' | 'pet' | 'unknown';

export interface AppConfig {
  port: string;
  baudRate: number;
  micDeskName: string;
  micHeadsetName: string;
  /** Głośność mikrofonu stacjonarnego 0-100; -1 = nie steruj głośnością */
  micDeskVolume: number;
  /** Głośność mikrofonu mobilnego 0-100; -1 = nie steruj głośnością */
  micHeadsetVolume: number;
  /** Bramka VAD Discorda dla mikrofonu stacjonarnego (-100..0 dB); -1 = nie steruj (szanuj PTT/auto próg) */
  micDeskGateDb: number;
  /** Bramka VAD Discorda dla mikrofonu mobilnego (-100..0 dB); -1 = nie steruj */
  micHeadsetGateDb: number;
  /** Wyciszenie szumów (Krisp) dla mikrofonu stacjonarnego */
  micDeskKrisp: 'default' | 'on' | 'off';
  /** Wyciszenie szumów (Krisp) dla mikrofonu mobilnego */
  micHeadsetKrisp: 'default' | 'on' | 'off';
  /** Automatyczna kontrola wzmocnienia (AGC) dla mikrofonu stacjonarnego */
  micDeskAgc: 'default' | 'on' | 'off';
  /** AGC dla mikrofonu mobilnego */
  micHeadsetAgc: 'default' | 'on' | 'off';
  /** Usuwanie echa dla mikrofonu stacjonarnego */
  micDeskEcho: 'default' | 'on' | 'off';
  /** Usuwanie echa dla mikrofonu mobilnego */
  micHeadsetEcho: 'default' | 'on' | 'off';
  /** Automatycznie dopasuj bramkę Discorda do aktywnego mikrofonu */
  discordGateFollowMic: boolean;
  /**
   * Application ID z Discord Developer Portal (wymagany przez RPC).
   * Bez własnego zarejestrowanego ID klient Discord może odrzucać połączenie.
   */
  discordClientId: string;
  /**
   * OAuth2 Client Secret tej apki — WYMAGANY do wymiany kodu autoryzacji
   * na token (presety głosowe). Trzymasz go tylko lokalnie w swoim
   * config.json; domyślnie pusty.
   */
  discordClientSecret: string;
  /** Redirect URI zarejestrowany w portalu deweloperskim (dla wymiany kodu) */
  discordRedirectUri: string;
  /** Zapisany token dostępu OAuth2 (Bearer) */
  discordAccessToken?: string;
  /** Zapisany token odświeżania OAuth2 do bezobsługowego odnawiania sesji */
  discordRefreshToken?: string;
  /** Unix ms wygaśnięcia access tokenu (proaktywny refresh z 24 h zapasem) */
  discordTokenExpiresAt?: number;
  timeoutAwayMs: number;
  timeoutDeskMs: number;
  /** Wykorzystuje aktywność klawiatury i myszy (GetLastInputInfo) jako potwierdzenie obecności */
  userInputPresenceEnabled: boolean;
  radarDistanceGateEnabled: boolean;
  radarMinDistanceCm: number;
  radarMaxDistanceCm: number;
  /** Potwierdzanie powrotu po głębokiej nieobecności: ON musi się ustabilizować, zanim przełączy mikrofon */
  radarDeepAwayConfirm: boolean;
  /** Długość ciągłego AWAY, po której powrót wymaga potwierdzenia (ms) */
  radarDeepAwayMinMs: number;
  /** Jak długo sygnał obecności musi wytrzymać ON, zanim uznamy powrót (ms) */
  radarDeepAwayConfirmMs: number;
  petFilterEnabled: boolean;
  radarAutoTuningEnabled: boolean;
  radarAutoTuningSpeed: 'balanced' | 'fast' | 'conservative';
  radarAutoTuningNoiseFloor: number;
  radarLearnedDistanceCenter: number;
  radarLearnedDistanceVariance: number;
  radarLearnedHeartRate: number;
  radarLearnedBreathRate: number;
  switchMicOnAway: boolean;
  switchMicOnDesk: boolean;
  muteBehaviorOnAway: 'none' | 'mute_stationary' | 'mute_all' | 'mute_inactive';
  unmuteOnDesk: boolean;
  discordIntegration: boolean;
  signalrgbEnabled: boolean;
  signalrgbPort: number;
  signalrgbAwayAction: 'solid_color' | 'turn_off' | 'dim';
  signalrgbAwayColor: string;
  signalrgbAwayBrightness: number;
  signalrgbRestoreOnDesk: boolean;
  /** Włącz czarny wygaszacz ekranu po odejściu od biurka */
  screensaverOnAway: boolean;
  /** Czas w ms nieobecności, po którym włącza się czarny wygaszacz (domyślnie 60000 = 1 min) */
  screensaverDelayMs: number;
  /** Włącz sprzętowe uśpienie zasilania monitorów (DPMS) po odejściu od biurka */
  sleepMonitorsOnAway: boolean;
  /** Czas w ms nieobecności, po którym następuje sprzętowe uśpienie monitorów (domyślnie 600000 = 10 min) */
  sleepMonitorsDelayMs: number;
  wakeMonitorsOnDesk: boolean;
  audioChime: boolean;
  audioChimeOnDesk: boolean;
  audioChimeOnAway: boolean;
  audioChimeVolume: number;
  /** Styl syntezowanego chime (własne pliki audio mają priorytet nad stylem) */
  audioChimeStyle: 'harmonic' | 'modern' | 'soft_click' | 'marimba';
  /** Własny plik audio (mp3/wav/ogg) zamiast syntezowanego chime dla profilu Stacjonarnego; '' = użyj chime */
  audioFileDesk: string;
  /** Własny plik audio zamiast chime dla profilu Słuchawki (mobilnego); '' = użyj chime */
  audioFileHeadset: string;
  notifications: boolean;
  autoStart: boolean;
  globalShortcut: string;
  githubRepo: string;
  githubToken: string;
  /** Integracja z Home Assistant OS (HAOS) */
  haEnabled: boolean;
  /** Adres URL instancji Home Assistant (np. http://homeassistant.local:8123 lub http://192.168.1.100:8123) */
  haUrl: string;
  /** Long-Lived Access Token wygenerowany w profilu Home Assistant */
  haToken: string;
  /** Identyfikator encji obecności w HA (np. binary_sensor.seeed_mr60bha2_presence) */
  haPresenceEntity: string;
  /** Opcjonalny identyfikator encji dystansu w HA (np. sensor.seeed_mr60bha2_distance) */
  haDistanceEntity: string;
  /** Opcjonalny identyfikator encji tętna w HA (np. sensor.seeed_mr60bha2_heart_rate) */
  haHeartRateEntity: string;
  /** Opcjonalny identyfikator encji oddechu w HA (np. sensor.seeed_mr60bha2_breath_rate) */
  haBreathRateEntity: string;
  /** Tryb cyfrowej stabilizacji i wygładzania odczytów radaru (ultra = mocny filtr medianowy+EMA, balanced = zbalansowany, raw = surowy) */
  radarSmoothingMode: 'ultra' | 'balanced' | 'raw';
  /** Włącz diodę statusową WS2812 na sensorze */
  sensorLedEnabled: boolean;
  /** Jasność diody sensora 0-100% (tryb nocny/stealth) */
  sensorLedBrightness: number;
  /** Kolor diody przy biurku (HEX, np. #22c55e) */
  sensorLedDeskColor: string;
  /** Kolor diody poza biurkiem (HEX, np. #f59e0b) */
  sensorLedAwayColor: string;
  /** Kolor diody przy wyciszonym mikrofonie (HEX, np. #ef4444) */
  sensorLedMuteColor: string;
}

export interface HomeAssistantStatus {
  enabled: boolean;
  connected: boolean;
  version?: string;
  error?: string;
  lastUpdate?: number;
  entitiesCount?: number;
  activeSource?: 'ha' | 'usb' | 'none';
}

export interface AutoTuningStatus {
  enabled: boolean;
  noiseFloor: number;
  samplesCount: number;
  adaptedDistanceCenter: number;
  adaptedDistanceMin: number;
  adaptedDistanceMax: number;
  adaptedHeartRateAvg: number;
  adaptedBreathRateAvg: number;
  stabilityScore: number;
  /** false dopóki kroczące okno stabilności się nie napełni (UI pokazuje "Nauka…") */
  stabilityReady: boolean;
  lastAdaptedAt: number;
}

export interface RadarTelemetry {
  presence?: boolean;
  distanceCm?: number;
  /** false = radar niejednoznaczny (kot + człowiek) — dystans może należeć do kota */
  distanceTrusted?: boolean;
  /** Liczba celów śledzonych przez radar (ramka 0x0A04 / sensor ESPHome target_number) */
  targetCount?: number;
  heartRate?: number;
  breathRate?: number;
  illuminanceLux?: number;
  detectedPerson?: DetectedPerson;
  autoTuning?: AutoTuningStatus;
  deviceInfo?: {
    fwVersion?: string;
    uptimeSec?: number;
    chipTempC?: number;
  };
  lastUpdate?: number;
}

export interface DiagRecordResult {
  active: boolean;
  durationSec: number;
  sampleCount: number;
  /** Gotowy raport tekstowy (PL) z wnioskami dla progów fuzji */
  summary: string;
  /** Pełne CSV: t_s,rodzaj,wartosc */
  csv: string;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface AudioDeviceItem {
  id?: string;
  name: string;
  isDefault: boolean;
  /** Rola komunikacyjna (priorytet dla rozmów) — używana przez watchdog defaultu */
  isDefaultComm?: boolean;
  isMuted?: boolean;
  volume?: number;
  /** Fizyczny poziom w dB — skala dokumentowana (procenty Windows to nieliniowy taper) */
  volumeDb?: number | null;
}

export interface Snapshot {
  version: string;
  mode: AppMode;
  state: DeviceState | null;
  deviceName: string | null;
  radar: {
    connected: boolean;
    presence: boolean;
    pendingState: DeskState;
    port: string;
  };
  ha?: HomeAssistantStatus;
  telemetry: RadarTelemetry;
  config: AppConfig;
  /** Unix ms do kiedy trwa pauza automatyki (snooze); 0 = brak pauzy */
  snoozeUntil: number;
}

export interface UpdaterStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  updateInfo?: UpdateInfo | null;
  downloadedFilePath?: string | null;
  error?: string;
}

export interface UpdateInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string;
  url: string;
  asset: {
    id: number;
    name: string;
    size: number;
    apiUrl: string;
    downloadUrl: string;
  } | null;
}

export interface PushEvent {
  type: string;
  snapshot?: Snapshot;
  message?: string;
  error?: boolean;
  percent?: number;
  transferred?: number;
  total?: number;
  speed?: string;
  stage?: string;
  entry?: string;
  state?: DeviceState;
  device?: string | null;
  updateInfo?: UpdateInfo;
  status?: UpdaterStatus;
  /** Aktualna lista urządzeń nagrywających (event devices:changed) */
  devices?: AudioDeviceItem[];
  /** Nazwy urządzeń, które się właśnie pojawiły */
  added?: string[];
  /** Nazwy urządzeń, które właśnie zniknęły */
  removed?: string[];
  /** Aktualna lista portów COM (event ports:changed) */
  ports?: SerialPortInfo[];
  [key: string]: unknown;
}

export interface DetectResult {
  devices: AudioDeviceItem[];
  recommended: { micDeskName: string; micHeadsetName: string };
}

/** Raport sesji diagnostycznej "Wyjście z pokoju" (diag:stop). */
export interface DiagSessionReport {
  startedAt: number;
  endedAt: number;
  count: number;
  text: string;
}

export interface Api {
  getState: () => Promise<Snapshot>;
  getPorts: () => Promise<SerialPortInfo[]>;
  setMode: (mode: AppMode) => Promise<Snapshot>;
  /** Pauza automatyki (snooze) na N minut; 0 = wznowienie. Zwraca świeży snapshot. */
  setSnooze: (minutes: number) => Promise<Snapshot>;
  updateConfig: (patch: Partial<AppConfig>) => Promise<Snapshot>;
  detectDevices: () => Promise<DetectResult>;
  listDevices: () => Promise<AudioDeviceItem[]>;
  toggleMute: () => Promise<{ ok: boolean; isMuted?: boolean }>;
  discordApplyVoice: (args: { gateDb?: number; krisp?: boolean; agc?: boolean; echo?: boolean }) => Promise<boolean>;
  discordGetStatus: () => Promise<{ connected: boolean; ready: boolean; authenticated: boolean; user?: string }>;
  discordGetVoiceSettings: () => Promise<{ thresholdDb?: number; autoThreshold?: boolean; krisp?: boolean; agc?: boolean; echo?: boolean } | null>;
  discordAuthorize: () => Promise<boolean>;
  testDevice: (name: string) => Promise<Snapshot>;
  screensaverStart: () => Promise<boolean>;
  screensaverDismiss: () => void;
  openConfigDir: () => Promise<boolean>;
  resetConfig: () => Promise<Snapshot>;
  resetAutoTuning: () => Promise<AutoTuningStatus | null>;
  diagRecord: () => Promise<DiagRecordResult>;
  closeWindow: () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  isWindowMaximized: () => Promise<boolean>;
  toggleDevTools: () => void;

  // Home Assistant Integration
  haTestConnection: (opts?: { url?: string; token?: string }) => Promise<{ ok: boolean; message?: string; version?: string; error?: string }>;
  haFetchEntities: (opts?: { url?: string; token?: string }) => Promise<{
    ok: boolean;
    message?: string;
    error?: string;
    binarySensors: { entity_id: string; name: string; state: string }[];
    sensors: { entity_id: string; name: string; state: string; unit?: string }[];
    recommended?: { presence?: string; distance?: string; heartRate?: string; breathRate?: string };
  }>;

  // SignalRGB Integration
  signalrgbTestAway: () => Promise<boolean>;
  signalrgbTestDesk: () => Promise<boolean>;

  openExternal: (url: string) => Promise<boolean>;
  copyToClipboard: (text: string) => Promise<boolean>;
  /** Systemowy dialog wyboru pliku audio; zwraca ścieżkę lub null przy anulowaniu */
  pickAudioFile: () => Promise<string | null>;
  /** Ponowne wysłanie koloru diody do sensora (po zmianie w color pickerze) */
  refreshLed: () => Promise<boolean>;
  checkForUpdates: () => Promise<{ available: boolean; updateInfo?: UpdateInfo | null; error?: string; currentVersion: string }>;
  downloadUpdate: () => Promise<{ ok: boolean; file?: string } | null>;
  installUpdate: () => Promise<void | null>;
  getUpdaterStatus: () => Promise<UpdaterStatus | null>;

  getLogs: () => Promise<string[]>;
  clearLogs: () => Promise<boolean>;
  openLogsInNotepad: () => Promise<boolean>;

  // Sesja diagnostyczna "Wyjście z pokoju"
  diagStart: () => Promise<boolean>;
  diagStatus: () => Promise<{ active: boolean; startedAt: number }>;
  diagStop: () => Promise<DiagSessionReport | null>;
  openTextInNotepad: (text: string) => Promise<boolean>;

  onEvent: (cb: (e: PushEvent) => void) => () => void;
}
