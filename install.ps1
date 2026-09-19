#Requires -Version 5.1
<#
.SYNOPSIS
  Install Skadi and what it needs to run.
.DESCRIPTION
  Sets up everything Skadi needs on this PC, without downloading a model:

    1. Node.js 20+           installed with winget if it is missing
    2. Skadi itself          downloaded from GitHub (skipped when run from a clone)
    3. llama.cpp engine      the BeeLlama build, with the backend for your GPU
    4. Skadi.exe             built on this PC, with Desktop and Start Menu shortcuts

  Models are chosen and downloaded inside Skadi (Local AI > Browse models),
  which shows whether a file will fit your GPU before you download it.

  Nothing needs administrator rights. Re-running it is safe: finished
  downloads are skipped, interrupted ones resume, and your config is kept.

    irm https://raw.githubusercontent.com/calinadrian/skadi/main/install.ps1 | iex

  With options:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/calinadrian/skadi/main/install.ps1))) -ModelsDir D:\models
.PARAMETER Dir
  Where Skadi goes. Default: %LOCALAPPDATA%\Skadi, or the clone this script is in.
.PARAMETER ModelsDir
  Where Skadi will look for models. Default: <Dir>\models.
.PARAMETER Backend
  vulkan (default; any GPU), cuda (NVIDIA, larger download), hip (AMD ROCm) or cpu.
.PARAMETER NoShortcuts
  Do not create Desktop and Start Menu shortcuts.
.PARAMETER NoLaunch
  Do not start Skadi when finished.
