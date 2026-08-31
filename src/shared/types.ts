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
  /** Wymuszenie automatycznej czułości wejścia Discorda (Voice Isolation) dla mikrofonu stacjonarnego */
  micDeskAutoThreshold?: boolean;
  /** Bramka VAD Discorda dla mikrofonu mobilnego (-100..0 dB); -1 = nie steruj */
  micHeadsetGateDb: number;
  /** Wymuszenie automatycznej czułości wejścia Discorda (Voice Isolation) dla mikrofonu mobilnego */
  micHeadsetAutoThreshold?: boolean;
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
  /** Czas podtrzymania obecności DESK po ostatnim dotknięciu klawiatury/myszy (sekundy, domyślnie 1s) */
  userInputPresenceHoldSec?: number;
  petFilterEnabled: boolean;
  switchMicOnAway: boolean;
  switchMicOnDesk: boolean;
  muteBehaviorOnAway: 'none' | 'mute_stationary' | 'mute_all' | 'mute_inactive';
  unmuteOnDesk: boolean;
  discordIntegration: boolean;
  signalrgbEnabled: boolean;
  signalrgbPort: number;
  signalrgbAwayAction: 'solid_color' | 'turn_off' | 'dim';
  signalrgbAwayColor: string;
  /** Nazwa efektu aplikowanego przy odejściu przez deep-link (case-sensitive); '' = Solid Color */
  signalrgbAwayEffect: string;
  signalrgbAwayBrightness: number;
  /** Akcja oświetlenia przy biurku: 'effect' (konkretny efekt), 'restore' (przywróć stan sprzed odejścia), 'none' */
  signalrgbDeskAction?: 'effect' | 'restore' | 'none';
  signalrgbRestoreOnDesk: boolean;
  /** Efekt aplikowany przy powrocie do biurka; '' = domyślny */
  signalrgbDeskEffect: string;
  /** Opcjonalny kolor dla efektu biurkowego */
  signalrgbDeskColor?: string;
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
  /**
   * Encja wołana przy odejściu od biurka (AWAY): automation.* / script.* /
   * button.* / scene.* — DeskSense sam dobiera usługę wg domeny.
   */
  haAutomationOnAway: string;
  /** Encja wołana przy powrocie do biurka (DESK), jw. */
  haAutomationOnDesk: string;
  /** Przycisk HAOS (button.*), którego wciśnięcie przełącza pauzę automatyki (snooze) */
  haButtonSnoozeEntity: string;
  /** Przycisk HAOS (button.*), którego wciśnięcie przełącza wyciszenie mikrofonu */
  haButtonMuteEntity: string;
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

