using System;
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

        // VAD State Tracking
        private static bool _isSpeaking = false;
        private static int _silenceDurationMs = 0;
        private static int _speechDurationMs = 0;
        private static double _speechProb = 0.0;
        private static double _noiseFloor = 80.0;

        // Whisper Audio Buffer & Circular Pre-roll
        private static readonly MemoryStream _whisperBuffer = new MemoryStream();
        private static readonly object _bufferLock = new object();
        private static readonly System.Collections.Generic.Queue<byte[]> _preRollQueue = new System.Collections.Generic.Queue<byte[]>();
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
                if (args.Length > 7 && _engineMode == "whisper")
                {
                    // Ścieżka do modelu Silero VAD (ggml-silero-*.bin) — ochrona przed muzyką/szumem
                    _vadModelPtr = AllocUtf8(args[7]);
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

                    _recognizerHandle = _voskRecognizerNew(_modelHandle, 16000.0f);
                    if (_recognizerHandle == IntPtr.Zero)
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
                        Console.WriteLine("{\"ok\":true,\"deviceUpdated\":" + EscapeJson(dev) + "}");
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
            _voskRecognizerFree = GetDelegate<vosk_recognizer_free_delegate>(_voskDllHandle, "vosk_recognizer_free");
            _voskRecognizerAcceptWaveform = GetDelegate<vosk_recognizer_accept_waveform_delegate>(_voskDllHandle, "vosk_recognizer_accept_waveform");
            _voskRecognizerResult = GetDelegate<vosk_recognizer_result_delegate>(_voskDllHandle, "vosk_recognizer_result");
            _voskRecognizerPartialResult = GetDelegate<vosk_recognizer_partial_result_delegate>(_voskDllHandle, "vosk_recognizer_partial_result");
            _voskRecognizerReset = GetDelegate<vosk_recognizer_reset_delegate>(_voskDllHandle, "vosk_recognizer_reset");

            return _voskModelNew != null && _voskRecognizerAcceptWaveform != null;
        }

        private static T GetDelegate<T>(IntPtr module, string name) where T : class
        {
            IntPtr proc = GetProcAddress(module, name);
            if (proc == IntPtr.Zero) return null;
            return Marshal.GetDelegateForFunctionPointer(proc, typeof(T)) as T;
        }

        private static int FindDeviceIndex(string preferred, out string deviceName)
        {
            int devCount = waveInGetNumDevs();
            deviceName = "Domyślny mikrofon Windows";

            if (devCount <= 0) return WAVE_MAPPER;

            string search = (preferred ?? "").ToLowerInvariant().Trim();

            // Bez wskazania urządzenia podążaj za aktualnym DOMYŚLNYM mikrofonem Windows
            // (DeskSense przełącza go między biurkiem a słuchawkami w locie).
            if (string.IsNullOrEmpty(search)) return WAVE_MAPPER;

            for (int i = 0; i < devCount; i++)
            {
                WAVEINCAPS caps;
                if (waveInGetDevCaps((IntPtr)i, out caps, Marshal.SizeOf(typeof(WAVEINCAPS))) == 0)
                {
                    string name = caps.szPname ?? "";
                    string nameLower = name.ToLowerInvariant();
                    if (nameLower.Contains(search) || search.Contains(nameLower))
                    {
                        deviceName = name;
                        return i;
                    }
                }
            }

            // Brak dopasowania — nie przypisuj na stałe pierwszego urządzenia,
            // tylko podążaj za domyślnym (np. gdy preferowany mikrofon odłączony).
            return WAVE_MAPPER;
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

            using (AutoResetEvent hEvent = new AutoResetEvent(false))
            {
                string matchedName;
                int deviceId = FindDeviceIndex(_preferredDevice, out matchedName);
                _activeDeviceName = matchedName;

                IntPtr hWaveIn;
                int res = waveInOpen(out hWaveIn, deviceId, ref wfx, hEvent.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CALLBACK_EVENT);
                if (res != 0 || hWaveIn == IntPtr.Zero)
                {
                    if (deviceId != WAVE_MAPPER)
                    {
                        res = waveInOpen(out hWaveIn, WAVE_MAPPER, ref wfx, hEvent.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CALLBACK_EVENT);
                    }
                    if (res != 0 || hWaveIn == IntPtr.Zero)
                    {
                        Thread.Sleep(500);
                        return;
                    }
                }

                const int BUF_COUNT = 4;
                const int BUF_SIZE = 1600; // 50ms chunks at 16kHz
                IntPtr[] hdrPtrs = new IntPtr[BUF_COUNT];
                IntPtr[] dataPtrs = new IntPtr[BUF_COUNT];
                byte[] rawPcmBuffer = new byte[BUF_SIZE];
                byte[] boostedPcmBuffer = new byte[BUF_SIZE];

                for (int i = 0; i < BUF_COUNT; i++)
                {
                    dataPtrs[i] = Marshal.AllocHGlobal(BUF_SIZE);
                    var hdr = new WAVEHDR
                    {
                        lpData = dataPtrs[i],
                        dwBufferLength = BUF_SIZE
                    };
                    hdrPtrs[i] = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
                    Marshal.StructureToPtr(hdr, hdrPtrs[i], false);
                    waveInPrepareHeader(hWaveIn, hdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                    waveInAddBuffer(hWaveIn, hdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                }

                res = waveInStart(hWaveIn);
                if (res != 0)
                {
                    waveInClose(hWaveIn);
                    return;
                }

                while (_running)
                {
                    if (hEvent.WaitOne(60))
                    {
                        for (int i = 0; i < BUF_COUNT; i++)
                        {
                            var hdr = (WAVEHDR)Marshal.PtrToStructure(hdrPtrs[i], typeof(WAVEHDR));
                            if ((hdr.dwFlags & WHDR_DONE) != 0)
                            {
                                uint bytes = hdr.dwBytesRecorded;
                                if (bytes > 0)
                                {
                                    Marshal.Copy(hdr.lpData, rawPcmBuffer, 0, (int)bytes);

                                    // Software Gain & Telemetry
                                    double sumSq = 0;
                                    int zcr = 0;
                                    short prevSample = 0;
                                    int sampleCount = (int)bytes / 2;
                                    float gain = _gainMultiplier;

                                    double maxAbs = 0;
                                    for (int s = 0; s < (int)bytes; s += 2)
                                    {
                                        short orig = (short)(rawPcmBuffer[s] | (rawPcmBuffer[s + 1] << 8));
                                        double amplified = (double)orig * gain;
                                        // Soft saturation compression curve to avoid harsh digital clipping harmonics
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

                                        boostedPcmBuffer[s] = (byte)(boosted & 0xFF);
                                        boostedPcmBuffer[s + 1] = (byte)((boosted >> 8) & 0xFF);

                                        sumSq += (double)boosted * boosted;

                                        if ((prevSample >= 0 && boosted < 0) || (prevSample < 0 && boosted >= 0))
                                        {
                                            zcr++;
                                        }
                                        prevSample = boosted;
                                    }

                                    double rms = Math.Sqrt(sumSq / sampleCount);
                                    double crestFactor = maxAbs / Math.Max(1.0, rms);

                                    // Sztywna brama -60 dB (≈32.77 RMS przy 32767, domena wzmocniona) — tylko dla DETEKCJI VAD.
                                    // Transkrypcja dostaje surowy PCM (patrz niżej), więc brama nie zniekształca audio.
                                    if (rms < 32.77)
                                    {
                                        rms = 0;
                                        maxAbs = 0;
                                        zcr = 0;
                                        sumSq = 0;
                                        crestFactor = 0;
                                    }

                                    // Adaptive noise floor tracking (clamped to realistic room noise floor 60.0 - 300.0)
                                    if (rms < _noiseFloor * 1.5)
                                    {
                                        _noiseFloor = _noiseFloor * 0.97 + rms * 0.03;
                                        if (_noiseFloor < 60.0) _noiseFloor = 60.0;
                                    }

                                    double snr = rms / Math.Max(40.0, _noiseFloor);
                                    double zcrNorm = (double)zcr / sampleCount;

                                    // Mechanical click rejection: Crest Factor > 3.8 indicates impulsive keyboard/mouse click or knock
                                    bool isMechanicalClick = crestFactor >= 3.8 || zcrNorm >= 0.45;

                                    double prob = 0.0;
                                    if (!isMechanicalClick && rms >= 160.0 && snr >= 1.7)
                                    {
                                        if (zcrNorm >= 0.04 && zcrNorm <= 0.35)
                                        {
                                            // Strong voiced vowel formant
                                            prob = Math.Min(1.0, (snr - 1.2) / 2.5);
                                        }
                                        else if (_isSpeaking && zcrNorm <= 0.44)
                                        {
                                            // Voiced consonant or Polish fricative during an active sentence (e.g. sz, cz, s)
                                            prob = 0.75;
                                        }
                                    }

                                    _speechProb = _speechProb * 0.35 + prob * 0.65;

                                    if (_speechProb >= 0.45)
                                    {
                                        _speechDurationMs += 50;
                                        _silenceDurationMs = 0;
                                        if (!_isSpeaking && _speechDurationMs >= 100) // 100ms of sustained voice
                                        {
                                            _isSpeaking = true;
                                            if (_engineMode == "whisper")
                                            {
                                                lock (_bufferLock)
                                                {
                                                    _whisperBuffer.SetLength(0);
                                                    while (_preRollQueue.Count > 0)
                                                    {
                                                        byte[] pre = _preRollQueue.Dequeue();
                                                        _whisperBuffer.Write(pre, 0, pre.Length);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    else if (_speechProb < 0.20)
                                    {
                                        _silenceDurationMs += 50;
                                        _speechDurationMs = 0;

                                        // End-of-Speech trigger (600ms ciszy po prawdziwej mowie -> Whisper decode!)
                                        // 400ms ucinało wyrazy przy naturalnych pauzach w zdaniu
                                        if (_isSpeaking && _silenceDurationMs >= 600)
                                        {
                                            _isSpeaking = false;
                                            if (_engineMode == "whisper")
                                            {
                                                byte[] audioChunk = null;
                                                lock (_bufferLock)
                                                {
                                                    // Min. 0.5s prawdziwego audio (16000 bajtów przy 32kB/s) — odcina szumy/muzykę
                                                    if (_whisperBuffer.Length >= 16000)
                                                    {
                                                        audioChunk = _whisperBuffer.ToArray();
                                                    }
                                                    _whisperBuffer.SetLength(0);
                                                }
                                                if (audioChunk != null)
                                                {
                                                    ThreadPool.QueueUserWorkItem((state) => ExecuteWhisper(audioChunk));
                                                }
                                            }
                                            else
                                            {
                                                ForceFinalizeVosk();
                                            }
                                        }
                                    }

                                    // Pre-roll queue & pure speech accumulation for Whisper
                                    if (_engineMode == "whisper")
                                    {
                                        // Zwolnij model z pamięci po bezczynności (konfigurowalne, 0 = nigdy)
                                        if (_modelLoaded && _idleUnloadMs > 0 && !_isSpeaking &&
                                            _lastDecodeTick > 0 &&
                                            (NowMs() - _lastDecodeTick) > _idleUnloadMs)
                                        {
                                            _lastDecodeTick = NowMs(); // zapobiega zalewaniu kolejki
                                            ThreadPool.QueueUserWorkItem(_ => UnloadWhisperModel());
                                        }

                                        if (!_isSpeaking)
                                        {
                                            byte[] copy = new byte[bytes];
                                            Buffer.BlockCopy(rawPcmBuffer, 0, copy, 0, (int)bytes);
                                            _preRollQueue.Enqueue(copy);
                                            while (_preRollQueue.Count > PRE_ROLL_COUNT)
                                            {
                                                _preRollQueue.Dequeue();
                                            }
                                        }
                                        else
                                        {
                                            lock (_bufferLock)
                                            {
                                                // Transkrypcja dostaje SUROWY PCM (bez wzmocnienia/clippingu/bramki)
                                                _whisperBuffer.Write(rawPcmBuffer, 0, (int)bytes);
                                                if (_whisperBuffer.Length > 32000 * 10) // Max 10s command
                                                {
                                                    _whisperBuffer.SetLength(32000 * 10);
                                                }
                                            }
                                        }
                                    }
                                    else
                                    {
                                        FeedVosk(rawPcmBuffer, (int)bytes);
                                    }

                                    // Emit real-time audio level & VAD telemetry every 100ms
                                    long now = Environment.TickCount;
                                    if (now - _lastAudioLevelTick >= 100)
                                    {
                                        _lastAudioLevelTick = now;
                                        double db = rms > 1 ? 20.0 * Math.Log10(rms / 32767.0) : -60.0;
                                        int levelPct = (int)Math.Min(100, Math.Max(0, (db + 50.0) * 2.0));
                                        string rmsStr = Math.Round(rms, 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
                                        string dbStr = Math.Round(db, 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
                                        string probStr = Math.Round(_speechProb * 100.0).ToString(System.Globalization.CultureInfo.InvariantCulture);
                                        Console.WriteLine("{\"event\":\"audio_level\",\"rms\":" + rmsStr + ",\"db\":" + dbStr + ",\"level\":" + levelPct + ",\"device\":" + EscapeJson(_activeDeviceName) + ",\"vad\":{\"speech\":" + (_isSpeaking ? "true" : "false") + ",\"prob\":" + probStr + "}}");
                                        Console.Out.Flush();
                                    }
                                }

                                // Re-queue buffer
                                hdr.dwBytesRecorded = 0;
                                hdr.dwFlags &= ~WHDR_DONE;
                                Marshal.StructureToPtr(hdr, hdrPtrs[i], false);
                                waveInAddBuffer(hWaveIn, hdrPtrs[i], Marshal.SizeOf(typeof(WAVEHDR)));
                            }
                        }
                    }
                }

                try
                {
                    waveInStop(hWaveIn);
                    waveInReset(hWaveIn);
                    waveInClose(hWaveIn);
                }
                catch { }

                for (int i = 0; i < BUF_COUNT; i++)
                {
                    if (dataPtrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(dataPtrs[i]);
                    if (hdrPtrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(hdrPtrs[i]);
                }
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
            public byte carry_initial_prompt;
            // pad 7
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
        private delegate void whisper_free_delegate(IntPtr ctx);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr whisper_print_system_info_delegate();

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void ggml_backend_load_all_delegate();

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
            _promptUtf8 = AllocUtf8(WHISPER_PL_PROMPT);
            return true;
        }

        /// <summary>
        /// Prompt początkowy nastawia dekoder Whisper na słownik polskich komend —
        /// znacząco poprawia rozpoznawanie polskich odmian (wycisz/odcisz/przełącz itd.).
        /// </summary>
        private const string WHISPER_PL_PROMPT =
            "OK Okej DeskSense wycisz mikrofon odcisz mikrofon wycisz odcisz przełącz na słuchawki przełącz na biurko " +
            "tryb automatyczny auto radar włącz radar przywróć radar zgaś ekrany zgaś ekran włącz wygaszacz uśpij monitory drzemka pauza głośniej ciszej " +
            "muzykę światło stacjonarny mobilny bezprzewodowy proszę powtórz jeszcze raz teraz szybko " +
            "komenda komendę wykonaj zapisz ustaw potwierdzam tak nie dziesięć piętnaście trzydzieści minut godziny";

        /// <summary>
        /// Weryfikuje layout WhisperFullParams względem wartości domyślnych z whisper.cpp.
        /// Chroni przed cichym uszkodzeniem dekodowania przy niezgodności ABI.
        /// </summary>
        private static bool VerifyWhisperLayout(IntPtr wparams)
        {
            if (_whisperLayoutChecked) return true;
            _whisperLayoutChecked = true;

            var p = (WhisperFullParams)Marshal.PtrToStructure(wparams, typeof(WhisperFullParams));
            string lang = p.language != IntPtr.Zero ? PtrToStringUtf8(p.language) : "(null)";
            bool ok = p.strategy == 0
                && p.n_threads >= 1 && p.n_threads <= 64
                && p.temperature == 0.0f
                && (p.greedy_best_of == -1 || p.greedy_best_of == 5)
                && p.beam_size == -1
                && lang == "en";
            if (!ok)
            {
                Console.Error.WriteLine("{\"event\":\"layout_debug\",\"strategy\":" + p.strategy + ",\"n_threads\":" + p.n_threads + ",\"temperature\":" + p.temperature.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"greedy_best_of\":" + p.greedy_best_of + ",\"beam_size\":" + p.beam_size + ",\"lang\":" + EscapeJson(lang) + ",\"size\":" + Marshal.SizeOf(typeof(WhisperFullParams)) + "}");
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
            if (nSamples < 1600) return;

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
                p.n_threads = Math.Min(8, Environment.ProcessorCount);
                p.translate = 0;          // NIGDY nie tłumaczymy — tylko transkrypcja
                p.no_timestamps = 1;
                p.no_context = 0;
                p.detect_language = 0;
                p.language = _langUtf8;
                p.initial_prompt = _promptUtf8;

                // Silero VAD wewnątrz whisper_full — chroni przed muzyką/szumem (bramka -60dB usuwa tylko niski szum)
                if (_vadModelPtr != IntPtr.Zero)
                {
                    p.vad = 1;
                    p.vad_model_path = _vadModelPtr;
                    p.vad_threshold = 0.5f;
                    p.vad_min_speech_duration_ms = 250;
                    p.vad_min_silence_duration_ms = 100;
                    p.vad_max_speech_duration_s = 5.0f;
                    p.vad_speech_pad_ms = 30;
                    p.vad_samples_overlap = 0.1f;
                }
                Marshal.StructureToPtr(p, wparams, false);

                // 16-bit PCM -> float [-1..1]
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
                    if (!string.IsNullOrEmpty(text))
                    {
                        Console.WriteLine("{\"event\":\"result\",\"data\":{\"text\":" + EscapeJson(text) + ",\"durationMs\":" + dtMs + ",\"gpuInfo\":\"whisper.dll keep-alive\"},\"engine\":\"whisper\"}");
                        Console.Out.Flush();
                    }
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

        private static void ExecuteWhisperCli(string tempWav)
        {
            var psi = new ProcessStartInfo
            {
                FileName = _whisperCliPath,
                Arguments = "-m \"" + _modelPath + "\" -l " + _language + " -f \"" + tempWav + "\" -nt -t 8 --prompt \"" + WHISPER_PL_PROMPT + "\"",
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

                    if (!string.IsNullOrEmpty(text))
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
                        Console.WriteLine("{\"event\":\"result\",\"data\":" + cleanJson + ",\"eos\":true,\"engine\":\"vosk\"}");
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
                            Console.WriteLine("{\"event\":\"result\",\"data\":" + cleanJson + ",\"engine\":\"vosk\"}");
                            Console.Out.Flush();
                            _lastPartialText = "";
                        }
                    }
                }
                else
                {
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
