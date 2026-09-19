// Optional SearXNG companion service. It is deliberately opt-in: DuckDuckGo
// remains the zero-setup default, while this gives users a private local
// metasearch instance when Docker is available.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ROOT } from './config.mjs';

const exec = promisify(execFile);
export const SEARXNG_CONTAINER = 'skadi-searxng';

export function localSearxngUrl(settings = {}) {
  const port = Math.min(65535, Math.max(1, Number(settings.searxngPort) || 8888));
  return `http://127.0.0.1:${port}`;
}

export function searxngDockerArgs(settings = {}, settingsFile = null) {
  const port = new URL(localSearxngUrl(settings)).port;
  const args = [
    'run', '--detach', '--rm', '--name', SEARXNG_CONTAINER,
    '--publish', `127.0.0.1:${port}:8080`,
    '--env', 'BASE_URL=http://localhost/',
  ];
  if (settingsFile) args.push('--volume', `${settingsFile.replaceAll('\\', '/')}:/etc/searxng/settings.yml:ro`);
  args.push('searxng/searxng:latest');
  return args;
}

async function ensureSettingsFile() {
  const file = join(ROOT, 'config', 'searxng', 'settings.yml');
  try {
    if ((await readFile(file, 'utf8')).includes('- json')) return file;
  } catch {}
  await mkdir(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  await writeFile(file, `use_default_settings: true\nserver:\n  secret_key: "${secret}"\nsearch:\n  formats:\n    - html\n    - json\n`, 'utf8');
  return file;
}

export class LocalSearxng {
  constructor({ run = exec, fetcher = fetch, settingsFile = ensureSettingsFile, onStatus = () => {} } = {}) {
    this.run = run;
    this.fetcher = fetcher;
    this.settingsFile = settingsFile;
    this.onStatus = onStatus;
    this.startedByUs = false;
    this.state = { state: 'off' };
    this.pending = null;
  }

  setStatus(state, extra = {}) {
    this.state = { state, ...extra };
    this.onStatus(this.state);
  }

  async ready(url) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await this.fetcher(`${url}/search?q=skadi&format=json`, {
          signal: AbortSignal.timeout(1500), headers: { Accept: 'application/json' },
        });
        if (response.ok) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  async start(settings) {
    if (this.pending) return this.pending;
    const url = localSearxngUrl(settings);
    if (this.startedByUs && this.state.state === 'ready' && this.state.url === url) return;
    if (this.startedByUs) await this.stop();
    this.pending = (async () => {
      this.setStatus('starting', { url });
      try {
        const settingsFile = await this.settingsFile();
        await this.run('docker', searxngDockerArgs(settings, settingsFile), { windowsHide: true, timeout: 180_000 });
        this.startedByUs = true;
        if (!await this.ready(url)) throw new Error('container started but its search API did not become ready');
        this.setStatus('ready', { url });
      } catch (error) {
        this.setStatus('error', { url, error: `Could not start local SearXNG: ${error.message}` });
        throw error;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  async stop() {
    if (!this.startedByUs) return;
    this.startedByUs = false;
    await this.run('docker', ['stop', SEARXNG_CONTAINER], { windowsHide: true, timeout: 30_000 }).catch(() => {});
    this.setStatus('off');
  }

  reconcile(settings) {
    return settings.searxngAutoStart ? this.start(settings) : this.stop();
  }
}
