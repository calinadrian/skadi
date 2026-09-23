// Skadi's natural voice. Installs Kyutai's Pocket TTS into a private Python
// environment (like SearXNG: Skadi finds a Python 3.10+ or downloads its own),
// runs tts_server.py on a free local port, and relays its streamed audio to
// the window. It runs on the CPU, so the language model keeps the whole GPU.
//
// Built-in voices work straight away. Cloning the user's own sample needs
// Kyutai's gated weights: the user accepts the terms on Hugging Face and gives
// Skadi a token, which is encrypted beside the provider keys (off limits to
// the agent) and never sent back to the window.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.mjs';
import { LocalSearxng } from './searxng.mjs';
import { freePort } from './ports.mjs';
import { killTree } from './tools.mjs';
import { loadSecrets, saveSecret } from './providers.mjs';

const exec = promisify(execFile);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'tts_server.py');
export const VOICES_DIR = join(ROOT, 'voices');
// Kept in the provider-key store, encrypted for the signed-in Windows user.
const TOKEN_ID = 'huggingface';
const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;

// Pocket TTS's built-in voices (English). Any of them works without a token.
export const BUILTIN_VOICES = [
  'alba', 'marius', 'javert', 'jean', 'fantine', 'cosette', 'eponine', 'azelma',
  'anna', 'vera', 'charles', 'paul', 'george', 'mary', 'jane', 'michael', 'eve',
];

export class VoiceEngine {
  constructor({ dir = join(ROOT, 'voice-engine'), onStatus = () => {} } = {}) {
    this.dir = dir;
    this.venv = join(dir, 'venv');
    this.python = join(this.venv, 'Scripts', 'python.exe');
    this.marker = join(dir, 'install.json');
    this.onStatus = onStatus;
    this.child = null;
    this.url = null;
    this.wanted = false;
    this.pending = null;
    this.state = { state: 'off', installed: this.isInstalled() };
  }

  setStatus(state, extra = {}) {
    this.state = { state, installed: this.isInstalled(), ...extra };
    this.onStatus(this.state);
  }

  isInstalled() {
    return existsSync(this.marker) && existsSync(this.python);
  }

  hasToken() {
    return Boolean(this.token());
  }

  token() {
    // Decrypting starts a PowerShell, so read the store once and remember.
    if (this.cachedToken === undefined) {
      try {
        this.cachedToken = loadSecrets()[TOKEN_ID] || '';
      } catch {
        this.cachedToken = '';
      }
    }
    return this.cachedToken || process.env.HF_TOKEN || '';
  }

  async setToken(token) {
    const value = String(token ?? '').trim();
    if (value && !/^hf_[A-Za-z0-9]{20,}$/.test(value)) throw new Error('That does not look like a Hugging Face token (they start with hf_).');
    saveSecret(TOKEN_ID, value);
    this.cachedToken = value;
    // The model is loaded at start, so a new token needs a fresh engine.
    if (this.wanted) await this.restart();
  }

