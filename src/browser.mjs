// A browser that lives inside Skadi.
//
// Chromium runs headless with a switchable viewport (desktop/mobile, like the
// DevTools device toolbar), and its frames are streamed to
// the UI over the DevTools screencast API -- the same mechanism DevTools uses to
// mirror a phone screen. The page therefore renders inside Skadi's own window
// rather than in a separate browser, and both the user and the agent drive it by
// dispatching synthetic input events.
//
// Node 22+ ships a WebSocket client and Chromium speaks CDP over one, so this
// needs no packages: no Playwright, no Puppeteer.
//
// The viewport is pinned per device, which matters more than it looks: screenshot pixels
// and click coordinates then share one coordinate space, so a model with vision
// can point at what it sees and have the click land there.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './config.mjs';

const SHOTS_DIR = join(ROOT, 'logs', 'shots');
/** One profile directory per chat, under a shared root. */
const PROFILE_ROOT = join(process.env.LOCALAPPDATA || homedir(), 'Skadi', 'browsers');
const PROFILE_DIR = join(PROFILE_ROOT, 'default');

/**
 * Where one chat's browser keeps its cookies, logins and history. Separate
 * directories are what make the browsers genuinely separate: two chats can be
 * signed into the same site as different users without either noticing.
 */
export function profileDirFor(key) {
  const safe = String(key || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'default';
  return join(PROFILE_ROOT, safe);
}

export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Device presets, Chrome-DevTools-device-toolbar style. Desktop is the pinned
 * default the UI was built around; mobile narrows the layout viewport,
 * enables the mobile meta-viewport behaviour and serves a phone UA so sites
 * answer with mobile markup. Coordinates everywhere stay in CSS pixels, so
 * clicks, the interactive map and screenshots need no conversion per mode.
 */
export const DEVICES = {
  desktop: {
    label: 'Desktop',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    ua: null, // the browser's own UA, captured before the first switch away
  },
  mobile: {
    label: 'Mobile',
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
};

function findChromium() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return [
    join(pf, 'Google/Chrome/Application/chrome.exe'),
    join(pfx, 'Google/Chrome/Application/chrome.exe'),
    join(local, 'Google/Chrome/Application/chrome.exe'),
    join(pf, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(pfx, 'Microsoft/Edge/Application/msedge.exe'),
    join(pf, 'Microsoft/Edge/Application/msedge.exe'),
  ].find((p) => existsSync(p)) || null;
}

/** Key names that need a real key event rather than inserted text. */
const SPECIAL_KEYS = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', key: 'Tab', vk: 9, text: '\t' },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', key: 'Delete', vk: 46 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', key: 'Home', vk: 36 },
  End: { code: 'End', key: 'End', vk: 35 },
  PageUp: { code: 'PageUp', key: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', vk: 34 },
};

export class AgentBrowser extends EventEmitter {
  constructor({ port = 9333, headless = true, profileDir = PROFILE_DIR, key = null } = {}) {
    super();
    this.port = port;
    this.headless = headless;
    // One Chromium per chat: its own debugging port and its own profile
    // directory, so cookies, logins and history never leak between chats.
    this.profileDir = profileDir;
    this.key = key;
    this.proc = null;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.console = [];
    this.currentUrl = null;
    this.title = null;
    this.casting = false;
    this.lastFrame = null;
    this.device = 'desktop';
    this.desktopUA = null;
    // Page audio, as the user set it in the pane. Applied to every document
    // this browser loads, so it survives navigation and reloads.
    this.volume = 1;
    this.muted = false;
    this.audioScriptId = null;
  }

  get running() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /** Current layout viewport in CSS pixels. Clicks, map and frames share it. */
  viewport() {
    const dev = DEVICES[this.device] || DEVICES.desktop;
    return { width: dev.width, height: dev.height };
  }

  status() {
    return {
      running: this.running,
      url: this.currentUrl,
      title: this.title,
      casting: this.casting,
      device: this.device,
      viewport: this.viewport(),
      volume: this.volume,
      muted: this.muted,
      key: this.key,
    };
  }

  async launch() {
    if (this.running) return;

    if (!this.proc) {
      const exe = findChromium();
      if (!exe) throw new Error('No Chromium-family browser found (Chrome, Brave or Edge).');
      mkdirSync(this.profileDir, { recursive: true });
      const args = [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-search-engine-choice-screen',
        '--disable-background-networking',
        '--disable-features=msImplicitSignin,msEdgeIdentityFre,SigninPromo,ForYouFre',
        // Media that would sit silently waiting for a click nobody can give
        // it: the page is driven synthetically, so let it start on its own.
        '--autoplay-policy=no-user-gesture-required',
        'about:blank',
      ];
      // Headless by default: the page is shown inside Skadi, so a second
      // operating-system window would just be in the way.
      if (this.headless) args.unshift('--headless=new');

      this.proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
      this.proc.on('exit', () => {
        this.proc = null;
        this.ws = null;
        this.casting = false;
        this.emit('closed');
      });
    }

    const target = await this._waitForTarget();
    await this._connect(target.webSocketDebuggerUrl);
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    // A fresh target has default metrics; pin ours, and reset the device
    // state that died with the old target.
    this.device = 'desktop';
    this.desktopUA = null;
    // Pin the viewport so screenshot pixels and click coordinates agree.
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // A fresh target starts at full volume; re-apply what the user chose.
    this.audioScriptId = null;
    await this._applyAudio().catch(() => {});
    this.emit('status', this.status());
  }

  async _waitForTarget(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const targets = await res.json();
          const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (page) return page;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('browser did not expose a debugging target in time');
  }

  _connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', () => reject(new Error('could not attach to the browser')));
      ws.addEventListener('close', () => {
        this.ws = null;
        this.casting = false;
        for (const [, { reject: rj }] of this.pending) rj(new Error('browser disconnected'));
        this.pending.clear();
      });
      ws.addEventListener('message', (event) => this._onMessage(event.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result);
      return;
    }

    switch (msg.method) {
      case 'Page.screencastFrame': {
        // Acknowledge or Chromium stops sending frames.
        this.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
        this.lastFrame = msg.params.data;
        this.emit('frame', { data: msg.params.data, metadata: msg.params.metadata });
        break;
      }
      case 'Page.frameNavigated':
        if (!msg.params.frame.parentId) {
          this.currentUrl = msg.params.frame.url;
          this.emit('status', this.status());
        }
        break;
      case 'Log.entryAdded': {
        const entry = msg.params.entry;
        this._record(entry.level, entry.text, entry.url, entry.lineNumber);
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this._record(msg.params.type, text);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = msg.params.exceptionDetails;
        this._record('error', d.exception?.description || d.text);
        break;
      }
      default:
        break;
    }
  }

  _record(level, text, url, line) {
    const entry = { ts: Date.now(), level, text: String(text).slice(0, 2000), url, line };
    this.console.push(entry);
    if (this.console.length > 300) this.console.splice(0, this.console.length - 300);
    // The user watches the same console the agent reads, live in the pane.
    this.emit('console', entry);
  }

  send(method, params = {}) {
    if (!this.running) return Promise.reject(new Error('browser is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  // --------------------------------------------------------------- screencast

  async startScreencast() {
    await this.launch();
    if (this.casting) return;
    // Frame aspect follows the device, so the UI's click mapping (displayed
    // rect scaled into viewport space) stays exact in every mode.
    const dev = DEVICES[this.device] || DEVICES.desktop;
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: dev.width * dev.deviceScaleFactor,
      maxHeight: dev.height * dev.deviceScaleFactor,
      everyNthFrame: 1,
    });
    this.casting = true;
    this.emit('status', this.status());
  }

  async stopScreencast() {
    if (!this.casting || !this.running) return;
    await this.send('Page.stopScreencast').catch(() => {});
    this.casting = false;
    this.emit('status', this.status());
  }

  /**
   * Switch the emulated device, DevTools device-toolbar style. Applies the
   * layout viewport, swaps the user agent (phone UA on mobile, the browser's
   * own UA back on desktop) and reloads the open page so sites re-evaluate
   * media queries and UA sniffing. Restarts the screencast when running so
   * frame aspect keeps matching the viewport.
   */
  async setDevice(mode = 'desktop') {
    const dev = DEVICES[mode];
    if (!dev) throw new Error(`unknown device: ${mode}. Use one of: ${Object.keys(DEVICES).join(', ')}`);
    await this.launch();
    if (dev.ua && !this.desktopUA) {
      // Remember what to restore before the first override buries it.
      this.desktopUA = await this.evaluate('navigator.userAgent').catch(() => null);
    }
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: dev.width,
      height: dev.height,
      deviceScaleFactor: dev.deviceScaleFactor,
      mobile: dev.mobile,
    });
    await this._swapUserAgent(dev.ua);
    this.device = mode;
    if (this.casting) {
      await this.stopScreencast().catch(() => {});
      await this.startScreencast().catch(() => {});
    }
    if (this.currentUrl && !/^about:blank/.test(this.currentUrl)) {
      await this.reload().catch(() => {});
    }
    this.emit('status', this.status());
    return this.status();
  }

  /** Apply a UA override, falling back across CDP domains by build age. */
  async _swapUserAgent(ua) {
    const want = ua || this.desktopUA;
    if (!want) return;
    try {
      await this.send('Emulation.setUserAgentOverride', { userAgent: want });
    } catch {
      await this.send('Network.enable', {}).catch(() => {});
      await this.send('Network.setUserAgentOverride', { userAgent: want });
    }
  }

  // ----------------------------------------------------------------- audio

  /**
   * Page volume and mute, the way a browser tab's own volume control would
   * behave if tabs had one. There is no CDP command for it, so the page gets
   * a small script instead: it clamps every <video>/<audio> element and
   * routes Web Audio through a gain node. The script is registered for every
   * new document, so navigating or reloading keeps the setting.
   *
   * The screencast carries no audio: sound comes out of the Chromium process
   * itself, which means a headless browser may stay silent on machines where
   * headless Chrome gets a null audio device. Turn `browserHeadless` off in
   * settings if you want to hear the page.
   */
  async setAudio({ volume, muted } = {}) {
    if (volume != null) this.volume = Math.min(Math.max(Number(volume) || 0, 0), 1);
    if (muted != null) this.muted = Boolean(muted);
    await this.launch();
    await this._applyAudio();
    this.emit('status', this.status());
    return this.status();
  }

  /** The injected script, parameterised with the current volume and mute. */
  _audioSource() {
    const settings = JSON.stringify({ volume: this.volume, muted: this.muted });
    return `(() => {
      const want = ${settings};
      const S = (window.__skadiAudio ||= { gains: [], wired: false });
      S.volume = want.volume;
      S.muted = want.muted;
      const level = () => (S.muted ? 0 : S.volume);
      const apply = (el) => { try { el.volume = S.volume; el.muted = S.muted; } catch {} };
      const sweep = () => {
        try { document.querySelectorAll('video,audio').forEach(apply); } catch {}
        for (const g of S.gains) { try { g.gain.value = level(); } catch {} }
      };
      // The script runs before the document has a body, so sweeping is
      // debounced and repeated rather than done once: elements parsed later,
      // and elements a script adds later, both have to end up at our level.
      const soon = () => {
        clearTimeout(S.timer);
        S.timer = setTimeout(sweep, 60);
      };
      if (!S.wired) {
        S.wired = true;
        // Elements that appear later, and elements that start playing later.
        document.addEventListener('play', (e) => apply(e.target), true);
        document.addEventListener('loadedmetadata', (e) => apply(e.target), true);
        document.addEventListener('DOMContentLoaded', sweep);
        window.addEventListener('load', sweep);
        // The document can be observed before <html> exists; documentElement cannot.
        try { new MutationObserver(soon).observe(document, { childList: true, subtree: true }); } catch {}
        // Web Audio ignores element volume, so hand every context a gain node
        // in place of its destination and keep that node at our level.
        const Base = window.BaseAudioContext || window.AudioContext;
        const desc = Base && Object.getOwnPropertyDescriptor(Base.prototype, 'destination');
        if (desc && desc.get && !Base.prototype.__skadiAudio) {
          Base.prototype.__skadiAudio = true;
          Object.defineProperty(Base.prototype, 'destination', {
            configurable: true,
            get() {
              const real = desc.get.call(this);
              if (!this.__skadiGain) {
                try {
                  const gain = this.createGain();
                  gain.connect(real);
                  this.__skadiGain = gain;
                  S.gains.push(gain);
                } catch { return real; }
              }
              try { this.__skadiGain.gain.value = level(); } catch {}
              return this.__skadiGain;
            },
          });
        }
      }
      sweep();
      soon();
    })()`;
  }

  /** Register the script for future documents and run it on the current one. */
  async _applyAudio() {
    if (!this.running) return;
    const source = this._audioSource();
    if (this.audioScriptId) {
      await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.audioScriptId }).catch(() => {});
      this.audioScriptId = null;
    }
    const res = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => null);
    this.audioScriptId = res?.identifier ?? null;
    await this.send('Runtime.evaluate', { expression: source, returnByValue: true }).catch(() => {});
  }

  // ------------------------------------------------------------- navigation

  async open(url) {
    await this.launch();
    this.clearConsole();
    await this.send('Page.navigate', { url });
    await this._waitForLoad();
    this.currentUrl = url;
    this.title = await this.evaluate('document.title').catch(() => null);
    this.emit('status', this.status());
    return url;
  }

  /** Drop the recorded console. The pane clears with it. */
  clearConsole() {
    this.console = [];
    this.emit('console_clear');
  }

  async reload() {
    await this.send('Page.reload', {});
    await this._waitForLoad();
    return this.currentUrl;
  }

  async history(delta) {
    const { currentIndex, entries } = await this.send('Page.getNavigationHistory');
    const target = entries[currentIndex + delta];
    if (!target) throw new Error(delta < 0 ? 'nothing to go back to' : 'nothing to go forward to');
    await this.send('Page.navigateToHistoryEntry', { entryId: target.id });
    await this._waitForLoad();
    this.currentUrl = target.url;
    this.emit('status', this.status());
    return target.url;
  }

  /** Resolve on the load event, or after a grace period for SPA routes. */
  _waitForLoad(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.ws?.removeEventListener('message', listener);
        setTimeout(resolve, 400); // let client-side rendering paint
      };
      const listener = (event) => {
        try {
          if (JSON.parse(event.data).method === 'Page.loadEventFired') done();
        } catch {
          /* ignore */
        }
      };
      const timer = setTimeout(() => {
        this.ws?.removeEventListener('message', listener);
        resolve();
      }, timeoutMs);
      this.ws?.addEventListener('message', listener);
    });
  }

  // ------------------------------------------------------------------ input

  async clickAt(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.launch();
    const point = { x: Math.round(x), y: Math.round(y), button, clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    await new Promise((r) => setTimeout(r, 350));
    return { x: point.x, y: point.y };
  }

  async scrollAt(x, y, deltaY, deltaX = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX,
      deltaY,
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  async typeText(text) {
    await this.send('Input.insertText', { text });
  }

  async pressKey(name) {
    const key = SPECIAL_KEYS[name];
    if (!key) throw new Error(`unsupported key: ${name}. Use one of: ${Object.keys(SPECIAL_KEYS).join(', ')}`);
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await new Promise((r) => setTimeout(r, 250));
  }

  // ------------------------------------------------------------ inspection

  async evaluate(expression) {
    await this.launch();
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return result.result?.value;
  }

  text() {
    return this.evaluate('document.body ? document.body.innerText : ""');
  }

  async click(selector) {
    const ok = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false; el.click(); return true; })()`,
    );
    if (!ok) throw new Error(`no element matches ${selector}`);
    await new Promise((r) => setTimeout(r, 400));
    return true;
  }

  async fill(selector, value) {
    const ok = await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set;
        setter ? setter.call(el, ${JSON.stringify(value)}) : (el.value = ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true; })()`,
    );
    if (!ok) throw new Error(`no element matches ${selector}`);
    return true;
  }

  /**
   * A labelled map of what is clickable, with centre coordinates.
   * This is how a model without vision "sees" the page well enough to click.
   */
  async interactiveMap() {
    return this.evaluate(`(() => {
      const sel = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[onclick]';
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 0 || r.top > innerHeight) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const label = (el.getAttribute('aria-label') || el.value || el.placeholder ||
          el.innerText || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
        out.push({
          tag: el.tagName.toLowerCase(),
          label,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        });
        if (out.length >= 80) break;
      }
      return out;
    })()`);
  }

  /**
   * JPEG to disk. Returns { file, name, bytes, base64 } for the UI and model.
   *
   * JPEG rather than PNG, deliberately: a screenshot enters the transcript as
   * base64 and is sent again on every later round, so its size is paid over
   * and over. The same 1280x800 page is 400KB-1.7MB as PNG and roughly a
   * tenth of that as JPEG, at a quality no model reads differently -- these
   * are screenshots of web pages, not images being examined for fine detail.
   * PNG's bulk is what pushed long browsing chats past the request-size
   * ceiling gateways enforce. `fitImageBudget` is the backstop; this is the
   * part that stops the problem being created.
   */
  async screenshot({ fullPage = false } = {}) {
    await this.launch();
    const result = await this.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
      captureBeyondViewport: Boolean(fullPage),
    });
    mkdirSync(SHOTS_DIR, { recursive: true });
    const name = `shot-${Date.now()}.jpg`;
    const file = join(SHOTS_DIR, name);
    const buffer = Buffer.from(result.data, 'base64');
    writeFileSync(file, buffer);
    // The type travels with the shot: the callers that hand it to a model and
    // serve it to the pane should not each be carrying their own guess about
    // what format it is in.
    return { file, name, bytes: buffer.length, base64: result.data, mediaType: 'image/jpeg' };
  }

  async close() {
    try {
      await this.stopScreencast();
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
    this.lastFrame = null;
    this.emit('status', this.status());
  }
}

