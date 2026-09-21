// HTTP layer: a small JSON API plus one Server-Sent Events stream that carries
// VRAM samples, llama-server logs and agent output to the browser. No framework,
// no websockets -- SSE is one-way and that is all the UI needs.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, openSync } from 'node:fs';
import { join, extname, normalize, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

import { ROOT, loadConfig, saveConfig, loadSettings, saveSettings, resetSettings, DEFAULT_SETTINGS, modelPath, loadModelMeta, saveModelMeta } from './config.mjs';
import { VramMonitor } from './vram.mjs';
import { LlamaServer, portIsFree, buildArgs, pidListeningOn, probeCapabilities, probeDevices, resolveDevice, fitWithLlamaCpp, visionOn, exeFor } from './llama.mjs';
import { searchModels, repoDetail, remoteShape, assessFit, quantOf, DownloadManager } from './huggingface.mjs';
import { catalogFor, CATALOG_VRAM_GB } from './profile-catalog.mjs';
import { readGgufMetadata, modelShape, estimateFootprint, maxContextFor, suggestProfile, fitProfile } from './gguf.mjs';
import { buildTools, toolSchemas, safePath } from './tools.mjs';
import { buildWebSearchTools } from './web-search.mjs';
import { LocalSearxng } from './searxng.mjs';
import { listDirectory, readProjectFile, findFiles } from './files.mjs';
import { TaskManager } from './tasks.mjs';
import { gitStatus, gitDiff } from './git.mjs';
import { SkillStore, skillTools, skillCatalogue, seedBundledSkills } from './skills.mjs';
import { MemoryStore, memoryTools } from './memory.mjs';
import { SessionStore, redactCredentials } from './sessions.mjs';
import { searchSession, contextDetails, turnReview, recordCommand } from './workflow.mjs';
import { topicTitle, modelTitle } from './titles.mjs';
import { checkForUpdate, applyUpdate, installedVersion } from './update.mjs';

// The tooling that moves files between two installations belongs to whoever
// maintains the app and is not part of a release. Where it is absent, every
// one of these is simply unavailable.
const deploy = await import('./publish.mjs').catch(() => null);
const canPublish = () => Boolean(deploy?.canPublish());
const canFetch = () => Boolean(deploy?.canFetch());
import { recordEdit, applyOne, applyAll, applyTurn, changeSummary, publicHistory } from './edits.mjs';

// When this process loaded its code. A source file newer than this is a
// change the running server is not executing: the window is served from
// disk and so is always current, which is how a fresh page ends up calling
// an endpoint its own server has never heard of.
const STARTED_AT = Date.now();
import { Agent, buildSystemPrompt } from './agent.mjs';
import { applyPlanAction, normalisePlan, planPrompt } from './plans.mjs';
import { normaliseLedgerOverride } from './progress-ledger.mjs';
import { resolveContextTokens, estimateTokens } from './compaction.mjs';
import {
  loadProviders, saveProviders, saveSecret, providerStatus, resolveProvider, listModels, modelLimits,
  repairToolArguments, streamCompletion,
} from './providers.mjs';
import { progressReviewInput, progressReviewPrompt, parseProgressReview } from './progress-review.mjs';
import { delegationPrompt, parseDelegation } from './delegation.mjs';
import { loadProjects, activeProject, addProject, removeProject, selectProject, projectSummary, projectsWithStatus } from './projects.mjs';
import { storeAttachment, attachmentsToBlocks, describeAttachments } from './attachments.mjs';
import { AgentBrowser, browserTools, SHOTS_DIR, VIEWPORT, profileDirFor } from './browser.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const MAX_BODY_BYTES = 64 * 1024 * 1024; // attachments arrive as base64 JSON


/**
 * Show the Windows folder picker and return the chosen path, or null if the
 * user cancelled. Needs -STA because the dialog is a COM/WinForms component.
 */
/**
 * A common dialog shown from a background process has no foreground rights, so
 * Windows opens it *behind* the app window. It is visible, it just cannot be
 * seen -- and ShowDialog then blocks forever, leaving a stuck process behind
 * every time the button is pressed.
 *
 * Giving the dialog a top-most owner window fixes both halves: the dialog
 * inherits top-most, and activating the owner first claims the foreground.
 */
const OWNER_PREAMBLE = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$owner.Show()
$owner.Activate()
[System.Windows.Forms.Application]::DoEvents()
`;

/** Show the file picker filtered to GGUF models. */
/**
 * Turn a fit patch into lines a person can read. llama.cpp hands back the
 * arguments and nothing else; what changed, and what it costs, is ours to say.
 */
function describeFit(profile, patch, blockCount = 0) {
  const steps = [];
  const n = (v) => Number(v).toLocaleString();
  if (patch.ctx !== undefined) steps.push(`context ${n(profile.ctx)} -> ${n(patch.ctx)}`);
  if (patch.nCpuMoe) {
    steps.push(`expert weights of the first ${patch.nCpuMoe} layers on the CPU (-ncmoe)`);
  }
  if (patch.ngl !== undefined) {
    // llama.cpp names an exact layer count where the profiles say 99, so "41"
    // on a 41-block model is every layer on the GPU, not a reduction. Saying
    // "some layers on the CPU" there would be a lie in the direction that
    // matters -- it is the one change that costs tokens per second.
    const all = blockCount ? patch.ngl >= blockCount : patch.ngl >= 99;
    if (!all) {
      steps.push(`-ngl ${profile.ngl} -> ${patch.ngl} (some layers on the CPU, expect fewer tokens/s)`);
    }
  }
  if (patch.overrideTensor !== undefined) {
    if (!patch.overrideTensor) {
      steps.push('tensor placement cleared — everything back on the GPU');
    } else {
      // The expression itself is hundreds of characters of regex; the count of
      // blocks it touches is the part worth reading.
      const blocks = new Set(patch.overrideTensor.match(/blk\\?\.(\d+)/g) || []);
      steps.push(`expert tensors of ${blocks.size} block${blocks.size === 1 ? '' : 's'} on the CPU (-ot)`);
    }
  }
  if (patch.cacheK !== undefined) steps.push(`KV cache -> ${patch.cacheK}/${patch.cacheV ?? patch.cacheK}`);
  return steps;
}

function pickModelFile(startDir) {
  const initial = String(startDir || '').replace(/'/g, "''");
  return runPicker(`${OWNER_PREAMBLE}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Choose a GGUF model'
$d.Filter = 'GGUF models (*.gguf)|*.gguf|All files (*.*)|*.*'
$d.Multiselect = $false
if (Test-Path -LiteralPath '${initial}') { $d.InitialDirectory = '${initial}' }
$result = $d.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`);
}

/** Every .gguf under a directory, two levels deep. */
function scanModels(dir, depth = 0) {
  if (!dir || !existsSync(dir) || depth > 2) return [];
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name).split('\\').join('/');
    if (entry.isDirectory()) {
      out.push(...scanModels(full, depth + 1));
    } else if (entry.name.toLowerCase().endsWith('.gguf')) {
      let bytes = 0;
      try { bytes = statSync(full).size; } catch { /* unreadable */ }
      out.push({ name: entry.name, path: full, bytes });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Built-in folder picker: the UI browses drives and directories through these
// helpers instead of popping a native Windows dialog. Directories only, no
// file contents, so the most it reveals is the shape of the disk.
/** Every present drive root, e.g. ["C:/", "D:/"]. Skips A: (floppy probe). */
function listDrives() {
  const drives = [];
  for (let code = 66; code <= 90; code++) { // B:..Z:
    const root = `${String.fromCharCode(code)}:/`;
    try {
      if (existsSync(root)) drives.push(root);
    } catch {
      /* unreadable root */
    }
  }
  return drives;
}

const MAX_DIR_ENTRIES = 2000;

/** Subdirectories of an absolute path, sorted, capped. Throws on failure. */
function listSubdirs(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('path required');
  const abs = resolve(raw);
  let names;
  try {
    names = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot open ${abs}: ${err.message}`);
  }
  const dirs = names
    .filter((e) => {
      try {
        return e.isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const slash = (p) => p.replace(/\\/g, '/');
  const parent = dirname(abs);
  return {
    path: slash(abs),
    parent: parent === abs ? null : slash(parent),
    entries: dirs.slice(0, MAX_DIR_ENTRIES).map((name) => ({ name, path: slash(join(abs, name)) })),
    truncated: dirs.length > MAX_DIR_ENTRIES,
  };
}

// Only one picker may be open at a time. Without this, a dialog the user cannot
// see invites repeated clicking, and every click leaves another blocked process.
let openPicker = null;

function runPicker(script, { timeoutMs = 180000 } = {}) {
  if (openPicker) {
    // Bring the one that is already open back to the front rather than adding
    // to the pile.
    try {
      openPicker.kill();
    } catch {
      /* already gone */
    }
    openPicker = null;
  }

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    openPicker = child;

    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    const done = (value) => {
      clearTimeout(timer);
      if (openPicker === child) openPicker = null;
      resolve(value);
    };

    child.on('error', () => done(null));
    child.on('close', () => {
      if (err.trim()) console.error('[picker]', err.trim().split('\n')[0]);
      done(out.trim() || null);
    });
  });
}

/**
 * Put a stored transcript back into a state a provider will accept: tool calls
 * whose arguments never were JSON are rewritten to hold the same text inside
 * legal JSON. Returns how many were repaired.
 */
function repairSession(session) {
  let count = 0;
  for (const message of session.messages || []) {
    for (const call of message.tool_calls || []) {
      const before = call.function?.arguments;
      repairToolArguments(call);
      if (call.function?.arguments !== before) count += 1;
    }
  }
  return count;
}

export class Skadi {
  constructor() {
    this.config = loadConfig();
    this.settings = loadSettings();
    seedBundledSkills(join(ROOT, 'defaults', 'skills'), join(ROOT, 'skills'));
    // One llama-server per loaded model, keyed by the profile it was launched
    // from, each on its own port. Load as many as the card holds.
    this.instances = new Map();
    // Every instance's output, tagged with whose it is, for the log view.
    this.serverLogs = [];
    this.vram = new VramMonitor({ intervalMs: this.settings.vramPollMs });
    this.skills = new SkillStore(join(ROOT, 'skills'));
    this.memory = new MemoryStore(join(ROOT, 'memory'));
    this.sessions = new SessionStore(join(ROOT, 'sessions'));
    this.clients = new Set();
    this.localSearxng = new LocalSearxng({
      onStatus: (status) => {
        this.webSearchStatus = status;
        this.broadcast('web_search_status', status);
      },
    });
    this.webSearchStatus = this.localSearxng.state;
    this.pendingApprovals = new Map();
    // Live turns, keyed by session id. One chat, one turn -- but several
    // chats can run at once, each with its own agent, transcript and tools.
    // A local llama-server with `-np 1` will still decode them one after the
    // other; the harness no longer adds a restriction of its own on top.
    this.turns = new Map();
    // Read-only children can run before the parent turn is constructed or
    // inside an already-running parent. Track them separately so reconnect,
    // Stop, deletion, and settings changes can still reach them.
    this.subagents = new Map();
    this.tasks = new TaskManager({ file: join(ROOT, 'logs', 'tasks.json') });
    this.tasks.on('update', (t) => this.broadcast('task_update', { task: t }));
    this.tasks.on('done', (t) => {
      this.onTaskDone(t).catch((err) => console.error('[task]', err.message));
    });
    this.shapeCache = new Map();
    // Downloads from Hugging Face, and the header-derived shape of every local
    // model file (path -> { mtime, shape }) so the model list does not re-read
    // a dozen multi-megabyte headers on every refresh.
    this.downloads = new DownloadManager();
    this.downloads.on('update', (job) => this.broadcast('download', { job }));
    this.downloads.on('done', (job) => this.onDownloadDone(job));
    this.fileShapes = new Map();
    // provider:model -> { ctx, at }. The endpoint's own figure for the model's
    // window, looked up once and reused: a turn must not pay for the model
    // catalogue, and a failed lookup must not retry on every round.
    this.modelCtxCache = new Map();
    // One browser per chat. Keyed by session id -- 'draft' until the chat is
    // saved, then re-keyed onto its real id. Each browser is a separate
    // Chromium with its own profile, so a page open in one chat can never be
    // mistaken for, or leak cookies into, another chat's.
    this.browsers = new Map();       // key -> AgentBrowser
    this.browserClients = new Map(); // key -> Set<res>
    // A llama-server Skadi did not start, already listening on our port
    // -- e.g. one launched from the old Start-*.ps1 scripts. We attach to it
    // for chat, but we must not claim to own it or try to stop it.
    this.external = null;

    this.vram.on('sample', (sample) => this.broadcast('vram', this.decorateVram(sample)));
  }

  // ---------------------------------------------------------------- instances

  /** Instances that hold, or are loading, a model. */
  liveInstances() {
    return [...this.instances.values()].filter((i) => i.state === 'ready' || i.state === 'starting');
  }

  /** Instances that can answer a chat right now, most recently loaded last. */
  readyInstances() {
    return [...this.instances.values()]
      .filter((i) => i.state === 'ready')
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }

  /** A new LlamaServer for a profile, wired to the window's event stream. */
  makeInstance(id) {
    const inst = new LlamaServer(id);
    inst.on('state', () => this.broadcast('server_state', this.instanceView(inst)));
    inst.on('log', (entry) => {
      const tagged = { ...entry, id };
      this.serverLogs.push(tagged);
      if (this.serverLogs.length > 800) this.serverLogs.splice(0, this.serverLogs.length - 800);
      this.broadcast('server_log', tagged);
    });
    inst.on('throughput', (t) => {
      this.broadcast('throughput', { id, ...t });
      this.recordThroughput(inst, t);
    });
    return inst;
  }

  /** One instance as the window sees it: its state plus what it holds on the card. */
  instanceView(inst) {
    const profile = this.config.profiles[inst.profileId ?? inst.id] || {};
    const mine = inst.pid ? this.vram.forPid(inst.pid) : { dedicated: 0, shared: 0 };
    return {
      ...inst.snapshot(),
      id: inst.id,
      label: profile.label || inst.id,
      alias: profile.alias || null,
      model: profile.model || profile.modelPath || null,
      ctx: profile.ctx ?? null,
      vram: mine,
      // For a load that failed: the build it used, so the window can offer the others.
      engine: inst.state === 'error' ? (profile.serverExe || this.config.serverExe) : undefined,
    };
  }

  instancesView() {
    const list = [...this.instances.values()].map((i) => this.instanceView(i));
    if (this.external && !this.instances.size) {
      list.push({
        id: 'external', external: true, state: 'external', port: this.config.port, pid: this.external.pid,
        label: this.external.alias || 'attached server', alias: this.external.alias, model: this.external.model,
        ctx: this.external.ctx, vram: this.external.pid ? this.vram.forPid(this.external.pid) : { dedicated: 0, shared: 0 },
      });
    }
    return list;
  }

  // ---------------------------------------------------------------- transport

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      // A browser that closed mid-turn leaves a destroyed response behind.
      // Writing to it must never take down the agent run that is emitting.
      if (client.writableEnded || client.destroyed) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * The project the review pane is looking at: the one asked for, else the
   * active one. Review is read-only, so any registered project may be read
   * without switching the agent over to it.
   */
  reviewProject(id) {
    const { projects = [], active } = loadProjects();
    const hit = projects.find((p) => p.id === (id || active));
    if (hit) return hit;
    if (id) throw new Error(`Unknown project: ${id}`);
    return { id: null, name: 'Workspace', path: this.workspace };
  }

  /** The folder the agent is allowed to touch: the active project's path. */
  get workspace() {
    return activeProject()?.path || this.settings.workspace;
  }

  /**
   * Attach Skadi's own interpretation to a raw VRAM sample: which slice
   * belongs to llama-server, and whether we are spilling into system RAM.
   */
  decorateVram(sample) {
    // Attribute an adopted external server's memory to llama-server too --
    // otherwise its 11 GB shows up as "everything else" and the bar lies.
    const live = [...this.instances.values()].filter((i) => i.pid);
    const pids = live.map((i) => i.pid);
    if (!pids.length && this.external?.pid) pids.push(this.external.pid);
    const pid = pids[0] ?? null;
    const held = pids.map((p) => this.vram.forPid(p));
    const mine = {
      dedicated: held.reduce((sum, h) => sum + (h.dedicated || 0), 0),
      shared: held.reduce((sum, h) => sum + (h.shared || 0), 0),
    };
    const adapter = sample.adapters?.[0] || { dedicated: 0, shared: 0 };
    const total = sample.totalBytes || 0;

    // Shared memory attributed to llama-server is normally the spill signal --
    // the adapter total includes the desktop compositor and any browser, so
    // only the slice belonging to the model means anything.
    //
    // Except when the offload is ours. A profile carrying -ot or -ncmoe puts
    // expert tensors in host memory on purpose, and Windows counts a GPU
    // process's host-visible allocations as Shared Usage all the same. Reporting
    // that as a spill would raise the alarm on a model decoding happily at
    // 26 tok/s, and an alarm that cries wolf is worse than no alarm.
    // An adopted external server has no profile id of its own, but it does
    // announce its alias -- and if that is one of ours, its flags are ours too.
    const designed = (profileId) => {
      const profile = profileId ? this.config.profiles[profileId] : null;
      const shape = profileId ? this.shapeCache.get(profileId) : null;
      return Boolean(
        profile &&
          (profile.overrideTensor ||
            profile.nCpuMoe > 0 ||
            (shape?.blockCount && Number(profile.ngl) < shape.blockCount)),
      );
    };
    // Each model is judged on its own: one spilling by accident must not be
    // excused because another one offloads on purpose.
    let byDesign = false;
    let spilling = false;
    for (const inst of live) {
      const share = this.vram.forPid(inst.pid);
      if (designed(inst.profileId)) byDesign = true;
      else if (share.shared > 64 * 1024 * 1024) spilling = true;
    }
    if (!live.length && this.external?.alias) {
      const id = Object.keys(this.config.profiles).find((k) => this.config.profiles[k].alias === this.external.alias);
      byDesign = designed(id);
      spilling = !byDesign && mine.shared > 64 * 1024 * 1024;
    }

    return {
      ...sample,
      llama: { pid, ...mine },
      // What each loaded model holds, so the window can label its own cards.
      perModel: live.map((i) => ({ id: i.id, ...this.vram.forPid(i.pid) })),
      usedBytes: adapter.dedicated,
      sharedBytes: adapter.shared,
      freeBytes: Math.max(total - adapter.dedicated, 0),
      offloadByDesign: byDesign && !spilling,
      spilling,
    };
  }

