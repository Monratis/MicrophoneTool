import { BrowserWindow, screen } from 'electron';
import { resolveWindowIcon } from './appContext';

/**
 * Własne powiadomienie OSD (HUD na ekranie) — przezroczyste okno always-on-top,
 * kliknięcia przechodzą na wierzch (click-through). Działa płynnie bez mrugania,
 * z idealnym wycentrowaniem i delikatnym breathing glow.
 */

const KIND_COLORS: Record<string, string> = {
  listen: '#38bdf8',
  ok: '#22c55e',
  miss: '#f59e0b',
  blocked: '#ef4444',
  mute: '#ef4444',
  unmute: '#22c55e',
  loading: '#38bdf8',
  info: '#38bdf8'
};

const KIND_SHADOW: Record<string, string> = {
  listen: '0 10px 30px rgba(0,0,0,.65), 0 0 22px rgba(56,189,248,.45)',
  ok: '0 10px 30px rgba(0,0,0,.65), 0 0 22px rgba(34,197,94,.45)',
  miss: '0 10px 30px rgba(0,0,0,.65), 0 0 22px rgba(245,158,11,.45)',
  blocked: '0 10px 30px rgba(0,0,0,.65), 0 0 22px rgba(239,68,68,.45)',
  mute: '0 10px 30px rgba(0,0,0,.65), 0 0 22px rgba(239,68,68,.45)',
  unmute: '0 10px 30px rgba(0,0,0,.65), 0 0 22px rgba(34,197,94,.45)',
  loading: '0 10px 30px rgba(0,0,0,.65), 0 0 18px rgba(56,189,248,.35)',
  info: '0 10px 30px rgba(0,0,0,.65), 0 0 18px rgba(56,189,248,.35)'
};

const KIND_ICONS: Record<string, string> = {
  listen: '🎙️',
  ok: '✓',
  miss: '❓',
  blocked: '🚫',
  mute: '🔇',
  unmute: '🎙️',
  loading: '⏳',
  info: '💡'
};

let osdWin: BrowserWindow | null = null;
let hideTimer: NodeJS.Timeout | null = null;
let isLoaded = false;
let pendingPayload: { text: string; kind: string; ms: number; title?: string } | null = null;

function buildBaseHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background: transparent !important;
      overflow: hidden;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .hud-capsule {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 3px;
      min-width: 260px;
      max-width: 480px;
      padding: 10px 22px;
      border-radius: 20px;
      background: rgba(13, 17, 24, 0.94);
      backdrop-filter: blur(28px) saturate(190%);
      -webkit-backdrop-filter: blur(28px) saturate(190%);
      border: 1px solid rgba(56, 189, 248, 0.4);
      box-shadow: 0 16px 40px -6px rgba(0, 0, 0, 0.8), 0 0 1px 1px rgba(255, 255, 255, 0.08), 0 0 20px -4px rgba(56, 189, 248, 0.35);
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      opacity: 1;
      transform: translateY(0) scale(1);
      transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s ease, box-shadow 0.35s ease;
    }
    .hud-capsule.hidden {
      opacity: 0;
      transform: translateY(-10px) scale(0.96);
      pointer-events: none;
    }
    .hud-header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      line-height: 1;
    }
    .hud-icon {
      font-size: 12px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
    }
    .hud-title {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: #38bdf8;
      opacity: 0.95;
      transition: color 0.3s ease;
    }
    .hud-text {
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: -0.1px;
      line-height: 1.35;
      color: #f8fafc;
      word-break: break-word;
      text-align: center;
      width: 100%;
    }
    .eq-bars {
      display: none;
      align-items: center;
      gap: 2px;
      height: 10px;
      margin-left: 2px;
    }
    .eq-bars.active {
      display: inline-flex;
    }
    .eq-bar {
      width: 2px;
      height: 8px;
      background: #38bdf8;
      border-radius: 1px;
      animation: eqDance 0.75s ease-in-out infinite alternate;
    }
    .eq-bar:nth-child(2) { animation-delay: 0.2s; height: 11px; }
    .eq-bar:nth-child(3) { animation-delay: 0.4s; height: 6px; }
    @keyframes eqDance {
      0% { transform: scaleY(0.35); opacity: 0.7; }
      100% { transform: scaleY(1.1); opacity: 1; }
    }
  </style></head><body>
    <div id="capsule" class="hud-capsule hidden">
      <div class="hud-header">
        <span id="icon" class="hud-icon">🎙️</span>
        <div id="title" class="hud-title">DeskSense</div>
        <div id="eq" class="eq-bars">
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
          <div class="eq-bar"></div>
        </div>
      </div>
      <div id="msg" class="hud-text">Słucham…</div>
    </div>
    <script>
      window.__update = function(d) {
        const capsule = document.getElementById('capsule');
        const icon = document.getElementById('icon');
        const title = document.getElementById('title');
        const msg = document.getElementById('msg');
        const eq = document.getElementById('eq');
        if (!capsule || !icon || !title || !msg) return;

        icon.textContent = d.icon || '🎙️';
        title.textContent = d.title || 'DeskSense';
        title.style.color = d.color || '#38bdf8';
        msg.textContent = d.text || '';
        
        capsule.style.borderColor = (d.color || '#38bdf8') + '66';
        capsule.style.boxShadow = '0 16px 40px -6px rgba(0, 0, 0, 0.8), 0 0 1px 1px rgba(255, 255, 255, 0.08), 0 0 22px -4px ' + (d.color || '#38bdf8') + '55';
        
        if (eq) {
          if (d.isPulse) eq.classList.add('active');
          else eq.classList.remove('active');
        }

        capsule.classList.remove('hidden');
      };
      window.__hide = function() {
        const capsule = document.getElementById('capsule');
        if (capsule) capsule.classList.add('hidden');
      };
    </script>
  </body></html>`;
}

function ensureWindow(): BrowserWindow | null {
  if (osdWin && !osdWin.isDestroyed()) return osdWin;
  try {
    const winIcon = resolveWindowIcon();
    isLoaded = false;
    osdWin = new BrowserWindow({
      width: 540,
      height: 130,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      show: false,
      thickFrame: false,
      roundedCorners: false,
      icon: winIcon ?? undefined,
      webPreferences: {
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false
      }
    });

    osdWin.setIgnoreMouseEvents(true);
    osdWin.setAlwaysOnTop(true, 'screen-saver', 1);
    osdWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    osdWin.webContents.once('did-finish-load', () => {
      isLoaded = true;
      if (pendingPayload && osdWin && !osdWin.isDestroyed()) {
        const p = pendingPayload;
        pendingPayload = null;
        showVoiceOsd(p.text, p.kind, p.ms, p.title);
      }
    });

    osdWin.on('closed', () => {
      osdWin = null;
      isLoaded = false;
    });

    void osdWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBaseHtml())}`);
    return osdWin;
  } catch (err) {
    console.warn('[VoiceOSD] Błąd tworzenia okna OSD:', err);
    return null;
  }
}

