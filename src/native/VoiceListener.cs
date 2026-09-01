using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DeskSenseVoice
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct WAVEINCAPS
    {
        public ushort wMid;
        public ushort wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint dwFormats;
        public ushort wChannels;
        public ushort wReserved1;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    public static class Program
    {
        private const int WAVE_MAPPER = -1;
        private const int CALLBACK_EVENT = 0x00050000;
        private const uint WHDR_DONE = 0x00000001;

        [DllImport("winmm.dll", CharSet = CharSet.Auto)]
        private static extern int waveInGetNumDevs();

        [DllImport("winmm.dll", CharSet = CharSet.Auto)]
        private static extern int waveInGetDevCaps(IntPtr uDeviceID, out WAVEINCAPS pwic, int cbwic);

        [DllImport("winmm.dll")]
        private static extern int waveInOpen(out IntPtr hWaveIn, int uDeviceID, ref WAVEFORMATEX lpFormat, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);

        [DllImport("winmm.dll")]
        private static extern int waveInPrepareHeader(IntPtr hWaveIn, IntPtr lpWaveHdr, int uSize);

        [DllImport("winmm.dll")]
        private static extern int waveInUnprepareHeader(IntPtr hWaveIn, IntPtr lpWaveHdr, int uSize);

        [DllImport("winmm.dll")]
        private static extern int waveInAddBuffer(IntPtr hWaveIn, IntPtr lpWaveHdr, int uSize);

        [DllImport("winmm.dll")]
        private static extern int waveInStart(IntPtr hWaveIn);

        [DllImport("winmm.dll")]
        private static extern int waveInStop(IntPtr hWaveIn);

        [DllImport("winmm.dll")]
        private static extern int waveInReset(IntPtr hWaveIn);

        [DllImport("winmm.dll")]
        private static extern int waveInClose(IntPtr hWaveIn);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern IntPtr LoadLibrary(string lpFileName);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern bool SetDllDirectory(string lpPathName);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        private static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

        // Native Vosk Delegates
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void vosk_set_log_level_delegate(int level);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr vosk_model_new_delegate(byte[] path);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void vosk_model_free_delegate(IntPtr model);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr vosk_recognizer_new_delegate(IntPtr model, float sampleRate);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr vosk_recognizer_new_grm_delegate(IntPtr model, float sampleRate, byte[] grammar);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void vosk_recognizer_free_delegate(IntPtr recognizer);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int vosk_recognizer_accept_waveform_delegate(IntPtr recognizer, byte[] data, int length);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr vosk_recognizer_result_delegate(IntPtr recognizer);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr vosk_recognizer_partial_result_delegate(IntPtr recognizer);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void vosk_recognizer_reset_delegate(IntPtr recognizer);

        private static vosk_set_log_level_delegate _voskSetLogLevel;
        private static vosk_model_new_delegate _voskModelNew;
        private static vosk_model_free_delegate _voskModelFree;
        private static vosk_recognizer_new_delegate _voskRecognizerNew;
        private static vosk_recognizer_new_grm_delegate _voskRecognizerNewGrm;
        private static vosk_recognizer_free_delegate _voskRecognizerFree;
        private static vosk_recognizer_accept_waveform_delegate _voskRecognizerAcceptWaveform;
        private static vosk_recognizer_result_delegate _voskRecognizerResult;
        private static vosk_recognizer_partial_result_delegate _voskRecognizerPartialResult;
        private static vosk_recognizer_reset_delegate _voskRecognizerReset;

        private static IntPtr _voskDllHandle = IntPtr.Zero;
        private static IntPtr _modelHandle = IntPtr.Zero;
        private static IntPtr _recognizerHandle = IntPtr.Zero;
        private static readonly object _recLock = new object();

        private static volatile bool _running = true;
        private static Thread _captureThread;

        private static string _engineMode = "vosk"; // "vosk" or "whisper"
        private static string _modelPath = "";
        private static string _whisperCliPath = "";
        private static string _whisperDllPath = ""; // ścieżka whisper.dll — tryb in-process keep-alive
        private static string _language = "pl";
        private static string _preferredDevice = "";
        private static string _activeDeviceName = "Domyślny mikrofon Windows";
        private static string _lastPartialText = "";
        private static long _lastAudioLevelTick = 0;
        private static float _gainMultiplier = 3.5f;

        // Multi-Device & Priority State Tracking
        private static readonly object _stateLock = new object();
        private static volatile bool _devicesNeedReload = false;
        private static int _activePriorityChannel = -1; // -1 = idle / none
        private static double _lastActiveSnr = 1.0;
        private static int _activeChannelsCount = 1;
        private static readonly List<AudioCaptureDevice> _activeChannelsList = new List<AudioCaptureDevice>();
        private static int _priorityHangoverMs = 0;

        // VAD State Tracking
        private static volatile bool _isSpeaking = false;

        // Tani spotter wake-word (Vosk small PL) — filtr przed drogim Whisperem.
        // Gdy silnik=whisper i wymagane słowo wywołania, spotter nasłuchuje ciągle,
        // a Whisper uruchamiany jest dopiero w oknie nasłuchu (_listenUntilMs).
        private static string _spotterLibvoskPath = "";
        private static string _spotterModelPath = "";
        private static bool _spotterEnabled = false;
        // volatile: pisane z wątku stdin (state listening), czytane z wątków audio.
        // long na x64 jest atomowy — volatile long niedozwolony w C#; stęchły odczyt o ms jest OK.
        private static long _listenUntilMs = 0;
        private static volatile bool _utteranceInListenWindow = false;

        // Whisper Audio Buffer
        private static readonly MemoryStream _whisperBuffer = new MemoryStream();
        private static readonly object _bufferLock = new object();
        private const int PRE_ROLL_COUNT = 8; // 8 x 50ms = 400ms pre-roll (zachowuje pierwszą sylabę)

        public static int Main(string[] args)
        {
            Thread.CurrentThread.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
            Thread.CurrentThread.CurrentUICulture = System.Globalization.CultureInfo.InvariantCulture;
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            if (args.Length < 2)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Usage: VoiceListener.exe [whisper|vosk] <model_path> <libvosk_or_cli_path> [preferred_device] [lang]\"}");
                return 1;
            }

            if (args[0] == "whisper" || args[0] == "vosk")
            {
                _engineMode = args[0];
                _modelPath = args.Length > 1 ? args[1] : "";
                string toolOrDll = args.Length > 2 ? args[2] : "";
                if (args.Length > 3) _preferredDevice = args[3];
                if (args.Length > 4) _language = args[4];
                if (args.Length > 5) _useGpu = args[5] == "1";
                if (args.Length > 6)
                {
                    int idleMin;
                    if (int.TryParse(args[6], out idleMin) && idleMin >= 0 && idleMin <= 60)
                    {
                        _idleUnloadMs = (long)idleMin * 60 * 1000;
                    }
                }
                if (args.Length > 7 && _engineMode == "whisper" && !string.IsNullOrEmpty(args[7]))
                {
                    // Ścieżka do modelu Silero VAD (ggml-silero-*.bin) — ochrona przed muzyką/szumem.
                    // Pusty string = brak modelu VAD (nie włączamy go z pustą ścieżką — whisper_full by się wywalił).
                    _vadModelPtr = AllocUtf8(args[7]);
                }
                if (args.Length > 8)
                {
                    // Bias słownika dekodera z procesu głównego:
                    // whisper — text initial_prompt (pusty = bez promptu, ogólne rozpoznawanie);
                    // vosk — gramatyka JSON (array fraz).
                    _promptText = args[8];
                    if (_engineMode == "vosk") _voskGrammarJson = args[8];
                }
                if (_engineMode == "whisper")
                {
                    // Tani spotter wake-word (Vosk small PL) — args[9] = libvosk.dll, args[10] = katalog modelu.
                    // Brak któregokolwiek pliku = spotter wyłączony (Whisper działa na każdej wypowiedzi, jak dawniej).
                    if (args.Length > 9) _spotterLibvoskPath = args[9];
                    if (args.Length > 10) _spotterModelPath = args[10];
                    _spotterEnabled =
                        !string.IsNullOrEmpty(_spotterLibvoskPath) && File.Exists(_spotterLibvoskPath) &&
                        !string.IsNullOrEmpty(_spotterModelPath) && Directory.Exists(_spotterModelPath);
                }

                if (_engineMode == "whisper")
                {
                    // Tryb in-process keep-alive: whisper.dll ładowany raz, model trzymany w pamięci
                    if (toolOrDll.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                    {
                        _whisperDllPath = toolOrDll;
                    }
                    else
                    {
                        _whisperCliPath = toolOrDll;
                    }

                    if (!string.IsNullOrEmpty(_whisperDllPath) && !File.Exists(_whisperDllPath))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"whisper.dll not found at: " + EscapeJson(_whisperDllPath) + "\"}");
                        return 1;
                    }
                    if (string.IsNullOrEmpty(_whisperDllPath) && !File.Exists(_whisperCliPath))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"whisper-cli.exe not found at: " + EscapeJson(_whisperCliPath) + "\"}");
                        return 1;
                    }
                    if (!File.Exists(_modelPath))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Whisper model file not found at: " + EscapeJson(_modelPath) + "\"}");
                        return 1;
                    }
                }
                else
                {
                    if (!File.Exists(toolOrDll))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"libvosk.dll not found at: " + EscapeJson(toolOrDll) + "\"}");
                        return 1;
                    }
                    if (!Directory.Exists(_modelPath))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Vosk model directory not found at: " + EscapeJson(_modelPath) + "\"}");
                        return 1;
                    }
                    if (!LoadVoskApi(toolOrDll))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Failed to load Vosk functions from DLL\"}");
                        return 1;
                    }
                }
            }
            else
            {
                // Backward compatibility: [modelPath, libvoskPath, preferredDevice]
                _engineMode = "vosk";
                _modelPath = args[0];
                string libvoskPath = args[1];
                if (args.Length > 2) _preferredDevice = args[2];

                if (!File.Exists(libvoskPath) || !Directory.Exists(_modelPath) || !LoadVoskApi(libvoskPath))
                {
                    Console.Error.WriteLine("{\"ok\":false,\"error\":\"Failed to initialize Vosk engine\"}");
                    return 1;
                }
            }

            try
            {
                string readyExtra = "";

                if (_engineMode == "vosk")
                {
                    _voskSetLogLevel(-1);
                    byte[] modelPathUtf8 = Encoding.UTF8.GetBytes(_modelPath + "\0");
                    _modelHandle = _voskModelNew(modelPathUtf8);
                    if (_modelHandle == IntPtr.Zero)
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Failed to initialize Vosk model from path\"}");
                        return 1;
                    }

                    if (!CreateRecognizer(_voskGrammarJson))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Failed to create Vosk recognizer\"}");
                        return 1;
                    }
                }
                else if (_engineMode == "whisper" && !string.IsNullOrEmpty(_whisperDllPath))
                {
                    // Tryb in-process: model Whisper ładowany na żądanie i zwalniany po bezczynności.
                    // Wszystko dzieje się WEWNĄTRZ tego procesu (whisper.dll z pakietu backendu).
                    if (!InitWhisperModel())
                    {
                        Console.Error.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":\"whisper_init_from_file failed — backend/CUDA nie wystartował\"}");
                        return 1;
                    }
                    if (_whisperPrintSystemInfo != null)
                    {
                        string sysInfo = PtrToStringUtf8(_whisperPrintSystemInfo());
                        readyExtra = ",\"systemInfo\":" + EscapeJson(sysInfo);
                    }
                }

                // Tani spotter wake-word (Vosk small PL) — nasłuchuje ciągle, by uruchamiać
                // drogiego Whispera dopiero po wykryciu słowa wywołania. Awaria spottera nie
                // blokuje startu — degradacja do Whispera na każdej wypowiedzi.
                if (_engineMode == "whisper" && _spotterEnabled)
                {
                    if (!LoadVoskApi(_spotterLibvoskPath))
                    {
                        Console.Error.WriteLine("{\"event\":\"warning\",\"message\":\"Spotter Vosk: LoadLibrary(libvosk.dll) nie powiódł się — Whisper bez taniego filtra\"}");
                        _spotterEnabled = false;
                    }
                    else
                    {
                        _voskSetLogLevel(-1);
                        byte[] spotterModelUtf8 = Encoding.UTF8.GetBytes(_spotterModelPath + "\0");
                        _modelHandle = _voskModelNew(spotterModelUtf8);
                        if (_modelHandle == IntPtr.Zero)
                        {
                            Console.Error.WriteLine("{\"event\":\"warning\",\"message\":\"Spotter Vosk: nie udało się załadować modelu — Whisper bez taniego filtra\"}");
                            _spotterEnabled = false;
                        }
                        else if (!CreateRecognizer("")) // pełny słownik small PL (tani, bez gramatyki)
                        {
                            Console.Error.WriteLine("{\"event\":\"warning\",\"message\":\"Spotter Vosk: nie udało się utworzyć rozpoznawacza — Whisper bez taniego filtra\"}");
                            _spotterEnabled = false;
                        }
                    }
                }

                // Start Audio Capture Loop
                _captureThread = new Thread(CaptureLoop)
                {
                    IsBackground = true,
                    Name = "DeskSense_AudioCapture"
                };
                _captureThread.Start();

                Console.WriteLine("{\"ready\":true,\"version\":\"1.5.0\",\"engine\":" + EscapeJson(_engineMode) + ",\"mode\":" + EscapeJson(!string.IsNullOrEmpty(_whisperDllPath) ? "dll-keepalive" : "spawn") + readyExtra + ",\"preferredDevice\":" + EscapeJson(_preferredDevice) + "}");
                Console.Out.Flush();
                _readyAnnounced = true;

                // Process stdin commands
                string line;
                while (_running && (line = Console.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (string.IsNullOrEmpty(line)) continue;

                    if (line.StartsWith("device "))
                    {
                        string dev = line.Substring(7).Trim();
                        _preferredDevice = dev;
                        _devicesNeedReload = true;
                        Console.WriteLine("{\"ok\":true,\"deviceUpdated\":" + EscapeJson(dev) + "}");
                        Console.Out.Flush();
                    }
                    else if (line.StartsWith("state "))
                    {
                        string st = line.Substring(6).Trim();
                        if (st == "listening")
                        {
                            _priorityHangoverMs = 5500;
                            _listenUntilMs = NowMs() + 5500; // okno, w którym Whisper może transkrybować komendę
                            // Wake-word padł W TRAKCIE trwającej wypowiedzi ("ok [komenda]" jednym ciągiem,
                            // a vosk rozdzielił ją na 2 wyniki) — pozwól Whisperowi przetranskrybować bieżące
                            // nagranie, bo inaczej komenda by zginęła (utterance zaczęło się przed oknem).
                            if (_isSpeaking) _utteranceInListenWindow = true;
                            // Pre-load modelu Whisper na wake-word — dzięki temu komenda w oknie
                            // dekoduje bez opóźnienia. Bez tego pierwsza komenda po idle-unload
                            // ładowała model w trakcie mowy i przegrywała wyścig z 4.5s oknem.
                            if (_engineMode == "whisper" && !string.IsNullOrEmpty(_whisperDllPath) && !_modelLoaded)
                            {
                                ThreadPool.QueueUserWorkItem(_ =>
                                {
                                    // Serializacja z decode/unload — unikamy podwójnej inicjalizacji
                                    lock (_whisperExecLock)
                                    {
                                        if (!_modelLoaded) InitWhisperModel();
                                    }
                                });
                            }
                        }
                        Console.WriteLine("{\"ok\":true,\"stateUpdated\":" + EscapeJson(st) + "}");
                        Console.Out.Flush();
                    }
                    else if (line.StartsWith("gain "))
                    {
                        float g;
                        if (float.TryParse(line.Substring(5).Trim().Replace(',', '.'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out g))
                        {
                            if (g > 0.1f && g <= 10.0f) _gainMultiplier = g;
                        }
                        Console.WriteLine("{\"ok\":true,\"gain\":" + _gainMultiplier + "}");
                    }
                    else if (line.StartsWith("prompt "))
                    {
                        // Aktualizacja biasu słownika na żywo (whisper: initial_prompt, vosk: gramatyka JSON)
                        string newPrompt = line.Substring(7).Trim();
                        _promptText = newPrompt;
                        if (_engineMode == "vosk")
                        {
                            _voskGrammarJson = newPrompt;
                            lock (_recLock)
                            {
                                CreateRecognizer(_voskGrammarJson);
                            }
                        }
                        else
                        {
                            if (!string.IsNullOrEmpty(_whisperDllPath))
                            {
                                lock (_whisperExecLock)
                                {
                                    if (_promptUtf8 != IntPtr.Zero) { try { Marshal.FreeHGlobal(_promptUtf8); } catch { } _promptUtf8 = IntPtr.Zero; }
                                    // Pusty prompt = fallback na stały polski kontekst (WHISPER_PL_PROMPT), nie null
                                    _promptUtf8 = string.IsNullOrEmpty(newPrompt) ? AllocUtf8(WHISPER_PL_PROMPT) : AllocUtf8(newPrompt);
                                }
                            }
                        }
                        Console.WriteLine("{\"ok\":true,\"promptUpdated\":true,\"engine\":" + EscapeJson(_engineMode) + "}");
                    }
                    else if (line == "ping")
                    {
                        Console.WriteLine("{\"ok\":true,\"pong\":true,\"engine\":" + EscapeJson(_engineMode) + ",\"activeDevice\":" + EscapeJson(_activeDeviceName) + "}");
                    }
                    else if (line == "reset")
                    {
                        lock (_recLock)
                        {
                            if (_recognizerHandle != IntPtr.Zero && _voskRecognizerReset != null)
                            {
                                _voskRecognizerReset(_recognizerHandle);
                            }
                        }
                        lock (_bufferLock)
                        {
                            _whisperBuffer.SetLength(0);
                        }
                        Console.WriteLine("{\"ok\":true,\"reset\":true}");
                    }
                    else if (line.StartsWith("decode "))
                    {
                        // Komenda testowa/diagnostyczna: dekoduj wskazany plik WAV
                        string wavPath = line.Substring(7).Trim();
                        ThreadPool.QueueUserWorkItem(_ =>
                        {
                            try
                            {
                                byte[] pcm = ReadPcmFromWav(wavPath);
                                if (pcm == null || pcm.Length < 3200)
                                {
                                    Console.WriteLine("{\"ok\":false,\"decode\":\"invalid wav\"}");
                                }
                                else
                                {
                                    ExecuteWhisper(pcm);
                                }
                            }
                            catch (Exception ex)
                            {
                                Console.Error.WriteLine("{\"event\":\"warning\",\"message\":" + EscapeJson("decode failed: " + ex.Message) + "}");
                            }
                        });
                    }
                    else if (line.StartsWith("idle "))
                    {
                        // Zmiana czasu bezczynności przed zwolnieniem modelu (minuty, 0 = nigdy)
                        int idleMin;
                        if (int.TryParse(line.Substring(5).Trim(), out idleMin) && idleMin >= 0 && idleMin <= 60)
                        {
                            _idleUnloadMs = (long)idleMin * 60 * 1000;
                        }
                        Console.WriteLine("{\"ok\":true,\"idleUnloadMs\":" + _idleUnloadMs + "}");
                    }
                    else if (line == "unload")
                    {
                        // Diagnostyka: wymuś zwolnienie modelu (test cyklu idle-unload)
                        ThreadPool.QueueUserWorkItem(_ => UnloadWhisperModel());
                        Console.WriteLine("{\"ok\":true,\"unload\":\"queued\"}");
                    }
                    else if (line == "exit" || line == "quit")
                    {
                        _running = false;
                        break;
                    }
                    Console.Out.Flush();
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":" + EscapeJson(ex.Message) + "}");
                return 1;
            }
            finally
            {
                _running = false;
                lock (_recLock)
                {
                    if (_recognizerHandle != IntPtr.Zero)
                    {
                        _voskRecognizerFree(_recognizerHandle);
                        _recognizerHandle = IntPtr.Zero;
                    }
                    if (_modelHandle != IntPtr.Zero)
                    {
                        _voskModelFree(_modelHandle);
                        _modelHandle = IntPtr.Zero;
                    }
                }
                if (_whisperCtx != IntPtr.Zero && _whisperFree != null)
                {
                    try { _whisperFree(_whisperCtx); } catch { }
                    _whisperCtx = IntPtr.Zero;
                }
            }

            return 0;
        }

        private static bool LoadVoskApi(string dllPath)
        {
            string dir = Path.GetDirectoryName(dllPath);
            if (!string.IsNullOrEmpty(dir))
            {
                SetDllDirectory(dir);
            }

            _voskDllHandle = LoadLibrary(dllPath);
            if (_voskDllHandle == IntPtr.Zero)
            {
                int win32Err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"LoadLibrary failed (Win32Error: " + win32Err + ") for: " + EscapeJson(dllPath) + "\"}");
                return false;
            }

            _voskSetLogLevel = GetDelegate<vosk_set_log_level_delegate>(_voskDllHandle, "vosk_set_log_level");
            _voskModelNew = GetDelegate<vosk_model_new_delegate>(_voskDllHandle, "vosk_model_new");
            _voskModelFree = GetDelegate<vosk_model_free_delegate>(_voskDllHandle, "vosk_model_free");
            _voskRecognizerNew = GetDelegate<vosk_recognizer_new_delegate>(_voskDllHandle, "vosk_recognizer_new");
            _voskRecognizerNewGrm = GetDelegate<vosk_recognizer_new_grm_delegate>(_voskDllHandle, "vosk_recognizer_new_grm");
            _voskRecognizerFree = GetDelegate<vosk_recognizer_free_delegate>(_voskDllHandle, "vosk_recognizer_free");
            _voskRecognizerAcceptWaveform = GetDelegate<vosk_recognizer_accept_waveform_delegate>(_voskDllHandle, "vosk_recognizer_accept_waveform");
            _voskRecognizerResult = GetDelegate<vosk_recognizer_result_delegate>(_voskDllHandle, "vosk_recognizer_result");
            _voskRecognizerPartialResult = GetDelegate<vosk_recognizer_partial_result_delegate>(_voskDllHandle, "vosk_recognizer_partial_result");
            _voskRecognizerReset = GetDelegate<vosk_recognizer_reset_delegate>(_voskDllHandle, "vosk_recognizer_reset");

            return _voskModelNew != null && _voskRecognizerAcceptWaveform != null;
        }

        /// <summary>
        /// Tworzy rozpoznawacza Vosk. Jeśli silnik wspiera vosk_recognizer_new_grm i podano
        /// gramatykę JSON (bias słownika z reguł użytkownika), używa jej — dekodowanie ograniczone
        /// do zadanego słownictwa (dużo mniej pomyłek). Fallback: zwykły rozpoznawacz bez gramatyki.
        /// Gdy gramatyka nie jest wspierana (model HCLG zamiast lookahead, albo brak eksportu),
        /// sygnalizujemy to raz do procesu głównego, żeby użytkownik wiedział o degradacji.
        /// </summary>
        private static bool CreateRecognizer(string grammarJson)
        {
            if (_recognizerHandle != IntPtr.Zero && _voskRecognizerFree != null)
            {
                try { _voskRecognizerFree(_recognizerHandle); } catch { }
                _recognizerHandle = IntPtr.Zero;
            }

            bool grammarRequested = !string.IsNullOrEmpty(grammarJson);

            // Próba gramatyki tylko gdy silnik ją eksportuje i model dotąd jej nie odrzucił.
            if (grammarRequested && _voskRecognizerNewGrm != null && !_grammarUnsupported)
            {
                try
                {
                    byte[] g = Encoding.UTF8.GetBytes(grammarJson + "\0");
                    IntPtr grm = _voskRecognizerNewGrm(_modelHandle, 16000.0f, g);
                    if (grm != IntPtr.Zero)
                    {
                        _recognizerHandle = grm;
                        _grammarUnsupported = false;
                        return true;
                    }
                }
                catch { }
            }

            // Gramatyka żądana, ale nie zastosowana: brak eksportu (stary libvosk) albo model
            // nie wspiera gramatyki (prekompilowany graf HCLG zamiast lookahead). Degradujemy do
            // pełnego słownika i informujemy (raz na proces; reset przy zmianie modelu = nowy proces).
            if (grammarRequested && !_grammarUnsupported)
            {
                _grammarUnsupported = true;
                string reason = _voskRecognizerNewGrm == null
                    ? "Biblioteka libvosk nie eksportuje vosk_recognizer_new_grm — gramatyka komend niedostępna"
                    : "Model Vosk nie wspiera gramatyki (vosk_recognizer_new_grm zwrócił NULL)";
                Console.WriteLine("{\"event\":\"grammar_unsupported\",\"engine\":\"vosk\",\"detail\":" + EscapeJson(reason + " — przełączam na pełne rozpoznawanie słownika") + "}");
                Console.Out.Flush();
            }

            _recognizerHandle = _voskRecognizerNew(_modelHandle, 16000.0f);
            return _recognizerHandle != IntPtr.Zero;
        }

        private static T GetDelegate<T>(IntPtr module, string name) where T : class
        {
            IntPtr proc = GetProcAddress(module, name);
            if (proc == IntPtr.Zero) return null;
            return Marshal.GetDelegateForFunctionPointer(proc, typeof(T)) as T;
        }

        private struct DeviceMatch
        {
            public int DeviceId;
            public string DeviceName;
        }

        private static string NormalizeDevName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "";
            return name.ToLowerInvariant()
                .Replace("(domyślny)", "")
                .Replace("(default)", "")
                .Replace("(", "")
                .Replace(")", "")
                .Replace("-", " ")
                .Replace("_", " ")
                .Trim();
        }

        private static List<DeviceMatch> FindCaptureDevices(string preferredConfig)
        {
            var result = new List<DeviceMatch>();
            int devCount = waveInGetNumDevs();
            if (devCount <= 0)
            {
                result.Add(new DeviceMatch { DeviceId = WAVE_MAPPER, DeviceName = "Domyślny mikrofon Windows" });
                return result;
            }

            var available = new List<KeyValuePair<int, string>>();
            for (int i = 0; i < devCount; i++)
            {
                WAVEINCAPS caps;
                if (waveInGetDevCaps((IntPtr)i, out caps, Marshal.SizeOf(typeof(WAVEINCAPS))) == 0)
                {
                    available.Add(new KeyValuePair<int, string>(i, caps.szPname ?? ("Urządzenie " + i)));
                }
            }

            if (string.IsNullOrEmpty(preferredConfig))
            {
                result.Add(new DeviceMatch { DeviceId = WAVE_MAPPER, DeviceName = "Domyślny mikrofon Windows" });
                return result;
            }

            string[] searchTokens = preferredConfig.Split(new string[] { "|||", "|", ";" }, StringSplitOptions.RemoveEmptyEntries);
            var matchedIds = new HashSet<int>();

            foreach (var token in searchTokens)
            {
                string cleanT = NormalizeDevName(token);
                if (string.IsNullOrEmpty(cleanT)) continue;

                int matchedId = -1;
                string matchedName = null;

                foreach (var dev in available)
                {
                    string cleanD = NormalizeDevName(dev.Value);
                    if (cleanD.Contains(cleanT) || cleanT.Contains(cleanD))
                    {
                        matchedId = dev.Key;
                        matchedName = dev.Value;
                        break;
                    }
                }

                if (matchedId >= 0 && !matchedIds.Contains(matchedId))
                {
                    matchedIds.Add(matchedId);
                    result.Add(new DeviceMatch { DeviceId = matchedId, DeviceName = matchedName });
                }
            }

            if (result.Count == 0)
            {
                result.Add(new DeviceMatch { DeviceId = WAVE_MAPPER, DeviceName = "Domyślny mikrofon Windows" });
            }

            return result;
        }

        private class AudioCaptureDevice : IDisposable
        {
            public int ChannelIndex;
            public int DeviceId;
            public string DeviceName;
            public IntPtr HWaveIn = IntPtr.Zero;
            public AutoResetEvent HEvent;
            public const int BUF_COUNT = 4;
            public const int BUF_SIZE = 1600; // 50ms at 16kHz 16-bit mono
            public IntPtr[] HdrPtrs = new IntPtr[BUF_COUNT];
            public IntPtr[] DataPtrs = new IntPtr[BUF_COUNT];
            public volatile bool IsRunning = false;
            public Thread WorkerThread;

            // Per-channel metrics
            public double NoiseFloor = 80.0;
            public double SpeechProb = 0.0;
            public double LastRms = 0.0;
            public double LastSnr = 1.0;
            public int SilenceDurationMs = 0;
            public int SpeechDurationMs = 0;

            // Per-channel circular pre-roll queue (8 x 50ms = 400ms)
            public readonly Queue<byte[]> PreRollQueue = new Queue<byte[]>();

            public void OpenAndStart(ref WAVEFORMATEX wfx)
            {
                HEvent = new AutoResetEvent(false);
                int res = waveInOpen(out HWaveIn, DeviceId, ref wfx, HEvent.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CALLBACK_EVENT);
                if (res != 0 || HWaveIn == IntPtr.Zero)
                {
                    if (DeviceId != WAVE_MAPPER)
                    {
                        res = waveInOpen(out HWaveIn, WAVE_MAPPER, ref wfx, HEvent.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CALLBACK_EVENT);
                    }
                    if (res != 0 || HWaveIn == IntPtr.Zero)
                    {
                        throw new Exception("waveInOpen failed for device " + DeviceId);
                    }
                }

                for (int i = 0; i < BUF_COUNT; i++)
                {
                    DataPtrs[i] = Marshal.AllocHGlobal(BUF_SIZE);
                    var hdr = new WAVEHDR
                    {
                        lpData = DataPtrs[i],
                        dwBufferLength = BUF_SIZE
                    };
                    HdrPtrs[i] = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
                    Marshal.StructureToPtr(hdr, HdrPtrs[i], false);
                    waveInPrepareHeader(HWaveIn, HdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                    waveInAddBuffer(HWaveIn, HdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                }

                res = waveInStart(HWaveIn);
                if (res != 0)
                {
                    throw new Exception("waveInStart failed for device " + DeviceId);
                }

                IsRunning = true;
                WorkerThread = new Thread(WorkerLoop)
                {
                    IsBackground = true,
                    Name = "Capture_" + DeviceId
                };
                WorkerThread.Start();
            }

            private void WorkerLoop()
            {
                byte[] tempBuf = new byte[BUF_SIZE];
                while (IsRunning && _running && !_devicesNeedReload)
                {
                    bool signaled = false;
                    try
                    {
                        if (HEvent != null) signaled = HEvent.WaitOne(60);
                    }
                    catch (ObjectDisposedException)
                    {
                        break;
                    }
                    catch (Exception)
                    {
                        break;
                    }

                    if (signaled)
                    {
                        for (int i = 0; i < BUF_COUNT; i++)
                        {
                            if (HdrPtrs[i] == IntPtr.Zero) continue;
                            try
                            {
                                var hdr = (WAVEHDR)Marshal.PtrToStructure(HdrPtrs[i], typeof(WAVEHDR));
                                if ((hdr.dwFlags & WHDR_DONE) != 0)
                                {
                                    uint bytes = hdr.dwBytesRecorded;
                                    if (bytes > 0)
                                    {
                                        Marshal.Copy(hdr.lpData, tempBuf, 0, (int)bytes);
                                        OnChannelChunk(this, tempBuf, (int)bytes);
                                    }

                                    hdr.dwBytesRecorded = 0;
                                    hdr.dwFlags &= ~WHDR_DONE;
                                    Marshal.StructureToPtr(hdr, HdrPtrs[i], false);
                                    if (HWaveIn != IntPtr.Zero)
                                    {
                                        waveInAddBuffer(HWaveIn, HdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                                    }
                                }
                            }
                            catch { }
                        }
                    }
                }
            }

            public void Dispose()
            {
                IsRunning = false;
                try { if (HEvent != null) HEvent.Set(); } catch { }
                try { if (WorkerThread != null && WorkerThread.IsAlive) WorkerThread.Join(150); } catch { }
                try
                {
                    if (HWaveIn != IntPtr.Zero)
                    {
                        waveInStop(HWaveIn);
                        waveInReset(HWaveIn);
                        for (int i = 0; i < BUF_COUNT; i++)
                        {
                            if (HdrPtrs[i] != IntPtr.Zero)
                            {
                                waveInUnprepareHeader(HWaveIn, HdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                            }
                        }
                        waveInClose(HWaveIn);
                        HWaveIn = IntPtr.Zero;
                    }
                }
                catch { }

                for (int i = 0; i < BUF_COUNT; i++)
                {
                    if (DataPtrs[i] != IntPtr.Zero)
                    {
                        Marshal.FreeHGlobal(DataPtrs[i]);
                        DataPtrs[i] = IntPtr.Zero;
                    }
                    if (HdrPtrs[i] != IntPtr.Zero)
                    {
                        Marshal.FreeHGlobal(HdrPtrs[i]);
                        HdrPtrs[i] = IntPtr.Zero;
                    }
                }

                try { if (HEvent != null) HEvent.Close(); } catch { }
            }
        }

        private static double ChannelStrength(AudioCaptureDevice ch)
        {
            return ch.SpeechProb * Math.Max(1.0, ch.LastSnr);
        }

        private static void OnChannelChunk(AudioCaptureDevice channel, byte[] rawPcmBuffer, int bytes)
        {
            double sumSq = 0;
            int zcr = 0;
            short prevSample = 0;
            int sampleCount = bytes / 2;
            float gain = _gainMultiplier;
            double maxAbs = 0;

            for (int s = 0; s < bytes; s += 2)
            {
                short orig = (short)(rawPcmBuffer[s] | (rawPcmBuffer[s + 1] << 8));
                double amplified = (double)orig * gain;
                if (amplified > 28000.0)
                {
                    amplified = 28000.0 + (amplified - 28000.0) / (1.0 + (amplified - 28000.0) / 8000.0);
                }
                else if (amplified < -28000.0)
                {
                    amplified = -28000.0 + (amplified + 28000.0) / (1.0 + (-amplified - 28000.0) / 8000.0);
                }
                if (amplified > 32767.0) amplified = 32767.0;
                if (amplified < -32768.0) amplified = -32768.0;
                short boosted = (short)amplified;

                double absVal = Math.Abs((double)boosted);
                if (absVal > maxAbs) maxAbs = absVal;
                sumSq += (double)boosted * boosted;

                if ((prevSample >= 0 && boosted < 0) || (prevSample < 0 && boosted >= 0))
                {
                    zcr++;
                }
                prevSample = boosted;
            }

            double rms = Math.Sqrt(sumSq / sampleCount);
            double crestFactor = maxAbs / Math.Max(1.0, rms);
            if (rms < 32.77)
            {
                rms = 0;
                maxAbs = 0;
                zcr = 0;
                sumSq = 0;
                crestFactor = 0;
            }

            if (rms < channel.NoiseFloor * 1.5)
            {
                channel.NoiseFloor = channel.NoiseFloor * 0.97 + rms * 0.03;
                if (channel.NoiseFloor < 50.0) channel.NoiseFloor = 50.0;
            }

            double snr = rms / Math.Max(35.0, channel.NoiseFloor);
            double zcrNorm = (double)zcr / sampleCount;
            // Spikes i stuki klawiatury charakteryzują się wysokim Crest Factor (ostry pik vs niski RMS) i wysokim ZCR
            bool isClick = crestFactor >= 3.2 || zcrNorm >= 0.38;

            double prob = 0.0;
            if (!isClick && rms >= 160.0 && snr >= 1.6)
            {
                if (zcrNorm >= 0.04 && zcrNorm <= 0.35)
                {
                    prob = Math.Min(1.0, (snr - 1.2) / 2.2);
                }
                else if (channel.SpeechProb >= 0.40 && zcrNorm <= 0.38)
                {
                    prob = 0.70;
                }
            }

            channel.SpeechProb = channel.SpeechProb * 0.35 + prob * 0.65;
            channel.LastRms = rms;
            channel.LastSnr = snr;

            lock (_stateLock)
            {
                // Circular pre-roll per channel
                byte[] copy = new byte[bytes];
                Buffer.BlockCopy(rawPcmBuffer, 0, copy, 0, bytes);
                channel.PreRollQueue.Enqueue(copy);
                while (channel.PreRollQueue.Count > PRE_ROLL_COUNT)
                {
                    channel.PreRollQueue.Dequeue();
                }

                if (channel.SpeechProb >= 0.40)
                {
                    channel.SpeechDurationMs += 50;
                    channel.SilenceDurationMs = 0;

                    if (!_isSpeaking)
                    {
                        // Arbitraż: Lepszy sygnał wygrywa. Gdy oba miki słyszą mowę naraz,
                        // wybieramy mocniejszy (SpeechProb × SNR) zamiast ślepego priorytetu kanału 0.
                        // Dzięki temu komenda do headsetu nie ginie, gdy biurko łapie cichy szum/echo.
                        bool claim;
                        if (channel.ChannelIndex == 0)
                        {
                            claim = true;
                        }
                        else
                        {
                            var ch0 = _activeChannelsList.Count > 0 ? _activeChannelsList[0] : null;
                            claim = ch0 == null || ch0.SpeechProb < 0.35 || ChannelStrength(channel) > ChannelStrength(ch0) * 1.6;
                        }

                        if (claim)
                        {
                            _isSpeaking = true;
                            _activePriorityChannel = channel.ChannelIndex;
                            _lastActiveSnr = channel.LastSnr;
                            _activeDeviceName = channel.DeviceName;
                            _utteranceInListenWindow = NowMs() < _listenUntilMs;

                            if (_engineMode == "whisper")
                            {
                                lock (_bufferLock)
                                {
                                    _whisperBuffer.SetLength(0);
                                    foreach (var pre in channel.PreRollQueue)
                                    {
                                        _whisperBuffer.Write(pre, 0, pre.Length);
                                    }
                                }
                                if (_spotterEnabled)
                                {
                                    foreach (var pre in channel.PreRollQueue)
                                    {
                                        FeedVosk(pre, pre.Length); // spotter słyszy pełne słowo wywołania
                                    }
                                }
                            }
                        }
                    }
                    else if (_isSpeaking && _activePriorityChannel != channel.ChannelIndex)
                    {
                        // Symetryczne przejęcie: wyraźnie mocniejszy kanał przejmuje prowadzenie.
                        // Reset bufora Whisper i recognizera spottera — bez mieszania audio z dwóch kanałów.
                        var active = (_activePriorityChannel >= 0 && _activePriorityChannel < _activeChannelsList.Count)
                            ? _activeChannelsList[_activePriorityChannel] : null;
                        if (active != null && ChannelStrength(channel) > ChannelStrength(active) * 1.8)
                        {
                            _activePriorityChannel = channel.ChannelIndex;
                            _lastActiveSnr = channel.LastSnr;
                            _activeDeviceName = channel.DeviceName;

                            if (_engineMode == "whisper")
                            {
                                lock (_bufferLock)
                                {
                                    _whisperBuffer.SetLength(0);
                                    foreach (var pre in channel.PreRollQueue)
                                    {
                                        _whisperBuffer.Write(pre, 0, pre.Length);
                                    }
                                }
                                if (_spotterEnabled)
                                {
                                    lock (_recLock)
                                    {
                                        if (_recognizerHandle != IntPtr.Zero && _voskRecognizerReset != null)
                                        {
                                            _voskRecognizerReset(_recognizerHandle);
                                        }
                                    }
                                    foreach (var pre in channel.PreRollQueue)
                                    {
                                        FeedVosk(pre, pre.Length);
                                    }
                                }
                            }
                        }
                    }
                }
                else if (channel.SpeechProb < 0.20)
                {
                    channel.SilenceDurationMs += 50;
                    channel.SpeechDurationMs = 0;

                    if (_priorityHangoverMs > 0 && !_isSpeaking)
                    {
                        _priorityHangoverMs -= 50;
                    }

                    if (_isSpeaking && _activePriorityChannel == channel.ChannelIndex && channel.SilenceDurationMs >= 450)
                    {
                        _isSpeaking = false;
                        _activePriorityChannel = -1;

                        if (_engineMode == "whisper")
                        {
                            // Tani filtr: Whisper uruchamiany TYLKO dla wypowiedzi, które ZACZĘŁY SIĘ
                            // w oknie nasłuchu po wake-word (nie transkrybuje samego słowa wywołania).
                            // Bez spottera (_spotterEnabled=false) — stary tryb: Whisper na każdej wypowiedzi.
                            // Pominięcie jest celowe i ciche — log na stderr przy każdej wypowiedzi
                            // (TV/muzyka) groził backpressure na wątku audio i zamrożeniem nasłuchu.
                            bool inListenWindow = !_spotterEnabled || _utteranceInListenWindow || (NowMs() <= _listenUntilMs);
                            byte[] audioChunk = null;
                            lock (_bufferLock)
                            {
                                if (inListenWindow && _whisperBuffer.Length > 0)
                                {
                                    audioChunk = _whisperBuffer.ToArray(); // kopiuj tylko gdy Whisper ma dekodować
                                }
                                _whisperBuffer.SetLength(0);
                            }
                            if (audioChunk != null)
                            {
                                ThreadPool.QueueUserWorkItem((state) => ExecuteWhisper(audioChunk));
                            }
                            if (_spotterEnabled)
                            {
                                ForceFinalizeVosk(); // spłucz wynik spottera (wykrywanie wake-word)
                            }
                        }
                        else
                        {
                            ForceFinalizeVosk();
                        }
                    }
                }

                // Feed recognizer only from the active priority channel
                if (_isSpeaking && _activePriorityChannel == channel.ChannelIndex)
                {
                    _lastActiveSnr = channel.LastSnr;
                    if (_engineMode == "whisper")
                    {
                        lock (_bufferLock)
                        {
                            _whisperBuffer.Write(rawPcmBuffer, 0, bytes);
                            if (_whisperBuffer.Length > 32000 * 10)
                            {
                                _whisperBuffer.SetLength(32000 * 10);
                            }
                        }
                        if (_spotterEnabled)
                        {
                            FeedVosk(rawPcmBuffer, bytes); // tani spotter wake-word
                        }
                    }
                    else
                    {
                        FeedVosk(rawPcmBuffer, bytes);
                    }
                }

                // Idle model unload
                if (_engineMode == "whisper" && _modelLoaded && _idleUnloadMs > 0 && !_isSpeaking &&
                    _lastDecodeTick > 0 && (NowMs() - _lastDecodeTick) > _idleUnloadMs)
                {
                    _lastDecodeTick = NowMs();
                    ThreadPool.QueueUserWorkItem(_ => UnloadWhisperModel());
                }

                // Telemetry
                long now = Environment.TickCount;
                if (now - _lastAudioLevelTick >= 100)
                {
                    _lastAudioLevelTick = now;
                    double teleRms = _isSpeaking ? channel.LastRms : rms;
                    double db = teleRms > 1 ? 20.0 * Math.Log10(teleRms / 32767.0) : -60.0;
                    int levelPct = (int)Math.Min(100, Math.Max(0, (db + 50.0) * 2.0));
                    string rmsStr = Math.Round(teleRms, 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    string dbStr = Math.Round(db, 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    string probStr = Math.Round(channel.SpeechProb * 100.0).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    string devName = _isSpeaking ? channel.DeviceName : (_activeChannelsCount > 1 ? "Dual-Mic (Czuwanie)" : channel.DeviceName);
                    Console.WriteLine("{\"event\":\"audio_level\",\"rms\":" + rmsStr + ",\"db\":" + dbStr + ",\"level\":" + levelPct + ",\"device\":" + EscapeJson(devName) + ",\"vad\":{\"speech\":" + (_isSpeaking ? "true" : "false") + ",\"prob\":" + probStr + "}}");
                    Console.Out.Flush();
                }
            }
        }

        private static void CaptureLoop()
        {
            Thread.CurrentThread.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
            Thread.CurrentThread.CurrentUICulture = System.Globalization.CultureInfo.InvariantCulture;

            while (_running)
            {
                try
                {
                    RunWaveInCapture();
                }
                catch (Exception ex)
                {
                    if (_running)
                    {
                        Console.Error.WriteLine("{\"event\":\"warning\",\"message\":" + EscapeJson("waveIn restart: " + ex.Message) + "}");
                        Thread.Sleep(1000);
                    }
                }
            }
        }

        private static void RunWaveInCapture()
        {
            Thread.CurrentThread.CurrentCulture = System.Globalization.CultureInfo.InvariantCulture;
            Thread.CurrentThread.CurrentUICulture = System.Globalization.CultureInfo.InvariantCulture;

            var wfx = new WAVEFORMATEX
            {
                wFormatTag = 1, // PCM
                nChannels = 1,  // Mono
                nSamplesPerSec = 16000,
                wBitsPerSample = 16,
                nBlockAlign = 2,
                nAvgBytesPerSec = 32000,
                cbSize = 0
            };

            var matchedDevices = FindCaptureDevices(_preferredDevice);
            var channels = new List<AudioCaptureDevice>();

            for (int i = 0; i < matchedDevices.Count; i++)
            {
                var d = matchedDevices[i];
                try
                {
                    var ch = new AudioCaptureDevice { ChannelIndex = i, DeviceId = d.DeviceId, DeviceName = d.DeviceName };
                    ch.OpenAndStart(ref wfx);
                    channels.Add(ch);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("{\"event\":\"warning\",\"message\":" + EscapeJson("Capture device " + d.DeviceName + " error: " + ex.Message) + "}");
                }
            }

            if (channels.Count == 0)
            {
                try
                {
                    var fallback = new AudioCaptureDevice { ChannelIndex = 0, DeviceId = WAVE_MAPPER, DeviceName = "Domyślny mikrofon Windows" };
                    fallback.OpenAndStart(ref wfx);
                    channels.Add(fallback);
                }
                catch
                {
                    Thread.Sleep(1000);
                    return;
                }
            }

            _activeChannelsCount = channels.Count;
            _activeDeviceName = channels.Count > 1 ? "Dual-Mic (Czuwanie)" : channels[0].DeviceName;
            _devicesNeedReload = false;

            lock (_stateLock)
            {
                _activeChannelsList.Clear();
                _activeChannelsList.AddRange(channels);
            }

            try
            {
                while (_running && !_devicesNeedReload)
                {
                    Thread.Sleep(100);
                }
            }
            finally
            {
                lock (_stateLock)
                {
                    _activeChannelsList.Clear();
                }
                foreach (var ch in channels)
                {
                    ch.Dispose();
                }
                channels.Clear();
            }
        }

        private static readonly object _whisperExecLock = new object();

        /// <summary>Wyciąga surowy PCM (chunk "data") z pliku WAV — do testów i diagnostyki</summary>
        private static byte[] ReadPcmFromWav(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read))
            using (var br = new BinaryReader(fs))
            {
                if (fs.Length < 44) return null;
                string riff = Encoding.ASCII.GetString(br.ReadBytes(4));
                if (riff != "RIFF") return null;
                br.ReadBytes(4); // rozmiar
                string wave = Encoding.ASCII.GetString(br.ReadBytes(4));
                if (wave != "WAVE") return null;

                while (fs.Position < fs.Length - 8)
                {
                    string id = Encoding.ASCII.GetString(br.ReadBytes(4));
                    int size = br.ReadInt32();
                    if (size < 0) break;
                    if (id == "data")
                    {
                        return br.ReadBytes(size);
                    }
                    fs.Position += size + (size & 1);
                }
            }
            return null;
        }
private static void ExecuteWhisper(byte[] rawPcm)
        {
            if (rawPcm == null || rawPcm.Length < 4000) return;

            // Delikatne "przygotowanie" audio: czysta normalizacja głośności (peak → ~90%),
            // bez clippingu i bez degradacji jakości (surowy sygnał, tylko skalowanie).
            rawPcm = NormalizePcm16(rawPcm);

            lock (_whisperExecLock)
            {
                // Tryb in-process (model w pamięci; ładowany na żądanie po idle-unload)
                if (!string.IsNullOrEmpty(_whisperDllPath))
                {
                    ExecuteWhisperDll(rawPcm);
                    return;
                }

                string tempWav = Path.Combine(Path.GetTempPath(), "ds_speech_" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".wav");
                try
                {
                    WriteWavFile(tempWav, rawPcm);
                    ExecuteWhisperCli(tempWav);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("{\"event\":\"warning\",\"message\":" + EscapeJson("Whisper execution failed: " + ex.Message) + "}");
                }
                finally
                {
                    try
                    {
                        if (File.Exists(tempWav)) File.Delete(tempWav);
                    }
                    catch { }
                }
            }
        }

        /// <summary>
/// Czysta normalizacja głośności: skaluje szczyt do ~90% pełnej skali, bez clippingu.
/// Nie degraduje jakości — zachowuje pełną dynamikę i częstotliwość (16 kHz/16 bit).
/// Wzmocnienie ograniczone do 6x, by nie podbijać szumu tła.
/// </summary>
private static byte[] NormalizePcm16(byte[] raw)
{
    int n = raw.Length / 2;
    short maxAbs = 0;
    for (int i = 0; i < n; i++)
    {
        short v = (short)(raw[i * 2] | (raw[i * 2 + 1] << 8));
        int a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = (short)a;
    }

    // Cisza lub już blisko celu — zostaw bez zmian
    if (maxAbs < 8) return raw;
    if (maxAbs > 26000 && maxAbs <= 32000) return raw;

    float scale = 29000.0f / maxAbs;
    if (scale > 6.0f) scale = 6.0f;

    byte[] outBuf = new byte[raw.Length];
    for (int i = 0; i < n; i++)
    {
        short v = (short)(raw[i * 2] | (raw[i * 2 + 1] << 8));
        float s = v * scale;
        if (s > 32767.0f) s = 32767.0f;
        if (s < -32768.0f) s = -32768.0f;
        short r = (short)s;
        outBuf[i * 2] = (byte)(r & 0xFF);
        outBuf[i * 2 + 1] = (byte)((r >> 8) & 0xFF);
    }
    return outBuf;
}

private static void WriteWavFile(string path, byte[] rawPcm)
        {
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write(Encoding.ASCII.GetBytes("RIFF"));
                bw.Write(36 + rawPcm.Length);
                bw.Write(Encoding.ASCII.GetBytes("WAVE"));
                bw.Write(Encoding.ASCII.GetBytes("fmt "));
                bw.Write(16);
                bw.Write((short)1); // PCM
                bw.Write((short)1); // Mono
                bw.Write(16000);    // 16kHz
                bw.Write(32000);    // 32kB/s
                bw.Write((short)2); // BlockAlign
                bw.Write((short)16);// BitsPerSample
                bw.Write(Encoding.ASCII.GetBytes("data"));
                bw.Write(rawPcm.Length);
                bw.Write(rawPcm);
            }
        }

        // ------------------------------------------------------------------------
        // Whisper in-process (whisper.dll) — model ładowany raz, dekodowanie bez spawnu.
        // Layout struktur skopiowany 1:1 z whisper.h (tag b4938).
        // ------------------------------------------------------------------------

        [StructLayout(LayoutKind.Sequential)]
        public struct WhisperContextParams
        {
            public byte use_gpu;
            public byte flash_attn;
            // pad 2
            public int gpu_device;
            public byte dtw_token_timestamps;
            // pad 3
            public int dtw_aheads_preset;
            public int dtw_n_top;
            // pad 4 (whisper_aheads wyrównane do 8)
            public UIntPtr dtw_aheads_n_heads;
            public IntPtr dtw_aheads_heads;
            public UIntPtr dtw_mem_size;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WhisperFullParams
        {
            public int strategy;               // 0 = greedy
            public int n_threads;
            public int n_max_text_ctx;
            public int offset_ms;
            public int duration_ms;

            public byte translate;
            public byte no_context;
            public byte no_timestamps;
            public byte single_segment;
            public byte print_special;
            public byte print_progress;
            public byte print_realtime;
            public byte print_timestamps;

            public byte token_timestamps;
            // pad 3
            public float thold_pt;
            public float thold_ptsum;
            public int max_len;
            public byte split_on_word;
            // pad 3
            public int max_tokens;
            public byte debug_mode;
            // pad 3
            public int audio_ctx;
            public byte tdrz_enable;
            // pad 7
            public IntPtr suppress_regex;
            public IntPtr initial_prompt;
            public IntPtr prompt_tokens;
            public int prompt_n_tokens;
            // pad 4
            public IntPtr language;
            public byte detect_language;
            public byte suppress_blank;
            public byte suppress_nst;
            // pad 1
            public float temperature;
            public float max_initial_ts;
            public float length_penalty;
            public float temperature_inc;
            public float entropy_thold;
            public float logprob_thold;
            public float no_speech_thold;

            public int greedy_best_of;

            public int beam_size;
            public float beam_patience;

            public IntPtr new_segment_callback;
            public IntPtr new_segment_callback_user_data;
            public IntPtr progress_callback;
            public IntPtr progress_callback_user_data;
            public IntPtr encoder_begin_callback;
            public IntPtr encoder_begin_callback_user_data;
            public IntPtr abort_callback;
            public IntPtr abort_callback_user_data;
            public IntPtr logits_filter_callback;
            public IntPtr logits_filter_callback_user_data;

            public IntPtr grammar_rules;
            public UIntPtr n_grammar_rules;
            public UIntPtr i_start_rule;
            public float grammar_penalty;

            public byte vad;
            // pad 7
            public IntPtr vad_model_path;

            public float vad_threshold;
            public int vad_min_speech_duration_ms;
            public int vad_min_silence_duration_ms;
            public float vad_max_speech_duration_s;
            public int vad_speech_pad_ms;
            public float vad_samples_overlap;
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_init_from_file_delegate([MarshalAs(UnmanagedType.LPStr)] string path);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_init_from_file_with_params_delegate([MarshalAs(UnmanagedType.LPStr)] string path, IntPtr cparams);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_context_default_params_by_ref_delegate();

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_full_default_params_by_ref_delegate(int strategy);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void whisper_free_params_delegate(IntPtr wparams);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int whisper_full_delegate(IntPtr ctx, IntPtr wparams, IntPtr samples, int n_samples);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int whisper_full_n_segments_delegate(IntPtr ctx);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_full_get_segment_text_delegate(IntPtr ctx, int i);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_print_system_info_delegate();

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void whisper_free_delegate(IntPtr ctx);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void whisper_log_callback(int level, IntPtr text, IntPtr user_data);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void whisper_log_set_delegate(whisper_log_callback log_callback, IntPtr user_data);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void ggml_backend_load_all_delegate();

        private static whisper_log_set_delegate _whisperLogSet;
        private static readonly whisper_log_callback _dummyLogCallback = (level, text, user_data) => {};

        private static whisper_init_from_file_delegate _whisperInitFromFile;
        private static whisper_init_from_file_with_params_delegate _whisperInitFromFileWithParams;
        private static whisper_context_default_params_by_ref_delegate _whisperContextDefaultParamsByRef;
        private static whisper_full_default_params_by_ref_delegate _whisperFullDefaultParamsByRef;
        private static whisper_free_params_delegate _whisperFreeParams;
        private static whisper_full_delegate _whisperFull;
        private static whisper_full_n_segments_delegate _whisperFullNSegments;
        private static whisper_full_get_segment_text_delegate _whisperFullGetSegmentText;
        private static whisper_free_delegate _whisperFree;
        private static whisper_print_system_info_delegate _whisperPrintSystemInfo;
        private static ggml_backend_load_all_delegate _ggmlBackendLoadAll;

        private static IntPtr _whisperCtx = IntPtr.Zero;
        private static bool _whisperLayoutChecked = false;
        private static bool _useGpu = true; // sterowane argumentem wywołania (backend CUDA vs CPU)
        private static volatile bool _modelLoaded = false;
        private static long _lastDecodeTick = 0;
        private static long _idleUnloadMs = 2 * 60 * 1000; // po ilu ms bezczynności zwolnić model (0 = nigdy)
        private static bool _readyAnnounced = false;
        private static IntPtr _vadModelPtr = IntPtr.Zero; // ścieżka do modelu Silero VAD (UTF-8)
        private static IntPtr _langUtf8 = IntPtr.Zero;      // "pl\0" — żyje cały proces
        private static IntPtr _promptUtf8 = IntPtr.Zero;    // prompt początkowy
        private static string _promptText = "";             // bias słownika z main (whisper: initial_prompt, vosk: gramatyka JSON)
        private static string _voskGrammarJson = "";        // cache gramatyki JSON dla vosk (przebudowa rozpoznawacza)
        // model vosk nie wspiera gramatyki (HCLG graph) — fallback do pełnego słownika.
        // Flaga statyczna, resetowana naturalnie: zmiana modelu = restart procesu (nowy VoiceListener.exe).
        private static bool _grammarUnsupported = false;

        private static IntPtr AllocUtf8(string text)
        {
            if (text == null) return IntPtr.Zero;
            byte[] bytes = Encoding.UTF8.GetBytes(text + "\0");
            IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, ptr, bytes.Length);
            return ptr;
        }

        /// <summary>Millisekundowy znacznik czasu bez przepełnienia (TickCount64 brak w .NET 4.0)</summary>
        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }

        /// <summary>
        /// Inicjalizuje (lub odtwarza po zwolnieniu) model Whisper w pamięci.
        /// Zwraca true gdy model gotowy do dekodowania.
        /// </summary>
        private static bool InitWhisperModel()
        {
            if (_modelLoaded && _whisperCtx != IntPtr.Zero) return true;

            if (_readyAnnounced)
            {
                // Ponowne ładowanie po bezczynności — poinformuj UI (pierwsza komenda dłuższa ~1-3s)
                Console.WriteLine("{\"event\":\"model_loading\",\"engine\":\"whisper\"}");
                Console.Out.Flush();
            }

            if (!LoadWhisperApi(_whisperDllPath))
            {
                return false;
            }

            if (_whisperInitFromFileWithParams != null && _whisperContextDefaultParamsByRef != null)
            {
                IntPtr defParams = _whisperContextDefaultParamsByRef();
                if (defParams != IntPtr.Zero)
                {
                    Marshal.WriteByte(defParams, 0, (byte)(_useGpu ? 1 : 0)); // use_gpu
                    Marshal.WriteByte(defParams, 1, (byte)(_useGpu ? 1 : 0)); // flash_attn = 1 na GPU
                    Marshal.WriteInt32(defParams, 4, 0);                      // gpu_device = 0
                }
                _whisperCtx = _whisperInitFromFileWithParams(_modelPath, defParams);
            }
            else if (_useGpu && _whisperInitFromFile != null)
            {
                _whisperCtx = _whisperInitFromFile(_modelPath);
            }
            else
            {
                Console.Error.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":\"whisper.dll bez wsparcia trybu CPU (brak init_with_params)\"}");
                return false;
            }

            if (_whisperCtx == IntPtr.Zero)
            {
                return false;
            }

            // Weryfikacja ABI (layout WhisperFullParams vs whisper.dll) — raz na proces
            if (!_whisperLayoutChecked && _whisperFullDefaultParamsByRef != null)
            {
                IntPtr testParams = _whisperFullDefaultParamsByRef(0);
                if (testParams != IntPtr.Zero)
                {
                    bool layoutOk = VerifyWhisperLayout(testParams);
                    try { _whisperFreeParams(testParams); } catch { }
                    if (!layoutOk)
                    {
                        _whisperCtx = IntPtr.Zero;
                        return false;
                    }
                }
            }

            _modelLoaded = true;
            _lastDecodeTick = NowMs();
            Console.WriteLine("{\"event\":\"model_loaded\",\"engine\":\"whisper\"}");
            Console.Out.Flush();
            return true;
        }

        /// <summary>Zwalnia model z pamięci (RAM/VRAM) — ponowne użycie = InitWhisperModel()</summary>
        private static void UnloadWhisperModel()
        {
            lock (_whisperExecLock)
            {
                if (!_modelLoaded || _whisperCtx == IntPtr.Zero) return;
                try { _whisperFree(_whisperCtx); } catch { }
                _whisperCtx = IntPtr.Zero;
                _modelLoaded = false;
                Console.WriteLine("{\"event\":\"model_unloaded\",\"engine\":\"whisper\"}");
                Console.Out.Flush();
            }
        }

        private static bool LoadWhisperApi(string dllPath)
        {
            string dir = Path.GetDirectoryName(dllPath);
            if (!string.IsNullOrEmpty(dir))
            {
                SetDllDirectory(dir);
            }

            IntPtr handle = LoadLibrary(dllPath);
            if (handle == IntPtr.Zero)
            {
                int win32Err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"LoadLibrary(whisper.dll) failed (Win32Error: " + win32Err + ") for: " + EscapeJson(dllPath) + "\"}");
                return false;
            }

            _whisperInitFromFile = GetDelegate<whisper_init_from_file_delegate>(handle, "whisper_init_from_file");
            _whisperInitFromFileWithParams = GetDelegate<whisper_init_from_file_with_params_delegate>(handle, "whisper_init_from_file_with_params");
            _whisperContextDefaultParamsByRef = GetDelegate<whisper_context_default_params_by_ref_delegate>(handle, "whisper_context_default_params_by_ref");
            _whisperFullDefaultParamsByRef = GetDelegate<whisper_full_default_params_by_ref_delegate>(handle, "whisper_full_default_params_by_ref");
            _whisperFreeParams = GetDelegate<whisper_free_params_delegate>(handle, "whisper_free_params");
            _whisperFull = GetDelegate<whisper_full_delegate>(handle, "whisper_full");
            _whisperFullNSegments = GetDelegate<whisper_full_n_segments_delegate>(handle, "whisper_full_n_segments");
            _whisperFullGetSegmentText = GetDelegate<whisper_full_get_segment_text_delegate>(handle, "whisper_full_get_segment_text");
            _whisperFree = GetDelegate<whisper_free_delegate>(handle, "whisper_free");
            _whisperLogSet = GetDelegate<whisper_log_set_delegate>(handle, "whisper_log_set");
            if (_whisperLogSet != null)
            {
                try { _whisperLogSet(_dummyLogCallback, IntPtr.Zero); } catch { }
            }
            _whisperPrintSystemInfo = GetDelegate<whisper_print_system_info_delegate>(handle, "whisper_print_system_info");

            // ggml.dll rejestruje backendy (CPU/CUDA) dopiero po jawnym wywołaniu
            // ggml_backend_load_all() — biblioteka whisper.dll sama tego nie robi
            // (robi to dopiero CLI). Bez tego: "devices = 0" i GGML_ASSERT przy init.
            IntPtr ggmlHandle = LoadLibrary("ggml.dll");
            if (ggmlHandle == IntPtr.Zero)
            {
                int win32Err = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"LoadLibrary(ggml.dll) failed (Win32Error: " + win32Err + ")\"}");
                return false;
            }
            _ggmlBackendLoadAll = GetDelegate<ggml_backend_load_all_delegate>(ggmlHandle, "ggml_backend_load_all");
            if (_ggmlBackendLoadAll == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"ggml.dll missing ggml_backend_load_all export\"}");
                return false;
            }
            _ggmlBackendLoadAll();

            if (_whisperInitFromFile == null && _whisperInitFromFileWithParams == null || _whisperFull == null || _whisperFullNSegments == null ||
                _whisperFullGetSegmentText == null || _whisperFree == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"whisper.dll missing required exports\"}");
                return false;
            }

            _langUtf8 = AllocUtf8("pl");
            // Prompt jawny (arg[8]): pusty = fallback na stały polski kontekst (WHISPER_PL_PROMPT),
            // tekst = bias słownika komend. Bez arg[8] (ręczne wywołanie): ten sam fallback.
            // WHISPER_PL_PROMPT nie faworyzuje konkretnych komend — daje dekoderowi bazowy
            // kontekst polskiej gramatyki i diakrytyków (ą,ę,ó,ś,ź,ż…), by nie gubił ogonków.
            _promptUtf8 = string.IsNullOrEmpty(_promptText)
                ? AllocUtf8(WHISPER_PL_PROMPT)
                : AllocUtf8(_promptText);
            return true;
        }

        /// <summary>
        /// Kontekst językowy dla dekodera Whisper (initial_prompt) — naturalne polskie zdania
        /// z pełnym pokryciem diakrytyków (ą,ć,ę,ł,ń,ó,ś,ź,ż) i trybem rozkazującym.
        /// Whisper traktuje initial_prompt jako "dotychczasową transkrypcję" — zdania w stylu
        /// komend dają dekoderowi wzorzec, że ma generować krótkie polskie komendy, a nie
        /// długie narracje czy napisy filmowe (główne źródło halucynacji).
        /// </summary>
        private const string WHISPER_PL_PROMPT =
            "Okej, przełącz mikrofon na słuchawki bezprzewodowe. Wycisz mikrofon stacjonarny. " +
            "Włącz tryb automatyczny i przywróć działanie radaru. " +
            "Otwórz aplikację, pokaż listę komend głosowych. " +
            "Zgaś ekrany, włącz wygaszacz ekranu. Odcisz mikrofon, zmień źródło dźwięku na biurko. " +
            "Drzemkę radaru włącz na piętnaście minut, wstrzymaj nasłuch. Uśpij monitory. " +
            "Uruchom program, zamknij proces. Wyślij komendę do Home Assistant. " +
            "Przywróć radar, również wygaś ekrany.";

        /// <summary>
        /// Weryfikuje layout WhisperFullParams względem wartości domyślnych z whisper.cpp.
        /// Chroni przed cichym uszkodzeniem dekodowania przy niezgodności ABI.
        /// </summary>
        private static bool VerifyWhisperLayout(IntPtr wparams)
        {
            if (_whisperLayoutChecked) return true;
            _whisperLayoutChecked = true;

            var p = (WhisperFullParams)Marshal.PtrToStructure(wparams, typeof(WhisperFullParams));
            bool ok = p.strategy == 0 && p.n_threads >= 1 && p.n_threads <= 128;
            if (!ok)
            {
                Console.Error.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":\"whisper_full_params ABI mismatch — sprawdź wersję whisper.dll\"}");
            }
            return ok;
        }

        /// <summary>
        /// Dekodowanie w procesie: whisper_full na buforze PCM, wynik z segmentów.
        /// Model już załadowany (_whisperCtx) — brak spawnu, brak HTTP, wszystko wewnątrz VoiceListener.exe.
        /// </summary>
        private static void ExecuteWhisperDll(byte[] rawPcm)
        {
            long tStart = NowMs();
            int nSamples = rawPcm.Length / 2;
            if (nSamples < 800) return;

            // Model zwolniony po bezczynności — załaduj ponownie (pierwsza komenda po przerwie wolniejsza)
            if (!_modelLoaded && !InitWhisperModel())
            {
                Console.Error.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":\"whisper_init_from_file failed — backend/CUDA nie wystartował\"}");
                return;
            }

            _lastDecodeTick = NowMs();

            IntPtr wparams = _whisperFullDefaultParamsByRef(0);
            if (wparams == IntPtr.Zero)
            {
                Console.Error.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":\"whisper_full_default_params_by_ref zwrócił null\"}");
                return;
            }

            try
            {
                if (!VerifyWhisperLayout(wparams)) return;

                var p = (WhisperFullParams)Marshal.PtrToStructure(wparams, typeof(WhisperFullParams));
                p.n_threads = Math.Min(4, Math.Max(2, Environment.ProcessorCount)); // 4 wątki — optymalny sweet spot dla 1-3s komend audio, zero lock contention
                p.translate = 0;          // NIGDY nie tłumaczymy — tylko transkrypcja w języku polskim
                p.no_timestamps = 1;
                p.no_context = 1;         // Każda komenda to niezależna wypowiedź — brak pętli halucynacji ze starych tokenów
                p.single_segment = 1;     // Jedna zwięzła fraza komendy, brak zapętleń powtórzeń
                p.max_tokens = 0;         // 0 = bez sztucznego ucinania tokenów w segmencie
                p.detect_language = 0;    // Ścisłe wymuszenie języka polskiego — brak zgadywania języka
                p.language = _langUtf8;
                p.initial_prompt = _promptUtf8;
                p.temperature = 0.0f;
                p.temperature_inc = 0.0f; // Brak fallbacku temperatury — zero halucynacji na ciszy/szumie
                p.suppress_blank = 1;
                p.suppress_nst = 1;
                p.no_speech_thold = 0.50f;
                p.logprob_thold = -1.0f;  // Domyślny próg -1.0f (nie odrzuca polskich końcówek i odmian)
                p.entropy_thold = 2.40f;

                // Silero VAD wewnątrz whisper_full — bezpieczne marginesy dla języka polskiego (nie ucinają głosek ani krótkiego "OK")
                if (_vadModelPtr != IntPtr.Zero)
                {
                    p.vad = 1;
                    p.vad_model_path = _vadModelPtr;
                    p.vad_threshold = 0.28f;
                    p.vad_min_speech_duration_ms = 70;
                    p.vad_min_silence_duration_ms = 220;
                    p.vad_max_speech_duration_s = 10.0f;
                    p.vad_speech_pad_ms = 200;
                    p.vad_samples_overlap = 0.1f;
                }
                Marshal.StructureToPtr(p, wparams, false);

                // 16-bit PCM -> float [-1..1] (standardowy format próbek dla whisper.cpp)
                IntPtr samplesPtr = Marshal.AllocHGlobal(nSamples * 4);
                try
                {
                    float[] f32 = new float[nSamples];
                    for (int i = 0; i < nSamples; i++)
                    {
                        short v = (short)(rawPcm[i * 2] | (rawPcm[i * 2 + 1] << 8));
                        f32[i] = v / 32768.0f;
                    }

                    Marshal.Copy(f32, 0, samplesPtr, nSamples);

                    int ret = _whisperFull(_whisperCtx, wparams, samplesPtr, nSamples);
                    long dtMs = NowMs() - tStart;

                    if (ret != 0)
                    {
                        Console.Error.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":\"whisper_full zwrócił kod " + ret + "\"}");
                        return;
                    }

                    int nSeg = _whisperFullNSegments(_whisperCtx);
                    var sb = new StringBuilder();
                    for (int i = 0; i < nSeg; i++)
                    {
                        IntPtr segPtr = _whisperFullGetSegmentText(_whisperCtx, i);
                        if (segPtr != IntPtr.Zero)
                        {
                            string seg = PtrToStringUtf8(segPtr);
                            if (!string.IsNullOrEmpty(seg))
                            {
                                if (sb.Length > 0) sb.Append(" ");
                                sb.Append(seg);
                            }
                        }
                    }

                    string text = sb.ToString().Trim();
                    // Zawsze emituj wynik do procesu nadrzędnego (widoczność w logach aplikacji)
                    Console.WriteLine("{\"event\":\"result\",\"data\":{\"text\":" + EscapeJson(text) + ",\"durationMs\":" + dtMs + ",\"gpuInfo\":\"whisper.dll keep-alive\"},\"engine\":\"whisper\"}");
                    Console.Out.Flush();
                }
                finally
                {
                    Marshal.FreeHGlobal(samplesPtr);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("{\"event\":\"warning\",\"message\":" + EscapeJson("Whisper DLL decode failed: " + ex.Message) + "}");
            }
            finally
            {
                if (_whisperFreeParams != null && wparams != IntPtr.Zero)
                {
                    try { _whisperFreeParams(wparams); } catch { }
                }
            }
        }

        private static string EscapeCliArg(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        }

        /// <summary>
        /// Szybka detekcja typowych polskich halucynacji generowanych przez Whisper na ciszy lub szumie.
        /// </summary>
        private static bool IsPolishHallucination(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return true;
            string s = raw.ToLowerInvariant()
                .Replace(".", "").Replace(",", "").Replace("!", "").Replace("?", "")
                .Replace("ą", "a").Replace("ć", "c").Replace("ę", "e")
                .Replace("ł", "l").Replace("ń", "n").Replace("ó", "o")
                .Replace("ś", "s").Replace("ż", "z").Replace("ź", "z")
                .Trim();
            if (s.Length <= 1) return true;

            string[] badPhrases = new string[] {
                "dziekuje", "dziekuje bardzo", "dziekuje za uwage", "dziekuje za ogladanie",
                "dziekuje za wysluchanie", "dziekuje za obejrzenie", "dzieki za ogladanie", "dzieki",
                "subskrybuj", "subskrybujcie", "subskrybuj kanal", "zostaw suba", "lajkuj", "zostaw lapke",
                "napisy", "napisy stworzone", "tlumaczenie", "transkrypcja", "muzyka", "brawa", "oklaski",
                "cisza", "szum", "do widzenia", "do zobaczenia", "milego dnia", "dobrej nocy",
                "koniec", "amen", "czesc i czolem", "dziekuje ze jestescie", "dziekuje bardzo panstwu",
                "dziekuje panstwu"
            };

            for (int i = 0; i < badPhrases.Length; i++)
            {
                string b = badPhrases[i];
                if (s == b || s.StartsWith(b + " ") || s.EndsWith(" " + b)) return true;
            }
            return false;
        }

        private static void ExecuteWhisperCli(string tempWav)
        {
            string promptText = string.IsNullOrEmpty(_promptText) ? WHISPER_PL_PROMPT : _promptText;
            string promptPart = " --prompt \"" + EscapeCliArg(promptText) + "\"";

            var psi = new ProcessStartInfo
            {
                FileName = _whisperCliPath,
                Arguments = "-m \"" + _modelPath + "\" -l pl -f \"" + tempWav + "\" -nt -t 4 --temperature 0.0 --no-fallback --suppress-nst -bs 1 -bo 1" + promptPart,
                WorkingDirectory = Path.GetDirectoryName(_whisperCliPath),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8
            };

            long tStart = Environment.TickCount;
            string gpuInfo = "";

            using (var p = Process.Start(psi))
            {
                if (p != null)
                {
                    var outputSb = new StringBuilder();
                    p.OutputDataReceived += (s, e) =>
                    {
                        if (e.Data != null) outputSb.AppendLine(e.Data);
                    };
                    p.ErrorDataReceived += (s, e) => {
                        if (!string.IsNullOrEmpty(e.Data))
                        {
                            if (e.Data.Contains("CUDA") || e.Data.Contains("Device") || e.Data.Contains("backend") || e.Data.Contains("CPU"))
                            {
                                gpuInfo += e.Data + " ";
                            }
                        }
                    };
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();

                    // Czekaj z timeoutem — gdy whisper-cli się zawiesi (np. inicjalizacja GPU),
                    // ubij go zamiast czekać w nieskończoność na zamknięcie strumienia.
                    bool exited = p.WaitForExit(9000);
                    if (!exited)
                    {
                        try { p.Kill(); } catch {}
                        p.WaitForExit();
                    }
                    long dtMs = Environment.TickCount - tStart;

                    string text = outputSb.ToString().Trim();
                    // Usuń znaczniki czasu, jeśli silnik je wypisał mimo -nt
                    text = System.Text.RegularExpressions.Regex.Replace(text, @"\[\d+:\d+:\d+\.\d+ --> \d+:\d+:\d+\.\d+\]", "").Trim();

                    // Inicjalizacja backendu (CUDA/CPU) nie powiodła się i nie ma wyniku —
                    // sygnalizuj do menedżera, by mógł przełączyć się na CPU.
                    if (exited && p.ExitCode != 0 && string.IsNullOrEmpty(text))
                    {
                        string detail = outputSb.ToString() + gpuInfo;
                        if (detail.Length > 300) detail = detail.Substring(0, 300);
                        Console.WriteLine("{\"event\":\"backend_failed\",\"engine\":\"whisper\",\"detail\":" + EscapeJson(detail.Trim()) + "}");
                        Console.Out.Flush();
                    }

                    if (!string.IsNullOrEmpty(text) && !IsPolishHallucination(text))
                    {
                        Console.WriteLine("{\"event\":\"result\",\"data\":{\"text\":" + EscapeJson(text) + ",\"durationMs\":" + dtMs + ",\"gpuInfo\":" + EscapeJson(gpuInfo.Trim()) + "},\"engine\":\"whisper\"}");
                        Console.Out.Flush();
                    }
                }
            }
        }

        private static void ForceFinalizeVosk()
        {
            lock (_recLock)
            {
                if (_recognizerHandle == IntPtr.Zero || _voskRecognizerResult == null) return;
                IntPtr resPtr = _voskRecognizerResult(_recognizerHandle);
                if (resPtr != IntPtr.Zero)
                {
                    string resJson = PtrToStringUtf8(resPtr);
                    if (!string.IsNullOrEmpty(resJson))
                    {
                        string cleanJson = resJson.Replace("\r", "").Replace("\n", " ").Trim();
                        if (cleanJson.Contains("\"text\" : \"\"") || cleanJson == "{\"text\":\"\"}")
                        {
                            return;
                        }
                        Console.WriteLine("{\"event\":\"result\",\"data\":" + cleanJson + ",\"eos\":true,\"engine\":\"vosk\"" + (_engineMode == "whisper" ? ",\"spotter\":true" : "") + "}");
                        Console.Out.Flush();
                        _lastPartialText = "";
                    }
                }
            }
        }

        private static void FeedVosk(byte[] pcmData, int length)
        {
            if (length <= 0) return;

            lock (_recLock)
            {
                if (_recognizerHandle == IntPtr.Zero || _voskRecognizerAcceptWaveform == null) return;

                int accept = _voskRecognizerAcceptWaveform(_recognizerHandle, pcmData, length);
                if (accept == 1)
                {
                    IntPtr resPtr = _voskRecognizerResult(_recognizerHandle);
                    if (resPtr != IntPtr.Zero)
                    {
                        string resJson = PtrToStringUtf8(resPtr);
                        if (!string.IsNullOrEmpty(resJson))
                        {
                            string cleanJson = resJson.Replace("\r", "").Replace("\n", " ").Trim();
                            Console.WriteLine("{\"event\":\"result\",\"data\":" + cleanJson + (_engineMode == "whisper" ? ",\"spotter\":true" : "") + ",\"engine\":\"vosk\"}");
                            Console.Out.Flush();
                            _lastPartialText = "";
                        }
                    }
                }
                else
                {
                    // Spotter (engine=whisper) nie emituje partiali — TS i tak je odrzuca,
                    // a pisanie 20x/s na stdout z wątku audio grozi backpressure i zamrożeniem nasłuchu.
                    if (_engineMode == "whisper") return;
                    IntPtr partPtr = _voskRecognizerPartialResult(_recognizerHandle);
                    if (partPtr != IntPtr.Zero)
                    {
                        string partJson = PtrToStringUtf8(partPtr);
                        if (!string.IsNullOrEmpty(partJson) && partJson != _lastPartialText)
                        {
                            _lastPartialText = partJson;
                            string cleanPart = partJson.Replace("\r", "").Replace("\n", " ").Trim();
                            Console.WriteLine("{\"event\":\"partial\",\"data\":" + cleanPart + ",\"engine\":\"vosk\"}");
                            Console.Out.Flush();
                        }
                    }
                }
            }
        }

        private static string PtrToStringUtf8(IntPtr ptr)
        {
            if (ptr == IntPtr.Zero) return "";
            int len = 0;
            while (Marshal.ReadByte(ptr, len) != 0) len++;
            if (len == 0) return "";
            byte[] bytes = new byte[len];
            Marshal.Copy(ptr, bytes, 0, len);
            return Encoding.UTF8.GetString(bytes);
        }

        private static string EscapeJson(string str)
        {
            if (string.IsNullOrEmpty(str)) return "\"\"";
            StringBuilder sb = new StringBuilder("\"", str.Length + 10);
            foreach (char c in str)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(c); break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