  /**
   * Is something already serving on our host:port that we did not spawn?
   * Returns a descriptor, or null. Cheap enough to call on every /api/state.
   */
  async detectExternal() {
    // The port belongs to one of ours: nothing foreign can be sitting on it.
    if ([...this.instances.values()].some((i) => i.proc && i.port === this.config.port)) {
      this.external = null;
      return null;
    }
    try {
      const res = await fetch(`http://${this.config.host}:${this.config.port}/props`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) throw new Error(String(res.status));
      const props = await res.json();
      const settings = props.default_generation_settings || {};
      this.external = {
        model: props.model_path || props.model || settings.model || null,
        alias: props.model_alias || settings.model || null,
        ctx: props.n_ctx || settings.n_ctx || null,
        pid: this.external?.pid ?? (await pidListeningOn(this.config.port)),
      };
    } catch {
      this.external = null;
    }
    return this.external;
  }

  /** Server status as the UI should see it, folding in an adopted external server. */
  serverStatus() {
    const ready = this.readyInstances();
    const latest = ready.at(-1) || [...this.instances.values()].at(-1);
    if (!latest) {
      return this.external
        ? { state: 'external', profileId: this.external.alias, external: this.external, count: 0 }
        : { state: 'stopped', count: 0 };
    }
    return {
      ...latest.snapshot(),
      state: ready.length ? 'ready' : latest.state,
      count: this.liveInstances().length,
    };
  }

  /** Can we send a chat request right now? */
  chatReady(provider) {
    if (!provider.managed) return provider.apiKey ? true : false;
    if (provider.instance) return this.instances.get(provider.instance)?.state === 'ready';
    return Boolean(this.external);
  }

  // ------------------------------------------------------------------- model

  async shapeFor(profileId) {
    if (this.shapeCache.has(profileId)) return this.shapeCache.get(profileId);
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    const file = modelPath(this.config, profile);
    if (!existsSync(file)) return null;
    const shape = modelShape(await readGgufMetadata(file));
    this.shapeCache.set(profileId, shape);
    return shape;
  }

