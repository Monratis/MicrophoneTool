import { Tray, Menu, nativeImage, app } from 'electron';
import type { AppContext } from './appContext';
import { toggleMuteWithFeedback } from './appContext';

const STATE_LABEL: Record<string, string> = {
  desk: 'Przy biurku (Stacjonarny)',
  away: 'Poza biurkiem (Mobilny)'
};
const MODE_LABEL: Record<string, string> = {
  auto: 'Auto (radar)',
  desk: 'Stacjonarny',
  headset: 'Mobilny'
};

// ---------- tray icons (crisp 32x32 PNG bitmaps) ----------

const TRAY_PNG_DESK =
  'data:image/png;base64,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';
const TRAY_PNG_AWAY =
  'data:image/png;base64,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';
const TRAY_PNG_DEF =
  'data:image/png;base64,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';

const TRAY_ICONS = {
  desk: nativeImage.createFromDataURL(TRAY_PNG_DESK),
  away: nativeImage.createFromDataURL(TRAY_PNG_AWAY),
  default: nativeImage.createFromDataURL(TRAY_PNG_DEF)
};

import path from 'node:path';
import fs from 'node:fs';

function getTrayIconPath(name: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', name);
  }
  return path.join(__dirname, '..', '..', 'resources', name);
}

export function trayIcon(state: string | null | undefined): Electron.NativeImage {
  const iconName =
    state === 'desk'
      ? 'tray-desk.png'
      : state === 'away' || state === 'headset'
        ? 'tray-away.png'
        : 'tray-default.png';
  const filePath = getTrayIconPath(iconName);
  if (fs.existsSync(filePath)) {
    const img = nativeImage.createFromPath(filePath);
    if (!img.isEmpty()) return img;
  }
  const fallbackKey =
    state === 'desk'
      ? 'desk'
      : state === 'away' || state === 'headset'
        ? 'away'
        : 'default';
  return TRAY_ICONS[fallbackKey] || TRAY_ICONS.default;
}

let trayInstance: Electron.Tray | null = null;

export function createTray(ctx: AppContext): Electron.Tray {
  if (trayInstance && !trayInstance.isDestroyed()) {
    try { trayInstance.destroy(); } catch (_) {}
  }
  const tray = new Tray(trayIcon('away'));
  trayInstance = tray;
  tray.on('click', () => ctx.showSettings());
  tray.on('double-click', () => ctx.showSettings());
  refreshTray(ctx, tray);
  return tray;
}

export function refreshTray(ctx: AppContext, tray: Electron.Tray): void {
  const s = ctx.buildSnapshot();
  const stateText = s.state ? STATE_LABEL[s.state] : '—';
  const menu = Menu.buildFromTemplate([
    { label: `Stan: ${stateText}`, enabled: false },
    { label: `Tryb: ${MODE_LABEL[s.mode]}`, enabled: false },
    { label: `Port: ${s.config.port || 'auto'}`, enabled: false },
    { type: 'separator' },
    { label: 'Ustawienia…', click: () => ctx.showSettings() },
    {
      label: 'Wycisz / Odcisz mikrofon (Ctrl+Shift+M)',
      // Wspólny helper: dioda + toast + powiadomienie + snapshot (jak skrót i IPC)
      click: () => {
        void toggleMuteWithFeedback(ctx);
      }
    },
    { type: 'separator' },
    {
      label: 'Tryb automatyczny (radar)',
      type: 'radio',
      checked: s.mode === 'auto',
      click: () => ctx.controller.setMode('auto')
    },
    {
      label: '🎙️ Wymuś mikrofon stacjonarny',
      type: 'radio',
      checked: s.mode === 'desk',
      click: () => ctx.controller.setMode('desk')
    },
    {
      label: '🎧 Wymuś mikrofon mobilny',
      type: 'radio',
      checked: s.mode === 'headset',
      click: () => ctx.controller.setMode('headset')
    },
    { type: 'separator' },
    {
      label: 'Sprawdź aktualizacje…',
      click: () => {
        ctx.showSettings();
        void ctx.updater.checkForUpdates();
      }
    },
    { label: 'Odśwież / wykryj port COM', click: () => void ctx.restartRadar() },
    { type: 'separator' },
    {
      label: 'Autoryzuj Discord (presety głosowe)',
      click: () => {
        if (!ctx.controller.discord) {
          ctx.pushEvent('toast', { message: 'Integracja Discord nie jest skonfigurowana' });
          return;
        }
        ctx.controller.discord.authorizeManually();
        ctx.pushEvent('toast', { message: 'Sprawdź popup zgody w kliencie Discord i zatwierdź autoryzację' });
      }
    },
    { label: 'Wyjdź', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`DeskSense · ${stateText} · ${MODE_LABEL[s.mode]}`);
  // Stan 'headset' odpowiada nieobecności przy biurku — pokazujemy ikonę 'away'
  const iconKey = s.state === 'headset' ? 'away' : s.state;
  tray.setImage(trayIcon(iconKey));
}
