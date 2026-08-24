using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace IconPatcher
{
    struct IconDirEntry
    {
        public byte bWidth;
        public byte bHeight;
        public byte bColorCount;
        public byte bReserved;
        public ushort wPlanes;
        public ushort wBitCount;
        public uint dwBytesInRes;
        public uint dwImageOffset;
    }

    class Program
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool FreeLibrary(IntPtr hModule);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

        delegate bool EnumResNamesProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern bool EnumResourceNames(IntPtr hModule, IntPtr lpszType, EnumResNamesProc lpEnumFunc, IntPtr lParam);

        const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
        static readonly IntPtr RT_ICON = (IntPtr)3;
        static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;

        static void Main(string[] args)
        {
            if (args.Length < 2)
            {
                Console.WriteLine("Usage: IconPatcher.exe <target.exe> <icon.ico>");
                return;
            }

            string exePath = Path.GetFullPath(args[0]);
            string icoPath = Path.GetFullPath(args[1]);

            if (!File.Exists(exePath))
            {
                Console.WriteLine("EXE not found: " + exePath);
                return;
            }
            if (!File.Exists(icoPath))
            {
                Console.WriteLine("ICO not found: " + icoPath);
                return;
            }

            byte[] icoBytes = File.ReadAllBytes(icoPath);

            // CRITICAL: BeginUpdateResource/EndUpdateResource rewrite the PE image and DROP
            // everything in the overlay (data after the last section). NSIS installer/portable
            // binaries store their entire compressed payload in the overlay — without saving
            // and re-appending it, the patched EXE would be truncated to a dead ~400 KB shell.
            long overlayOffset = GetOverlayOffset(exePath);
            long fileSize = new FileInfo(exePath).Length;
            byte[] overlay = null;
            if (overlayOffset < fileSize)
            {
                using (var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read))
                {
                    fs.Seek(overlayOffset, SeekOrigin.Begin);
                    overlay = new byte[fileSize - overlayOffset];
                    int totalRead = 0;
                    while (totalRead < overlay.Length)
                    {
                        int n = fs.Read(overlay, totalRead, overlay.Length - totalRead);
                        if (n <= 0) break;
                        totalRead += n;
                    }
                    Array.Resize(ref overlay, totalRead);
                }
                Console.WriteLine(string.Format("Preserved overlay: {0} bytes at offset {1}", overlay.Length, overlayOffset));
            }

            InjectIcon(exePath, icoBytes, overlay);
        }

        static long GetOverlayOffset(string exePath)
        {
            using (var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read))
            {
                if (fs.Length < 0x40) return fs.Length;
                var head = new byte[4096];
                int have = fs.Read(head, 0, head.Length);
                if (have < 0x40) return fs.Length;

                int e_lfanew = BitConverter.ToInt32(head, 0x3C);
                if (e_lfanew <= 0 || e_lfanew + 24 > have) return fs.Length;

                ushort numSections = BitConverter.ToUInt16(head, e_lfanew + 6);
                ushort optHeaderSize = BitConverter.ToUInt16(head, e_lfanew + 20);
                int sectTableStart = e_lfanew + 24 + optHeaderSize;
                int sectTableEnd = sectTableStart + numSections * 40;
                if (sectTableEnd > have)
                {
                    head = new byte[sectTableEnd];
                    fs.Position = 0;
                    have = fs.Read(head, 0, sectTableEnd);
                    if (have < sectTableEnd) return fs.Length;
                }

                long overlayStart = 0;
                for (int i = 0; i < numSections; i++)
                {
                    int s = sectTableStart + i * 40;
                    uint sizeOfRawData = BitConverter.ToUInt32(head, s + 16);
                    uint pointerToRawData = BitConverter.ToUInt32(head, s + 20);
                    long sectionEnd = (long)pointerToRawData + sizeOfRawData;
                    if (sectionEnd > overlayStart) overlayStart = sectionEnd;
                }
                return overlayStart >= fs.Length ? fs.Length : overlayStart;
            }
        }

        public static void InjectIcon(string exePath, byte[] icoBytes)
        {
            InjectIcon(exePath, icoBytes, null);
        }

        public static void InjectIcon(string exePath, byte[] icoBytes, byte[] overlayToRestore)
        {
            using (var ms = new MemoryStream(icoBytes))
            using (var br = new BinaryReader(ms))
            {
                ushort reserved = br.ReadUInt16();
                ushort type = br.ReadUInt16();
                ushort count = br.ReadUInt16();

                if (type != 1 || count == 0)
                {
                    Console.WriteLine("Invalid ICO file format");
                    return;
                }

                var entries = new IconDirEntry[count];
                for (int i = 0; i < count; i++)
                {
                    entries[i].bWidth = br.ReadByte();
                    entries[i].bHeight = br.ReadByte();
                    entries[i].bColorCount = br.ReadByte();
                    entries[i].bReserved = br.ReadByte();
                    entries[i].wPlanes = br.ReadUInt16();
                    entries[i].wBitCount = br.ReadUInt16();
                    entries[i].dwBytesInRes = br.ReadUInt32();
                    entries[i].dwImageOffset = br.ReadUInt32();
                }

                var groupNames = new List<IntPtr>();
                var rawIconNames = new List<IntPtr>();

                IntPtr hMod = LoadLibraryEx(exePath, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
                if (hMod != IntPtr.Zero)
                {
                    EnumResourceNames(hMod, RT_GROUP_ICON, (h, t, name, l) =>
                    {
                        groupNames.Add(name);
                        return true;
                    }, IntPtr.Zero);

                    EnumResourceNames(hMod, RT_ICON, (h, t, name, l) =>
                    {
                        rawIconNames.Add(name);
                        return true;
                    }, IntPtr.Zero);

                    FreeLibrary(hMod);
                }

                Console.WriteLine(string.Format("Found {0} icon groups, {1} icons in {2}", groupNames.Count, rawIconNames.Count, Path.GetFileName(exePath)));

                byte[] groupIconData;
                using (var grpMs = new MemoryStream())
                using (var grpBw = new BinaryWriter(grpMs))
                {
                    grpBw.Write((ushort)0);
                    grpBw.Write((ushort)1);
                    grpBw.Write((ushort)count);

                    for (ushort i = 0; i < count; i++)
                    {
                        grpBw.Write(entries[i].bWidth);
                        grpBw.Write(entries[i].bHeight);
                        grpBw.Write(entries[i].bColorCount);
                        grpBw.Write(entries[i].bReserved);
                        grpBw.Write(entries[i].wPlanes);
                        grpBw.Write(entries[i].wBitCount);
                        grpBw.Write(entries[i].dwBytesInRes);
                        grpBw.Write((ushort)(i + 1));
                    }

                    groupIconData = grpMs.ToArray();
                }

                IntPtr hUpdate = BeginUpdateResource(exePath, false);
                if (hUpdate == IntPtr.Zero)
                {
                    Console.WriteLine("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
                    return;
                }

                for (ushort i = 0; i < count; i++)
                {
                    ms.Seek(entries[i].dwImageOffset, SeekOrigin.Begin);
                    byte[] imgData = br.ReadBytes((int)entries[i].dwBytesInRes);

                    ushort iconId = (ushort)(i + 1);
                    UpdateResource(hUpdate, RT_ICON, (IntPtr)iconId, 0, imgData, (uint)imgData.Length);
                    UpdateResource(hUpdate, RT_ICON, (IntPtr)iconId, 1033, imgData, (uint)imgData.Length);
                    UpdateResource(hUpdate, RT_ICON, (IntPtr)iconId, 1045, imgData, (uint)imgData.Length);
                }

                var allTargetGroups = new HashSet<IntPtr>(groupNames);
                allTargetGroups.Add((IntPtr)1);
                allTargetGroups.Add((IntPtr)101);
                allTargetGroups.Add((IntPtr)103);
                allTargetGroups.Add((IntPtr)105);
                allTargetGroups.Add((IntPtr)128);
                allTargetGroups.Add((IntPtr)32512);

                foreach (var grp in allTargetGroups)
                {
                    UpdateResource(hUpdate, RT_GROUP_ICON, grp, 0, groupIconData, (uint)groupIconData.Length);
                    UpdateResource(hUpdate, RT_GROUP_ICON, grp, 1033, groupIconData, (uint)groupIconData.Length);
                    UpdateResource(hUpdate, RT_GROUP_ICON, grp, 1045, groupIconData, (uint)groupIconData.Length);
                }

                bool result = EndUpdateResource(hUpdate, false);
                if (result)
                {
                    if (overlayToRestore != null && overlayToRestore.Length > 0)
                    {
                        using (var fs = new FileStream(exePath, FileMode.Append, FileAccess.Write))
                        {
                            fs.Write(overlayToRestore, 0, overlayToRestore.Length);
                        }
                    }
                    Console.WriteLine("SUCCESS: Injected icon into " + Path.GetFileName(exePath));
                }
                else
                {
                    Console.WriteLine("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
                }
            }
        }
    }
}
