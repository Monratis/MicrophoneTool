using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace IconGen
{
    class Program
    {
        static void Main(string[] args)
        {
            string outDir = args.Length > 0 ? args[0] : "build";
            Directory.CreateDirectory(outDir);
            Directory.CreateDirectory("resources");

            // 1. Generate High-Res 512x512 Master App Icon
            int masterSize = 512;
            using (var masterBmp = new Bitmap(masterSize, masterSize, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(masterBmp))
            {
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.Clear(Color.Transparent);

                DrawModernAppIcon(g, masterSize);

                // Save 256x256 and 512x512 PNGs
                string pngPath = Path.Combine(outDir, "icon.png");
                using (var icon256 = ResizeBitmap(masterBmp, 256, 256))
                {
                    icon256.Save(pngPath, ImageFormat.Png);
                    Console.WriteLine("Saved: " + pngPath);

                    string resIcon = Path.Combine("resources", "icon.png");
                    icon256.Save(resIcon, ImageFormat.Png);
                    Console.WriteLine("Saved: " + resIcon);
                }

                // Save multi-resolution ICO (256, 128, 64, 48, 32, 16)
                string icoPath = Path.Combine(outDir, "icon.ico");
                SaveAsMultiResIcon(masterBmp, icoPath);
                Console.WriteLine("Saved: " + icoPath);

                string resIco = Path.Combine("resources", "icon.ico");
                SaveAsMultiResIcon(masterBmp, resIco);
                Console.WriteLine("Saved: " + resIco);
            }

            // 2. Generate System Tray Icons (Crisp 32x32 and 64x64)
            GenerateTrayIcon("resources/tray-desk.png", TrayState.Desk);
            GenerateTrayIcon("resources/tray-away.png", TrayState.Away);
            GenerateTrayIcon("resources/tray-default.png", TrayState.Default);
            Console.WriteLine("Tray icons generated in resources/");
        }

        private static void DrawModernAppIcon(Graphics g, int size)
        {
            float scale = size / 512f;

            // --- 1. Background Squircle with Vibrant Gradient ---
            float pad = 24 * scale;
            float boxSize = size - (pad * 2);
            float radius = 108 * scale;

            using (var bgPath = CreateRoundedRectangle(pad, pad, boxSize, boxSize, radius))
            {
                // Rich multi-stop gradient background
                using (var bgGrad = new LinearGradientBrush(
                    new PointF(pad, pad),
                    new PointF(size - pad, size - pad),
                    Color.FromArgb(255, 10, 25, 47),    // Deep Navy Slate #0a192f
                    Color.FromArgb(255, 4, 120, 87)))   // Vivid Emerald #047857
                {
                    ColorBlend blend = new ColorBlend(4);
                    blend.Colors = new Color[] {
                        Color.FromArgb(255, 15, 23, 42),   // Dark Slate #0f172a
                        Color.FromArgb(255, 13, 71, 71),   // Deep Teal #0d4747
                        Color.FromArgb(255, 5, 150, 105),  // Emerald #059669
                        Color.FromArgb(255, 16, 185, 129)  // Bright Emerald #10b981
                    };
                    blend.Positions = new float[] { 0f, 0.35f, 0.75f, 1f };
                    bgGrad.InterpolationColors = blend;
                    g.FillPath(bgGrad, bgPath);
                }

                // Inner glow overlay
                using (var innerGlow = new LinearGradientBrush(
                    new PointF(pad, pad),
                    new PointF(pad, size - pad),
                    Color.FromArgb(90, 56, 189, 248),  // Sky cyan glow at top
                    Color.FromArgb(0, 0, 0, 0)))
                {
                    g.FillPath(innerGlow, bgPath);
                }

                // Outer crisp glowing border
                using (var borderPen = new Pen(Color.FromArgb(220, 52, 211, 153), 7f * scale))
                {
                    g.DrawPath(borderPen, bgPath);
                }

                // Subtle inner top specular highlight rim
                using (var rimPen = new Pen(Color.FromArgb(120, 255, 255, 255), 2.5f * scale))
                {
                    using (var rimPath = CreateRoundedRectangle(pad + 4 * scale, pad + 4 * scale, boxSize - 8 * scale, boxSize - 8 * scale, radius - 4 * scale))
                    {
                        g.DrawPath(rimPen, rimPath);
                    }
                }
            }

            // --- 2. Ambient Radar Waves (mmWave Presence Pulse) ---
            float cx = size / 2f;
            float cy = 215f * scale;

            DrawRadarArc(g, cx, cy, 145 * scale, 13f * scale, 125, 110, Color.FromArgb(240, 56, 189, 248));  // Cyan left
            DrawRadarArc(g, cx, cy, 145 * scale, 13f * scale, 305, 110, Color.FromArgb(240, 56, 189, 248));  // Cyan right

            DrawRadarArc(g, cx, cy, 190 * scale, 10f * scale, 132, 96, Color.FromArgb(190, 52, 211, 153));  // Emerald left
            DrawRadarArc(g, cx, cy, 190 * scale, 10f * scale, 312, 96, Color.FromArgb(190, 52, 211, 153));  // Emerald right

            DrawRadarArc(g, cx, cy, 230 * scale, 7.5f * scale, 140, 80, Color.FromArgb(120, 45, 212, 191));  // Teal left
            DrawRadarArc(g, cx, cy, 230 * scale, 7.5f * scale, 320, 80, Color.FromArgb(120, 45, 212, 191));  // Teal right

            // --- 3. Studio Microphone ---
            float micW = 124 * scale;
            float micH = 175 * scale;
            float micX = cx - (micW / 2f);
            float micY = 88 * scale;
            float micRadius = micW / 2f;

            // Microphone body background shadow
            using (var shadowPath = CreateRoundedRectangle(micX - 4 * scale, micY + 4 * scale, micW + 8 * scale, micH + 8 * scale, micRadius))
            using (var shadowBrush = new SolidBrush(Color.FromArgb(80, 0, 0, 0)))
            {
                g.FillPath(shadowBrush, shadowPath);
            }

            // A) Microphone Upper Grille Capsule
            using (var micPath = CreateRoundedRectangle(micX, micY, micW, micH, micRadius))
            {
                // Metallic grille gradient
                using (var grilleGrad = new LinearGradientBrush(
                    new PointF(micX, micY),
                    new PointF(micX + micW, micY),
                    Color.FromArgb(255, 226, 232, 240),  // Light silver #e2e8f0
                    Color.FromArgb(255, 51, 65, 85)))    // Slate #334155
                {
                    ColorBlend micBlend = new ColorBlend(4);
                    micBlend.Colors = new Color[] {
                        Color.FromArgb(255, 203, 213, 225), // #cbd5e1
                        Color.FromArgb(255, 255, 255, 255), // #ffffff highlight
                        Color.FromArgb(255, 148, 163, 184), // #94a3b8
                        Color.FromArgb(255, 71, 85, 105)    // #475569
                    };
                    micBlend.Positions = new float[] { 0f, 0.3f, 0.7f, 1f };
                    grilleGrad.InterpolationColors = micBlend;
                    g.FillPath(grilleGrad, micPath);
                }

                // Grille mesh horizontal slots
                float[] grilleYs = new float[] { 118, 138, 158, 178 };
                using (var slotPen = new Pen(Color.FromArgb(170, 15, 23, 42), 4.5f * scale))
                using (var slotHiPen = new Pen(Color.FromArgb(160, 255, 255, 255), 2f * scale))
                {
                    slotPen.StartCap = LineCap.Round;
                    slotPen.EndCap = LineCap.Round;
                    slotHiPen.StartCap = LineCap.Round;
                    slotHiPen.EndCap = LineCap.Round;

                    foreach (float gy in grilleYs)
                    {
                        float yScaled = gy * scale;
                        g.DrawLine(slotPen, micX + 22 * scale, yScaled, micX + micW - 22 * scale, yScaled);
                        g.DrawLine(slotHiPen, micX + 24 * scale, yScaled + 2.5f * scale, micX + micW - 24 * scale, yScaled + 2.5f * scale);
                    }
                }
            }

            // B) Glowing LED Ring / Status Collar
            float ringY = 196 * scale;
            float ringH = 15 * scale;
            using (var ringBrush = new LinearGradientBrush(
                new PointF(micX, ringY),
                new PointF(micX + micW, ringY),
                Color.FromArgb(255, 14, 165, 233),   // Sky #0ea5e9
                Color.FromArgb(255, 16, 185, 129)))  // Emerald #10b981
            {
                g.FillRectangle(ringBrush, micX + 1, ringY, micW - 2, ringH);
            }
            using (var ringHi = new Pen(Color.FromArgb(230, 255, 255, 255), 2.5f * scale))
            {
                g.DrawLine(ringHi, micX + 16 * scale, ringY + ringH / 2f, micX + micW - 16 * scale, ringY + ringH / 2f);
            }

            // C) Microphone Lower Metallic Body
            float lowerY = ringY + ringH;
            float lowerH = (micY + micH) - lowerY;
            using (var lowerPath = new GraphicsPath())
            {
                lowerPath.AddArc(micX, micY + micH - micRadius * 2, micRadius * 2, micRadius * 2, 90, 90);
                lowerPath.AddLine(micX, micY + micH - micRadius, micX, lowerY);
                lowerPath.AddLine(micX, lowerY, micX + micW, lowerY);
                lowerPath.AddLine(micX + micW, lowerY, micX + micW, micY + micH - micRadius);
                lowerPath.AddArc(micX + micW - micRadius * 2, micY + micH - micRadius * 2, micRadius * 2, micRadius * 2, 0, 90);
                lowerPath.CloseFigure();

                using (var lowerGrad = new LinearGradientBrush(
                    new PointF(micX, lowerY),
                    new PointF(micX + micW, lowerY),
                    Color.FromArgb(255, 30, 41, 59),
                    Color.FromArgb(255, 15, 23, 42)))
                {
                    ColorBlend lowBlend = new ColorBlend(4);
                    lowBlend.Colors = new Color[] {
                        Color.FromArgb(255, 51, 65, 85),
                        Color.FromArgb(255, 100, 116, 139),
                        Color.FromArgb(255, 30, 41, 59),
                        Color.FromArgb(255, 15, 23, 42)
                    };
                    lowBlend.Positions = new float[] { 0f, 0.35f, 0.75f, 1f };
                    lowerGrad.InterpolationColors = lowBlend;
                    g.FillPath(lowerGrad, lowerPath);
                }
            }

            // Microphone border outline
            using (var micBorder = new Pen(Color.FromArgb(255, 255, 255, 255), 4.5f * scale))
            {
                using (var micPath = CreateRoundedRectangle(micX, micY, micW, micH, micRadius))
                {
                    g.DrawPath(micBorder, micPath);
                }
            }

            // --- 4. Chrome Suspension Cradle & Stand ---
            float cradleRadius = 104 * scale;
            float cradleTopY = 175 * scale;
            float cradlePenW = 16 * scale;

            // Curved U-stand
            using (var cradlePen = new Pen(Color.FromArgb(255, 248, 250, 252), cradlePenW))
            {
                cradlePen.StartCap = LineCap.Round;
                cradlePen.EndCap = LineCap.Round;

                // U-cradle arc
                g.DrawArc(cradlePen, cx - cradleRadius, cradleTopY, cradleRadius * 2, cradleRadius * 2, 0, 180);

                // Mount pivot knobs on sides
                using (var knobBrush = new SolidBrush(Color.FromArgb(255, 255, 255, 255)))
                {
                    float knobSz = 22 * scale;
                    g.FillEllipse(knobBrush, cx - cradleRadius - knobSz / 2f, cradleTopY + cradleRadius - knobSz / 2f, knobSz, knobSz);
                    g.FillEllipse(knobBrush, cx + cradleRadius - knobSz / 2f, cradleTopY + cradleRadius - knobSz / 2f, knobSz, knobSz);
                }

                // Vertical Stem
                float stemTopY = cradleTopY + cradleRadius * 2;
                float stemBottomY = 416 * scale;
                g.DrawLine(cradlePen, cx, stemTopY - 8 * scale, cx, stemBottomY);

                // Weighted Base (Curved Pill)
                float baseW = 160 * scale;
                float baseH = 24 * scale;
                using (var basePath = CreateRoundedRectangle(cx - baseW / 2f, stemBottomY - baseH / 2f, baseW, baseH, baseH / 2f))
                using (var baseBrush = new LinearGradientBrush(
                    new PointF(cx - baseW / 2f, stemBottomY),
                    new PointF(cx + baseW / 2f, stemBottomY),
                    Color.FromArgb(255, 226, 232, 240),
                    Color.FromArgb(255, 255, 255, 255)))
                {
                    g.FillPath(baseBrush, basePath);
                    using (var baseBorder = new Pen(Color.FromArgb(255, 255, 255, 255), 3f * scale))
                    {
                        g.DrawPath(baseBorder, basePath);
                    }
                }
            }
        }

        private static void DrawRadarArc(Graphics g, float cx, float cy, float radius, float penWidth, float startAngle, float sweepAngle, Color color)
        {
            using (var pen = new Pen(color, penWidth))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawArc(pen, cx - radius, cy - radius, radius * 2, radius * 2, startAngle, sweepAngle);
            }
        }

        private enum TrayState { Desk, Away, Default }

        private static void GenerateTrayIcon(string filePath, TrayState state)
        {
            int size = 64; // Master 64x64 downsampled for crisp tray
            using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.Clear(Color.Transparent);

                // Background rounded badge
                float pad = 4f;
                float bSize = size - pad * 2;
                float r = 18f;

                Color c1, c2, borderC;
                switch (state)
                {
                    case TrayState.Desk:
                        c1 = Color.FromArgb(255, 16, 185, 129);  // Emerald #10b981
                        c2 = Color.FromArgb(255, 5, 150, 105);   // Deep Emerald #059669
                        borderC = Color.FromArgb(255, 110, 231, 183); // #6ee7b7
                        break;
                    case TrayState.Away:
                        c1 = Color.FromArgb(255, 14, 165, 233);  // Sky Blue #0ea5e9
                        c2 = Color.FromArgb(255, 2, 132, 199);   // Ocean #0284c7
                        borderC = Color.FromArgb(255, 125, 211, 252); // #7dd3fc
                        break;
                    default:
                        c1 = Color.FromArgb(255, 100, 116, 139); // Slate #64748b
                        c2 = Color.FromArgb(255, 71, 85, 105);   // #475569
                        borderC = Color.FromArgb(255, 203, 213, 225);
                        break;
                }

                using (var path = CreateRoundedRectangle(pad, pad, bSize, bSize, r))
                {
                    using (var grad = new LinearGradientBrush(new PointF(pad, pad), new PointF(size - pad, size - pad), c1, c2))
                    {
                        g.FillPath(grad, path);
                    }
                    using (var p = new Pen(borderC, 2.5f))
                    {
                        g.DrawPath(p, path);
                    }
                }

                // Crisp White Glyph
                if (state == TrayState.Desk || state == TrayState.Default)
                {
                    // Modern Studio Microphone Glyph
                    float cx = size / 2f;
                    float micW = 16f;
                    float micH = 26f;
                    float micX = cx - micW / 2f;
                    float micY = 13f;

                    // Mic Capsule
                    using (var micPath = CreateRoundedRectangle(micX, micY, micW, micH, micW / 2f))
                    using (var micBrush = new SolidBrush(Color.White))
                    {
                        g.FillPath(micBrush, micPath);
                    }

                    // Cradle
                    using (var cradlePen = new Pen(Color.White, 3.5f))
                    {
                        cradlePen.StartCap = LineCap.Round;
                        cradlePen.EndCap = LineCap.Round;

                        float cradleR = 13f;
                        g.DrawArc(cradlePen, cx - cradleR, micY + 8f, cradleR * 2, cradleR * 2, 0, 180);
                        // Stem
                        g.DrawLine(cradlePen, cx, micY + 8f + cradleR * 2, cx, 49f);
                        // Base
                        g.DrawLine(cradlePen, cx - 9f, 49f, cx + 9f, 49f);
                    }

                    // Presence side waves for desk
                    if (state == TrayState.Desk)
                    {
                        using (var wavePen = new Pen(Color.FromArgb(220, 255, 255, 255), 2.5f))
                        {
                            wavePen.StartCap = LineCap.Round;
                            wavePen.EndCap = LineCap.Round;
                            g.DrawArc(wavePen, cx - 21f, micY + 2f, 42f, 42f, 130, 100);
                            g.DrawArc(wavePen, cx - 21f, micY + 2f, 42f, 42f, 310, 100);
                        }
                    }
                }
                else
                {
                    // Headset Glyph for Away / Headset
                    float cx = size / 2f;
                    float cy = 28f;
                    using (var headPen = new Pen(Color.White, 4f))
                    {
                        headPen.StartCap = LineCap.Round;
                        headPen.EndCap = LineCap.Round;

                        // Headband arch
                        g.DrawArc(headPen, cx - 16f, cy - 14f, 32f, 30f, 180, 180);
                    }

                    // Ear cups
                    using (var cupBrush = new SolidBrush(Color.White))
                    {
                        using (var lCup = CreateRoundedRectangle(cx - 20f, cy - 2f, 8f, 16f, 4f))
                        using (var rCup = CreateRoundedRectangle(cx + 12f, cy - 2f, 8f, 16f, 4f))
                        {
                            g.FillPath(cupBrush, lCup);
                            g.FillPath(cupBrush, rCup);
                        }
                    }

                    // Mic boom
                    using (var boomPen = new Pen(Color.White, 3f))
                    {
                        boomPen.StartCap = LineCap.Round;
                        boomPen.EndCap = LineCap.Round;
                        g.DrawArc(boomPen, cx - 18f, cy + 2f, 22f, 16f, 45, 90);
                    }
                    using (var micTipBrush = new SolidBrush(Color.White))
                    {
                        g.FillEllipse(micTipBrush, cx - 2f, cy + 15f, 5f, 5f);
                    }
                }

                // Save as crisp 32x32 PNG for Tray
                using (var tray32 = ResizeBitmap(bmp, 32, 32))
                {
                    tray32.Save(filePath, ImageFormat.Png);
                }
            }
        }

        private static Bitmap ResizeBitmap(Bitmap src, int width, int height)
        {
            var dest = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(dest))
            {
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.DrawImage(src, 0, 0, width, height);
            }
            return dest;
        }

        private static GraphicsPath CreateRoundedRectangle(float x, float y, float width, float height, float radius)
        {
            var path = new GraphicsPath();
            float diameter = radius * 2;
            path.AddArc(x, y, diameter, diameter, 180, 90);
            path.AddArc(x + width - diameter, y, diameter, diameter, 270, 90);
            path.AddArc(x + width - diameter, y + height - diameter, diameter, diameter, 0, 90);
            path.AddArc(x, y + height - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void SaveAsMultiResIcon(Bitmap src, string filePath)
        {
            int[] sizes = new int[] { 256, 128, 64, 48, 32, 16 };
            using (var ms = new MemoryStream())
            using (var bw = new BinaryWriter(ms))
            {
                bw.Write((short)0);      // Reserved
                bw.Write((short)1);      // Type: 1 = ICO
                bw.Write((short)sizes.Length); // Image count

                int offset = 6 + (16 * sizes.Length);
                byte[][] rawBuffers = new byte[sizes.Length][];

                for (int i = 0; i < sizes.Length; i++)
                {
                    int sz = sizes[i];
                    using (var resized = ResizeBitmap(src, sz, sz))
                    {
                        using (var imgMs = new MemoryStream())
                        {
                            if (sz >= 64)
                            {
                                // 256, 128, 64 as PNG (modern Windows Vista+ format)
                                resized.Save(imgMs, ImageFormat.Png);
                            }
                            else
                            {
                                // 48, 32, 16 as standard Win32 DIB
                                WriteDibIcon(resized, imgMs);
                            }
                            rawBuffers[i] = imgMs.ToArray();
                        }
                    }

                    // ICONDIRENTRY
                    bw.Write((byte)(sz >= 256 ? 0 : sz)); // Width
                    bw.Write((byte)(sz >= 256 ? 0 : sz)); // Height
                    bw.Write((byte)0);                    // ColorCount
                    bw.Write((byte)0);                    // Reserved
                    bw.Write((short)1);                   // Color planes
                    bw.Write((short)32);                  // Bits per pixel
                    bw.Write((int)rawBuffers[i].Length);  // Image bytes
                    bw.Write((int)offset);                // Offset of image data
                    offset += rawBuffers[i].Length;
                }

                for (int i = 0; i < sizes.Length; i++)
                {
                    bw.Write(rawBuffers[i]);
                }

                File.WriteAllBytes(filePath, ms.ToArray());
            }
        }

        private static void WriteDibIcon(Bitmap bmp, Stream output)
        {
            using (var bw = new BinaryWriter(output))
            {
                int w = bmp.Width;
                int h = bmp.Height;
                int andRowBytes = ((w + 31) / 32) * 4;
                int xorSize = w * h * 4;
                int andSize = andRowBytes * h;

                // BITMAPINFOHEADER (40 bytes)
                bw.Write(40);            // biSize
                bw.Write(w);             // biWidth
                bw.Write(h * 2);         // biHeight (XOR + AND mask height)
                bw.Write((short)1);      // biPlanes
                bw.Write((short)32);     // biBitCount
                bw.Write(0);             // biCompression: BI_RGB
                bw.Write(0);             // biSizeImage: 0 for BI_RGB
                bw.Write(0);             // biXPelsPerMeter
                bw.Write(0);             // biYPelsPerMeter
                bw.Write(0);             // biClrUsed
                bw.Write(0);             // biClrImportant

                // XOR mask (bottom-up BGRA)
                for (int y = h - 1; y >= 0; y--)
                {
                    for (int x = 0; x < w; x++)
                    {
                        Color c = bmp.GetPixel(x, y);
                        bw.Write(c.B);
                        bw.Write(c.G);
                        bw.Write(c.R);
                        bw.Write(c.A);
                    }
                }

                // AND mask (1 bit per pixel, bottom-up, DWORD padded)
                byte[] andMask = new byte[andSize];
                for (int y = 0; y < h; y++)
                {
                    int srcY = h - 1 - y; // bottom-up
                    int rowOffset = y * andRowBytes;
                    for (int x = 0; x < w; x++)
                    {
                        Color c = bmp.GetPixel(x, srcY);
                        if (c.A < 128)
                        {
                            andMask[rowOffset + (x / 8)] |= (byte)(0x80 >> (x % 8));
                        }
                    }
                }
                bw.Write(andMask);
            }
        }
    }
}

