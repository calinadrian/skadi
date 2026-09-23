// Voice input: runs voice.ps1 (offline Windows speech recognition) and turns
// its JSON lines into events. The page decides what a phrase means -- wake
// word, push-to-talk -- so the server only hears and reports.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'voice.ps1');

const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Whether a heard word is the wake word, allowing for how speech recognition
 * mangles names: "Scotty" or "Skaddy" for "Skadi". Same first sound, same
 * consonant skeleton, similar length. ui/app.js keeps a copy.
 */
export function soundsLike(heard, wake) {
  const a = norm(heard).replace(/^c/, 'k');
  const b = norm(wake).replace(/^c/, 'k');
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.length < 4 || a[0] !== b[0] || Math.abs(a.length - b.length) > 2) return false;
  const skeleton = (w) => w[0] + w.slice(1)
    .replace(/ck|c|q/g, 'k').replace(/d/g, 't').replace(/ph/g, 'f').replace(/[aeiouyh]/g, '')
    .replace(/(.)\1+/g, '$1');
  return skeleton(a) === skeleton(b);
}

/**
 * If `text` starts with the wake word (optionally after "hey"/"ok"), the
 * command that follows it; otherwise null. "Skadi, open notepad" -> "open
 * notepad". A bare wake word gives '' so the caller can answer "yes?".
 */
export function afterWakeWord(text, wake) {
  const words = String(wake ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return String(text ?? '').trim();
  const clean = String(text ?? '').trim();
  const tokens = clean.split(/\s+/);
  let i = 0;
  while (i < tokens.length && ['hey', 'ok', 'okay', 'hi', 'yo'].includes(norm(tokens[i]))) i += 1;
  for (const w of words) {
    if (i >= tokens.length || !soundsLike(tokens[i], w)) return null;
    i += 1;
  }
  return tokens.slice(i).join(' ').replace(/^[\s,.:;!?-]+/, '').trim();
}

export class VoiceListener extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = { listening: false, culture: null, error: null };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start({ culture = '', wake = '' } = {}) {
    if (this.child) return this.state;
    if (process.platform !== 'win32') {
      this._set({ listening: false, error: 'Voice control needs Windows speech recognition.' });
      return this.state;
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Culture', culture, '-Wake', wake, '-ParentPid', String(process.pid)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this._set({ listening: true, error: null });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'ready') this._set({ culture: msg.culture });
      else if (msg.type === 'error') this._set({ error: msg.message });
      else if (msg.type === 'heard' || msg.type === 'partial') this.emit('speech', msg);
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-1000); });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this._set({ listening: false, error: this.state.error || (code ? stderr.trim() || `speech engine exited (${code})` : null) });
    });
    return this.state;
  }

  stop() {
    const child = this.child;
    this.child = null;
    // The script also exits by itself if Skadi goes away (-ParentPid).
    if (child) try { child.kill(); } catch {}
    this._set({ listening: false });
    return this.state;
  }
}
