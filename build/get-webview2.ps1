#Requires -Version 5.1
<#
.SYNOPSIS
  Fetch the WebView2 managed assemblies that Skadi.exe links against.
.DESCRIPTION
  Skadi's shell is a frameless WinForms window hosting WebView2, which needs
  three files that are not part of Windows:

    Microsoft.Web.WebView2.Core.dll      the managed wrapper
    Microsoft.Web.WebView2.WinForms.dll  the WinForms control
    WebView2Loader.dll                   the native loader (x64)

  The WebView2 *runtime* itself already ships with Windows 11; this only
  downloads the ~0.9 MB of glue needed to talk to it. Run once, then build.

    powershell -ExecutionPolicy Bypass -File build\get-webview2.ps1
#>
[CmdletBinding()]
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$buildDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$libDir = Join-Path $buildDir "lib"
New-Item -ItemType Directory -Force -Path $libDir | Out-Null

if (-not $Version) {
  $index = Invoke-RestMethod "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json" -TimeoutSec 30
  $Version = $index.versions | Where-Object { $_ -notmatch '-' } | Select-Object -Last 1
}

$tmp = Join-Path $env:TEMP ("skadi-wv2-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $pkg = Join-Path $tmp "wv2.zip"
  Write-Host "Downloading Microsoft.Web.WebView2 $Version ..."
  Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg" `
    -OutFile $pkg -UseBasicParsing -TimeoutSec 120
  Expand-Archive $pkg -DestinationPath (Join-Path $tmp "x") -Force

  $wanted = @{
    "lib\net462\Microsoft.Web.WebView2.Core.dll"          = "Microsoft.Web.WebView2.Core.dll"
    "lib\net462\Microsoft.Web.WebView2.WinForms.dll"      = "Microsoft.Web.WebView2.WinForms.dll"
    "runtimes\win-x64\native\WebView2Loader.dll"          = "WebView2Loader.dll"
  }
  foreach ($rel in $wanted.Keys) {
    $src = Join-Path (Join-Path $tmp "x") $rel
    if (-not (Test-Path -LiteralPath $src)) { throw "Package layout changed: missing $rel" }
    Copy-Item -LiteralPath $src -Destination (Join-Path $libDir $wanted[$rel]) -Force
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$total = (Get-ChildItem $libDir | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host ("  Staged {0} files in {1} ({2} MB)" -f (Get-ChildItem $libDir).Count, $libDir, [math]::Round($total / 1MB, 2))
Write-Host "  Now run build\build.ps1"
Write-Host ""
