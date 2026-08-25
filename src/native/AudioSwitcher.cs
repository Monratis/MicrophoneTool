using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AudioSwitcher
{
    public enum ERole
    {
        eConsole = 0,
        eMultimedia = 1,
        eCommunications = 2
    }

    public enum EDataFlow
    {
        eRender = 0,
        eCapture = 1,
        eAll = 2
    }

    public enum DeviceState
    {
        Active = 0x00000001,
        Disabled = 0x00000002,
        NotPresent = 0x00000004,
        Unplugged = 0x00000008,
        All = 0x0000000F
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int deviceNumber, out IMMDevice device);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, DeviceState stateMask, out IMMDeviceCollection deviceCollection);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int propertyIndex, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PropVariant
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr ptr;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat();
        [PreserveSig] int GetDeviceFormat();
        [PreserveSig] int ResetDeviceFormat();
        [PreserveSig] int SetDeviceFormat();
        [PreserveSig] int GetProcessingPeriod();
        [PreserveSig] int SetProcessingPeriod();
        [PreserveSig] int GetShareMode();
        [PreserveSig] int SetShareMode();
        [PreserveSig] int GetPropertyValue();
        [PreserveSig] int SetPropertyValue();
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string wszDeviceId, ERole eRole);
        [PreserveSig] int SetEndpointVisibility();
    }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    internal class CPolicyConfigClient { }

    [ComImport, Guid("5BC644DE-035A-46E0-B884-219C03C28731"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
        [PreserveSig] int GetChannelCount(out int pnChannelCount);
        [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
        [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        [PreserveSig] int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
        [PreserveSig] int VolumeStepUp(ref Guid pguidEventContext);
        [PreserveSig] int VolumeStepDown(ref Guid pguidEventContext);
        [PreserveSig] int QueryHardwareSupport(out uint pdwHardwareSupportMask);
        [PreserveSig] int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
    }

    public class AudioDevice
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public bool IsDefault { get; set; }
        public bool IsDefaultComm { get; set; }
        public bool IsMuted { get; set; }
        public int Volume { get; set; }
    }

    public static class Program
    {
        private static readonly PropertyKey PKEY_Device_FriendlyName = new PropertyKey
        {
            fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
            pid = 14
        };

        private static readonly Guid IID_IAudioEndpointVolume = new Guid("5BC644DE-035A-46E0-B884-219C03C28731");

        // Zwalnia pamięć COM przydzieloną przez IPropertyStore.GetValue —
        // bez tego daemon wycieka przy każdej enumeracji każdego urządzenia.
        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant pvar);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern uint SetThreadExecutionState(uint esFlags);

        private const int HWND_BROADCAST = 0xFFFF;
        private const uint WM_SYSCOMMAND = 0x0112;
        private const int SC_MONITORPOWER = 0xF170;
        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint ES_CONTINUOUS = 0x80000000;
        private const uint ES_SYSTEM_REQUIRED = 0x00000001;
        private const uint ES_DISPLAY_REQUIRED = 0x00000002;

        private static IMMDeviceEnumerator _cachedEnumerator;
        private static IPolicyConfig _cachedPolicyConfig;

        private static IMMDeviceEnumerator GetEnumerator()
        {
            if (_cachedEnumerator == null)
            {
                _cachedEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            }
            return _cachedEnumerator;
        }

        private static IPolicyConfig GetPolicyConfig()
        {
            if (_cachedPolicyConfig == null)
            {
                _cachedPolicyConfig = (IPolicyConfig)new CPolicyConfigClient();
            }
            return _cachedPolicyConfig;
        }

        public static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            if (args.Length == 0)
            {
                PrintHelp();
                return 0;
            }

            string command = args[0].ToLowerInvariant();

            try
            {
                if (command == "daemon" || command == "--daemon" || command == "-d")
                {
                    return RunDaemon();
                }
                else if (command == "list" || command == "--list" || command == "-l" || command == "/list")
                {
                    return ListDevices();
                }
                else if (command == "get" || command == "--get" || command == "-g")
                {
                    return GetDefaultDevice();
                }
                else if (command == "toggle-mute" || command == "--toggle-mute")
                {
                    string target = args.Length > 1 ? args[1] : "";
                    return ToggleMute(target);
                }
                else if (command == "mute" || command == "--mute")
                {
                    string target = args.Length > 1 ? args[1] : "";
                    return SetMute(target, true);
                }
                else if (command == "unmute" || command == "--unmute")
                {
                    string target = args.Length > 1 ? args[1] : "";
                    return SetMute(target, false);
                }
                else if (command == "sleep-display" || command == "sleep-monitors" || command == "display-off")
                {
                    return SleepDisplay();
                }
                else if (command == "wake-display" || command == "wake-monitors" || command == "display-on")
                {
                    return WakeDisplay();
                }
                else if (command == "set" || command == "--set" || command == "-s")
                {
                    if (args.Length < 2)
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Missing device name or ID argument\"}");
                        return 1;
                    }
                    return SetDefaultDevice(args[1]);
                }
                else if (command == "/setdefault")
                {
                    if (args.Length < 2)
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Missing device argument\"}");
                        return 1;
                    }
                    return SetDefaultDevice(args[1]);
                }
                else if (command == "set-volume")
                {
                    if (args.Length < 3)
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Usage: set-volume <Name_or_ID> <0-100> lub <0-100> <Name_or_ID>\"}");
                        return 1;
                    }
                    // Auto-wykrywanie kolejności: daemon używa <0-100> <Name>,
                    // CLI/fallback SoundVolumeView <Name> <0-100>. Próbujemy obie,
                    // żeby obie konwencje działały i nie było "Invalid volume percentage".
                    float pct;
                    string target;
                    if (float.TryParse(args[2], out pct))
                    {
                        target = args[1]; // <Name_or_ID> <0-100>
                    }
                    else if (float.TryParse(args[1], out pct))
                    {
                        target = args[2]; // <0-100> <Name_or_ID>
                    }
                    else
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Invalid volume percentage\"}");
                        return 1;
                    }
                    if (pct < 0f) pct = 0f;
                    if (pct > 100f) pct = 100f;
                    return SetVolume(target, pct / 100f);
                }
                else if (command == "get-volume")
                {
                    return GetVolume(args.Length > 1 ? args[1] : "");
                }
                else if (command == "--help" || command == "-h" || command == "/?")
                {
                    PrintHelp();
                    return 0;
                }
                else
                {
                    return SetDefaultDevice(args[0]);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":" + EscapeJson(ex.Message) + "}");
                return 1;
            }
        }

        private static void PrintHelp()
        {
            Console.WriteLine("AudioSwitcher - High Performance Windows CoreAudio Daemon & CLI");
            Console.WriteLine("Usage:");
            Console.WriteLine("  AudioSwitcher.exe daemon                # Run resident background daemon (IPC via stdin/stdout)");
            Console.WriteLine("  AudioSwitcher.exe list                  # List all active recording devices (JSON)");
            Console.WriteLine("  AudioSwitcher.exe get                   # Get current default recording device (JSON)");
            Console.WriteLine("  AudioSwitcher.exe set <Name_or_ID>      # Set default recording device");
            Console.WriteLine("  AudioSwitcher.exe toggle-mute [Name_or_ID] # Toggle microphone mute");
            Console.WriteLine("  AudioSwitcher.exe sleep-display         # Turn off / sleep connected monitors");
            Console.WriteLine("  AudioSwitcher.exe wake-display          # Wake up connected monitors");
        }

        private static int RunDaemon()
        {
            GetEnumerator();
            GetPolicyConfig();

            Console.WriteLine("{\"ready\":true,\"version\":\"0.2.0\"}");
            Console.Out.Flush();

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;

                string cmd = line;
                string arg = "";
                int spaceIdx = line.IndexOf(' ');
                if (spaceIdx > 0)
                {
                    cmd = line.Substring(0, spaceIdx).Trim().ToLowerInvariant();
                    arg = line.Substring(spaceIdx + 1).Trim();
                }
                else
                {
                    cmd = cmd.ToLowerInvariant();
                }

                if (cmd == "ping")
                {
                    Console.WriteLine("{\"ok\":true,\"pong\":true}");
                }
                else if (cmd == "list")
                {
                    ListDevices();
                }
                else if (cmd == "get")
                {
                    GetDefaultDevice();
                }
                else if (cmd == "set")
                {
                    SetDefaultDevice(arg);
                }
                else if (cmd == "toggle-mute" || cmd == "togglemute")
                {
                    ToggleMute(arg);
                }
                else if (cmd == "mute")
                {
                    SetMute(arg, true);
                }
                else if (cmd == "unmute")
                {
                    SetMute(arg, false);
                }
                else if (cmd == "set-volume")
                {
                    // Format: set-volume <0-100> <Name_or_ID>
                    // Procent PIERWSZY — nazwy urządzeń bywają kończą się cyfrą,
                    // co łamało parsowanie "ostatni token = wartość".
                    int firstSpace = arg.IndexOf(' ');
                    float pct;
                    if (firstSpace <= 0 || !float.TryParse(arg.Substring(0, firstSpace).Trim(), out pct))
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"Usage: set-volume <0-100> <Name_or_ID>\"}");
                    }
                    else
                    {
                        string volTarget = arg.Substring(firstSpace + 1).Trim();
                        if (pct < 0f) pct = 0f;
                        if (pct > 100f) pct = 100f;
                        SetVolume(volTarget, pct / 100f);
                    }
                }
                else if (cmd == "get-volume")
                {
                    GetVolume(arg);
                }
                else if (cmd == "sleep-display" || cmd == "sleep-monitors" || cmd == "display-off")
                {
                    SleepDisplay();
                }
                else if (cmd == "wake-display" || cmd == "wake-monitors" || cmd == "display-on")
                {
                    WakeDisplay();
                }
                else if (cmd == "exit" || cmd == "quit")
                {
                    Console.WriteLine("{\"ok\":true,\"bye\":true}");
                    break;
                }
                else
                {
                    SetDefaultDevice(line);
                }
                Console.Out.Flush();
            }

            return 0;
        }

        public static int SleepDisplay()
        {
            PostMessage((IntPtr)HWND_BROADCAST, WM_SYSCOMMAND, (IntPtr)SC_MONITORPOWER, (IntPtr)2);
            Console.WriteLine("{\"ok\":true,\"display\":\"sleep\"}");
            return 0;
        }

        public static int WakeDisplay()
        {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
            mouse_event(MOUSEEVENTF_MOVE, 0, 1, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(25);
            mouse_event(MOUSEEVENTF_MOVE, 0, unchecked((uint)-1), 0, UIntPtr.Zero);
            SetThreadExecutionState(ES_CONTINUOUS);
            Console.WriteLine("{\"ok\":true,\"display\":\"wake\"}");
            return 0;
        }

        private static List<AudioDevice> EnumerateRecordingDevices(out string defaultConsoleId, out string defaultCommId)
        {
            var list = new List<AudioDevice>(8);
            defaultConsoleId = "";
            defaultCommId = "";

            IMMDeviceEnumerator enumerator = GetEnumerator();
            IMMDeviceCollection collection;
            int hr = enumerator.EnumAudioEndpoints(EDataFlow.eCapture, DeviceState.Active, out collection);
            if (hr != 0 || collection == null)
            {
                return list;
            }

            try
            {
                IMMDevice defCon;
                if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eConsole, out defCon) == 0 && defCon != null)
                {
                    defCon.GetId(out defaultConsoleId);
                }
            }
            catch { }

            try
            {
                IMMDevice defComm;
                if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eCommunications, out defComm) == 0 && defComm != null)
                {
                    defComm.GetId(out defaultCommId);
                }
            }
            catch { }

            int count;
            collection.GetCount(out count);

            PropertyKey key = PKEY_Device_FriendlyName;

            for (int i = 0; i < count; i++)
            {
                IMMDevice dev;
                if (collection.Item(i, out dev) != 0 || dev == null)
                    continue;

                string id = "";
                dev.GetId(out id);

                string name = "";
                IPropertyStore store;
                if (dev.OpenPropertyStore(0, out store) == 0 && store != null)
                {
                    PropVariant val = default(PropVariant);
                    try
                    {
                        if (store.GetValue(ref key, out val) == 0 && val.ptr != IntPtr.Zero)
                        {
                            name = Marshal.PtrToStringUni(val.ptr);
                        }
                    }
                    finally
                    {
                        PropVariantClear(ref val);
                    }
                }

                if (string.IsNullOrEmpty(name))
                {
                    name = "Recording Device " + i;
                }

                bool isMuted = false;
                int volume = 100;
                try
                {
                    Guid iid = IID_IAudioEndpointVolume;
                    object epvObj;
                    if (dev.Activate(ref iid, 1, IntPtr.Zero, out epvObj) == 0 && epvObj != null)
                    {
                        IAudioEndpointVolume epv = epvObj as IAudioEndpointVolume;
                        if (epv != null)
                        {
                            epv.GetMute(out isMuted);
                            float volScalar;
                            if (epv.GetMasterVolumeLevelScalar(out volScalar) == 0)
                            {
                                volume = (int)Math.Round(volScalar * 100f);
                            }
                        }
                    }
                }
                catch { }

                list.Add(new AudioDevice
                {
                    Id = id,
                    Name = name,
                    IsDefault = (!string.IsNullOrEmpty(defaultConsoleId) && id == defaultConsoleId),
                    IsDefaultComm = (!string.IsNullOrEmpty(defaultCommId) && id == defaultCommId),
                    IsMuted = isMuted,
                    Volume = volume
                });
            }

            return list;
        }

        private static int ListDevices()
        {
            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);

            var sb = new StringBuilder(512);
            sb.Append("[");
            for (int i = 0; i < devices.Count; i++)
            {
                var d = devices[i];
                if (i > 0) sb.Append(",");
                sb.Append("{\"id\":").Append(EscapeJson(d.Id))
                  .Append(",\"name\":").Append(EscapeJson(d.Name))
                  .Append(",\"isDefault\":").Append(d.IsDefault ? "true" : "false")
                  .Append(",\"isDefaultComm\":").Append(d.IsDefaultComm ? "true" : "false")
                  .Append(",\"isMuted\":").Append(d.IsMuted ? "true" : "false")
                  .Append(",\"volume\":").Append(d.Volume)
                  .Append("}");
            }
            sb.Append("]");
            Console.WriteLine(sb.ToString());
            return 0;
        }

        private static int GetDefaultDevice()
        {
            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);
            var current = devices.Find(d => d.IsDefault) ?? (devices.Count > 0 ? devices[0] : null);

            if (current == null)
            {
                Console.WriteLine("null");
                return 0;
            }

            var sb = new StringBuilder(256);
            sb.Append("{\"id\":").Append(EscapeJson(current.Id))
              .Append(",\"name\":").Append(EscapeJson(current.Name))
              .Append(",\"isDefault\":true,")
              .Append("\"isDefaultComm\":").Append(current.IsDefaultComm ? "true" : "false").Append(",")
              .Append("\"isMuted\":").Append(current.IsMuted ? "true" : "false").Append(",")
              .Append("\"volume\":").Append(current.Volume)
              .Append("}");
            Console.WriteLine(sb.ToString());
            return 0;
        }

        private static int SetDefaultDevice(string target)
        {
            if (string.IsNullOrEmpty(target))
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Target device identifier is empty\"}");
                return 1;
            }

            IPolicyConfig policyConfig = GetPolicyConfig();
            if (policyConfig == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Failed to create IPolicyConfig client\"}");
                return 1;
            }

            if (target.StartsWith("{") && target.Contains(".{"))
            {
                // HRESULT-y MUSZĄ być sprawdzane — po restarcie usługi audio
                // martwy COM zwraca błąd, a fałszywe "ok:true" zatruwa cache
                // po stronie aplikacji.
                int hrA = policyConfig.SetDefaultEndpoint(target, ERole.eConsole);
                int hrB = policyConfig.SetDefaultEndpoint(target, ERole.eMultimedia);
                int hrC = policyConfig.SetDefaultEndpoint(target, ERole.eCommunications);
                if (hrA != 0 || hrB != 0 || hrC != 0)
                {
                    Console.Error.WriteLine("{\"ok\":false,\"error\":\"SetDefaultEndpoint failed hr=0x" + (hrA | hrB | hrC).ToString("X8") + "\"}");
                    return 1;
                }
                Console.WriteLine("{\"ok\":true,\"id\":" + EscapeJson(target) + "}");
                return 0;
            }

            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);

            if (devices.Count == 0)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"No active recording devices found\"}");
                return 1;
            }

            AudioDevice match = FindMatchingDevice(devices, target);
            if (match == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":" + EscapeJson("Device not found: " + target) + "}");
                return 1;
            }

            if (match.IsDefault && match.IsDefaultComm)
            {
                Console.WriteLine("{\"ok\":true,\"name\":" + EscapeJson(match.Name) + ",\"id\":" + EscapeJson(match.Id) + ",\"cached\":true}");
                return 0;
            }

            int hr1 = policyConfig.SetDefaultEndpoint(match.Id, ERole.eConsole);
            int hr2 = policyConfig.SetDefaultEndpoint(match.Id, ERole.eMultimedia);
            int hr3 = policyConfig.SetDefaultEndpoint(match.Id, ERole.eCommunications);
            if (hr1 != 0 || hr2 != 0 || hr3 != 0)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"SetDefaultEndpoint failed hr=0x" + (hr1 | hr2 | hr3).ToString("X8") + "\"}");
                return 1;
            }

            Console.WriteLine("{\"ok\":true,\"name\":" + EscapeJson(match.Name) + ",\"id\":" + EscapeJson(match.Id) + "}");
            return 0;
        }

        private static int ToggleMute(string target)
        {
            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);
            AudioDevice dev = string.IsNullOrEmpty(target)
                ? (devices.Find(d => d.IsDefault) ?? (devices.Count > 0 ? devices[0] : null))
                : FindMatchingDevice(devices, target);

            if (dev == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Device not found\"}");
                return 1;
            }

            return SetMute(dev.Id, !dev.IsMuted);
        }

        // Endpoint potrafi na chwilę zniknąć przy przełączaniu urządzeń (USB/BT
        // rozłącza się między enumeracją a Activate) — krótki retry zamiast
        // natychmiastowego "Failed to access endpoint volume".
        private static IAudioEndpointVolume ActivateEndpointVolume(string deviceId, out int hr)
        {
            hr = unchecked((int)0x80004005); // E_FAIL
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    IMMDeviceEnumerator enumerator = GetEnumerator();
                    IMMDevice immDev;
                    if (enumerator.GetDevice(deviceId, out immDev) == 0 && immDev != null)
                    {
                        Guid iid = IID_IAudioEndpointVolume;
                        object epvObj;
                        hr = immDev.Activate(ref iid, 1, IntPtr.Zero, out epvObj);
                        if (hr == 0 && epvObj != null)
                        {
                            IAudioEndpointVolume epv = epvObj as IAudioEndpointVolume;
                            if (epv != null) return epv;
                        }
                        // E_NOINTERFACE = urządzenie (np. BT "Chat"/telefon) NIE wspiera
                        // IAudioEndpointVolume w ogóle — retry nic nie da, przerywamy.
                        if (hr == unchecked((int)0x80004002)) break;
                    }
                    else
                    {
                        hr = unchecked((int)0x80070490); // HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
                    }
                }
                catch (Exception ex)
                {
                    hr = Marshal.GetHRForException(ex);
                }
                System.Threading.Thread.Sleep(150);
            }
            return null;
        }

        private static int SetMute(string target, bool mute)
        {
            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);
            AudioDevice dev = string.IsNullOrEmpty(target)
                ? (devices.Find(d => d.IsDefault) ?? (devices.Count > 0 ? devices[0] : null))
                : FindMatchingDevice(devices, target);

            if (dev == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Device not found\"}");
                return 1;
            }

            int hrAct = 0;
            try
            {
                IAudioEndpointVolume epv = ActivateEndpointVolume(dev.Id, out hrAct);
                if (epv != null)
                {
                    Guid ctx = Guid.Empty;
                    int hrMute = epv.SetMute(mute, ref ctx);
                    if (hrMute != 0)
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"SetMute failed hr=0x" + hrMute.ToString("X8") + "\"}");
                        return 1;
                    }
                    Console.WriteLine("{\"ok\":true,\"isMuted\":" + (mute ? "true" : "false") + ",\"id\":" + EscapeJson(dev.Id) + "}");
                    return 0;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":" + EscapeJson(ex.Message) + "}");
                return 1;
            }

            Console.Error.WriteLine("{\"ok\":false,\"error\":" + (hrAct == unchecked((int)0x80004002) ? EscapeJson("Device does not support volume/mute control (E_NOINTERFACE)") : EscapeJson("Failed to access endpoint volume hr=0x" + hrAct.ToString("X8"))) + "}");
            return 1;
        }

        private static int SetVolume(string target, float scalar)
        {
            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);
            AudioDevice dev = string.IsNullOrEmpty(target)
                ? (devices.Find(d => d.IsDefault) ?? (devices.Count > 0 ? devices[0] : null))
                : FindMatchingDevice(devices, target);

            if (dev == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Device not found\"}");
                return 1;
            }

            int hrAct = 0;
            try
            {
                IAudioEndpointVolume epv = ActivateEndpointVolume(dev.Id, out hrAct);
                if (epv != null)
                {
                    Guid ctx = Guid.Empty;
                    int hrVol = epv.SetMasterVolumeLevelScalar(scalar, ref ctx);
                    if (hrVol != 0)
                    {
                        Console.Error.WriteLine("{\"ok\":false,\"error\":\"SetVolume failed hr=0x" + hrVol.ToString("X8") + "\"}");
                        return 1;
                    }
                    Console.WriteLine("{\"ok\":true,\"volume\":" + Math.Round(scalar * 100f) + ",\"id\":" + EscapeJson(dev.Id) + "}");
                    return 0;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":" + EscapeJson(ex.Message) + "}");
                return 1;
            }

            Console.Error.WriteLine("{\"ok\":false,\"error\":" + (hrAct == unchecked((int)0x80004002) ? EscapeJson("Device does not support volume/mute control (E_NOINTERFACE)") : EscapeJson("Failed to access endpoint volume hr=0x" + hrAct.ToString("X8"))) + "}");
            return 1;
        }

        private static int GetVolume(string target)
        {
            string defCon, defComm;
            var devices = EnumerateRecordingDevices(out defCon, out defComm);
            AudioDevice dev = string.IsNullOrEmpty(target)
                ? (devices.Find(d => d.IsDefault) ?? (devices.Count > 0 ? devices[0] : null))
                : FindMatchingDevice(devices, target);

            if (dev == null)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":\"Device not found\"}");
                return 1;
            }

            int hrAct = 0;
            float scalar;
            try
            {
                IAudioEndpointVolume epv = ActivateEndpointVolume(dev.Id, out hrAct);
                if (epv != null && epv.GetMasterVolumeLevelScalar(out scalar) == 0)
                {
                    Console.WriteLine("{\"ok\":true,\"volume\":" + Math.Round(scalar * 100f) + ",\"id\":" + EscapeJson(dev.Id) + "}");
                    return 0;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("{\"ok\":false,\"error\":" + EscapeJson(ex.Message) + "}");
                return 1;
            }

            Console.Error.WriteLine("{\"ok\":false,\"error\":" + (hrAct == unchecked((int)0x80004002) ? EscapeJson("Device does not support volume/mute control (E_NOINTERFACE)") : EscapeJson("Failed to access endpoint volume hr=0x" + hrAct.ToString("X8"))) + "}");
            return 1;
        }

        private static AudioDevice FindMatchingDevice(List<AudioDevice> devices, string target)
        {
            var match = devices.Find(d => string.Equals(d.Id, target, StringComparison.OrdinalIgnoreCase));
            if (match == null) match = devices.Find(d => string.Equals(d.Name, target, StringComparison.Ordinal));
            if (match == null) match = devices.Find(d => string.Equals(d.Name, target, StringComparison.OrdinalIgnoreCase));
            if (match == null) match = devices.Find(d => d.Name.IndexOf(target, StringComparison.OrdinalIgnoreCase) >= 0);
            return match;
        }

        private static string EscapeJson(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 4);
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