export const DEFAULT_CONFIG: AppConfig = {
  port: 'auto',
  baudRate: 115200,
  micDeskName: '',
  micHeadsetName: '',
  micDeskVolume: -1,
  micHeadsetVolume: -1,
  micDeskGateDb: -1,
  micDeskAutoThreshold: false,
  micHeadsetGateDb: -1,
  micHeadsetAutoThreshold: false,
  micDeskKrisp: 'default',
  micHeadsetKrisp: 'default',
  micDeskAgc: 'default',
  micHeadsetAgc: 'default',
  micDeskEcho: 'default',
  micHeadsetEcho: 'default',
  discordGateFollowMic: true,
  discordClientId: '1238447097859145859',
  discordClientSecret: 'xwmeOcXQP496dX5EYgXBFFcNyEUo30Z3',
  discordRedirectUri: 'https://discord.com',
  discordAccessToken: '',
  discordRefreshToken: '',
  discordTokenExpiresAt: 0,
  timeoutAwayMs: 800,
  timeoutDeskMs: 50,
  userInputPresenceEnabled: true,
  userInputPresenceHoldSec: 1,
  petFilterEnabled: true,
  switchMicOnAway: true,
  switchMicOnDesk: true,
  muteBehaviorOnAway: 'mute_inactive',
  unmuteOnDesk: true,
  discordIntegration: true,
  signalrgbEnabled: false,
  signalrgbPort: 16038,
  signalrgbAwayAction: 'solid_color',
  signalrgbAwayColor: '#f59e0b',
  signalrgbAwayEffect: '',
  signalrgbAwayBrightness: 0,
  signalrgbDeskAction: 'effect',
  signalrgbDeskEffect: 'Neon Shift',
  signalrgbDeskColor: '',
  signalrgbRestoreOnDesk: true,
  screensaverOnAway: true,
  screensaverDelayMs: 60000,
  sleepMonitorsOnAway: false,
  sleepMonitorsDelayMs: 600000,
  wakeMonitorsOnDesk: true,
  audioChime: true,
  audioChimeOnDesk: true,
  audioChimeOnAway: true,
  audioChimeVolume: 0.2,
  audioChimeStyle: 'harmonic',
  audioFileDesk: '',
  audioFileHeadset: '',
  notifications: true,
  autoStart: false,
  globalShortcut: 'CommandOrControl+Shift+M',
  githubRepo: 'Monratis/MicrophoneTool',
  githubToken: '',
  haEnabled: false,
  haUrl: 'http://homeassistant.local:8123',
  haToken: '',
  haPresenceEntity: '',
  haDistanceEntity: '',
  haHeartRateEntity: '',
  haBreathRateEntity: '',
  haAutomationOnAway: '',
  haAutomationOnDesk: '',
  haButtonSnoozeEntity: '',
  haButtonMuteEntity: '',
  radarSmoothingMode: 'balanced',
  sensorLedEnabled: true,
  sensorLedBrightness: 25,
  sensorLedDeskColor: '#22c55e',
  sensorLedAwayColor: '#f59e0b',
  sensorLedMuteColor: '#ef4444'
};

export interface DiscordStatus {
  enabled: boolean;
  connected: boolean;
  ready: boolean;
  authenticated: boolean;
  user?: string;
  error?: string;
}

export interface DiscordVoiceSettings {
  thresholdDb?: number;
  autoThreshold?: boolean;
  krisp?: boolean;
  agc?: boolean;
  echo?: boolean;
}

export interface HomeAssistantStatus {
  enabled: boolean;
  connected: boolean;
  version?: string;
  error?: string;
  activeSource?: 'ha' | 'usb' | 'none';
}