export function initVoiceOsd(): void {
  ensureWindow();
}

export function showVoiceOsd(text: string, kind: string, ms = 3000, title?: string): void {
  try {
    const win = ensureWindow();
    if (!win || win.isDestroyed()) return;

    if (!isLoaded) {
      pendingPayload = { text, kind, ms, title };
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const width = 540;
    const height = 130;
    const x = Math.round(display.bounds.x + (display.bounds.width - width) / 2);
    const y = Math.round(display.bounds.y + 40);

    win.setBounds({ x, y, width, height });

    const color = KIND_COLORS[kind] || '#38bdf8';
    const shadow = KIND_SHADOW[kind] || KIND_SHADOW.listen;
    const icon = KIND_ICONS[kind] || '💡';
    const isPulse = kind === 'listen';
    const resolvedTitle =
      title ||
      (kind === 'listen'
        ? 'DeskSense · Słucham'
        : kind === 'ok'
          ? 'DeskSense · Wykonano'
          : kind === 'mute'
            ? 'DeskSense · Wyciszenie'
            : kind === 'unmute'
              ? 'DeskSense · Mikrofon aktywny'
              : kind === 'miss'
                ? 'DeskSense · Nierozpoznano'
                : kind === 'blocked'
                  ? 'DeskSense · Zablokowano'
                  : 'DeskSense');

    const updatePayload = {
      text,
      kind,
      color,
      shadow,
      icon,
      isPulse,
      title: resolvedTitle
    };

    win.webContents.executeJavaScript(`window.__update(${JSON.stringify(updatePayload)})`).catch(() => {});
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.moveTop();

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (osdWin && !osdWin.isDestroyed()) {
        osdWin.webContents.executeJavaScript('window.__hide()').catch(() => {});
        setTimeout(() => {
          if (osdWin && !osdWin.isDestroyed()) osdWin.hide();
        }, 220);
      }
    }, ms);
  } catch (err) {
    console.warn('[VoiceOSD] Błąd wyświetlania OSD:', err);
  }
}

export function hideVoiceOsd(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (osdWin && !osdWin.isDestroyed()) {
    osdWin.webContents.executeJavaScript('window.__hide()').catch(() => {});
    setTimeout(() => {
      if (osdWin && !osdWin.isDestroyed()) osdWin.hide();
    }, 220);
  }
}

export function closeVoiceOsd(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  pendingPayload = null;
  if (osdWin && !osdWin.isDestroyed()) osdWin.destroy();
  osdWin = null;
  isLoaded = false;
}