export { SHOTS_DIR };

// ------------------------------------------------------------ page map
//
// The model's view of a page is a numbered list of what it can act on, like
// the accessibility tree a human-grade browser agent reads. Each element gets
// a data-skadi-ref attribute, so "click 3" names exactly one thing until the
// next snapshot renumbers the page. Numbers, visible text and CSS selectors
// all resolve through one function: a 7B model that writes "Sign in" instead
// of the ref still lands on the button.

function pageHelpers() {
  if (window.__skadi) return window.__skadi;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const role = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (/^(submit|button|reset|image)$/.test(ty)) return 'button';
      return 'textbox';
    }
    if (t === 'textarea' || el.isContentEditable) return 'textbox';
    if (t === 'select') return 'combobox';
    return t === 'summary' ? 'button' : t;
  };
  const label = (el) => {
    const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const aria = el.getAttribute('aria-labelledby');
    const labelled = aria && aria.split(' ').map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
    return clean(el.getAttribute('aria-label') || labelled || byId?.innerText || el.closest('label')?.innerText
      || (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? el.value : '')
      || (el.tagName === 'SELECT' ? '' : el.innerText) || el.placeholder || el.title || el.alt || el.getAttribute('name') || el.id || '').slice(0, 80);
  };
  const describe = (el) => {
    const r = role(el);
    let line = `${r} "${label(el)}"`;
    const t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA') {
      if (/checkbox|radio/.test(r)) line += el.checked ? ' [checked]' : ' [unchecked]';
      else if (el.value) line += ` value="${clean(el.type === 'password' ? '***' : el.value).slice(0, 60)}"`;
      else if (el.placeholder && label(el) !== clean(el.placeholder)) line += ` placeholder="${clean(el.placeholder).slice(0, 40)}"`;
    } else if (t === 'SELECT') {
      line += ` selected="${clean(el.selectedOptions[0]?.text)}" options: ${[...el.options].slice(0, 12).map((o) => clean(o.text)).join(' | ')}`;
    } else if (el.getAttribute('aria-checked')) {
      line += el.getAttribute('aria-checked') === 'true' ? ' [checked]' : ' [unchecked]';
    }
    const href = t === 'A' && el.getAttribute('href');
    if (href && !href.startsWith('javascript')) line += ` -> ${href.slice(0, 80)}`;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]';
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0) line += ' (above, scroll up)';
    else if (rect.top > innerHeight) line += ' (below, scroll down)';
    return line;
  };
  const snapshot = (maxEls, maxText) => {
    document.querySelectorAll('[data-skadi-ref]').forEach((e) => e.removeAttribute('data-skadi-ref'));
    const els = [];
    const all = [...document.querySelectorAll(SEL)].filter(visible);
    for (const el of all) {
      // A button inside a link (or the reverse) is one target, not two.
      if (els.some((p) => p.contains(el) && label(p) === label(el))) continue;
      els.push(el);
      if (els.length >= maxEls) break;
    }
    const lines = els.map((el, i) => { el.setAttribute('data-skadi-ref', String(i + 1)); return `[${i + 1}] ${describe(el)}`; });
    const dialog = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')].find(visible);
    const text = clean(document.body ? document.body.innerText : '');
    return {
      title: document.title,
      url: location.href,
      dialog: dialog ? clean(dialog.innerText).slice(0, 300) : '',
      elements: lines,
      more: all.length > els.length && els.length >= maxEls,
      text: text.length > maxText ? `${text.slice(0, maxText)} ... [more text: use browser_read]` : text,
      scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) },
    };
  };
  // Resolve what the model named to one element: a ref number, a CSS
  // selector, or visible text (exact label first, then contains).
  const find = (target) => {
    const t = clean(target).replace(/^ref[\s_=:-]*/i, '').replace(/^\[|\]$/g, '').replace(/^e(?=\d+$)/i, '');
    if (/^\d+$/.test(t)) {
      const el = document.querySelector(`[data-skadi-ref="${t}"]`);
      return el ? { el } : { error: `No element [${t}] on the page now. The page may have changed: call browser_snapshot for fresh numbers.` };
    }
    if (/^[#.[]|^[a-z]+[#.[:]|^(input|button|select|textarea|a|form|img)$/i.test(t)) {
      try { const el = document.querySelector(t); if (el) return { el }; } catch { /* not a selector */ }
    }
    const want = t.toLowerCase().replace(/^["']|["']$/g, '');
    const all = [...document.querySelectorAll(SEL)].filter(visible);
    const hit = all.find((el) => label(el).toLowerCase() === want)
      || all.find((el) => label(el).toLowerCase().includes(want))
      || all.find((el) => clean(el.placeholder).toLowerCase().includes(want));
    if (hit) return { el: hit };
    // Last try: any visible leaf whose own text matches, e.g. a clickable card.
    const any = [...document.querySelectorAll('body *')].find((el) => el.children.length === 0 && visible(el) && clean(el.innerText).toLowerCase() === want);
    return any ? { el: any } : { error: `Nothing on the page matches "${t}". Call browser_snapshot and use a number from the list.` };
  };
  const locate = (target) => {
    const r = find(target);
    if (r.error) return r;
    r.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const b = r.el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), what: describe(r.el), tag: r.el.tagName, role: role(r.el) };
  };
  window.__skadi = { snapshot, find, locate, describe, clean };
  return window.__skadi;
}

