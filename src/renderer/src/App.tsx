import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioDeviceItem, PushEvent, SerialPortInfo, Snapshot, UpdaterStatus } from './global';

const STATE_LABEL: Record<string, string> = { desk: 'Przy biurku (Stacjonarny)', away: 'Poza biurkiem (Mobilny)' };
const MODE_LABEL: Record<string, string> = {
  auto: 'Auto (radar)',
  desk: 'Stacjonarny',
  headset: 'Mobilny'
};

const MODES: { id: Snapshot['mode']; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto (radar)', hint: 'Automatyczne przełączanie wg obecności przy biurku' },
  { id: 'desk', label: '🎙️ Stacjonarny', hint: 'Wymuś mikrofon stacjonarny' },
  { id: 'headset', label: '🎧 Mobilny', hint: 'Wymuś mikrofon mobilny' }
];

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

interface Toast {
  id: number;
  message: string;
  error?: boolean;
}

function playChime(state: 'desk' | 'away', volume = 0.2) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    if (state === 'desk') {
      // Pleasant upbeat two-tone chime (D5 -> A5)
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.08);
    } else {
      // Pleasant soft down-tone (G5 -> C5)
      osc.frequency.setValueAtTime(783.99, now);
      osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.08);
    }

    const safeVol = Math.min(1, Math.max(0.01, volume));
    gain.gain.setValueAtTime(safeVol, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  } catch (_) {}
}

