using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DeskSenseInputHook
{
    public static class Program
    {
        private const int WH_MOUSE_LL = 14;
        private const int WH_KEYBOARD_LL = 13;

        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_RBUTTONDOWN = 0x0204;
        private const int WM_MBUTTONDOWN = 0x0207;
        private const int WM_XBUTTONDOWN = 0x020B;

        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;

        private const int XBUTTON1 = 0x0001;
        private const int XBUTTON2 = 0x0002;

        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12; // Alt
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

        private static LowLevelProc _mouseProc;
        private static LowLevelProc _keyboardProc;
        private static IntPtr _mouseHookId = IntPtr.Zero;
        private static IntPtr _keyboardHookId = IntPtr.Zero;
        private static uint _mainThreadId = 0;

        private static string _voiceShortcut = "";
        private static string _muteShortcut = "";
        private static readonly object _lock = new object();
        private static bool _running = true;

        public static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;
            _mainThreadId = GetCurrentThreadId();

            if (args.Length > 0 && !string.IsNullOrEmpty(args[0]))
            {
                _voiceShortcut = NormalizeShortcut(args[0]);
            }
            if (args.Length > 1 && !string.IsNullOrEmpty(args[1]))
            {
                _muteShortcut = NormalizeShortcut(args[1]);
            }

            _mouseProc = MouseHookCallback;
            _keyboardProc = KeyboardHookCallback;

            using (Process curProcess = Process.GetCurrentProcess())
            using (ProcessModule curModule = curProcess.MainModule)
            {
                IntPtr modHandle = GetModuleHandle(curModule.ModuleName);
                _mouseHookId = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, modHandle, 0);
                _keyboardHookId = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, modHandle, 0);
            }

            if (_mouseHookId == IntPtr.Zero && _keyboardHookId == IntPtr.Zero)
            {
                Console.Error.WriteLine("{\"error\":\"Failed to install hooks\"}");
                return 1;
            }

            Console.WriteLine("{\"ready\":true,\"version\":\"1.0.0\"}");
            Console.Out.Flush();

            Thread inputThread = new Thread(ReadCommands)
            {
                IsBackground = true
            };
            inputThread.Start();

            MSG msg;
            while (_running && GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            if (_mouseHookId != IntPtr.Zero) UnhookWindowsHookEx(_mouseHookId);
            if (_keyboardHookId != IntPtr.Zero) UnhookWindowsHookEx(_keyboardHookId);

            return 0;
        }

        private static void ReadCommands()
        {
            string line;
            while (_running && (line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;

                if (line.StartsWith("voice "))
                {
                    string sc = line.Substring(6).Trim();
                    lock (_lock)
                    {
                        _voiceShortcut = NormalizeShortcut(sc);
                    }
                    Console.WriteLine("{\"ok\":true,\"voiceUpdated\":\"" + _voiceShortcut + "\"}");
                    Console.Out.Flush();
                }
                else if (line.StartsWith("mute "))
                {
                    string sc = line.Substring(5).Trim();
                    lock (_lock)
                    {
                        _muteShortcut = NormalizeShortcut(sc);
                    }
                    Console.WriteLine("{\"ok\":true,\"muteUpdated\":\"" + _muteShortcut + "\"}");
                    Console.Out.Flush();
                }
                else if (line == "quit" || line == "exit")
                {
                    _running = false;
                    PostThreadMessage(_mainThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
                    break;
                }
                else if (line == "ping")
                {
                    Console.WriteLine("{\"pong\":true}");
                    Console.Out.Flush();
                }
            }

            if (_running)
            {
                _running = false;
                PostThreadMessage(_mainThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
            }
        }

        private static string NormalizeShortcut(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "";
            string[] parts = raw.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            bool ctrl = false, alt = false, shift = false, win = false;
            string key = "";

            for (int i = 0; i < parts.Length; i++)
            {
                string p = parts[i].Trim();
                if (string.Equals(p, "ctrl", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "control", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "commandorcontrol", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "cmdorctrl", StringComparison.OrdinalIgnoreCase))
                {
                    ctrl = true;
                }
                else if (string.Equals(p, "alt", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(p, "option", StringComparison.OrdinalIgnoreCase))
                {
                    alt = true;
                }
                else if (string.Equals(p, "shift", StringComparison.OrdinalIgnoreCase))
                {
                    shift = true;
                }
                else if (string.Equals(p, "win", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(p, "super", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(p, "meta", StringComparison.OrdinalIgnoreCase))
                {
                    win = true;
                }
                else
                {
                    string k = p.ToLowerInvariant();
                    if (k == "equal" || k == "=") k = "plus";
                    else if (k == "esc") k = "escape";
                    else if (k == "enter") k = "return";
                    key = k;
                }
            }

            StringBuilder sb = new StringBuilder();
            if (ctrl) sb.Append("ctrl+");
            if (alt) sb.Append("alt+");
            if (shift) sb.Append("shift+");
            if (win) sb.Append("win+");
            sb.Append(key);
            return sb.ToString();
        }

        private static bool IsCurrentStateMatching(string normalizedTarget, string triggerKey)
        {
            if (string.IsNullOrEmpty(normalizedTarget)) return false;

            bool isCtrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
            bool isAlt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
            bool isShift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
            bool isWin = ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0) || ((GetAsyncKeyState(VK_RWIN) & 0x8000) != 0);

            StringBuilder current = new StringBuilder();
            if (isCtrl) current.Append("ctrl+");
            if (isAlt) current.Append("alt+");
            if (isShift) current.Append("shift+");
            if (isWin) current.Append("win+");
            current.Append(triggerKey.ToLowerInvariant());

            return string.Equals(normalizedTarget, current.ToString(), StringComparison.OrdinalIgnoreCase);
        }

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                string mouseButton = null;

                if (msg == WM_XBUTTONDOWN)
                {
                    MSLLHOOKSTRUCT hookStruct = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    uint xbutton = (hookStruct.mouseData >> 16) & 0xFFFF;
                    if (xbutton == XBUTTON1) mouseButton = "mouse4";
                    else if (xbutton == XBUTTON2) mouseButton = "mouse5";
                }
                else if (msg == WM_MBUTTONDOWN)
                {
                    mouseButton = "mouse3";
                }
                else if (msg == WM_RBUTTONDOWN)
                {
                    mouseButton = "mouse2";
                }
                else if (msg == WM_LBUTTONDOWN)
                {
                    mouseButton = "mouse1";
                }

                if (!string.IsNullOrEmpty(mouseButton))
                {
                    string vTarget, mTarget;
                    lock (_lock)
                    {
                        vTarget = _voiceShortcut;
                        mTarget = _muteShortcut;
                    }

                    if (!string.IsNullOrEmpty(vTarget) && IsCurrentStateMatching(vTarget, mouseButton))
                    {
                        Console.WriteLine("{\"event\":\"hotkey\",\"target\":\"voice\",\"button\":\"" + mouseButton + "\"}");
                        Console.Out.Flush();
                    }
                    else if (!string.IsNullOrEmpty(mTarget) && IsCurrentStateMatching(mTarget, mouseButton))
                    {
                        Console.WriteLine("{\"event\":\"hotkey\",\"target\":\"mute\",\"button\":\"" + mouseButton + "\"}");
                        Console.Out.Flush();
                    }
                }
            }

            return CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
        }

        private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
                {
                    KBDLLHOOKSTRUCT kbd = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    string keyName = MapVkToKeyName(kbd.vkCode);

                    if (!string.IsNullOrEmpty(keyName))
                    {
                        string vTarget, mTarget;
                        lock (_lock)
                        {
                            vTarget = _voiceShortcut;
                            mTarget = _muteShortcut;
                        }

                        // Sprawdzaj dopasowanie
                        if (!string.IsNullOrEmpty(vTarget) && IsCurrentStateMatching(vTarget, keyName))
                        {
                            Console.WriteLine("{\"event\":\"hotkey\",\"target\":\"voice\",\"key\":\"" + keyName + "\"}");
                            Console.Out.Flush();
                        }
                        else if (!string.IsNullOrEmpty(mTarget) && IsCurrentStateMatching(mTarget, keyName))
                        {
                            Console.WriteLine("{\"event\":\"hotkey\",\"target\":\"mute\",\"key\":\"" + keyName + "\"}");
                            Console.Out.Flush();
                        }
                    }
                }
            }

            return CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
        }

        private static string MapVkToKeyName(uint vk)
        {
            if (vk >= 0x70 && vk <= 0x87) return "f" + (vk - 0x70 + 1); // F1-F24
            if (vk >= 0x41 && vk <= 0x5A) return ((char)vk).ToString().ToLowerInvariant(); // A-Z
            if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString(); // 0-9
            if (vk == 0x20) return "space";
            if (vk == 0x0D) return "return";
            if (vk == 0x09) return "tab";
            if (vk == 0x08) return "backspace";
            if (vk == 0x2E) return "delete";
            if (vk == 0x2D) return "insert";
            if (vk == 0x24) return "home";
            if (vk == 0x23) return "end";
            if (vk == 0x21) return "pageup";
            if (vk == 0x22) return "pagedown";
            if (vk == 0x26) return "up";
            if (vk == 0x28) return "down";
            if (vk == 0x25) return "left";
            if (vk == 0x27) return "right";
            if (vk == 0x1B) return "escape";
            if (vk >= 0x60 && vk <= 0x69) return "num" + (vk - 0x60);
            if (vk == 0x6A) return "nummult";
            if (vk == 0x6B) return "numadd";
            if (vk == 0x6D) return "numsub";
            if (vk == 0x6E) return "numdec";
            if (vk == 0x6F) return "numdiv";
            // OEM Punctuation keys
            if (vk == 0xC0) return "`";
            if (vk == 0xBD) return "-";
            if (vk == 0xBB) return "plus";
            if (vk == 0xDB) return "[";
            if (vk == 0xDD) return "]";
            if (vk == 0xDC) return "\\";
            if (vk == 0xBA) return ";";
            if (vk == 0xDE) return "'";
            if (vk == 0xBC) return ",";
            if (vk == 0xBE) return ".";
            if (vk == 0xBF) return "/";
            // Media keys
            if (vk == 0xAD) return "volumemute";
            if (vk == 0xAE) return "volumedown";
            if (vk == 0xAF) return "volumeup";
            if (vk == 0xB3) return "mediaplaypause";
            if (vk == 0xB0) return "medianexttrack";
            if (vk == 0xB1) return "mediaprevtrack";
            return "";
        }
    }
}