#>
[CmdletBinding()]
param(
  [string]$Dir = "",
  [string]$ModelsDir = "",
  [ValidateSet("vulkan", "cuda", "hip", "cpu")][string]$Backend = "vulkan",
  [switch]$NoShortcuts,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is ~10x faster without its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "calinadrian/skadi"
$EngineRepo = "Anbeeld/beellama.cpp"
$TemplateUrl = "https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates/resolve/main/chat_template.jinja"
$UA = @{ "User-Agent" = "Skadi-installer" }

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Warn($text) { Write-Host "    ! $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host ""; Write-Host "  x $text" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1's -Encoding UTF8 writes a byte-order mark, which JSON.parse rejects.
function Write-Text($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

function Get-Json($url) { Invoke-RestMethod -Uri $url -Headers $UA -TimeoutSec 30 }

# Big files go through curl.exe (ships with Windows 10+): it resumes an
# interrupted download and shows real progress. Written to .part and renamed
# only when complete, so a half-finished file is never mistaken for a model.
function Get-File($url, $dest, [long]$expected = 0) {
  if ((Test-Path -LiteralPath $dest) -and ($expected -le 0 -or (Get-Item -LiteralPath $dest).Length -eq $expected)) {
    Info "already have $(Split-Path -Leaf $dest)"
    return
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  $part = "$dest.part"
  Info "downloading $(Split-Path -Leaf $dest)"
  & curl.exe -L --fail --retry 5 --retry-delay 3 -C - --progress-bar -H "User-Agent: Skadi-installer" -o $part $url
  if ($LASTEXITCODE -ne 0) { Fail "Download failed: $url" }
  if ($expected -gt 0 -and (Get-Item -LiteralPath $part).Length -ne $expected) {
    Fail "$(Split-Path -Leaf $dest) is the wrong size ($((Get-Item -LiteralPath $part).Length) bytes, expected $expected). Run the installer again to resume."
  }
  Move-Item -LiteralPath $part -Destination $dest -Force
}

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host ""
Write-Host "  Skadi installer" -ForegroundColor White
Write-Host "  a local-AI coding harness for llama.cpp on Windows"

if ($env:OS -ne "Windows_NT") { Fail "Skadi runs on Windows." }

# ---------------------------------------------------------------- where -----
$here = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { "" }
$inClone = $here -and (Test-Path -LiteralPath (Join-Path $here "skadi.mjs"))
if (-not $Dir) { $Dir = if ($inClone) { $here } else { Join-Path $env:LOCALAPPDATA "Skadi" } }
$Dir = [IO.Path]::GetFullPath($Dir)
if (-not $ModelsDir) { $ModelsDir = Join-Path $Dir "models" }
$ModelsDir = [IO.Path]::GetFullPath($ModelsDir)
$engineDir = Join-Path $Dir "engine"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# ----------------------------------------------------------------- node -----
Step "Node.js"
function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  $v = (& node --version) -replace "^v", ""
  return [int]($v.Split(".")[0])
}
$major = Get-NodeMajor
if ($major -lt 20) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "Node.js 20 or newer is required and winget is not available to install it. Get it from https://nodejs.org, then run this again."
  }
  Info "installing Node.js LTS with winget"
  & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  Refresh-Path
  $major = Get-NodeMajor
  if ($major -lt 20) { Fail "Node.js was installed but is not on PATH yet. Open a new terminal and run this again." }
}
Info "node $(& node --version)"
if ($major -lt 22) { Warn "Node 22+ is needed for the embedded review browser. Skadi runs without it." }

# ------------------------------------------------------------------ app -----
Step "Skadi"
if ($inClone -and ($Dir -eq $here)) {
  Info "using this clone: $Dir"
} else {
  $head = Get-Json "https://api.github.com/repos/$Repo/commits/main"
  $zip = Join-Path $env:TEMP "skadi-$($head.sha).zip"
  $stage = Join-Path $env:TEMP "skadi-$($head.sha)"
  Info "downloading $($head.sha.Substring(0, 7))"
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/$($head.sha)" -Headers $UA -OutFile $zip
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
  $tree = Get-ChildItem $stage -Directory | Select-Object -First 1
  # Release files only: an existing install keeps its config, chats and keys.
  Copy-Item -Path (Join-Path $tree.FullName "*") -Destination $Dir -Recurse -Force
  Remove-Item $zip, $stage -Recurse -Force -ErrorAction SilentlyContinue
  $ver = (Get-Content (Join-Path $Dir "package.json") -Raw | ConvertFrom-Json).version
  @{ sha = $head.sha; version = $ver; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
    ConvertTo-Json | ForEach-Object { Write-Text (Join-Path $Dir ".skadi-version.json") $_ }
  Info "installed to $Dir"
}

# --------------------------------------------------------------- engine -----
Step "llama.cpp engine ($Backend)"
if (Test-Path (Join-Path $engineDir "llama-server.exe")) {
  Info "already installed: $engineDir"
} else {
  $rel = Get-Json "https://api.github.com/repos/$EngineRepo/releases/latest"
  $pattern = switch ($Backend) {
    "cuda"   { "bin-win-cuda-12\.4-x64\.zip$" }
    "hip"    { "bin-win-hip-radeon-x64\.zip$" }
    "cpu"    { "bin-win-cpu-x64\.zip$" }
    default  { "bin-win-vulkan-x64\.zip$" }
  }
  $asset = $rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { Fail "No Windows $Backend build in $EngineRepo $($rel.tag_name)." }
  $stageEngine = Join-Path $env:TEMP "skadi-engine"
  if (Test-Path $stageEngine) { Remove-Item $stageEngine -Recurse -Force }
  $files = @($asset)
  # The CUDA runtime DLLs ship as a separate archive.
  if ($Backend -eq "cuda") { $files += @($rel.assets | Where-Object { $_.name -match "^beellama-.*-cudart-win-cuda-12\.4-x64\.zip$" }) }
  foreach ($f in $files) {
    $z = Join-Path $env:TEMP $f.name
    Get-File $f.browser_download_url $z ([long]$f.size)
    Expand-Archive -LiteralPath $z -DestinationPath $stageEngine -Force
    Remove-Item $z -Force
  }
  $exe = Get-ChildItem $stageEngine -Recurse -Filter "llama-server.exe" | Select-Object -First 1
  if (-not $exe) { Fail "The engine download did not contain llama-server.exe." }
  New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
  Copy-Item -Path (Join-Path $exe.DirectoryName "*") -Destination $engineDir -Recurse -Force
  Remove-Item $stageEngine -Recurse -Force
  Info "$($rel.tag_name) -> $engineDir"
}

# ------------------------------------------------------------- template -----
Step "Chat template"
$template = Join-Path $ModelsDir "chat_template.jinja"
if (Test-Path $template) {
  Info "already have it"
} else {
  try {
    New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
    Invoke-WebRequest -Uri $TemplateUrl -Headers $UA -OutFile $template
    Info "saved to $template"
  } catch { Warn "Could not fetch the chat template ($($_.Exception.Message)). Skadi falls back to the model's own." }
}

# --------------------------------------------------------------- config -----
Step "Configuration"
$configDir = Join-Path $Dir "config"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$profiles = Join-Path $configDir "profiles.json"
$fwd = { param($p) $p.Replace("\", "/") }
if (Test-Path $profiles) {
  Info "keeping your existing config\profiles.json"
} else {
  $exe = & $fwd (Join-Path $engineDir "llama-server.exe")
  [ordered]@{
    serverExe        = $exe
    engines          = [ordered]@{ beellama = $exe }
    modelsDir        = & $fwd $ModelsDir
    chatTemplateFile = & $fwd $template
    host             = "127.0.0.1"
    port             = 8080
    activeProfile    = "qwen38-27b-iq3s-128k"
    profiles         = [ordered]@{}
  } | ConvertTo-Json -Depth 5 | ForEach-Object { Write-Text $profiles $_ }
  Info "wrote config\profiles.json"
}
# Starter skills, only into an empty skills folder.
$skillsDir = Join-Path $Dir "skills"
$defaultSkills = Join-Path $Dir "defaults\skills"
if ((Test-Path $defaultSkills) -and -not (Test-Path $skillsDir)) {
  Copy-Item -Path $defaultSkills -Destination $skillsDir -Recurse
  Info "added the starter skills"
}

# ------------------------------------------------------------- launcher -----
Step "Launcher"
$exePath = Join-Path $Dir "Skadi.exe"
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "build\get-webview2.ps1") | Out-Null
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "build\build.ps1") | Out-Null
} catch { }
if (Test-Path $exePath) {
  Info "built $exePath"
} else {
  Warn "Could not build Skadi.exe; start Skadi with:  node `"$Dir\skadi.mjs`""
}

if ($NoShortcuts -eq $false -and (Test-Path $exePath)) {
  $shell = New-Object -ComObject WScript.Shell
  $targets = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Skadi.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "Skadi.lnk")
  )
  foreach ($path in $targets) {
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $exePath
    $lnk.WorkingDirectory = $Dir
    $lnk.IconLocation = "$exePath,0"
    $lnk.Description = "Skadi - local AI coding harness"
    $lnk.Save()
  }
  Info "shortcuts added to the Desktop and Start Menu"
}

# ----------------------------------------------------------------- done -----
Write-Host ""
Write-Host "  Skadi is installed." -ForegroundColor Green
Write-Host "    app      $Dir"
Write-Host "    engine   $engineDir"
Write-Host "    models   $ModelsDir"
Write-Host ""
Write-Host "  Next: open Local AI, choose Browse models, and download one that fits your GPU." -ForegroundColor Yellow
Write-Host ""

if (-not $NoLaunch) {
  if (Test-Path $exePath) { Start-Process -FilePath $exePath -WorkingDirectory $Dir }
  else { Start-Process -FilePath "node" -ArgumentList "`"$Dir\skadi.mjs`"" -WorkingDirectory $Dir }
}
