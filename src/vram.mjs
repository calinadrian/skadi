// GPU memory sampling on Windows, without any vendor SDK.
//
// Two facts make this cheap and accurate:
//   * "\GPU Adapter Memory(*)\Dedicated Usage" is real VRAM in use.
//   * "\GPU Adapter Memory(*)\Shared Usage" is exactly the spill into system RAM
//     -- when this climbs while a model is loaded, you have overcommitted VRAM.
// WMI's Win32_VideoController.AdapterRAM is a 32-bit field and reports 4 GB for a
// 16 GB card, so total VRAM comes from the registry's qwMemorySize instead.
//
// One long-lived PowerShell process emits a JSON line per tick; spawning
// powershell.exe per sample would cost ~300 ms of CPU every poll.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const ADAPTER_REG = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*';

function psSampler(intervalMs) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Total VRAM per adapter, read once. qwMemorySize is the 64-bit value that
# Win32_VideoController.AdapterRAM truncates.
$totals = @()
foreach ($k in Get-ItemProperty -Path '${ADAPTER_REG}') {
  $qw = $k.'HardwareInformation.qwMemorySize'
  if ($qw) { $totals += [pscustomobject]@{ name = [string]$k.DriverDesc; total = [int64]$qw } }
}
$init = [pscustomobject]@{ kind = 'adapters'; adapters = $totals } | ConvertTo-Json -Compress -Depth 4
Write-Output $init

$paths = @(
  '\\GPU Adapter Memory(*)\\Dedicated Usage',
  '\\GPU Adapter Memory(*)\\Shared Usage',
  '\\GPU Process Memory(*)\\Dedicated Usage',
  '\\GPU Process Memory(*)\\Shared Usage'
)

while ($true) {
  $rows = @()
  try {
    foreach ($s in (Get-Counter -Counter $paths -ErrorAction Stop).CounterSamples) {
      if ($s.CookedValue -le 0) { continue }
      $rows += [pscustomobject]@{
        p = [string]$s.Path
        i = [string]$s.InstanceName
        v = [int64]$s.CookedValue
      }
    }
  } catch { }
  $out = [pscustomobject]@{ kind = 'sample'; ts = [int64](Get-Date -UFormat %s); rows = $rows }
  Write-Output ($out | ConvertTo-Json -Compress -Depth 4)
  Start-Sleep -Milliseconds ${intervalMs}
}
`;
}

/**
 * Emits 'sample' events shaped like:
 *   { ts, totalBytes, adapters: [{id, dedicated, shared}], byPid: {pid: {dedicated, shared}} }
 * `totalBytes` is the largest discrete adapter -- on this box the 9070 XT's 15.92 GB.
 */
export class VramMonitor extends EventEmitter {
  constructor({ intervalMs = 2000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.proc = null;
    this.last = null;
    this.adapterTotals = [];
    this.buffer = '';
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psSampler(this.intervalMs)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.on('exit', () => {
      this.proc = null;
    });
    this.proc.on('error', (err) => this.emit('error', err));
  }

  stop() {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      if (msg.kind === 'adapters') {
        this.adapterTotals = Array.isArray(msg.adapters) ? msg.adapters : [msg.adapters].filter(Boolean);
        this.emit('adapters', this.adapterTotals);
      } else if (msg.kind === 'sample') {
        this.last = this._shape(msg);
        this.emit('sample', this.last);
      }
    }
  }

  _shape(msg) {
    const rows = Array.isArray(msg.rows) ? msg.rows : [msg.rows].filter(Boolean);
    const adapters = new Map();
    const byPid = new Map();

    for (const row of rows) {
      const path = String(row.p || '');
      const isShared = /shared usage/i.test(path);
      const isProcess = /gpu process memory/i.test(path);
      const value = Number(row.v) || 0;

      if (isProcess) {
        // Instance names look like: pid_12345_luid_0x00000000_0x00013d61_phys_0
        const match = /^pid_(\d+)_/.exec(String(row.i || ''));
        if (!match) continue;
        const pid = Number(match[1]);
        const entry = byPid.get(pid) || { dedicated: 0, shared: 0 };
        entry[isShared ? 'shared' : 'dedicated'] += value;
        byPid.set(pid, entry);
      } else {
        const id = String(row.i || '');
        const entry = adapters.get(id) || { id, dedicated: 0, shared: 0 };
        entry[isShared ? 'shared' : 'dedicated'] += value;
        adapters.set(id, entry);
      }
    }

    const adapterList = [...adapters.values()].sort((a, b) => b.dedicated - a.dedicated);
    // The discrete card is the one with the most VRAM, not the most usage --
    // an idle dGPU next to a busy iGPU would otherwise pick the wrong total.
    const totalBytes = this.adapterTotals.reduce((max, a) => Math.max(max, Number(a.total) || 0), 0);

    return {
      ts: msg.ts,
      totalBytes,
      adapters: adapterList,
      byPid: Object.fromEntries(byPid),
    };
  }

  /** Current reading for one process, or zeros if it is not on the GPU yet. */
  forPid(pid) {
    const entry = this.last?.byPid?.[pid];
    return entry || { dedicated: 0, shared: 0 };
  }
}
