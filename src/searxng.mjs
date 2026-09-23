// Private web search with SearXNG, run natively: no Docker.
//
// One switch in Settings turns it on. The first time, Skadi sets it up by
// itself under <root>/searxng: it finds Python (3.10+), downloads the SearXNG
// source, makes a virtual environment and installs its packages. After that,
// turning it on just starts the server on 127.0.0.1 and turning it off stops
// it. DuckDuckGo stays the zero-setup default and the fallback whenever the
// local instance is not ready.
//
// SearXNG officially targets Linux. On Windows it runs unchanged apart from a
// single `import pwd` (used only to word a Valkey error message), which a
// two-line stand-in module on PYTHONPATH satisfies.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, closeSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './config.mjs';

const exec = promisify(execFile);
export const SEARXNG_SOURCE = 'https://codeload.github.com/searxng/searxng/tar.gz/refs/heads/master';
const MIN_PYTHON = [3, 10];

// When no usable Python is on the machine (Windows), Skadi fetches its own:
// python.org's official NuGet build, a plain zip with venv and pip included.
// It unpacks into the searxng folder, needs no admin rights or installer, and
// never touches PATH or the user's other Pythons.
export const PORTABLE_PYTHON_VERSION = '3.12.10';
export function portablePythonUrl(arch = process.arch) {
  const id = arch === 'arm64' ? 'pythonarm64' : arch === 'ia32' ? 'pythonx86' : 'python';
  const v = PORTABLE_PYTHON_VERSION;
  return `https://api.nuget.org/v3-flatcontainer/${id}/${v}/${id}.${v}.nupkg`;
}

export function localSearxngUrl(settings = {}) {
  const port = Math.min(65535, Math.max(1, Number(settings.searxngPort) || 8888));
  return `http://127.0.0.1:${port}`;
}

/** Everything lives in one folder, so "Reinstall" is simply "delete it". */
export function searxngPaths(dir) {
  const win = process.platform === 'win32';
  return {
    dir,
    src: join(dir, 'src'),
    venv: join(dir, 'venv'),
    python: join(dir, 'venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    runtime: join(dir, 'python'),
    runtimePython: join(dir, 'python', 'tools', 'python.exe'),
    runtimeArchive: join(dir, 'python.nupkg'),
    shim: join(dir, 'shim'),
    settings: join(dir, 'settings.yml'),
    marker: join(dir, 'install.json'),
    pid: join(dir, 'searxng.pid'),
    log: join(dir, 'searxng.log'),
    archive: join(dir, 'download.tar.gz'),
  };
}

export function searxngSettingsYml({ port, secret }) {
  return [
    'use_default_settings: true',
    'general:',
    '  instance_name: "Skadi search"',
    'server:',
    `  secret_key: "${secret}"`,
    '  bind_address: "127.0.0.1"',
    `  port: ${port}`,
    '  limiter: false',
    '  image_proxy: false',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n');
}

const PWD_SHIM = [
  '# Stand-in for the Unix-only pwd module. SearXNG only reads it to name the',
  '# user in a Valkey error message, which never applies to Skadi.',
  'import collections, getpass',
  'struct_passwd = collections.namedtuple("struct_passwd", "pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell")',
  'def getpwuid(uid):',
  '    return struct_passwd(getpass.getuser(), "x", uid, 0, "", "", "")',
  '',
].join('\n');

/** The Python commands worth trying, most specific first. */
export function pythonCandidates(platform = process.platform) {
  return platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
}

/**
 * Pythons installed but not on PATH: the python.org installer's default
 * folders (per user and all users). Newest first.
 */
export function knownPythonDirs(env = process.env) {
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Python'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const m = /^Python3(\d+)/i.exec(name);
      if (m && Number(m[1]) >= MIN_PYTHON[1]) found.push([Number(m[1]), join(root, name, 'python.exe')]);
    }
  }
  return found.sort((a, b) => b[0] - a[0]).map(([, path]) => path).filter((path) => existsSync(path));
}

export class LocalSearxng {
  constructor({
    dir = join(ROOT, 'searxng'),
    run = exec,
    spawnProcess = spawn,
    fetcher = fetch,
    platform = process.platform,
    onStatus = () => {},
    pythonDirs = null,
    arch = process.arch,
  } = {}) {
    this.pythonDirs = pythonDirs;
    this.arch = arch;
    this.paths = searxngPaths(dir);
    this.run = run;
    this.spawnProcess = spawnProcess;
    this.fetcher = fetcher;
    this.platform = platform;
    this.onStatus = onStatus;
    this.child = null;
    this.pid = null;
    this.state = { state: 'off', installed: this.isInstalled() };
    this.pending = null;
    this.wanted = false;
  }

  setStatus(state, extra = {}) {
    this.state = { state, installed: this.isInstalled(), ...extra };
    this.onStatus(this.state);
  }

