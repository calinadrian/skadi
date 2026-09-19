// Owns the llama-server.exe process: builds its argv from a profile, starts and
// stops it, watches for readiness, and scrapes the throughput numbers it prints.
// This is the part that replaces the four Start-*.ps1 scripts -- settings become
// live values you can change and re-apply instead of constants baked into a file.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Is the vision tower switched on for this profile?
 *
 * Deliberately separate from whether one is *named*, so turning vision off
 * keeps the filename rather than making you find it again. Absent means on,
 * which keeps every profile written before the switch existed behaving as it
 * did. Exported because the fitter has to agree with the launcher: leaving the
 * tower out of the launch but counting its 0.9 GB in the fit would quietly cost
 * you the context it was supposed to free.
 */
export function visionOn(profile) {
  return Boolean(profile.mmproj) && profile.vision !== false;
}

/**
 * The device a profile should run on: the one it names, or the discrete card.
 *
 * A named device only counts if this build actually has it. Device ids belong to
 * the backend (`Vulkan0`, `CUDA0`), so a profile saved under one engine names a
 * device that does not exist under another, and passing it through makes
 * llama-server refuse to start. `devices` is the probed id list; when it is
 * unknown the name is trusted, since guessing wrong would be worse than asking.
 */
export function resolveDevice(profile, { defaultDevice, devices } = {}) {
  if (profile.device === 'auto') return undefined;
  if (profile.device && (!devices?.length || devices.includes(profile.device))) return profile.device;
  return defaultDevice;
}

/**
 * Translate a profile into llama-server arguments.
 * Flags are only emitted when the profile actually sets them, so an unset field
 * means "let llama.cpp choose" rather than "send a zero".
 */