/** An expression that runs `body` with the page helpers bound to S. */
const page = (body) => `(() => { const S = (${pageHelpers.toString()})(); ${body} })()`;

/** The snapshot as the model reads it: short, numbered, one line each. */
export function formatSnapshot(snap, { note = '' } = {}) {
  if (!snap) return note || 'The page could not be read.';
  const out = [];
  if (note) out.push(note);
  out.push(`Page: "${snap.title || '(no title)'}" — ${snap.url}`);
  if (snap.dialog) out.push(`A dialog is open: ${snap.dialog}`);
  out.push(snap.elements.length
    ? `Elements (use the number with browser_click / browser_type):\n${snap.elements.join('\n')}${snap.more ? '\n... more elements: scroll, then browser_snapshot' : ''}`
    : 'No clickable elements are visible.');
  if (snap.text) out.push(`Text: ${snap.text}`);
  if (snap.scroll?.max > 0) out.push(`Scroll: ${snap.scroll.y} of ${snap.scroll.max}px${snap.scroll.y < snap.scroll.max ? ' (more below)' : ''}.`);
  return out.join('\n\n');
}

/** A URL, a bare host or a full local path, turned into what Chromium opens. */
export function normaliseUrl(input) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (/^(https?|file):\/\//i.test(raw) || /^about:blank$/i.test(raw)) return raw;
  if (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith('/')) {
    const segs = raw.replace(/\\/g, '/').split('/');
    const path = segs.map((seg, i) => (i === 0 && /^[a-z]:$/i.test(seg) ? seg : encodeURIComponent(seg))).join('/');
    return `file://${path.startsWith('/') ? '' : '/'}${path}`;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`;
  // "index.html" is a relative file, not a website at index.html.
  const relativeFile = /\.(html?|xhtml|svg|md|txt|json|js|css|png|jpe?g|gif|pdf)$/i.test(raw) && !raw.includes('/');
  if (!relativeFile && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw)) return `https://${raw}`;
  throw new Error(`"${raw}" is not a URL or a full file path. Examples: http://localhost:5173, https://example.com, C:/site/index.html`);
}

/** Key names as small models write them: "enter", "esc", "down". */
export function keyName(name) {
  const k = String(name || '').trim().toLowerCase().replace(/^arrow/, '');
  const names = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
    delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  };
  return names[k] || String(name || '').trim();
}

