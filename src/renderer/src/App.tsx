import { useCallback, useEffect, useRef, useState } from 'react';
import type { PushEvent, SerialPortInfo, Snapshot } from './global';

const STATE_LABEL: Record<string, string> = { desk: 'Przy biurku', headset: 'Poza biurkiem' };
const MODE_LABEL: Record<string, string> = {
  auto: 'Auto (radar)',
  desk: 'QuadCast 2',
  headset: 'Słuchawki'
};

const MODES: { id: Snapshot['mode']; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'przełączanie wg radaru' },
  { id: 'desk', label: 'QuadCast 2', hint: 'wymuś mikrofon biurkowy' },
  { id: 'headset', label: 'Słuchawki', hint: 'wymuś mikrofon słuchawek' }
];

interface Toast {
  id: number;
  message: string;
  error?: boolean;
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

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ kind: 'idle' | 'saved' | 'error'; text: string }>({ kind: 'idle', text: '' });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dirty, setDirty] = useState(false);
  const toastId = useRef(0);

  // form state (init from snapshot)
  const [form, setForm] = useState<Snapshot['config'] | null>(null);

  const pushToast = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  useEffect(() => {
    let mounted = true;
    window.api.getState().then((s) => {
      if (!mounted) return;
      setSnap(s);
      setForm(s.config);
    });
    window.api.getPorts().then(setPorts);
    const off = window.api.onEvent((e: PushEvent) => {
      if (e.type === 'snapshot' && e.snapshot) {
        setSnap(e.snapshot);
        setForm((f) => (f ? { ...f, ...e.snapshot!.config } : e.snapshot!.config));
        setDirty(false);
      }
      if (e.type === 'toast' && e.message) pushToast(e.message, e.error);
    });
    return () => {
      mounted = false;
      off();
    };
  }, [pushToast]);

  const refreshPorts = useCallback(async () => {
    setRefreshing(true);
    const list = await window.api.getPorts();
    setPorts(list);
    setRefreshing(false);
  }, []);

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

  if (!snap || !form) {
    return <div className="app" style={{ display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Wczytywanie…</div>;
  }

  const state = snap.state;
  const radar = snap.radar;
  const isMock = form.mockMode;

  return (
    <div className="app">
      {/* titlebar */}
      <div className="titlebar">
        <div className="brand">
          <span className="logo"><IconLogo /></span>
          Auto Audio Switch
        </div>
        <div className="win-btns">
          <button className="close" title="Ukryj" onClick={() => window.api.closeWindow()}>
            <IconClose />
          </button>
        </div>
      </div>

      <div className="scroll">
        {/* status */}
        <section className="card">
          <h2>Status</h2>
          <div className="status-hero" data-state={state}>
            <div className="status-ring">
              <span className="pulse" />
              <span className="dot"><IconMic state={state} /></span>
            </div>
            <div className="status-meta">
              <h1>{state ? STATE_LABEL[state] : '—'}</h1>
              <p>
                Domyślny mikrofon:{' '}
                <strong>{snap.deviceName ?? '—'}</strong>
              </p>
              <div className="badges">
                <span className="badge">{MODE_LABEL[snap.mode]}</span>
                {isMock && <span className="badge mock">MOCK</span>}
                {!isMock && <span className={`badge ${radar.connected ? 'live' : ''}`}>
                  {radar.connected ? 'Radar: połączony' : 'Radar: brak połączenia'}
                </span>}
              </div>
            </div>
          </div>
        </section>

        {/* mode */}
        <section className="card">
          <h2>Tryb pracy</h2>
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

        {/* system */}
        <section className="card">
          <h2>System</h2>
          <div className="toggle-row">
            <div className="label">
              Uruchamiaj przy starcie Windows
              <small>aplikacja startuje ukryta w tray razem z systemem</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={form.autoStart}
              onClick={() => patchForm({ autoStart: !form.autoStart })}
            />
          </div>
        </section>

        {/* radar */}
        <section className="card">
          <h2>Radar mmWave <span className="badge">60 GHz</span></h2>

          <div className="field">
            <label>Port COM</label>
            <div className="port-line">
              <select
                className="select"
                value={form.port}
                disabled={isMock}
                onChange={(e) => setPort(e.target.value)}
              >
                <option value="auto">auto (wykryj po VID/PID Seeed)</option>
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path}{p.manufacturer ? ` · ${p.manufacturer}` : ''}
                  </option>
                ))}
              </select>
              <button className={`icon-btn ${refreshing ? 'spin' : ''}`} title="Odśwież listę portów" onClick={refreshPorts}>
                <IconRefresh />
              </button>
            </div>
            {ports.length === 0 && !isMock && (
              <p className="port-hint">Brak dostępnych portów szeregowych.</p>
            )}
          </div>

          <div className="row">
            <div className="field">
              <label>Baud rate</label>
              <input
                className="input"
                type="number"
                value={form.baudRate}
                disabled={isMock}
                onChange={(e) => patchForm({ baudRate: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>Port w configu</label>
              <input className="input" value={form.port} disabled onChange={() => {}} />
            </div>
          </div>

          <div className="toggle-row">
            <div className="label">
              Tryb mock (symulacja)
              <small>brak urządzenia — radar przełącza co 15 s</small>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={isMock}
              onClick={() => patchForm({ mockMode: !isMock })}
            />
          </div>
        </section>

        {/* audio devices */}
        <section className="card">
          <h2>Urządzenia audio</h2>
          <div className="field">
            <label>Przy biurku (mikrofon biurkowy)</label>
            <input
              className="input"
              value={form.micDeskName}
              placeholder="Microphone (HyperX QuadCast 2)"
              onChange={(e) => patchForm({ micDeskName: e.target.value })}
            />
            <p className="hint">Nazwa dokładnie jak w SoundVolumeView.</p>
          </div>
          <div className="field">
            <label>Poza biurkiem (słuchawki)</label>
            <input
              className="input"
              value={form.micHeadsetName}
              placeholder="Microphone (Headset)"
              onChange={(e) => patchForm({ micHeadsetName: e.target.value })}
            />
            <p className="hint">Nazwa dokładnie jak w SoundVolumeView.</p>
          </div>
        </section>

        {/* timing */}
        <section className="card">
          <h2>Reakcja (debounce / histereza)</h2>
          <div className="row">
            <div className="field">
              <label>Przy biurku (wejście)</label>
              <div className="input-group">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={100}
                  value={form.timeoutDeskMs}
                  onChange={(e) => patchForm({ timeoutDeskMs: Number(e.target.value) })}
                />
                <span className="input-suffix">ms</span>
              </div>
              <p className="hint">Szybka reakcja po siadnięciu (np. 300).</p>
            </div>
            <div className="field">
              <label>Poza biurkiem (wyjście)</label>
              <div className="input-group">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={100}
                  value={form.timeoutAwayMs}
                  onChange={(e) => patchForm({ timeoutAwayMs: Number(e.target.value) })}
                />
                <span className="input-suffix">ms</span>
              </div>
              <p className="hint">Histereza przy zaniku obecności (np. 3000).</p>
            </div>
          </div>
        </section>
      </div>

      {/* footer */}
      <div className="footer">
        <button className="btn btn-ghost" onClick={() => window.api.resetConfig().then((s) => { setSnap(s); setForm(s.config); pushToast('Przywrócono domyślne ustawienia'); })}>
          Przywróć
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Zapisywanie…' : 'Zapisz'}
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