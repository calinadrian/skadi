#Requires -Version 5.1
<#
.SYNOPSIS
  Build the Skadi icon from build\skadi-icon.png.
.DESCRIPTION
  Crops the portrait to a square, rounds the corners, and writes:

    build\skadi.ico   multi-resolution icon embedded in Skadi.exe
    ui\icon.png       256px mark for the window's top bar and favicon

  Replace build\skadi-icon.png and run this to change the icon. Uses GDI+ from
  the .NET Framework, which is on every Windows install, and packs the .ico by
  hand: PNG-compressed icon entries are supported from Vista onward, so each
  size is simply a PNG.

    powershell -ExecutionPolicy Bypass -File build\make-icon.ps1
#>
[CmdletBinding()]
param(
  [string]$Source = "",
  [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$buildDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $buildDir
if (-not $Source) { $Source = Join-Path $buildDir "skadi-icon.png" }
if (-not (Test-Path -LiteralPath $Source)) { throw "Missing $Source" }

$src = [System.Drawing.Image]::FromFile($Source)
# Largest centred square. The portrait is already almost square, so this only
# trims a few pixels.
$side = [Math]::Min($src.Width, $src.Height)
$cropX = [int](($src.Width - $side) / 2)
$cropY = [int](($src.Height - $side) / 2)

function New-Mark {
  param([int]$S)
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $radius = [Math]::Max([int]($S * 0.18), 2)
  $d = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($S - $d, 0, $d, $d, 270, 90)
  $path.AddArc($S - $d, $S - $d, $d, $d, 0, 90)
  $path.AddArc(0, $S - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.SetClip($path)

  $dest = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
  $g.DrawImage($src, $dest, $cropX, $cropY, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
  $g.ResetClip()
  $g.Dispose(); $path.Dispose()
  return $bmp
}

$images = @()
foreach ($size in $Sizes) {
  $bmp = New-Mark -S $size
  $stream = New-Object System.IO.MemoryStream
  $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
  $stream.Dispose(); $bmp.Dispose()
}

# ICONDIR (6 bytes) + ICONDIRENTRY * n (16 each) + the PNG payloads.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($out)
$w.Write([UInt16]0)                 # reserved
$w.Write([UInt16]1)                 # type: icon
$w.Write([UInt16]$images.Count)
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
  $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }   # 0 means 256
  $w.Write([Byte]$dim); $w.Write([Byte]$dim)
  $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$img.Bytes.Length)
  $w.Write([UInt32]$offset)
  $offset += $img.Bytes.Length
}
foreach ($img in $images) { $w.Write($img.Bytes) }
$w.Flush()
$icoOut = Join-Path $buildDir "skadi.ico"
[System.IO.File]::WriteAllBytes($icoOut, $out.ToArray())
$w.Dispose(); $out.Dispose()

$pngOut = Join-Path $root "ui\icon.png"
$big = New-Mark -S 256
$big.Save($pngOut, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
$src.Dispose()

Write-Host ""
Write-Host "  Source $Source"
Write-Host "  Built  $icoOut ($([math]::Round((Get-Item -LiteralPath $icoOut).Length / 1KB, 1)) KB, sizes: $($Sizes -join ', '))"
Write-Host "  Built  $pngOut"
Write-Host ""
