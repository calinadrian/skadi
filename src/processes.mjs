// Programs the agent's commands start, so that stopping Skadi stops them too.
//
// Killing a shell's process tree is not enough on Windows. `Start-Process npm
// run dev`, `start app.exe` or a detached server hands the program to a
// process whose parent -- the shell -- exits straight away. The program lives
// on as an orphan outside any tree `taskkill /T` can walk from Skadi, keeping
// its window open and its port bound after Skadi is gone.
//
// Windows keeps the dead parent's PID on the orphan, though. So every shell a
// command runs in is recorded here with its start time, and at shutdown the
// process table is read and everything descended from a recorded shell is
// stopped. Start times guard against PID reuse: a process older than the
// parent it names is someone else's.
import { execFile } from 'node:child_process';

// A shell's recorded start is taken just after spawn returns; allow for that
// and for the coarse creation times Windows reports.
const SLACK_MS = 2000;
const MAX_ROOTS = 2000;

const roots = new Map(); // pid -> when it was started (ms)

/** Remember a shell Skadi started for a command. */
export function trackProcess(pid, at = Date.now()) {
  if (!pid) return;
  roots.delete(pid);
  roots.set(pid, at);
  if (roots.size > MAX_ROOTS) roots.delete(roots.keys().next().value);
}

/**
 * The PIDs to stop: each recorded shell still alive, and every descendant of
 * one, including those whose parents have already exited.
 * `table` rows are { pid, ppid, created } with `created` in ms.
 */
export function trackedDescendants(table, tracked = roots) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const byParent = new Map();
  for (const p of table) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const out = new Set();
  const queue = [];
  for (const [pid, at] of tracked) {
    const live = byPid.get(pid);
    // Alive and not a newer process that was handed the same PID.
    if (live && live.created <= at + SLACK_MS) out.add(pid);
    queue.push({ pid, at });
  }
  while (queue.length) {
    const { pid, at } = queue.shift();
    // The PID may belong to a newer, unrelated process by now; only children
    // born before that one started can be ours.
    const holder = byPid.get(pid);
    const until = holder && holder.created > at + SLACK_MS ? holder.created : Infinity;
    for (const child of byParent.get(pid) || []) {
      if (out.has(child.pid) || child.pid === pid) continue;
      if (child.created + SLACK_MS < at) continue; // older than its "parent": PID reuse
      if (child.created >= until) continue;
      out.add(child.pid);
      queue.push({ pid: child.pid, at: child.created });
    }
  }
  out.delete(process.pid);
  out.delete(process.ppid);
  return out;
}

const run = (file, args, timeout) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

/** Every process on the machine as { pid, ppid, created }, or null. */
async function processTable() {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
  if (!out) return null;
  return out.split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid, created]) => pid > 0 && Number.isFinite(ppid) && Number.isFinite(created))
    .map(([pid, ppid, created]) => ({ pid, ppid, created }));
}

/**
 * Stop everything the agent's commands started that is still running.
 * Returns how many processes were asked to stop.
 */
export async function stopTrackedProcesses() {
  if (!roots.size) return 0;
  if (process.platform !== 'win32') {
    let n = 0;
    for (const pid of roots.keys()) {
      try { process.kill(-pid, 'SIGTERM'); n++; } catch { try { process.kill(pid, 'SIGTERM'); n++; } catch { /* gone */ } }
    }
    roots.clear();
    return n;
  }
  const table = await processTable();
  // Without the table, the shells still running are all that can be named.
  const pids = table ? [...trackedDescendants(table)] : [...roots.keys()];
  roots.clear();
  for (let i = 0; i < pids.length; i += 40) {
    const batch = pids.slice(i, i + 40).flatMap((pid) => ['/PID', String(pid)]);
    await run('taskkill', ['/T', '/F', ...batch], 15_000);
  }
  return pids.length;
}
