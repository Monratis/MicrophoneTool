// Wspolne helpery UI renderera (esc, chime, typy zakladek).

const STATE_LABEL: Record<string, string> = { desk: 'Przy biurku (Stacjonarny)', headset: 'Poza biurkiem (Mobilny)' };

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// ---------- Web Audio Chime Synthesizer with Sound Profiles ----------
let sharedAudioCtx: AudioContext | null = null;
const CHIME_MAX_GAIN = 0.35;

type ChimeStyle = 'harmonic' | 'modern' | 'soft_click' | 'marimba';

function playChime(state: 'desk' | 'headset' | 'away', volume = 0.2, style: ChimeStyle = 'harmonic') {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }
    const ctx = sharedAudioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    const safeVol = Math.min(CHIME_MAX_GAIN, Math.max(0.01, volume));

    if (style === 'modern') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(state === 'desk' ? 880 : 1318, now);
      osc.frequency.exponentialRampToValueAtTime(state === 'desk' ? 1760 : 659, now + 0.09);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(safeVol * 0.9, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (style === 'soft_click') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(state === 'desk' ? 440 : 330, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(safeVol * 0.8, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (style === 'marimba') {
      [state === 'desk' ? 523.25 : 659.25, state === 'desk' ? 659.25 : 523.25].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.04);
        gain.gain.setValueAtTime(0.0001, now + idx * 0.04);
        gain.gain.linearRampToValueAtTime(safeVol * 0.6, now + idx * 0.04 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.04 + 0.18);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.04);
        osc.stop(now + idx * 0.04 + 0.22);
      });
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      if (state === 'desk') {
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.08);
      } else {
        osc.frequency.setValueAtTime(783.99, now);
        osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.08);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(safeVol, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch (_) {}
}

/**
 * Odtwarzanie własnego pliku audio z dysku (mp3/wav/ogg) zamiast syntezowanego
 * chime. Strona w packaged app ma origin file://, więc file:// media gra bez
 * webSecurity. Zwraca false, gdy plik nieustawiony lub odtwarzacz zawodzi —
 * wtedy wywołujący ma spaść na syntezowany chime.
 */
function playCustomAudioFile(filePath: string, state: 'desk' | 'headset' | 'away', volume = 0.2): boolean {
  if (!filePath) return false;
  try {
    const normalized = filePath.replace(/\\/g, '/').split('?')[0].split('#')[0];
    const audio = new Audio(encodeURI(`file:///${normalized.replace(/^\//, '')}`));
    audio.volume = Math.min(1, Math.max(0.01, volume));
    void audio.play().catch(() => playChime(state, volume));
    return true;
  } catch (_) {
    return false;
  }
}


type TabType = 'home' | 'settings' | 'logs' | 'about';
type SettingsTab = 'port' | 'timeouts' | 'biometrics' | 'discord' | 'signalrgb' | 'chime' | 'haos';

export {
  esc,
  playChime,
  playCustomAudioFile,
  STATE_LABEL,
  type ChimeStyle,
  type TabType,
  type SettingsTab
};