  isInstalled() {
    return existsSync(this.paths.marker) && existsSync(this.paths.python) && existsSync(join(this.paths.src, 'searx', 'webapp.py'));
  }

  async healthy(url) {
    try {
      const response = await this.fetcher(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitReady(url, seconds = 60) {
    for (let attempt = 0; attempt < seconds; attempt++) {
      if (!this.wanted) return false;
      if (await this.healthy(url)) return true;
      if (this.child && this.child.exitCode !== null) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  /** A Python new enough for SearXNG, as [command, leading args]. */
  async findPython() {
    const probe = 'import sys, venv, ensurepip; print(sys.version_info[0], sys.version_info[1])';
    const candidates = [
      // Skadi's own copy from an earlier install comes first.
      ...(existsSync(this.paths.runtimePython) ? [[this.paths.runtimePython, []]] : []),
      ...pythonCandidates(this.platform),
      ...(this.platform === 'win32' ? (this.pythonDirs ?? knownPythonDirs()).map((path) => [path, []]) : []),
    ];
    for (const [command, args] of candidates) {
      try {
        const { stdout } = await this.run(command, [...args, '-c', probe], { windowsHide: true, timeout: 20_000 });
        const [major, minor] = String(stdout).trim().split(/\s+/).map(Number);
        if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) return [command, args, `${major}.${minor}`];
      } catch { /* not this one */ }
    }
    return null;
  }

  /** Windows: download python.org's portable build into the searxng folder. */
  async installPortablePython() {
    const p = this.paths;
    this.setStatus('installing', { step: `Python not found: downloading Python ${PORTABLE_PYTHON_VERSION} for Skadi (about 15 MB, one time)…` });
    await mkdir(p.dir, { recursive: true });
    const response = await this.fetcher(portablePythonUrl(this.arch), { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`could not download Python (HTTP ${response.status})`);
    await writeFile(p.runtimeArchive, Buffer.from(await response.arrayBuffer()));
    this.setStatus('installing', { step: 'Unpacking Python…' });
    await rm(p.runtime, { recursive: true, force: true });
    await mkdir(p.runtime, { recursive: true });
    await this.run(this.tarCommand(), ['-xf', p.runtimeArchive, '-C', p.runtime], { windowsHide: true, timeout: 180_000 });
    await rm(p.runtimeArchive, { force: true });
    if (!existsSync(p.runtimePython)) throw new Error('the Python download did not contain tools/python.exe');
  }

  tarCommand() {
    // Windows 10+ ships bsdtar here; Git's GNU tar earlier on PATH cannot
    // always cope with Windows paths, so name the system one explicitly.
    return this.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  }

  /** First-time setup. Idempotent: a finished install is left alone. */
  async install() {
    if (this.isInstalled()) return;
    const p = this.paths;
    this.setStatus('installing', { step: 'Looking for Python 3.10 or newer…' });
    let python = await this.findPython();
    if (!python && this.platform === 'win32') {
      try {
        await this.installPortablePython();
      } catch (err) {
        throw new Error(`SearXNG needs Python 3.10 or newer and Skadi could not download it (${err.message}). ` +
          'Check the internet connection and press Reinstall, or install Python from python.org and turn SearXNG on again.');
      }
      python = await this.findPython();
    }
    if (!python) {
      throw new Error(this.platform === 'win32'
        ? 'SearXNG needs Python 3.10 or newer, and the copy Skadi downloaded would not run. Install Python from python.org, then press Reinstall.'
        : this.platform === 'darwin'
          ? 'SearXNG needs Python 3.10 or newer. Install it with "brew install python" or from python.org, then turn SearXNG on again.'
          : 'SearXNG needs Python 3.10 or newer with venv. Install it (Debian/Ubuntu: "sudo apt install python3 python3-venv"; Fedora: "sudo dnf install python3"), then turn SearXNG on again.');
    }
    await mkdir(p.dir, { recursive: true });

    this.setStatus('installing', { step: 'Downloading SearXNG…' });
    const response = await this.fetcher(SEARXNG_SOURCE, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`could not download SearXNG (HTTP ${response.status})`);
    await writeFile(p.archive, Buffer.from(await response.arrayBuffer()));

    this.setStatus('installing', { step: 'Unpacking…' });
    const unpack = join(p.dir, 'unpack');
    await rm(unpack, { recursive: true, force: true });
    await mkdir(unpack, { recursive: true });
    // Only the searx package is needed to run; the rest holds symlinks and
    // tooling that do not unpack cleanly on Windows.
    const excludes = ['utils', 'docs', 'tests', 'client', 'container', 'searxng_extra'].flatMap((name) => ['--exclude', `*/${name}`]);
    await this.run(this.tarCommand(), ['-xzf', p.archive, '-C', unpack, ...excludes], { windowsHide: true, timeout: 180_000 });
    const [top] = await readdir(unpack);
    if (!top || !existsSync(join(unpack, top, 'searx', 'webapp.py'))) throw new Error('the SearXNG download did not contain searx/webapp.py');
    await rm(p.src, { recursive: true, force: true });
    await rename(join(unpack, top), p.src);
    await rm(unpack, { recursive: true, force: true });
    await rm(p.archive, { force: true });

    this.setStatus('installing', { step: `Creating a Python ${python[2]} environment…` });
    await rm(p.venv, { recursive: true, force: true });
    await this.run(python[0], [...python[1], '-m', 'venv', p.venv], { windowsHide: true, timeout: 300_000 });

    this.setStatus('installing', { step: 'Installing SearXNG packages (a few minutes the first time)…' });
    await this.run(p.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', '-r', join(p.src, 'requirements.txt')], {
      windowsHide: true, timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024,
    });

    await mkdir(p.shim, { recursive: true });
    await writeFile(join(p.shim, 'pwd.py'), PWD_SHIM, 'utf8');
    await writeFile(p.marker, JSON.stringify({ installedAt: Date.now(), python: python[2], secret: randomBytes(32).toString('hex') }, null, 2));
  }

  async secret() {
    try {
      return JSON.parse(await readFile(this.paths.marker, 'utf8')).secret || randomBytes(32).toString('hex');
    } catch {
      return randomBytes(32).toString('hex');
    }
  }

  async start(settings) {
    this.wanted = true;
    if (this.pending) return this.pending;
    const url = localSearxngUrl(settings);
    if (this.state.state === 'ready' && this.state.url === url) return;
    if (this.pid && this.state.url !== url) await this.kill();
    this.pending = (async () => {
      try {
        await this.install();
        // Switched off while it was installing: the install is kept, so the
        // next switch-on is quick, but nothing is started.
        if (!this.wanted) { this.setStatus('off'); return; }
        // A server left running by an earlier Skadi (a crash, a hard exit) is
        // adopted rather than fought for the port.
        const leftover = await this.readPid();
        if (leftover && await this.healthy(url)) {
          this.pid = leftover;
          this.setStatus('ready', { url });
          return;
        }
        this.setStatus('starting', { url });
        const port = new URL(url).port;
        await writeFile(this.paths.settings, searxngSettingsYml({ port, secret: await this.secret() }), 'utf8');
        const log = openSync(this.paths.log, 'w');
        const sep = this.platform === 'win32' ? ';' : ':';
        try {
          this.child = this.spawnProcess(this.paths.python, ['-m', 'searx.webapp'], {
            cwd: this.paths.src,
            env: {
              ...process.env,
              SEARXNG_SETTINGS_PATH: this.paths.settings,
              PYTHONPATH: [this.paths.shim, this.paths.src].join(sep),
              PYTHONUNBUFFERED: '1',
              PYTHONIOENCODING: 'utf-8',
            },
            stdio: ['ignore', log, log],
            windowsHide: true,
          });
        } finally {
          closeSync(log);
        }
        this.pid = this.child.pid;
        await writeFile(this.paths.pid, String(this.pid), 'utf8');
        this.child.on('exit', () => {
          const unexpected = this.child && this.wanted && this.state.state === 'ready';
          this.child = null;
          if (unexpected) this.setStatus('error', { url, error: `SearXNG stopped unexpectedly. See ${this.paths.log}.` });
        });
        if (!await this.waitReady(url)) {
          if (!this.wanted) { await this.kill(); this.setStatus('off'); return; }
          const tail = (await readFile(this.paths.log, 'utf8').catch(() => '')).trim().split(/\r?\n/).slice(-3).join(' ');
          throw new Error(`SearXNG did not answer on ${url}.${tail ? ` Last log lines: ${tail.slice(0, 400)}` : ''}`);
        }
        this.setStatus('ready', { url });
      } catch (error) {
        await this.kill();
        this.setStatus('error', { url, error: error.message });
        throw error;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  async readPid() {
    const pid = Number(await readFile(this.paths.pid, 'utf8').catch(() => ''));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  async kill() {
    const pid = this.pid || await this.readPid();
    this.pid = null;
    this.child = null;
    if (pid) {
      if (this.platform === 'win32') {
        await this.run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }).catch(() => {});
      } else {
        try { process.kill(pid); } catch { /* already gone */ }
      }
    }
    await rm(this.paths.pid, { force: true });
  }

  async stop() {
    this.wanted = false;
    // A first install can take minutes; it finishes in the background and
    // start() sees `wanted` is false. Only a quick start is waited for.
    if (this.state.state === 'starting') await this.pending?.catch(() => {});
    await this.kill();
    if (this.state.state !== 'off') this.setStatus('off');
  }

  /** Stop, delete the whole install, and set it up again from scratch. */
  async reinstall(settings) {
    await this.stop();
    await rm(this.paths.dir, { recursive: true, force: true });
    this.setStatus('off');
    if (settings.searxngAutoStart) await this.start(settings);
  }

  reconcile(settings) {
    return settings.searxngAutoStart ? this.start(settings) : this.stop();
  }
}
