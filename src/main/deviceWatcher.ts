import type AudioController from './audioController';
import RadarListener from './radarListener';
import type { AudioDeviceItem, SerialPortInfo } from '../shared/types';

export interface DeviceWatcherHandlers {
  devicesChanged: (devices: AudioDeviceItem[], added: string[], removed: string[]) => void;
  portsChanged: (ports: SerialPortInfo[], added: string[], removed: string[]) => void;
}

/**
 * Watchdog sprzętu (main process): co ~3 s odświeża listę mikrofonów i portów
 * COM niezależnie od widoczności okna (apka siedzi w tray) i informuje o
 * podłączeniu/odłączeniu urządzenia. Dzięki temu dropdowny miksu/portu nigdy
 * nie są nieaktualne — nie trzeba klikać "Auto-wykryj mikrofony".
 */
export default class DeviceWatcher {
  private readonly audio: AudioController;
  private readonly handlers: DeviceWatcherHandlers;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private audioInitialized = false;
  private portsInitialized = false;
  private prevDeviceSig = '';
  private prevDeviceNames = new Set<string>();
  private prevPortSig = '';
  private prevPortPaths = new Set<string>();

  constructor(audio: AudioController, handlers: DeviceWatcherHandlers) {
    this.audio = audio;
    this.handlers = handlers;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.checkAudioDevices();
      await this.checkPorts();
    } catch {
      /* pomiń cykl */
    } finally {
      this.ticking = false;
    }
  }

  private async checkAudioDevices(): Promise<void> {
    try {
      const devices = await this.audio.listRecordingDevices(true);
      const sig = devices.map((d) => d.id || d.name).sort().join('|');
      if (sig === this.prevDeviceSig) return;

      const names = new Set(devices.map((d) => d.name));
      const added = [...names].filter((n) => !this.prevDeviceNames.has(n));
      const removed = [...this.prevDeviceNames].filter((n) => !names.has(n));
      this.prevDeviceSig = sig;
      this.prevDeviceNames = names;

      if (!this.audioInitialized) {
        this.audioInitialized = true;
        return;
      }
      if (added.length || removed.length) {
        this.handlers.devicesChanged(devices, added, removed);
      }
    } catch {
      /* brak daemona audio / tymczasowy błąd — następny tick */
    }
  }

  private async checkPorts(): Promise<void> {
    try {
      const ports = await RadarListener.listPorts();
      const sig = ports.map((p) => p.path).sort().join('|');
      if (sig === this.prevPortSig) return;

      const paths = new Set(ports.map((p) => p.path));
      const added = [...paths].filter((p) => !this.prevPortPaths.has(p));
      const removed = [...this.prevPortPaths].filter((p) => !paths.has(p));
      this.prevPortSig = sig;
      this.prevPortPaths = paths;

      if (!this.portsInitialized) {
        this.portsInitialized = true;
        return;
      }
      if (added.length || removed.length) {
        this.handlers.portsChanged(ports, added, removed);
      }
    } catch {
      /* enumeracja COM zawiodła — następny tick */
    }
  }
}