  /** Size of a file a profile names, relative to modelsDir or absolute. */
  sidecarBytes(name) {
    if (!name) return 0;
    const file = /[\\/]/.test(name) ? name : join(this.config.modelsDir, name);
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  /**
   * Weights that land on the card beside the main model and that
   * llama-fit-params cannot see, because it accepts neither --mmproj nor -md.
   * Its answer is otherwise a fit with a gigabyte or two still to be loaded.
   */
  invisibleBytes(profile) {
    return {
      // Switched off means not loaded, so it must not be charged for either.
      mmprojBytes: visionOn(profile) ? this.sidecarBytes(profile.mmproj) : 0,
      draftBytes: this.sidecarBytes(profile.draftModel),
    };
  }

  /**
   * Everything the footprint arithmetic needs that does not come from the GGUF:
   * the vision tower, the KV types this binary accepts, and the correction we
   * learned from the last launch of this same profile.
   */
  async extrasFor(profileId) {
    const profile = this.config.profiles[profileId] || {};
    const caps = await probeCapabilities(exeFor(this.config, profile));
    return {
      ...this.invisibleBytes(profile),
      biasBytes: this.biasFor(profileId),
      cacheTypes: caps?.cacheTypes ?? null,
    };
  }

  /**
   * How far the last prediction for this profile undershot reality.
   *
   * `dedicated + shared` is what llama-server actually needed; the shared part is
   * the slice the driver could not fit in VRAM and backed with system RAM. The
   * gap between that and what we predicted is carried into the next estimate, so
   * a profile that spilled once does not spill the same way twice. Only stale if
   * the profile has since been edited -- which is why the ctx it was measured at
   * is stored alongside, and the bias is dropped when ctx moves.
   */
  biasFor(profileId) {
    const m = this.settings.measured?.[profileId];
    const profile = this.config.profiles[profileId];
    if (!m || !m.predictedBytes || !profile) return 0;
    if (m.ctx && Number(profile.ctx) !== Number(m.ctx)) return 0;
    if (m.cacheK && profile.cacheK !== m.cacheK) return 0;
    if ((m.overrideTensor || null) !== (profile.overrideTensor || null)) return 0;

    // What the card actually had to hold. For an ordinary profile that is
    // dedicated plus whatever the driver pushed into system RAM. For one that
    // offloads on purpose, the host-memory slice is not a failure and must not
    // be counted -- only the dedicated part was ever meant to be on the card,
    // and it will be *less* than predicted, which is the correction we want.
    const offloads = Boolean(profile.overrideTensor || profile.nCpuMoe > 0);
    const actual = offloads ? (m.dedicated || 0) : (m.dedicated || 0) + (m.shared || 0);
    const bias = actual - m.predictedBytes;
    return offloads ? bias : Math.max(bias, 0);
  }

  /** VRAM we are willing to fill, after other apps and the configured reserve. */
  async budgetBytes({ reclaim = [] } = {}) {
    await this.detectExternal();

    const total = this.vram.last?.totalBytes || 0;
    // Models stay loaded side by side, so what another one holds is not ours to
    // spend. Only memory that would be handed back -- the profile being loaded
    // again, or everything when the question is "does this file fit this card"
    // -- counts as reclaimable.
    const pids = reclaim === 'all'
      ? [...this.instances.values()].map((i) => i.pid).concat(this.external?.pid ?? null)
      : [...this.instances.values()].filter((i) => reclaim.includes(i.id)).map((i) => i.pid);
    const adapterUsed = this.vram.last?.adapters?.[0]?.dedicated || 0;
    const reclaimable = pids.filter(Boolean).reduce((sum, pid) => sum + this.vram.forPid(pid).dedicated, 0);
    const inUseByOthers = Math.max(adapterUsed - reclaimable, 0);
    // Filling the card to the last byte is what causes the spill: the compositor
    // and the driver need room, and when they cannot get it the driver silently
    // moves someone's allocation to system RAM rather than refusing it.
    const reserve = Math.max(Number(this.settings.vramReserveMb) || 0, 0) * 1024 * 1024;
    return {
      total,
      inUseByOthers,
      reclaimable,
      reserve,
      budget: Math.max(total - inUseByOthers - reserve, 0),
    };
  }

  /** The fit mode in force for a profile: its own, else the global default. */
  fitModeFor(profileId) {
    const own = this.config.profiles[profileId]?.autoFit;
    if (own && own !== 'inherit') return own;
    return this.settings.fitMode || 'ctx';
  }

  /** Every knob the fitter takes, resolved from profile then settings. */
  async fitOptionsFor(profileId, overrides = {}) {
    const profile = this.config.profiles[profileId] || {};
    const extras = await this.extrasFor(profileId);
    return {
      mode: this.fitModeFor(profileId),
      priority: profile.fitPriority || this.settings.fitPriority || 'context',
      ctxFloor: Number(profile.ctxFloor) || Number(this.settings.ctxFloor) || 16384,
      allowCpuLayers:
        profile.allowCpuLayers ?? this.settings.allowCpuLayers ?? false,
      extras,
      cacheTypes: extras.cacheTypes,
      ...overrides,
    };
  }

  // ------------------------------------------------------------------ models

  /** A launch profile built from a .gguf's own header, plus the card's free VRAM. */
  async profileFromModel(path, { id, mmproj, temporary = false } = {}) {
    const shape = modelShape(await readGgufMetadata(path));
    const { budget } = await this.budgetBytes();

    const file = path.replace(/\\/g, '/');
    const suggested = suggestProfile(shape, budget, {
      name: basename(file),
      modelPath: file,
      threads: this.settings.defaultThreads || 8,
    });
    // Sits beside the model in modelsDir, so the file name is enough.
    if (mmproj) Object.assign(suggested, { mmproj, vision: true });
    // Prism's ternary types (PQ2_0, PTQ1_0) only exist in the PrismML fork, and
    // its CPU repack of them segfaults on load, so -nr keeps the weights as-is.
    const prism = this.config.engines?.prism;
    if (prism && /PQ2_0|PTQ1_0/i.test(basename(file))) {
      suggested.serverExe = prism;
      suggested.extraArgs = [...(suggested.extraArgs || []), '-nr'];
    }
    // Default settings a model is loaded with are not kept unless asked: they
    // live until the model is ejected, and the Save button makes them a profile.
    if (temporary) suggested.temporary = true;

    let profileId = id || suggested.alias;
    let n = 2;
    while (this.config.profiles[profileId]) profileId = `${suggested.alias}-${n++}`;

    this.config.profiles[profileId] = suggested;
    this.config.activeProfile = profileId;
    saveConfig(this.config);
    this.shapeCache.set(profileId, shape);
    return { profileId, profile: suggested };
  }

  /**
   * Move the models folder. Profiles name their files relative to it, so a
   * profile whose files are in the old folder is pinned to them by absolute
   * path first -- switching folders must not strand the models you already have.
   */
  async setModelsDir(wanted) {
    const dir = resolve(wanted).replace(/\\/g, '/');
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder.`);
    const old = this.config.modelsDir;
    if (resolve(old) !== resolve(dir)) {
      const pin = (profile, key) => {
        const name = profile[key];
        if (!name || /[\\/]/.test(name)) return;
        const before = join(old, name);
        if (existsSync(before) && !existsSync(join(dir, name))) profile[key] = before.replace(/\\/g, '/');
      };
      for (const profile of Object.values(this.config.profiles)) {
        if (profile.catalog) continue;
        if (profile.model && !profile.modelPath) {
          const before = join(old, profile.model);
          if (existsSync(before) && !existsSync(join(dir, profile.model))) profile.modelPath = before.replace(/\\/g, '/');
        }
        pin(profile, 'mmproj');
        pin(profile, 'draftModel');
      }
    }
    this.config.modelsDir = dir;
    saveConfig(this.config);
    this.fileShapes.clear();
    this.shapeCache.clear();
    this.broadcast('models_changed', {});
  }

  /** A fresh profile with default settings for a model file, kept so it can be edited later. */
  async defaultProfileForModel(name) {
    const file = basename(name);
    // Already loaded with defaults, or left over from a failed load: reuse it
    // rather than piling up one per click.
    const again = Object.entries(this.config.profiles).find(([id, p]) => p.temporary
      && String(p.model || '').toLowerCase() === file.toLowerCase() && !this.liveInstances().some((i) => i.id === id));
    if (again) return again[0];
    const path = join(this.config.modelsDir, file).replace(/\\/g, '/');
    if (!existsSync(path)) throw new Error(`${file} is not in ${this.config.modelsDir}.`);
    const meta = loadModelMeta()[file];
    const mmproj = meta?.mmproj && existsSync(join(this.config.modelsDir, meta.mmproj)) ? meta.mmproj : undefined;
    return (await this.profileFromModel(path, { mmproj, temporary: true })).profileId;
  }

  /** The profile "Load" should start for a model file, creating one if needed. */
  async profileForModel(name) {
    const file = basename(name);
    const existing = (wantCatalog) => Object.entries(this.config.profiles).find(
      ([, p]) => Boolean(p.catalog) === wantCatalog
        && String(p.model || '').toLowerCase() === file.toLowerCase(),
    );
    const found = existing(true) || existing(false);
    if (found) return found[0];
    const path = join(this.config.modelsDir, file).replace(/\\/g, '/');
    if (!existsSync(path)) throw new Error(`${file} is not in ${this.config.modelsDir}.`);
    const meta = loadModelMeta()[file];
    const mmproj = meta?.mmproj && existsSync(join(this.config.modelsDir, meta.mmproj)) ? meta.mmproj : undefined;
    return (await this.profileFromModel(path, { mmproj, temporary: true })).profileId;
  }

  /** Header-derived shape of a local file, cached until the file changes. */
  async fileShape(path) {
    const mtime = statSync(path).mtimeMs;
    const cached = this.fileShapes.get(path);
    if (cached?.mtime === mtime) return cached.shape;
    const shape = modelShape(await readGgufMetadata(path));
    this.fileShapes.set(path, { mtime, shape });
    return shape;
  }

  /** Every model in modelsDir, with what fits, what profiles it has, and whether it is loaded. */
  async localModels() {
    const dir = this.config.modelsDir;
    const { budget, total } = await this.budgetBytes({ reclaim: 'all' });
    const meta = loadModelMeta();
    const all = scanModels(dir);
    const byName = new Map(all.map((m) => [m.name, m]));
    const shardOf = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
    const loadedFiles = new Set(this.liveInstances()
      .map((i) => String(this.config.profiles[i.profileId]?.model || '').toLowerCase())
      .filter(Boolean));

    const models = [];
    for (const m of all) {
      if (/mmproj|^mtp[-_]/i.test(m.name)) continue; // companions, not models
      const shard = shardOf.exec(m.name);
      if (shard && Number(shard[2]) !== 1) continue; // the first shard stands for the set
      let bytes = m.bytes;
      if (shard) {
        for (const other of all) {
          const o = shardOf.exec(other.name);
          if (o && o[1] === shard[1] && other.name !== m.name) bytes += other.bytes;
        }
      }
      const profiles = Object.entries(this.config.profiles)
        .filter(([, p]) => String(p.model || '').toLowerCase() === m.name.toLowerCase())
        .map(([id, p]) => ({ id, label: p.label || id, catalog: Boolean(p.catalog), mmproj: p.mmproj || null }));
      const mmproj = profiles.find((p) => p.mmproj)?.mmproj || meta[m.name]?.mmproj || null;
      const mmprojBytes = mmproj ? byName.get(mmproj)?.bytes || 0 : 0;

      let fit = { verdict: 'unknown', maxContext: null, needBytes: null };
      let shape = null;
      try {
        shape = await this.fileShape(m.path);
        fit = assessFit(shape, bytes, budget, { mmprojBytes });
      } catch { /* unreadable header: listed without a verdict */ }

      models.push({
        name: m.name,
        bytes,
        quant: quantOf(m.name),
        arch: shape?.arch || null,
        trainCtx: shape?.trainCtx || null,
        repo: meta[m.name]?.repo || null,
        mmproj: mmprojBytes ? mmproj : null,
        mmprojBytes,
        fit: this.tuned(fit, profiles.filter((p) => p.catalog), total),
        profiles,
        loaded: loadedFiles.has(m.name.toLowerCase()),
        loadedProfiles: this.liveInstances()
          .filter((i) => String(this.config.profiles[i.profileId]?.model || '').toLowerCase() === m.name.toLowerCase())
          .map((i) => i.profileId),
      });
    }
    return { dir, totalVramBytes: total, budgetBytes: budget, catalogVramGB: CATALOG_VRAM_GB, models };
  }

  /**
   * A catalog profile was tuned on a 16 GB card, with layer offload and other
   * levers this arithmetic does not use. On a card that size, a file with one
   * is marked so the badge can say so instead of calling it "tight".
   */
  tuned(fit, catalog, totalVramBytes) {
    const gib = totalVramBytes / 1024 ** 3;
    if (!catalog.length || gib < CATALOG_VRAM_GB - 1.5 || gib > CATALOG_VRAM_GB + 1.5) return fit;
    return fit.verdict === 'fits' ? fit : { ...fit, tuned: true };
  }

  /** The catalog with what each entry needs and whether this PC already has it. */
  catalogView() {
    const dir = this.config.modelsDir;
    const has = (name) => Boolean(name) && this.sidecarBytes(name) > 0;
    const loadedIds = new Set(this.liveInstances().map((i) => i.id));
    const entries = Object.entries(this.config.profiles)
      .filter(([, p]) => p.catalog)
      .map(([id, p]) => {
        const exe = p.serverExe || null;
        return {
          id,
          label: p.label,
          info: p.info || {},
          model: p.model,
          mmproj: p.mmproj || null,
          draft: p.draftModel || null,
          have: {
            model: has(p.model),
            mmproj: p.mmproj ? has(p.mmproj) : null,
            draft: p.draftModel ? has(p.draftModel) : null,
          },
          engine: { exe, ok: exe ? existsSync(exe) : true },
          active: id === this.config.activeProfile,
          loaded: loadedIds.has(id),
          imported: this.isImported(id),
        };
      });
    const total = this.vram.last?.totalBytes || 0;
    return { dir, vramGB: CATALOG_VRAM_GB, totalVramBytes: total, entries };
  }

  isImported(id) {
    return (this.config.catalogImported || []).includes(id);
  }

  /** Bring a catalog profile into the profile list. Idempotent. */
  importCatalogProfile(id) {
    if (!this.config.profiles[id]?.catalog) throw new Error('unknown catalog profile');
    if (!this.isImported(id)) {
      this.config.catalogImported = [...(this.config.catalogImported || []), id];
      saveConfig(this.config);
    }
  }

  /**
   * Take a catalog profile back out of the profile list. The profile a running
   * server was launched from stays: removing it would leave the Local AI tab
   * showing a model that has no entry.
   */
  removeCatalogProfile(id) {
    if (!this.config.profiles[id]?.catalog) throw new Error('unknown catalog profile');
    const running = this.liveInstances().some((i) => i.id === id);
    if (running) throw new Error('That profile is loaded right now. Eject it first, then remove it.');
    this.config.catalogImported = (this.config.catalogImported || []).filter((x) => x !== id);
    // The default profile just left the list; hand the role to one still in it.
    if (this.config.activeProfile === id) {
      const next = Object.entries(this.config.profiles).find(([pid, p]) => !p.catalog || this.isImported(pid));
      if (next) this.config.activeProfile = next[0];
    }
    saveConfig(this.config);
  }

  /** One repo for the detail pane: files with a fit verdict against this card, and what is already here. */
  async repoView(id) {
    const detail = await repoDetail(id);
    const { budget, total } = await this.budgetBytes({ reclaim: 'all' });
    let shape = null;
    let shapeError = null;
    // Every quant shares one architecture, so one header answers for all of them.
    const probe = detail.models.find((m) => m.shards === 1) || detail.models[0];
    if (probe) {
      try { shape = await remoteShape(id, probe); } catch (err) { shapeError = err.message; }
    }
    const vision = detail.mmproj[0] || null;
    const dir = this.config.modelsDir;
    const models = detail.models.map((m) => {
      const onDisk = m.files.every((f) => {
        try { return statSync(join(dir, f.name)).size === f.bytes; } catch { return false; }
      });
      const catalog = catalogFor(m.file);
      return {
        ...m,
        fit: this.tuned(assessFit(shape, m.bytes, budget), catalog, total),
        fitWithVision: vision ? this.tuned(assessFit(shape, m.bytes, budget, { mmprojBytes: vision.bytes }), catalog, total) : null,
        downloaded: onDisk,
        catalog,
      };
    });
    return {
      ...detail,
      models,
      vision,
      shape: shape && { arch: shape.arch, layers: shape.blockCount, trainCtx: shape.trainCtx },
      shapeError,
      totalVramBytes: total,
      budgetBytes: budget,
      modelsDir: dir,
    };
  }

  async startDownload(repo, file, withVision, withDraft = false) {
    // Re-resolve the file list here: a path or size from the page is a hint,
    // never something to write to disk on trust.
    const detail = await repoDetail(repo);
    const model = detail.models.find((m) => m.file === file);
    if (!model) throw new Error(`${file} is not in ${repo}.`);
    const files = model.files.map((f) => ({ ...f }));
    const meta = { model: model.file, mmproj: null };
    const tower = withVision ? detail.mmproj[0] : null;
    if (tower) {
      // Towers are all called mmproj-F16.gguf; name it after the model so two
      // repos' towers cannot overwrite each other in one folder.
      const family = repo.split('/')[1].replace(/-GGUF$/i, '');
      const name = `mmproj-${family}-${tower.name.replace(/^mmproj[-_]?/i, '')}`;
      files.push({ ...tower, name });
      meta.mmproj = name;
    }
    // The speculative-decoding draft keeps its own name: catalog profiles refer to it by that.
    if (withDraft && detail.drafts[0]) files.push({ ...detail.drafts[0] });
    return this.downloads.start(repo, files, this.config.modelsDir, meta);
  }

  /** A finished download: remember its origin and vision tower, then tell the window. */
  onDownloadDone(job) {
    try {
      if (job.meta?.model) {
        saveModelMeta({ [job.meta.model]: { repo: job.repo, mmproj: job.meta.mmproj || null, at: Date.now() } });
      }
    } catch (err) {
      console.error('[models]', err.message);
    }
    this.broadcast('models_changed', {});
  }

  async estimateFor(profileId) {
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    const shape = await this.shapeFor(profileId);
    if (!shape) return { available: false, reason: 'model file not found' };

    const options = await this.fitOptionsFor(profileId);
    const extras = options.extras;
    const { total, inUseByOthers, reclaimable, reserve, budget } = await this.budgetBytes({ reclaim: [profileId] });

    const estimate = estimateFootprint(shape, profile, extras);
    // What auto-fit *would* do, without doing it -- so the panel can offer the
    // change rather than spring it on you.
    const fit = fitProfile(shape, profile, budget, options);

    return {
      available: true,
      shape,
      ...estimate,
      totalVramBytes: total,
      otherProcessesBytes: inUseByOthers,
      reclaimableBytes: reclaimable,
      reserveBytes: reserve,
      budgetBytes: budget,
      fits: estimate.totalBytes === null ? null : estimate.totalBytes <= budget,
      maxContext: maxContextFor(shape, profile, budget, extras),
      measured: this.settings.measured?.[profileId] || null,
      fitMode: options.mode,
      fitPriority: options.priority,
      ctxFloor: options.ctxFloor,
      allowCpuLayers: options.allowCpuLayers,
      minTokensPerSec: Number(this.settings.minTokensPerSec) || 0,
      autoFitOnStart: this.settings.autoFitOnStart !== false,
      suggestion: Object.keys(fit.patch).length ? { patch: fit.patch, steps: fit.steps, fits: fit.fits } : null,
      cacheTypes: extras.cacheTypes,
      // "Fits" is a statement about memory. A profile can fit perfectly and
      // still be unable to start, and reporting the two as one number is how
      // you end up staring at a green forecast and a server that will not load.
      blocked: this.blockedReason(profile, extras.cacheTypes),
      // Whether a tower exists at all, and whether it is switched on: the panel
      // needs both to show a toggle rather than an empty checkbox.
      hasVision: Boolean(profile.mmproj),
      visionOn: visionOn(profile),
      // The device list, so the panel can say which card this is fitted against
      // rather than leaving you to guess which of two Vulkan devices won.
      ...(await this.deviceInfo()),
      argv: buildArgs(this.config, profile, modelPath(this.config, profile), await this.fitArgs()),
    };
  }

  /**
   * Why this profile will refuse to start, regardless of whether it fits.
   *
   * Only one reason so far, and it is the one that actually bites: a KV cache
   * type from a llama.cpp fork (kvarn4 and friends) against an upstream build,
   * which is rejected while parsing arguments, long before any memory is
   * allocated.
   */
  blockedReason(profile, cacheTypes) {
    if (!Array.isArray(cacheTypes)) return null;
    for (const [flag, value] of [['cache-type-k', profile.cacheK], ['cache-type-v', profile.cacheV]]) {
      const name = String(value || '').toLowerCase();
      if (name && !cacheTypes.includes(name)) {
        return `this llama.cpp build rejects --${flag} "${name}". It accepts: ${cacheTypes.join(', ')}.`;
      }
    }
    return null;
  }

  /** The binary the active profile runs on -- a fork, if that profile names one. */
  exeForActive() {
    return exeFor(this.config, this.config.profiles[this.config.activeProfile] || {});
  }

  /** The GPUs llama.cpp can see, and which one profiles target by default. */
  async deviceInfo() {
    const probed = await probeDevices(this.exeForActive());
    return { devices: probed?.devices || [], defaultDevice: probed?.discrete?.id || null };
  }

  /** The margin arguments handed to llama.cpp's own fitter, kept in step with ours. */
  async fitArgs() {
    const { reserve } = await this.budgetBytes();
    const { devices, defaultDevice } = await this.deviceInfo();
    return {
      fitTargetMiB: Math.round(reserve / 1024 / 1024) || undefined,
      fitCtxFloor: Number(this.settings.ctxFloor) || undefined,
      defaultDevice: defaultDevice || undefined,
      devices: devices.map((d) => d.id),
    };
  }

  /**
   * Shrink a profile until it fits, and optionally write the change back.
   * Returns the steps taken so the UI (and the chat log) can say what changed.
   */
  async fitFor(profileId, { apply = false, mode } = {}) {
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`unknown profile ${profileId}`);
    const shape = await this.shapeFor(profileId);
    if (!shape) return { applied: false, steps: [], reason: 'model file not found' };

    const { budget } = await this.budgetBytes({ reclaim: [profileId] });
    const options = await this.fitOptionsFor(profileId, mode ? { mode } : {});

    // llama.cpp's own fitter first: it reads the real tensor table and measures
    // the card, so its answer is the one that matters. Skadi's arithmetic is the
    // fallback for when the binary is missing or refuses the profile.
    let result = null;
    let via = 'llama.cpp';
    if (options.mode !== 'off') {
      // llama-fit-params accepts neither --mmproj nor -md, so a vision tower
      // and a draft model are both invisible to it. Widening the margin by
      // their combined size is what keeps it from handing back a configuration
      // that fills the card and then loads two more gigabytes.
      const invisible = this.invisibleBytes(profile);
      const invisibleMiB = Math.ceil(
        (invisible.mmprojBytes + invisible.draftBytes) / 1024 / 1024,
      );
      // The two views of "free VRAM" do not agree, and the disagreement is the
      // whole reason a fitted profile could still spill.
      //
      // Vulkan reports a per-process *budget* -- on this card, 15.0 GB free
      // while the performance counters say 2.8 GB is committed. Both are true:
      // Windows counts what is committed, Vulkan reports what this process
      // could allocate if the driver evicted everyone else. It does not
      // reliably evict them. llama.cpp believes Vulkan, fitted a 27B model into
      // 14.2 GB, and 3.9 GB of it ended up in system RAM.
      //
      // So the margin handed to llama.cpp is not just our reserve: it is
      // whatever it takes to bring its optimistic view down to the budget the
      // committed-memory counters support.
      const { devices, defaultDevice } = await this.deviceInfo();
      const deviceIds = devices.map((d) => d.id);
      const targetId = resolveDevice(profile, { defaultDevice, devices: deviceIds });
      const vulkanFreeMiB = devices.find((d) => d.id === targetId)?.freeMiB ?? 0;
      const budgetMiB = Math.floor(budget / 1024 / 1024);
      const reconcileMiB = vulkanFreeMiB ? Math.max(vulkanFreeMiB - budgetMiB, 0) : 0;
      const ask = async (decide) =>
        fitWithLlamaCpp(this.config, profile, modelPath(this.config, profile), {
          targetMiB:
            Math.max(reconcileMiB, Math.max(Number(this.settings.vramReserveMb) || 0, 0)) +
            invisibleMiB,
          ctxFloor: options.ctxFloor,
          decide,
          defaultDevice: defaultDevice || undefined,
          devices: deviceIds,
        });

      // -ngl is always left for llama.cpp to choose, even when CPU layers are
      // forbidden. Its placement pass is the same one that produces the -ot
      // expert map, so pinning -ngl does not protect speed -- it just makes the
      // fitter give up on a Mixture-of-Experts model that would have fitted
      // comfortably. The speed constraint is enforced on the answer instead:
      // if it came back wanting dense layers on the CPU, that answer is refused.
      // Anything but 'quality' means the context is not what gives way, so it
      // is pinned and llama.cpp is left to find the room elsewhere.
      const holdCtx = options.priority !== 'quality';
      let native = await ask(holdCtx ? ['ngl', 'ncmoe'] : ['ngl', 'ncmoe', 'ctx']);
      const movesDenseLayers = (r) =>
        r.available && shape.blockCount && (r.patch.ngl ?? 99) < shape.blockCount;
      if (holdCtx && (!native.available || (!options.allowCpuLayers && movesDenseLayers(native)))) {
        // Shortening the window is the next thing to try before giving up on it.
        native = await ask(['ngl', 'ncmoe', 'ctx']);
      }
      if (!options.allowCpuLayers && movesDenseLayers(native)) {
        native = {
          available: false,
          reason: `only fits with ${shape.blockCount - native.patch.ngl} layers on the CPU, which you have not allowed`,
        };
      }

      if (native.available) {
        const patch = {};
        for (const [key, value] of Object.entries(native.patch)) {
          // Treat "absent" and "null" as the same thing, so a model with no
          // tensor overrides does not get a null written into it every fit.
          if ((profile[key] ?? null) === (value ?? null)) continue;
          patch[key] = value;
        }
        result = { fits: true, patch, steps: describeFit(profile, patch, shape.blockCount), estimate: null };
      } else {
        via = `skadi (${native.reason})`;
      }
    }
    if (!result) {
      if (via === 'llama.cpp') via = 'skadi';
      result = fitProfile(shape, profile, budget, options);
    }

    // llama-fit-params measures the card as it is *now*, and has no idea that
    // the 10 GB a different profile is holding would be freed the moment you
    // launched this one. Skadi's own arithmetic does model that, so the fallback
    // answer is the better one here -- but the fit is still being computed
    // against a moving target, and that is worth saying rather than quietly
    // handing back a cramped profile.
    const others = this.liveInstances().filter((i) => i.id !== profileId).map((i) => i.id);
    const busyWith = others.length
      ? others.map((id) => this.config.profiles[id]?.alias || id).join(', ')
      : this.external ? this.external.alias || 'another model' : null;

    const changed = Object.keys(result.patch).length > 0;
    // A catalog profile is read-only: its fit is computed and offered, and a
    // launch uses it, but it is never written into the profile.
    const writable = !profile.catalog;
    if (apply && changed && writable) {
      Object.assign(this.config.profiles[profileId], result.patch);
      saveConfig(this.config);
    }
    return {
      applied: apply && changed && writable,
      changed,
      via,
      busyWith,
      fits: result.fits,
      steps: result.steps,
      patch: result.patch,
      estimate: await this.estimateFor(profileId),
    };
  }

  async startServer(profileId) {
    const id = profileId || this.config.activeProfile;
    if (!this.config.profiles[id]?.model && !this.config.profiles[id]?.modelPath) {
      throw new Error(`unknown profile ${id}`);
    }
    if (this.instances.get(id)?.state === 'ready' || this.instances.get(id)?.state === 'starting') {
      throw new Error(`${this.config.profiles[id].label || id} is already loaded.`);
    }

    await this.detectExternal();

    // Fit before launching, not after discovering the spill. The card's free
    // space is measured now -- other loaded models included -- so a profile that
    // fitted this morning with nothing else running still fits this afternoon
    // with a browser open, or with a second model beside it.
    let fitNote = null;
    let fitted = false;
    let launchPatch = {};
    if (this.settings.autoFitOnStart !== false && this.fitModeFor(id) !== 'off') {
      try {
        const fit = await this.fitFor(id, { apply: true });
        fitted = fit.via === 'llama.cpp';
        if (this.config.profiles[id].catalog) launchPatch = fit.patch;
        if (fit.applied || (fit.changed && this.config.profiles[id].catalog)) {
          fitNote = `auto-fit (${fit.via}): ${fit.steps.join('; ')}`;
        } else if (fit.fits === false) {
          fitNote =
            `auto-fit could not make this fit (${this.fitModeFor(id)} mode); ` +
            `launching anyway — expect a spill into system RAM`;
        }
      } catch (err) {
        fitNote = `auto-fit skipped: ${err.message}`;
      }
    }

    this.config.activeProfile = id;
    saveConfig(this.config);
    this.slowWarned?.delete(id); // a fresh launch deserves a fresh verdict
    const profile = { id, ...this.config.profiles[id], ...launchPatch };

    // Every model gets its own port: the first takes the configured one, the
    // rest the next free ones above it.
    const port = await this.freePort();
    const inst = this.makeInstance(id);
    this.instances.set(id, inst);
    if (fitNote) inst._log('harness', fitNote);
    try {
      await inst.start({ ...this.config, port }, profile, modelPath(this.config, profile), {
        // Its own backstop has nothing left to do once we have fitted, and left on
        // it complains about the explicit -ngl we just worked out.
        fit: { ...(await this.fitArgs()), fitBackstop: fitted ? 'off' : undefined },
      });
    } catch (err) {
      // A load that never became healthy must not leave its process behind.
      await inst.stop().catch(() => {});
      throw err;
    }
    setTimeout(() => {
      this.recordMeasurement(inst).catch(() => {});
    }, 6000);
    this.broadcast('models_changed', {});
    return { ...this.instanceView(inst), fitNote };
  }

  /**
   * The llama-server builds on this machine: the configured one, any a profile
   * names, and the ones sitting beside it (D:/AI/llama.cpp, D:/AI/prism-llama.cpp...).
   * Forks are not interchangeable -- some formats only load on one -- so the
   * profile lets you say which to use.
   */
  engines() {
    const found = new Map();
    const add = (path) => {
      const norm = String(path || '').replace(/\\/g, '/');
      if (!norm || found.has(norm.toLowerCase()) || !existsSync(norm)) return;
      found.set(norm.toLowerCase(), { path: norm, name: norm.split('/').slice(-2, -1)[0] || norm });
    };
    add(this.config.serverExe);
    for (const p of Object.values(this.config.profiles)) add(p.serverExe);
    try {
      const parent = dirname(dirname(String(this.config.serverExe || '')));
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) add(join(parent, entry.name, 'llama-server.exe'));
      }
    } catch { /* no sibling folder to look in */ }
    return [...found.values()];
  }

  /** The lowest port from the configured one up that nothing is listening on. */
  async freePort() {
    const taken = new Set([...this.instances.values()].filter((i) => i.proc).map((i) => i.port));
    for (let port = this.config.port; port < this.config.port + 50; port++) {
      if (!taken.has(port) && await portIsFree(this.config.host, port)) return port;
    }
    throw new Error(`No free port from ${this.config.port} up for another model.`);
  }

  /** Unload one model -- or, with no id, every one Skadi started. */
  async stopServer(id, { keepTemporary = false } = {}) {
    const targets = id ? [this.instances.get(id)].filter(Boolean) : [...this.instances.values()];
    await Promise.all(targets.map(async (inst) => {
      await inst.stop();
      this.instances.delete(inst.id);
      if (!keepTemporary) this.dropIfTemporary(inst.id);
      // The window keeps a card for every id it has heard of until told otherwise.
      this.broadcast('server_state', { ...this.instanceView(inst), state: 'stopped', removed: true });
    }));
    this.broadcast('models_changed', {});
    this.broadcast('profiles_changed', { config: this.config });
  }

  /** Default settings a model was loaded with go when it does, unless they were saved. */
  dropIfTemporary(id) {
    if (!this.config.profiles[id]?.temporary) return;
    delete this.config.profiles[id];
    this.shapeCache.delete(id);
    if (this.config.activeProfile === id) {
      this.config.activeProfile = Object.keys(this.config.profiles).find((k) => !this.config.profiles[k].temporary)
        ?? Object.keys(this.config.profiles)[0];
    }
    saveConfig(this.config);
  }

  /**
   * Keep the last decode rate a llama-server reported for the profile it runs.
   *
   * Nothing here can predict tokens per second -- it depends on the quant, the
   * driver and what else is on the card -- so the honest way to hold a speed
   * floor is to measure it and say when it is missed. A rate well under the
   * floor with no spill means the profile itself is too slow; under the floor
   * *with* a spill means the fit is wrong, which is fixable.
   *
   * Only meaningful for a managed llama-server: an API provider's rate says
   * nothing about this card.
   */
  recordThroughput(inst, t) {
    const id = inst.profileId;
    const rate = Number(t?.decode);
    if (!id || inst.state !== 'ready') return;
    if (!Number.isFinite(rate) || rate <= 0) return;
    const measured = { ...(this.settings.measured || {}) };
    const entry = measured[id];
    if (!entry) return; // the VRAM measurement lands first and owns the record
    if (entry.tokensPerSec === rate) return;
    measured[id] = { ...entry, tokensPerSec: rate, tokensPerSecAt: Date.now() };
    this.settings = saveSettings({ measured });

    const floor = Number(this.settings.minTokensPerSec) || 0;
    if (floor && rate < floor && !this.slowWarned?.has?.(id)) {
      (this.slowWarned ||= new Set()).add(id);
      const spill = this.vram.forPid(inst.pid ?? 0).shared || 0;
      inst._log(
        'harness',
        `decoding at ${rate.toFixed(1)} tok/s, under the ${floor} tok/s floor` +
          (spill > 64 * 1024 * 1024
            ? ` — ${(spill / 1024 ** 3).toFixed(2)} GB is in system RAM, so fitting this profile should get it back.`
            : ' — nothing is spilling, so this profile is simply this fast on this card.'),
      );
    }
  }

  async recordMeasurement(inst) {
    const profileId = inst.profileId;
    const pid = inst.pid;
    if (!pid || !profileId) return;
    const mine = this.vram.forPid(pid);
    if (!mine.dedicated) return;
    const profile = this.config.profiles[profileId] || {};

    // Store the prediction beside the measurement. On its own, "11.9 GB
    // dedicated" says nothing about whether we were right; the pair is what
    // makes the next estimate better than this one. The prediction recorded is
    // the *uncorrected* one -- including the previous bias here would make each
    // launch record only the residual, and the correction would decay away.
    let predictedBytes = null;
    try {
      const shape = await this.shapeFor(profileId);
      if (shape) {
        const extras = { ...(await this.extrasFor(profileId)), biasBytes: 0 };
        predictedBytes = estimateFootprint(shape, profile, extras).totalBytes;
      }
    } catch {
      /* a missing model file should not cost us the measurement */
    }

    const measured = { ...(this.settings.measured || {}) };
    measured[profileId] = {
      dedicated: mine.dedicated,
      shared: mine.shared,
      predictedBytes,
      ctx: profile.ctx ?? null,
      cacheK: profile.cacheK ?? null,
      overrideTensor: profile.overrideTensor ?? null,
      at: Date.now(),
    };
    this.settings = saveSettings({ measured });
    this.broadcast('measured', { profileId, ...measured[profileId] });

    // A spill is worth saying out loud in the log the user is already watching,
    // with the number that will be folded into the next estimate. Host memory a
    // profile asked for with -ot or -ncmoe is not a spill and gets no alarm.
    const offloads = Boolean(profile.overrideTensor || profile.nCpuMoe > 0);
    if (!offloads && mine.shared > 64 * 1024 * 1024) {
      inst._log(
        'harness',
        `spilling ${(mine.shared / 1024 ** 3).toFixed(2)} GB into system RAM. ` +
          `The next fit for "${profileId}" will account for it; re-fit and restart to reclaim the speed.`,
      );
    }
  }

  // ----------------------------------------------------------------- browser

  /** The browser key for a chat. A chat without an id yet browses as 'draft'. */
  browserKey(sessionId) {
    const raw = String(sessionId || 'draft');
    return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'draft';
  }

  /** The lowest debugging port no live browser is already using. */
  browserPort() {
    const taken = new Set([...this.browsers.values()].map((b) => b.port));
    let port = 9333;
    while (taken.has(port)) port += 1;
    return port;
  }

  /**
   * Keep the number of live Chromium instances bounded: each one costs a few
   * hundred megabytes, and a long chat list would otherwise accumulate them.
   * The least recently used browser nobody is watching goes first.
   */
  async evictBrowsers(keep) {
    const cap = Number(this.settings.maxBrowsers ?? 4);
    if (!cap || cap < 1) return;
    const candidates = [...this.browsers.entries()]
      .filter(([key]) => key !== keep && !this.browserClients.get(key)?.size)
      .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    while (this.browsers.size >= cap && candidates.length) {
      const [key, browser] = candidates.shift();
      this.browsers.delete(key);
      await browser.close().catch(() => {});
      this.broadcast('browser_status', { running: false, key });
    }
  }

  async getBrowser(sessionId) {
    const key = this.browserKey(sessionId);
    let browser = this.browsers.get(key);
    if (!browser) {
      await this.evictBrowsers(key);
      // Headless by default: the page is mirrored inside Skadi's own window, so
      // a second OS window would only get in the way.
      browser = new AgentBrowser({
        headless: this.settings.browserHeadless !== false,
        port: this.browserPort(),
        profileDir: profileDirFor(key),
        key,
      });
      this.browsers.set(key, browser);
      this.wireBrowser(key, browser);
    }
    browser.lastUsed = Date.now();
    await browser.launch();
    // Anyone watching the pane wants frames the moment the agent navigates.
    if (this.browserClients.get(key)?.size) await browser.startScreencast();
    return browser;
  }

  /** Point one browser's events at one chat's stream. */
  wireBrowser(key, browser) {
    for (const event of ['closed', 'status', 'frame', 'console', 'console_clear']) {
      browser.removeAllListeners(event);
    }
    browser.on('closed', () => {
      if (this.browsers.get(key) === browser) this.browsers.delete(key);
      this.broadcast('browser_status', { running: false, key });
    });
    browser.on('status', (s) => this.broadcast('browser_status', { ...s, key }));
    browser.on('frame', ({ data, metadata }) => this.sendBrowserEvent(key, 'frame', { data, metadata }));
    // The console the agent reads with browser_console, mirrored into the pane
    // so the user sees the same errors at the same time.
    browser.on('console', (entry) => this.sendBrowserEvent(key, 'console', entry));
    browser.on('console_clear', () => this.sendBrowserEvent(key, 'console_clear', {}));
  }

  /**
   * A chat that browsed before it was saved keeps its browser: the draft's
   * pages, cookies and console move onto the session id the moment one
   * exists, rather than the tab dying with the draft.
   */
  rekeyBrowser(from, to) {
    const src = this.browserKey(from);
    const dst = this.browserKey(to);
    if (src === dst) return;
    const browser = this.browsers.get(src);
    if (!browser || this.browsers.has(dst)) return;
    this.browsers.delete(src);
    this.browsers.set(dst, browser);
    browser.key = dst;
    this.wireBrowser(dst, browser);
    // Move the watchers too, then tell the UI which stream to reconnect to.
    const watchers = this.browserClients.get(src);
    if (watchers) {
      this.browserClients.delete(src);
      this.browserClients.set(dst, watchers);
    }
    this.broadcast('browser_rekey', { from: src, to: dst });
    this.broadcast('browser_status', { ...browser.status(), key: dst });
  }

  /**
   * Frames and console lines go to their chat's own stream, so they cannot
   * flood the main event feed -- and cannot show up in another chat.
   */
  sendBrowserEvent(key, event, data) {
    const clients = this.browserClients.get(key);
    if (!clients?.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
        continue;
      }
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  handleBrowserStream(req, res, url) {
    const key = this.browserKey(url.searchParams.get('session'));
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    let clients = this.browserClients.get(key);
    if (!clients) this.browserClients.set(key, (clients = new Set()));
    clients.add(res);

    // Show the newest frame and the console so far immediately, so the pane is
    // never blank on open.
    const existing = this.browsers.get(key);
    if (existing?.lastFrame) {
      res.write(`event: frame\ndata: ${JSON.stringify({ data: existing.lastFrame })}\n\n`);
    }
    if (existing?.console.length) {
      res.write(`event: console_history\ndata: ${JSON.stringify({ entries: existing.console.slice(-200) })}\n\n`);
    }
    this.getBrowser(key)
      .then((browser) => browser.startScreencast())
      .catch((err) => {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        } catch {
          /* client already gone */
        }
      });

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      const set = this.browserClients.get(key);
      set?.delete(res);
      // Nobody is watching: stop paying for frames.
      if (!set?.size) {
        this.browserClients.delete(key);
        this.browsers.get(key)?.stopScreencast().catch(() => {});
      }
    });
  }

  /** Shut one chat's browser down and forget it. */
  async closeBrowser(sessionId) {
    const key = this.browserKey(sessionId);
    const browser = this.browsers.get(key);
    if (!browser) return false;
    this.browsers.delete(key);
    await browser.close().catch(() => {});
    this.broadcast('browser_status', { running: false, key });
    return true;
  }

  // ------------------------------------------------------------------- agent

  activeProvider() {
    const cfg = loadProviders();
    return resolveProvider(cfg.active, cfg);
  }

  /**
   * The provider one chat talks to. Every chat carries its own choice -- a
   * provider id and, for a hosted provider, a model -- so one chat can run on
   * the local model while another runs on OpenRouter. A missing choice, or one
   * naming a provider that has since been removed, falls back to the default
   * provider: the one new chats start on.
   */
  providerFor(pick = {}) {
    const cfg = loadProviders();
    const id = pick.provider && cfg.providers[pick.provider] ? pick.provider : cfg.active;
    const provider = resolveProvider(id, cfg);
    const model = String(pick.model || '').trim();
    if (provider.managed) Object.assign(provider, this.localEndpoint(model));
    else if (model) provider.model = model;
    return provider;
  }

  /**
   * Which loaded model a local chat talks to. `wanted` is the profile id the
   * chat picked; when that model is not loaded (any more), the one loaded most
   * recently answers instead. Each model listens on its own port.
   */
  localEndpoint(wanted) {
    const inst = (wanted && this.instances.get(wanted)?.state === 'ready' ? this.instances.get(wanted) : null)
      ?? this.readyInstances().at(-1);
    if (!inst) return { instance: null };
    return {
      instance: inst.id,
      baseUrl: `http://${this.config.host}:${inst.port}/v1`,
      model: this.config.profiles[inst.profileId]?.alias || 'local',
    };
  }