export function buildArgs(cfg, profile, modelFile, opts = {}) {
  const args = ['-m', modelFile];
  const push = (flag, value) => {
    if (value === undefined || value === null || value === '') return;
    args.push(flag, String(value));
  };

  // A sibling file named relative to modelsDir, or an absolute path anywhere.
  const sibling = (name) =>
    /[\\/]/.test(name) ? name.replace(/\\/g, '/') : `${cfg.modelsDir}/${name}`.replace(/\\/g, '/');

  if (visionOn(profile)) push('--mmproj', sibling(profile.mmproj));
  // Some MTP heads ship as their own small .gguf beside the weights rather than
  // baked into them, and then speculative decoding needs to be pointed at it.
  if (profile.draftModel) push('-md', sibling(profile.draftModel));
  // Which GPUs are in play at all. This box reports two Vulkan devices -- the
  // discrete card and the CPU's integrated graphics, whose 46 GB of "free"
  // memory is system RAM wearing a GPU's hat. Left to itself llama.cpp will
  // split across both, which looks like a fit and runs like a swap file, so a
  // profile naming its device is a profile whose fit means something.
  // 'auto' is the explicit opt-out: hand llama.cpp every device it can find.
  // Anything else names a device; unset falls back to the discrete card, which
  // is what you want often enough that it should not need saying.
  push('-dev', resolveDevice(profile, opts));
  push('-sm', profile.splitMode);
  push('-mg', profile.mainGpu);
  push('-c', profile.ctx);
  push('-ngl', profile.ngl);
  push('-ngld', profile.ngld);
  // Mixture-of-Experts models are fitted by moving expert tensors to the CPU,
  // not whole layers: the experts are most of the weights and only a fraction of
  // them run per token, so this trades far less speed per gigabyte reclaimed
  // than -ngl does.
  push('-ncmoe', profile.nCpuMoe);
  // A tensor-level placement map, as llama-fit-params works it out: which expert
  // tensors of which blocks stay on the CPU. Finer than -ncmoe, which can only
  // move whole layers' experts, and it is what the fitter actually returns.
  push('-ot', profile.overrideTensor);
  push('-t', profile.threads);
  push('--threads-batch', profile.threadsBatch);
  push('--flash-attn', profile.flashAttn);
  push('--cache-type-k', profile.cacheK);
  push('--cache-type-v', profile.cacheV);
  push('--kv-tail-tokens', profile.kvTailTokens);
  push('-b', profile.batch);
  push('-ub', profile.ubatch);
  if (profile.kvOffload) args.push('--kv-offload');
  if (profile.jinja) args.push('--jinja');
  if (profile.useChatTemplate !== false && cfg.chatTemplateFile && existsSync(cfg.chatTemplateFile)) {
    args.push('--chat-template-file', cfg.chatTemplateFile);
  }
  // Some templates take their own parameters -- preserving thinking blocks, for
  // one -- which are set through the template rather than a llama.cpp flag.
  push('--chat-template-kwargs', profile.chatTemplateKwargs);

  push('--reasoning', profile.reasoning);
  push('--reasoning-format', profile.reasoningFormat);
  if (profile.reasoningPreserve) args.push('--reasoning-preserve');
  push('--reasoning-effort', profile.reasoningEffort);

  push('--temp', profile.temp);
  push('--top-k', profile.topK);
  push('--top-p', profile.topP);
  push('--min-p', profile.minP);
  push('--repeat-penalty', profile.repeatPenalty);
  push('--repeat-last-n', profile.repeatLastN);
  push('--presence-penalty', profile.presencePenalty);
  push('--frequency-penalty', profile.frequencyPenalty);

  push('--spec-type', profile.specType);
  push('--spec-draft-n-max', profile.specDraftNMax);
  push('--spec-draft-p-min', profile.specDraftPMin);
  push('--spec-draft-type-k', profile.specDraftCacheK);
  push('--spec-draft-type-v', profile.specDraftCacheV);

  push('-a', profile.alias);
  args.push('--metrics');
  push('--host', cfg.host);
  push('--port', cfg.port);
  if (profile.kvUnified) args.push('-kvu');

  // llama.cpp's own fitter only adjusts arguments we did *not* set. Every
  // profile here sets -c and -ngl explicitly, so `-fit on` by itself has
  // nothing left to adjust -- which is why a profile can be marked "fit: on"
  // and still spill 4 GB into system RAM. It is kept as a backstop for the
  // arguments we leave unset, and given the same margin Skadi reserves, so the
  // two do not disagree about how much of the card is ours to fill.
  // ...and once Skadi has fitted a profile itself, the backstop is not just
  // redundant, it is noisy: given an explicit -ngl it prints "already set by
  // user, abort", which reads like a failure and is not one.
  push('-fit', opts.fitBackstop ?? profile.fit);
  push('-fitt', opts.fitTargetMiB);
  push('-fitc', opts.fitCtxFloor);
  push('-np', profile.parallel);

  if (Array.isArray(profile.extraArgs)) args.push(...profile.extraArgs.map(String));
  return args;
}

