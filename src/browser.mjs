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

/**
 * Browser tools exposed to the model.
 *
 * `vision` decides how a screenshot is handled: a model that can see gets the
 * image back and may click by coordinate; a text-only model is steered towards
 * reading the page and the interactive map instead of pretending to look.
 */
export function browserTools(getBrowser, { onScreenshot, vision = () => false } = {}) {
  const tools = {
    browser_open: {
      schema: {
        description:
          'Open a URL in the review browser embedded in Skadi. Use this to look at a running app or dev server after changing it.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Full URL, e.g. http://localhost:5173' } },
          required: ['url'],
        },
      },
      async run({ url }) {
        if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
        const browser = await getBrowser();
        await browser.open(url);
        const vp = browser.viewport();
        return `Opened ${url}${browser.title ? ` — "${browser.title}"` : ''}. Viewport is ${vp.width}x${vp.height} (${browser.device}).`;
      },
    },

    browser_screenshot: {
      schema: {
        description:
          'Capture the current page. The user always sees it. If you can view images it is returned to you, and its pixel coordinates match browser_click_at.',
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
          ? `Screenshot captured (${vp.width}x${vp.height}). It is attached for you to look at; coordinates in it map directly to browser_click_at.`
          : `Screenshot captured (${Math.round(shot.bytes / 1024)} KB) and shown to the user. You cannot view images — use browser_read and browser_elements to inspect the page.`;
      },
    },

    browser_read: {
      schema: {
        description:
          'Read the visible text of the current page. The reliable way to check what actually rendered.',
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const browser = await getBrowser();
        const text = String((await browser.text()) || '').trim();
        if (!text) return 'The page rendered no visible text.';
        return text.length > 12000 ? `${text.slice(0, 12000)}\n... [truncated]` : text;
      },
    },

    browser_elements: {
      schema: {
        description:
          'List the clickable elements on screen with their labels and centre coordinates. Use this to choose a target for browser_click_at without vision.',
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const browser = await getBrowser();
        const items = await browser.interactiveMap();
        if (!items?.length) return 'No interactive elements are visible.';
        return items.map((i) => `(${i.x},${i.y}) <${i.tag}> ${i.label || '[no label]'}`).join('\n');
      },
    },

    browser_click_at: {
      schema: {
        description:
          'Click at a pixel coordinate in the viewport. Coordinates come from a screenshot you can see, or from browser_elements.',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            double: { type: 'boolean' },
          },
          required: ['x', 'y'],
        },
      },
      async run({ x, y, double }) {
        const browser = await getBrowser();
        const vp = browser.viewport();
        if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
          throw new Error(`(${x},${y}) is outside the ${vp.width}x${vp.height} viewport`);
        }
        await browser.clickAt(x, y, { clickCount: double ? 2 : 1 });
        return `Clicked at (${x}, ${y}).`;
      },
    },

    browser_click: {
      schema: {
        description: 'Click the first element matching a CSS selector. Prefer this when you know the selector.',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string' } },
          required: ['selector'],
        },
      },
      async run({ selector }) {
        await (await getBrowser()).click(selector);
        return `Clicked ${selector}.`;
      },
    },

    browser_type: {
      schema: {
        description:
          'Type text into whatever currently has focus, then optionally press a key. Click the field first.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            press: { type: 'string', description: 'Optional key afterwards, e.g. Enter or Tab.' },
          },
        },
      },
      async run({ text, press }) {
        const browser = await getBrowser();
        if (text) await browser.typeText(text);
        if (press) await browser.pressKey(press);
        return `Typed${text ? ` ${JSON.stringify(text)}` : ''}${press ? ` and pressed ${press}` : ''}.`;
      },
    },

    browser_fill: {
      schema: {
        description: 'Set the value of an input or textarea by selector and fire input/change events.',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string' }, value: { type: 'string' } },
          required: ['selector', 'value'],
        },
      },
      async run({ selector, value }) {
        await (await getBrowser()).fill(selector, value);
        return `Set ${selector} to ${JSON.stringify(value)}.`;
      },
    },

    browser_scroll: {
      schema: {
        description: 'Scroll the page. Positive amounts scroll down.',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'integer', description: 'Pixels, default 600.' } },
        },
      },
      async run({ amount }) {
        const browser = await getBrowser();
        const vp = browser.viewport();
        await browser.scrollAt(vp.width / 2, vp.height / 2, amount ?? 600);
        return `Scrolled ${amount ?? 600}px.`;
      },
    },

    browser_console: {
      schema: {
        description:
          'Read console output and uncaught errors. Check this after any change that could break at runtime.',
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

    browser_eval: {
      schema: {
        description:
          'Evaluate a JavaScript expression in the page and return the result. For inspection, not for building features.',
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

  return tools;
}