  /** The model id to send: the llama.cpp profile alias, or the provider's own. */
  modelFor(provider) {
    if (provider.managed) {
      if (provider.instance) return provider.model;
      const profile = this.config.profiles[this.config.activeProfile];
      return this.external?.alias || profile?.alias || 'local';
    }
    return provider.model;
  }

  /**
   * The window the endpoint says the active model has, cached. Negative
   * results are cached too, briefly, so an unreachable catalogue costs one
   * lookup rather than one per round.
   */
  async modelContextFor(provider) {
    if (!provider || provider.managed) return null;
    const model = provider.model;
    if (!model) return null;
    const key = `${provider.id}:${model}`;
    const hit = this.modelCtxCache.get(key);
    if (hit && (hit.ctx || Date.now() - hit.at < 5 * 60 * 1000)) return hit.ctx;
    const ctx = (await modelLimits(provider, model))?.contextTokens ?? null;
    this.modelCtxCache.set(key, { ctx, at: Date.now() });
    return ctx;
  }

  /**
   * Whether the active model takes a reasoning effort at all, as its own
   * endpoint reports it. true, false, or null for "it did not say" -- which is
   * every endpoint but OpenRouter, and must not read as "no".
   *
   * `modelLimits` shares `listModels`' cache with the context lookup above, so
   * asking here costs nothing extra.
   */
  async modelReasoningFor(provider) {
    if (!provider || provider.managed || !provider.model) return null;
    return (await modelLimits(provider, provider.model))?.reasoning ?? null;
  }

  /** Context window governing compaction for this provider right now. */
  async contextTokensFor(provider) {
    return resolveContextTokens({
      provider,
      profileCtx: this.config.profiles[provider.instance ?? this.config.activeProfile]?.ctx ?? null,
      externalCtx: this.external?.ctx ?? null,
      modelCtx: await this.modelContextFor(provider).catch(() => null),
    });
  }

  /**
   * Which model writes compaction summaries (Hermes-style auxiliary model).
   * Falls back to the main model when unset, or when a managed llama-server
   * cannot serve the configured one — it holds a single model, so anything
   * but its alias would only 404.
   */
  resolveCompressionModel(provider, mainModel) {
    const alt = String(this.settings.compressionModel || '').trim();
    if (!alt || alt === mainModel) return mainModel;
    if (provider.managed) {
      const served = provider.model || this.external?.alias || this.config.profiles[this.config.activeProfile]?.alias;
      if (alt !== served) return mainModel;
    }
    return alt;
  }

  /** Session ids with either a parent turn or one or more research children. */
  workingSessionIds() {
    return [...new Set([...this.turns.keys(), ...this.subagents.keys()])];
  }

  isSessionWorking(id) {
    return this.turns.has(id) || this.subagents.has(id);
  }

  liveSession(id) {
    const parent = this.turns.get(id)?.session;
    if (parent) return parent;
    for (const child of this.subagents.get(id) ?? []) {
      if (child.session) return child.session;
    }
    return null;
  }

  broadcastTurns() {
    this.broadcast('turns', { sessionIds: this.workingSessionIds() });
  }

  trackSubagent(sessionId, session, agent) {
    if (!sessionId) return null;
    const record = { agent, session, cancelled: false };
    const records = this.subagents.get(sessionId) ?? new Set();
    records.add(record);
    this.subagents.set(sessionId, records);
    this.broadcastTurns();
    return record;
  }

  untrackSubagent(sessionId, record) {
    if (!sessionId || !record) return;
    const records = this.subagents.get(sessionId);
    records?.delete(record);
    if (!records?.size) this.subagents.delete(sessionId);
    this.broadcastTurns();
  }

  /** Abort parent and child work for one chat. Returns agents signalled. */
  abortSessionWork(sessionId) {
    let stopped = 0;
    const parent = this.turns.get(sessionId);
    if (parent) {
      parent.agent.abort();
      stopped++;
    }
    for (const child of this.subagents.get(sessionId) ?? []) {
      child.cancelled = true;
      child.agent.abort();
      stopped++;
    }
    return stopped;
  }

  progressReviewer(provider, model) {
    return async ({ messages, roundStart, signal, ledger }) => {
      const input = progressReviewInput(messages, roundStart, ledger);
      const effort = String(this.settings.loopReviewEffort || 'low').toLowerCase();
      const sampling = { max_tokens: 220, temperature: 0 };
      if (provider.managed) {
        sampling.chat_template_kwargs = { enable_thinking: effort !== 'none', reasoning_effort: effort };
      } else if (effort && effort !== 'none') {
        sampling.reasoning_effort = effort;
      }
      const result = await streamCompletion(provider, {
        model,
        messages: [{ role: 'user', content: progressReviewPrompt(input) }],
        tools: [],
        sampling,
      }, {}, signal);
      return parseProgressReview(result.message?.content);
    };
  }

  async planDelegation(provider, model, request) {
    if (!String(request || '').trim()) return null;
    const result = await streamCompletion(provider, {
      model,
      messages: [{ role: 'user', content: delegationPrompt(request) }],
      tools: [],
      sampling: {
        max_tokens: 220,
        temperature: 0,
        ...(provider.managed ? { chat_template_kwargs: { enable_thinking: false, reasoning_effort: 'none' } } : {}),
      },
    });
    const plan = parseDelegation(result.message?.content);
    if (plan?.delegate && this.settings.autoSubagentReasoning) {
      plan.reasoning = String(this.settings.autoSubagentReasoning);
    }
    return plan;
  }

