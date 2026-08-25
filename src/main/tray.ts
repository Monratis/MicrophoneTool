import { Tray, Menu, nativeImage, app } from 'electron';
import type { AppContext } from './appContext';

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
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXUlEQVR4nO3SQQoAIAgEwJ7Ql3tWr6trWBpCKtUueFN2DqaEkORamuWElosIr3IWAYDmmAsAAJgDdhl3AAAgBEAx7wEkkPYWgDsB4U8YDjg5AEwAT8Sy3Ashln+ZDoqHy6bNXpYkAAAAAElFTkSuQmCC';
const TRAY_PNG_AWAY =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAg0lEQVR4nO3TMQ6AMAwDwO78f+WXzCA2hCCNncaAiKVuNL5WtLXKKcs8rZnr0XIToSq/RbCD9kgBnqQAmAwDRBIGoCfzfu8CIMXoXhjAvhAaEDm9Z0Y6oPcvFMAE9DazgOMc+Q3IX0EBhgOspAAQDHo73wNkrAK8D6BEXJarEGb5L7MBuujMYhVrKjAAAAAASUVORK5CYII=';
const TRAY_PNG_DEF =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXUlEQVR4nO3SQQoAIAgEwB7bE/pFj65rWBpCKtUueFN2DqaEkORSm+WElosIr3IWAYDmmAsAAJgDdhl3AAAgBEAx7wEkkPYWgDsB4U8YDjg5AEwAT8Sy3Ashln+ZDs1pCdFUvqKZAAAAAElFTkSuQmCC';

const TRAY_ICONS = {
  desk: nativeImage.createFromDataURL(TRAY_PNG_DESK),
  away: nativeImage.createFromDataURL(TRAY_PNG_AWAY),
  default: nativeImage.createFromDataURL(TRAY_PNG_DEF)
};

export function trayIcon(state: string | null | undefined): Electron.NativeImage {
  return TRAY_ICONS[state as keyof typeof TRAY_ICONS] || TRAY_ICONS.default;
}

export function createTray(ctx: AppContext): Electron.Tray {
  const tray = new Tray(trayIcon('away'));
  tray.on('click', () => ctx.showSettings());
  tray.on('double-click', () => ctx.showSettings());
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
      click: async () => {
        const res = await ctx.audio.toggleMute();
        const isMuted = res?.isMuted;
        ctx.pushEvent('toast', { message: isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️' });
        ctx.showWindowsNotification(
          'Auto Audio Switch',
          isMuted ? 'Mikrofon został wyciszony 🔇' : 'Wyciszenie wyłączone 🎙️'
        );
        ctx.refreshSnapshot();
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
    { label: 'Wyjdź', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Auto Audio Switch · ${stateText} · ${MODE_LABEL[s.mode]}`);
  // Stan 'headset' odpowiada nieobecności przy biurku — pokazujemy ikonę 'away'
  const iconKey = s.state === 'headset' ? 'away' : s.state;
  tray.setImage(trayIcon(iconKey));
}