export interface AutoTuningStatus {
  enabled: boolean;
  samplesCount: number;
  adaptedDistanceCenter: number;
  adaptedDistanceMin: number;
  adaptedDistanceMax: number;
  adaptedHeartRateAvg: number;
  adaptedBreathRateAvg: number;
  stabilityScore: number;
  /** false dopóki kroczące okno stabilności się nie napełni (UI pokazuje "Nauka…") */
  stabilityReady: boolean;
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
  deviceInfo?: {
    fwVersion?: string;
    uptimeSec?: number;
    chipTempC?: number;
  };
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

export interface CalibrationSamples {
  ambientDistances: number[];
  ambientPresenceFrames: number;
  ambientTotalFrames: number;
  ambientLux: number[];
  ambientHeartRates: number[];
  ambientBreathRates: number[];
  userDistances: number[];
  userHeartRates: number[];
  userBreathRates: number[];
  userLux: number[];
  userTotalFrames: number;
}

export interface CalibrationResults {
  ambientCleanlinessPct: number;
  ambientNoiseCm: number;
  ambientFalsePresenceCount: number;
  ambientAvgLux: number;
  ambientGhostDetected: boolean;
  ambientGhostDistanceCm: number;
  userSeatedDistanceCm: number;
  userMinDistanceCm: number;
  userMaxDistanceCm: number;
  userAvgHeartRate: number;
  userAvgBreathRate: number;
  userPostureSpreadCm: number;
  recommendedGateMinCm: number;
  recommendedGateMaxCm: number;
  recommendedDeepAwayConfirmMs: number;
  recommendedTimeoutAwayMs: number;
  targetVariance: number;
  stabilityScore: number;
  reportSummary: string;
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
  discord?: DiscordStatus;
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

/** Wynik akcji/testu SignalRGB: via = ścieżka wykonania (rest/deeplink/none). */
export interface SignalRGBTestResult {
  ok: boolean;
  via?: 'rest' | 'deeplink' | 'none';
  reason?: string;
}

export interface DiagSessionTimelineItem {
  offsetMs: number;
  timeStr: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface DiagSessionAnalysis {
  exitLatencySec: number | null;
  audioSwitchLatencyMs: number | null;
  pathTaken: 'geometric_fast' | 'seat_abandoned' | 'standard_timeout' | 'dropout_protection' | 'input_held' | 'unknown';
  pathDescription: string;
  speedRating: 'ultra_fast' | 'fast' | 'moderate' | 'delayed';
  bottlenecks: string[];
  recommendations: string[];
}

/** Raport sesji diagnostycznej "Wyjście z pokoju" (diag:stop). */
export interface DiagSessionReport {
  startedAt: number;
  endedAt: number;
  durationSec?: number;
  count: number;
  timeline?: DiagSessionTimelineItem[];
  analysis?: DiagSessionAnalysis;
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
  discordApplyVoice: (args: { gateDb?: number; autoThreshold?: boolean; krisp?: boolean; agc?: boolean; echo?: boolean }) => Promise<boolean>;
  discordGetStatus: () => Promise<DiscordStatus>;
  discordGetVoiceSettings: () => Promise<{ ok: boolean; settings?: DiscordVoiceSettings; user?: string; error?: string }>;
  discordAuthorize: () => Promise<{ ok: boolean; user?: string; error?: string }>;
  testDevice: (name: string) => Promise<Snapshot>;
  screensaverStart: () => Promise<boolean>;
  screensaverDismiss: () => void;
  openConfigDir: () => Promise<boolean>;
  resetConfig: () => Promise<Snapshot>;
  resetAutoTuning: () => Promise<{ ok: boolean }>;
  radarApplyCalibration: (data: {
    centerCm: number;
    varianceCm: number;
    heartRate: number;
    breathRate: number;
    minGateCm: number;
    maxGateCm: number;
    deepAwayConfirmMs?: number;
    timeoutAwayMs?: number;
  }) => Promise<{ ok: boolean; snapshot: Snapshot }>;
  diagRecord: (durationSec?: number) => Promise<DiagRecordResult>;
  diagRecordStart: (durationSec?: number) => Promise<DiagRecordResult>;
  diagRecordStop: () => Promise<DiagRecordResult>;
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
    binarySensors: { entity_id: string; name: string; state: string; deviceName?: string }[];
    sensors: { entity_id: string; name: string; state: string; unit?: string; deviceName?: string }[];
    /** Encje akcji (button/automation/script/scene/input_boolean/switch) do pickera automatyzacji i przycisków */
    actions?: { entity_id: string; name: string; domain: string; deviceName?: string }[];
    recommended?: { presence?: string; distance?: string; heartRate?: string; breathRate?: string };
  }>;
  /**
   * Wywołanie usługi na encji HAOS dla domeny (automation/script/button/scene/
   * input_boolean/switch) — używane przez przyciski "Testuj" w panelu HAOS.
   */
  haCallService: (entityId: string) => Promise<{ ok: boolean; message?: string; error?: string }>;

  // SignalRGB Integration
  signalrgbTestAway: () => Promise<SignalRGBTestResult>;
  signalrgbTestDesk: () => Promise<SignalRGBTestResult>;
  /** Wykryty tier Local API: REST dostępny czy 403 (wymagany Pro) + treść odmowy */
  signalrgbGetStatus: () => Promise<{ restAvailable: boolean; proRequired: boolean; detail?: string }>;
  /** Zainstalowane efekty z dysku VortxEngine/WhirlwindFX (podpowiedzi do pickerów, bez Pro) */
  signalrgbListEffects: () => Promise<string[]>;
  /** Ręczny/testowy podgląd wybranego efektu z opcjonalnym kolorem */
  signalrgbApplyEffect: (effectName: string, color?: string) => Promise<SignalRGBTestResult>;

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
