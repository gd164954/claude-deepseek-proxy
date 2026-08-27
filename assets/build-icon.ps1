param(
  [string]$InputPng = (Join-Path $PSScriptRoot "DeepSeekProxyManager-icon-mask.png"),
  [string]$OutputPng = (Join-Path $PSScriptRoot "DeepSeekProxyManager-icon.png"),
  [string]$OutputIco = (Join-Path $PSScriptRoot "DeepSeekProxyManager.ico"),
  [string]$PreviewPng = (Join-Path $PSScriptRoot "DeepSeekProxyManager-icon-sizes.png"),
  [switch]$PreserveInputColors
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not ("DeepSeekProxy.IconPaletteRenderer" -as [type])) {
  Add-Type -ReferencedAssemblies @("System.Drawing", "System.Core") -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;

namespace DeepSeekProxy
{
    public static class IconPaletteRenderer
    {
        // Clockwise from the top: medium gray, near black, dark gray,
        // medium gray, light gray, near white, light gray, and soft gray.
        // This creates the approved lower-left-light to upper-right-deep
        // monochrome progression while keeping every segment distinct.
        private static readonly Color[] SegmentColors = new[]
        {
            Color.FromArgb(0x6D, 0x6D, 0x6D),
            Color.FromArgb(0x08, 0x08, 0x08),
            Color.FromArgb(0x19, 0x19, 0x19),
            Color.FromArgb(0x81, 0x81, 0x81),
            Color.FromArgb(0xDE, 0xDE, 0xDE),
            Color.FromArgb(0xF4, 0xF4, 0xF4),
            Color.FromArgb(0xF0, 0xF0, 0xF0),
            Color.FromArgb(0xD4, 0xD4, 0xD4)
        };

        public static Bitmap FillCanvas(Bitmap input)
        {
            int minX = input.Width;
            int minY = input.Height;
            int maxX = -1;
            int maxY = -1;
            for (int y = 0; y < input.Height; y++)
            {
                for (int x = 0; x < input.Width; x++)
                {
                    if (input.GetPixel(x, y).A == 0) continue;
                    minX = Math.Min(minX, x);
                    minY = Math.Min(minY, y);
                    maxX = Math.Max(maxX, x);
                    maxY = Math.Max(maxY, y);
                }
            }

            if (maxX < minX || maxY < minY)
            {
                return new Bitmap(input);
            }

            Bitmap output = new Bitmap(input.Width, input.Height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(output))
            using (ImageAttributes attributes = new ImageAttributes())
            {
                const double subjectScale = 0.93;
                int targetWidth = Math.Max(1, (int)Math.Round(input.Width * subjectScale));
                int targetHeight = Math.Max(1, (int)Math.Round(input.Height * subjectScale));
                if (((input.Width - targetWidth) & 1) != 0 && targetWidth < input.Width) targetWidth++;
                if (((input.Height - targetHeight) & 1) != 0 && targetHeight < input.Height) targetHeight++;
                int targetX = (input.Width - targetWidth) / 2;
                int targetY = (input.Height - targetHeight) / 2;

                graphics.Clear(Color.Transparent);
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                graphics.DrawImage(
                    input,
                    new Rectangle(targetX, targetY, targetWidth, targetHeight),
                    minX,
                    minY,
                    maxX - minX + 1,
                    maxY - minY + 1,
                    GraphicsUnit.Pixel,
                    attributes);
            }
            return output;
        }

        public static Bitmap Render(Bitmap input)
        {
            int width = input.Width;
            int height = input.Height;
            Bitmap source = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(source))
            {
                graphics.Clear(Color.Transparent);
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.DrawImageUnscaled(input, 0, 0);
            }

            Rectangle bounds = new Rectangle(0, 0, width, height);
            BitmapData sourceData = source.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            int stride = sourceData.Stride;
            byte[] sourceBytes = new byte[stride * height];
            Marshal.Copy(sourceData.Scan0, sourceBytes, 0, sourceBytes.Length);
            source.UnlockBits(sourceData);
            source.Dispose();

            int pixelCount = width * height;
            int[] labels = new int[pixelCount];
            int[] queue = new int[pixelCount];
            List<int> componentSizes = new List<int>();
            int component = 0;

            // Preserve the eight large ring segments and discard tiny generation
            // artifacts that may exist in transparent gaps in the original PNG.
            for (int position = 0; position < pixelCount; position++)
            {
                int x = position % width;
                int y = position / width;
                int byteOffset = (y * stride) + (x * 4);
                if (labels[position] != 0 || sourceBytes[byteOffset + 3] < 64)
                {
                    continue;
                }

                component++;
                int head = 0;
                int tail = 0;
                int size = 0;
                labels[position] = component;
                queue[tail++] = position;

                while (head < tail)
                {
                    int current = queue[head++];
                    int currentX = current % width;
                    int currentY = current / width;
                    size++;

                    if (currentX > 0) AddNeighbor(current - 1, component, width, stride, sourceBytes, labels, queue, ref tail);
                    if (currentX + 1 < width) AddNeighbor(current + 1, component, width, stride, sourceBytes, labels, queue, ref tail);
                    if (currentY > 0) AddNeighbor(current - width, component, width, stride, sourceBytes, labels, queue, ref tail);
                    if (currentY + 1 < height) AddNeighbor(current + width, component, width, stride, sourceBytes, labels, queue, ref tail);
                }

                componentSizes.Add(size);
            }

            bool[] keep = new bool[component + 1];
            foreach (int label in Enumerable.Range(1, component)
                .OrderByDescending(label => componentSizes[label - 1])
                .Take(8))
            {
                keep[label] = true;
            }

            byte[] outputBytes = new byte[sourceBytes.Length];
            double centerX = (width - 1) / 2.0;
            double centerY = (height - 1) / 2.0;
            for (int position = 0; position < pixelCount; position++)
            {
                int x = position % width;
                int y = position / width;
                int byteOffset = (y * stride) + (x * 4);
                byte alpha = sourceBytes[byteOffset + 3];
                if (alpha == 0 || !IsNearKeptCore(position, width, height, labels, keep))
                {
                    continue;
                }

                double angle = Math.Atan2(y - centerY, x - centerX) * 180.0 / Math.PI;
                double normalized = (angle + 112.5) % 360.0;
                if (normalized < 0) normalized += 360.0;
                int segment = (int)Math.Floor(normalized / 45.0) % 8;
                Color baseColor = SegmentColors[segment];

                double xRatio = width > 1 ? x / (double)(width - 1) : 0.5;
                double yRatio = height > 1 ? y / (double)(height - 1) : 0.5;
                double highlight = 0.02 + (0.10 * (((1.0 - xRatio) * 0.55) + ((1.0 - yRatio) * 0.45)));

                outputBytes[byteOffset] = Lift(baseColor.B, highlight);
                outputBytes[byteOffset + 1] = Lift(baseColor.G, highlight);
                outputBytes[byteOffset + 2] = Lift(baseColor.R, highlight);
                outputBytes[byteOffset + 3] = alpha;
            }

            Bitmap output = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData outputData = output.LockBits(bounds, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(outputBytes, 0, outputData.Scan0, outputBytes.Length);
            output.UnlockBits(outputData);
            return output;
        }

        private static void AddNeighbor(
            int position,
            int component,
            int width,
            int stride,
            byte[] sourceBytes,
            int[] labels,
            int[] queue,
            ref int tail)
        {
            if (labels[position] != 0) return;
            int x = position % width;
            int y = position / width;
            if (sourceBytes[(y * stride) + (x * 4) + 3] < 64) return;
            labels[position] = component;
            queue[tail++] = position;
        }

        private static bool IsNearKeptCore(int position, int width, int height, int[] labels, bool[] keep)
        {
            int originX = position % width;
            int originY = position / width;
            for (int y = Math.Max(0, originY - 2); y <= Math.Min(height - 1, originY + 2); y++)
            {
                for (int x = Math.Max(0, originX - 2); x <= Math.Min(width - 1, originX + 2); x++)
                {
                    int label = labels[(y * width) + x];
                    if (label > 0 && keep[label]) return true;
                }
            }
            return false;
        }

        private static byte Lift(byte channel, double amount)
        {
            return (byte)Math.Round(channel + ((255 - channel) * amount));
        }
    }
}
"@
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$inputSource = [Drawing.Bitmap]::new((Resolve-Path -LiteralPath $InputPng).Path)
$normalizedSource = [DeepSeekProxy.IconPaletteRenderer]::FillCanvas($inputSource)
$inputSource.Dispose()
$inputSource = $null
$source = $null
$temporaryPng = "$OutputPng.recoloring.png"
if ($PreserveInputColors) {
  $source = $normalizedSource
  $normalizedSource = $null
} else {
  $source = [DeepSeekProxy.IconPaletteRenderer]::Render($normalizedSource)
  $normalizedSource.Dispose()
  $normalizedSource = $null
}
$source.Save($temporaryPng, [Drawing.Imaging.ImageFormat]::Png)
[IO.File]::Copy($temporaryPng, $OutputPng, $true)
[IO.File]::Delete($temporaryPng)
$rendered = New-Object System.Collections.Generic.List[Drawing.Bitmap]
$payloads = New-Object System.Collections.Generic.List[byte[]]

try {
  foreach ($size in $sizes) {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bitmap.SetResolution(96, 96)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([Drawing.Color]::Transparent)
      $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($source, [Drawing.Rectangle]::new(0, 0, $size, $size))
    } finally {
      $graphics.Dispose()
    }

    $stream = [IO.MemoryStream]::new()
    try {
      $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
      $payloads.Add($stream.ToArray())
    } finally {
      $stream.Dispose()
    }
    $rendered.Add($bitmap)
  }

  $fileStream = [IO.File]::Open($OutputIco, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  $writer = [IO.BinaryWriter]::new($fileStream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $size = $sizes[$index]
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$payloads[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $payloads[$index].Length
    }
    foreach ($payload in $payloads) { $writer.Write($payload) }
  } finally {
    $writer.Dispose()
    $fileStream.Dispose()
  }

  $previewSizes = @(16, 20, 24, 32, 40, 48, 64)
  $preview = [Drawing.Bitmap]::new(680, 190, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $preview.SetResolution(96, 96)
  $previewGraphics = [Drawing.Graphics]::FromImage($preview)
  $labelFont = [Drawing.Font]::new("Microsoft YaHei UI", 9)
  $labelBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 52, 64, 84))
  try {
    $previewGraphics.Clear([Drawing.Color]::FromArgb(255, 244, 246, 250))
    $previewGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $previewGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
    for ($index = 0; $index -lt $previewSizes.Count; $index++) {
      $x = 18 + ($index * 93)
      $previewGraphics.DrawImage($rendered[$index], [Drawing.Rectangle]::new($x + 30, 8, $previewSizes[$index], $previewSizes[$index]))
      $previewGraphics.DrawImage($rendered[$index], [Drawing.Rectangle]::new($x, 80, 78, 78))
      $previewGraphics.DrawString("$($previewSizes[$index]) px", $labelFont, $labelBrush, $x + 20, 164)
    }
    $preview.Save($PreviewPng, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $labelBrush.Dispose()
    $labelFont.Dispose()
    $previewGraphics.Dispose()
    $preview.Dispose()
  }
} finally {
  foreach ($bitmap in $rendered) { $bitmap.Dispose() }
  if ($source) { $source.Dispose() }
  if ($normalizedSource) { $normalizedSource.Dispose() }
  if ($inputSource) { $inputSource.Dispose() }
  if ([IO.File]::Exists($temporaryPng)) { [IO.File]::Delete($temporaryPng) }
}

if (-not $PreserveInputColors) {
  Write-Host "Applied palette: monochrome, lower-left light to upper-right deep"
}
Write-Host "Built source PNG: $OutputPng"
Write-Host "Built icon: $OutputIco"
Write-Host "Built preview: $PreviewPng"
