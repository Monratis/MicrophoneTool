import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  port: 'auto',
  baudRate: 115200,
  // Urządzenia wybrane przez użytkownika (domyślnie puste — użytkownik decyduje w GUI)
  micDeskName: '',              // Mikrofon stacjonarny
  micHeadsetName: '',           // Mikrofon mobilny
  // Czas reakcji
  timeoutAwayMs: 3000,
  timeoutDeskMs: 300,
  // Zaawansowana kontrola sensora i strefa fotela (Spatial Distance Gate)
  radarDistanceGateEnabled: true,// Ogranicz wykrywanie tylko do strefy fotela
  radarMinDistanceCm: 40,       // Minimalna odległość (cm)
  radarMaxDistanceCm: 110,      // Maksymalna odległość (cm) — odcina osoby w tle pokoju
  radarSensitivity: 80,         // Czułość sensora (0-100)
  // Filtr zwierząt domowych (Kot / Pies)
  petFilterEnabled: true,       // Automatycznie odfiltrowuje i ignoruje kota/psa na bazie oddechu (>22 RPM) i tętna (>125 BPM)
  // Biometria i rozróżnianie osób (Ty vs Narzeczona/Inni)
  biometricsEnabled: false,     // Rozróżnianie tożsamości na bazie tętna i odległości
  userHeartRateMin: 55,         // Twoje tętno spoczynkowe min (BPM)
  userHeartRateMax: 78,         // Twoje tętno spoczynkowe max (BPM)
  userSeatingDistanceMin: 60,   // Twoja typowa odległość od monitora min (cm)
  userSeatingDistanceMax: 90,   // Twoja typowa odległość od monitora max (cm)
  // Auto-Tuning i samouczenie się parametrów otoczenia (Dynamic Real-Time Adaptation)
  radarAutoTuningEnabled: true, // Automatyczne dopasowywanie do pozycji fotela, szumu tła i biometrii
  radarAutoTuningSpeed: 'balanced', // 'balanced' | 'fast' | 'conservative'
  radarAutoTuningNoiseFloor: 0, // Wyuczony poziom szumu otoczenia (%)
  radarLearnedDistanceCenter: 0,// Wyuczony środek odległości fotela (cm)
  radarLearnedDistanceVariance: 0,// Wyuczone odchylenie odległości (cm)
  radarLearnedHeartRate: 0,     // Wyuczone tętno spoczynkowe (BPM)
  radarLearnedBreathRate: 0,    // Wyuczony oddech spoczynkowy (RPM)
  personMismatchAction: 'ignore', // 'ignore' | 'switch_anyway' | 'notify_only'
  // Zachowania audio i przełączania
  switchMicOnAway: true,        // Przełącz na mikrofon mobilny po odejściu
  switchMicOnDesk: true,        // Przełącz na mikrofon stacjonarny po powrocie
  muteBehaviorOnAway: 'none',   // 'none' | 'mute_stationary' | 'mute_all'
  unmuteOnDesk: true,           // Automatycznie odcisz po powrocie do biurka
  // Integracja z Discordem
  discordIntegration: true,     // Błyskawiczne odświeżanie strumienia głosu w Discordzie
  // Integracja z SignalRGB (oświetlenie / klawiatura / obudowa)
  signalrgbEnabled: false,      // Czy włączona integracja z SignalRGB
  signalrgbPort: 16038,         // Port HTTP API SignalRGB (domyślnie 16038)
  signalrgbAwayAction: 'solid_color', // 'solid_color' | 'turn_off' | 'dim'
  signalrgbAwayColor: '#f59e0b',// Kolor po odejściu (np. bursztynowy / pomarańczowy)
  signalrgbAwayBrightness: 0,   // Poziom przyciemnienia po odejściu (0 - 100)
  signalrgbRestoreOnDesk: true, // Automatyczne przywracanie profilu po powrocie do biurka
  // Zachowania ekranów
  sleepMonitorsOnAway: false,   // Usypiaj monitory po odejściu
  sleepMonitorsDelayMs: 15000,  // Czas oczekiwania przed uśpieniem ekranów (ms)
  wakeMonitorsOnDesk: true,     // Automatycznie wybudzaj monitory po powrocie
  // Dźwięki i powiadomienia
  audioChime: true,             // Dźwięk powiadomienia
  audioChimeOnDesk: true,       // Dźwięk przy powrocie
  audioChimeOnAway: true,       // Dźwięk przy odejściu
  audioChimeVolume: 0.2,        // Głośność (0.0 - 1.0)
  notifications: true,          // Dymki Windows Toast
  // Systemowe
  autoStart: false,
  autoDownloadTools: true,
  globalShortcut: 'CommandOrControl+Shift+M',
  githubRepo: 'Monratis/MicrophoneTool',
  githubToken: process.env.GITHUB_TOKEN || '' // PAT dla prywatnych repo — env GITHUB_TOKEN lub %APPDATA% config
};

export default class Config {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = { ...DEFAULTS, ...parsed };
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[config] load error, restoring defaults:', err.message);
      this.data = { ...DEFAULTS };
      this.save();
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[config] atomic save error:', err.message);
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (innerErr) {
        console.error('[config] fallback save error:', innerErr.message);
      }
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }
}