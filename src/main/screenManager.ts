import { BrowserWindow, screen, powerMonitor } from 'electron';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { appendLog } from './logger';
import type Config from './config';
import type AudioController from './audioController';

/**
 * Menedżer 2-etapowego zarządzania ekranami:
 * 1. Czarny wygaszacz ekranu (overlay bezramkowy na wszystkich monitorach) po krótkim czasie nieobecności (np. 1 min).
 * 2. Sprzętowe uśpienie zasilania monitorów (DPMS) po dłuższej nieobecności (np. 10 min).
 * 3. Błyskawiczne zdjęcie wygaszacza (0 ms) i wybudzenie sprzętowe przy powrocie do biurka.
 */
export default class ScreenManager extends EventEmitter {
  private readonly config: Config;
  private readonly audio: AudioController;

  private screensaverTimer: NodeJS.Timeout | null = null;
  private displaySleepTimer: NodeJS.Timeout | null = null;
  private activePollTimer: NodeJS.Timeout | null = null;
  private lastIdleSec = 0;
  private screensaverWindows: BrowserWindow[] = [];
  private isScreensaverActive = false;
  private isDisplaySleeping = false;
  private onMetricsChangedBound: () => void;

  constructor(config: Config, audio: AudioController) {
    super();
    this.config = config;
    this.audio = audio;

    this.onMetricsChangedBound = () => {
      if (this.isScreensaverActive) {
        this.scheduleRecreate();
      }
    };

    screen.on('display-added', this.onMetricsChangedBound);
    screen.on('display-removed', this.onMetricsChangedBound);
    screen.on('display-metrics-changed', this.onMetricsChangedBound);
  }

  onAway(): void {
    this.clearTimers();

    // 1. Czarny wygaszacz po zadanym czasie (domyślnie 60s / 1 min).
    // Celowo NIEZALEŻNY od DPMS — to podstawowa reakcja na nieobecność
    // i ma działać także przy wyłączonym uśpianiu monitorów.
    const ssEnabled = this.config.get('screensaverOnAway') !== false;
    if (ssEnabled) {
      const ssDelay = Math.max(1000, Number(this.config.get('screensaverDelayMs')) || 60000);
      this.screensaverTimer = setTimeout(() => {
        this.screensaverTimer = null;
        this.showScreensaver();
      }, ssDelay);
    }

    // 2. Sprzętowe uśpienie zasilania monitorów DPMS (domyślnie 600s / 10 min)
    if (this.config.get('sleepMonitorsOnAway')) {
      const sleepDelay = Math.max(1000, Number(this.config.get('sleepMonitorsDelayMs')) || 600000);
      this.displaySleepTimer = setTimeout(() => {
        this.displaySleepTimer = null;
        this.sleepDisplays();
      }, sleepDelay);
    }
  }

  onDesk(): void {
    this.clearTimers();

    // 1. Błyskawiczne zdjęcie czarnego wygaszacza (0 ms)
    if (this.isScreensaverActive) {
      this.hideScreensaver();
    }

    // 2. Wybudzenie fizyczne monitorów (DPMS) przy powrocie do biurka
    const shouldWake = this.config.get('wakeMonitorsOnDesk') !== false;
    if (this.isDisplaySleeping || shouldWake) {
      const wasSleeping = this.isDisplaySleeping;
      this.isDisplaySleeping = false;
      if (shouldWake) {
        appendLog('SCREEN', `Wybudzanie fizyczne monitorów DPMS (powrót użytkownika do biurka${wasSleeping ? ' — po uśpieniu DeskSense' : ''})`);
        void this.audio
          .wakeDisplay()
          .then(() => this.emit('displayState', 'wake'))
          .catch((err) => {
            appendLog('SCREEN', `Błąd wybudzania monitorów: ${(err as Error).message}`);
          });
      }
    }
  }

  showScreensaver(): void {
    if (this.isScreensaverActive) return;
    this.isScreensaverActive = true;
    appendLog('SCREEN', 'Aktywowano czarny wygaszacz ekranu (brak obecności)');
    this.createScreensaverWindows();
    this.startActivePoll();
  }

  hideScreensaver(): void {
    this.stopActivePoll();
    if (!this.isScreensaverActive && this.screensaverWindows.length === 0) return;
    this.isScreensaverActive = false;
    appendLog('SCREEN', 'Wyłączono czarny wygaszacz ekranu — powrót użytkownika');
    this.destroyScreensaverWindows();
  }

  sleepDisplays(): void {
    this.isDisplaySleeping = true;
    appendLog('SCREEN', 'Sprzętowe uśpienie zasilania monitorów DPMS (długa nieobecność)');
    void this.audio
      .sleepDisplay()
      .then(() => this.emit('displayState', 'sleep'))
      .catch((err) => {
        appendLog('SCREEN', `Błąd sprzętowego uśpienia monitorów: ${(err as Error).message}`);
      });
  }

  /**
   * Twarda gwarancja zamknięcia: wejście użytkownika (mysz/klik/scroll/dotyk
   * z nakładki przez screensaver:dismiss, klawiatura przez poll idle) ZAWSZE
   * i natychmiast zdejmuje wygaszacz. Żadna ścieżka nie może tego blokować.
   */
  notifyUserInput(): void {
    this.hideScreensaver();
    this.emit('userActivity');
  }