function IconMic({ state }: { state: string | null }) {
  const color = state === 'desk' ? '#0d0f14' : '#fff';
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function IconLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ kind: 'idle' | 'saved' | 'error'; text: string }>({ kind: 'idle', text: '' });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dirty, setDirty] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const toastId = useRef(0);

  // Updater state
  const [updater, setUpdater] = useState<UpdaterStatus>({ status: 'idle', currentVersion: '0.2.0' });
  const [downloadProgress, setDownloadProgress] = useState<{ percent: number; speed: string } | null>(null);

  // form state (init from snapshot)
  const [form, setForm] = useState<Snapshot['config'] | null>(null);
  const formRef = useRef<Snapshot['config'] | null>(null);
  formRef.current = form;

  const pushToast = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const loadAudioDevices = useCallback(async () => {
    try {
      const devs = await window.api.listDevices();
      setAudioDevices(devs || []);
      const current = devs.find((d) => d.isDefault);
      if (current && typeof current.isMuted === 'boolean') {
        setIsMuted(current.isMuted);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    let mounted = true;
    window.api.getState().then((s) => {
      if (!mounted) return;
      setSnap(s);
      setForm(s.config);
    });
    window.api.getPorts().then(setPorts);
    loadAudioDevices();
    window.api.getUpdaterStatus().then((st) => {
      if (mounted && st) setUpdater(st);
    });

    const off = window.api.onEvent((e: PushEvent) => {
      if (e.type === 'snapshot' && e.snapshot) {
        setSnap(e.snapshot);
        setForm((f) => (f ? { ...f, ...e.snapshot!.config } : e.snapshot!.config));
        setDirty(false);
        loadAudioDevices();
      }
      if (e.type === 'toast' && e.message) pushToast(e.message, e.error);

      if (e.type === 'switch' && e.state) {
        const cfg = formRef.current;
        if (cfg && cfg.audioChime) {
          const shouldChime = e.state === 'desk' ? (cfg.audioChimeOnDesk !== false) : (cfg.audioChimeOnAway !== false);
          if (shouldChime) {
            playChime(e.state as 'desk' | 'away', cfg.audioChimeVolume ?? 0.2);
          }
        }
      }

      if (e.type === 'updater:status') {
        setUpdater((prev) => ({
          ...prev,
          status: (e.status as any) || prev.status,
          updateInfo: e.updateInfo !== undefined ? e.updateInfo : prev.updateInfo,
          error: e.error ? String(e.error) : undefined
        }));
      }

      if (e.type === 'updater:progress') {
        setDownloadProgress({
          percent: e.percent || 0,
          speed: e.speed || ''
        });
      }
    });

    return () => {
      mounted = false;
      off();
    };
  }, [pushToast, loadAudioDevices]);

  const refreshPorts = useCallback(async () => {
    setRefreshing(true);
    const list = await window.api.getPorts();
    setPorts(list);
    await loadAudioDevices();
    setRefreshing(false);
  }, [loadAudioDevices]);

  const patchForm = useCallback((patch: Partial<Snapshot['config']>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  }, []);

  const setMode = useCallback(async (mode: Snapshot['mode']) => {
    const s = await window.api.setMode(mode);
    setSnap(s);
  }, []);

  const setPort = useCallback(async (port: string) => {
    const s = await window.api.setPort(port);
    setSnap(s);
    setForm(s.config);
  }, []);

  const toggleMute = useCallback(async () => {
    const res = await window.api.toggleMute();
    if (res && typeof res.isMuted === 'boolean') {
      setIsMuted(res.isMuted);
      pushToast(res.isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️');
    }
  }, [pushToast]);

  const testDevice = useCallback(async (name: string) => {
    if (!name) {
      pushToast('Wybierz najpierw urządzenie z listy', true);
      return;
    }
    pushToast(`Przełączam na: ${name}…`);
    const s = await window.api.testDevice(name);
    setSnap(s);
    await loadAudioDevices();
  }, [pushToast, loadAudioDevices]);

  const testSleepDisplay = useCallback(async () => {
    pushToast('Usypianie ekranów… (porusz myszką, aby wybudzić)');
    await window.api.sleepDisplay();
  }, [pushToast]);

  const save = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    setSaveState({ kind: 'idle', text: 'Zapisywanie…' });
    try {
      const s = await window.api.updateConfig(form);
      setSnap(s);
      setForm(s.config);
      setDirty(false);
      setSaveState({ kind: 'saved', text: 'Zapisano ✓' });
      pushToast('Konfiguracja zapisana');
    } catch (err) {
      setSaveState({ kind: 'error', text: 'Błąd zapisu' });
      pushToast(`Błąd zapisu: ${String(err)}`, true);
    } finally {
      setSaving(false);
      setTimeout(() => setSaveState((v) => (v.kind === 'idle' ? v : { kind: 'idle', text: '' })), 2500);
    }
  }, [form, pushToast]);

  const [deviceInfo, setDeviceInfo] = useState('');

  const detectDevices = useCallback(async () => {
    setDeviceInfo('Skanowanie podłączonych mikrofonów…');
    const r = await window.api.detectDevices();
    await loadAudioDevices();
    if (r.devices.length === 0) {
      setDeviceInfo('Nie znaleziono aktywnych urządzeń nagrywających w systemie Windows.');
      return;
    }
    if (r.recommended.micDeskName || r.recommended.micHeadsetName) {
      patchForm({
        micDeskName: r.recommended.micDeskName || formRef.current?.micDeskName || '',
        micHeadsetName: r.recommended.micHeadsetName || formRef.current?.micHeadsetName || ''
      });
      pushToast('Zaproponowano mikrofony — kliknij "Zapisz zmiany", aby zatwierdzić');
    }
    const list = r.devices.map((d) => d.name).slice(0, 4).join(' · ');
    setDeviceInfo(
      `Wykryto ${r.devices.length} mikrofonów Windows:\n${list}`
    );
  }, [pushToast, loadAudioDevices, patchForm]);

  // Preset Timing buttons
  const applyPreset = useCallback((deskMs: number, awayMs: number) => {
    patchForm({ timeoutDeskMs: deskMs, timeoutAwayMs: awayMs });
    pushToast(`Zastosowano profil: ${deskMs}ms wejście / ${awayMs}ms wyjście`);
  }, [patchForm, pushToast]);

  // Updater actions
  const checkForUpdates = useCallback(async () => {
    pushToast('Sprawdzam dostępność wydań na GitHubie…');
    try {
      const res = await window.api.checkForUpdates();
      if (res.available) {
        pushToast(`Dostępna nowa wersja: ${res.updateInfo?.version || 'nowa'}`);
      } else {
        pushToast('Posiadasz najnowszą wersję ✓');
      }
    } catch (err) {
      pushToast(`Błąd sprawdzania aktualizacji: ${String(err)}`, true);
    }
  }, [pushToast]);

  const startDownload = useCallback(async () => {
    try {
      pushToast('Rozpoczynam pobieranie aktualizacji…');
      await window.api.downloadUpdate();
    } catch (err) {
      pushToast(`Błąd pobierania: ${String(err)}`, true);
    }
  }, [pushToast]);

  const installUpdate = useCallback(async () => {
    try {
      await window.api.installUpdate();
    } catch (err) {
      pushToast(`Błąd instalacji: ${String(err)}`, true);
    }
  }, [pushToast]);

  const openConfigFolder = useCallback(async () => {
    await window.api.openConfigDir();
    pushToast('Otwarto folder konfiguracji w Eksploratorze');
  }, [pushToast]);

  if (!snap || !form) {
    return <div className="app" style={{ display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Wczytywanie…</div>;
  }

  const state = snap.state;
  const radar = snap.radar;
  const isUnconfigured = !form.micDeskName && !form.micHeadsetName;

  return (
    <div className="app">
      {/* titlebar */}
      <div className="titlebar">
        <div className="brand">
          <span className="logo"><IconLogo /></span>
          Auto Audio Switch
          <span className="ver-tag">v{updater.currentVersion}</span>
        </div>
        <div className="win-btns">
          <button className="close" title="Ukryj do zasobnika (Tray)" onClick={() => window.api.closeWindow()}>
            <IconClose />
          </button>
        </div>
      </div>

      <div className="scroll">
        {/* unconfigured alert banner */}
        {isUnconfigured && (
          <div className="update-banner" style={{ borderColor: 'rgba(245, 158, 11, 0.6)', background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(217, 119, 6, 0.12))' }}>
            <div className="update-banner-icon" style={{ background: '#f59e0b' }}>⚠️</div>
            <div className="update-banner-content">
              <strong style={{ color: '#fbbf24' }}>Wybierz swoje mikrofony poniżej</strong>
              <p>Wybierz mikrofon stacjonarny i mobilny z list i kliknij <strong>Zapisz zmiany</strong>. Aplikacja nie wykonuje żadnych akcji dopóki sam ich nie wskażesz.</p>
            </div>
          </div>
        )}

        {/* update alert banner */}
        {updater.status === 'available' && updater.updateInfo && (
          <div className="update-banner">
            <div className="update-banner-icon"><IconDownload /></div>
            <div className="update-banner-content">
              <strong>Nowa wersja dostępna: v{updater.updateInfo.version}</strong>
              <p>{updater.updateInfo.name || 'Nowe funkcje i poprawki wydajności'}</p>
              <button className="btn btn-sm btn-primary" onClick={startDownload}>
                Pobierz i zaktualizuj
              </button>
            </div>
          </div>
        )}

        {updater.status === 'downloading' && (
          <div className="update-banner downloading">
            <div className="update-banner-content" style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>Pobieranie aktualizacji…</strong>
                <span>{downloadProgress?.percent || 0}% ({downloadProgress?.speed || '...'})</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${downloadProgress?.percent || 0}%` }} />
              </div>
            </div>
          </div>
        )}

        {updater.status === 'downloaded' && (
          <div className="update-banner ready">
            <div className="update-banner-icon">✓</div>
            <div className="update-banner-content">
              <strong>Aktualizacja gotowa do instalacji!</strong>
              <p>Kliknij poniżej, aby zrestartować aplikację.</p>
              <button className="btn btn-sm btn-primary" onClick={installUpdate}>
                Zainstaluj i uruchom ponownie
              </button>
            </div>
          </div>
        )}

        {/* status */}
        <section className="card">
          <h2>Status mikrofonu</h2>
          <div className="status-hero" data-state={state}>
            <div className="status-ring">
              <span className="pulse" />
              <span className="dot"><IconMic state={state} /></span>
            </div>
            <div className="status-meta">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <h1>{state ? STATE_LABEL[state] : (isUnconfigured ? 'Brak konfiguracji' : 'Oczekiwanie…')}</h1>
                <button
                  className={`mute-pill ${isMuted ? 'muted' : ''}`}
                  onClick={toggleMute}
                  title="Wycisz/Odcisz (skrót: Ctrl+Shift+M)"
                >
                  {isMuted ? '🔇 Wyciszony' : '🎙️ Aktywny'}
                </button>
              </div>
              <p>
                Domyślny mikrofon:{' '}
                <strong>{snap.deviceName ?? (isUnconfigured ? 'Nie wybrano (skonfiguruj poniżej)' : '—')}</strong>
              </p>
              <div className="badges">
                <span className="badge">{MODE_LABEL[snap.mode] || snap.mode}</span>
                <span className={`badge ${radar.connected ? 'live' : ''}`}>
                  {radar.connected ? 'Radar: połączony' : 'Radar: brak połączenia'}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* mode */}
        <section className="card">
          <h2>Wymuszenie trybu</h2>
          <div className="segmented">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={snap.mode === m.id ? 'active' : ''}
                title={m.hint}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </section>

        {/* audio devices */}
        <section className="card">
          <h2>Wybór mikrofonów Windows</h2>

          <div className="field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label style={{ margin: 0, fontWeight: 600 }}>🎙️ Mikrofon stacjonarny (przy biurku / USB / XLR)</label>
              {form.micDeskName && (
                <button className="text-btn" onClick={() => testDevice(form.micDeskName)}>
                  ▶ Przetestuj
                </button>
              )}
            </div>
            <select
              className="select"
              value={audioDevices.some((d) => d.name === form.micDeskName) ? form.micDeskName : (form.micDeskName ? '__custom__' : '')}
              onChange={(e) => {
                if (e.target.value !== '__custom__') {
                  patchForm({ micDeskName: e.target.value });
                }
              }}
            >
              <option value="">-- Wybierz mikrofon stacjonarny --</option>
              {audioDevices.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} {d.isDefault ? '(Aktywny domyślny)' : ''}
                </option>
              ))}
              <option value="__custom__">-- Wpisz własną nazwę ręcznie --</option>
            </select>
            <input
              className="input"
              style={{ marginTop: 6 }}
              value={form.micDeskName}
              placeholder="Wybierz z listy powyżej lub wpisz nazwę (np. HyperX QuadCast 2)"
              onChange={(e) => patchForm({ micDeskName: e.target.value })}
            />
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label style={{ margin: 0, fontWeight: 600 }}>🎧 Mikrofon mobilny (słuchawki / headset / Bluetooth)</label>
              {form.micHeadsetName && (
                <button className="text-btn" onClick={() => testDevice(form.micHeadsetName)}>
                  ▶ Przetestuj
                </button>
              )}
            </div>
            <select
              className="select"
              value={audioDevices.some((d) => d.name === form.micHeadsetName) ? form.micHeadsetName : (form.micHeadsetName ? '__custom__' : '')}
              onChange={(e) => {
                if (e.target.value !== '__custom__') {
                  patchForm({ micHeadsetName: e.target.value });
                }
              }}
            >
              <option value="">-- Wybierz mikrofon mobilny --</option>
              {audioDevices.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} {d.isDefault ? '(Aktywny domyślny)' : ''}
                </option>
              ))}
              <option value="__custom__">-- Wpisz własną nazwę ręcznie --</option>
            </select>
            <input
              className="input"
              style={{ marginTop: 6 }}
              value={form.micHeadsetName}
              placeholder="Wybierz z listy powyżej lub wpisz nazwę (np. Headset / Słuchawki)"
              onChange={(e) => patchForm({ micHeadsetName: e.target.value })}
            />
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <div className="port-line">
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={detectDevices}>
                Wykryj i zaproponuj mikrofony
              </button>
            </div>
            {deviceInfo && (
              <p className="port-hint" style={{ whiteSpace: 'pre-line' }}>{deviceInfo}</p>
            )}
          </div>
        </section>

        {/* behaviors */}
        <section className="card">
          <h2>⚙️ Konfiguracja zachowań automatycznych</h2>

          <h3 className="sub-heading">Gdy odchodzisz od biurka (Tryb mobilny):</h3>
          
          <div className="toggle-row">
            <div className="label">
              Przełączaj na mikrofon mobilny
              <small>automatycznie ustawia mikrofon słuchawek jako domyślny</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.switchMicOnAway ?? true}
              onClick={() => patchForm({ switchMicOnAway: !(form.switchMicOnAway ?? true) })}
            />
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label>Zachowanie wyciszania po odejściu:</label>
            <select
              className="select"
              value={form.muteBehaviorOnAway || 'none'}
              onChange={(e) => patchForm({ muteBehaviorOnAway: e.target.value as any })}
            >
              <option value="none">Brak wyciszania (mikrofon mobilny od razu aktywny)</option>
              <option value="mute_stationary">Wycisz tylko mikrofon stacjonarny</option>
              <option value="mute_all">Wycisz wszystkie mikrofony (tryb prywatności po odejściu)</option>
            </select>
          </div>

          <div className="toggle-row" style={{ marginTop: 10 }}>
            <div className="label">
              Dźwięk powiadomienia w słuchawkach
              <small>cichy sygnał audio potwierdzający przejście w tryb mobilny</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.audioChimeOnAway ?? true}
              onClick={() => patchForm({ audioChimeOnAway: !(form.audioChimeOnAway ?? true) })}
            />
          </div>

          <div className="toggle-row" style={{ marginTop: 10 }}>
            <div className="label">
              Usypiaj monitory po odejściu
              <small>gasi ekrany po upływie zadanego czasu bezruchu</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.sleepMonitorsOnAway ?? false}
              onClick={() => patchForm({ sleepMonitorsOnAway: !(form.sleepMonitorsOnAway ?? false) })}
            />
          </div>

          {form.sleepMonitorsOnAway && (
            <div className="field" style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label>Czas oczekiwania przed uśpieniem ekranów</label>
                <span className="slider-val">{Math.round((form.sleepMonitorsDelayMs ?? 15000) / 1000)} s</span>
              </div>
              <input
                type="range"
                className="slider"
                min={3000}
                max={60000}
                step={1000}
                value={form.sleepMonitorsDelayMs ?? 15000}
                onChange={(e) => patchForm({ sleepMonitorsDelayMs: Number(e.target.value) })}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <p className="hint" style={{ margin: 0 }}>Monitory zgasną po tylu sekundach od odejścia od biurka.</p>
                <button className="text-btn" onClick={testSleepDisplay}>
                  ▶ Przetestuj uśpienie
                </button>
              </div>
            </div>
          )}

          <h3 className="sub-heading" style={{ marginTop: 18 }}>Gdy wracasz do biurka (Tryb stacjonarny):</h3>

          <div className="toggle-row">
            <div className="label">
              Przełączaj na mikrofon stacjonarny
              <small>automatycznie przywraca główny mikrofon biurkowy</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.switchMicOnDesk ?? true}
              onClick={() => patchForm({ switchMicOnDesk: !(form.switchMicOnDesk ?? true) })}
            />
          </div>

          <div className="toggle-row" style={{ marginTop: 10 }}>
            <div className="label">
              Automatycznie odciszaj mikrofon stacjonarny
              <small>odcisza mikrofon przy siadaniu na fotelu</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.unmuteOnDesk ?? true}
              onClick={() => patchForm({ unmuteOnDesk: !(form.unmuteOnDesk ?? true) })}
            />
          </div>

          <div className="toggle-row" style={{ marginTop: 10 }}>
            <div className="label">
              Automatycznie wybudzaj monitory
              <small>natychmiast włącza ekrany po wykryciu siadania na fotelu</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.wakeMonitorsOnDesk ?? true}
              onClick={() => patchForm({ wakeMonitorsOnDesk: !(form.wakeMonitorsOnDesk ?? true) })}
            />
          </div>

          <div className="toggle-row" style={{ marginTop: 10 }}>
            <div className="label">
              Dźwięk powiadomienia o powrocie
              <small>przyjemny dwuton potwierdzający aktywację mikrofonu stacjonarnego</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.audioChimeOnDesk ?? true}
              onClick={() => patchForm({ audioChimeOnDesk: !(form.audioChimeOnDesk ?? true) })}
            />
          </div>
        </section>

        {/* radar */}
        <section className="card">
          <h2>Radar mmWave <span className="badge">Seeed 60 GHz</span></h2>

          <div className="field">
            <label>Port COM</label>
            <div className="port-line">
              <select
                className="select"
                value={form.port}
                onChange={(e) => setPort(e.target.value)}
              >
                <option value="auto">auto (automatyczne wykrycie Seeed ESP32-C6)</option>
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path}{p.manufacturer ? ` · ${p.manufacturer}` : ''}
                  </option>
                ))}
              </select>
              <button className={`icon-btn ${refreshing ? 'spin' : ''}`} title="Odśwież porty COM" onClick={refreshPorts}>
                <IconRefresh />
              </button>
            </div>
            {ports.length === 0 && (
              <p className="port-hint">Brak portów szeregowych — podłącz radar przez USB.</p>
            )}
          </div>

          <div className="row">
            <div className="field">
              <label>Baud rate</label>
              <select
                className="select"
                value={form.baudRate}
                onChange={(e) => patchForm({ baudRate: Number(e.target.value) })}
              >
                {BAUD_RATES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Aktywny port</label>
              <input className="input" value={radar.port || form.port} disabled onChange={() => {}} />
            </div>
          </div>
        </section>

        {/* timing */}
        <section className="card">
          <h2>Czułość i opóźnienia przełączania</h2>

          <div className="preset-bar">
            <span className="preset-label">Profile:</span>
            <button className="btn-preset" onClick={() => applyPreset(100, 2000)}>⚡ Gaming (100ms / 2s)</button>
            <button className="btn-preset" onClick={() => applyPreset(300, 3000)}>⚖️ Standard (300ms / 3s)</button>
            <button className="btn-preset" onClick={() => applyPreset(1000, 8000)}>☕ Spokojny (1s / 8s)</button>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <label>Siadanie przy biurku (wejście do stacjonarnego)</label>
              <span className="slider-val">{form.timeoutDeskMs} ms</span>
            </div>
            <input
              type="range"
              className="slider"
              min={0}
              max={3000}
              step={50}
              value={form.timeoutDeskMs}
              onChange={(e) => patchForm({ timeoutDeskMs: Number(e.target.value) })}
            />
            <p className="hint">Błyskawiczna reakcja po zajęciu miejsca przy biurku.</p>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <label>Odejście od biurka (przejście w mobilny)</label>
              <span className="slider-val">{form.timeoutAwayMs} ms</span>
            </div>
            <input
              type="range"
              className="slider"
              min={500}
              max={15000}
              step={250}
              value={form.timeoutAwayMs}
              onChange={(e) => patchForm({ timeoutAwayMs: Number(e.target.value) })}
            />
            <p className="hint">Histereza zapobiegająca przełączeniom np. przy chwilowym sięgnięciu po napój.</p>
          </div>
        </section>

        {/* audio feedback chime */}
        <section className="card">
          <h2>🔔 Głośność i testy dźwięku powiadomień</h2>

          <div className="toggle-row">
            <div className="label">
              Główny przełącznik dźwięków
              <small>włącza/wyłącza sygnały dźwiękowe</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.audioChime ?? true}
              onClick={() => patchForm({ audioChime: !(form.audioChime ?? true) })}
            />
          </div>

          {(form.audioChime ?? true) && (
            <div className="field" style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label>Głośność sygnału</label>
                <span className="slider-val">{Math.round((form.audioChimeVolume ?? 0.2) * 100)}%</span>
              </div>
              <input
                type="range"
                className="slider"
                min={0.05}
                max={1.0}
                step={0.05}
                value={form.audioChimeVolume ?? 0.2}
                onChange={(e) => patchForm({ audioChimeVolume: Number(e.target.value) })}
              />
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ flex: 1 }}
                  onClick={() => playChime('desk', form.audioChimeVolume ?? 0.2)}
                >
                  ▶ Dźwięk: Stacjonarny
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ flex: 1 }}
                  onClick={() => playChime('away', form.audioChimeVolume ?? 0.2)}
                >
                  ▶ Dźwięk: Mobilny
                </button>
              </div>
            </div>
          )}
        </section>

        {/* system & features */}
        <section className="card">
          <h2>Automatyzacja i system</h2>

          <div className="toggle-row">
            <div className="label">
              Powiadomienia Windows (Toast)
              <small>pokazuje dyskretny dymek systemowy przy zmianie mikrofonu</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.notifications ?? true}
              onClick={() => patchForm({ notifications: !(form.notifications ?? true) })}
            />
          </div>

          <div className="toggle-row" style={{ marginTop: 10 }}>
            <div className="label">
              Uruchamiaj przy starcie Windows
              <small>aplikacja startuje zminimalizowana w zasobniku systemowym</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.autoStart}
              onClick={() => patchForm({ autoStart: !form.autoStart })}
            />
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>Globalny skrót klawiszowy wyciszenia</label>
            <input
              className="input"
              value={form.globalShortcut || 'CommandOrControl+Shift+M'}
              placeholder="CommandOrControl+Shift+M"
              onChange={(e) => patchForm({ globalShortcut: e.target.value })}
            />
            <p className="hint">Domyślnie: Ctrl+Shift+M (lub Cmd+Shift+M na Mac).</p>
          </div>
        </section>

        {/* updates & config folder */}
        <section className="card">
          <h2>Aktualizacje i pliki</h2>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <span style={{ fontWeight: 600 }}>Wersja aplikacji: v{updater.currentVersion}</span>
              <small style={{ display: 'block', color: 'var(--muted-2)' }}>Automatyczne sprawdzanie wydań GitHub</small>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              disabled={updater.status === 'checking' || updater.status === 'downloading'}
              onClick={checkForUpdates}
            >
              {updater.status === 'checking' ? 'Sprawdzanie…' : 'Sprawdź aktualizacje'}
            </button>
          </div>

          <div className="field">
            <label>Repozytorium GitHub</label>
            <input
              className="input"
              value={form.githubRepo || 'Monratis/MicrophoneTool'}
              placeholder="Monratis/MicrophoneTool"
              onChange={(e) => patchForm({ githubRepo: e.target.value })}
            />
          </div>

          <div style={{ marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={openConfigFolder}>
              <IconFolder /> Otwórz folder konfiguracji (%APPDATA%\Audio Switcher)
            </button>
          </div>
        </section>
      </div>

      {/* footer */}
      <div className="footer">
        <button
          className="btn btn-ghost"
          onClick={() =>
            window.api.resetConfig().then((s) => {
              setSnap(s);
              setForm(s.config);
              pushToast('Przywrócono domyślne ustawienia');
            })
          }
        >
          Domyślne
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
        </button>
        <span className={`save-state ${saveState.kind}`}>{saveState.text}</span>
      </div>

      {/* toasts */}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}