  async install() {
    if (this.isInstalled()) return;
    // SearXNG's installer already knows how to find a Python on Windows or
    // fetch python.org's portable build; borrow it for this folder.
    const finder = new LocalSearxng({
      dir: this.dir,
      onStatus: ({ step }) => step && this.setStatus('installing', { step }),
    });
    this.setStatus('installing', { step: 'Looking for Python 3.10 or newer…' });
    let python = await finder.findPython();
    if (!python && process.platform === 'win32') {
      await finder.installPortablePython();
      python = await finder.findPython();
    }
    if (!python) throw new Error('The natural voice needs Python 3.10 or newer. Install it from python.org and turn the voice on again.');
    await mkdir(this.dir, { recursive: true });
    this.setStatus('installing', { step: `Creating a Python ${python[2]} environment…` });
    await rm(this.venv, { recursive: true, force: true });
    await exec(python[0], [...python[1], '-m', 'venv', this.venv], { windowsHide: true, timeout: 300_000 });
    this.setStatus('installing', { step: 'Installing the voice engine (about 1 GB, a few minutes the first time)…' });
    await exec(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', 'pocket-tts'], {
      windowsHide: true, timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024,
    });
    await writeFile(this.marker, JSON.stringify({ installedAt: Date.now(), python: python[2] }, null, 2));
  }

  start() {
    this.wanted = true;
    if (this.pending) return this.pending;
    if (this.child && this.state.state === 'ready') return Promise.resolve();
    this.pending = (async () => {
      try {
        await this.install();
        if (!this.wanted) { this.setStatus('off'); return; }
        const port = await freePort(8871);
        this.setStatus('starting', { step: this.state.installed && existsSync(join(this.dir, 'started')) ? 'Loading the voice…' : 'Downloading the voice model (first start only)…' });
        const token = this.token();
        const child = spawn(this.python, [SERVER, '--port', String(port)], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...(token ? { HF_TOKEN: token } : {}),
            PYTHONUNBUFFERED: '1',
            PYTHONIOENCODING: 'utf-8',
            HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
          },
        });
        this.child = child;
        let stderr = '';
        child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
        const ready = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 15 * 60_000);
          createInterface({ input: child.stdout }).on('line', (line) => {
            if (line.trim() === 'READY') { clearTimeout(timer); resolve(true); }
          });
          child.on('exit', () => { clearTimeout(timer); resolve(false); });
        });
        child.on('exit', () => {
          if (this.child !== child) return;
          this.child = null;
          if (this.wanted) this.setStatus('error', { error: `The voice engine stopped. ${lastLine(stderr)}` });
        });
        if (!ready) {
          killTree(child);
          this.child = null;
          throw new Error(`The voice engine did not start. ${lastLine(stderr)}`);
        }
        await writeFile(join(this.dir, 'started'), String(Date.now())).catch(() => {});
        this.url = `http://127.0.0.1:${port}`;
        if (!this.wanted) return this.stop();
        this.setStatus('ready', { cloning: Boolean(token) });
      } catch (err) {
        this.setStatus('error', { error: err.message });
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  stop() {
    this.wanted = false;
    const child = this.child;
    this.child = null;
    this.url = null;
    if (child) killTree(child);
    if (this.state.state !== 'installing') this.setStatus('off');
  }

  async restart() {
    this.stop();
    await new Promise((r) => setTimeout(r, 500));
    return this.start();
  }

  /** Follow the setting: on starts (and installs), off stops. */
  reconcile(settings) {
    if (settings.voiceNatural) this.start();
    else if (this.wanted || this.child) this.stop();
  }

  /** The streamed PCM response from the engine, or null when it is not running. */
  async speak(text, voice, signal) {
    if (this.state.state !== 'ready' || !this.url) return null;
    return fetch(`${this.url}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal,
    });
  }
}

const lastLine = (text) => String(text).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';

/** What `voice` to hand the engine: the user's sample if one is set, else a built-in name. */
export function voiceFor(settings) {
  const sample = String(settings.voiceSample ?? '');
  if (sample && existsSync(join(VOICES_DIR, sample))) return join(VOICES_DIR, sample);
  return BUILTIN_VOICES.includes(settings.voiceName) ? settings.voiceName : 'alba';
}

/** Save an uploaded voice sample, replacing the previous one. Returns its file name. */
export async function saveVoiceSample({ name, data }) {
  // The window converts any recording to WAV before sending it.
  if (extname(String(name ?? '')).toLowerCase() !== '.wav') throw new Error('Send the sample as WAV.');
  const bytes = Buffer.from(String(data ?? ''), 'base64');
  if (bytes.length < 1000) throw new Error('That recording is empty.');
  if (bytes.length > MAX_SAMPLE_BYTES) throw new Error('Keep the sample under 20 MB; 10-30 seconds of clear speech is ideal.');
  await clearVoiceSamples();
  const file = 'my-voice.wav';
  await writeFile(join(VOICES_DIR, file), bytes);
  return file;
}

export async function clearVoiceSamples() {
  await mkdir(VOICES_DIR, { recursive: true });
  for (const f of await readdir(VOICES_DIR)) await rm(join(VOICES_DIR, f), { force: true });
}