/** Can something bind host:port right now? Used to hand each loaded model its own port. */
export function portIsFree(host, port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * PID of whatever is listening on a TCP port, or null.
 * Used to attribute VRAM to a llama-server this harness did not spawn.
 */
export async function pidListeningOn(port) {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ],
      { windowsHide: true, timeout: 5000 },
    );
    const pid = Number(String(stdout).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const capabilitiesCache = new Map();
const deviceCache = new Map();

/**
 * What this particular llama-server binary can do, read out of its own --help.
 *
 * Two things matter, and both vary between builds:
 *   * which flags exist -- an unknown one kills the server on startup;
 *   * which KV cache types it accepts. The `kvarn*` quants come from the
 *     ISTA-DASLab fork, not upstream llama.cpp, so a profile asking for kvarn4
 *     against an upstream build is refused at load time. Knowing the list lets
 *     the fitter pick a type this binary will actually take.
 */
export async function probeCapabilities(serverExe) {
  if (capabilitiesCache.has(serverExe)) return capabilitiesCache.get(serverExe);
  let caps = null;
  try {
    const { stdout, stderr } = await execFileAsync(serverExe, ['--help'], {
      maxBuffer: 8 << 20,
      windowsHide: true,
    });
    const help = `${stdout}\n${stderr}`;
    // Short forms too (-fitt, -ub, -kvu...): builds vary in which of those they
    // carry, and an unknown short flag kills the server just as dead as an
    // unknown long one.
    const flags = new Set(help.match(/(?<![\w-])-{1,2}[a-z][a-z0-9-]*/gi) || []);
    const allowed = /--cache-type-k[\s\S]{0,200}?allowed values:\s*([^\n]+)/i.exec(help);
    const cacheTypes = allowed
      ? allowed[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : null;
    caps = { flags, cacheTypes };
  } catch {
    caps = null; // probe failed; caller should not filter
  }
  capabilitiesCache.set(serverExe, caps);
  return caps;
}

/** Back-compat shim: just the flag set. */
export async function probeSupportedFlags(serverExe) {
  return (await probeCapabilities(serverExe))?.flags ?? null;
}

/**
 * The GPUs this build can offload to, as it names them itself.
 *
 * Worth asking rather than assuming, because the answer is not "the graphics
 * card". A desktop CPU with integrated graphics presents a second Vulkan device
 * whose memory is system RAM, and it reports tens of gigabytes free. A fitter
 * that believes it has 60 GB of VRAM will place layers there, report a
 * comfortable fit, and decode at a crawl.
 *
 * `discrete` is the device to pin to: the one with real, bounded memory.
 */
export async function probeDevices(serverExe) {
  if (deviceCache.has(serverExe)) return deviceCache.get(serverExe);
  let result = null;
  try {
    const { stdout, stderr } = await execFileAsync(serverExe, ['--list-devices'], {
      maxBuffer: 8 << 20,
      windowsHide: true,
      timeout: 60000,
    });
    const text = `${stdout}\n${stderr}`;
    const devices = [];
    // "  Vulkan0: AMD Radeon RX 9070 XT (16304 MiB, 13289 MiB free)"
    const row = /^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/gm;
    for (let m; (m = row.exec(text)); ) {
      devices.push({ id: m[1], name: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) });
    }

    // Integrated graphics is the device backed by host memory. llama.cpp prints
    // `uma: 1` for it in its own load banner; from the device list alone the
    // reliable signal is that it reports far more memory than a graphics card
    // has, because it is reporting a share of RAM.
    const uma = new Set(
      [...text.matchAll(/ggml_vulkan:\s*(\d+)\s*=\s*(.+?)\s*\|\s*uma:\s*1/g)].map((m) => `Vulkan${m[1]}`),
    );
    const integrated = (d) => uma.has(d.id) || d.totalMiB > 32768;
    const candidates = devices.filter((d) => !integrated(d));
    result = {
      devices,
      discrete: (candidates.length ? candidates : devices).reduce(
        (best, d) => (!best || d.totalMiB > best.totalMiB ? d : best),
        null,
      ),
    };
  } catch {
    result = null;
  }
  deviceCache.set(serverExe, result);
  return result;
}

/** llama-fit-params sits next to llama-server in the same build. */
/**
 * Which llama-server binary a profile runs on.
 *
 * Forks are not interchangeable: BeeLlama accepts `kvarn*` cache types that
 * stock llama.cpp rejects outright, and stock accepts flags a fork may lag on.
 * A profile naming its own `serverExe` is a profile that can rely on its
 * fork's features without forcing every other profile onto that build. The
 * capability and device probes are already cached per exe path, so pointing
 * profiles at different binaries costs one extra probe each, not one per launch.
 */
export function exeFor(cfg, profile) {
  return (profile && profile.serverExe) || cfg.serverExe;
}

export function fitParamsExe(serverExe) {
  return String(serverExe).replace(/llama-server(\.exe)?$/i, (m, ext) => `llama-fit-params${ext || ''}`);
}

// Memory-relevant arguments only. llama-fit-params is not a server and rejects
// the serving flags outright (-kvu, --host, --metrics...), so this is an
// explicit list rather than a filtered buildArgs.
const FIT_PARAM_FLAGS = [
  // The device list first: fitting against a different set of GPUs than the
  // server will use makes the answer meaningless.
  ['-dev', (p, cfg, opts) => resolveDevice(p, opts)],
  ['-sm', (p) => p.splitMode],
  ['-mg', (p) => p.mainGpu],
  // Omitted entirely when vision is switched off, so the fit reflects the
  // launch. llama-fit-params does not accept --mmproj anyway and drops it; the
  // margin it is given is widened instead, and that widening keys off the same
  // switch.
  ['--mmproj', (p, cfg) => (visionOn(p) ? (/[\\/]/.test(p.mmproj) ? p.mmproj : `${cfg.modelsDir}/${p.mmproj}`).replace(/\\/g, '/') : undefined)],
  // The draft model is a second set of weights on the same card, so the fitter
  // has to know about it or it will fit the main model into space the draft
  // then wants.
  ['-md', (p, cfg) => (p.draftModel && !/[\\/]/.test(p.draftModel) ? `${cfg.modelsDir}/${p.draftModel}`.replace(/\\/g, '/') : p.draftModel)],
  ['-fa', (p) => p.flashAttn],
  ['-ctk', (p) => p.cacheK],
  ['-ctv', (p) => p.cacheV],
  ['-b', (p) => p.batch],
  ['-ub', (p) => p.ubatch],
  ['-np', (p) => p.parallel],
  ['-t', (p) => p.threads],
];

/**
 * Ask llama.cpp itself what will fit, and get back the arguments to use.
 *
 * Skadi's own arithmetic in gguf.mjs is a prediction: file size plus a KV
 * formula plus a flat allowance for compute buffers. It is instant, which is
 * what makes the sliders in the UI feel live, but it is a model of llama.cpp's
 * allocator rather than the allocator itself -- and for a Mixture-of-Experts
 * model it is simply the wrong shape, because the right lever there is moving
 * *expert tensors* to the CPU (-ncmoe), not whole layers.
 *
 * llama-fit-params ships with the same build, reads the real tensor table,
 * measures the card's actual free memory and prints the arguments that fit. It
 * costs a couple of seconds and no model load, so it is worth running before
 * every launch and treating as the authority.
 *
 * `decide` names the arguments llama.cpp is allowed to choose. Anything not
 * listed is pinned to the profile's own value, because its fitter only adjusts
 * arguments you did not set.
 */
export async function fitWithLlamaCpp(cfg, profile, modelFile, opts = {}) {
  const { targetMiB = 1024, ctxFloor = 4096, decide = ['ngl', 'ncmoe'], defaultDevice, devices } = opts;
  const exe = fitParamsExe(exeFor(cfg, profile));
  if (!existsSync(exe)) return { available: false, reason: `llama-fit-params not found: ${exe}` };

  const args = ['-m', modelFile];
  for (const [flag, read] of FIT_PARAM_FLAGS) {
    const value = read(profile, cfg, { defaultDevice, devices });
    if (value !== undefined && value !== null && value !== '') args.push(flag, String(value));
  }
  if (!decide.includes('ctx') && profile.ctx) args.push('-c', String(profile.ctx));
  if (!decide.includes('ngl') && profile.ngl !== undefined) args.push('-ngl', String(profile.ngl));
  if (!decide.includes('ncmoe') && profile.nCpuMoe !== undefined && profile.nCpuMoe !== null) {
    args.push('-ncmoe', String(profile.nCpuMoe));
  }
  args.push('-fit', 'on', '-fitt', String(Math.max(Math.round(targetMiB), 0)));
  if (decide.includes('ctx')) args.push('-fitc', String(ctxFloor));

  // Drop anything this particular build has never heard of, same as for the server.
  const caps = await probeCapabilities(exe);
  const argv = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token !== '-m' && caps?.flags && /^-{1,2}[a-z]/i.test(token) && !caps.flags.has(token)) {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    argv.push(token);
  }

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await execFileAsync(exe, argv, {
      maxBuffer: 8 << 20,
      windowsHide: true,
      timeout: 120000,
    }));
  } catch (err) {
    // The last line of its output is usually "to show complete usage, run with
    // -h", which says nothing. The line that names the problem is the one to
    // carry back.
    const lines = (err.stderr || err.message || 'llama-fit-params failed')
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const reason =
      lines.find((l) => /error|invalid|failed|unsupported|unknown/i.test(l)) ??
      lines[lines.length - 1];
    return { available: false, reason, argv };
  }

  // The tool prints one line of CLI arguments, e.g. `-c 116736 -ngl -1`, or for
  // a Mixture-of-Experts model a long quoted -ot expression naming the exact
  // expert tensors to leave on the CPU.
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^-[a-z]/i.test(s))
    .pop();
  if (!line) return { available: false, reason: 'llama-fit-params printed no arguments', argv };

  const patch = {};
  const read = (flag) => {
    // Values may be bare or double-quoted; the -ot expression is always quoted
    // and full of the regex metacharacters that make naive splitting unsafe.
    const m = new RegExp(`(?:^|\\s)${flag}\\s+(?:"([^"]*)"|(\\S+))`).exec(line);
    return m ? (m[1] ?? m[2]) : null;
  };

  // Number(null) is 0, not NaN, so an absent flag has to be rejected before the
  // conversion -- otherwise "-ncmoe was not printed" reads as "-ncmoe 0".
  const num = (flag) => {
    const raw = read(flag);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const ctx = num('-c');
  if (ctx !== null) patch.ctx = ctx;

  const ngl = num('-ngl');
  // -1 is llama.cpp's "as many as there are"; the profiles spell that 99.
  if (ngl !== null) patch.ngl = ngl < 0 ? 99 : ngl;

  const ncmoe = num('-ncmoe');
  if (ncmoe !== null) patch.nCpuMoe = ncmoe;

  // Pass the expression through verbatim. It goes to spawn() as one argv entry,
  // so it must NOT keep the shell quotes the printed line carries.
  const ot = read('-ot');
  patch.overrideTensor = ot || null;

  return { available: true, patch, line, argv };
}