  async runSubagent(provider, model, {
    task, reasoning = 'none', webSearch = true, sessionId = null, session = null,
  } = {}) {
    const request = String(task || '').trim();
    if (!request) throw new Error('delegate_task requires a task');
    const ctx = { workspace: this.workspace, settings: this.settings, tasks: this.tasks };
    const researchTools = Object.fromEntries(Object.entries({
      ...buildTools(ctx),
      ...(webSearch ? buildWebSearchTools(ctx) : {}),
      ...skillTools(this.skills),
    }).filter(([, tool]) => !tool.mutates));
    const child = new Agent({
      provider,
      model,
      tools: researchTools,
      schemas: toolSchemas(researchTools),
      settings: this.settings,
      approve: async () => false,
      contextTokens: await this.contextTokensFor(provider),
      summaryModel: this.resolveCompressionModel(provider, model),
      reviewProgress: this.progressReviewer(provider, model),
      stopOnLoop: true,
    });
    const project = activeProject();
    const messages = [{
      role: 'system',
      content: `You are a focused read-only subagent. Complete only the delegated task. Gather decisive evidence with the fewest tool calls, do not edit files, and return a concise report with exact paths, lines, commands, or sources. Do not delegate further.\n\nProject: ${projectSummary(project)}`,
    }, { role: 'user', content: request }];
    const effort = String(reasoning || 'none').toLowerCase();
    const sampling = provider.managed
      ? { chat_template_kwargs: { enable_thinking: effort !== 'none', reasoning_effort: effort } }
      : (effort === 'none' ? {} : { reasoning_effort: effort });
    const tracked = this.trackSubagent(sessionId, session, child);
    try {
      await child.run(messages, { sampling });
      const answer = [...messages].reverse().find((m) => m.role === 'assistant' && m.content && !m.tool_calls)?.content;
      return String(answer || 'Subagent finished without a written report.');
    } catch (err) {
      if (tracked?.cancelled) {
        const stopped = new Error('Research subagent stopped.');
        stopped.code = 'SUBAGENT_ABORTED';
        throw stopped;
      }
      throw err;
    } finally {
      this.untrackSubagent(sessionId, tracked);
    }
  }

