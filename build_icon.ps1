# 生成 DSHDesktop.exe 用的图标 app.ico（深蓝色圆角方块 + 白色 "D"）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot 'app.ico'
if (Test-Path $out) { Write-Host "app.ico 已存在，跳过生成。"; exit 0 }

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角矩形参数
$margin = 16
$fw = $size - 32
$fh = $size - 32
$radius = 52
$d2 = $radius * 2

$rect = New-Object System.Drawing.Rectangle -ArgumentList @($margin, $margin, $fw, $fh)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $d2, $d2, 180, 90)
$path.AddArc($rect.Right - $d2, $rect.Y, $d2, $d2, 270, 90)
$path.AddArc($rect.Right - $d2, $rect.Bottom - $d2, $d2, $d2, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d2, $d2, $d2, 90, 90)
$path.CloseFigure()

$c1 = [System.Drawing.Color]::FromArgb(0, 120, 212)
$c2 = [System.Drawing.Color]::FromArgb(0, 60, 160)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @($rect, $c1, $c2, 45.0)
$g.FillPath($brush, $path)

# 白色 "D" 字母
$font = New-Object System.Drawing.Font('Segoe UI', 140.0, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF -ArgumentList @(0.0, 0.0, [single]$size, [single]$size)
$g.DrawString('D', $font, $white, $textRect, $sf)

# 保存为 PNG，再封装成 PNG-in-ICO（Vista 及以上支持，Win10/11 完美显示）
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()

$fs = New-Object System.IO.FileStream ($out, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter ($fs)
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type: icon
$bw.Write([UInt16]1)      # count
$bw.Write([Byte]0)        # width (0 = 256)
$bw.Write([Byte]0)        # height (0 = 256)
$bw.Write([Byte]0)        # color count
$bw.Write([Byte]0)        # reserved
$bw.Write([UInt16]1)      # planes
$bw.Write([UInt16]32)     # bit count
$bw.Write([UInt32]$png.Length)  # png data size
$bw.Write([UInt32]22)     # offset of png data
$bw.Write($png)
$bw.Close()
$fs.Close()

$sf.Dispose(); $white.Dispose(); $font.Dispose(); $brush.Dispose(); $path.Dispose()
$g.Dispose(); $bmp.Dispose()
Write-Host "已生成 $out"
