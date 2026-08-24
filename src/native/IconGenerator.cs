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

            int size = 256;
            using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);

                // Background rounded squircle with gradient
                using (var path = CreateRoundedRectangle(12, 12, 232, 232, 54))
                using (var gradBrush = new LinearGradientBrush(
                    new PointF(0, 0),
                    new PointF(256, 256),
                    Color.FromArgb(255, 18, 24, 38),   // Dark Navy / Slate
                    Color.FromArgb(255, 10, 14, 23)))   // Deep Dark
                {
                    g.FillPath(gradBrush, path);

                    // Outer glowing border
                    using (var borderPen = new Pen(Color.FromArgb(120, 52, 211, 153), 4f))
                    {
                        g.DrawPath(borderPen, path);
                    }
                }

                // Audio wave accents in background
                using (var wavePen = new Pen(Color.FromArgb(40, 52, 211, 153), 3f))
                {
                    wavePen.StartCap = LineCap.Round;
                    wavePen.EndCap = LineCap.Round;
                    g.DrawArc(wavePen, 38, 70, 180, 116, 130, 100);
                    g.DrawArc(wavePen, 38, 70, 180, 116, 310, 100);
                }

                // Center microphone body with emerald gradient
                using (var micGrad = new LinearGradientBrush(
                    new PointF(96, 48),
                    new PointF(160, 140),
                    Color.FromArgb(255, 52, 211, 153),  // Emerald green
                    Color.FromArgb(255, 16, 185, 129))) // Deep emerald
                {
                    // Microphone capsule
                    using (var micPath = CreateRoundedRectangle(94, 48, 68, 100, 34))
                    {
                        g.FillPath(micGrad, micPath);
                    }
                }

                // Inner microphone grille detail
                using (var grillePen = new Pen(Color.FromArgb(160, 13, 15, 20), 3f))
                {
                    grillePen.StartCap = LineCap.Round;
                    grillePen.EndCap = LineCap.Round;
                    g.DrawLine(grillePen, 110, 75, 146, 75);
                    g.DrawLine(grillePen, 106, 92, 150, 92);
                    g.DrawLine(grillePen, 110, 109, 146, 109);
                }

                // Microphone cradle / U-bracket
                using (var cradlePen = new Pen(Color.FromArgb(255, 241, 245, 249), 10f))
                {
                    cradlePen.StartCap = LineCap.Round;
                    cradlePen.EndCap = LineCap.Round;
                    g.DrawArc(cradlePen, 72, 68, 112, 100, 0, 180);

                    // Stem down
                    g.DrawLine(cradlePen, 128, 168, 128, 196);

                    // Base horizontal bar
                    g.DrawLine(cradlePen, 98, 196, 158, 196);
                }

                // Save PNG
                string pngPath = Path.Combine(outDir, "icon.png");
                bmp.Save(pngPath, ImageFormat.Png);
                Console.WriteLine("Saved: " + pngPath);

                // Save ICO
                string icoPath = Path.Combine(outDir, "icon.ico");
                SaveAsIcon(bmp, icoPath);
                Console.WriteLine("Saved: " + icoPath);
            }
        }

        private static GraphicsPath CreateRoundedRectangle(int x, int y, int width, int height, int radius)
        {
            var path = new GraphicsPath();
            int diameter = radius * 2;
            path.AddArc(x, y, diameter, diameter, 180, 90);
            path.AddArc(x + width - diameter, y, diameter, diameter, 270, 90);
            path.AddArc(x + width - diameter, y + height - diameter, diameter, diameter, 0, 90);
            path.AddArc(x, y + height - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void SaveAsIcon(Bitmap src, string filePath)
        {
            int[] sizes = new int[] { 256, 128, 64, 48, 32, 16 };
            using (var ms = new MemoryStream())
            using (var bw = new BinaryWriter(ms))
            {
                // ICONDIR header
                bw.Write((short)0);      // Reserved
                bw.Write((short)1);      // Type: 1 = ICO
                bw.Write((short)sizes.Length); // Image count

                int offset = 6 + (16 * sizes.Length);
                byte[][] pngBuffers = new byte[sizes.Length][];

                for (int i = 0; i < sizes.Length; i++)
                {
                    int sz = sizes[i];
                    using (var resized = new Bitmap(sz, sz, PixelFormat.Format32bppArgb))
                    using (var g = Graphics.FromImage(resized))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(src, 0, 0, sz, sz);

                        using (var imgMs = new MemoryStream())
                        {
                            resized.Save(imgMs, ImageFormat.Png);
                            pngBuffers[i] = imgMs.ToArray();
                        }
                    }

                    // ICONDIRENTRY
                    bw.Write((byte)(sz == 256 ? 0 : sz)); // Width
                    bw.Write((byte)(sz == 256 ? 0 : sz)); // Height
                    bw.Write((byte)0);                    // ColorCount
                    bw.Write((byte)0);                    // Reserved
                    bw.Write((short)1);                   // Color planes
                    bw.Write((short)32);                  // Bits per pixel
                    bw.Write((int)pngBuffers[i].Length);  // Image bytes
                    bw.Write((int)offset);                // Offset of image data
                    offset += pngBuffers[i].Length;
                }

                for (int i = 0; i < sizes.Length; i++)
                {
                    bw.Write(pngBuffers[i]);
                }

                File.WriteAllBytes(filePath, ms.ToArray());
            }
        }
    }
}