/**
 * One llama-server process holding one model. Skadi runs as many of these as
 * the user has loaded models, each on its own port; `id` is the profile it was
 * launched from, which is what the rest of the app calls it.
 */
export class LlamaServer extends EventEmitter {
  constructor(id = null) {
    super();
    this.id = id;
    this.port = null;
    this.proc = null;
    this.state = 'stopped'; // stopped | starting | ready | error
    this.profileId = null;
    this.args = null;
    this.startedAt = null;
    this.logs = [];
    this.lastError = null;
    this.throughput = { prompt: null, decode: null, draftAccept: null };
  }

  get pid() {
    return this.proc?.pid ?? null;
  }

  snapshot() {
    return {
      id: this.id,
      port: this.port,
      state: this.state,
      pid: this.pid,
      profileId: this.profileId,
      args: this.args,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      throughput: this.throughput,
      lastError: this.lastError,
    };
  }

  _log(stream, text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = { ts: Date.now(), stream, line };
      this.logs.push(entry);
      // Keep the ring buffer small; the UI only ever shows the tail.
      if (this.logs.length > 800) this.logs.splice(0, this.logs.length - 800);
      this.emit('log', entry);
      this._scrape(line);
    }
  }

  /**
   * llama-server prints timing lines after each request, e.g.
   *   prompt eval time = 1234.5 ms / 900 tokens ( 1.37 ms per token, 729.2 tokens per second)
   * Capturing them here means throughput shows up in the UI with no extra polling.
   */
  _scrape(line) {
    const prompt = /prompt eval time.*?([\d.]+)\s+tokens per second/i.exec(line);
    if (prompt) {
      this.throughput.prompt = Number(prompt[1]);
      this.emit('throughput', this.throughput);
    }
    const decode = /^\s*eval time.*?([\d.]+)\s+tokens per second/i.exec(line);
    if (decode) {
      this.throughput.decode = Number(decode[1]);
      this.emit('throughput', this.throughput);
    }
    const draft = /draft acceptance rate\s*=\s*([\d.]+)/i.exec(line);
    if (draft) {
      this.throughput.draftAccept = Number(draft[1]);
      this.emit('throughput', this.throughput);
    }
    // llama.cpp prefixes its level as a single letter after the timestamp:
    // "0.00.777.568 W common_fit_params: failed to fit params...". A warning
    // that says "failed to" is still a warning, and promoting it to lastError
    // puts a red error in the status bar over a server that started fine.
    const isWarning = /^\s*[\d.]+\s+W\s/.test(line);
    if (!isWarning && /error|failed to|out of memory|vk::|ggml_vulkan.*error/i.test(line)) {
      this.lastError = line.trim();
    }
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.snapshot());
  }

  /** Start llama-server and resolve once /health reports ok. */
  async start(cfg, profile, modelFile, { timeoutMs = 300000, fit = {} } = {}) {
    if (this.proc) throw new Error('llama-server is already running; stop it first');
    const serverExe = exeFor(cfg, profile);
    if (!existsSync(serverExe)) throw new Error(`llama-server not found: ${serverExe}`);
    if (!existsSync(modelFile)) throw new Error(`model not found: ${modelFile}`);

    let args = buildArgs(cfg, profile, modelFile, fit);
    const caps = await probeCapabilities(serverExe);
    const supported = caps?.flags ?? null;

    // A cache type this binary will refuse is worth saying out loud before the
    // load fails with it, because the error llama-server prints names the value
    // but not where it came from.
    if (caps?.cacheTypes) {
      for (const key of ['cacheK', 'cacheV']) {
        const type = String(profile[key] || '').toLowerCase();
        if (type && !caps.cacheTypes.includes(type)) {
          this._log(
            'harness',
            `this build does not support KV cache type "${type}" (${key}); ` +
              `it accepts: ${caps.cacheTypes.join(', ')}`,
          );
        }
      }
    }

    if (supported) {
      const dropped = [];
      const filtered = [];
      for (let i = 0; i < args.length; i++) {
        const token = args[i];
        // -m is how the model gets named; if the help text were ever unreadable
        // enough to lose it, dropping it would be worse than passing it blind.
        if (token !== '-m' && /^-{1,2}[a-z]/i.test(token) && !supported.has(token)) {
          dropped.push(token);
          // Also drop this flag's value, if it takes one.
          if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
          continue;
        }
        filtered.push(token);
      }
      if (dropped.length) {
        this._log('harness', `dropped flags this build does not support: ${dropped.join(' ')}`);
        args = filtered;
      }
    }

    this.args = args;
    this.port = Number(cfg.port) || null;
    this.profileId = profile.id ?? null;
    this.lastError = null;
    this.throughput = { prompt: null, decode: null, draftAccept: null };
    this.logs = [];
    this._setState('starting');
    this._log('harness', `${serverExe} ${args.join(' ')}`);

    this.proc = spawn(serverExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.startedAt = Date.now();

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._log('stdout', d));
    this.proc.stderr.on('data', (d) => this._log('stderr', d));

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.startedAt = null;
      const clean = code === 0 || signal === 'SIGTERM';
      this._log('harness', `llama-server exited (code=${code} signal=${signal})`);
      this._setState(clean ? 'stopped' : 'error');
    });
    this.proc.on('error', (err) => {
      this.lastError = err.message;
      this._setState('error');
    });

    await this._waitForHealth(cfg, timeoutMs);
    this._setState('ready');
    return this.snapshot();
  }

  async _waitForHealth(cfg, timeoutMs) {
    const url = `http://${cfg.host}:${cfg.port}/health`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) {
        throw new Error(this.lastError || 'llama-server exited before becoming ready');
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        // Not listening yet -- a 27B model takes a while to load from disk.
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error(`llama-server did not become healthy within ${Math.round(timeoutMs / 1000)}s`);
  }

  async stop({ timeoutMs = 15000 } = {}) {
    if (!this.proc) return;
    const proc = this.proc;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill();
    const timer = setTimeout(() => {
      // Windows ignores SIGTERM for console apps in some cases; fall back to taskkill.
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* nothing more we can do */
      }
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  /** llama-server's own view of the loaded model. */
  async props(cfg) {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/props`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`/props returned ${res.status}`);
    return res.json();
  }
}
