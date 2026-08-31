// Podpiecie wszystkich zdarzen UI (bindEvents): klikniecia, inputy, shortcuty

import type { AppUI } from './app';
import { playChime, playCustomAudioFile, type ChimeStyle, type SettingsTab, type TabType } from './ui';
import type { Snapshot } from './global';
import { isMicActive, triggerOsdHud, updateHeaderAndLiveDOM } from './homeView';
import { refreshDiscordRpcStatus, refreshSignalrgbEffectList, refreshSignalrgbStatus,
  openHaPickerForRule, closeHaPicker, applyHaCatalog, renderHaPickerChips, renderHaPickerList } from './integrationsPanels';
import { applyLogFilter, refreshLogConsoleDOM } from './logsAbout';
import { applyVadResults, closeVadModal, openVadModal, runVadStep1, runVadStep2, toggleDiagSession } from './modals';
import { renderBackendHint, renderVoiceDownloadSection, isSelectedVoiceModelReady, parseVoiceHaPayload, stringifyVoiceHaPayload } from './voicePanel';

  // ---------- EVENT BINDINGS ----------
export function bindEvents(app: AppUI) {
    const byId = (id: string) => document.getElementById(id);

    // Navigation Tabs
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.currentTarget as HTMLElement).getAttribute('data-tab') as TabType;
        if (tab && tab !== app.currentTab) {
          app.currentTab = tab;
          app.render();
        }
      });
    });

    // Window Controls
    byId('fc-win-close')?.addEventListener('click', () => window.api.closeWindow());
    byId('fc-win-min')?.addEventListener('click', () => window.api.minimizeWindow());
    byId('fc-win-max')?.addEventListener('click', async () => {
      await window.api.maximizeWindow();
      app.isMaximized = !app.isMaximized;
    });

    // Settings Sub-Navigation (lewy panel ustawień)
    document.querySelectorAll<HTMLElement>('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.currentTarget as HTMLElement).getAttribute('data-settings-tab') as SettingsTab;
        if (tab && tab !== app.settingsTab) {
          app.settingsTab = tab;
          app.render();
        }
      });
    });

    // Double-click on Titlebar to Maximize/Restore
    byId('fc-titlebar')?.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.top-tools, button, select, input')) return;
      void window.api.maximizeWindow();
    });

    // Header Controls
    byId('fc-header-mute-btn')?.addEventListener('click', async () => {
      const res = await window.api.toggleMute();
      if (res && typeof res.isMuted === 'boolean') {
        app.isMuted = res.isMuted;
        app.pushToast(res.isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️');
        triggerOsdHud(app, res.isMuted ? '🔇 Mikrofon Wyciszony' : '🎙️ Mikrofon Aktywny', res.isMuted);
        updateHeaderAndLiveDOM(app);
      }
    });

    byId('fc-btn-refresh-all')?.addEventListener('click', async () => {
      app.refreshingPorts = true;
      app.render();
      await app.pollHardwareLists();
      app.refreshingPorts = false;
      app.render();
      app.pushToast('Odświeżono urządzenia audio i porty COM');
    });

    // QoL: Cancel Snooze — pauza żyje w main (AppController), IPC ją ustawia
    byId('btn-cancel-snooze')?.addEventListener('click', async () => {
      try {
        const s = await window.api.setSnooze(0);
        app.snap = s;
        app.snoozeUntil = null;
        app.pushToast('Wznowiono automatyczne przełączanie mikrofonu ✓');
      } catch {
        app.pushToast('Nie udało się wznowić automatyki', true);
      }
      app.render();
    });

    // QoL: Quick Snooze in Master Card — main jest źródłem prawdy pauzy
    byId('sel-quick-snooze')?.addEventListener('change', async (e) => {
      const mins = Number((e.target as HTMLSelectElement).value);
      try {
        const s = await window.api.setSnooze(mins);
        app.snap = s;
        app.snoozeUntil = s.snoozeUntil > 0 ? s.snoozeUntil : null;
        app.pushToast(mins > 0 ? `Wstrzymano automatyczne przełączanie na ${mins} min ⏸️` : 'Wznowiono automatyczne przełączanie ✓');
      } catch {
        app.pushToast('Nie udało się zmienić pauzy automatyki', true);
      }
      app.render();
    });

    // Section Contextual Actions
    const handleAutoDetect = async () => {
      app.pushToast('Wykrywam mikrofony…');
      const r = await window.api.detectDevices();
      await app.loadAudioDevices();
      if (r.recommended.micDeskName || r.recommended.micHeadsetName) {
        app.patchForm({
          micDeskName: r.recommended.micDeskName || app.form?.micDeskName || '',
          micHeadsetName: r.recommended.micHeadsetName || app.form?.micHeadsetName || ''
        }, true);
        void app.vuEngine.start(app.form?.micDeskName || '', app.form?.micHeadsetName || '');
        app.pushToast('Dopasowano optymalne mikrofony — zapisano automatycznie ✓');
      }
    };

    byId('btn-home-detect-mics')?.addEventListener('click', handleAutoDetect);
    byId('btn-banner-detect-mics')?.addEventListener('click', handleAutoDetect);

    // Mode segmented buttons
    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const mode = (e.currentTarget as HTMLElement).getAttribute('data-mode') as Snapshot['mode'];
        if (mode) {
          const s = await window.api.setMode(mode);
          app.snap = s;
          app.render();
        }
      });
    });

    // Card Actions
    byId('card-btn-test-desk')?.addEventListener('click', async () => {
      if (!app.form?.micDeskName) return;
      app.pushToast(`Aktywuję: ${app.form.micDeskName}…`);
      app.snap = await window.api.testDevice(app.form.micDeskName);
      await app.loadAudioDevices();
      triggerOsdHud(app, `🎙️ Aktywny: ${app.form.micDeskName}`, false);
      app.render();
    });

    byId('card-btn-test-headset')?.addEventListener('click', async () => {
      if (!app.form?.micHeadsetName) return;
      app.pushToast(`Aktywuję: ${app.form.micHeadsetName}…`);
      app.snap = await window.api.testDevice(app.form.micHeadsetName);
      await app.loadAudioDevices();
      triggerOsdHud(app, `🎧 Aktywny: ${app.form.micHeadsetName}`, false);
      app.render();
    });

    byId('card-sw-mute')?.addEventListener('click', async () => {
      const res = await window.api.toggleMute();
      if (res && typeof res.isMuted === 'boolean') {
        app.isMuted = res.isMuted;
        triggerOsdHud(app, res.isMuted ? '🔇 Mikrofon Wyciszony' : '🎙️ Mikrofon Aktywny', res.isMuted);
        updateHeaderAndLiveDOM(app);
      }
    });

    // VAD Auto-Calibration Modal & Discord Sync triggers
    byId('btn-vad-calibrate-desk')?.addEventListener('click', () => openVadModal(app, 'desk'));
    byId('btn-vad-calibrate-headset')?.addEventListener('click', () => openVadModal(app, 'headset'));

    const fetchDiscordVoiceProfile = async (target: 'desk' | 'headset' | 'active' | 'both') => {
      app.pushToast('Pobieram profil głosu z Discorda…');
      try {
        const res = await window.api.discordGetVoiceSettings();
        if (res?.ok && res.settings) {
          const s = res.settings;
          const patch: Partial<Snapshot['config']> = {};
          const applyDesk = target === 'desk' || target === 'both' || (target === 'active' && isMicActive(app, 'desk'));
          const applyHeadset = target === 'headset' || target === 'both' || (target === 'active' && !isMicActive(app, 'desk'));

          if (applyDesk) {
            if (typeof s.thresholdDb === 'number') {
              patch.micDeskGateDb = s.thresholdDb;
              app.vuEngine.deskGateDb = s.thresholdDb;
            }
            if (typeof s.krisp === 'boolean') patch.micDeskKrisp = s.krisp ? 'on' : 'off';
            if (typeof s.agc === 'boolean') patch.micDeskAgc = s.agc ? 'on' : 'off';
            if (typeof s.echo === 'boolean') patch.micDeskEcho = s.echo ? 'on' : 'off';
          }
          if (applyHeadset) {
            if (typeof s.thresholdDb === 'number') {
              patch.micHeadsetGateDb = s.thresholdDb;
              app.vuEngine.headGateDb = s.thresholdDb;
            }
            if (typeof s.krisp === 'boolean') patch.micHeadsetKrisp = s.krisp ? 'on' : 'off';
            if (typeof s.agc === 'boolean') patch.micHeadsetAgc = s.agc ? 'on' : 'off';
            if (typeof s.echo === 'boolean') patch.micHeadsetEcho = s.echo ? 'on' : 'off';
          }

          app.patchForm(patch, true);
          const targetName = applyDesk && applyHeadset ? 'obu mikrofonów' : applyDesk ? 'biurka' : 'słuchawek';
          const info = typeof s.thresholdDb === 'number' ? ` (próg: ${s.thresholdDb} dB${typeof s.krisp === 'boolean' ? `, Krisp: ${s.krisp ? 'ON' : 'OFF'}` : ''})` : '';
          app.pushToast(`Pobrano profil z Discorda dla ${targetName}${info} ✓`);
        } else {
          app.pushToast(res?.error || 'Nie udało się pobrać profilu z Discorda — upewnij się, że autoryzowano OAuth Discorda.', true);
        }
      } catch (err) {
        app.pushToast(`Błąd pobierania profilu: ${(err as Error).message}`, true);
      }
    };

    byId('btn-vad-sync-desk')?.addEventListener('click', () => void fetchDiscordVoiceProfile('desk'));
    byId('btn-vad-sync-headset')?.addEventListener('click', () => void fetchDiscordVoiceProfile('headset'));

    byId('btn-vad-close')?.addEventListener('click', () => closeVadModal(app));
    byId('btn-vad-cancel')?.addEventListener('click', () => closeVadModal(app));
    byId('btn-vad-back')?.addEventListener('click', () => {
      app.vadStep = 1;
      app.vadWarning = '';
      app.render();
    });
    byId('vad-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'vad-overlay') closeVadModal(app);
    });
    byId('btn-run-vad-1')?.addEventListener('click', () => runVadStep1(app));
    byId('btn-run-vad-2')?.addEventListener('click', () => runVadStep2(app));
    byId('btn-vad-apply')?.addEventListener('click', () => applyVadResults(app));

    // Quick VAD Presets Desk
    byId('preset-vad-desk-auto')?.addEventListener('click', () => {
      app.patchForm({ micDeskAutoThreshold: true, micDeskKrisp: 'on' }, true);
      if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ autoThreshold: true, krisp: true });
      }
      app.pushToast('Włączono tryb Auto (Discord Voice Isolation & Krisp)');
    });
    byId('preset-vad-desk-quiet')?.addEventListener('click', () => {
      app.patchForm({ micDeskGateDb: -55, micDeskAutoThreshold: false }, true);
      if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -55, autoThreshold: false });
      }
      app.pushToast('Ustawiono próg VAD: -55 dB (Cichy pokój)');
    });
    byId('preset-vad-desk-std')?.addEventListener('click', () => {
      app.patchForm({ micDeskGateDb: -45, micDeskAutoThreshold: false }, true);
      if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -45, autoThreshold: false });
      }
      app.pushToast('Ustawiono próg VAD: -45 dB (Zbalansowany)');
    });
    byId('preset-vad-desk-noisy')?.addEventListener('click', () => {
      app.patchForm({ micDeskGateDb: -35, micDeskAutoThreshold: false }, true);
      if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -35, autoThreshold: false });
      }
      app.pushToast('Ustawiono próg VAD: -35 dB (Głośna klawiatura / Tło)');
    });

    // Quick VAD Presets Headset
    byId('preset-vad-headset-auto')?.addEventListener('click', () => {
      app.patchForm({ micHeadsetAutoThreshold: true, micHeadsetKrisp: 'on' }, true);
      if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ autoThreshold: true, krisp: true });
      }
      app.pushToast('Włączono tryb Auto (Discord Voice Isolation & Krisp)');
    });
    byId('preset-vad-headset-quiet')?.addEventListener('click', () => {
      app.patchForm({ micHeadsetGateDb: -55, micHeadsetAutoThreshold: false }, true);
      if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -55, autoThreshold: false });
      }
      app.pushToast('Ustawiono próg VAD: -55 dB (Ciche otoczenie)');
    });
    byId('preset-vad-headset-std')?.addEventListener('click', () => {
      app.patchForm({ micHeadsetGateDb: -45, micHeadsetAutoThreshold: false }, true);
      if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -45, autoThreshold: false });
      }
      app.pushToast('Ustawiono próg VAD: -45 dB (Zbalansowany)');
    });
    byId('preset-vad-headset-noisy')?.addEventListener('click', () => {
      app.patchForm({ micHeadsetGateDb: -35, micHeadsetAutoThreshold: false }, true);
      if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: -35, autoThreshold: false });
      }
      app.pushToast('Ustawiono próg VAD: -35 dB (Głośne tło)');
    });

    // Form inputs (Mic desk & headset)
    const onDeskMicSelect = (sel: HTMLSelectElement) => {
      const name = sel.value;
      const vol = app.initVolumePercent(name, app.form?.micDeskVolume);
      app.patchForm({ micDeskName: name, micDeskVolume: vol });
      void app.vuEngine.start(name, app.form?.micHeadsetName || '');
    };

    byId('sel-mic-desk')?.addEventListener('change', (e) => onDeskMicSelect(e.target as HTMLSelectElement));

    const onHeadsetMicSelect = (sel: HTMLSelectElement) => {
      const name = sel.value;
      const vol = app.initVolumePercent(name, app.form?.micHeadsetVolume);
      app.patchForm({ micHeadsetName: name, micHeadsetVolume: vol });
      void app.vuEngine.start(app.form?.micDeskName || '', name);
    };

    byId('sel-mic-headset')?.addEventListener('change', (e) => onHeadsetMicSelect(e.target as HTMLSelectElement));

    // Desk Voice Filters
    byId('rng-gate-desk')?.addEventListener('input', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      app.patchForm({ micDeskGateDb: val, micDeskAutoThreshold: false });
      const el = byId('val-gate-desk');
      if (el) {
        el.textContent = `${val} dB`;
        el.style.color = '#fbbf24';
      }
      app.vuEngine.deskGateDb = val;
      const marker = byId('vu-gate-desk');
      if (marker) {
        const pct = Math.max(0, Math.min(100, ((val + 100) / 100) * 100));
        marker.style.left = `${pct}%`;
        marker.title = `Próg bramki Discord: ${val} dB`;
      }
    });
    byId('rng-gate-desk')?.addEventListener('change', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val, autoThreshold: false });
      }
    });

    const updateDeskKrisp = (mode: 'default' | 'on' | 'off') => {
      app.patchForm({ micDeskKrisp: mode });
      if (mode !== 'default' && isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    };
    byId('settings-krisp-desk')?.addEventListener('change', (e) => updateDeskKrisp((e.target as HTMLSelectElement).value as any));

    const updateDeskAgc = (mode: 'default' | 'on' | 'off') => {
      app.patchForm({ micDeskAgc: mode });
      if (mode !== 'default' && isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    };
    byId('settings-agc-desk')?.addEventListener('change', (e) => updateDeskAgc((e.target as HTMLSelectElement).value as any));

    byId('settings-echo-desk')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      app.patchForm({ micDeskEcho: mode });
      if (mode !== 'default' && isMicActive(app, 'desk') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ echo: mode === 'on' });
      }
    });

    // Headset Voice Filters
    byId('rng-gate-headset')?.addEventListener('input', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      app.patchForm({ micHeadsetGateDb: val, micHeadsetAutoThreshold: false });
      const el = byId('val-gate-headset');
      if (el) {
        el.textContent = `${val} dB`;
        el.style.color = '#fbbf24';
      }
      app.vuEngine.headGateDb = val;
      const marker = byId('vu-gate-headset');
      if (marker) {
        const pct = Math.max(0, Math.min(100, ((val + 100) / 100) * 100));
        marker.style.left = `${pct}%`;
        marker.title = `Próg bramki Discord: ${val} dB`;
      }
    });
    byId('rng-gate-headset')?.addEventListener('change', (e) => {
      const val = Math.max(-100, Math.min(0, Number((e.target as HTMLInputElement).value)));
      if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ gateDb: val, autoThreshold: false });
      }
    });

    // Click on VU track to set VAD Gate directly
    const bindVuClick = (boxId: string, sliderId: string, valId: string, markerId: string, isDesk: boolean) => {
      const box = byId(boxId);
      const track = box?.querySelector('.fc-vu-track') as HTMLElement | null;
      if (!track) return;
      track.style.cursor = 'pointer';
      track.title = 'Kliknij, aby ustawić próg bramki głosu';
      track.addEventListener('click', (e) => {
        const rect = track.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const db = Math.round(-100 + pct * 100);
        const clampedDb = Math.max(-100, Math.min(0, db));

        const rng = byId(sliderId) as HTMLInputElement | null;
        const valEl = byId(valId);
        const marker = byId(markerId);

        if (rng) rng.value = String(clampedDb);
        if (valEl) valEl.textContent = `${clampedDb} dB`;
        if (marker) marker.style.left = `${pct * 100}%`;

        if (isDesk) {
          app.vuEngine.deskGateDb = clampedDb;
          app.patchForm({ micDeskGateDb: clampedDb }, false);
          if (isMicActive(app, 'desk') && app.form?.discordIntegration) {
            void window.api.discordApplyVoice({ gateDb: clampedDb });
          }
        } else {
          app.vuEngine.headGateDb = clampedDb;
          app.patchForm({ micHeadsetGateDb: clampedDb }, false);
          if (isMicActive(app, 'headset') && app.form?.discordIntegration) {
            void window.api.discordApplyVoice({ gateDb: clampedDb });
          }
        }
        app.pushToast(`Ustawiono próg głosu: ${clampedDb} dB`);
      });
    };

    bindVuClick('vu-box-desk', 'rng-gate-desk', 'val-gate-desk', 'vu-gate-desk', true);
    bindVuClick('vu-box-headset', 'rng-gate-headset', 'val-gate-headset', 'vu-gate-headset', false);

    const updateHeadsetKrisp = (mode: 'default' | 'on' | 'off') => {
      app.patchForm({ micHeadsetKrisp: mode });
      if (mode !== 'default' && isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ krisp: mode === 'on' });
      }
    };
    byId('settings-krisp-headset')?.addEventListener('change', (e) => updateHeadsetKrisp((e.target as HTMLSelectElement).value as any));

    const updateHeadsetAgc = (mode: 'default' | 'on' | 'off') => {
      app.patchForm({ micHeadsetAgc: mode });
      if (mode !== 'default' && isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ agc: mode === 'on' });
      }
    };
    byId('settings-agc-headset')?.addEventListener('change', (e) => updateHeadsetAgc((e.target as HTMLSelectElement).value as any));

    byId('settings-echo-headset')?.addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as any;
      app.patchForm({ micHeadsetEcho: mode });
      if (mode !== 'default' && isMicActive(app, 'headset') && app.form?.discordIntegration) {
        void window.api.discordApplyVoice({ echo: mode === 'on' });
      }
    });

    // Discord Integration Toggles
    byId('sw-discord')?.addEventListener('click', () => {
      const val = !(app.form?.discordIntegration ?? true);
      app.patchForm({ discordIntegration: val }, false);
      const btn = byId('sw-discord');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-discord-follow')?.addEventListener('click', () => {
      const val = !(app.form?.discordGateFollowMic !== false);
      app.patchForm({ discordGateFollowMic: val }, false);
      const btn = byId('sw-discord-follow');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    byId('btn-discord-auth')?.addEventListener('click', async () => {
      const btn = byId('btn-discord-auth');
      const originalText = btn?.textContent || '🔐 Autoryzuj Discord';
      if (btn) {
        btn.textContent = '⏳ Czekam na zgodę w Discordzie…';
        (btn as HTMLButtonElement).disabled = true;
      }
      app.pushToast('Otwarto okno autoryzacji — zatwierdź uprawnienia w aplikacji Discord 🎮');
      try {
        const res = await window.api.discordAuthorize();
        if (res?.ok) {
          app.pushToast(`Pomyślnie autoryzowano OAuth Discord${res.user ? ` jako @${res.user}` : ''} ✓`);
          void refreshDiscordRpcStatus(app);
        } else {
          app.pushToast(res?.error || 'Nie udało się autoryzować Discorda (upewnij się, że Discord jest uruchomiony)', true);
        }
      } catch (err) {
        app.pushToast(`Błąd autoryzacji: ${(err as Error).message}`, true);
      } finally {
        const targetBtn = byId('btn-discord-auth');
        if (targetBtn) {
          targetBtn.textContent = originalText;
          (targetBtn as HTMLButtonElement).disabled = false;
        }
      }
    });

    byId('btn-discord-fetch')?.addEventListener('click', () => void fetchDiscordVoiceProfile('both'));

    byId('btn-discord-sync')?.addEventListener('click', async () => {
      const isDesk = isMicActive(app, 'desk');
      const rawGate = isDesk ? app.form?.micDeskGateDb : app.form?.micHeadsetGateDb;
      const gateDb =
        typeof rawGate === 'number' && Number.isFinite(rawGate) && rawGate <= 0 && rawGate >= -100 && rawGate !== -1
          ? rawGate
          : undefined;
      const krispMode = isDesk ? app.form?.micDeskKrisp : app.form?.micHeadsetKrisp;
      const agcMode = isDesk ? app.form?.micDeskAgc : app.form?.micHeadsetAgc;
      const echoMode = isDesk ? app.form?.micDeskEcho : app.form?.micHeadsetEcho;
      const tri = (v: string | undefined): boolean | undefined => (v === 'on' ? true : v === 'off' ? false : undefined);

      app.pushToast('Wysyłam profil głosu do Discorda…');
      const ok = await window.api.discordApplyVoice({
        gateDb,
        krisp: tri(krispMode),
        agc: tri(agcMode),
        echo: tri(echoMode)
      });
      if (ok) {
        app.pushToast(`Zsynchronizowano profil głosu Discord (${isDesk ? 'Biurko' : 'Słuchawki'}) ✓`);
      } else {
        app.pushToast('Discord nie przyjął zmian profilu (upewnij się, że autoryzowano OAuth Discorda)', true);
      }
    });

    // Status połączenia RPC w panelu Discord — odświeżany przy każdym renderze
    // panelu (element istnieje tylko w tym panelu), z throttlingiem zapytań.
    void refreshDiscordRpcStatus(app);

    // Status Local API SignalRGB w panelu (element istnieje tylko tam).
    void refreshSignalrgbStatus(app);
    // Lista efektów z dysku do datalist podpowiedzi (darmowa droga, bez Pro).
    void refreshSignalrgbEffectList(app);

    // Sensor LED switch & brightness sync
    byId('sw-sensor-led')?.addEventListener('click', () => {
      const val = !(app.form?.sensorLedEnabled !== false);
      app.patchForm({ sensorLedEnabled: val }, false);
      const btn = byId('sw-sensor-led');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    const syncSensorLedBri = (val: number) => {
      app.patchForm({ sensorLedBrightness: val });
      const elVal = byId('val-sensor-led-bri');
      const rng = byId('rng-sensor-led-bri') as HTMLInputElement | null;
      if (elVal) elVal.textContent = `${val}%`;
      if (rng && Number(rng.value) !== val) rng.value = String(val);
    };

    byId('rng-sensor-led-bri')?.addEventListener('input', (e) => syncSensorLedBri(Number((e.target as HTMLInputElement).value)));

    // Color pickery diody: zapis + natychmiastowe przepięcie koloru na sensorze
    const bindLedColor = (inputId: string, key: 'sensorLedDeskColor' | 'sensorLedAwayColor' | 'sensorLedMuteColor') => {
      byId(inputId)?.addEventListener('input', (e) => {
        const val = (e.target as HTMLInputElement).value;
        app.patchForm({ [key]: val });
        void window.api.refreshLed();
      });
    };
    bindLedColor('clr-led-desk', 'sensorLedDeskColor');
    bindLedColor('clr-led-away', 'sensorLedAwayColor');
    bindLedColor('clr-led-mute', 'sensorLedMuteColor');

    byId('sw-pet-filter')?.addEventListener('click', () => {
      const val = !(app.form?.petFilterEnabled ?? true);
      app.patchForm({ petFilterEnabled: val }, false);
      const btn = byId('sw-pet-filter');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    byId('sw-user-input-presence')?.addEventListener('click', () => {
      const val = !(app.form?.userInputPresenceEnabled !== false);
      app.patchForm({ userInputPresenceEnabled: val }, false);
      const btn = byId('sw-user-input-presence');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    // SignalRGB Integration Handlers
    byId('sw-signalrgb')?.addEventListener('click', () => {
      const val = !(app.form?.signalrgbEnabled ?? false);
      app.patchForm({ signalrgbEnabled: val }, false);
      const btn = byId('sw-signalrgb');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    // Desk Action & Effect
    byId('sel-signalrgb-desk-action')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as any;
      app.patchForm({ signalrgbDeskAction: val, signalrgbRestoreOnDesk: val === 'restore' }, true);
    });
    byId('sel-signalrgb-desk-effect')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val === '__custom__') {
        app.signalrgbCustomDesk = true;
        app.render();
      } else {
        app.signalrgbCustomDesk = false;
        app.patchForm({ signalrgbDeskEffect: val }, true);
      }
    });
    byId('inp-signalrgb-desk-effect-custom')?.addEventListener('input', (e) => {
      app.patchForm({ signalrgbDeskEffect: (e.target as HTMLInputElement).value });
    });
    byId('clr-signalrgb-desk')?.addEventListener('input', (e) => {
      app.patchForm({ signalrgbDeskColor: (e.target as HTMLInputElement).value });
    });
    byId('btn-cancel-custom-desk')?.addEventListener('click', () => {
      app.signalrgbCustomDesk = false;
      app.render();
    });
    byId('btn-preview-signalrgb-desk')?.addEventListener('click', async () => {
      const effectName = (app.form?.signalrgbDeskEffect || '').trim() || 'Neon Shift';
      const color = app.form?.signalrgbDeskColor || '';
      app.pushToast(`SignalRGB: podgląd efektu biurka "${effectName}"…`);
      const res = await window.api.signalrgbApplyEffect(effectName, color || undefined);
      if (res?.ok) {
        app.pushToast(`Zastosowano efekt "${effectName}" w SignalRGB (${res.via === 'deeplink' ? 'deep-link' : 'REST'}) ✨`);
      } else {
        app.pushToast(`SignalRGB: błąd — ${res?.reason || 'nie udało się uruchomić'}`, true);
      }
    });

    // Away Action & Effect
    byId('sel-signalrgb-away-action')?.addEventListener('change', (e) => {
      app.patchForm({ signalrgbAwayAction: (e.target as HTMLSelectElement).value as any }, true);
    });
    byId('clr-signalrgb-away')?.addEventListener('input', (e) => {
      app.patchForm({ signalrgbAwayColor: (e.target as HTMLInputElement).value });
    });
    byId('sel-signalrgb-away-effect')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (val === '__custom__') {
        app.signalrgbCustomAway = true;
        app.render();
      } else {
        app.signalrgbCustomAway = false;
        app.patchForm({ signalrgbAwayEffect: val });
      }
    });
    byId('inp-signalrgb-away-effect-custom')?.addEventListener('input', (e) => {
      app.patchForm({ signalrgbAwayEffect: (e.target as HTMLInputElement).value });
    });
    byId('btn-cancel-custom-away')?.addEventListener('click', () => {
      app.signalrgbCustomAway = false;
      app.render();
    });
    byId('btn-preview-signalrgb-away')?.addEventListener('click', async () => {
      const effectName = (app.form?.signalrgbAwayEffect || '').trim() || 'Solid Color';
      const color = app.form?.signalrgbAwayColor || '#f59e0b';
      app.pushToast(`SignalRGB: podgląd efektu odejścia "${effectName}"…`);
      const res = await window.api.signalrgbApplyEffect(effectName, color);
      if (res?.ok) {
        app.pushToast(`Zastosowano efekt "${effectName}" w SignalRGB (${res.via === 'deeplink' ? 'deep-link' : 'REST'}) ✨`);
      } else {
        app.pushToast(`SignalRGB: błąd — ${res?.reason || 'nie udało się uruchomić'}`, true);
      }
    });

    byId('rng-signalrgb-bri')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      app.patchForm({ signalrgbAwayBrightness: v });
      const el = byId('val-signalrgb-bri');
      if (el) el.textContent = `${v}%`;
    });

    byId('btn-refresh-signalrgb-effects')?.addEventListener('click', async () => {
      app.pushToast('Skanuję SignalRGB w poszukiwaniu zainstalowanych efektów…');
      try {
        const names = await window.api.signalrgbListEffects();
        if (Array.isArray(names)) {
          app.signalrgbEffects = names;
          app.render();
          app.pushToast(`Wykryto ${names.length} zainstalowanych efektów SignalRGB ✓`);
        }
      } catch (err: any) {
        app.pushToast(`Błąd skanowania efektów: ${err?.message || err}`, true);
      }
    });

    byId('btn-test-signalrgb-away')?.addEventListener('click', async () => {
      app.pushToast('Testuję oświetlenie SignalRGB: Odejście…');
      const res = await window.api.signalrgbTestAway();
      if (res?.ok && res.via && res.via !== 'none') {
        app.pushToast(`SignalRGB: akcja Odejście wykonana (${res.via === 'deeplink' ? 'deep-link, działa bez Pro' : 'REST'}) ✓`);
      } else {
        app.pushToast(`SignalRGB: test nieudany — ${res?.reason || 'nieznany powód'}`, true);
      }
    });
    byId('btn-test-signalrgb-desk')?.addEventListener('click', async () => {
      app.pushToast('Testuję oświetlenie SignalRGB: Powrót…');
      const res = await window.api.signalrgbTestDesk();
      if (res?.ok && res.via && res.via !== 'none') {
        app.pushToast(`SignalRGB: powrót wykonany (${res.via === 'deeplink' ? 'deep-link, działa bez Pro' : 'REST'}) ✓`);
      } else if (res?.ok) {
        app.pushToast(`SignalRGB: ${res.reason || 'nic do zrobienia'}`);
      } else {
        app.pushToast(`SignalRGB: test nieudany — ${res?.reason || 'nieznany powód'}`, true);
      }
    });

    // Home Assistant (HAOS) Integration Handlers
    byId('sw-ha-enabled')?.addEventListener('click', () => {
      const val = !(app.form?.haEnabled ?? false);
      app.patchForm({ haEnabled: val }, true);
      app.pushToast(val ? 'Włączono integrację Home Assistant (HAOS) 🏠' : 'Wyłączono integrację Home Assistant');
    });

    byId('inp-ha-url')?.addEventListener('input', (e) => {
      app.patchForm({ haUrl: (e.target as HTMLInputElement).value });
    });

    byId('inp-ha-token')?.addEventListener('input', (e) => {
      app.patchForm({ haToken: (e.target as HTMLInputElement).value });
    });

    byId('btn-toggle-ha-token')?.addEventListener('click', () => {
      app.haShowToken = !app.haShowToken;
      const inp = byId('inp-ha-token') as HTMLInputElement | null;
      const btn = byId('btn-toggle-ha-token');
      if (inp) inp.type = app.haShowToken ? 'text' : 'password';
      if (btn) btn.textContent = app.haShowToken ? 'Ukryj 👁️' : 'Pokaż 👁️';
    });

    byId('btn-ha-test')?.addEventListener('click', async () => {
      const url = (byId('inp-ha-url') as HTMLInputElement | null)?.value || app.form?.haUrl;
      const token = (byId('inp-ha-token') as HTMLInputElement | null)?.value || app.form?.haToken;
      app.haTesting = true;
      app.haTestResult = null;
      const fb = byId('ha-test-feedback');
      if (fb) {
        fb.style.color = 'var(--fc-text-muted)';
        fb.textContent = '⏳ Sprawdzam połączenie…';
      }
      try {
        const res = await window.api.haTestConnection({ url, token });
        app.haTestResult = res;
        if (fb) {
          fb.style.color = res.ok ? 'var(--fc-accent-green)' : '#ef4444';
          fb.textContent = res.ok ? `✓ ${res.message || 'Połączono pomyślnie!'}` : `❌ ${res.error || 'Błąd połączenia'}`;
        }
        app.pushToast(res.ok ? 'Połączenie z Home Assistantem nawiązane poprawnie ✓' : `Błąd HAOS: ${res.error}`, !res.ok);
      } catch (err: any) {
        app.haTestResult = { ok: false, error: err.message };
        if (fb) {
          fb.style.color = '#ef4444';
          fb.textContent = `❌ ${err.message}`;
        }
        app.pushToast(`Błąd testu HAOS: ${err.message}`, true);
      } finally {
        app.haTesting = false;
      }
    });

    byId('btn-ha-fetch-entities')?.addEventListener('click', async () => {
      const url = (byId('inp-ha-url') as HTMLInputElement | null)?.value || app.form?.haUrl;
      const token = (byId('inp-ha-token') as HTMLInputElement | null)?.value || app.form?.haToken;
      app.haFetchingEntities = true;
      const fb = byId('ha-test-feedback');
      if (fb) {
        fb.style.color = 'var(--fc-accent-blue)';
        fb.textContent = '⏳ Pobieram encje z Home Assistanta…';
      }
      try {
        const res = await window.api.haFetchEntities({ url, token });
        if (res.ok) {
          applyHaCatalog(app, res);

          const patch: Partial<Snapshot['config']> = {};
          if (res.recommended?.presence && !app.form?.haPresenceEntity) {
            patch.haPresenceEntity = res.recommended.presence;
          }
          if (res.recommended?.distance && !app.form?.haDistanceEntity) {
            patch.haDistanceEntity = res.recommended.distance;
          }
          if (res.recommended?.heartRate && !app.form?.haHeartRateEntity) {
            patch.haHeartRateEntity = res.recommended.heartRate;
          }
          if (res.recommended?.breathRate && !app.form?.haBreathRateEntity) {
            patch.haBreathRateEntity = res.recommended.breathRate;
          }
          if (Object.keys(patch).length > 0) {
            app.patchForm(patch, true);
          } else {
            app.render();
          }
          app.pushToast(`Pobrano ${app.haCatalog.length} encji z HAOS ✓`);
        } else {
          if (fb) {
            fb.style.color = '#ef4444';
            fb.textContent = `❌ ${res.error || 'Błąd pobierania'}`;
          }
          app.pushToast(`Błąd pobierania encji: ${res.error}`, true);
        }
      } catch (err: any) {
        app.pushToast(`Błąd pobierania encji z HAOS: ${err.message}`, true);
      } finally {
        app.haFetchingEntities = false;
      }
    });

    // Modal-wyszukiwarka encji: filtr listy bez pełnego re-renderu (input nie traci fokusu)
    byId('inp-ha-picker-search')?.addEventListener('input', (e) => {
      app.haPickerSearch = (e.target as HTMLInputElement).value;
      const list = byId('ha-picker-list');
      if (list) list.innerHTML = renderHaPickerList(app);
    });
    // Klawiatura: Enter = wybierz pierwszy wynik / wejdź w pierwsze urządzenie, Escape = cofnij/wyjdz
    byId('inp-ha-picker-search')?.addEventListener('keydown', (e) => {
      const list = byId('ha-picker-list');
      if (!list) return;
      if (e.key === 'Enter') {
        const first = list.querySelector('[data-ha-entity]') as HTMLElement | null;
        if (first) {
          first.click();
          return;
        }
        const device = list.querySelector('[data-ha-device]') as HTMLElement | null;
        if (device) device.click();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (app.haPickerMode === 'areas' && app.haPickerArea) {
          app.haPickerArea = '';
          list.innerHTML = renderHaPickerList(app);
        } else if (app.haPickerMode === 'devices' && app.haPickerDevice) {
          app.haPickerDevice = '';
          list.innerHTML = renderHaPickerList(app);
        } else {
          closeHaPicker(app);
        }
      }
    });
    byId('ha-picker-chips')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest('[data-ha-picker-domain]') as HTMLElement | null;
      const viewChip = target.closest('[data-ha-picker-view]') as HTMLElement | null;
      if (viewChip) {
        const viewMode = viewChip.getAttribute('data-ha-picker-view');
        app.haPickerMode = (viewMode === 'entities' || viewMode === 'devices' || viewMode === 'areas') ? viewMode : 'areas';
        app.haPickerArea = '';
        app.haPickerDevice = '';
        const chips = byId('ha-picker-chips');
        if (chips) chips.innerHTML = renderHaPickerChips(app);
        const list = byId('ha-picker-list');
        if (list) list.innerHTML = renderHaPickerList(app);
        (byId('inp-ha-picker-search') as HTMLInputElement | null)?.focus();
        return;
      }
      if (chip) {
        app.haPickerDomain = chip.getAttribute('data-ha-picker-domain') || '';
        const chips = byId('ha-picker-chips');
        if (chips) chips.innerHTML = renderHaPickerChips(app);
        const list = byId('ha-picker-list');
        if (list) list.innerHTML = renderHaPickerList(app);
      }
    });
    byId('ha-picker-list')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest('[data-ha-entity]') as HTMLElement | null;
      if (item && app.haPicker) {
        const entityId = item.getAttribute('data-ha-entity') || '';
        if (app.haPicker.ruleIndex !== undefined) {
          const idx = app.haPicker.ruleIndex;
          const rules = [...(app.form?.voiceRules || [])];
          if (rules[idx]) {
            const domain = entityId.split('.')[0];
            const defaultService = domain === 'light' ? 'turn_on'
              : (domain === 'scene' || domain === 'script') ? 'turn_on'
              : (domain === 'automation') ? 'trigger'
              : (domain === 'button' || domain === 'input_button') ? 'press'
              : (domain === 'media_player') ? 'media_play_pause'
              : (domain === 'climate') ? 'set_temperature'
              : (domain === 'cover') ? 'toggle'
              : 'toggle';

            const currentCfg = parseVoiceHaPayload(rules[idx].actionPayload);
            const newCfg = {
              entity_id: entityId,
              service: defaultService,
              color: domain === 'light' ? (currentCfg.color || '#ffffff') : undefined,
              brightness: domain === 'light' ? (currentCfg.brightness !== undefined ? currentCfg.brightness : 100) : undefined,
              temperature: domain === 'climate' ? (currentCfg.temperature ?? 21) : undefined
            };
            rules[idx].actionPayload = stringifyVoiceHaPayload(newCfg);
            app.patchForm({ voiceRules: rules }, true);
            app.pushToast(`Wybrano: ${entityId}`);
          }
          closeHaPicker(app);
          return;
        }

        if (app.haPicker.key) {
          app.patchForm({ [app.haPicker.key]: entityId } as Partial<Snapshot['config']>, true);
          app.pushToast(`Wybrano encję: ${entityId}`);
          closeHaPicker(app);
          return;
        }
      }

      // Pokoje / Obszary
      const area = target.closest('[data-ha-area]') as HTMLElement | null;
      if (area) {
        app.haPickerArea = area.getAttribute('data-ha-area') || '';
        const list = byId('ha-picker-list');
        if (list) {
          list.innerHTML = renderHaPickerList(app);
          list.scrollTop = 0;
        }
        return;
      }
      const backArea = target.closest('[data-ha-picker-back-area]');
      if (backArea) {
        app.haPickerArea = '';
        const list = byId('ha-picker-list');
        if (list) list.innerHTML = renderHaPickerList(app);
        return;
      }

      // Urządzenia
      const device = target.closest('[data-ha-device]') as HTMLElement | null;
      if (device) {
        app.haPickerDevice = device.getAttribute('data-ha-device') || '';
        const list = byId('ha-picker-list');
        if (list) {
          list.innerHTML = renderHaPickerList(app);
          list.scrollTop = 0;
        }
        return;
      }
      const back = target.closest('[data-ha-picker-back]');
      if (back) {
        app.haPickerDevice = '';
        const list = byId('ha-picker-list');
        if (list) list.innerHTML = renderHaPickerList(app);
        return;
      }
    });
    byId('btn-ha-picker-close')?.addEventListener('click', () => closeHaPicker(app));
    byId('ha-picker-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'ha-picker-overlay') closeHaPicker(app);
    });
    if (app.haPicker) (byId('inp-ha-picker-search') as HTMLInputElement | null)?.focus();

    // Radar port & timeouts
    byId('sel-port')?.addEventListener('change', (e) => {
      app.patchForm({ port: (e.target as HTMLSelectElement).value });
    });
    byId('fc-btn-refresh-ports')?.addEventListener('click', async () => {
      app.ports = await window.api.getPorts();
      app.refreshPortSelectOptions();
      app.pushToast('Odświeżono listę portów COM');
    });
    byId('inp-timeout-away')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v)) app.patchForm({ timeoutAwayMs: v });
    });
    byId('inp-timeout-desk')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v)) app.patchForm({ timeoutDeskMs: v });
    });
    byId('inp-input-hold-sec')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (!isNaN(v) && v >= 1) app.patchForm({ userInputPresenceHoldSec: v });
    });
    byId('sel-radar-smoothing')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as 'ultra' | 'balanced' | 'raw';
      app.patchForm({ radarSmoothingMode: val }, false);
      app.pushToast(`Filtr DSP: ${val === 'ultra' ? 'Ultra-Stabilny 🛡️' : val === 'balanced' ? 'Zbalansowany' : 'Szybki'}`);
    });
    byId('sel-mute-behavior')?.addEventListener('change', (e) => {
      app.patchForm({ muteBehaviorOnAway: (e.target as HTMLSelectElement).value as any });
    });

    // Mic Switching rules
    byId('sw-switch-desk')?.addEventListener('click', () => {
      const val = !(app.form?.switchMicOnDesk !== false);
      app.patchForm({ switchMicOnDesk: val }, false);
      const btn = byId('sw-switch-desk');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-switch-away')?.addEventListener('click', () => {
      const val = !(app.form?.switchMicOnAway !== false);
      app.patchForm({ switchMicOnAway: val }, false);
      const btn = byId('sw-switch-away');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-unmute-desk')?.addEventListener('click', () => {
      const val = !(app.form?.unmuteOnDesk !== false);
      app.patchForm({ unmuteOnDesk: val }, false);
      const btn = byId('sw-unmute-desk');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });

    // System & Chime
    byId('sw-autostart')?.addEventListener('click', () => {
      const val = !(app.form?.autoStart ?? false);
      app.patchForm({ autoStart: val }, false);
      const btn = byId('sw-autostart');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-sleep-monitors')?.addEventListener('click', () => {
      const val = !(app.form?.sleepMonitorsOnAway ?? false);
      app.patchForm({ sleepMonitorsOnAway: val }, true);
    });
    byId('sw-screensaver')?.addEventListener('click', () => {
      const val = !(app.form?.screensaverOnAway ?? true);
      app.patchForm({ screensaverOnAway: val }, false);
      const btn = byId('sw-screensaver');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sel-screensaver-delay')?.addEventListener('change', (e) => {
      const v = Number((e.target as HTMLSelectElement).value) || 60000;
      app.patchForm({ screensaverDelayMs: v }, false);
    });
    byId('sel-sleep-monitors-delay')?.addEventListener('change', (e) => {
      const v = Number((e.target as HTMLSelectElement).value) || 600000;
      app.patchForm({ sleepMonitorsDelayMs: v }, false);
    });
    byId('sw-wake-monitors')?.addEventListener('click', () => {
      const val = !(app.form?.wakeMonitorsOnDesk ?? true);
      app.patchForm({ wakeMonitorsOnDesk: val }, false);
      const btn = byId('sw-wake-monitors');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('btn-test-screensaver')?.addEventListener('click', async () => {
      app.pushToast('Uruchamiam test czarnego wygaszacza (ruch myszy zdejmuje ekran)…');
      try {
        await window.api.screensaverStart();
      } catch (err) {
        app.pushToast(`Błąd testu wygaszacza: ${(err as Error).message}`, true);
      }
    });
    byId('sw-audio-chime')?.addEventListener('click', () => {
      const val = !(app.form?.audioChime ?? true);
      app.patchForm({ audioChime: val }, false);
      const btn = byId('sw-audio-chime');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-chime-desk')?.addEventListener('click', () => {
      const val = !(app.form?.audioChimeOnDesk !== false);
      app.patchForm({ audioChimeOnDesk: val }, false);
      const btn = byId('sw-chime-desk');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sw-chime-away')?.addEventListener('click', () => {
      const val = !(app.form?.audioChimeOnAway !== false);
      app.patchForm({ audioChimeOnAway: val }, false);
      const btn = byId('sw-chime-away');
      if (btn) {
        btn.className = `fc-switch ${val ? 'active' : ''}`;
        btn.setAttribute('aria-checked', String(val));
      }
    });
    byId('sel-chime-style')?.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as ChimeStyle;
      // Styl trafia do configu — bez zapisu wybór "resetował" się po restarcie
      app.patchForm({ audioChimeStyle: val });
      playChime('desk', app.form?.audioChimeVolume ?? 0.2, app.selectedChimeStyle);
      app.pushToast('Wybrano i przetestowano styl powiadomienia Chime');
    });
    byId('btn-test-chime')?.addEventListener('click', () => {
      playChime('desk', app.form?.audioChimeVolume ?? 0.2, app.selectedChimeStyle);
    });
    byId('rng-chime-volume')?.addEventListener('input', (e) => {
      const v = Math.max(0, Math.min(100, Number((e.target as HTMLInputElement).value)));
      app.patchForm({ audioChimeVolume: v / 100 });
      const elVal = byId('val-chime-volume');
      if (elVal) elVal.textContent = `${v}%`;
      playChime('desk', v / 100, app.selectedChimeStyle);
    });

    // Własne pliki audio (Stacjonarny / Słuchawki) — wybór, test, czyszczenie
    const bindCustomAudio = (variant: 'desk' | 'headset') => {
      const configKey = variant === 'desk' ? 'audioFileDesk' : 'audioFileHeadset';
      byId(`btn-pick-audio-${variant}`)?.addEventListener('click', async () => {
        const picked = await window.api.pickAudioFile();
        if (!picked) return;
        app.patchForm({ [configKey]: picked });
        app.render();
        playCustomAudioFile(picked, variant === 'desk' ? 'desk' : 'headset', app.form?.audioChimeVolume ?? 0.2);
        app.pushToast('Ustawiono własny dźwięk — przetestowany 🎵');
      });
      byId(`btn-test-audio-${variant}`)?.addEventListener('click', () => {
        const file = variant === 'desk' ? app.form?.audioFileDesk : app.form?.audioFileHeadset;
        if (file) playCustomAudioFile(file, variant === 'desk' ? 'desk' : 'headset', app.form?.audioChimeVolume ?? 0.2);
      });
      byId(`btn-clear-audio-${variant}`)?.addEventListener('click', () => {
        app.patchForm({ [configKey]: '' });
        app.render();
        app.pushToast('Przywrócono syntezowany chime 🔔');
      });
    };
    bindCustomAudio('desk');
    bindCustomAudio('headset');

    // Logs Filtering & Search
    document.querySelectorAll<HTMLElement>('[data-log-filter]').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        const filter = (e.currentTarget as HTMLElement).getAttribute('data-log-filter') as any;
        if (filter) {
          app.logFilter = filter;
          document.querySelectorAll('[data-log-filter]').forEach((c) => c.classList.remove('active'));
          (e.currentTarget as HTMLElement).classList.add('active');
          refreshLogConsoleDOM(app);
        }
      });
    });

    byId('inp-log-search')?.addEventListener('input', (e) => {
      app.logSearch = (e.target as HTMLInputElement).value;
      refreshLogConsoleDOM(app);
    });

    byId('fc-btn-copy-diag-report')?.addEventListener('click', async () => {
      const snap = app.snap;
      const form = app.form;
      const fullLogs = await window.api.getLogs();
      const logsToInclude = fullLogs && fullLogs.length > 0 ? fullLogs : app.logs;
      // Raport domyślnie zawiera to, co użytkownik widzi w konsoli logów
      // (aktywna zakładka: Audio & VU, Discord & RGB itd. + wyszukiwarka).
      const visibleLogs = applyLogFilter(app, logsToInclude);
      const filterNames: Record<string, string> = {
        all: 'Wszystkie',
        radar: 'Radar & DSP',
        voice: 'Mowa & Vosk',
        haos: 'HAOS',
        audio: 'Audio & VU',
        discord: 'Discord & RGB',
        error: 'Błędy'
      };
      const activeFilterName = filterNames[app.logFilter] || 'Wszystkie';

      // Kluczowe zdarzenia audio, przełączania, błędów i radar-event z widocznego zbioru
      const keyEvents = visibleLogs.filter((l) =>
        /\[(AUDIO-|SWITCH-|APP-|RADAR-EVENT|WARN|ERROR)/i.test(l)
      );

      // Ostatnie próbki telemetryczne dla podglądu działania radaru —
      // 200 ramek z odfiltrowanym szumem (duplikaty lux, powtórki bez zmiany wartości).
      const stripTs = (l: string) => l.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/\x1B\[[0-9;]*m/g, '').trim();
      const isNoiseRaw = (l: string) => /bh1750\.sensor|Illuminance|illuminance/i.test(l);
      const dspVal = (l: string) => {
        const m = l.match(/\[RADAR-DSP\]\s*(Tętno|Oddech|Dystans|Światło):\s*([\d.]+)/);
        return m ? `${m[1]}:${m[2]}` : null;
      };
      const filteredTelemetry: string[] = [];
      let lastRawNorm = '';
      let lastDspSig: string | null = null;
      for (const l of logsToInclude) {
        // Zdarzenia kluczowe zawsze wchodzą (rzadkie, nośne)
        if (/\[(RADAR-EVENT|RADAR-AMBIG|SWITCH-|AUDIO-|WARN|ERROR|APP-)/i.test(l)) {
          filteredTelemetry.push(l);
          continue;
        }
        // Przetworzony sygnał: trzymamy tylko gdy zmieniła się wartość wyjściowa
        if (/\[RADAR-DSP/i.test(l)) {
          const sig = dspVal(l);
          if (sig && sig !== lastDspSig) {
            filteredTelemetry.push(l);
            lastDspSig = sig;
          }
          continue;
        }
        // Surowe ramki: bez luxa i bez identycznych powtórek
        if (/\[RADAR-RAW/i.test(l)) {
          if (isNoiseRaw(l)) continue;
          const norm = stripTs(l);
          if (norm && norm !== lastRawNorm) {
            filteredTelemetry.push(l);
            lastRawNorm = norm;
          }
          continue;
        }
      }
      // Okno próbki: ostatnie 2 minuty — diagnostyka fuzji potrzebuje pełnych
      // cykli zachowania radaru (rampy dystansu trwają po ~35 s), migawka z
      // 200 linii łapała ledwo kilkanaście sekund. Gdy w oknie nic nie ma
      // (cisza ramek), awaryjnie zostaje ostatnie 100 linii.
      const RAW_WINDOW_MS = 120_000;
      const nowTs = Date.now();
      const ageMs = (l: string): number => {
        const m = l.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
        if (!m) return 0;
        const n = new Date();
        const t = new Date(n.getFullYear(), n.getMonth(), n.getDate(), +m[1], +m[2], +m[3]).getTime();
        return nowTs - t;
      };
      let windowStart = filteredTelemetry.findIndex((l) => ageMs(l) <= RAW_WINDOW_MS);
      if (windowStart < 0) windowStart = Math.max(0, filteredTelemetry.length - 100);
      const recentTelemetry = filteredTelemetry.slice(windowStart);

      const report = [
        `# Raport Diagnostyczny DeskSense (dla Agenta AI / Programisty)`,
        `Data wygenerowania: ${new Date().toLocaleString('pl-PL')}`,
        `Wersja: v${snap?.version || '0.3.0'} | Tryb pracy: ${snap?.mode || 'auto'} | Aktywny profil: ${snap?.state === 'desk' ? 'Stacjonarny (Biurko)' : 'Mobilny (Słuchawki)'}`,
        ``,
        `## 📡 Radar mmWave & Stan Obecności`,
        `- Aktywne źródło: ${snap?.ha?.activeSource === 'ha' ? 'Home Assistant OS' : 'USB COM Port'}`,
        `- Stan obecności (Presence): ${snap?.radar?.presence ? 'OBECNY PRZY BIURKU (true)' : 'POZA FOTELEM (false)'}`,
        `- Dystans live: ${app.telemetry.distanceCm ?? '--'} cm${app.telemetry.distanceTrusted === false ? ' | CEL NIEPEWNY (kot?)' : ''} | Cele: ${app.telemetry.targetCount ?? '—'}`,
        `- Biometria live: Tętno: ${app.telemetry.heartRate ?? '--'} BPM | Oddech: ${app.telemetry.breathRate ?? '--'} RPM`,
        `- Oświetlenie: ${typeof app.telemetry.illuminanceLux === 'number' ? `${app.telemetry.illuminanceLux} lx` : '--'}`,
        `- Port USB: ${snap?.radar?.port || form?.port || 'auto'} (baud: ${form?.baudRate || 115200})`,
        ``,
        `## 🎙️ Konfiguracja Audio & Urządzenia Windows`,
        `- Profil Stacjonarny (Biurko): "${form?.micDeskName || 'nie wybrano'}" (Głośność: ${form?.micDeskVolume ?? 100}%, Auto-Switch: ${form?.switchMicOnDesk !== false ? 'TAK' : 'NIE'})`,
        `- Profil Mobilny (Słuchawki): "${form?.micHeadsetName || 'nie wybrano'}" (Głośność: ${form?.micHeadsetVolume ?? 100}%, Auto-Switch: ${form?.switchMicOnAway !== false ? 'TAK' : 'NIE'})`,
        `- Aktualnie domyślny mikrofon Windows: "${app.audioDevices.find((d) => d.isDefault)?.name || 'brak'}"`,
        `- Wykryte mikrofony w systemie (${app.audioDevices.length}):`,
        ...app.audioDevices.map(
          (d) => `  * "${d.name}" [ID: ${d.id || 'n/a'}] ${d.isDefault ? ' ⭐ [DOMYŚLNY]' : ''} ${d.isMuted ? ' 🔇 [MUTED]' : ' 🔊 [UNMUTED]'} (vol: ${d.volume ?? '--'}%)`
        ),
        ``,
        `## 🔌 Integracje Zewnętrzne`,
        `- Home Assistant: ${form?.haEnabled ? `Włączony (${snap?.ha?.connected ? 'Połączono' : 'Brak połączenia'})` : 'Wyłączony'}`,
        `- Discord: ${form?.discordIntegration ? 'Włączony' : 'Wyłączony'} (Auto-Próg VAD: ${form?.discordGateFollowMic ? 'TAK' : 'NIE'})`,
        `- SignalRGB: ${form?.signalrgbEnabled ? 'Włączony' : 'Wyłączony'}`,
        ``,
        `## ⚡ Oś Czasu Kluczowych Zdarzeń (Przełączanie, Audio, Zmiany Stanu) [${keyEvents.length} wpisów, widok logów: ${activeFilterName}]`,
        '```',
        keyEvents.length > 0 ? keyEvents.join('\n') : 'Brak zarejestrowanych zdarzeń przełączania w buforze.',
        '```',
        ``,
        `## 🌊 Ostatnia Próbka Strumienia Radaru (ostatnie 2 minuty, ${recentTelemetry.length} wpisów, bez szumu)`,
        '```',
        recentTelemetry.length > 0 ? recentTelemetry.join('\n') : 'Brak ramek telemetrycznych.',
        '```'
      ].join('\n');

      await window.api.copyToClipboard(report);
      app.pushToast('Skopiowano idealny raport diagnostyczny dla Agenta AI! 🤖📋');
    });

    byId('fc-btn-open-notepad')?.addEventListener('click', async () => {
      const ok = await window.api.openLogsInNotepad();
      if (ok) {
        app.pushToast('Otwarto wszystkie surowe logi w Notatniku 📝');
      } else {
        app.pushToast('Nie udało się uruchomić Notatnika', true);
      }
    });

    byId('fc-btn-copy-logs')?.addEventListener('click', async () => {
      try {
        const fullLogs = await window.api.getLogs();
        const logs = fullLogs && fullLogs.length > 0 ? fullLogs : app.logs;
        // Kopiujemy to, co widoczne w konsoli (aktywna zakładka + wyszukiwarka)
        const visible = applyLogFilter(app, logs || []);
        if (!visible || visible.length === 0) {
          app.pushToast('Brak logów do skopiowania dla aktywnego filtru');
          return;
        }
        await window.api.copyToClipboard(visible.join('\r\n'));
        const scope = app.logFilter === 'all' && !app.logSearch ? 'WSZYSTKIE' : 'widoczne (aktywny filtr)';
        app.pushToast(`Skopiowano logi RAW — ${scope} (${visible.length} linii) 📋`);
      } catch (err: any) {
        app.pushToast(`Błąd kopiowania: ${err.message}`, true);
      }
    });
    byId('fc-btn-clear-logs')?.addEventListener('click', async () => {
      await window.api.clearLogs();
      app.logs = [];
      refreshLogConsoleDOM(app);
      app.pushToast('Wyczyszczono logi');
    });

    // Firmware & Flasher MR60BHA2 (limengdu/MR60BHA2_ESPHome_external_components)
    byId('btn-open-stock-bin')?.addEventListener('click', () => {
      void window.api.openExternal('https://github.com/limengdu/MR60BHA2_ESPHome_external_components/releases');
      app.pushToast('Otwieram Releases z binarkami firmware…');
    });
    byId('btn-open-seeed-wiki')?.addEventListener('click', () => {
      void window.api.openExternal('https://limengdu.github.io/MR60BHA2_ESPHome_external_components/');
      app.pushToast('Otwieram Web Flasher ESPHome…');
    });
    byId('btn-open-seeed-gh')?.addEventListener('click', () => {
      void window.api.openExternal('https://github.com/limengdu/MR60BHA2_ESPHome_external_components');
      app.pushToast('Otwieram repozytorium GitHub ESPHome…');
    });

    // Updates & About
    byId('fc-btn-check-updates')?.addEventListener('click', async () => {
      app.pushToast('Sprawdzam aktualizacje na GitHubie…');
      try {
        const res = await window.api.checkForUpdates();
        if (res.available && res.updateInfo) {
          app.pushToast(`Dostępna nowa wersja: v${res.updateInfo.version}`);
        } else {
          app.pushToast('Aplikacja jest aktualna ✓');
        }
      } catch (err: any) {
        app.pushToast(`Błąd: ${err.message}`, true);
      }
    });

    byId('btn-download-update')?.addEventListener('click', async () => {
      app.pushToast('Pobieranie aktualizacji…');
      try {
        await window.api.downloadUpdate();
      } catch (err: any) {
        app.pushToast(`Błąd pobierania: ${err.message}`, true);
      }
    });

    byId('btn-install-update')?.addEventListener('click', async () => {
      try {
        await window.api.installUpdate();
      } catch (err: any) {
        app.pushToast(`Błąd instalacji: ${err.message}`, true);
      }
    });

    byId('btn-run-full-diag')?.addEventListener('click', () => {
      app.diagModalOpen = true;
      app.render();
    });

    byId('fc-btn-open-conf-dir')?.addEventListener('click', () => window.api.openConfigDir());

    // QoL: Profile JSON Export
    byId('fc-btn-copy-profile')?.addEventListener('click', async () => {
      if (!app.form) return;
      await window.api.copyToClipboard(JSON.stringify(app.form, null, 2));
      app.pushToast('Konfiguracja profilu skopiowana do schowka (JSON) ✓');
    });

    // Save & Reset bottom bar
    byId('fc-btn-save')?.addEventListener('click', () => app.save());
    byId('fc-btn-reset-defaults')?.addEventListener('click', async () => {
      if (confirm('Przywrócić wszystkie ustawienia do wartości domyślnych?')) {
        app.snap = await window.api.resetConfig();
        app.form = { ...app.snap.config };
        app.dirty = false;
        app.pushToast('Przywrócono ustawienia domyślne ✓');
        app.render();
      }
    });

    // Diagnostics Modal
    byId('btn-diag-close')?.addEventListener('click', () => { app.diagModalOpen = false; app.render(); });
    byId('btn-diag-cancel')?.addEventListener('click', () => { app.diagModalOpen = false; app.render(); });
    byId('diag-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'diag-overlay') { app.diagModalOpen = false; app.render(); }
    });

    // Sesja diagnostyczna "Wyjście z pokoju"
    byId('fc-header-diag-btn')?.addEventListener('click', () => void toggleDiagSession(app));
    byId('btn-diag-session-close')?.addEventListener('click', () => { app.diagReportModalOpen = false; app.render(); });
    byId('btn-diag-session-cancel')?.addEventListener('click', () => { app.diagReportModalOpen = false; app.render(); });
    byId('diag-session-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'diag-session-overlay') { app.diagReportModalOpen = false; app.render(); }
    });
    byId('btn-diag-session-copy')?.addEventListener('click', async () => {
      await window.api.copyToClipboard(app.diagSessionText);
      app.pushToast('Raport skopiowany do schowka 🤖');
    });
    byId('btn-diag-session-notepad')?.addEventListener('click', async () => {
      const ok = await window.api.openTextInNotepad(app.diagSessionText);
      app.pushToast(ok ? 'Otwarto raport w Notatniku 📝' : 'Nie udało się uruchomić Notatnika', !ok);
    });

    // Voice Control Events
    bindVoiceEvents(app);
  }

function bindVoiceEvents(app: AppUI): void {
  const byId = (id: string) => document.getElementById(id);

  // Master switch
  byId('sw-voice-enabled')?.addEventListener('click', async () => {
    const next = !(app.form?.voiceEnabled ?? false);
    byId('sw-voice-enabled')?.classList.toggle('active', next);
    byId('sw-voice-enabled')?.setAttribute('aria-checked', String(next));
    app.patchForm({ voiceEnabled: next }, false);
    void app.save();
    if (app.currentTab === 'settings' && app.settingsTab === 'voice') {
      app.render();
    }
    app.pushToast(next ? 'Włączono sterowanie głosem 🎙️' : 'Wyłączono sterowanie głosem ⏸️');

    if (next && !isSelectedVoiceModelReady(app)) {
      const engine = app.form?.voiceEngine || 'whisper';
      const isWhisper = engine === 'whisper';
      const promptText = isWhisper
        ? 'Sterowanie głosem OpenAI Whisper wymaga jednorazowego pobrania silnika AI (~150 MB).\n\nCzy chcesz pobrać go teraz automatycznie w tle?'
        : 'Silnik mowy Vosk wymaga pobrania pakietu (~45 MB).\n\nCzy chcesz pobrać go teraz automatycznie w tle?';

      if (window.confirm(promptText)) {
        app.pushToast(`Rozpoczynam pobieranie komponentów (${engine.toUpperCase()})… ⏳`);
        const targetModel = isWhisper ? app.form?.voiceWhisperModel : app.form?.voiceModel;
        const targetBackend = app.form?.voiceWhisperBackend || 'auto';
        try {
          const res = await window.api.voiceStartDownload(engine, targetModel as any, targetBackend as any);
          if (res && res.ok) {
            app.pushToast('Komponenty mowy zainstalowane pomyślnie! Silnik aktywny ✓');
            if (app.currentTab === 'settings' && app.settingsTab === 'voice') {
              app.render();
            }
          } else if (res && !res.ok) {
            app.pushToast(`Błąd pobierania: ${res.message || 'Nieznany błąd'}`, true);
          }
        } catch (err: any) {
          app.pushToast(`Błąd: ${err.message}`, true);
        }
      }
    }
  });

  // Wymóg słowa wywołania (Wake word switch)
  byId('sw-voice-require-wake')?.addEventListener('click', () => {
    const next = !(app.form?.voiceRequireWakeWord ?? true);
    byId('sw-voice-require-wake')?.classList.toggle('active', next);
    byId('sw-voice-require-wake')?.setAttribute('aria-checked', String(next));
    const rowWake = byId('row-voice-wake-word');
    if (rowWake) rowWake.style.display = next ? 'flex' : 'none';
    app.patchForm({ voiceRequireWakeWord: next }, false);
    void app.save();
    if (app.currentTab === 'settings' && app.settingsTab === 'voice') {
      app.render();
    }
    app.pushToast(next ? 'Włączono wymóg słowa wywołania (Wake Word) 🛡️' : 'Komendy działają bezpośrednio bez słowa wywołania ⚡');
  });

  // Wake word input
  byId('inp-voice-wake-word')?.addEventListener('change', (e) => {
    const val = ((e.target as HTMLInputElement).value || '').trim();
    if (!val) {
      app.pushToast('Słowo wywołujące nie może być puste', true);
      (e.target as HTMLInputElement).value = app.form?.voiceWakeWord || 'ok';
      return;
    }
    app.patchForm({ voiceWakeWord: val.toLowerCase() }, false);
    void app.save();
    if (app.currentTab === 'settings' && app.settingsTab === 'voice') {
      app.render();
    }
  });

  // Dynamic sections (odświeżane przez voice:status / voice:downloadProgress)
  bindVoiceDynamic(app);

  // Engine select cards
  byId('btn-engine-whisper')?.addEventListener('click', () => {
    byId('btn-engine-whisper')?.classList.add('selected');
    byId('btn-engine-vosk')?.classList.remove('selected');
    const rowWhisper = byId('row-whisper-model');
    const rowVosk = byId('row-vosk-model');
    const customRow = byId('row-vosk-custom-path');
    if (rowWhisper) rowWhisper.style.display = 'block';
    if (rowVosk) rowVosk.style.display = 'none';
    if (customRow) customRow.style.display = 'none';
    app.patchForm({ voiceEngine: 'whisper' }, false);
    void app.save();
    const dlSec = byId('voice-download-section');
    if (dlSec) {
      dlSec.innerHTML = renderVoiceDownloadSection(app);
      bindVoiceDynamic(app);
    }
    app.pushToast('Przełączono na silnik: OpenAI Whisper AI 🧠');
  });

  byId('btn-engine-vosk')?.addEventListener('click', () => {
    byId('btn-engine-vosk')?.classList.add('selected');
    byId('btn-engine-whisper')?.classList.remove('selected');
    const rowWhisper = byId('row-whisper-model');
    const rowVosk = byId('row-vosk-model');
    const customRow = byId('row-vosk-custom-path');
    if (rowWhisper) rowWhisper.style.display = 'none';
    if (rowVosk) rowVosk.style.display = 'block';
    if (customRow) customRow.style.display = app.form?.voiceModel === 'custom' ? 'block' : 'none';
    app.patchForm({ voiceEngine: 'vosk' }, false);
    void app.save();
    const dlSec = byId('voice-download-section');
    if (dlSec) {
      dlSec.innerHTML = renderVoiceDownloadSection(app);
      bindVoiceDynamic(app);
    }
    app.pushToast('Przełączono na silnik: Vosk Fast 🚀');
  });

  // Whisper model select
  byId('sel-whisper-model')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    app.patchForm({ voiceWhisperModel: val as any }, false);
    void app.save();
    const dlSec = byId('voice-download-section');
    if (dlSec) {
      dlSec.innerHTML = renderVoiceDownloadSection(app);
      bindVoiceDynamic(app);
    }
  });

  // Whisper backend select (GPU / CPU)
  byId('sel-whisper-backend')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    app.patchForm({ voiceWhisperBackend: val as any }, false);
    const hintEl = byId('voice-backend-hint');
    if (hintEl) hintEl.innerHTML = renderBackendHint(val as any, app.snap?.voice);
    void app.save();
    const dlSec = byId('voice-download-section');
    if (dlSec) {
      dlSec.innerHTML = renderVoiceDownloadSection(app);
      bindVoiceDynamic(app);
    }
  });

  // Usuń pakiet backendu
  byId('btn-delete-voice-backend')?.addEventListener('click', async () => {
    const key = app.form?.voiceWhisperBackend || 'auto';
    if (key === 'auto') return;
    if (!window.confirm(`Usunąć pakiet backendu „${key}” z dysku?`)) return;
    const res = await window.api.voiceDeleteAsset('backend', key);
    app.pushToast(res?.message || (res?.ok ? 'Usunięto backend' : 'Błąd usuwania'), !res?.ok);
    if (app.currentTab === 'settings' && app.settingsTab === 'voice') app.render();
  });

  // Idle unload minutes (na żywo — bez restartu silnika)
  byId('inp-voice-idle-min')?.addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(60, Number((e.target as HTMLInputElement).value) || 0));
    (e.target as HTMLInputElement).value = String(v);
    app.patchForm({ voiceIdleUnloadMin: v }, false);
  });

  // Vosk Model select
  byId('sel-voice-model')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    const customRow = byId('row-vosk-custom-path');
    if (customRow) customRow.style.display = val === 'custom' ? 'block' : 'none';
    app.patchForm({ voiceModel: val as any }, false);
    void app.save();
    const dlSec = byId('voice-download-section');
    if (dlSec) {
      dlSec.innerHTML = renderVoiceDownloadSection(app);
      bindVoiceDynamic(app);
    }
  });

  // Custom model path input
  byId('inp-voice-custom-path')?.addEventListener('change', (e) => {
    const val = (e.target as HTMLInputElement).value;
    app.patchForm({ voiceCustomModelPath: val });
  });

  // Pick custom model folder button
  byId('btn-pick-custom-model')?.addEventListener('click', async () => {
    const folder = await window.api.voicePickCustomModel();
    if (folder) {
      app.patchForm({ voiceCustomModelPath: folder }, false);
      const inp = byId('inp-voice-custom-path') as HTMLInputElement | null;
      if (inp) inp.value = folder;
      app.pushToast(`Wybrano folder modelu: ${folder}`);
    }
  });

  // Wake word & safety switches
  byId('sw-voice-only-desk')?.addEventListener('click', () => {
    const next = !(app.form?.voiceOnlyAtDesk ?? true);
    byId('sw-voice-only-desk')?.classList.toggle('active', next);
    byId('sw-voice-only-desk')?.setAttribute('aria-checked', String(next));
    app.patchForm({ voiceOnlyAtDesk: next }, false);
    void app.save();
  });

  byId('sw-voice-chime')?.addEventListener('click', () => {
    const next = !(app.form?.voiceChimeFeedback ?? true);
    byId('sw-voice-chime')?.classList.toggle('active', next);
    byId('sw-voice-chime')?.setAttribute('aria-checked', String(next));
    app.patchForm({ voiceChimeFeedback: next }, false);
    void app.save();
  });

  // Add rule button
  byId('btn-add-voice-rule')?.addEventListener('click', () => {
    const rules = [...(app.form?.voiceRules || [])];
    const newId = `rule_${Date.now()}`;
    rules.push({
      id: newId,
      name: `Nowa komenda #${rules.length + 1}`,
      phrase: '',
      actionType: 'switch_desk',
      enabled: true
    });
    app.patchForm({ voiceRules: rules }, true);
    app.pushToast('Dodano nową regułę komendy głosowej');
  });

  // Rule enable switch
  document.querySelectorAll<HTMLElement>('.rule-enable-switch').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        rules[idx].enabled = !rules[idx].enabled;
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.rule-name-input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        rules[idx].name = (e.target as HTMLInputElement).value;
        app.patchForm({ voiceRules: rules });
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.rule-phrase-input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        rules[idx].phrase = (e.target as HTMLInputElement).value;
        app.patchForm({ voiceRules: rules });
      }
    });
  });

  document.querySelectorAll<HTMLSelectElement>('.rule-action-select').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        rules[idx].actionType = (e.target as HTMLSelectElement).value as any;
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.rule-payload-input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        rules[idx].actionPayload = (e.target as HTMLInputElement).value;
        app.patchForm({ voiceRules: rules });
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-pick-rule-app').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const filePath = await window.api.voicePickAppPath();
      if (filePath) {
        const rules = [...(app.form?.voiceRules || [])];
        if (rules[idx]) {
          rules[idx].actionPayload = filePath;
          app.patchForm({ voiceRules: rules }, true);
          app.pushToast(`Wybrano plik programu: ${filePath}`);
        }
      }
    });
  });

  // Home Assistant (HAOS) — Picker urządzeń/encji w regułach głosowych
  document.querySelectorAll<HTMLButtonElement>('.btn-open-ha-rule-picker').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      openHaPickerForRule(app, idx);
    });
  });

  // Home Assistant (HAOS) — Czyszczenie wybranego urządzenia/encji
  document.querySelectorAll<HTMLButtonElement>('.btn-clear-ha-rule').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        rules[idx].actionPayload = '';
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  // Home Assistant (HAOS) — Wybór usługi (Włącz / Wyłącz / Przełącz itp.)
  document.querySelectorAll<HTMLSelectElement>('.sel-ha-rule-service').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const service = (e.target as HTMLSelectElement).value;
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        const currentCfg = parseVoiceHaPayload(rules[idx].actionPayload);
        currentCfg.service = service;
        rules[idx].actionPayload = stringifyVoiceHaPayload(currentCfg);
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  // Home Assistant (HAOS) — Suwak jasności światła
  document.querySelectorAll<HTMLInputElement>('.fc-rule-ha-brightness-slider').forEach((el) => {
    el.addEventListener('input', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const briVal = Number((e.target as HTMLInputElement).value);
      const valEl = document.getElementById(`ha-rule-bri-val-${idx}`);
      if (valEl) valEl.textContent = `${briVal}%`;
    });
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const briVal = Number((e.target as HTMLInputElement).value);
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        const currentCfg = parseVoiceHaPayload(rules[idx].actionPayload);
        currentCfg.brightness = briVal;
        rules[idx].actionPayload = stringifyVoiceHaPayload(currentCfg);
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  // Home Assistant (HAOS) — Szybkie przyciski jasności (25%, 50%, 100%, Auto)
  document.querySelectorAll<HTMLButtonElement>('.btn-ha-rule-bri').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const briAttr = (e.currentTarget as HTMLElement).getAttribute('data-bri');
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        const currentCfg = parseVoiceHaPayload(rules[idx].actionPayload);
        if (briAttr === 'none') {
          delete currentCfg.brightness;
        } else {
          currentCfg.brightness = Number(briAttr);
        }
        rules[idx].actionPayload = stringifyVoiceHaPayload(currentCfg);
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  // Home Assistant (HAOS) — Szybka paleta kolorów
  document.querySelectorAll<HTMLButtonElement>('.btn-ha-rule-color').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const color = (e.currentTarget as HTMLElement).getAttribute('data-color') || '';
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        const currentCfg = parseVoiceHaPayload(rules[idx].actionPayload);
        currentCfg.color = color === 'none' ? undefined : color;
        rules[idx].actionPayload = stringifyVoiceHaPayload(currentCfg);
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  // Home Assistant (HAOS) — Color Picker HTML
  document.querySelectorAll<HTMLInputElement>('.fc-rule-ha-color-input').forEach((el) => {
    el.addEventListener('change', (e) => {
      const idx = Number((e.target as HTMLElement).getAttribute('data-index'));
      const color = (e.target as HTMLInputElement).value;
      const rules = [...(app.form?.voiceRules || [])];
      if (rules[idx]) {
        const currentCfg = parseVoiceHaPayload(rules[idx].actionPayload);
        currentCfg.color = color;
        rules[idx].actionPayload = stringifyVoiceHaPayload(currentCfg);
        app.patchForm({ voiceRules: rules }, true);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-test-voice-rule').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const rules = app.form?.voiceRules || [];
      const rule = rules[idx];
      if (rule) {
        app.pushToast(`Testuję akcję: [${rule.name}]…`);
        const res = await window.api.voiceTestAction(rule);
        if (res && res.ok) {
          app.pushToast(`✓ ${res.message || 'Akcja wykonana pomyślnie'}`);
        } else {
          app.pushToast(`Błąd wykonania: ${res?.message || 'Niepowodzenie'}`, true);
        }
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-delete-voice-rule').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.currentTarget as HTMLElement).getAttribute('data-index'));
      const rules = [...(app.form?.voiceRules || [])];
      const removed = rules.splice(idx, 1);
      app.patchForm({ voiceRules: rules }, true);
      app.pushToast(`Usunięto regułę: ${removed[0]?.name || ''}`);
    });
  });

  // Calibration Wizard modal
  byId('btn-open-voice-calibrator')?.addEventListener('click', async () => {
    if (!isSelectedVoiceModelReady(app)) {
      const engine = app.form?.voiceEngine || 'whisper';
      const promptText = engine === 'whisper'
        ? 'Kalibrator wymowy wymaga pobranego modelu OpenAI Whisper (~150 MB).\n\nCzy chcesz pobrać go teraz automatycznie w tle?'
        : 'Kalibrator wymowy wymaga pobranego modelu Vosk (~45 MB).\n\nCzy chcesz pobrać go teraz automatycznie w tle?';

      if (window.confirm(promptText)) {
        app.pushToast(`Rozpoczynam pobieranie modelu (${engine.toUpperCase()})… ⏳`);
        const targetModel = engine === 'whisper' ? app.form?.voiceWhisperModel : app.form?.voiceModel;
        const targetBackend = app.form?.voiceWhisperBackend || 'auto';
        try {
          const res = await window.api.voiceStartDownload(engine, targetModel as any, targetBackend as any);
          if (res && res.ok) {
            app.pushToast('Model pobrany! Otwieram kalibrator… ✓');
            app.voiceCalibratorOpen = true;
            app.render();
            try {
              await window.api.voiceStartLiveTest();
            } catch (_) {}
          } else if (res && !res.ok) {
            app.pushToast(`Błąd pobierania: ${res.message || 'Nieznany błąd'}`, true);
          }
        } catch (err: any) {
          app.pushToast(`Błąd: ${err.message}`, true);
        }
      }
      return;
    }

    app.voiceCalibratorOpen = true;
    app.render();
    try {
      await window.api.voiceStartLiveTest();
    } catch (_) {}
  });

  const closeCalibrator = async () => {
    app.voiceCalibratorOpen = false;
    app.render();
    try {
      await window.api.voiceStopLiveTest();
    } catch (_) {}
  };

  byId('btn-close-voice-calibrator')?.addEventListener('click', () => void closeCalibrator());
  byId('btn-close-voice-calibrator-2')?.addEventListener('click', () => void closeCalibrator());
  byId('modal-voice-calibrator')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'modal-voice-calibrator') {
      void closeCalibrator();
    }
  });

  byId('btn-use-recognized-phrase')?.addEventListener('click', async () => {
    if (!app.voiceLastRecognized) return;
    const wakeWord = (app.form?.voiceWakeWord || 'ok').trim().toLowerCase();
    const regex = new RegExp(`^(?:${wakeWord}|ok|okej|okey|desksense|desk-sense)\\s+`, 'i');
    let phraseClean = app.voiceLastRecognized.replace(regex, '').trim();
    if (!phraseClean) phraseClean = app.voiceLastRecognized.trim();
    const rules = [...(app.form?.voiceRules || [])];
    rules.push({
      id: `rule_${Date.now()}`,
      name: `Komenda: ${phraseClean.substring(0, 20)}`,
      phrase: phraseClean,
      actionType: 'switch_desk',
      enabled: true
    });
    app.patchForm({ voiceRules: rules }, true);
    app.pushToast(`Utworzono komendę dla frazy: „${phraseClean}” ✓`);
    await closeCalibrator();
  });
}