  async makeAgent(provider, model, { webSearch = true, subagents = true } = {}) {
    const ctx = {
      workspace: this.workspace,
      settings: this.settings,
      tasks: this.tasks,
      // Evaluated when a background task actually starts, by which point the
      // turn has stamped its session id onto ctx (see chat below).
      startBackground: ({ command, shell }) =>
        this.tasks.start({ command, shell, sessionId: ctx.sessionId ?? null, cwd: this.workspace }),
      updatePlan: (request) => this.updateSessionPlan(ctx.sessionId, request, { source: 'agent' }),
    };
    // Filled in once the agent exists: the screenshot hook belongs to *this*
    // turn's agent, not to whichever turn happens to be running.
    let self = null;
    const tools = {
      ...buildTools(ctx),
      ...(webSearch ? buildWebSearchTools(ctx) : {}),
      ...skillTools(this.skills),
      ...memoryTools(this.memory),
      ...(subagents ? { delegate_task: {
        schema: {
          description: 'Delegate one bounded read-only research, search, inspection, or summary task to a focused subagent. Use this before broad exploration. The subagent returns evidence only; the parent remains responsible for edits and final verification.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Self-contained objective and expected evidence.' },
              reasoning: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort. Use none for find/search/summary; raise only for genuinely difficult analysis.' },
            },
            required: ['task'],
          },
        },
        run: ({ task, reasoning }) => this.runSubagent(provider, model, {
          task,
          reasoning,
          webSearch,
          sessionId: ctx.sessionId,
          session: this.turns.get(ctx.sessionId)?.session ?? null,
        }),
      } } : {}),
      ...browserTools(() => this.getBrowser(ctx.sessionId), {
        vision: () => provider.vision !== false,
        onScreenshot: (shot) => {
          // Tagged with the chat that took it: a screenshot belongs in the
          // conversation that asked for it, not in whichever one is on screen.
          this.broadcast('screenshot', { name: shot.name, bytes: shot.bytes, sessionId: ctx.sessionId ?? null });
          // Vision-capable providers get the pixels back on the next round.
          self?.offerImage({
            mediaType: shot.mediaType || 'image/png',
            data: shot.base64,
            label: 'Screenshot of the page you just captured.',
          });
        },
      }),
    };

    const agent = new Agent({
      provider,
      model,
      tools,
      schemas: toolSchemas(tools),
      settings: this.settings,
      approve: (call) => this.requestApproval(call),
      // Compaction budget: the live profile's ctx for a managed llama-server
      // (or an adopted external server's n_ctx), the provider's figure for
      // hosted APIs. Null disables the automatic preflight, not manual use.
      contextTokens: await this.contextTokensFor(provider),
      summaryModel: this.resolveCompressionModel(provider, model),
      reviewProgress: this.progressReviewer(provider, model),
    });

    // Every event carries the session it belongs to: with several turns in
    // flight the UI has to know which chat a token belongs to before it can
    // render it. Token and reasoning deltas arrive as bare strings, so they
    // are wrapped rather than spread.
    for (const event of ['round', 'progress', 'token', 'reasoning', 'tool_call', 'tool_result', 'approval_request', 'retry', 'steer', 'stats', 'done', 'loop_detected', 'loop_review_error', 'compact_start', 'compact_progress', 'compact_end']) {
      agent.on(event, (data) => {
        const sessionId = agent.toolCtx?.sessionId ?? null;
        const payload = typeof data === 'string' ? { text: data } : { ...(data ?? {}) };
        this.broadcast(`agent_${event}`, { ...payload, sessionId });
      });
    }
    // The decode rate the model actually achieved on a real turn. llama.cpp
    // reports it in the response body, which is where this comes from -- the
    // per-request timing lines it prints to stdout depend on the log verbosity,
    // so scraping them misses them entirely at the default level.
    agent.on('stats', (d) => this.recordThroughput({ decode: d?.tps ?? null }));
    // Retries only reached the UI, so a turn that failed after several of them
    // left a log that started at the failure. Record the sequence too.
    agent.on('retry', (d) => {
      console.error('[agent] retry', `${d.attempt}/${d.attempts}`,
        `in ${Math.round((d.delayMs ?? 0) / 1000)}s`, `after ${d.status}:`, d.error);
    });

    // The turn stamps per-session tool context here; tool closures read it
    // lazily so background tasks and edit records land in the right session.
    agent.toolCtx = ctx;
    agent.liveGuidance = () => {
      const session = this.liveSession(ctx.sessionId);
      return [planPrompt(session?.plan), session?.requirements ? `Pinned requirements from the user:\n${session.requirements}` : ''].filter(Boolean).join('\n\n');
    };
    agent.liveLedger = () => {
      const session = this.liveSession(ctx.sessionId);
      return { override: session?.ledger, snapshot: session?.ledgerState };
    };
    // Keep the counters with the chat so a compaction or "continue" does not
    // make the next turn believe no work has happened.
    agent.on('progress', (d) => {
      const session = this.liveSession(ctx.sessionId);
      if (session && d.ledger) session.ledgerState = d.ledger.snapshot;
    });
    self = agent;
    return agent;
  }

  requestApproval(call) {
    return new Promise((resolve) => {
      this.pendingApprovals.set(call.id, resolve);
      // If the browser is not attached there is nobody to ask; fail closed.
      if (!this.clients.size) {
        this.pendingApprovals.delete(call.id);
        resolve(false);
      }
    });
  }

  resolveApproval(id, allow) {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return false;
    this.pendingApprovals.delete(id);
    resolve(Boolean(allow));
    return true;
  }

  /** Append the user's message, with any attachments, to a session. */
  /**
   * The content of one user message: the text, plus any attachments as
   * content blocks. Attachment records are filed on the session as a side
   * effect, since that is where the UI reads them back from.
   */
  userContent(session, text, uploads = [], provider = {}) {
    if (!uploads.length) return text;
    const records = uploads.map((u) => {
      const stored = storeAttachment(u);
      return { ...stored, buffer: readFileSync(stored.file) };
    });
    const blocks = attachmentsToBlocks(records, { vision: provider.vision !== false });
    session.attachments = [
      ...(session.attachments || []),
      ...records.map(({ buffer, ...rest }) => rest),
    ];
    return [...(text ? [{ type: 'text', text }] : []), ...blocks];
  }

  appendUserMessage(session, text, uploads = [], provider = {}) {
    session.messages.push({ role: 'user', content: this.userContent(session, text, uploads, provider) });
    return session;
  }

  async chat(sessionId, text, uploads = [], opts = {}) {
    const systemMessage = typeof opts.systemMessage === 'string' && opts.systemMessage.trim()
      ? opts.systemMessage.trim()
      : '';
    // What the composer picked wins; a caller that names nothing gets what the
    // chat used last, then the default.
    const stored = opts.provider || !sessionId
      ? null
      : this.liveSession(sessionId) ?? await this.sessions.get(sessionId).catch(() => null);
    const provider = this.providerFor(opts.provider
      ? { provider: opts.provider, model: opts.model }
      : { provider: stored?.provider, model: stored?.model });
    if (provider.managed) await this.detectExternal();
    if (!this.chatReady(provider)) {
      throw new Error(
        provider.managed
          ? 'No llama-server is reachable. Start a profile, or pick a hosted provider for this chat.'
          : `${provider.label} credentials are not configured. Add one in Settings → Model & provider.`,
      );
    }
    const model = this.modelFor(provider);
    const project = activeProject();
    // Per-turn reasoning effort from the composer's picker (opencode-style).
    // 'default'/empty means "use the server or provider default" — send nothing.
    const effort = String(opts.effort || '').trim().toLowerCase();

    // One live transcript per session. A message sent while *this* chat's
    // turn is still running used to load a stale copy from disk and race that
    // turn's own save -- last writer won, and a whole turn's replies vanished
    // from the file. It now joins the running transcript instead, and the
    // agent picks it up on its next round, the way a finished background task
    // does. Other chats are unaffected: they get their own turn.
    const live = this.turns.get(sessionId);
    if (!live && sessionId && this.subagents.has(sessionId)) {
      throw new Error('This chat is still running its research subagent. Stop it before sending another message.');
    }
    // `running` is read before the content is built, with nothing awaited in
    // between: the uploads are stored on the session as a side effect of
    // building it, so a steer that lost the race would file every attachment
    // twice -- once here and once again on the new turn below.
    if (live?.agent.running) {
      const content = systemMessage || this.userContent(live.session, text, uploads, provider);
      // Hand it to the agent instead of pushing it onto the transcript here:
      // only the run loop knows when a message is legal, and it keeps the turn
      // going so the model answers mid-flight rather than after. Harness
      // notifications stay system-authored instead of looking user-authored.
      if (live.agent.steer(content, { role: systemMessage ? 'system' : 'user' })) return live.session;
      // The turn ended while the message was in flight; fall through and
      // start a new one on the same session.
    }

    // A turn that has finished but not yet been cleared from the list still
    // holds the transcript of record. Reuse its object: reading the file back
    // here would fork the chat in two, and the turn's own closing save would
    // then land on top of this one's -- the same lost-turn bug from the other
    // side.
    const session = live?.session
      ?? (sessionId
        ? await this.sessions.get(sessionId)
        : await this.sessions.create(text.trim() ? topicTitle(text) : 'Attachment', project?.id));
    // A title nobody has chosen yet: the model gets to improve on it once the
    // first turn is done (see `refineTitle`). Renaming the chat clears this.
    if (!sessionId && !live) session.titleAuto = Boolean(text.trim());

    // The chat existed only as a draft until now; hand it that draft's browser
    // so a page the user opened before sending stays open in this chat. The
    // window names the draft, because every unsent chat has its own: keyed on
    // a shared 'draft', the browser opened in one new chat followed whichever
    // new chat happened to be sent in first.
    if (!sessionId) this.rekeyBrowser(opts.draftKey || 'draft', session.id);

    // The caller asked for the id as soon as there is one: a turn that fails
    // later has to name the chat it failed in, and for a brand-new chat that
    // id did not exist when the request came in.
    opts.onSession?.(session.id);

    // Heal a transcript poisoned before this fix existed: one tool call whose
    // arguments are not JSON makes every later request invalid, so the chat
    // fails forever with whatever the endpoint says about malformed calls.
    // Saved transcripts are repaired on the way into a turn.
    const repaired = repairSession(session);
    if (repaired) {
      console.error('[agent] repaired', repaired, 'malformed tool call(s) in', session.id);
      await this.sessions.save(session);
    }

    if (!session.messages.length) {
      session.messages.push({
        role: 'system',
        content: await buildSystemPrompt({
          skills: this.settings.skillsInPrompt === false
            ? ''
            : skillCatalogue(await this.skills.list()),
          memory: await this.memory.promptBlock({
            enabled: this.settings.memoryInPrompt !== false,
            types: this.settings.memoryTypes,
          }),
          project: projectSummary(project),
          provider,
          model,
          browser: true,
          permissionMode: this.settings.permissionMode || 'default',
        }),
      });
    }

    // The chat keeps the choice it was sent with, so reopening it later goes
    // back to the same provider whatever the default has become since.
    session.provider = provider.id;
    if (provider.managed) {
      if (provider.instance) session.model = provider.instance;
      else delete session.model;
    } else session.model = provider.model;

    session.webSearch = opts.webSearch == null ? session.webSearch !== false : opts.webSearch !== false;
    session.subagents = opts.subagents == null
      ? (session.subagents ?? this.settings.autoSubagents !== false)
      : opts.subagents !== false;
    if (systemMessage) session.messages.push({ role: 'system', content: systemMessage });
    else this.appendUserMessage(session, text, uploads, provider);

    const workTurn = { id: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: redactCredentials(text || systemMessage || 'Continue task').slice(0, 100), startedAt: Date.now(), status: 'running', commands: [] };
    session.workTurns ??= [];
    session.workTurns.push(workTurn);

    // Persist the turn before the run starts: if the app restarts, crashes
    // or is closed mid-turn, the user's message is already on disk and the
    // session still shows up in the rail instead of vanishing silently.
    await this.sessions.save(session);
    // Announced once, here, and it means exactly one thing: a turn is starting
    // on this chat. It is the only place the window learns the id of a chat it
    // has just created by sending into it, so nothing else may borrow it.
    this.broadcast('agent_session', { id: session.id, title: session.title });

    // A no-reasoning router automatically hands bounded discovery to a
    // read-only child. The parent receives only the report, keeping exploratory
    // tool chatter out of its context and leaving edits/verification under the
    // parent agent's control.
    try {
      const delegation = !systemMessage && session.subagents && typeof this.planDelegation === 'function'
        ? await this.planDelegation(provider, model, text)
        : null;
      if (delegation?.delegate && delegation.task) {
        this.broadcast('agent_subagent', { sessionId: session.id, state: 'running', task: delegation.task, reasoning: delegation.reasoning });
        const report = await this.runSubagent(provider, model, {
          task: delegation.task,
          reasoning: delegation.reasoning,
          webSearch: session.webSearch,
          sessionId: session.id,
          session,
        });
        session.messages.push({
          role: 'system',
          content: `[Automatic read-only subagent report; reasoning=${delegation.reasoning}]\n${report}\n\nUse this evidence. Do not repeat the same exploration in the parent turn.`,
        });
        await this.sessions.save(session);
        this.broadcast('agent_subagent', { sessionId: session.id, state: 'done', task: delegation.task, reasoning: delegation.reasoning });
      }
    } catch (err) {
      if (err.code === 'SUBAGENT_ABORTED') throw err;
      // Delegation improves the turn but must never prevent it. The parent can
      // still proceed with its own tools when routing or the child fails.
      console.error('[subagent]', err.message);
      this.broadcast('agent_subagent', { sessionId: session.id, state: 'failed', error: err.message });
    }

    const agent = await this.makeAgent(provider, model, { webSearch: session.webSearch, subagents: session.subagents });
    // Per-turn tool context: background tasks tag this session, and file
    // edits push undo snapshots here (capped; before-images clipped). They
    // ride along in the session file so Undo survives a restart.
    agent.toolCtx.sessionId = session.id;
    agent.on('tool_call', (call) => {
      if (call.name === 'run_command') workTurn.commands.push({ id: call.id, command: redactCredentials(call.args?.command || ''), status: 'running', exitCode: null });
    });
    agent.on('tool_result', (result) => recordCommand(workTurn, result));
    agent.on('done', (result) => { workTurn.outcome = result; workTurn.status = result.incomplete || result.truncated ? 'incomplete' : 'finished'; });
    agent.toolCtx.recordEdit = (entry) => {
      workTurn.editCount = (workTurn.editCount || 0) + 1;
      recordEdit(session, { ...entry, turnId: workTurn.id });
      // The bar above the chat counts this turn's edits as they land.
      this.broadcast('edits', { sessionId: session.id, ...changeSummary(session), history: publicHistory(session) });
    };
    // `deleted` is set by stopTurn when the chat is being removed underneath
    // this turn: every write below checks it, so an agent that is slow to stop
    // cannot save the file back after the delete and resurrect the chat.
    const turn = { agent, session, deleted: false };
    this.turns.set(session.id, turn);
    this.broadcastTurns();
    // Keep a lineage log on the session: what each compaction replaced. The
    // messages themselves go to `session.archive` (see agent.archive above);
    // this records why the live transcript changed shape.
    const compactions = [];
    agent.on('compact_end', (data) => {
      if (data?.compacted) compactions.push({ at: Date.now(), ...data });
    });
    // Save as the turn happens, not just when it ends: each appended message
    // goes to disk the moment it exists, so a crash, a force-close or a lost
    // provider can cost at most the round still streaming. SessionStore
    // serialises and coalesces these, so a chatty turn is not a write storm.
    // The agent awaits this before emitting the round's events, which is what
    // lets a reopened chat trust the saved file over its own live buffer.
    agent.persist = () => (turn.deleted ? null : this.sessions.save(session));
    // Compaction rewrites the transcript the model sees; the chat itself keeps
    // everything. The replaced messages are filed here, in order, so reopening
    // a compacted chat still shows the whole conversation.
    agent.archive = (replaced) => {
      session.archive = [...(session.archive || []), ...replaced];
    };
    agent.on('persist_error', ({ error }) => console.error('[session] save failed:', error));

    const profile = this.config.profiles[this.config.activeProfile] || {};
    const sampling = provider.managed
      ? {
          temperature: profile.temp,
          top_p: profile.topP,
          top_k: profile.topK,
          min_p: profile.minP,
        }
      : { temperature: this.settings.apiTemperature ?? 1 };
    // Reasoning effort override for this turn only. The effort is stated once,
    // here, in OpenAI's spelling; turning it into what a given endpoint
    // actually reads is the adapter's job -- Anthropic maps it to a thinking
    // budget, OpenRouter to its own `reasoning` object.
    //
    // llama.cpp is the exception that cannot be pushed down: it drops
    // top-level reasoning_effort (except "none"), so managed models go through
    // chat_template_kwargs, which the request overrides over the server flag.
    if (effort && effort !== 'default') {
      if (provider.managed) {
        // "none" is a request not to think, so it must not arrive with
        // thinking switched on beside it.
        sampling.chat_template_kwargs = { enable_thinking: effort !== 'none', reasoning_effort: effort };
      } else {
        sampling.reasoning_effort = effort;
      }
    }

    try {
      await agent.run(session.messages, { sampling });
    } finally {
      workTurn.finishedAt = Date.now();
      if (workTurn.status === 'running') workTurn.status = 'interrupted';
      if (compactions.length) session.compactions = [...(session.compactions || []), ...compactions];
      // Once per chat, and about its first message: a later turn must not rename it.
      const askTitle = !systemMessage && session.titleAuto && !session.titleAsked;
      if (askTitle) session.titleAsked = true;
      if (!turn.deleted) await this.sessions.save(session);
      if (this.turns.get(session.id) === turn) this.turns.delete(session.id);
      this.broadcastTurns();
      if (askTitle && !turn.deleted) this.refineTitle(session.id, provider, model, text);
    }
    return session;
  }

  /**
   * Replace the instant title of a new chat with one the model wrote about its
   * first message. Runs after the turn so it never competes with the answer,
   * and gives up quietly: the instant title is already a fine name.
   */
  async refineTitle(id, provider, model, firstMessage) {
    const title = await modelTitle(provider, model, firstMessage);
    if (!title) return;
    try {
      // The chat may have started another turn meanwhile; that turn's own
      // saves would overwrite a title written only to disk.
      const live = this.liveSession(id);
      const session = live ?? await this.sessions.get(id);
      if (!session.titleAuto) return; // renamed by hand while we were asking
      session.title = title;
      session.titleAuto = false;
      if (!live) await this.sessions.save(session, { touch: false });
      this.broadcast('session_title', { id, title });
    } catch {
      // The chat was deleted underneath us; nothing to name.
    }
  }

  /**
   * Stop the turn running in a chat and wait for it to let go, so the chat can
   * be deleted without its own agent writing the file straight back.
   */
  async stopTurn(id) {
    const live = this.turns.get(id);
    const children = this.subagents.get(id);
    if (!live && !children?.size) return false;
    if (live) live.deleted = true;
    this.abortSessionWork(id);
    // The run loop clears its entry in a `finally`; give it that chance rather
    // than racing it. A turn wedged in a tool call is dropped from the list
    // anyway -- the delete matters more than the bookkeeping.
    for (let i = 0; i < 40 && this.isSessionWorking(id); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (live && this.turns.get(id) === live) {
      this.turns.delete(id);
    }
    this.subagents.delete(id);
    this.broadcastTurns();
    return true;
  }

  /**
   * Run fn against a session and persist it. When the session has a live
   * turn, fn mutates the in-flight object and the turn's final save carries
   * it -- otherwise a concurrent save would silently drop the change.
   */
  /** Source files newer than the running process, newest first. */
  async staleSources() {
    const names = ['skadi.mjs', ...(await readdir(join(ROOT, 'src')).catch(() => []))
      .filter((n) => n.endsWith('.mjs')).map((n) => join('src', n))];
    const rows = [];
    for (const name of names) {
      const at = await stat(join(ROOT, name)).then((f) => f.mtimeMs).catch(() => 0);
      if (at > STARTED_AT) rows.push({ name: name.replace(/\\/g, '/'), at });
    }
    return rows.sort((a, b) => b.at - a.at).map((r) => r.name);
  }

  /** The change bar's figures plus the image-free history the chips use. */
  editState(session) {
    return { ...changeSummary(session), history: publicHistory(session) };
  }

  async mutateSession(id, fn) {
    const live = this.liveSession(id);
    if (live) {
      await fn(live);
      return live;
    }
    const s = await this.sessions.get(id);
    await fn(s);
    await this.sessions.save(s);
    return s;
  }

  /** Apply a manual correction to the progress ledger and tell the UI. */
  async updateSessionLedger(id, patch = {}) {
    if (!id) throw new Error('session id required');
    const session = await this.mutateSession(id, (target) => {
      const cur = normaliseLedgerOverride(target.ledger);
      if (patch.dismissGap) cur.dismissed.push(String(patch.dismissGap));
      if (patch.restoreGap) cur.dismissed = cur.dismissed.filter((g) => g !== String(patch.restoreGap));
      if (patch.phase !== undefined) cur.phase = patch.phase;
      if (patch.note !== undefined) cur.note = patch.note;
      target.ledger = normaliseLedgerOverride(cur);
      if (patch.reset) {
        target.ledger = normaliseLedgerOverride(null);
        target.ledgerState = null;
      }
    });
    await this.sessions.save(session);
    const payload = { ledger: normaliseLedgerOverride(session.ledger), state: session.ledgerState ?? null };
    this.broadcast('session_ledger', { sessionId: id, ...payload });
    return payload;
  }

  /** Apply one plan action to the in-flight session object (when present). */
  async updateSessionPlan(id, request, { source = 'user' } = {}) {
    if (!id) throw new Error('session id required');
    const session = await this.mutateSession(id, (target) => {
      target.plan = applyPlanAction(target.plan, request, { source });
    });
    // Plan edits are user-visible state, so persist immediately even during a
    // running turn rather than waiting for the next transcript append.
    await this.sessions.save(session);
    const plan = normalisePlan(session.plan);
    this.broadcast('session_plan', { sessionId: id, plan, source });
    if (source === 'user') {
      const turn = this.turns.get(id);
      if (turn?.agent?.running) {
        turn.agent.steer(`[Execution plan edited by the user; revision ${plan.revision}. Re-read the authoritative live plan at the next step and follow it. Do not recreate skipped or deleted items.]`);
      }
    }
    return plan;
  }

  /** A background task finished: land its result in the session transcript. */
  async onTaskDone(task) {
    // The panel/toast should update immediately; a resumed model turn can take
    // minutes and must not delay the completion signal.
    this.broadcast('task_done', { task });
    if (task.sessionId) {
      const secs = Math.max(0, Math.round(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000));
      const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
      const note =
        `[Automatic background task completion]\n` +
        `The background command \`${task.command}\` finished with exit code ${task.exitCode} after ${dur}.\n` +
        `${(task.tail || '').trim() || '(no output)'}\n\n` +
        `Continue the original work now. Inspect this result, run the next required analysis or verification, update the execution plan, and finish the requested deliverable. Do not wait for another user message.`;
      try {
        // A live turn receives a system steer at its next legal boundary. If
        // it already ended, start a continuation turn automatically: saying
        // "I'll continue when this finishes" must actually continue.
        const live = this.turns.get(task.sessionId);
        if (live?.agent?.running && live.agent.steer(note, { role: 'system' })) return;
        await this.chat(task.sessionId, '', [], { systemMessage: note });
      } catch (err) {
        // Keep the evidence when the model is unavailable. The next manual
        // turn receives it without a fake user bubble.
        try {
          await this.mutateSession(task.sessionId, (s) => {
            const duplicate = s.messages.some((m) => m.role === 'system' && m.content === note);
            if (!duplicate) s.messages.push({ role: 'system', content: note });
          });
        } catch {
          /* session deleted mid-task; the panel still shows the output */
        }
        this.broadcast('task_resume_failed', {
          taskId: task.id,
          sessionId: task.sessionId,
          error: err.message,
        });
      }
    }
  }

  // ------------------------------------------------------------------ routes

  async handleApi(req, res, url) {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error('request body too large');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    };

    const route = url.pathname.replace(/^\/api\//, '');

    try {
      // Maintainer-only routes, served by a module a release does not carry.
      if (route.startsWith('production/') && deploy?.handleRoute && await deploy.handleRoute({ req, res, url, route, json, readBody })) return;
      switch (`${req.method} ${route}`) {
        // Identify this installation before a desktop launcher reuses its port.
        case 'GET instance':
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(resolve(ROOT));
        // Separate from the line above, which older launchers compare whole:
        // the shell adopts an already-running server by process id so that it
        // stops when the window does, instead of outliving it as an orphan.
        case 'GET instance/pid':
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(String(process.pid));
        // ---- updates from GitHub -------------------------------------------
        case 'GET update/status':
          return json(200, await this.updateStatus({ passive: true }));
        case 'POST update/check':
          return json(200, await this.updateStatus({ force: true }));
        case 'POST update/apply': {
          if (!this.canInstallUpdates()) return json(403, { error: 'Automatic installation is disabled in the development checkout.' });
          if (req.headers.origin && req.headers.origin !== url.origin) return json(403, { error: 'Origin mismatch.' });
          if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON required.' });
          if ((await readBody()).confirm !== 'UPDATE') return json(400, { error: 'Confirmation required.' });
          const result = await applyUpdate();
          if (result.updated) setTimeout(() => this.relaunch().catch((err) => console.error('[update]', err)), 500);
          return json(200, { ...result, restarting: Boolean(result.updated) });
        }
        case 'GET state': {
          await this.detectExternal();
          const providersCfg = loadProviders();
          const projectsCfg = loadProjects();
          // The context meter used to show a hardcoded 128k for every API
          // provider. Resolve the active one properly so it shows the window
          // the model actually has -- the same number compaction uses.
          const providers = providerStatus();
          try {
            const active = resolveProvider(providersCfg.active, providersCfg);
            const ctx = await this.contextTokensFor(active);
            const row = providers.find((p) => p.id === active.id);
            if (row && ctx) row.contextTokens = ctx;
            // Whether an effort setting would reach this model at all, so the
            // composer can say so instead of offering a picker that is
            // quietly discarded. Tri-state: null means the endpoint does not
            // publish this, and the picker stays available.
            if (row) row.reasoning = await this.modelReasoningFor(active).catch(() => null);
          } catch {
            // No active provider, or it cannot be resolved: leave the rows be.
          }
          return json(200, {
            config: this.config,
            settings: this.settings,
            // Shipped defaults, so the UI can diff every setting against the
            // factory state and offer a per-row reset.
            appName: canPublish() ? deploy.APP_NAME : 'Skadi',
            canPublish: canPublish(),
            canFetch: canFetch(),
            settingsDefaults: DEFAULT_SETTINGS,
            server: this.serverStatus(),
            // So the window can say "restart Skadi" rather than letting a
            // fresh page call an endpoint this process does not have.
            staleSources: await this.staleSources(),
            vram: this.vram.last ? this.decorateVram(this.vram.last) : null,
            instances: this.instancesView(),
            logs: this.serverLogs.slice(-200),
            providers,
            activeProvider: providersCfg.active,
            projects: projectsWithStatus(projectsCfg.projects),
            activeProject: projectsCfg.active,
            workspace: this.workspace,
            // A reloaded window has no idea which turns are mid-flight; this
            // lets it pick them back up instead of sitting there idle.
            turns: this.workingSessionIds(),
          });
        }

        case 'GET estimate': {
          const id = url.searchParams.get('profile') || this.config.activeProfile;
          return json(200, await this.estimateFor(id));
        }

        // ---- llama-server ------------------------------------------------
        case 'POST server/start':
          return json(200, await this.startServer((await readBody()).profileId));
        case 'POST server/stop': {
          // One model by profile id, or every model Skadi started when none is named.
          const { profileId } = await readBody().catch(() => ({}));
          await this.stopServer(profileId);
          return json(200, { instances: this.instancesView(), config: this.config });
        }
        case 'POST profile/save': {
          // Keep a profile that was made for a load and would otherwise go with it.
          const { profileId } = await readBody();
          const profile = this.config.profiles[profileId];
          if (!profile) return json(404, { error: 'unknown profile' });
          delete profile.temporary;
          saveConfig(this.config);
          this.broadcast('profiles_changed', { config: this.config });
          return json(200, { config: this.config });
        }
        case 'POST server/restart': {
          const { profileId } = await readBody();
          // Restarting is not ejecting: default settings survive it.
          await this.stopServer(profileId, { keepTemporary: true });
          return json(200, await this.startServer(profileId));
        }

        // ---- profiles ----------------------------------------------------
        case 'POST profile': {
          const { profileId, patch } = await readBody();
          if (!this.config.profiles[profileId]) return json(404, { error: 'unknown profile' });
          if (this.config.profiles[profileId].catalog) {
            return json(403, { error: 'Catalog profiles are read-only. Duplicate it to make an editable copy.' });
          }
          Object.assign(this.config.profiles[profileId], patch);
          saveConfig(this.config);
          this.shapeCache.delete(profileId);
          return json(200, await this.estimateFor(profileId));
        }
        case 'POST profile/fit': {
          // Apply the fit to a profile now. `mode` overrides the profile's own
          // setting for this one call, so "squeeze it however you have to" is
          // available without permanently changing what the profile allows.
          const { profileId, apply = true, mode } = await readBody();
          const id = profileId || this.config.activeProfile;
          if (!this.config.profiles[id]) return json(404, { error: 'unknown profile' });
          const result = await this.fitFor(id, { apply, mode });
          return json(200, { profileId: id, ...result, config: this.config });
        }

        // ---- models ------------------------------------------------------
        case 'POST models/dir': {
          // Where models are kept, and where downloads land.
          const wanted = String(((await readBody()).path) || '').trim();
          if (!wanted) return json(400, { error: 'choose a folder' });
          try {
            await this.setModelsDir(wanted);
          } catch (err) {
            return json(400, { error: err.message });
          }
          return json(200, { config: this.config });
        }
        case 'POST model/browse': {
          const path = await pickModelFile(this.config.modelsDir);
          return json(200, { path });
        }
        case 'GET model/scan': {
          return json(200, { models: scanModels(this.config.modelsDir) });
        }
        case 'GET catalog':
          return json(200, this.catalogView());
        case 'GET engines':
          return json(200, { engines: this.engines(), default: this.config.serverExe });
        case 'POST catalog/import':
        case 'POST catalog/remove': {
          const { profileId } = await readBody();
          try {
            if (route.endsWith('import')) this.importCatalogProfile(profileId);
            else this.removeCatalogProfile(profileId);
          } catch (err) {
            return json(err.message.startsWith('unknown') ? 404 : 409, { error: err.message });
          }
          return json(200, { config: this.config });
        }
        case 'POST profile/new': {
          // A fresh profile with default settings for a model file -- the same
          // defaults "Load" would build, but kept and named.
          const { model, label } = await readBody();
          const file = basename(String(model || ''));
          const path = join(this.config.modelsDir, file).replace(/\\/g, '/');
          if (!file || !existsSync(path)) return json(404, { error: `${file || 'That model'} is not in ${this.config.modelsDir}.` });
          const meta = loadModelMeta()[file];
          const mmproj = meta?.mmproj && existsSync(join(this.config.modelsDir, meta.mmproj)) ? meta.mmproj : undefined;
          const made = await this.profileFromModel(path, { mmproj });
          if (String(label || '').trim()) this.config.profiles[made.profileId].label = String(label).trim();
          saveConfig(this.config);
          return json(200, { profileId: made.profileId, config: this.config });
        }
        case 'POST profile/defaults': {
          // The unsaved default-settings profile for a model file, so the
          // Profile and Forecast panels describe that model before it loads.
          const { model } = await readBody();
          try {
            const profileId = await this.defaultProfileForModel(String(model || ''));
            return json(200, { profileId, config: this.config });
          } catch (err) {
            return json(404, { error: err.message });
          }
        }
        case 'GET models/local':
          return json(200, await this.localModels());
        case 'POST model/load': {
          // "Load" in the model manager: pick the best profile for the file
          // (catalog first, then the user's own, else build one) and start it.
          const { name, profileId: wanted, defaults } = await readBody();
          if (wanted && !this.config.profiles[wanted]) return json(404, { error: 'unknown profile' });
          const profileId = wanted
            || (defaults ? await this.defaultProfileForModel(String(name || '')) : await this.profileForModel(String(name || '')));
          // Loading a catalog profile is a way of choosing it, so it joins the list.
          if (this.config.profiles[profileId]?.catalog) this.importCatalogProfile(profileId);
          const server = await this.startServer(profileId);
          return json(200, { profileId, config: this.config, server });
        }

        // ---- Hugging Face ------------------------------------------------
        case 'GET hf/search':
          return json(200, {
            results: await searchModels(url.searchParams.get('q'), { sort: url.searchParams.get('sort') || 'downloads' }),
          });
        case 'GET hf/repo':
          return json(200, await this.repoView(url.searchParams.get('id')));
        case 'POST hf/download': {
          const { repo, file, vision, draft } = await readBody();
          return json(200, { job: await this.startDownload(repo, file, Boolean(vision), Boolean(draft)) });
        }
        case 'GET hf/downloads':
          return json(200, { jobs: this.downloads.list() });
        case 'POST hf/cancel': {
          const { id } = await readBody();
          return json(200, { ok: this.downloads.cancel(id) });
        }
        case 'POST profile/from-model': {
          // Build a whole profile from a .gguf the user picked: read its
          // metadata, then choose the largest context that actually fits.
          const { path, id } = await readBody();
          if (!path || !existsSync(path)) return json(404, { error: `no such file: ${path}` });
          const made = await this.profileFromModel(path, { id });
          return json(200, { ...made, config: this.config, estimate: await this.estimateFor(made.profileId) });
        }
        case 'POST profile/duplicate': {
          // The way to change a catalog profile: copy it, then edit the copy.
          const { profileId, label } = await readBody();
          const source = this.config.profiles[profileId];
          if (!source) return json(404, { error: 'unknown profile' });
          const { catalog, vramGB, temporary, ...copy } = structuredClone(source);
          let id = `${profileId}-copy`;
          for (let n = 2; this.config.profiles[id]; n++) id = `${profileId}-copy-${n}`;
          copy.label = String(label || '').trim() || `${source.label || profileId} (copy)`;
          if (copy.alias) copy.alias = `${copy.alias}-copy`;
          this.config.profiles[id] = copy;
          saveConfig(this.config);
          return json(200, { profileId: id, config: this.config });
        }
        case 'POST profile/delete': {
          const { profileId } = await readBody();
          if (this.config.profiles[profileId]?.catalog) {
            return json(403, { error: 'Catalog profiles cannot be deleted.' });
          }
          if (this.liveInstances().some((i) => i.id === profileId)) {
            return json(409, { error: 'That profile is loaded. Eject it first, then delete it.' });
          }
          if (!this.config.profiles[profileId]) return json(404, { error: 'unknown profile' });
          if (Object.keys(this.config.profiles).length <= 1) {
            return json(400, { error: 'that is the only profile left' });
          }
          delete this.config.profiles[profileId];
          this.shapeCache.delete(profileId);
          if (this.config.activeProfile === profileId) {
            this.config.activeProfile = Object.keys(this.config.profiles)[0];
          }
          saveConfig(this.config);
          return json(200, { config: this.config, activeProfile: this.config.activeProfile });
        }

        // ---- providers ---------------------------------------------------
        case 'POST provider/select': {
          const { id } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[id]) return json(404, { error: 'unknown provider' });
          cfg.active = id;
          saveProviders(cfg);
          return json(200, { providers: providerStatus(), active: id });
        }
        case 'POST provider/key': {
          const { id, apiKey } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[id] || cfg.providers[id].managed) return json(404, { error: 'unknown API provider' });
          const secret = String(apiKey || '').trim();
          if (secret.length > 8192) return json(400, { error: 'credential is too long' });
          saveSecret(id, secret);
          return json(200, { providers: providerStatus() });
        }
        case 'POST provider/model': {
          const { id, model } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[id]) return json(404, { error: 'unknown provider' });
          cfg.providers[id].model = model;
          saveProviders(cfg);
          // The window belongs to the model, not the provider.
          this.modelCtxCache.clear();
          return json(200, { providers: providerStatus() });
        }
        case 'POST provider/endpoint': {
          const { id, baseUrl } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[id]) return json(404, { error: 'unknown provider' });
          if (cfg.providers[id].managed) return json(400, { error: 'the local endpoint is managed by Skadi' });
          const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
          if (!/^https?:\/\//.test(clean)) return json(400, { error: 'endpoint must start with http(s)://' });
          cfg.providers[id].baseUrl = clean;
          saveProviders(cfg);
          return json(200, { providers: providerStatus() });
        }
        case 'POST provider/context': {
          // Pin the window for endpoints that publish no limits, or that
          // publish the wrong ones. Empty clears it back to automatic.
          const { id, contextTokens } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[id]) return json(404, { error: 'unknown provider' });
          const value = Number(contextTokens);
          if (contextTokens === '' || contextTokens == null) delete cfg.providers[id].contextTokens;
          else if (!Number.isFinite(value) || value < 1024) return json(400, { error: 'context window must be at least 1024 tokens' });
          else cfg.providers[id].contextTokens = Math.round(value);
          saveProviders(cfg);
          this.modelCtxCache.clear();
          return json(200, { providers: providerStatus(), active: cfg.active });
        }
        case 'POST provider/vision': {
          const { id, vision } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[id]) return json(404, { error: 'unknown provider' });
          cfg.providers[id].vision = Boolean(vision);
          saveProviders(cfg);
          return json(200, { providers: providerStatus(), active: cfg.active });
        }
        case 'GET provider/info': {
          // What the context meter and the effort picker need to know about one
          // provider + model -- for whichever chat is open, not just the default.
          const provider = this.providerFor({
            provider: url.searchParams.get('id'),
            model: url.searchParams.get('model'),
          });
          return json(200, {
            id: provider.id,
            model: provider.model || null,
            contextTokens: await this.contextTokensFor(provider).catch(() => null),
            reasoning: await this.modelReasoningFor(provider).catch(() => null),
          });
        }
        case 'POST session/provider': {
          // Point one chat at a provider (and model) without sending anything.
          const { id, provider: providerId, model } = await readBody();
          const cfg = loadProviders();
          if (!cfg.providers[providerId]) return json(404, { error: 'unknown provider' });
          const apply = (session) => {
            session.provider = providerId;
            if (!String(model || '').trim()) delete session.model;
            else session.model = String(model).trim();
          };
          // A chat mid-turn owns its transcript; patching the file underneath it
          // would be overwritten by the turn's next save.
          const live = this.liveSession(id);
          if (live) {
            apply(live);
            return json(200, { provider: live.provider, model: live.model ?? null });
          }
          const session = await this.sessions.get(id);
          apply(session);
          await this.sessions.save(session, { touch: false });
          return json(200, { provider: session.provider, model: session.model ?? null });
        }
        case 'POST session/web-search': {
          const { id, enabled } = await readBody();
          if (this.isSessionWorking(id)) return json(409, { error: 'Web search cannot change while this chat is running.' });
          const session = await this.sessions.get(id);
          session.webSearch = Boolean(enabled);
          await this.sessions.save(session, { touch: false });
          return json(200, { webSearch: session.webSearch });
        }
        case 'POST session/subagents': {
          const { id, enabled } = await readBody();
          if (this.isSessionWorking(id)) return json(409, { error: 'Subagents cannot change while this chat is running.' });
          const session = await this.sessions.get(id);
          session.subagents = Boolean(enabled);
          await this.sessions.save(session, { touch: false });
          return json(200, { subagents: session.subagents });
        }
        case 'GET provider/models': {
          const id = url.searchParams.get('id');
          try {
            return json(200, { models: await listModels(resolveProvider(id)) });
          } catch (err) {
            return json(200, { models: [], error: err.message });
          }
        }

        // ---- projects ----------------------------------------------------
        // Built-in folder picker: drives, directory listing and mkdir behind
        // the in-app browser modal. No native dialog is ever shown.
        // ---- benchmarks --------------------------------------------------
        // Measured numbers, kept in a file rather than a profile label so a
        // run is recorded once and read everywhere. Labels drift; this does
        // not. Appending is a POST so a future run can be added without an
        // edit to the file by hand.
        case 'GET benchmarks': {
          const file = join(ROOT, 'config', 'benchmarks.json');
          if (!existsSync(file)) return json(200, { updated: null, suites: [] });
          try {
            return json(200, JSON.parse(readFileSync(file, 'utf8')));
          } catch (err) {
            return json(500, { error: `benchmarks.json is not readable: ${err.message}` });
          }
        }
        case 'POST benchmarks': {
          const { suiteId, row } = await readBody();
          const file = join(ROOT, 'config', 'benchmarks.json');
          if (!existsSync(file)) return json(404, { error: 'no benchmarks.json' });
          const data = JSON.parse(readFileSync(file, 'utf8'));
          const suite = (data.suites || []).find((x) => x.id === suiteId);
          if (!suite) return json(404, { error: `unknown suite: ${suiteId}` });
          suite.rows.push(row || {});
          data.updated = new Date().toISOString().slice(0, 10);
          writeFileSync(file, JSON.stringify(data, null, 2) + String.fromCharCode(10));
          return json(200, data);
        }
        case 'GET drives': {
          return json(200, {
            drives: listDrives(),
            home: homedir().replace(/\\/g, '/'),
            workspace: String(this.workspace).replace(/\\/g, '/'),
          });
        }
        case 'GET dir/list': {
          try {
            return json(200, listSubdirs(url.searchParams.get('path')));
          } catch (err) {
            return json(403, { error: err.message });
          }
        }
        case 'POST dir/mkdir': {
          const { path: base, name } = await readBody();
          const clean = String(name || '').trim().replace(/[<>:"|?*]/g, '').slice(0, 80);
          if (!clean) return json(400, { error: 'folder name required' });
          if (!base) return json(400, { error: 'path required' });
          const full = join(resolve(String(base)), clean);
          try {
            mkdirSync(full, { recursive: true });
          } catch (err) {
            return json(403, { error: `cannot create ${full}: ${err.message}` });
          }
          try {
            return json(200, listSubdirs(full));
          } catch (err) {
            return json(403, { error: err.message });
          }
        }
        case 'POST project/add': {
          const { path, name } = await readBody();
          const project = addProject(path, name);
          return json(200, { project: { ...project, exists: true }, projects: projectsWithStatus(loadProjects().projects), active: project.id });
        }
        case 'POST project/select': {
          const { id } = await readBody();
          return json(200, { project: projectsWithStatus([selectProject(id)])[0], workspace: this.workspace });
        }
        case 'POST project/remove': {
          const { id } = await readBody();
          const cfg = removeProject(id);
          return json(200, { projects: projectsWithStatus(cfg.projects), active: cfg.active });
        }

        case 'POST terminal/run': {
          const { command } = await readBody();
          const source = String(command || '').trim();
          if (!source) return json(400, { error: 'command required' });
          const cwd = resolve(this.workspace);
          const result = await new Promise((done) => {
            const child = spawn('powershell.exe', [
              '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source,
            ], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const finish = (payload) => {
              if (settled) return;
              settled = true;
              done(payload);
            };
            child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('error', (err) => finish({ stdout, stderr: `${stderr}${err.message}`, code: -1 }));
            child.on('close', (code) => finish({ stdout, stderr, code: code ?? -1 }));
            setTimeout(() => {
              if (settled) return;
              child.kill();
              finish({ stdout, stderr: `${stderr}\nCommand timed out after 120 seconds.`.trim(), code: -1 });
            }, 120000).unref();
          });
          return json(200, { ...result, cwd });
        }

        // ---- browser -----------------------------------------------------
        case 'POST browser/open': {
          const { url: target, sessionId } = await readBody();
          const browser = await this.getBrowser(sessionId);
          await browser.open(target);
          return json(200, { url: target });
        }
        case 'POST browser/close': {
          const { sessionId } = await readBody().catch(() => ({}));
          await this.closeBrowser(sessionId);
          return json(200, { ok: true });
        }
        case 'POST browser/reload':
          return json(200, { url: await (await this.getBrowser((await readBody()).sessionId)).reload() });
        case 'POST browser/back':
          return json(200, { url: await (await this.getBrowser((await readBody()).sessionId)).history(-1) });
        case 'POST browser/forward':
          return json(200, { url: await (await this.getBrowser((await readBody()).sessionId)).history(1) });
        case 'POST browser/shot': {
          const { sessionId } = await readBody();
          const shot = await (await this.getBrowser(sessionId)).screenshot({});
          return json(200, { name: shot.name, bytes: shot.bytes });
        }
        case 'GET browser/status': {
          const browser = this.browsers.get(this.browserKey(url.searchParams.get('session')));
          return json(200, browser ? browser.status() : { running: false, viewport: VIEWPORT });
        }
        case 'GET browser/console': {
          const browser = this.browsers.get(this.browserKey(url.searchParams.get('session')));
          return json(200, { entries: browser ? browser.console.slice(-200) : [] });
        }
        case 'POST browser/console/clear': {
          const { sessionId } = await readBody().catch(() => ({}));
          this.browsers.get(this.browserKey(sessionId))?.clearConsole();
          return json(200, { ok: true });
        }
        case 'POST browser/audio': {
          // Page volume and mute, as set from the pane.
          const { sessionId, volume, muted } = await readBody();
          return json(200, await (await this.getBrowser(sessionId)).setAudio({ volume, muted }));
        }
        case 'POST browser/input': {
          // Clicks and keystrokes the user made on the mirrored page.
          const input = await readBody();
          const browser = await this.getBrowser(input.sessionId);
          if (input.kind === 'click') await browser.clickAt(input.x, input.y, { clickCount: input.clickCount || 1 });
          else if (input.kind === 'scroll') await browser.scrollAt(input.x, input.y, input.deltaY || 0, input.deltaX || 0);
          else if (input.kind === 'text') await browser.typeText(String(input.text || ''));
          else if (input.kind === 'key') await browser.pressKey(String(input.key));
          else return json(400, { error: `unknown input kind: ${input.kind}` });
          return json(200, { ok: true });
        }
        case 'POST browser/device': {
          const { mode, sessionId } = await readBody();
          return json(200, await (await this.getBrowser(sessionId)).setDevice(mode));
        }

        // ---- content -----------------------------------------------------
        case 'GET skills':
          return json(200, await this.skills.list());
        case 'GET skill': {
          const name = url.searchParams.get('name');
          if (!name) return json(400, { error: 'name required' });
          try {
            return json(200, await this.skills.load(name));
          } catch (err) {
            return json(404, { error: err.message });
          }
        }
        case 'POST skill/save': {
          const { name, description, body, previousName } = await readBody();
          if (!String(name || '').trim() || !String(body || '').trim()) {
            return json(400, { error: 'name and body are required' });
          }
          const saved = await this.skills.save(name, description, body);
          // A rename leaves the old directory behind; remove it so the
          // catalogue does not list the skill twice.
          if (previousName && previousName.toLowerCase() !== saved.name.toLowerCase()) {
            try {
              await this.skills.remove(previousName);
            } catch {
              /* already gone */
            }
          }
          return json(200, { skill: saved });
        }
        case 'POST skill/delete':
          try {
            return json(200, { removed: await this.skills.remove((await readBody()).name) });
          } catch (err) {
            return json(404, { error: err.message });
          }
        case 'GET memory':
          return json(200, await this.memory.list());
        case 'POST memory/save': {
          const { name, description, type, content } = await readBody();
          if (!String(name || '').trim() || !String(content || '').trim()) {
            return json(400, { error: 'name and content are required' });
          }
          return json(200, { id: await this.memory.save({ name, description, type, content }) });
        }
        case 'POST memory/delete':
          try {
            return json(200, { removed: await this.memory.forget((await readBody()).name) });
          } catch (err) {
            return json(404, { error: err.message });
          }
        case 'GET sessions/search': {
          const query = (url.searchParams.get('q') || '').slice(0, 200);
          if (!query.trim()) return json(200, []);
          const matches = [];
          for (const row of await this.sessions.list()) {
            const session = this.liveSession(row.id) || await this.sessions.get(row.id).catch(() => null);
            const match = session && searchSession(session, query);
            if (match) matches.push({ ...row, match });
            if (matches.length >= 100) break;
          }
          return json(200, matches);
        }
        case 'GET session/workflow': {
          const id = url.searchParams.get('id');
          const session = this.liveSession(id) || await this.sessions.get(id);
          const turns = turnReview(session, this.tasks.list());
          if (!this.isSessionWorking(id)) for (const turn of turns) if (turn.status === 'running') turn.status = 'interrupted';
          return json(200, { context: contextDetails(session), turns });
        }
        case 'POST session/requirements': {
          const { id, requirements } = await readBody();
          if (typeof requirements !== 'string' || requirements.length > 8000) return json(400, { error: 'Requirements must be text, up to 8000 characters.' });
          await this.mutateSession(id, (s) => { s.requirements = requirements; });
          return json(200, { ok: true });
        }
        case 'POST session/checkpoint/restore': {
          const { id, turnId, direction, confirm } = await readBody();
          if (!['undo', 'redo'].includes(direction) || confirm !== 'RESTORE CHECKPOINT') return json(400, { error: 'Checkpoint confirmation required.' });
          // File restores require a quiet workspace, including background commands.
          if (this.turns.size || this.tasks.list().some(t => ['running', 'interrupted'].includes(t.status))) return json(409, { error: 'Finish running work and review recovered tasks before restoring a checkpoint.' });
          let result;
          await this.mutateSession(id, async s => {
            if (!s.projectId) throw new Error('This chat has no project; its checkpoint cannot be safely restored.');
            const project = this.reviewProject(s.projectId);
            result = await applyTurn(s, project.path, turnId, direction);
            s.messages.push({ role: 'user', content: `[Checkpoint ${direction === 'undo' ? 'reverted' : 'reapplied'}: ${turnId}] Files: ${result.paths.join(', ')}. Continue from the current files.` });
          });
          return json(200, { ok: true, ...result });
        }
        case 'POST session/checkpoint': {
          const { id, turnId, name } = await readBody();
          if (typeof name !== 'string' || !name.trim() || name.length > 100) return json(400, { error: 'Use a checkpoint name of 1–100 characters.' });
          await this.mutateSession(id, (s) => {
            const turn = s.workTurns?.find(t => t.id === turnId);
            if (!turn) throw new Error('Turn not found');
            turn.name = redactCredentials(name.trim());
          });
          return json(200, { ok: true });
        }
        case 'GET sessions': {
          // scope=all hands back every project's chats. The rail shows the
          // active project's own, but a chat filed elsewhere -- one still
          // running, most of the time -- has to stay reachable instead of
          // vanishing with nothing to say it exists.
          const scope = url.searchParams.get('scope');
          return json(200, await this.sessions.list(scope === 'all' ? null : loadProjects().active));
        }
        case 'GET session': {
          const session = await this.sessions.get(url.searchParams.get('id'));
          // What is read back is the whole conversation, not the model's view
          // of it: anything compaction replaced is put back in front of the
          // summary that stands in for it. `messages` alone would open a
          // compacted chat on a summary with nothing above it, as though the
          // first half had been deleted.
          const archive = session.archive || [];
          // The meter measures the window, so it counts the live transcript --
          // and it used to estimate an opened chat at bytes/4 over the raw
          // JSON, which counts a screenshot's base64 as three quarters of a
          // million tokens. Send the same estimate compaction uses instead.
          return json(200, {
            ...session,
            messages: archive.length ? [...archive, ...session.messages] : session.messages,
            estimatedTokens: estimateTokens(session.messages),
            // Images are megabytes and the window never needs them: send the
            // history without them, and the figures for the bar.
            undo: publicHistory(session),
            changes: changeSummary(session),
          });
        }
        case 'POST session/delete': {
          const { id } = await readBody();
          // Stop the turn first. A running agent saves after every message, so
          // deleting the file under it only made the chat reappear a second
          // later -- with the rail still showing it as working.
          await this.stopTurn(id);
          await this.closeBrowser(id);
          await this.sessions.remove(id);
          return json(200, { ok: true });
        }
        case 'POST sessions/wipe': {
          const active = loadProjects().active;
          for (const id of this.workingSessionIds()) {
            const session = this.liveSession(id);
            if (!active || (session?.projectId ?? null) === active) await this.stopTurn(id);
          }
          return json(200, { count: await this.sessions.wipe(active) });
        }
        // ---- session organisation (chats-only left rail) -------------------
        case 'GET groups':
          return json(200, await this.sessions.listGroups(loadProjects().active));
        case 'POST session/update': {
          const { id, patch } = await readBody();
          if (!id) return json(400, { error: 'id required' });
          const session = await this.sessions.update(id, patch || {});
          return json(200, { session });
        }
        case 'POST session/plan': {
          const { id, ...request } = await readBody();
          if (!id) return json(400, { error: 'id required' });
          return json(200, { plan: await this.updateSessionPlan(id, request, { source: 'user' }) });
        }
        case 'GET session/ledger': {
          const id = url.searchParams.get('id');
          if (!id) return json(400, { error: 'id required' });
          const session = this.liveSession(id) ?? await this.sessions.get(id);
          return json(200, { ledger: normaliseLedgerOverride(session.ledger), state: session.ledgerState ?? null });
        }
        case 'POST session/ledger': {
          const { id, ...patch } = await readBody();
          if (!id) return json(400, { error: 'id required' });
          return json(200, await this.updateSessionLedger(id, patch));
        }
        case 'POST group/create': {
          const { name } = await readBody();
          const group = await this.sessions.createGroup(name, loadProjects().active);
          return json(200, { group });
        }
        case 'POST group/rename': {
          const { id, name } = await readBody();
          return json(200, { group: await this.sessions.renameGroup(id, name) });
        }
        case 'POST group/delete': {
          const { id } = await readBody();
          await this.sessions.deleteGroup(id);
          return json(200, { ok: true });
        }
        case 'POST session/compact': {
          // Manual compaction, the Hermes /compress equivalent: summarise the
          // session's older messages now instead of waiting for the preflight.
          const { id } = await readBody();
          if (this.isSessionWorking(id)) return json(409, { error: 'that chat is mid-turn; stop it first' });
          const target = await this.sessions.get(id);
          const cProvider = this.providerFor({ provider: target.provider, model: target.model });
          if (cProvider.managed) await this.detectExternal();
          if (!this.chatReady(cProvider)) {
            throw new Error(
              cProvider.managed
                ? 'No llama-server is reachable. Start a profile, or pick a hosted provider for this chat.'
                : `No credential is configured for ${cProvider.label}. Add one in Settings → Model & provider.`,
            );
          }
          // A throwaway agent with no tools: the summary call runs with tools
          // disabled, so there is nothing for it to need.
          const compactor = new Agent({
            provider: cProvider,
            model: this.modelFor(cProvider),
            tools: {},
            schemas: [],
            settings: this.settings,
            contextTokens: await this.contextTokensFor(cProvider),
            summaryModel: this.resolveCompressionModel(cProvider, this.modelFor(cProvider)),
          });
          for (const event of ['compact_start', 'compact_progress', 'compact_end']) {
            compactor.on(event, (data) => this.broadcast(`agent_${event}`, { ...(data ?? {}), sessionId: target.id }));
          }
          // Same bargain as an automatic compaction: the replaced messages go
          // on the session, so the chat still reads back whole.
          compactor.archive = (replaced) => {
            target.archive = [...(target.archive || []), ...replaced];
          };
          const result = await compactor.compact(target.messages, { manual: true });
          if (result.compacted) {
            target.compactions = [...(target.compactions || []), { at: Date.now(), manual: true, ...result }];
            await this.sessions.save(target);
          }
          return json(200, { session: target, compaction: result });
        }

        // ---- background tasks ----------------------------------------------
        case 'GET tasks':
          return json(200, this.tasks.list());
        case 'GET task/log': {
          try {
            const id = url.searchParams.get('id');
            const max = Number(url.searchParams.get('max')) || 8000;
            return json(200, { log: this.tasks.log(id, max) });
          } catch (err) {
            return json(404, { error: err.message });
          }
        }
        case 'POST task/stop': {
          try {
            return json(200, { message: this.tasks.stop((await readBody()).task_id) });
          } catch (err) {
            return json(404, { error: err.message });
          }
        }
        case 'POST tasks/clear':
          return json(200, { cleared: this.tasks.clearFinished() });

        // ---- edit undo and redo ---------------------------------------------
        // One pair of endpoints: undo writes an edit's before-image back, redo
        // writes its after-image again. Neither drops the entry, so a reversed
        // edit stays in the history and can be put back.
        case 'POST edit/undo':
        case 'POST edit/redo': {
          const direction = route.endsWith('redo') ? 'redo' : 'undo';
          const { sessionId, callId } = await readBody();
          if (!sessionId || !callId) return json(400, { error: 'sessionId and callId are required' });
          try {
            let entry;
            const session = await this.mutateSession(sessionId, async (s) => {
              entry = await applyOne(s, this.workspace, callId, direction);
              // The model is told, so it continues from what the file now
              // holds rather than from what it believes it wrote.
              s.messages.push({
                role: 'user',
                content: direction === 'undo'
                  ? `[undo] Reverted ${entry.path} to its state before the edit. Continue from there.`
                  : `[redo] Reapplied the edit to ${entry.path}. Continue from there.`,
              });
            });
            return json(200, { ok: true, direction, path: entry.path, ...this.editState(session) });
          } catch (err) {
            return json(404, { error: err.message });
          }
        }

        // ---- every edit in one chat -----------------------------------------
        // The bar above a chat: undo the lot when a turn broke something, or
        // put the lot back. Both are all-or-nothing -- a failure part-way
        // restores every file already touched.
        case 'POST session/changes/revert':
        case 'POST session/changes/reapply': {
          const direction = route.endsWith('reapply') ? 'redo' : 'undo';
          const { sessionId, confirm } = await readBody();
          if (!sessionId) return json(400, { error: 'sessionId is required' });
          if (confirm !== (direction === 'undo' ? 'REVERT ALL' : 'REAPPLY ALL')) {
            return json(400, { error: 'Confirmation required.' });
          }
          // A turn writing files underneath a bulk revert would race it.
          if (this.isSessionWorking(sessionId)) return json(409, { error: 'This chat is still working. Stop the turn first.' });
          try {
            let outcome;
            const session = await this.mutateSession(sessionId, async (s) => {
              outcome = await applyAll(s, this.workspace, direction);
              s.messages.push({
                role: 'user',
                content: direction === 'undo'
                  ? `[undo all] Reverted every edit made in this chat (${outcome.count} across ${outcome.paths.length} file(s)). The files are back as they were before it started. Continue from there.`
                  : `[redo all] Reapplied every reverted edit in this chat (${outcome.count} across ${outcome.paths.length} file(s)). Continue from there.`,
              });
            });
            return json(200, { ok: true, direction, ...outcome, ...this.editState(session) });
          } catch (err) {
            return json(409, { error: err.message });
          }
        }

        case 'GET session/changes': {
          const session = await this.sessions.get(url.searchParams.get('id'));
          return json(200, this.editState(session));
        }

        // ---- reveal in Explorer ----------------------------------------------
        case 'POST file/reveal': {
          const { path } = await readBody();
          try {
            const file = safePath(this.workspace, String(path || ''));
            if (!existsSync(file)) return json(404, { error: `no such file: ${path}` });
            // /select opens the parent folder with the file highlighted.
            // Keep the switch and path as separate argv entries. Node will
            // quote the path when needed, while Explorer still receives its
            // required comma delimiter as `/select, <path>`.
            // No windowsHide here: CREATE_NO_WINDOW starts the process but
            // suppresses the new Explorer window, so the click appears dead.
            const child = spawn('explorer.exe', ['/select,', file], {
              detached: true,
              stdio: 'ignore',
            });
            await new Promise((resolve, reject) => {
              child.once('spawn', resolve);
              child.once('error', reject);
            });
            child.unref();
            return json(200, { ok: true });
          } catch (err) {
            return json(403, { error: err.message });
          }
        }

        // ---- the project's files (Files tab, file viewer) -------------------------
        case 'GET fs/tree':
        case 'GET fs/file':
        case 'GET fs/find': {
          try {
            const root = this.workspace;
            if (route === 'fs/tree') return json(200, { root: basename(root), ...listDirectory(root, url.searchParams.get('path')) });
            if (route === 'fs/file') return json(200, readProjectFile(root, url.searchParams.get('path')));
            return json(200, findFiles(root, url.searchParams.get('q')));
          } catch (err) {
            return json(err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'No such file or folder.' : err.message });
          }
        }

        // ---- working tree (read-only git) ----------------------------------
        case 'GET git/status': {
          const project = this.reviewProject(url.searchParams.get('project'));
          return json(200, { ...(await gitStatus(project.path)), project: { id: project.id, name: project.name } });
        }
        case 'GET git/diff': {
          const project = this.reviewProject(url.searchParams.get('project'));
          const path = url.searchParams.get('path');
          return json(200, await gitDiff(project.path, path || null));
        }

        // ---- the turn ----------------------------------------------------
        case 'POST chat': {
          const {
            sessionId, draftKey, message, attachments = [], effort = 'default', provider, model, webSearch = true, subagents = true,
          } = await readBody();
          json(202, { accepted: true, attachments: describeAttachments(attachments) });
          // The chat a failure belongs to. For a brand-new chat that is not
          // known until the turn creates it, and a failure the window cannot
          // place is a composer stuck on “Stop generating” for good.
          let failedIn = sessionId ?? null;
          const onSession = (id) => { failedIn = id; };
          // Nothing is broadcast when the turn *resolves*: `agent_session`
          // means “a turn started on this chat”, and firing it again at the
          // end left the rail pulsing “working…” over a chat that had
          // finished. The turn announces itself at the start, and the window
          // refreshes the row from `agent_done`.
          this.chat(sessionId, message, attachments, { effort, onSession, draftKey, provider, model, webSearch, subagents }).catch((err) => {
            // Also log it: a turn can fail with no browser attached, and a
            // silent failure is the hardest kind to debug.
            console.error('[agent]', err.message);
            // The one-line message is a summary of someone else's error. Keep
            // the response that produced it, or a failure like "400: ERROR"
            // is unanswerable after the fact.
            if (err.body) console.error('[agent] response body:', String(err.body).slice(0, 1200));
            this.broadcast('agent_error', { error: err.message, sessionId: failedIn });
            // Authoritative running list, in case the failure landed before
            // the turn was ever registered (no `turns` event would follow).
            this.broadcastTurns();
          });
          return;
        }
        case 'POST abort': {
          // Stop one chat's turn, or every running turn when none is named.
          const { sessionId } = await readBody().catch(() => ({}));
          const ids = sessionId ? [sessionId] : this.workingSessionIds();
          let stopped = 0;
          for (const id of ids) stopped += this.abortSessionWork(id);
          for (const [id] of this.pendingApprovals) this.resolveApproval(id, false);
          return json(200, { ok: true, stopped });
        }
        case 'POST approve': {
          const { id, allow } = await readBody();
          return json(200, { resolved: this.resolveApproval(id, allow) });
        }
        case 'POST settings':
          this.settings = saveSettings(await readBody());
          this.localSearxng.reconcile(this.settings).catch((err) => console.error('[searxng]', err.message));
          // The running agent holds the old object; hand it the new one so a
          // mid-session permission-mode switch (or any other tweak) applies to
          // the very next tool call instead of the next turn.
          for (const t of this.turns.values()) t.agent.settings = this.settings;
          for (const children of this.subagents.values()) {
            for (const child of children) child.agent.settings = this.settings;
          }
          return json(200, this.settings);
        case 'POST settings/reset':
          this.settings = resetSettings();
          this.localSearxng.reconcile(this.settings).catch((err) => console.error('[searxng]', err.message));
          for (const t of this.turns.values()) t.agent.settings = this.settings;
          for (const children of this.subagents.values()) {
            for (const child of children) child.agent.settings = this.settings;
          }
          return json(200, this.settings);

        default:
          return json(404, { error: `no route for ${req.method} ${route}` });
      }
    } catch (err) {
      return json(500, { error: err.message });
    }
  }

  /** Screenshots captured by the agent, served back to the UI. */
  async handleShot(req, res, url) {
    const name = basename(url.searchParams.get('name') || '');
    const file = join(SHOTS_DIR, name);
    if (!name || !file.startsWith(SHOTS_DIR) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    // From the extension, not a constant: shots taken before the switch to
    // JPEG are still on disk and still open from old chats.
    const type = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=31536000' });
    res.end(await readFile(file));
  }

  async handleStatic(req, res, url) {
    const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, '');
    const file = join(ROOT, 'ui', rel);
    if (!file.startsWith(join(ROOT, 'ui')) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  }

  handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    if (this.vram.last) res.write(`event: vram\ndata: ${JSON.stringify(this.decorateVram(this.vram.last))}\n\n`);
    // Which chats are mid-turn, as the server sees it. Without this a client
    // that reconnected (sleep, a dropped stream, a reload mid-turn) keeps
    // whatever it last inferred -- and a chat stuck "running" is a composer
    // that never comes back.
    res.write(`event: turns\ndata: ${JSON.stringify({ sessionIds: this.workingSessionIds() })}\n\n`);
    res.write(`event: web_search_status\ndata: ${JSON.stringify(this.webSearchStatus)}\n\n`);

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
    });
  }

  /** Installing replaces source files, so the development checkout may check but not self-update. */
  canInstallUpdates() {
    return !canPublish();
  }

  async updateStatus({ force = false, passive = false } = {}) {
    const installed = await installedVersion();
    if (passive && this.settings.updateCheck === false) {
      return {
        enabled: true,
        installable: this.canInstallUpdates(),
        current: installed,
        ...(this.lastUpdate || {}),
      };
    }
    try {
      const result = await checkForUpdate({ force });
      this.lastUpdate = result;
      this.broadcast('update', { available: result.available });
      return { enabled: true, installable: this.canInstallUpdates(), ...result };
    } catch (err) {
      // A network that is down is not news; say so only to a person who asked.
      if (force) return { enabled: true, installable: this.canInstallUpdates(), current: installed, error: err.message };
      return { enabled: true, installable: this.canInstallUpdates(), current: installed, ...(this.lastUpdate || {}), error: err.message };
    }
  }

  /** Look for updates shortly after start and every few hours after that. */
  startUpdateChecks() {
    if (this.settings.updateCheck === false) return;
    const check = () => this.updateStatus().catch(() => {});
    setTimeout(check, 20_000).unref();
    setInterval(check, 6 * 60 * 60 * 1000).unref();
  }

  /**
   * Start the replacement server, then step aside. The new process inherits
   * whatever keeps this one alive -- the window's job object included -- and
   * waits for the port to come free, so the window sees a brief reconnect and
   * nothing else.
   */
  async relaunch() {
    const logs = join(ROOT, 'logs');
    mkdirSync(logs, { recursive: true });
    const log = openSync(join(logs, 'skadi.log'), 'a');
    const args = [join(ROOT, 'skadi.mjs'), '--no-open', '--port', String(this.port)];
    spawn(process.execPath, args, {
      cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, SKADI_WAIT_PORT: '45' },
    }).unref();
    await this.shutdown();
    process.exit(0);
  }

  listen(port) {
    this.port = port;
    this.vram.start();
    this.startUpdateChecks();
    this.localSearxng.reconcile(this.settings).catch((err) => console.error('[searxng]', err.message));
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/events') return this.handleEvents(req, res);
      if (url.pathname === '/api/browser/stream') return this.handleBrowserStream(req, res, url);
      if (url.pathname === '/api/shot') return this.handleShot(req, res, url);
      if (url.pathname.startsWith('/api/')) return this.handleApi(req, res, url);
      return this.handleStatic(req, res, url);
    });
    // Bind to loopback only. This process can run arbitrary shell commands and
    // holds API keys; it has no business being reachable from the network.
    // A restarted server is launched before the old one has let go of the
    // port; it waits its turn rather than dying on EADDRINUSE.
    const deadline = Date.now() + Number(process.env.SKADI_WAIT_PORT || 0) * 1000;
    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE' || Date.now() > deadline) throw err;
      setTimeout(() => server.listen(port, '127.0.0.1'), 400);
    });
    server.listen(port, '127.0.0.1');
    return server;
  }

  async shutdown() {
    this.vram.stop();
    await this.localSearxng.stop();
    await Promise.all([...this.browsers.values()].map((b) => b.close().catch(() => {})));
    this.browsers.clear();
    await this.stopServer();
  }
}
