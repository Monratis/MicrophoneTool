import { BrowserWindow, screen } from 'electron';

/**
 * Własne powiadomienie OSD (NIE Windows toast) — przezroczyste okno always-on-top,
 * kliknięcia przechodzą na wierzch. Działa nawet gdy okno ustawień jest ukryte/zwinięte.
 */

const KIND_COLORS: Record<string, string> = {
  listen: '#38bdf8',
  ok: '#22c55e',
  miss: '#f59e0b',
  blocked: '#ef4444',
  loading: '#38bdf8'
};

const KIND_SHADOW: Record<string, string> = {
  listen: '0 0 22px rgba(56,189,248,.45)',
  ok: '0 0 22px rgba(34,197,94,.45)',
  miss: '0 0 22px rgba(245,158,11,.45)',
  blocked: '0 0 22px rgba(239,68,68,.45)',
  loading: '0 0 18px rgba(56,189,248,.35)'
};

let osdWin: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(text: string, kind: string): string {
  const color = KIND_COLORS[kind] || '#38bdf8';
  const shadow = KIND_SHADOW[kind] || KIND_SHADOW.listen;
  const pulse = kind === 'listen' ? `
    @keyframes pulse { 0%,100% { box-shadow: 0 8px 24px rgba(0,0,0,.6), 0 0 14px ${color}55; } 50% { box-shadow: 0 8px 24px rgba(0,0,0,.6), 0 0 30px ${color}aa; } }
    .pill { animation: pulse 1.2s ease-in-out infinite; }
  ` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
    .pill {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      max-width: 440px; padding: 10px 18px; border-radius: 14px;
      background: rgba(19,25,34,.94); backdrop-filter: blur(12px);
      border: 1px solid ${color}; box-shadow: 0 8px 24px rgba(0,0,0,.6), ${shadow};
      color: #fff; font-family: "Segoe UI", system-ui, sans-serif;
      transform: translateY(-14px); opacity: 0;
      animation: pop .22s cubic-bezier(.16,1,.3,1) forwards;
    }
    @keyframes pop { to { transform: translateY(0); opacity: 1; } }
    .title { font-size: 10px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; opacity: .7; }
    .text { font-size: 13.5px; font-weight: 700; line-height: 1.35; }
    ${pulse}
  </style></head><body>
    <div class="pill"><div class="title">DeskSense</div><div class="text">${escHtml(text)}</div></div>
  </body></html>`;
}

export function showVoiceOsd(text: string, kind: string, ms = 3000): void {
  try {
    const display = screen.getPrimaryDisplay();
    const { width } = display.workAreaSize;

    if (!osdWin || osdWin.isDestroyed()) {
      osdWin = new BrowserWindow({
        width: 500,
        height: 110,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        movable: false,
        hasShadow: false,
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false
        }
      });
      osdWin.setIgnoreMouseEvents(true, { forward: true });
      osdWin.setAlwaysOnTop(true, 'screen-saver');
      osdWin.on('closed', () => {
        osdWin = null;
      });
    }

    const w = osdWin.getBounds().width;
    osdWin.setPosition(Math.round((width - w) / 2), 40);

    void osdWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(text, kind))}`);
    osdWin.showInactive();

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (osdWin && !osdWin.isDestroyed()) osdWin.hide();
    }, ms);
  } catch {
    // OSD nigdy nie może wywrócić nasłuchu — przy błędzie po cichu pomijamy
  }
}

export function closeVoiceOsd(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (osdWin && !osdWin.isDestroyed()) osdWin.destroy();
  osdWin = null;
}