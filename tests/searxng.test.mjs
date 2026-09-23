import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSearxng, localSearxngUrl, searxngSettingsYml } from '../src/searxng.mjs';
import { buildWebSearchTools } from '../src/web-search.mjs';

test('local SearXNG binds only to loopback and serves JSON', () => {
  assert.equal(localSearxngUrl({ searxngPort: 9999 }), 'http://127.0.0.1:9999');
  const yml = searxngSettingsYml({ port: 9999, secret: 'abc' });
  assert.match(yml, /bind_address: "127\.0\.0\.1"/);
  assert.match(yml, /port: 9999/);
  assert.match(yml, /- json/);
  assert.match(yml, /limiter: false/);
});

/** A fake machine: Python 3.12 on PATH, a working tar, a SearXNG that answers. */
function fakeMachine(dir, { python = '3 12' } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args.includes('-c')) {
      if (!python) throw new Error('not found');
      return { stdout: python };
    }
    if (args[0] === '-xzf') {
      const unpack = args[args.indexOf('-C') + 1];
      await mkdir(join(unpack, 'searxng-master', 'searx'), { recursive: true });
      await writeFile(join(unpack, 'searxng-master', 'searx', 'webapp.py'), '');
      await writeFile(join(unpack, 'searxng-master', 'requirements.txt'), 'flask');
    }
    if (args.includes('venv')) {
      const venv = args.at(-1);
      await mkdir(join(venv, 'Scripts'), { recursive: true });
      await mkdir(join(venv, 'bin'), { recursive: true });
      await writeFile(join(venv, 'Scripts', 'python.exe'), '');
      await writeFile(join(venv, 'bin', 'python'), '');
    }
    return { stdout: '' };
  };
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 4321, exitCode: null, on() {} };
  };
  const fetcher = async (url) => (url.endsWith('/healthz')
    ? { ok: true }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  return { calls, spawned, service: new LocalSearxng({ dir, run, spawnProcess, fetcher, platform: 'win32' }) };
}

test('turning it on installs SearXNG natively once, then starts it without Docker', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'skadi-sx-')), 'searxng');
  const { calls, spawned, service } = fakeMachine(dir);
  const steps = [];
  service.onStatus = (s) => steps.push(s.state);
  await service.reconcile({ searxngAutoStart: true, searxngPort: 8890 });

  assert.equal(service.state.state, 'ready');
  assert.equal(service.state.url, 'http://127.0.0.1:8890');
  assert.equal(calls.some(([command]) => /docker/i.test(command)), false, 'Docker must never be used');
  assert.ok(calls.some(([, args]) => args.includes('venv')), 'a virtual environment is created');
  assert.ok(calls.some(([, args]) => args.includes('pip') && args.includes('-r')), 'requirements are installed');
  assert.ok(steps.includes('installing') && steps.includes('starting'));
  assert.deepEqual(spawned[0].args, ['-m', 'searx.webapp']);
  assert.match(spawned[0].options.env.PYTHONPATH, /shim/, 'the Windows pwd stand-in is on the path');
  assert.ok(existsSync(join(dir, 'shim', 'pwd.py')));
  assert.match(await readFile(join(dir, 'settings.yml'), 'utf8'), /port: 8890/);

  // Off stops exactly the process it started.
  await service.reconcile({ searxngAutoStart: false });
  assert.deepEqual(calls.at(-1), ['taskkill', ['/PID', '4321', '/T', '/F']]);
  assert.equal(service.state.state, 'off');

  // On again: no second download or pip install.
  const before = calls.length;
  await service.reconcile({ searxngAutoStart: true, searxngPort: 8890 });
  assert.equal(calls.slice(before).some(([, args]) => args.includes('pip') || args[0] === '-xzf'), false);
  await service.stop();
});

test('without Python the switch explains what to install instead of failing silently', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'skadi-sx-')), 'searxng');
  const { service } = fakeMachine(dir, { python: '' });
  await assert.rejects(service.start({ searxngAutoStart: true }), /Python 3\.10 or newer/);
  assert.equal(service.state.state, 'error');
  assert.match(service.state.error, /python\.org/);
});

test('web search falls back to DuckDuckGo while the local SearXNG is not ready', async () => {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(String(url));
    return { ok: true, text: async () => '<a class="result__a" href="https://example.com">Example</a>', json: async () => ({ results: [] }) };
  };
  const ctx = { settings: { searxngAutoStart: true, searxngPort: 8888 }, searxngStatus: () => ({ state: 'installing' }) };
  const tools = buildWebSearchTools(ctx, fetcher);
  await tools.web_search.run({ query: 'skadi' });
  assert.ok(asked.some((url) => /duckduckgo/.test(url)));
  assert.equal(asked.some((url) => url.includes('127.0.0.1:8888')), false);

  ctx.searxngStatus = () => ({ state: 'ready' });
  await tools.web_search.run({ query: 'skadi' });
  assert.ok(asked.some((url) => url.includes('127.0.0.1:8888')));
});