/**
 * Browser tools exposed to the model.
 *
 * Built so a small model can drive a page: every action answers with a fresh
 * numbered snapshot, so the model never has to remember to look, and a target
 * is whatever it can name -- a number from the list, the visible text, or a
 * CSS selector. `vision` adds coordinate clicks for models that can see.
 */
export function browserTools(getBrowser, { onScreenshot, vision = () => false } = {}) {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = async (browser, { maxEls = 60, maxText = 1500, note = '' } = {}) => {
    const value = await browser.evaluate(page(`return S.snapshot(${maxEls}, ${maxText});`)).catch(() => null);
    return formatSnapshot(value, { note });
  };
  // Small models name the target under whatever key comes to mind.
  const targetOf = (args) => args?.target ?? args?.ref ?? args?.element ?? args?.selector ?? args?.field ?? args?.label;
  // Clicks go through real mouse events at the element's centre, so the page
  // sees a trusted click the way it would from a person.
  const locate = async (browser, target) => {
    if (target === undefined || target === null || String(target).trim() === '') {
      throw new Error('Say what to act on: a number from browser_snapshot, the visible text, or a CSS selector.');
    }
    const hit = await browser.evaluate(page(`return S.locate(${JSON.stringify(String(target))});`));
    if (!hit || hit.error) throw new Error(hit?.error || `Could not find ${target}.`);
    return hit;
  };
  const afterAction = async (browser, before, note) => {
    await settle(500);
    // A click that navigated needs the new document to finish painting.
    const now = await browser.evaluate('location.href').catch(() => before);
    if (now !== before) await settle(800);
    return snap(browser, { note });
  };
  const href = (browser) => browser.evaluate('location.href').catch(() => null);
  const target = { type: 'string', description: 'What to act on: the number from the element list (e.g. "3"), the visible text (e.g. "Sign in"), or a CSS selector.' };

  const tools = {
    browser_open: {
      schema: {
        description: 'Open a page in the built-in browser and get its numbered element list. Takes a URL (http://localhost:5173, https://example.com), a full file path (C:/site/index.html), or "back", "forward", "reload".',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'URL, full file path, or back / forward / reload.' } },
          required: ['url'],
        },
      },
      async run({ url }) {
        const browser = await getBrowser();
        const word = String(url || '').trim().toLowerCase();
        if (word === 'back' || word === 'forward') await browser.history(word === 'back' ? -1 : 1);
        else if (word === 'reload' || word === 'refresh') await browser.reload();
        else await browser.open(normaliseUrl(url));
        const errors = browser.console.filter((c) => /error/i.test(c.level)).length;
        return snap(browser, { note: errors ? `Warning: ${errors} console error(s) while loading. Call browser_console to read them.` : '' });
      },
    },

    browser_snapshot: {
      schema: {
        description: 'Look at the current page: title, URL, a numbered list of buttons, links and fields, and the page text. Call it whenever you are unsure what is on the page.',
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        return snap(await getBrowser(), { maxEls: 100, maxText: 4000 });
      },
    },

    browser_click: {
      schema: {
        description: 'Click an element. Answers with the page after the click.',
        parameters: {
          type: 'object',
          properties: { target, double: { type: 'boolean', description: 'Double-click instead.' } },
          required: ['target'],
        },
      },
      async run(args) {
        const browser = await getBrowser();
        const before = await href(browser);
        const hit = await locate(browser, targetOf(args) ?? args?.text);
        await browser.clickAt(hit.x, hit.y, { clickCount: args?.double ? 2 : 1 });
        return afterAction(browser, before, `Clicked ${hit.what}.`);
      },
    },

    browser_type: {
      schema: {
        description: 'Type into a text field (it is cleared first) or pick an option in a dropdown. Set submit to true to press Enter afterwards. Answers with the page after typing.',
        parameters: {
          type: 'object',
          properties: {
            target,
            text: { type: 'string', description: 'The text to type, or the option to pick.' },
            submit: { type: 'boolean', description: 'Press Enter after typing, e.g. to search or log in.' },
          },
          required: ['target', 'text'],
        },
      },
      async run(args) {
        const browser = await getBrowser();
        const before = await href(browser);
        const text = String(args?.text ?? args?.value ?? '');
        const name = targetOf(args);
        const hit = await locate(browser, name);
        if (hit.tag === 'SELECT') {
          const chosen = await browser.evaluate(page(`
            const el = S.find(${JSON.stringify(String(name))}).el;
            const want = ${JSON.stringify(text.toLowerCase())};
            const opts = [...el.options];
            const opt = opts.find((o) => S.clean(o.text).toLowerCase() === want || o.value.toLowerCase() === want)
              || opts.find((o) => S.clean(o.text).toLowerCase().includes(want));
            if (!opt) return { error: 'No option ' + ${JSON.stringify(JSON.stringify(text))} + '. Options: ' + opts.map((o) => S.clean(o.text)).join(' | ') };
            el.value = opt.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { text: S.clean(opt.text) };`));
          if (chosen?.error) throw new Error(chosen.error);
          return afterAction(browser, before, `Picked "${chosen.text}" in ${hit.what}.`);
        }
        if (hit.role !== 'textbox' && hit.role !== 'combobox' && hit.role !== 'searchbox') {
          throw new Error(`${hit.what} is not a text field. Use browser_click for it, or pick a textbox number from browser_snapshot.`);
        }
        await browser.clickAt(hit.x, hit.y);
        // Clear what is there, whether a plain input or a framework-managed one.
        await browser.evaluate(`(() => { const el = document.activeElement; if (!el) return;
          if (el.isContentEditable) { document.execCommand('selectAll'); document.execCommand('delete'); return; }
          if ('value' in el) { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
            set ? set.call(el, '') : (el.value = ''); el.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
        if (text) await browser.typeText(text);
        const submit = args?.submit === true || String(args?.submit).toLowerCase() === 'true' || keyName(args?.press) === 'Enter';
        if (submit) await browser.pressKey('Enter');
        return afterAction(browser, before, `Typed ${JSON.stringify(text)} into ${hit.what}${submit ? ' and pressed Enter' : ''}.`);
      },
    },

    browser_press: {
      schema: {
        description: 'Press a key on the focused element: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, PageDown, Home, End.',
        parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      },
      async run({ key }) {
        const browser = await getBrowser();
        const before = await href(browser);
        await browser.pressKey(keyName(key));
        return afterAction(browser, before, `Pressed ${keyName(key)}.`);
      },
    },

    browser_scroll: {
      schema: {
        description: 'Scroll "down" or "up" by one screen, to "top" or "bottom", or to an element (a number from the list, or its text).',
        parameters: {
          type: 'object',
          properties: { to: { type: 'string', description: 'down, up, top, bottom, or an element.' } },
        },
      },
      async run(args) {
        const browser = await getBrowser();
        const to = String(args?.to ?? args?.direction ?? targetOf(args) ?? (Number(args?.amount) < 0 ? 'up' : 'down')).trim();
        const word = to.toLowerCase();
        const vp = browser.viewport();
        let done = word;
        if (word === 'down' || word === 'up') await browser.scrollAt(vp.width / 2, vp.height / 2, (word === 'up' ? -1 : 1) * Math.round(vp.height * 0.8));
        else if (word === 'top' || word === 'bottom') await browser.evaluate(`window.scrollTo(0, ${word === 'top' ? 0 : 'document.documentElement.scrollHeight'})`);
        else done = `to ${(await locate(browser, to)).what}`;
        await settle(300);
        return snap(browser, { note: `Scrolled ${done}.` });
      },
    },

    browser_wait: {
      schema: {
        description: 'Wait until some text appears on the page (up to 15 seconds), or for a number of seconds. Use it after something that loads slowly.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to wait for.' },
            seconds: { type: 'number', description: 'Seconds to wait, at most 15.' },
          },
        },
      },
      async run({ text, seconds }) {
        const browser = await getBrowser();
        const limit = Math.min(15, Math.max(0.5, Number(seconds) || (text ? 15 : 2))) * 1000;
        const start = Date.now();
        if (text) {
          const want = JSON.stringify(String(text).toLowerCase());
          while (Date.now() - start < limit) {
            if (await browser.evaluate(`(document.body?.innerText || '').toLowerCase().includes(${want})`).catch(() => false)) {
              return snap(browser, { note: `"${text}" appeared after ${((Date.now() - start) / 1000).toFixed(1)}s.` });
            }
            await settle(400);
          }
          return snap(browser, { note: `"${text}" did not appear within ${limit / 1000}s.` });
        }
        await settle(limit);
        return snap(browser, { note: `Waited ${limit / 1000}s.` });
      },
    },

    browser_read: {
      schema: {
        description: 'Read all visible text of the current page (longer than the snapshot text).',
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const browser = await getBrowser();
        const text = String((await browser.text()) || '').trim();
        if (!text) return 'The page rendered no visible text.';
        return text.length > 12000 ? `${text.slice(0, 12000)}\n... [truncated]` : text;
      },
    },

    browser_screenshot: {
      schema: {
        description: 'Capture the page so the user can see it. If you can view images it is returned to you too.',
        parameters: {
          type: 'object',
          properties: { full_page: { type: 'boolean', description: 'Capture past the viewport.' } },
        },
      },
      async run({ full_page }) {
        const browser = await getBrowser();
        const shot = await browser.screenshot({ fullPage: full_page });
        onScreenshot?.(shot);
        const vp = browser.viewport();
        return vision()
          ? `Screenshot captured (${vp.width}x${vp.height}). It is attached for you to look at; its pixel coordinates work with browser_click_at.`
          : 'Screenshot shown to the user. You cannot view images: use browser_snapshot to check the page.';
      },
    },

    browser_console: {
      schema: {
        description: 'Read console errors and logs. Check it after loading a page you changed.',
        parameters: { type: 'object', properties: { errors_only: { type: 'boolean' } } },
      },
      async run({ errors_only }) {
        const browser = await getBrowser();
        const rows = browser.console.filter((c) => !errors_only || /error|warning/i.test(c.level));
        if (!rows.length) return errors_only ? 'No errors or warnings.' : 'Console is empty.';
        return rows
          .slice(-60)
          .map((c) => `[${c.level}] ${c.text}${c.url ? ` (${c.url}:${c.line ?? '?'})` : ''}`)
          .join('\n');
      },
    },

    browser_extract: {
      schema: {
        description:
          'Extract structured data from the current page: headings, links, images with nearby text, and embedded JSON. Use it for lists, products or results that the snapshot text does not show well.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'Maximum rows per category, default 80 and maximum 200.' },
          },
        },
      },
      async run({ limit }) {
        const browser = await getBrowser();
        const cap = Math.min(200, Math.max(10, Number(limit) || 80));
        const value = await browser.evaluate(`(() => {
          const cap = ${cap};
          const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
          const nearby = (el) => {
            let node = el;
            for (let i = 0; node && i < 5; i++, node = node.parentElement) {
              const text = clean(node.innerText || node.textContent);
              if (text.length >= 3 && text.length <= 500) return text;
            }
            return '';
          };
          const rows = (selector, map) => [...document.querySelectorAll(selector)].slice(0, cap).map(map);
          return {
            title: document.title,
            url: location.href,
            headings: rows('h1,h2,h3,h4', el => clean(el.innerText || el.textContent)).filter(Boolean),
            links: rows('a[href]', el => ({ text: clean(el.innerText || el.textContent), href: el.href })),
            images: rows('img', el => ({ alt: clean(el.alt), title: clean(el.title), src: el.currentSrc || el.src, nearby: nearby(el) })),
            embeddedJson: rows('script[type="application/json"],script#__NEXT_DATA__', el => clean(el.textContent).slice(0, 6000)).filter(Boolean),
          };
        })()`);
        const text = JSON.stringify(value, null, 2) ?? '{}';
        return text.length > 30000 ? `${text.slice(0, 30000)}\n... [truncated]` : text;
      },
    },

    browser_eval: {
      schema: {
        description:
          'Run a JavaScript expression in the page and return the result. For precise checks, e.g. getComputedStyle(document.querySelector(".card")).color.',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string' } },
          required: ['expression'],
        },
      },
      async run({ expression }) {
        const value = await (await getBrowser()).evaluate(expression);
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined';
      },
    },
  };

  // Coordinate clicks only help a model that can see the screenshot; for a
  // text-only model they invite guessed numbers.
  if (vision()) {
    tools.browser_click_at = {
      schema: {
        description: 'Click at a pixel coordinate read off a screenshot. Prefer browser_click with a number when the element is in the list.',
        parameters: {
          type: 'object',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, double: { type: 'boolean' } },
          required: ['x', 'y'],
        },
      },
      async run({ x, y, double }) {
        const browser = await getBrowser();
        const vp = browser.viewport();
        if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
          throw new Error(`(${x},${y}) is outside the ${vp.width}x${vp.height} viewport`);
        }
        const before = await href(browser);
        await browser.clickAt(x, y, { clickCount: double ? 2 : 1 });
        return afterAction(browser, before, `Clicked at (${x}, ${y}).`);
      },
    };
  }

  return tools;
}
