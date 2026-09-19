#Requires -Version 5.1
<#
.SYNOPSIS
  Build Skadi.exe.
.DESCRIPTION
  Uses the C# compiler that ships with the .NET Framework on every Windows
  install, so there is nothing to download. Produces a small native launcher
  in the project root that starts Skadi with the local Node runtime.

    powershell -ExecutionPolicy Bypass -File build\build.ps1

  Pass -Icon to embed an .ico file in the executable.
#>
[CmdletBinding()]
param(
  [string]$Icon = "",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

$buildDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $buildDir
if (-not $OutFile) { $OutFile = Join-Path $root "Skadi.exe" }

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $csc)) {
  throw "Could not find csc.exe. Install the .NET Framework 4.x developer files, or build with 'dotnet build' instead."
}

$source = Join-Path $buildDir "Skadi.cs"
if (-not (Test-Path -LiteralPath $source)) { throw "Missing $source" }

# WebView2's managed wrappers, staged in build\lib. They must sit next to the
# built executable at run time as well, so the shell can load them.
$libDir = Join-Path $buildDir "lib"
$wv2 = @("Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll")
$native = "WebView2Loader.dll"
$haveWebView2 = $true
foreach ($dll in ($wv2 + $native)) {
  if (-not (Test-Path -LiteralPath (Join-Path $libDir $dll))) { $haveWebView2 = $false }
}
if (-not $haveWebView2) {
  throw "Missing WebView2 assemblies in $libDir. Run build\get-webview2.ps1 first."
}

$outDir = Split-Path -Parent $OutFile
foreach ($dll in ($wv2 + $native)) {
  Copy-Item -LiteralPath (Join-Path $libDir $dll) -Destination $outDir -Force
}

$cscArgs = @(
  "/nologo",
  # winexe, not exe: no console window flashes up when the UI is launched.
  "/target:winexe",
  "/optimize+",
  # WebView2Loader.dll is x64-only, so the shell has to be too.
  "/platform:x64",
  "/reference:System.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll"
)
foreach ($dll in $wv2) { $cscArgs += "/reference:" + (Join-Path $libDir $dll) }
$cscArgs += @("/out:$OutFile", $source)
# Default to the generated mark; build it first if it is missing.
if (-not $Icon) {
  $Icon = Join-Path $buildDir "skadi.ico"
  if (-not (Test-Path -LiteralPath $Icon)) {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $buildDir "make-icon.ps1") | Out-Null
  }
}
if ($Icon -and (Test-Path -LiteralPath $Icon)) { $cscArgs += "/win32icon:$Icon" }

Write-Host "Compiling Skadi.exe ..."
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }

$size = [math]::Round((Get-Item -LiteralPath $OutFile).Length / 1KB, 1)
Write-Host ""
Write-Host "  Built $OutFile ($size KB)"
Write-Host "  Run it from anywhere; it finds node.exe and skadi.mjs on its own."
Write-Host ""