/** Wiąże przyciski dynamicznych sekcji karty głosowej (pobieranie / anuluj) —
 *  wywoływane po każdym podmianie innerHTML przez voice:status. */
export function bindVoiceDynamic(app: AppUI): void {
  const byId = (id: string) => document.getElementById(id);

  byId('btn-download-voice-model')?.addEventListener('click', async () => {
    const engine = app.form?.voiceEngine || 'whisper';
    const targetModel = engine === 'whisper' ? app.form?.voiceWhisperModel : app.form?.voiceModel;
    const targetBackend = app.form?.voiceWhisperBackend || 'auto';
    app.pushToast(`Rozpoczynam pobieranie wybranych komponentów (${engine.toUpperCase()})… ⏳`);
    try {
      const res = await window.api.voiceStartDownload(engine, targetModel as any, targetBackend as any);
      if (res && res.ok) {
        app.pushToast('Wybrane komponenty mowy zainstalowane pomyślnie ✓');
        if (app.currentTab === 'settings' && app.settingsTab === 'voice') {
          app.render();
        }
      } else if (res && !res.ok) {
        app.pushToast(`Błąd pobierania: ${res.message || 'Nieznany błąd'}`, true);
      }
    } catch (err: any) {
      app.pushToast(`Błąd: ${err.message}`, true);
    }
  });

  byId('btn-cancel-voice-download')?.addEventListener('click', async () => {
    try {
      await window.api.voiceCancelDownload();
      app.pushToast('Pobieranie anulowane');
    } catch (err: any) {
      app.pushToast(`Błąd anulowania: ${err.message}`, true);
    }
  });

  byId('btn-delete-voice-model')?.addEventListener('click', async () => {
    const engine = app.form?.voiceEngine || 'whisper';
    const key = engine === 'whisper' ? (app.form?.voiceWhisperModel || 'whisper-base') : (app.form?.voiceModel || 'pl-small');
    if (!window.confirm(`Usunąć pobrany model „${key}” z dysku?`)) return;
    const res = await window.api.voiceDeleteAsset('model', key);
    app.pushToast(res?.message || (res?.ok ? 'Usunięto model' : 'Błąd usuwania'), !res?.ok);
    if (app.currentTab === 'settings' && app.settingsTab === 'voice') app.render();
  });
}
