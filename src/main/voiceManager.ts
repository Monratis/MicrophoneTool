import { spawn, exec, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import readline from 'node:readline';
import { shell } from 'electron';
import AdmZip from 'adm-zip';
import { appendLog } from './logger';
import type { AppContext } from './appContext';
import { resolveBinDir, toggleMuteWithFeedback } from './appContext';
import { showVoiceOsd, hideVoiceOsd } from './voiceOsd';
import { showSettings } from './settingsWindow';
import {
  findBestMatchingRule,
  normalizeText,
  buildVoiceVocabulary,
  buildWhisperInitialPrompt,
  getWakeWordVariations,
  CONFIRMATION_SYNONYMS,
  REJECTION_SYNONYMS,
  stripCorrectionPrefix
} from './voiceMatcher';
import type { VoiceRule, VoiceStatus, VoiceModelType, VoiceEngineType, VoiceWhisperModel, VoiceWhisperBackend } from '../shared/types';

export const VOSK_MODELS: Record<string, { id: VoiceModelType; name: string; url: string; folder: string }> = {
  'pl-small': {
    id: 'pl-small',
    name: 'Polski (Vosk Small PL ~45MB)',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-pl-0.22.zip',
    folder: 'vosk-model-small-pl-0.22'
  },
  'en-small': {
    id: 'en-small',
    name: 'English (Vosk Small EN ~40MB)',
    url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
    folder: 'vosk-model-small-en-us-0.15'
  }
};

export const WHISPER_MODELS: Record<string, { id: VoiceWhisperModel; name: string; url: string; file: string; sizeMb: number }> = {
  'whisper-medium-pl': {
    id: 'whisper-medium-pl',
    name: 'BardsAI Whisper Medium PL (~1.46 GB - Zalecany dla GPU / Studyjna precyzja PL)',
    url: 'https://huggingface.co/knightdave/whisper-polish-ggml-handy/resolve/main/ggml-medium-pl.bin',
    file: 'ggml-medium-pl.bin',
    sizeMb: 1463
  },
  'whisper-small-pl': {
    id: 'whisper-small-pl',
    name: 'BardsAI Whisper Small PL (~465 MB - Zalecany dla CPU / Szybki PL)',
    url: 'https://huggingface.co/knightdave/whisper-polish-ggml-handy/resolve/main/ggml-small-pl.bin',
    file: 'ggml-small-pl.bin',
    sizeMb: 465
  },
  'whisper-base': {
    id: 'whisper-base',
    name: 'OpenAI Whisper Base (~148 MB - Szybki ogólny)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    file: 'ggml-base.bin',
    sizeMb: 148
  },
  'whisper-tiny': {
    id: 'whisper-tiny',
    name: 'OpenAI Whisper Tiny (~77 MB - Najszybszy)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    file: 'ggml-tiny.bin',
    sizeMb: 77
  },
  'whisper-large-turbo': {
    id: 'whisper-large-turbo',
    name: 'OpenAI Whisper Large v3 Turbo (~1.5 GB - Duży model, GPU)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    file: 'ggml-large-v3-turbo.bin',
    sizeMb: 1549
  },
  'whisper-small': {
    id: 'whisper-small',
    name: 'OpenAI Whisper Small (~460 MB - Standardowy ogólny)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    file: 'ggml-small.bin',
    sizeMb: 460
  }
};

export const WHISPER_BACKENDS: Record<VoiceWhisperBackend, {
  id: VoiceWhisperBackend;
  name: string;
  desc: string;
  url: string;
  sizeMb: number;
  tag: string;
}> = {
  'auto': {
    id: 'auto',
    name: '🪄 Automatyczny (Zalecany)',
    desc: 'Wykrywa kartę graficzną i automatycznie dobiera najszybszy backend (NVIDIA CUDA dla RTX/GTX lub OpenBLAS dla CPU)',
    url: '',
    sizeMb: 0,
    tag: 'Auto'
  },
  'cuda12': {
    id: 'cuda12',
    name: '🚀 NVIDIA GPU (CUDA 12.x / Tensor Cores)',
    desc: 'Dla kart NVIDIA GeForce RTX 20/30/40/50 oraz GTX 16xx. Błyskawiczna odpowiedź w ~500ms.',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-cublas-12.4.0-bin-x64.zip',
    sizeMb: 640,
    tag: 'NVIDIA GPU'
  },
  'cuda11': {
    id: 'cuda11',
    name: '🚀 NVIDIA GPU (CUDA 11.8 - Starsze karty)',
    desc: 'Dla starszych kart NVIDIA GeForce GTX 900 / 1000.',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-cublas-11.8.0-bin-x64.zip',
    sizeMb: 257,
    tag: 'NVIDIA Legacy'
  },
  'cpu_blas': {
    id: 'cpu_blas',
    name: '⚡ CPU Wielowątkowy (OpenBLAS + AVX2 / AVX-512)',
    desc: 'Wysoka wydajność na procesorach AMD Ryzen i Intel Core (~20 MB).',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-blas-bin-x64.zip',
    sizeMb: 20,
    tag: 'AMD / Intel CPU'
  },
  'cpu': {
    id: 'cpu',
    name: '🍃 CPU Standard (Lekki pakiet ~8 MB)',
    desc: 'Podstawowy silnik na procesorze, minimalny rozmiar.',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip',
    sizeMb: 8,
    tag: 'Lekki CPU'
  },
  'hip': {
    id: 'hip',
    name: '🔴 AMD GPU (ROCm/HIP — pakiet w przygotowaniu)',
    desc: 'Akceleracja dla kart AMD Radeon RX 6000+ (RDNA2+). Wymaga Windows oraz budowy binarki HIP, której upstream whisper.cpp nie wydaje — pakiet pojawi się w aktualizacji aplikacji.',
    url: '',
    sizeMb: 0,
    tag: 'AMD RDNA2+'
  }
};

const LIBVOSK_URL = 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip';

/** Model Silero VAD — ochrona Whispera przed muzyką/szumem (działa wewnątrz whisper_full) */
const VAD_MODEL_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin';
const VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin';
const VAD_MODEL_MIN_BYTES = 500000;

/** Etykiety działań do powiadomień OSD ("Zrozumiałem — ...") */
const VOICE_ACTION_LABELS: Record<string, string> = {
  switch_desk: 'przełączam na mikrofon biurkowy',
  switch_headset: 'przełączam na słuchawki',
  switch_auto: 'włączam tryb automatyczny (radar)',
  toggle_mute: 'przełączam wyciszenie mikrofonu',
  mute: 'wyciszam mikrofon',
  unmute: 'odciszam mikrofon',
  open_app: 'otwieram aplikację',
  show_commands: 'otwieram listę komend',
  sleep_display: 'usypiam ekrany',
  screensaver: 'włączam wygaszacz',
  snooze: 'wyciszam radar (drzemka)',
  run_app: 'uruchamiam aplikację',
  kill_process: 'zamykam proces',
  shell_cmd: 'wykonuję polecenie',
  open_url: 'otwieram link',
  ha_service: 'wysyłam komendę do Home Assistant'
};

export class VoiceManager {
  private appContext: AppContext;
  private proc: ChildProcess | null = null;
  private isListeningForCommand = false;
  private listeningTimer: NodeJS.Timeout | null = null;
  private cancelDownloadFlag = false;
  private detectedGpu = '';
  private hasNvidia = false;
  /** Czy sterownik NVIDIA (nvcuda.dll) jest faktycznie zainstalowany */
  private nvidiaDriverOk = false;
  private gpuVendor: 'nvidia' | 'amd' | 'intel' | 'other' = 'other';
  /** Po nieudanej inicjalizacji CUDA w locie — auto wymusza backend CPU */
  private preferCpuFallback = false;

  private status: VoiceStatus = {
    enabled: false,
    running: false,
    state: 'idle',
    engine: 'whisper',
    backend: 'auto',
    modelReady: false,
    modelType: 'whisper-small-pl'
  };

  /** Oczekujące potwierdzenie intencji użytkownika ("Czy chodziło Ci o [Reguła]?") */
  private pendingConfirmation: {
    rule: VoiceRule;
    spokenPhrase: string;
    expiresAt: number;
  } | null = null;

  private isIntentionalStop = false;

  constructor(appContext: AppContext) {
    this.appContext = appContext;
    void this.detectGpuHardwareAsync();
  }

  detectGpuHardwareAsync(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Wykrycie GPU + faktyczna obecność sterownika NVIDIA (nvcuda.dll).
      // CUDA nie wymaga instalacji CUDA Toolkit — pakiety cublas z whisper.cpp
      // mają wbudowany runtime (cudart/cublas/nvrtc); wystarczy sterownik karty.
      const cmd = `powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"`;
      exec(cmd, (err, stdout) => {
        const gpus: string[] = [];
        if (!err && stdout) {
          const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          for (const l of lines) {
            if (l) gpus.push(l);
          }
        }

        // Sprawdzenie obecności sterownika NVIDIA w systemie (nvcuda.dll w System32 lub SysWOW64)
        const sys32Cuda = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvcuda.dll');
        const sysWowCuda = path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'nvcuda.dll');
        const nvDriver = fs.existsSync(sys32Cuda) || fs.existsSync(sysWowCuda);

        this.detectedGpu = gpus.join(' + ');
        this.hasNvidia = gpus.some((g) => /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(g));
        this.nvidiaDriverOk = nvDriver;
        this.status.gpus = gpus;

        // NVIDIA ma priorytet: dyskretna karta RTX/GTX wygrywa z iGPU AMD/Intel
        // (np. Ryzen + RTX 4080) — auto ma zawsze celować w dedykowane GPU.
        if (this.hasNvidia) this.gpuVendor = 'nvidia';
        else if (gpus.some((g) => /radeon|amd|ati/i.test(g))) this.gpuVendor = 'amd';
        else if (gpus.some((g) => /intel|arc/i.test(g))) this.gpuVendor = 'intel';
        else this.gpuVendor = 'other';

        this.status.detectedGpu = this.detectedGpu;
        this.status.gpuVendor = this.gpuVendor;
        this.emitStatus();
        resolve();
      });
    });
  }

  /** Uzasadnienie wyboru backendu dla logów diagnostycznych */
  private backendRationale(): string {
    if (this.gpuVendor === 'nvidia' && !this.nvidiaDriverOk) {
      return 'wykryto GPU NVIDIA, ale bez sterownika (brak nvcuda.dll) → CPU';
    }
    if (this.gpuVendor === 'amd' || this.gpuVendor === 'intel') {
      return `${this.gpuVendor.toUpperCase()} nie ma backendu GPU w whisper.cpp (brak buildów Vulkan/HIP) → CPU OpenBLAS`;
    }
    return 'auto';
  }

  /**
   * Czy wybrany backend CUDA jest właściwy dla wykrytej karty:
   * GTX 900/1000 (Maxwell/Pascal) → CUDA 11; RTX / GTX 16xx i nowsze → CUDA 12.
   */
  private isCuda12Compatible(): boolean {
    const gpu = this.detectedGpu.toLowerCase();
    // GTX 9xx (Maxwell) i 10xx (Pascal) → starszy pakiet CUDA 11; GTX 16xx i RTX → CUDA 12
    return !/\b(gtx|geforce gtx)\s*(9\d\d|10\d\d)\b/.test(gpu);
  }

  /** RTX 50xx (Blackwell, sm_120) wymaga cuBLAS 12.8+ — upstream nie wydaje takiego buildu */
  private isBlackwellGpu(): boolean {
    return /\brtx\s*50\d\d\b/i.test(this.detectedGpu);
  }

  private get toolsDir(): string {
    return path.join(this.appContext.appDataDir, 'tools');
  }

  private get voskDir(): string {
    return path.join(this.toolsDir, 'vosk');
  }

  private get libvoskDllPath(): string {
    return path.join(this.voskDir, 'libvosk.dll');
  }

  private get voskModelsDir(): string {
    return path.join(this.voskDir, 'models');
  }

  private get whisperDir(): string {
    return path.join(this.toolsDir, 'whisper');
  }

  get whisperVadPath(): string {
    return path.join(this.whisperDir, 'vad', VAD_MODEL_FILE);
  }

  get whisperBackendsDir(): string {
    return path.join(this.whisperDir, 'backends');
  }

  resolveBackend(target?: VoiceWhisperBackend): 'cuda12' | 'cuda11' | 'cpu_blas' | 'cpu' | 'hip' {
    const b = target || this.appContext.config.get('voiceWhisperBackend') || 'auto';
    if (b === 'auto') {
      if (this.preferCpuFallback) return 'cpu_blas';
      // CUDA tylko gdy jest GPU NVIDIA I działa sterownik — inaczej CPU (AMD/Intel/bez driv).
      // HIP nie jest jeszcze wybierany automatycznie (brak wydanej binarki — świadomy wybór użytkownika).
      if (this.hasNvidia && this.nvidiaDriverOk) {
        if (this.isBlackwellGpu()) return 'cpu_blas'; // brak buildów cuBLAS 12.8+
        return this.isCuda12Compatible() ? 'cuda12' : 'cuda11';
      }
      return 'cpu_blas';
    }
    return b;
  }

  getWhisperCliPath(backend?: VoiceWhisperBackend): string {
    const resolved = this.resolveBackend(backend);

    // 1. Sprawdź dedykowany folder wybranego backendu
    const cand1 = path.join(this.whisperBackendsDir, resolved, 'Release', 'whisper-cli.exe');
    if (fs.existsSync(cand1)) return cand1;

    const cand2 = path.join(this.whisperBackendsDir, resolved, 'whisper-cli.exe');
    if (fs.existsSync(cand2)) return cand2;

    // 2. Sprawdź legacy katalog Release w tools/whisper/
    const legacy1 = path.join(this.whisperDir, 'Release', 'whisper-cli.exe');
    if (fs.existsSync(legacy1)) return legacy1;

    const legacy2 = path.join(this.whisperDir, 'whisper-cli.exe');
    if (fs.existsSync(legacy2)) return legacy2;

    return cand1;
  }

  isBackendInstalled(backend: VoiceWhisperBackend): boolean {
    const resolved = this.resolveBackend(backend);
    const cli = this.getWhisperCliPath(resolved);
    if (!fs.existsSync(cli)) return false;

    const dir = path.dirname(cli);
    if (resolved === 'cuda12') {
      return fs.existsSync(path.join(dir, 'ggml-cuda.dll')) || fs.existsSync(path.join(dir, 'cublas64_12.dll'));
    }
    if (resolved === 'cuda11') {
      return fs.existsSync(path.join(dir, 'ggml-cuda.dll')) || fs.existsSync(path.join(dir, 'cublas64_11.dll'));
    }
    return true;
  }

  getInstalledBackends(): Record<string, boolean> {
    return {
      auto: this.isBackendInstalled('auto'),
      cuda12: this.isBackendInstalled('cuda12'),
      cuda11: this.isBackendInstalled('cuda11'),
      cpu_blas: this.isBackendInstalled('cpu_blas'),
      cpu: this.isBackendInstalled('cpu')
    };
  }

  private get whisperModelsDir(): string {
    return path.join(this.whisperDir, 'models');
  }

  private get nativeExePath(): string {
    const binExe = path.join(resolveBinDir(), 'VoiceListener.exe');
    if (fs.existsSync(binExe)) return binExe;
    return path.join(this.toolsDir, 'VoiceListener.exe');
  }

  private readonly requiredVoskDlls = ['libvosk.dll', 'libwinpthread-1.dll', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll'];

  getStatus(): VoiceStatus {
    const engine = this.appContext.config.get('voiceEngine') || 'whisper';
    const backend = this.appContext.config.get('voiceWhisperBackend') || 'auto';
    const modelType = engine === 'whisper'
      ? (this.appContext.config.get('voiceWhisperModel') || 'whisper-small-pl')
      : (this.appContext.config.get('voiceModel') || 'pl-small');

    this.status.enabled = this.appContext.config.get('voiceEnabled') || false;
    this.status.engine = engine;
    this.status.backend = backend;
    this.status.detectedGpu = this.detectedGpu;
    this.status.gpuVendor = this.gpuVendor;
    this.status.modelType = modelType;
    this.status.modelReady = this.isModelReady(engine, modelType, backend);
    this.status.modelPath = this.resolveModelPath(engine, modelType);
    this.status.installedModels = this.getInstalledModels();
    this.status.installedBackends = this.getInstalledBackends();
    return { ...this.status };
  }

  isRunning(): boolean {
    return Boolean(this.status.running && this.proc);
  }

  getInstalledModels(): { whisper: Record<string, boolean>; vosk: Record<string, boolean> } {
    const whisperInstalled: Record<string, boolean> = {};
    for (const [key, info] of Object.entries(WHISPER_MODELS)) {
      const p = path.join(this.whisperModelsDir, info.file);
      if (fs.existsSync(p)) {
        try {
          const stat = fs.statSync(p);
          whisperInstalled[key] = stat.size >= Math.round(info.sizeMb * 0.90 * 1024 * 1024);
        } catch {
          whisperInstalled[key] = false;
        }
      } else {
        whisperInstalled[key] = false;
      }
    }

    const voskInstalled: Record<string, boolean> = {};
    for (const [key, info] of Object.entries(VOSK_MODELS)) {
      const p = path.join(this.voskModelsDir, info.folder);
      voskInstalled[key] = fs.existsSync(p) && (
        fs.existsSync(path.join(p, 'am')) ||
        fs.existsSync(path.join(p, 'final.mdl')) ||
        fs.existsSync(path.join(p, 'conf'))
      );
    }

    return { whisper: whisperInstalled, vosk: voskInstalled };
  }

  private resolveModelPath(engine: VoiceEngineType, modelType: VoiceModelType): string {
    if (modelType === 'custom') {
      return this.appContext.config.get('voiceCustomModelPath') || '';
    }
    if (engine === 'whisper') {
      const info = WHISPER_MODELS[modelType];
      if (!info) return '';
      return path.join(this.whisperModelsDir, info.file);
    } else {
      const info = VOSK_MODELS[modelType];
      if (!info) return '';
      return path.join(this.voskModelsDir, info.folder);
    }
  }

  isModelReady(engine?: VoiceEngineType, targetModel?: VoiceModelType, targetBackend?: VoiceWhisperBackend): boolean {
    const currentEngine = engine || this.appContext.config.get('voiceEngine') || 'whisper';
    const model = targetModel || (currentEngine === 'whisper'
      ? (this.appContext.config.get('voiceWhisperModel') || 'whisper-small-pl')
      : (this.appContext.config.get('voiceModel') || 'pl-small'));

    if (currentEngine === 'whisper') {
      const backend = targetBackend || this.appContext.config.get('voiceWhisperBackend') || 'auto';
      if (!this.isBackendInstalled(backend)) return false;

      const info = WHISPER_MODELS[model as string];
      if (!info) return false;
      const modelPath = path.join(this.whisperModelsDir, info.file);
      if (!fs.existsSync(modelPath)) return false;
      try {
        const stat = fs.statSync(modelPath);
        if (stat.size < Math.round(info.sizeMb * 0.90 * 1024 * 1024)) return false;
      } catch {
        return false;
      }

      // Gdy wymagane jest słowo wywołania, tani spotter Vosk small PL musi być gotowy
      const requireWake = this.appContext.config.get('voiceRequireWakeWord') ?? true;
      if (requireWake && !this.isSpotterReady()) {
        return false;
      }
      return true;
    } else {
      for (const dll of this.requiredVoskDlls) {
        if (!fs.existsSync(path.join(this.voskDir, dll))) return false;
      }
      const modelPath = this.resolveModelPath('vosk', model);
      if (!modelPath || !fs.existsSync(modelPath)) return false;
      return (
        fs.existsSync(path.join(modelPath, 'am')) ||
        fs.existsSync(path.join(modelPath, 'final.mdl')) ||
        fs.existsSync(path.join(modelPath, 'conf')) ||
        fs.existsSync(modelPath)
      );
    }
  }

  /** Czy tani spotter wake-word (libvosk.dll + model Vosk small PL) jest gotowy do użycia */
  isSpotterReady(): boolean {
    if (!this.requiredVoskDlls.every((d) => fs.existsSync(path.join(this.voskDir, d)))) return false;
    const info = VOSK_MODELS['pl-small'];
    if (!info) return false;
    const p = path.join(this.voskModelsDir, info.folder);
    return fs.existsSync(p) && (
      fs.existsSync(path.join(p, 'am')) ||
      fs.existsSync(path.join(p, 'final.mdl')) ||
      fs.existsSync(path.join(p, 'conf'))
    );
  }

  /** Pobiera libvosk.dll + zależności (jeśli brak) — współdzielone przez silnik Vosk i spotter */
  private async downloadVoskLib(): Promise<void> {
    fs.mkdirSync(this.voskDir, { recursive: true });
    const hasAllDlls = this.requiredVoskDlls.every((d) => fs.existsSync(path.join(this.voskDir, d)));
    if (hasAllDlls) return;

    appendLog('VOICE-DL', 'Pobieram biblioteki silnika Vosk (libvosk.dll + zależności)…');
    const tempZip = path.join(this.voskDir, 'libvosk_temp.zip');
    await this.downloadFileWithProgress(LIBVOSK_URL, tempZip, 'Biblioteka Vosk');
    if (this.cancelDownloadFlag) {
      try { fs.unlinkSync(tempZip); } catch {}
      throw new Error('Pobieranie anulowane');
    }

    appendLog('VOICE-DL', 'Rozpakowuję biblioteki DLL Vosk…');
    const zip = new AdmZip(tempZip);
    for (const entry of zip.getEntries()) {
      const lower = entry.entryName.toLowerCase();
      if (lower.endsWith('.dll')) {
        const fileName = path.basename(entry.entryName);
        fs.writeFileSync(path.join(this.voskDir, fileName), entry.getData());
      }
    }
    try { fs.unlinkSync(tempZip); } catch {}
  }

  /** Pobiera model Vosk (jeśli brak) — współdzielone przez silnik Vosk i spotter */
  private async downloadVoskModel(modelKey: keyof typeof VOSK_MODELS): Promise<void> {
    const voskInfo = VOSK_MODELS[modelKey];
    if (!voskInfo) throw new Error(`Nieznany model Vosk: ${String(modelKey)}`);
    fs.mkdirSync(this.voskModelsDir, { recursive: true });

    const targetFolder = path.join(this.voskModelsDir, voskInfo.folder);
    if (fs.existsSync(targetFolder)) return;

    appendLog('VOICE-DL', `Pobieram model mowy ${voskInfo.name}…`);
    const modelZip = path.join(this.voskModelsDir, `${voskInfo.folder}.zip`);
    await this.downloadFileWithProgress(voskInfo.url, modelZip, voskInfo.name);
    if (this.cancelDownloadFlag) {
      try { fs.unlinkSync(modelZip); } catch {}
      throw new Error('Pobieranie anulowane');
    }

    appendLog('VOICE-DL', `Rozpakowuję model ${voskInfo.name}…`);
    const zip = new AdmZip(modelZip);
    zip.extractAllTo(this.voskModelsDir, true);
    try { fs.unlinkSync(modelZip); } catch {}
  }

  async init(): Promise<void> {
    await this.detectGpuHardwareAsync();
    const enabled = this.appContext.config.get('voiceEnabled');
    appendLog('VOICE-BOOT', `Inicjalizacja modułu mowy: voiceEnabled=${enabled}, Wykryto sprzęt: [${this.detectedGpu || 'CPU'}]`);
    if (enabled) {
      const engine = this.appContext.config.get('voiceEngine') || 'whisper';
      const modelType = engine === 'whisper'
        ? (this.appContext.config.get('voiceWhisperModel') || 'whisper-small-pl')
        : (this.appContext.config.get('voiceModel') || 'pl-small');
      const backend = this.appContext.config.get('voiceWhisperBackend') || 'auto';

      if (!this.isModelReady(engine, modelType, backend)) {
        appendLog('VOICE-BOOT', `Włączone sterowanie głosem wymaga pobrania pakietu [${engine}:${modelType}:${backend}] — rozpoczynam pobieranie w tle…`);
        void this.startDownload(engine, modelType as any, backend as any);
      } else if (engine === 'whisper' && (this.appContext.config.get('voiceRequireWakeWord') ?? true) && !this.isSpotterReady()) {
        appendLog('VOICE-BOOT', 'Silnik Whisper gotowy, brakuje taniego spottera wake-word (Vosk small PL) — dosbieram w tle…');
        void this.startDownload(engine, modelType as any, backend as any);
      } else {
        void this.start();
      }
    }
  }

  async start(): Promise<boolean> {
    // Nie przerywaj trwającego pobierania — start podczas downloadu zresetowałby
    // stan 'downloading' i zepsuł pasek postępu w UI.
    if (this.status.state === 'downloading') {
      appendLog('VOICE-WARN', 'Pomijam start nasłuchu — trwa pobieranie komponentów');
      return false;
    }

    this.stop();

    const engine = this.appContext.config.get('voiceEngine') || 'whisper';
    const modelType = engine === 'whisper'
      ? (this.appContext.config.get('voiceWhisperModel') || 'whisper-small-pl')
      : (this.appContext.config.get('voiceModel') || 'pl-small');
    const backend = this.appContext.config.get('voiceWhisperBackend') || 'auto';

    if (!this.isModelReady(engine, modelType, backend)) {
      this.status.modelReady = false;
      this.status.state = 'idle';
      appendLog('VOICE-WARN', `Silnik [${engine}] model [${modelType}] backend [${backend}] nie jest jeszcze pobrany/gotowy`);
      this.emitStatus();
      return false;
    }

    const modelPath = this.resolveModelPath(engine, modelType);
    const exe = await this.ensureExecutable();
    if (!exe) {
      this.status.state = 'error';
      this.status.error = 'Brak pliku VoiceListener.exe';
      this.emitStatus();
      return false;
    }

    // Jednoczesny nasłuch ze wszystkich skonfigurowanych mikrofonów (głównych i zapasowych):
    const deskMic = (this.appContext.config.get('micDeskName') || '').trim();
    const deskFallback = (this.appContext.config.get('micDeskFallbackName') || '').trim();
    const headMic = (this.appContext.config.get('micHeadsetName') || '').trim();
    const headFallback = (this.appContext.config.get('micHeadsetFallbackName') || '').trim();
    const isHeadsetPriority = Boolean(
      this.appContext.controller &&
      (this.appContext.controller.isUserAtDesk() === false || (this.appContext.controller as any).currentDevice === 'headset')
    );
    const deskMics = [deskMic, deskFallback].filter(Boolean);
    const headMics = [headMic, headFallback].filter(Boolean);
    const preferredMic = isHeadsetPriority
      ? [...headMics, ...deskMics].filter((v, i, a) => a.indexOf(v) === i).join('|||')
      : [...deskMics, ...headMics].filter((v, i, a) => a.indexOf(v) === i).join('|||');

    let toolOrDll = engine === 'whisper' ? this.getWhisperCliPath() : this.libvoskDllPath;
    let modeLabel = engine === 'whisper' ? 'CLI (spawn per komenda)' : 'Vosk in-process';
    let spawnCwd: string | undefined;
    if (engine === 'whisper') {
      // Tryb in-process: whisper.dll z pakietu backendu — model ładowany raz,
      // dekodowanie wewnątrz VoiceListener.exe (bez spawnu, bez serwera obok).
      const dllPath = path.join(path.dirname(toolOrDll), 'whisper.dll');
      if (fs.existsSync(dllPath)) {
        toolOrDll = dllPath;
        modeLabel = 'whisper.dll keep-alive (model w pamięci)';
        // ggml szuka DLL-i backendów (ggml-*.dll) w katalogu EXE i w CWD —
        // bez CWD na katalogu backendu: "devices = 0" i GGML_ASSERT przy init
        spawnCwd = path.dirname(dllPath);
      }
    }

    const resolvedBackend = this.resolveBackend();
    const gpuFlag = resolvedBackend === 'cuda12' || resolvedBackend === 'cuda11' || resolvedBackend === 'hip' ? '1' : '0';
    const idleMin = Math.max(0, Math.min(60, Number(this.appContext.config.get('voiceIdleUnloadMin')) || 0));
    // Silero VAD — ścieżka do modelu (whisper); pusty = bez VAD
    const vadPath = engine === 'whisper' && fs.existsSync(this.whisperVadPath) ? this.whisperVadPath : '';
    // Słownik komend jako bias dekodera: whisper=initial_prompt (naturalne zdania PL), vosk=gramatyka JSON (twarda)
    const vocabBias = this.appContext.config.get('voiceVocabBias') !== false;
    const rules = this.appContext.config.get('voiceRules') || [];
    const wakeWord = this.appContext.config.get('voiceWakeWord') || 'ok';
    const vocab = buildVoiceVocabulary(rules, wakeWord);
    const whisperPrompt = buildWhisperInitialPrompt(rules, wakeWord);
    const promptText = vocabBias ? whisperPrompt : '';
    const grammarJson = vocabBias ? JSON.stringify(vocab) : '';
    const args = [engine, modelPath, toolOrDll, preferredMic, 'pl', gpuFlag, String(idleMin), vadPath, engine === 'vosk' ? grammarJson : promptText];
    // Tani spotter wake-word (Vosk small PL) — tylko dla Whispera z wymaganym słowem wywołania.
    // Odciąża GPU/CPU: Whisper dekoduje wyłącznie komendy wypowiedziane po słowie wywołania.
    let spotterEnabled = false;
    if (engine === 'whisper' && (this.appContext.config.get('voiceRequireWakeWord') ?? true)) {
      if (this.isSpotterReady()) {
        args.push(this.libvoskDllPath, path.join(this.voskModelsDir, VOSK_MODELS['pl-small'].folder));
        spotterEnabled = true;
      } else {
        appendLog('VOICE-WARN', 'Tani spotter wake-word (Vosk small PL) niedostępny — Whisper uruchomi się na każdej wypowiedzi (bez filtra)');
        this.appContext.pushEvent('toast', { message: '🎙️ Brak modelu Vosk small — Whisper działa bez taniego filtra wake-word (pobierz w ustawieniach mowy).', error: false });
      }
    }
    appendLog('VOICE-VOCAB', `Słownik komend dla dekodera: ${vocab.length} fraz / prompt Whisper: "${whisperPrompt.substring(0, 120)}..."${vocabBias ? '' : ' (WYŁĄCZONY bias słownika)'}`);
    appendLog('VOICE-VOCAB', vocabBias ? `${engine === 'vosk' ? 'Gramatyka' : 'Prompt'}: ${engine === 'vosk' ? vocab.join(', ').substring(0, 300) : whisperPrompt.substring(0, 300)}${promptText.length > 300 ? '…' : ''}` : 'Używany domyślny prompt Whisper / bez gramatyki Vosk');

    const micSummary = deskMic && headMic
      ? `Dual-mic jednoczesny (${deskMic} + ${headMic})`
      : (deskMic || headMic || 'Domyślny mikrofon Windows');

    appendLog('VOICE-START', `Uruchamiam nasłuch (Silnik: ${engine.toUpperCase()}, Model: ${modelType}, Backend: ${resolvedBackend.toUpperCase()} [${this.detectedGpu || 'CPU'}], Źródła: ${micSummary})`);
    appendLog('VOICE-INFO', `Wybór backendu: ${this.backendRationale()}`);
    appendLog('VOICE-INFO', `Tryb silnika: ${modeLabel}`);
    appendLog('VOICE-INFO', `Ścieżka silnika Whisper: ${toolOrDll}`);
    if (spotterEnabled) appendLog('VOICE-INFO', 'Tani spotter wake-word: Vosk small PL — Whisper dekoduje tylko po słowie wywołania');

    try {
      this.proc = spawn(exe, args, {
        cwd: spawnCwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.status.running = true;
      this.status.state = 'loading';
      this.status.engine = engine;
      this.status.backend = backend;
      this.status.modelReady = true;
      this.status.modelType = modelType;
      this.status.modelPath = modelPath;
      this.status.error = undefined;

      const rl = readline.createInterface({ input: this.proc.stdout! });
      rl.on('line', (line) => this.handleProcessOutput(line));

      const rlErr = readline.createInterface({ input: this.proc.stderr! });
      rlErr.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            const errObj = JSON.parse(trimmed);
            if (errObj.error) {
              appendLog('VOICE-ERR', `Błąd VoiceListener: ${errObj.error}`);
            }
            if (errObj.event === 'backend_failed') {
              const detail = typeof errObj.detail === 'string' ? errObj.detail : '';
              appendLog('VOICE-ERR', `Backend Whisper zawiódł: ${detail}`);
              void this.autoFallbackBackend();
            }
          } catch {
            if (!trimmed.startsWith('whisper_vad') && !trimmed.startsWith('ggml_') && !trimmed.startsWith('whisper_init')) {
              appendLog('VOICE-DEBUG', trimmed);
            }
          }
        }
      });

      this.proc.on('error', (err) => {
        appendLog('VOICE-ERR', `Awaria procesu mowy: ${err.message}`);
        this.status.running = false;
        this.status.state = 'error';
        this.status.error = err.message;
        this.emitStatus();
      });

      this.proc.on('exit', (code, signal) => {
        appendLog('VOICE-EXIT', `Proces VoiceListener zakończony (kod: ${code}, sygnał: ${signal})`);
        this.status.running = false;
        if (this.status.state !== 'downloading') {
          this.status.state = 'idle';
        }
        this.proc = null;
        this.emitStatus();

        // Watchdog: automatyczne wznowienie TYLKO przy nieoczekiwanym wyjściu (np. awaria)
        if (!this.isIntentionalStop && this.appContext.config.get('voiceEnabled') && !this.cancelDownloadFlag) {
          const st = this.status.state as VoiceStatus['state'];
          if (st !== 'downloading' && st !== 'error') {
            setTimeout(() => {
              const st2 = this.status.state as VoiceStatus['state'];
              if (!this.isIntentionalStop && this.appContext.config.get('voiceEnabled') && !this.proc && st2 !== 'downloading' && st2 !== 'error') {
                appendLog('VOICE-WATCHDOG', 'Automatyczne wznowienie procesu nasłuchu mowy…');
                void this.start();
              }
            }, 1500);
          }
        }
      });

      this.isIntentionalStop = false;
      this.emitStatus();
      return true;
    } catch (err) {
      appendLog('VOICE-ERR', `Nie udało się wystartować VoiceListener: ${(err as Error).message}`);
      this.status.running = false;
      this.status.state = 'error';
      this.status.error = (err as Error).message;
      this.emitStatus();
      return false;
    }
  }

  stop(): void {
    this.isIntentionalStop = true;
    if (this.listeningTimer) {
      clearTimeout(this.listeningTimer);
      this.listeningTimer = null;
    }
    this.isListeningForCommand = false;

    if (this.proc) {
      try {
        if (this.proc.stdin && !this.proc.stdin.destroyed) {
          this.proc.stdin.write('quit\n');
        }
        this.proc.kill('SIGTERM');
      } catch {}
      this.proc = null;
    }

    this.status.running = false;
    this.status.modelLoaded = false;
    if (this.status.state !== 'downloading') {
      this.status.state = 'idle';
    }
    this.emitStatus();
  }

  async restart(): Promise<boolean> {
    this.stop();
    await new Promise((r) => setTimeout(r, 200));
    return this.start();
  }

  /** Informuje działający VoiceListener.exe o zmianie aktywnego profilu mikrofonu */
  onDeviceSwitched(newDevice: 'desk' | 'headset'): void {
    const deskMic = (this.appContext.config.get('micDeskName') || '').trim();
    const deskFallback = (this.appContext.config.get('micDeskFallbackName') || '').trim();
    const headMic = (this.appContext.config.get('micHeadsetName') || '').trim();
    const headFallback = (this.appContext.config.get('micHeadsetFallbackName') || '').trim();
    const deskMics = [deskMic, deskFallback].filter(Boolean);
    const headMics = [headMic, headFallback].filter(Boolean);
    const preferredMic = newDevice === 'headset'
      ? [...headMics, ...deskMics].filter((v, i, a) => a.indexOf(v) === i).join('|||')
      : [...deskMics, ...headMics].filter((v, i, a) => a.indexOf(v) === i).join('|||');
    if (!preferredMic) return;

    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.write(`device ${preferredMic}\n`);
      } catch {}
    }
  }

  /** Czy trwa pobieranie modelu/backendu (nie restartować wtedy silnika) */
  isDownloading(): boolean {
    return this.status.state === 'downloading';
  }

  /** Resetuje wymuszony fallback CPU — gdy użytkownik jawnie wybierze GPU */
  resetCpuFallback(): void {
    this.preferCpuFallback = false;
  }

  /** Aktualizuje urządzenia wejściowe nasłuchu na żywo (bez restartu modelu) */
  updateDevices(preferred?: string): void {
    const deskMic = (this.appContext.config.get('micDeskName') || '').trim();
    const deskFallback = (this.appContext.config.get('micDeskFallbackName') || '').trim();
    const headMic = (this.appContext.config.get('micHeadsetName') || '').trim();
    const headFallback = (this.appContext.config.get('micHeadsetFallbackName') || '').trim();
    const allMics = [deskMic, deskFallback, headMic, headFallback].filter(Boolean);
    const dev = preferred !== undefined ? preferred : [...new Set(allMics)].join('|||');
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.write(`device ${dev}\n`);
      } catch {}
    }
  }

  setPreferredDevice(deviceName: string): void {
    this.updateDevices(deviceName);
  }

  /** Zmiana czasu bezczynności przed zwolnieniem modelu (na żywo, bez restartu) */
  setVoiceIdleUnload(minutes: number): void {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try {
        const m = Math.max(0, Math.min(60, Math.round(minutes) || 0));
        this.proc.stdin.write(`idle ${m}\n`);
      } catch {}
    }
  }

  /**
   * Aktualizuje bias słownika dekodera na żywo (bez restartu silnika) po zmianie
   * reguł głosowych / słowa wywołania / przełącznika biasu. Whisper: nowy initial_prompt,
   * Vosk: przebudowa rozpoznawacza z nową gramatyką.
   */
  updateVocabulary(): void {
    const engine = this.status.engine || this.appContext.config.get('voiceEngine') || 'whisper';
    const vocabBias = this.appContext.config.get('voiceVocabBias') !== false;
    const rules = this.appContext.config.get('voiceRules') || [];
    const wakeWord = this.appContext.config.get('voiceWakeWord') || 'ok';
    const vocab = buildVoiceVocabulary(rules, wakeWord);
    const whisperPrompt = buildWhisperInitialPrompt(rules, wakeWord);
    const prompt = engine === 'vosk'
      ? (vocabBias ? JSON.stringify(vocab) : '')
      : (vocabBias ? whisperPrompt : '');

    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.write(`prompt ${prompt}\n`);
        appendLog('VOICE-VOCAB', `Zaktualizowano słownik dekodera na żywo (${vocab.length} fraz${vocabBias ? '' : ', bias wyłączony'})`);
      } catch (err) {
        appendLog('VOICE-ERR', `Nie udało się zaktualizować słownika: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Auto-heal: gdy silnik Whisper nie wystartował na CUDA (np. brak drivera lub
   * za stara karta), przełącz na CPU (OpenBLAS) i zrestartuj nasłuch.
   */
  private async autoFallbackBackend(): Promise<void> {
    const cfgBackend = this.appContext.config.get('voiceWhisperBackend') || 'auto';
    const resolved = this.resolveBackend();
    if (resolved === 'cpu_blas' || resolved === 'cpu') {
      // Już na CPU — dalsze próby restartu to pętla; zatrzymaj watchdog do ręcznej interwencji
      this.status.state = 'error';
      this.status.error = 'Silnik Whisper nie działa na wybranym backendzie (sprawdź dziennik)';
      appendLog('VOICE-ERR', 'Silnik Whisper zawiódł także na CPU — nasłuch zatrzymany (wymagana interwencja użytkownika)');
      this.emitStatus();
      return;
    }

    if (!this.isBackendInstalled('cpu_blas')) {
      appendLog('VOICE-WARN', 'CUDA nie działa, a pakiet CPU (OpenBLAS) nie jest pobrany — pobierz go w ustawieniach mowy');
      this.appContext.pushEvent('toast', { message: '🎙️ CUDA Whisper nie wystartował. Pobierz backend CPU (OpenBLAS) w ustawieniach mowy.', error: true });
      this.status.state = 'error';
      this.status.error = 'Backend CUDA zawiódł; brak pobranego pakietu CPU';
      this.emitStatus();
      return;
    }

    appendLog('VOICE-WARN', `CUDA nie działa — automatyczny fallback na backend CPU (OpenBLAS). Backend w configu: ${cfgBackend}`);
    if (cfgBackend === 'auto') {
      this.preferCpuFallback = true;
    } else {
      this.appContext.config.set('voiceWhisperBackend', 'cpu_blas');
    }
    this.appContext.pushEvent('toast', { message: '🎙️ Whisper nie wystartował na GPU — przełączono na CPU (OpenBLAS).' });
    await this.restart();
  }

  private isLiveTestActive = false;

  setLiveTestMode(active: boolean): void {
    this.isLiveTestActive = active;
    if (active && !this.status.running) {
      void this.start();
    } else if (!active && !this.appContext.config.get('voiceEnabled')) {
      this.stop();
    }
  }

  private handleProcessOutput(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.ready) {
        const info = parsed.systemInfo ? ` | ${parsed.systemInfo}` : '';
        this.status.modelLoaded = true;
        this.status.state = 'idle';
        appendLog('VOICE-READY', `Silnik mowy gotowy do nasłuchu [${parsed.engine || 'native'}, tryb: ${parsed.mode || '?'}]${info}`);
        this.emitStatus();
        return;
      }

      if (parsed.event === 'model_unloaded') {
        this.status.modelLoaded = false;
        appendLog('VOICE-INFO', 'Model Whisper zwolniony z pamięci (bezczynność) — załaduję przy następnej komendzie');
        this.emitStatus();
        return;
      }

      if (parsed.event === 'model_loaded') {
        this.status.modelLoaded = true;
        appendLog('VOICE-INFO', 'Model Whisper załadowany do pamięci');
        if (!this.isListeningForCommand) {
          this.status.state = 'idle';
          showVoiceOsd('Moduł mowy gotowy', 'info', 2200, 'DeskSense · Mowa');
        }
        this.appContext.pushEvent('voice:modelLoaded', {});
        this.emitStatus();
        return;
      }

      if (parsed.event === 'model_loading') {
        if (!this.isListeningForCommand) {
          this.status.state = 'loading';
          showVoiceOsd('Ładowanie modelu mowy…', 'loading', 2500, 'DeskSense · Mowa');
        }
        this.appContext.pushEvent('voice:modelLoading', {});
        this.emitStatus();
        return;
      }

      if (parsed.event === 'audio_level') {
        const rms = typeof parsed.rms === 'number' ? parsed.rms : 0;
        const db = typeof parsed.db === 'number' ? parsed.db : -60;
        const level = typeof parsed.level === 'number' ? parsed.level : 0;
        const device = typeof parsed.device === 'string' ? parsed.device : 'Mikrofon';
        const vad = parsed.vad && typeof parsed.vad === 'object' ? {
          speech: Boolean((parsed.vad as Record<string, unknown>).speech),
          prob: typeof (parsed.vad as Record<string, unknown>).prob === 'number' ? (parsed.vad as Record<string, unknown>).prob as number : Number((parsed.vad as Record<string, unknown>).prob) || 0
        } : undefined;

        this.status.audioLevel = { rms, db, level, device, vad };
        this.appContext.pushEvent('voice:audioLevel', {
          rms,
          db,
          level,
          device,
          vad
        });
        return;
      }

      if (parsed.event === 'partial' && parsed.data && parsed.data.partial) {
        if (parsed.spotter) return; // spotter wake-word — nie pokazuj częściowych w UI (prywatność/śmieci)
        const partialText = parsed.data.partial.trim();
        this.appContext.pushEvent('voice:partial', {
          text: partialText
        });
        return;
      }

      if (parsed.event === 'result' && parsed.data) {
        const rawText = (parsed.data.text || '').trim();
        const engine = this.appContext.config.get('voiceEngine') || 'whisper';
        const modelType = engine === 'whisper'
          ? (this.appContext.config.get('voiceWhisperModel') || 'whisper-small-pl')
          : (this.appContext.config.get('voiceModel') || 'pl-small');
        const resolvedBackend = engine === 'whisper' ? this.resolveBackend() : 'native';
        const dur = typeof parsed.data.durationMs === 'number' ? ` [${parsed.data.durationMs}ms]` : '';
        const gpu = parsed.data.gpuInfo ? ` (${parsed.data.gpuInfo})` : '';
        const recognizerLabel = engine === 'whisper'
          ? `Whisper ${modelType} [${resolvedBackend.toUpperCase()}]`
          : `Vosk ${modelType}`;

        if (!rawText) {
          if (this.isListeningForCommand) {
            appendLog('VOICE-RAW', `${recognizerLabel}${dur}${gpu}: (brak rozpoznanego tekstu / cisza)`);
          }
          return;
        }

        if (parsed.spotter) {
          // Wynik taniego spottera (Vosk small PL) — wyłącznie wykrywanie wake-word.
          // Gdy już nasłuchujemy komendy, transkrypcję robi Whisper — pomijamy spotter,
          // żeby uniknąć podwójnego wykonania tej samej akcji.
          if (this.isListeningForCommand) return;
          const spotterLabel = 'Spotter Vosk small PL';
          appendLog('VOICE-SPOTTER', `[${spotterLabel}] "${rawText}"`);
          this.processRecognizedPhrase(rawText, spotterLabel);
          return;
        }

        appendLog('VOICE-RAW', `${recognizerLabel}${dur}${gpu}: "${rawText}"`);
        this.processRecognizedPhrase(rawText, recognizerLabel);
      }

      if (parsed.event === 'backend_failed') {
        const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
        appendLog('VOICE-ERR', `Backend Whisper zawiódł przy inicjalizacji: ${detail}`);
        void this.autoFallbackBackend();
      }

      if (parsed.event === 'grammar_unsupported') {
        const detail = typeof parsed.detail === 'string' ? parsed.detail : 'Model Vosk nie wspiera gramatyki';
        appendLog('VOICE-WARN', detail);
        this.appContext.pushEvent('toast', { message: `🎙️ ${detail}.`, error: false });
      }
    } catch {
      // Ignorujemy nie-JSON
    }
  }

  private processRecognizedPhrase(text: string, recognizerInfo?: string): void {
    const rawText = text.trim();
    if (!rawText) return;

    // Jedna ścieżka normalizacji (interpunkcja + diakrytyki) — wspólna z voiceMatcher
    const normalized = normalizeText(rawText);

    // Filtr typowych halucynacji ciszy i napisów końcowych modeli Whisper w języku polskim
    const WHISPER_SILENCE_HALLUCINATIONS = [
      'dziekuje', 'dziekuje.', 'dziekuje bardzo', 'dziekuje za uwage', 'dziekuje za ogladanie',
      'dziekuje za wysluchanie', 'dziekuje za obejrzenie', 'dzieki za ogladanie',
      'subskrybuj', 'subskrybujcie', 'subskrybuj kanal', 'zostaw suba', 'lajkuj', 'zostaw lapke',
      'napisy', 'napisy stworzone', 'tlumaczenie', 'transkrypcja', 'muzyka', 'brawa', 'oklaski',
      'do widzenia', 'do zobaczenia', 'milego dnia', 'dobrej nocy',
      'czesc i czolem', 'dziekuje ze jestescie', 'dziekuje bardzo panstwu', 'dziekuje panstwu'
    ];

    if (normalized.length <= 1 || WHISPER_SILENCE_HALLUCINATIONS.some((h) => normalized === h || normalized.startsWith(`${h} `) || normalized.endsWith(` ${h}`))) {
      appendLog('VOICE-FILTER', `Odrzucono halucynację ciszy/napisów Whispera: "${rawText}"`);
      return;
    }

    const configuredWake = (this.appContext.config.get('voiceWakeWord') || 'ok').toLowerCase().trim();
    const sourceTag = recognizerInfo ? `[${recognizerInfo}] ` : '';

    appendLog('VOICE-INPUT', `${sourceTag}Rozpoznano mowę: "${rawText}" (znormalizowano: "${normalized}")`);
    this.status.lastPhrase = rawText;
    this.emitStatus();

    const rules = this.appContext.config.get('voiceRules') || [];
    const previewMatch = findBestMatchingRule(normalized, rules);

    this.appContext.pushEvent('voice:recognized', {
      text: rawText,
      engine: recognizerInfo,
      isListening: this.isListeningForCommand,
      isLiveTest: this.isLiveTestActive,
      matchedRule: previewMatch ? {
        name: previewMatch.rule.name,
        confidence: Math.round(previewMatch.confidence * 100),
        actionType: previewMatch.rule.actionType
      } : undefined
    });

    if (this.isLiveTestActive) {
      return;
    }

    // Obsługa aktywnego pytania o potwierdzenie ("Czy chodziło Ci o [Nazwa]?")
    if (this.pendingConfirmation && Date.now() <= this.pendingConfirmation.expiresAt) {
      const candidate = this.pendingConfirmation;
      const cleanSpoken = stripCorrectionPrefix(normalized);

      // 1. Potwierdzenie: "tak", "no", "jasne", "dokładnie", "potwierdzam", "yep", "yes", "dawaj"
      const isAffirmative = CONFIRMATION_SYNONYMS.includes(normalized) ||
        normalized.startsWith('tak ') || normalized.endsWith(' tak') || normalized === 'no';

      if (isAffirmative) {
        this.pendingConfirmation = null;
        appendLog('VOICE-CONFIRM', `✅ Użytkownik potwierdził („${rawText}”) zamiar wykonania reguły [${candidate.rule.name}]`);
        this.executeMatchedRule(candidate.rule, candidate.spokenPhrase, 1.0, 'user_confirmed');
        return;
      }

      // 2. Zaprzeczenie: "nie", "nie nie", "anuluj", "błąd", "stop"
      const isNegative = REJECTION_SYNONYMS.includes(normalized) ||
        (normalized.startsWith('nie ') && !normalized.includes('chodzilo') && !normalized.includes('mialem'));

      if (isNegative && !normalized.includes('chodzilo') && !normalized.includes('mialem')) {
        this.pendingConfirmation = null;
        appendLog('VOICE-CONFIRM', `❌ Użytkownik odrzucił („${rawText}”) propozycję wykonania reguły [${candidate.rule.name}]`);
        showVoiceOsd('Anulowano — słucham nowej komendy…', 'info', 5500, 'DeskSense · Gotowy');
        this.resetListeningTimer(5500);
        return;
      }

      // 3. Korekta użytkownika (np. "nie, chodziło mi o wycisz mikrofon" lub inna nowa komenda)
      this.pendingConfirmation = null;
      appendLog('VOICE-CONFIRM', `🔄 Użytkownik podał nową/skorygowaną komendę: "${cleanSpoken}"`);
      this.matchAndExecuteRule(cleanSpoken);
      return;
    }

    const requireWakeWord = this.appContext.config.get('voiceRequireWakeWord') ?? true;

    if (!requireWakeWord) {
      // Tryb bezpośredni — wykonaj komendę od razu bez słowa wywołania
      this.matchAndExecuteRule(normalized);
      return;
    }

    // Obsługa słów wywołania (domyślnych lub zdefiniowanych przez użytkownika)
    const wakeVariations = getWakeWordVariations(configuredWake);

    let remaining = normalized;
    let hasWakeWord = false;

    // Usuwaj wielokrotne / powtarzające się słowa wywołania z początku (np. "ok ok", "hej hej", "o ok")
    while (remaining.length > 0) {
      let matchedInLoop: string | null = null;
      let matchedEnd = -1;

      for (const w of wakeVariations) {
        if (remaining === w) {
          matchedInLoop = w;
          matchedEnd = remaining.length;
          break;
        }
        if (remaining.startsWith(`${w} `)) {
          matchedInLoop = w;
          matchedEnd = w.length;
          break;
        }
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp(`^${escaped}(\\s+|$)`);
        const m = rx.exec(remaining);
        if (m) {
          matchedInLoop = w;
          matchedEnd = m[0].length;
          break;
        }
      }

      if (matchedInLoop) {
        hasWakeWord = true;
        remaining = remaining.substring(matchedEnd).trim();
      } else {
        break;
      }
    }

    // 1. Wypowiedziano wyłącznie słowo/słowa wywołania (np. "ok", "ok ok", "Jarvis")
    if (hasWakeWord && remaining.length === 0) {
      if (!this.isListeningForCommand) {
        this.triggerWakeState();
      } else {
        // Jeśli już nasłuchujemy i padło znowu słowo wywołania, odśwież licznik 5.5s
        if (this.listeningTimer) clearTimeout(this.listeningTimer);
        this.listeningTimer = setTimeout(() => {
          this.isListeningForCommand = false;
          this.status.state = 'idle';
          hideVoiceOsd();
          this.appContext.pushEvent('voice:listening_timeout', {});
          if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
            try { this.proc.stdin.write('state idle\n'); } catch {}
          }
          this.appContext.radar?.stopVoiceListeningAnimation(false);
          this.emitStatus();
        }, 5500);
      }
      return;
    }

    // 2. Wypowiedziano słowo wywołania razem z komendą w jednym ciągu (np. "ok wycisz mikrofon", "ok ok otwórz")
    if (hasWakeWord && remaining.length > 0) {
      this.matchAndExecuteRule(remaining);
      return;
    }

    // 3. Jesteśmy w aktywnym oknie wybudzenia (po wcześniejszym słowie wywołania lub skrócie klawiszowym)
    if (this.isListeningForCommand) {
      this.matchAndExecuteRule(normalized);
      return;
    }

    // 4. Bezpośrednie wywołanie otwarcia aplikacji ("otwórz", "pokaż apkę") lub listy komend ("pokaż listę komend", "lista komend")
    const directMatch = findBestMatchingRule(normalized, rules);
    if (
      directMatch &&
      directMatch.confidence >= 0.88 &&
      (directMatch.rule.actionType === 'open_app' || directMatch.rule.actionType === 'show_commands')
    ) {
      this.matchAndExecuteRule(normalized);
      return;
    }
  }

  resetListeningTimer(durationMs: number = 5500): void {
    this.isListeningForCommand = true;
    this.status.state = 'listening';
    this.appContext.radar?.startVoiceListeningAnimation();

    if (this.listeningTimer) clearTimeout(this.listeningTimer);
    this.listeningTimer = setTimeout(() => {
      this.isListeningForCommand = false;
      this.pendingConfirmation = null;
      this.status.state = 'idle';
      hideVoiceOsd();
      this.appContext.pushEvent('voice:listening_timeout', {});
      if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
        try { this.proc.stdin.write('state idle\n'); } catch {}
      }
      this.appContext.radar?.stopVoiceListeningAnimation(false);
      this.emitStatus();
    }, durationMs);

    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      try { this.proc.stdin.write('state listening\n'); } catch {}
    }
    this.emitStatus();
  }

  triggerWakeState(source: 'wake_word' | 'hotkey' | 'manual' = 'wake_word'): void {
    const isHotkey = source === 'hotkey';
    const isManual = source === 'manual';
    const logMsg = isHotkey
      ? '⌨️ Wyzwolono nasłuch komendy skrótem klawiszowym (Hotkey) — nasłuchuję przez 5.5s'
      : isManual
        ? '🖱️ Wyzwolono nasłuch komendy ręcznie — nasłuchuję przez 5.5s'
        : '💡 Wykryto słowo wywołania (Wake Word) — nasłuchuję komendy przez 5.5s';
    appendLog('VOICE-WAKE', logMsg);
    this.pendingConfirmation = null;
    this.appContext.pushEvent('voice:listening', { durationMs: 5500, source });
    showVoiceOsd('Słucham komendy…', 'listen', 5500);

    if (this.appContext.config.get('voiceChimeFeedback')) {
      this.appContext.pushEvent('voice:playChime', { chimeType: 'wake' });
    }

    this.resetListeningTimer(5500);
  }

  private matchAndExecuteRule(spokenPhrase: string): void {
    const cleanedPhrase = stripCorrectionPrefix(spokenPhrase);
    const rules = this.appContext.config.get('voiceRules') || [];
    const match = findBestMatchingRule(cleanedPhrase, rules);

    if (!match) {
      appendLog('VOICE-MISS', `Nie dopasowano żadnej akcji do frazy: "${cleanedPhrase}"`);
      if (this.isListeningForCommand) {
        this.appContext.pushEvent('voice:miss', { text: cleanedPhrase });
        this.resetListeningTimer(5500);
        showVoiceOsd(`Nie rozpoznano: „${cleanedPhrase}” — powtórz proszę`, 'miss', 5500, 'DeskSense · Słucham ponownie');
        if (this.appContext.config.get('voiceChimeFeedback')) {
          this.appContext.pushEvent('voice:playChime', { chimeType: 'miss' });
        }
      }
      return;
    }

    // Jeśli pewność dopasowania jest w strefie niepewności (0.58 .. 0.84), zapytaj użytkownika!
    if (match.confidence < 0.85 && this.isListeningForCommand) {
      this.pendingConfirmation = {
        rule: match.rule,
        spokenPhrase: cleanedPhrase,
        expiresAt: Date.now() + 6500
      };
      appendLog('VOICE-CONFIRM', `🤔 Niejednoznaczne dopasowanie (${Math.round(match.confidence * 100)}% via ${match.matchedBy}) do [${match.rule.name}] dla: "${cleanedPhrase}" — pytam użytkownika o potwierdzenie`);
      this.appContext.pushEvent('voice:confirm_prompt', {
        candidateRule: match.rule.name,
        spokenPhrase: cleanedPhrase,
        confidence: Math.round(match.confidence * 100)
      });
      this.resetListeningTimer(6500);
      showVoiceOsd(`Czy chodziło Ci o: „${match.rule.name}”?`, 'listen', 6500, `Usłyszano: „${cleanedPhrase}” · Odpowiedz: Tak / Nie`);
      if (this.appContext.config.get('voiceChimeFeedback')) {
        this.appContext.pushEvent('voice:playChime', { chimeType: 'wake' });
      }
      return;
    }

    this.executeMatchedRule(match.rule, cleanedPhrase, match.confidence, match.matchedBy);
  }

  private executeMatchedRule(matchedRule: VoiceRule, spokenPhrase: string, confidence?: number, matchedBy?: string): void {
    appendLog('VOICE-MATCH', `🎯 Wykonuję regułę [${matchedRule.name}] (${confidence ? Math.round(confidence * 100) + '% via ' + matchedBy : 'potwierdzono'}) dla mowy: "${spokenPhrase}"`);

    // Sprawdź warunek obecności przy biurku
    const onlyAtDesk = this.appContext.config.get('voiceOnlyAtDesk') ?? true;
    if (onlyAtDesk) {
      const isAtDesk = this.appContext.controller.isUserAtDesk();
      if (!isAtDesk) {
        appendLog('VOICE-BLOCKED', `Zablokowano wykonanie [${matchedRule.name}] — użytkownik poza biurkiem (wymóg: Obecność DESK)`);
        this.appContext.pushEvent('voice:blocked', { name: matchedRule.name });
        showVoiceOsd(`Zablokowano „${matchedRule.name}” — jesteś poza biurkiem`, 'blocked', 3500);
        if (this.listeningTimer) clearTimeout(this.listeningTimer);
        this.isListeningForCommand = false;
        this.pendingConfirmation = null;
        this.status.state = 'idle';
        this.appContext.radar?.stopVoiceListeningAnimation(false);
        this.emitStatus();
        return;
      }
    }

    if (this.listeningTimer) clearTimeout(this.listeningTimer);
    this.isListeningForCommand = false;
    this.pendingConfirmation = null;
    this.status.state = 'idle';
    this.status.lastAction = matchedRule.name;
    this.status.lastTime = Date.now();
    this.appContext.radar?.stopVoiceListeningAnimation(true);
    this.emitStatus();

    let actionDetail = VOICE_ACTION_LABELS[matchedRule.actionType] || matchedRule.name;
    if (matchedRule.actionType === 'ha_service' && matchedRule.actionPayload) {
      try {
        const parsed = JSON.parse(matchedRule.actionPayload);
        const entity = parsed.entity_id || parsed.target || matchedRule.actionPayload;
        const srv = parsed.service || 'akcja';
        const domain = String(entity).split('.')[0] || '';
        if (domain === 'automation') {
          actionDetail = `Home Assistant (Wyzwolenie automatyzacji -> ${entity})`;
        } else if (domain === 'script') {
          actionDetail = `Home Assistant (Uruchomienie skryptu -> ${entity})`;
        } else if (domain === 'scene') {
          actionDetail = `Home Assistant (Aktywacja sceny -> ${entity})`;
        } else {
          actionDetail = `Home Assistant (${srv} -> ${entity})`;
        }
      } catch {
        actionDetail = `Home Assistant (${matchedRule.actionPayload})`;
      }
    } else if (matchedRule.actionType === 'run_app' && matchedRule.actionPayload) {
      const appBase = path.basename(matchedRule.actionPayload);
      actionDetail = `Uruchomienie: ${appBase}`;
    }

    appendLog('VOICE-EXEC', `🚀 Zrozumiałem: [${matchedRule.name}] -> Wykonuję: ${actionDetail} (z frazy: "${spokenPhrase}")`);

    const feedbackText = `${matchedRule.name} (${actionDetail})`;
    this.appContext.pushEvent('voice:understood', {
      name: matchedRule.name,
      phrase: spokenPhrase,
      actionLabel: feedbackText
    });
    showVoiceOsd(feedbackText, 'ok', 3600, `Usłyszano: „${spokenPhrase}”`);

    if (this.appContext.config.get('voiceChimeFeedback')) {
      this.appContext.pushEvent('voice:playChime', { chimeType: 'action' });
    }

    void this.executeAction(matchedRule);
  }

  async executeAction(rule: VoiceRule): Promise<{ ok: boolean; message?: string }> {
    try {
      const payload = (rule.actionPayload || '').trim();

      switch (rule.actionType) {
        case 'switch_desk': {
          // setMode -> applyDevice() sam przełącza domyślny mikrofon oraz robi
          // pełną sekwencję profilu (odciszenie, głośność, Discord). Bezpośrednie
          // setDefaultRecordingDevice() tutaj powodowało podwójne przełączenie
          // i wyścig (dwa razy "Aktywowano..." + redundantny skip).
          this.appContext.controller.setMode('desk');
          return { ok: true, message: `Przełączono na mikrofon biurkowy: "${this.appContext.config.get('micDeskName') || 'domyślny'}"` };
        }

        case 'switch_headset': {
          this.appContext.controller.setMode('headset');
          return { ok: true, message: `Przełączono na słuchawki: "${this.appContext.config.get('micHeadsetName') || 'domyślny'}"` };
        }

        case 'switch_auto': {
          this.appContext.controller.setMode('auto');
          return { ok: true, message: 'Włączono tryb automatyczny (Radar)' };
        }

        case 'toggle_mute': {
          const res = await toggleMuteWithFeedback(this.appContext);
          return { ok: true, message: res.isMuted ? 'Wyciszono mikrofon' : 'Odciszono mikrofon' };
        }

        case 'mute': {
          // Przez kontroler (nie surowe audio.setMute) — żeby zadziałał fallback
          // głośność-0% dla urządzeń bez węzła mute (BlackShark Chat), zapisał
          // intencję użytkownika (userMuted) i zsynchronizował parę + Discord.
          const target =
            this.appContext.controller.currentDevice === 'desk'
              ? this.appContext.config.get('micDeskName')
              : this.appContext.config.get('micHeadsetName');
          const res = await this.appContext.controller.setDeviceMute(target || '', true);
          if (res.ok) {
            this.appContext.radar.updateLed('mute');
            this.appContext.pushEvent('toast', { message: 'Mikrofon wyciszony 🔇' });
            showVoiceOsd('Mikrofon wyciszony', 'mute', 2000);
          }
          this.appContext.refreshSnapshot();
          return { ok: res.ok, message: res.ok ? 'Wyciszono mikrofon' : 'Nie udało się wyciszyć mikrofonu' };
        }

        case 'unmute': {
          const target =
            this.appContext.controller.currentDevice === 'desk'
              ? this.appContext.config.get('micDeskName')
              : this.appContext.config.get('micHeadsetName');
          const res = await this.appContext.controller.setDeviceMute(target || '', false);
          if (res.ok) {
            this.appContext.radar.updateLed(this.appContext.controller.currentDevice || 'desk');
            this.appContext.pushEvent('toast', { message: 'Mikrofon aktywny 🎙️' });
            showVoiceOsd('Mikrofon aktywny', 'unmute', 2000);
          }
          this.appContext.refreshSnapshot();
          return { ok: res.ok, message: res.ok ? 'Odciszono mikrofon' : 'Nie udało się odciszyć mikrofonu' };
        }

        case 'open_app': {
          showSettings(this.appContext, true);
          return { ok: true, message: 'Otwarto okno aplikacji przy kursorze' };
        }

        case 'show_commands': {
          showSettings(this.appContext, true, 'voice');
          return { ok: true, message: 'Otwarto listę komend głosowych' };
        }

        case 'sleep_display': {
          this.appContext.screen.sleepDisplays();
          return { ok: true, message: 'Wysłano sygnał uśpienia monitorów' };
        }

        case 'screensaver': {
          this.appContext.screen.showScreensaver();
          return { ok: true, message: 'Włączono wygaszacz ekranu' };
        }

        case 'snooze': {
          const duration = parseInt(payload || '15', 10) || 15;
          this.appContext.controller.setSnooze(duration);
          return { ok: true, message: `Wyciszono radar (Snooze) na ${duration} min` };
        }

        case 'run_app': {
          if (!payload) return { ok: false, message: 'Brak ścieżki do aplikacji' };
          await shell.openPath(payload);
          return { ok: true, message: `Uruchomiono aplikację: ${payload}` };
        }

        case 'kill_process': {
          if (!payload) return { ok: false, message: 'Brak nazwy procesu' };
          const procName = payload.replace(/\.exe$/i, '');
          await new Promise<void>((resolve, reject) => {
            exec(`taskkill /F /IM "${procName}.exe"`, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          return { ok: true, message: `Zakończono proces: ${procName}.exe` };
        }

        case 'shell_cmd': {
          if (!payload) return { ok: false, message: 'Brak polecenia' };
          await new Promise<void>((resolve, reject) => {
            exec(payload, { windowsHide: true, timeout: 30000 }, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          return { ok: true, message: `Wykonano polecenie: ${payload}` };
        }

        case 'open_url': {
          if (!payload) return { ok: false, message: 'Brak adresu URL' };
          await shell.openExternal(payload);
          return { ok: true, message: `Otwarto URL: ${payload}` };
        }

        case 'ha_service': {
          if (!payload) return { ok: false, message: 'Brak encji Home Assistant' };
          const res = await this.appContext.ha.callService(payload);
          return { ok: res.ok, message: res.message || `Wywołano usługę HA dla ${payload}` };
        }

        default:
          return { ok: false, message: `Nieznany typ akcji: ${rule.actionType}` };
      }
    } catch (err) {
      appendLog('VOICE-ERR', `Błąd wykonywania akcji [${rule.name}]: ${(err as Error).message}`);
      return { ok: false, message: (err as Error).message };
    }
  }

  // ---------- Pobieranie Modeli i Narzędzi (Whisper / Vosk) ----------

  async startDownload(engineOverride?: VoiceEngineType, targetModel?: VoiceModelType, targetBackend?: VoiceWhisperBackend): Promise<{ ok: boolean; message?: string }> {
    const engine = engineOverride || this.appContext.config.get('voiceEngine') || 'whisper';
    const backend = targetBackend || this.appContext.config.get('voiceWhisperBackend') || 'auto';
    const modelType = targetModel || (engine === 'whisper'
      ? (this.appContext.config.get('voiceWhisperModel') || 'whisper-small-pl')
      : (this.appContext.config.get('voiceModel') || 'pl-small'));

    if (modelType === 'custom') {
      return { ok: true, message: 'Dla własnego modelu wskaż folder na dysku' };
    }

    if (this.status.state === 'downloading') {
      return { ok: false, message: 'Pobieranie już trwa' };
    }

    this.cancelDownloadFlag = false;
    this.status.state = 'downloading';
    this.status.downloadProgress = { percent: 0, transferred: 0, total: 0 };
    this.emitStatus();

    try {
      if (engine === 'whisper') {
        const whisperInfo = WHISPER_MODELS[modelType];
        if (!whisperInfo) {
          throw new Error(`Nieznany model Whisper: ${modelType}`);
        }

        const resolvedBackend = this.resolveBackend(backend);
        const backendInfo = WHISPER_BACKENDS[resolvedBackend] || WHISPER_BACKENDS['cpu_blas'];
        if (!backendInfo.url) {
          this.status.state = 'idle';
          this.emitStatus();
          return { ok: false, message: backendInfo.id === 'hip' ? 'Pakiet AMD (ROCm/HIP) nie jest jeszcze wydany — używaj CPU OpenBLAS (wybór Automatyczny)' : 'Brak źródła pobierania dla tego backendu' };
        }

        fs.mkdirSync(this.whisperDir, { recursive: true });
        fs.mkdirSync(this.whisperBackendsDir, { recursive: true });
        fs.mkdirSync(this.whisperModelsDir, { recursive: true });

        const targetBackendDir = path.join(this.whisperBackendsDir, resolvedBackend);

        // 1. Sprawdź i pobierz brakujący backend (CUDA / OpenBLAS / CPU)
        if (!this.isBackendInstalled(resolvedBackend)) {
          appendLog('VOICE-DL', `Pobieram pakiet wykonawczy Whisper: ${backendInfo.name} (${backendInfo.sizeMb} MB)…`);
          const tempZip = path.join(this.whisperDir, `whisper_${resolvedBackend}_temp.zip`);
          await this.downloadFileWithProgress(backendInfo.url, tempZip, backendInfo.name);

          if (this.cancelDownloadFlag) {
            try { fs.unlinkSync(tempZip); } catch {}
            this.status.state = 'idle';
            this.emitStatus();
            return { ok: false, message: 'Pobieranie anulowane' };
          }

          appendLog('VOICE-DL', `Rozpakowuję ${backendInfo.name}…`);
          fs.mkdirSync(targetBackendDir, { recursive: true });
          const zip = new AdmZip(tempZip);
          zip.extractAllTo(targetBackendDir, true);
          try { fs.unlinkSync(tempZip); } catch {}
        }

        // 2. Sprawdź i pobierz brakujący model sieci neuronowej
        const targetModelFile = path.join(this.whisperModelsDir, whisperInfo.file);
        const expectedMinBytes = Math.round(whisperInfo.sizeMb * 0.90 * 1024 * 1024);
        if (!fs.existsSync(targetModelFile) || fs.statSync(targetModelFile).size < expectedMinBytes) {
          appendLog('VOICE-DL', `Pobieram model sieci neuronowej ${whisperInfo.name} (${whisperInfo.sizeMb} MB)…`);
          await this.downloadFileWithProgress(whisperInfo.url, targetModelFile, whisperInfo.name);

          if (this.cancelDownloadFlag) {
            try { fs.unlinkSync(targetModelFile); } catch {}
            this.status.state = 'idle';
            this.emitStatus();
            return { ok: false, message: 'Pobieranie anulowane' };
          }
        }

        // 3. Pobierz model Silero VAD (ochrona przed muzyką) — mały, ~0.9 MB
        const vadFile = this.whisperVadPath;
        if (!fs.existsSync(vadFile) || fs.statSync(vadFile).size < VAD_MODEL_MIN_BYTES) {
          fs.mkdirSync(path.dirname(vadFile), { recursive: true });
          appendLog('VOICE-DL', 'Pobieram model Silero VAD (ochrona przed muzyką i szumem)…');
          await this.downloadFileWithProgress(VAD_MODEL_URL, vadFile, 'Silero VAD');

          if (this.cancelDownloadFlag) {
            try { fs.unlinkSync(vadFile); } catch {}
            this.status.state = 'idle';
            this.emitStatus();
            return { ok: false, message: 'Pobieranie anulowane' };
          }
        }

        // 4. Tani spotter wake-word (Vosk small PL) — wymagany, gdy słowo wywołania ma
        //    odfiltrować drogie dekodowanie Whispera (inaczej Whisper na każdej wypowiedzi).
        if ((this.appContext.config.get('voiceRequireWakeWord') ?? true) && !this.isSpotterReady()) {
          appendLog('VOICE-DL', 'Pobieram tani spotter wake-word (Vosk small PL + libvosk.dll)…');
          try {
            await this.downloadVoskLib();
            await this.downloadVoskModel('pl-small');
          } catch (err) {
            // Anulowanie rzuca wyjątkiem — przekładamy na czysty stan idle (spójnie z innymi ścieżkami)
            if (this.cancelDownloadFlag) {
              this.status.state = 'idle';
              this.emitStatus();
              return { ok: false, message: 'Pobieranie anulowane' };
            }
            throw err;
          }
        }

        this.status.state = 'idle';
        this.status.modelReady = true;
        this.status.downloadProgress = undefined;
        this.status.installedBackends = this.getInstalledBackends();
        this.status.installedModels = this.getInstalledModels();
        appendLog('VOICE-DL', `Pakiet ${backendInfo.name} + model ${whisperInfo.name} + Silero VAD gotowe do użycia ✓`);
        this.emitStatus();

        if (this.appContext.config.get('voiceEnabled')) {
          void this.start();
        }

        return { ok: true, message: `Pomyślnie przygotowano ${backendInfo.name} oraz ${whisperInfo.name}` };
      } else {
        // Vosk Download
        const voskInfo = VOSK_MODELS[modelType];
        if (!voskInfo) {
          throw new Error(`Nieznany model Vosk: ${modelType}`);
        }

        fs.mkdirSync(this.voskDir, { recursive: true });
        fs.mkdirSync(this.voskModelsDir, { recursive: true });

        const hasAllDlls = this.requiredVoskDlls.every((d) => fs.existsSync(path.join(this.voskDir, d)));
        if (!hasAllDlls) {
          appendLog('VOICE-DL', 'Pobieram biblioteki silnika Vosk (libvosk.dll + zależności)…');
          const tempZip = path.join(this.voskDir, 'libvosk_temp.zip');
          await this.downloadFileWithProgress(LIBVOSK_URL, tempZip, 'Biblioteka Vosk');

          if (this.cancelDownloadFlag) {
            try { fs.unlinkSync(tempZip); } catch {}
            this.status.state = 'idle';
            this.emitStatus();
            return { ok: false, message: 'Pobieranie anulowane' };
          }

          appendLog('VOICE-DL', 'Rozpakowuję biblioteki DLL Vosk…');
          const zip = new AdmZip(tempZip);
          const entries = zip.getEntries();
          for (const entry of entries) {
            const lower = entry.entryName.toLowerCase();
            if (lower.endsWith('.dll')) {
              const fileName = path.basename(entry.entryName);
              fs.writeFileSync(path.join(this.voskDir, fileName), entry.getData());
            }
          }
          try { fs.unlinkSync(tempZip); } catch {}
        }

        const targetFolder = path.join(this.voskModelsDir, voskInfo.folder);
        if (!fs.existsSync(targetFolder)) {
          appendLog('VOICE-DL', `Pobieram model mowy ${voskInfo.name}…`);
          const modelZip = path.join(this.voskModelsDir, `${voskInfo.folder}.zip`);
          await this.downloadFileWithProgress(voskInfo.url, modelZip, voskInfo.name);

          if (this.cancelDownloadFlag) {
            try { fs.unlinkSync(modelZip); } catch {}
            this.status.state = 'idle';
            this.emitStatus();
            return { ok: false, message: 'Pobieranie anulowane' };
          }

          appendLog('VOICE-DL', `Rozpakowuję model ${voskInfo.name}…`);
          const zip = new AdmZip(modelZip);
          zip.extractAllTo(this.voskModelsDir, true);
          try { fs.unlinkSync(modelZip); } catch {}
        }

        this.status.state = 'idle';
        this.status.modelReady = true;
        this.status.downloadProgress = undefined;
        appendLog('VOICE-DL', `Model ${voskInfo.name} gotowy do użycia ✓`);
        this.emitStatus();

        if (this.appContext.config.get('voiceEnabled')) {
          void this.start();
        }

        return { ok: true, message: `Model ${voskInfo.name} zainstalowany pomyślnie` };
      }
    } catch (err) {
      this.status.state = 'error';
      this.status.error = (err as Error).message;
      appendLog('VOICE-ERR', `Błąd pobierania modelu: ${(err as Error).message}`);
      this.emitStatus();
      return { ok: false, message: (err as Error).message };
    }
  }

  cancelDownload(): boolean {
    if (this.status.state === 'downloading') {
      this.cancelDownloadFlag = true;
      this.status.state = 'idle';
      this.status.downloadProgress = undefined;
      this.emitStatus();
      return true;
    }
    return false;
  }

  /** Usuwa pobrane pliki (model lub pakiet backendu) — zwalnia miejsce na dysku */
  deleteAsset(kind: 'model' | 'backend', key: string): { ok: boolean; message?: string } {
    try {
      // Zatrzymaj silnik, żeby zwolnić ewentualne blokady plików (mmap modelu)
      if (this.status.running) {
        this.stop();
      }

      if (kind === 'backend') {
        const dir = path.join(this.whisperBackendsDir, key);
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        this.status.installedBackends = this.getInstalledBackends();
        this.status.modelReady = this.getStatus().modelReady;
        this.emitStatus();
        return { ok: true, message: `Usunięto pakiet backendu „${key}”` };
      }

      // model
      if (key.startsWith('whisper-')) {
        const info = WHISPER_MODELS[key as string];
        if (info) {
          const p = path.join(this.whisperModelsDir, info.file);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      } else if (key === 'pl-small' || key === 'en-small') {
        const info = VOSK_MODELS[key];
        if (info) {
          const p = path.join(this.voskModelsDir, info.folder);
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
      }

      this.status.modelReady = false;
      this.status.installedModels = this.getInstalledModels();
      this.emitStatus();
      return { ok: true, message: `Usunięto model „${key}”` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private downloadFileWithProgress(url: string, dest: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const makeRequest = (currentUrl: string): void => {
        if (this.cancelDownloadFlag) {
          reject(new Error('Anulowano pobieranie'));
          return;
        }

        https.get(currentUrl, { headers: { 'User-Agent': 'DeskSense-VoiceDownloader/1.0' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
            const redirect = res.headers.location;
            if (redirect) {
              makeRequest(redirect);
              return;
            }
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Serwer zwrócił błąd HTTP ${res.statusCode}`));
            return;
          }

          const total = parseInt(res.headers['content-length'] || '0', 10);
          let transferred = 0;
          let lastTime = Date.now();
          let lastTransferred = 0;
          let speedStr = '';

          const fileStream = fs.createWriteStream(dest);

          res.on('data', (chunk: Buffer) => {
            if (this.cancelDownloadFlag) {
              res.destroy();
              fileStream.close();
              reject(new Error('Anulowano pobieranie'));
              return;
            }

            transferred += chunk.length;
            const now = Date.now();
            if (now - lastTime >= 500) {
              const bytesDiff = transferred - lastTransferred;
              const timeDiff = (now - lastTime) / 1000;
              const speedBps = bytesDiff / timeDiff;
              speedStr = `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`;

              const pct = total > 0 ? Math.round((transferred / total) * 100) : 0;
              const progress = {
                percent: pct,
                transferred,
                total,
                speed: speedStr,
                modelName: label
              };
              this.status.downloadProgress = progress;
              this.emitStatus();
              this.appContext.pushEvent('voice:downloadProgress', { percent: pct, speed: speedStr, transferred, total, modelName: label });

              lastTime = now;
              lastTransferred = transferred;
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });

          fileStream.on('error', (err) => {
            try { fs.unlinkSync(dest); } catch {}
            reject(err);
          });
        }).on('error', (err) => {
          try { fs.unlinkSync(dest); } catch {}
          reject(err);
        });
      };

      makeRequest(url);
    });
  }

  private async ensureExecutable(): Promise<string | null> {
    const exe = this.nativeExePath;
    if (fs.existsSync(exe)) return exe;

    const sourceCs = path.join(__dirname, '..', '..', 'src', 'native', 'VoiceListener.cs');
    if (!fs.existsSync(sourceCs)) return null;

    appendLog('VOICE-BUILD', 'Kompiluję natywny moduł VoiceListener.exe…');
    fs.mkdirSync(this.toolsDir, { recursive: true });

    const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const targetExe = path.join(this.toolsDir, 'VoiceListener.exe');

    return new Promise((resolve) => {
      exec(`"${cscPath}" /nologo /optimize /platform:x64 /out:"${targetExe}" "${sourceCs}"`, (err) => {
        if (err) {
          appendLog('VOICE-ERR', `Kompilacja VoiceListener nie powiodła się: ${err.message}`);
          resolve(null);
        } else {
          appendLog('VOICE-BUILD', 'Skompilowano VoiceListener.exe ✓');
          resolve(targetExe);
        }
      });
    });
  }

  private emitStatus(): void {
    this.appContext.pushEvent('voice:status', { voiceStatus: this.getStatus() });
  }
}