  private startActivePoll(): void {
    this.stopActivePoll();
    try {
      this.lastIdleSec = powerMonitor.getSystemIdleTime();
    } catch {
      this.lastIdleSec = 0;
    }
    this.activePollTimer = setInterval(() => {
      if (!this.isScreensaverActive) {
        this.stopActivePoll();
        return;
      }
      try {
        const idle = powerMonitor.getSystemIdleTime();
        if (typeof idle === 'number' && Number.isFinite(idle) && (idle <= 1 || idle < this.lastIdleSec)) {
          this.hideScreensaver();
          this.emit('userActivity');
        }
        this.lastIdleSec = idle;
      } catch {}
    }, 200);
  }

  private stopActivePoll(): void {
    if (this.activePollTimer) {
      clearInterval(this.activePollTimer);
      this.activePollTimer = null;
    }
  }

  private createScreensaverWindows(): void {
    this.destroyScreensaverWindows();

    const displays = screen.getAllDisplays();
    // Dowolne wejście na stronie (mysz/klik/scroll/dotyk) natychmiast wysyła
    // screensaver:dismiss przez własny preload. Klawiatura nie trafia do strony
    // (okno focusable:false, żeby nakładka nie kradła fokusu) — tę ścieżkę
    // obsługuje poll idle (startActivePoll, 200 ms) w main.
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100vw;height:100vh;background:#000000;overflow:hidden;cursor:none;user-select:none;}</style></head><body><script>
(function () {
  var sent = false;
  // Chromium syntezuje mousemove, gdy tworzone okno pojawia sie pod
  // nieruchomym kursorem — bez grace period wygaszacz gaslby sie sam
  // w chwili aktywacji. Prawdziwe wejście w tym oknie i tak lapie poll
  // idle w main (powerMonitor.getSystemIdleTime, 200 ms).
  var armedAt = Date.now() + 2000;
  var dismiss = function () {
    if (sent || Date.now() < armedAt) return;
    sent = true;
    try { window.api.screensaverDismiss(); } catch (e) {}
  };
  ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart', 'pointerdown'].forEach(function (ev) {
    window.addEventListener(ev, dismiss, { passive: true });
  });
})();
</script></body></html>`;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

    for (const disp of displays) {
      try {
        const win = new BrowserWindow({
          x: disp.bounds.x,
          y: disp.bounds.y,
          width: disp.bounds.width,
          height: disp.bounds.height,
          frame: false,
          transparent: false,
          backgroundColor: '#000000',
          skipTaskbar: true,
          resizable: false,
          movable: false,
          focusable: false,
          hasShadow: false,
          show: false,
          enableLargerThanScreen: true,
          // thickFrame (domyślnie true przy frame:false) dokleja systemową ramkę
          // DWM — na Windows 11 rysuje się jako jasna linia u góry i jasne
          // narożniki na czarnym tle nakładki. roundedCorners zdejmuje zaokrąglenie.
          thickFrame: false,
          roundedCorners: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            // Ten sam preload co okno główne (sandbox wymaga CJS — osobny wpis
            // w electron-vite przełączyłby output na .mjs, którego sandbox nie ładuje)
            preload: path.join(__dirname, '../preload/index.js')
          }
        });

        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

        win.once('ready-to-show', () => {
          if (this.isScreensaverActive && !win.isDestroyed()) {
            win.setBounds(disp.bounds);
            win.showInactive();
          }
        });

        win.loadURL(dataUrl)
          .then(() => {
            if (this.isScreensaverActive && !win.isDestroyed() && !win.isVisible()) {
              win.setBounds(disp.bounds);
              win.showInactive();
            }
          })
          .catch(() => {});

        this.screensaverWindows.push(win);
      } catch (err) {
        appendLog('SCREEN', `Błąd tworzenia okna wygaszacza na monitorze: ${(err as Error).message}`);
      }
    }
  }

  /**
   * display-metrics-changed potrafi przyjść seriami (zmiana DPI, układu
   * monitorów, wybudzenie) — odtwarzanie okien debounce'ujemy, żeby nie
   * produkować serii destroy/create.
   */
  private recreateDebounceTimer: NodeJS.Timeout | null = null;

  private scheduleRecreate(): void {
    if (this.recreateDebounceTimer) return;
    this.recreateDebounceTimer = setTimeout(() => {
      this.recreateDebounceTimer = null;
      if (this.isScreensaverActive) {
        this.recreateScreensaverWindows();
      }
    }, 500);
  }

  private recreateScreensaverWindows(): void {
    if (!this.isScreensaverActive) return;
    this.createScreensaverWindows();
  }

  private destroyScreensaverWindows(): void {
    for (const win of this.screensaverWindows) {
      try {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      } catch {
        /* ignore */
      }
    }
    this.screensaverWindows = [];
  }

  clearTimers(): void {
    if (this.screensaverTimer) {
      clearTimeout(this.screensaverTimer);
      this.screensaverTimer = null;
    }
    if (this.displaySleepTimer) {
      clearTimeout(this.displaySleepTimer);
      this.displaySleepTimer = null;
    }
    if (this.recreateDebounceTimer) {
      clearTimeout(this.recreateDebounceTimer);
      this.recreateDebounceTimer = null;
    }
    this.stopActivePoll();
  }

  stop(): void {
    this.clearTimers();
    this.hideScreensaver();
    screen.removeListener('display-added', this.onMetricsChangedBound);
    screen.removeListener('display-removed', this.onMetricsChangedBound);
    screen.removeListener('display-metrics-changed', this.onMetricsChangedBound);
  }
}
