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
                using (var path = CreateRoundedRectangle(10, 10, 236, 236, 52))
                using (var gradBrush = new LinearGradientBrush(
                    new PointF(0, 0),
                    new PointF(256, 256),
                    Color.FromArgb(255, 15, 23, 42),   // Dark Slate #0f172a
                    Color.FromArgb(255, 30, 41, 59)))   // Slate #1e293b
                {
                    g.FillPath(gradBrush, path);

                    // Outer glowing emerald border
                    using (var borderPen = new Pen(Color.FromArgb(255, 16, 185, 129), 6f))
                    {
                        g.DrawPath(borderPen, path);
                    }
                }

                // Audio wave accents
                using (var wavePen = new Pen(Color.FromArgb(180, 52, 211, 153), 4.5f))
                {
                    wavePen.StartCap = LineCap.Round;
                    wavePen.EndCap = LineCap.Round;
                    g.DrawArc(wavePen, 34, 66, 188, 124, 135, 90);
                    g.DrawArc(wavePen, 34, 66, 188, 124, 315, 90);
                }

                // Center microphone body with vibrant emerald gradient
                using (var micGrad = new LinearGradientBrush(
                    new PointF(96, 44),
                    new PointF(160, 144),
                    Color.FromArgb(255, 52, 211, 153),  // Emerald #34d399
                    Color.FromArgb(255, 5, 150, 105)))  // Deep emerald #059669
                {
                    using (var micPath = CreateRoundedRectangle(92, 44, 72, 104, 36))
                    {
                        g.FillPath(micGrad, micPath);
                    }
                }

                // Microphone grille lines
                using (var grillePen = new Pen(Color.FromArgb(200, 15, 23, 42), 3.5f))
                {
                    grillePen.StartCap = LineCap.Round;
                    grillePen.EndCap = LineCap.Round;
                    g.DrawLine(grillePen, 110, 72, 146, 72);
                    g.DrawLine(grillePen, 104, 90, 152, 90);
                    g.DrawLine(grillePen, 110, 108, 146, 108);
                }

                // Microphone cradle / stand
                using (var cradlePen = new Pen(Color.FromArgb(255, 255, 255, 255), 11f))
                {
                    cradlePen.StartCap = LineCap.Round;
                    cradlePen.EndCap = LineCap.Round;
                    g.DrawArc(cradlePen, 68, 66, 120, 104, 0, 180);

                    // Stem down
                    g.DrawLine(cradlePen, 128, 170, 128, 202);

                    // Base bar
                    g.DrawLine(cradlePen, 94, 202, 162, 202);
                }

                // Save PNG
                string pngPath = Path.Combine(outDir, "icon.png");
                bmp.Save(pngPath, ImageFormat.Png);
                Console.WriteLine("Saved: " + pngPath);

                // Also save to resources/
                string resIcon = Path.Combine("resources", "icon.png");
                Directory.CreateDirectory("resources");
                bmp.Save(resIcon, ImageFormat.Png);

                // Save standard Windows ICO (with 256, 128, 64, 48, 32, 16)
                string icoPath = Path.Combine(outDir, "icon.ico");
                SaveAsMultiResIcon(bmp, icoPath);
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
                    using (var resized = new Bitmap(sz, sz, PixelFormat.Format32bppArgb))
                    using (var g = Graphics.FromImage(resized))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(src, 0, 0, sz, sz);

                        using (var imgMs = new MemoryStream())
                        {
                            if (sz == 256)
                            {
                                // 256x256 as PNG
                                resized.Save(imgMs, ImageFormat.Png);
                            }
                            else
                            {
                                // Standard Win32 DIB format (BITMAPINFOHEADER + BGRA raw bytes + AND mask)
                                WriteDibIcon(resized, imgMs);
                            }
                            rawBuffers[i] = imgMs.ToArray();
                        }
                    }

                    // ICONDIRENTRY
                    bw.Write((byte)(sz == 256 ? 0 : sz)); // Width
                    bw.Write((byte)(sz == 256 ? 0 : sz)); // Height
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

                // BITMAPINFOHEADER (40 bytes)
                bw.Write(40);            // biSize
                bw.Write(w);             // biWidth
                bw.Write(h * 2);         // biHeight (XOR + AND mask height)
                bw.Write((short)1);      // biPlanes
                bw.Write((short)32);     // biBitCount
                bw.Write(0);             // biCompression: BI_RGB
                bw.Write(w * h * 4);     // biSizeImage
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
                int andRowBytes = ((w + 31) / 32) * 4;
                byte[] andRow = new byte[andRowBytes];
                for (int y = 0; y < h; y++)
                {
                    bw.Write(andRow);
                }
            }
        }
    }
}
