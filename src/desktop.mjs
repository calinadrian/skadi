// Desktop control: the agent drives the user's real mouse, keyboard and
// screen, Jarvis-style. Everything goes through one long-lived PowerShell
// helper (desktop.ps1) so the Win32 glue compiles once, not on every click.
//
// The tools are only offered when Settings › Voice & desktop › "Let the agent
// control this computer" is on, and every one that acts is `mutates`, so the
// permission mode decides whether each click asks first.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS_DIR } from './browser.mjs';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'desktop.ps1');
const SHOT_WIDTH = 1600;

// Virtual-key codes for key names a model is likely to use.
const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, menu: 0x12, win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2c, prtsc: 0x2c, apps: 0x5d,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, mute: 0xad, playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1, mediastop: 0xb2,
  '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '`': 0xc0,
};
for (let i = 1; i <= 24; i += 1) VK[`f${i}`] = 0x6f + i;

/** "ctrl+shift+esc" -> [0x11, 0x10, 0x1b]. Throws on a name it does not know. */
export function parseChord(combo) {
  const parts = String(combo ?? '').trim().toLowerCase().split(/\s*\+\s*/).filter(Boolean);
  if (!parts.length) throw new Error('keys is required, e.g. "ctrl+c", "win+r", "enter"');
  return parts.map((p) => {
    if (VK[p] != null) return VK[p];
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    throw new Error(`unknown key "${p}"; use names like ctrl, alt, shift, win, enter, tab, esc, f5, a-z, 0-9`);
  });
}

export class DesktopHelper {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    // The last screenshot's geometry: how screenshot pixels map to screen pixels.
    this.view = null;
    // The last element list, so "click 4" means what the model was shown.
    this.elements = [];
  }

  /** Clickable things in the active window, numbered from 1. */
  async listElements({ query = '', max = 120, title = '' } = {}) {
    const res = await this.request('elements', { query, max, title }, 30000);
    // Remember which window each came from: a control in a window behind
    // others has to be brought forward before clicking it.
    const elements = [].concat(res.elements ?? []).map((e) => ({ ...e, title }));
    if (!query) this.elements = elements;
    return { window: res.window, elements };
  }

  /**
   * An element from the last list by number, or found by its visible name.
   * Returns its centre in screen pixels.
   */
  async resolveElement(target) {
    const text = String(target ?? '').trim();
    if (!text) throw new Error('say which element: a number from desktop_elements or its visible name');
    if (/^\d+$/.test(text)) {
      const hit = this.elements[Number(text) - 1];
      if (!hit) throw new Error(`there is no element ${text}; call desktop_elements for the current list`);
      return hit;
    }
    const { elements } = await this.listElements({ query: text, max: 20, title: this.elements[0]?.title ?? '' });
    const lower = text.toLowerCase();
    const hit = elements.find((e) => e.name.toLowerCase() === lower) ?? elements[0];
    if (!hit) throw new Error(`nothing named "${text}" in the active window; call desktop_elements to see what is there`);
    return hit;
  }

  _start() {
    if (this.child) return;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result ?? {});
      else waiter.reject(new Error(msg.error || 'desktop helper failed'));
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      for (const w of this.pending.values()) w.reject(new Error(`desktop helper exited${stderr ? `: ${stderr.trim()}` : ''}`));
      this.pending.clear();
    });
  }

  request(op, args = {}, timeoutMs = 20000) {
    if (process.platform !== 'win32') return Promise.reject(new Error('desktop control is only available on Windows'));
    this._start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`desktop ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  /** Screenshot pixel -> real screen pixel. Without a screenshot, taken as-is. */
  toScreen(x, y) {
    const v = this.view;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('x and y are required numbers');
    if (!v) return { x: Math.round(x), y: Math.round(y) };
    return { x: Math.round(v.left + x / v.scale), y: Math.round(v.top + y / v.scale) };
  }

  /** Monitor 0 is the main screen, -1 all of them; default the last one looked at. */
  async screenshot(monitor = this.view?.monitor ?? 0) {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const name = `desktop-${Date.now()}.png`;
    const file = join(SHOTS_DIR, name);
    const info = await this.request('screenshot', { path: file, maxWidth: SHOT_WIDTH, monitor }, 30000);
    this.view = info;
    const buffer = readFileSync(file);
    return { ...info, file, name, bytes: buffer.length, base64: buffer.toString('base64'), mediaType: 'image/png' };
  }

  close() {
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chrome and Edge only publish a page's buttons and links to UI Automation
 * when they believe a screen reader is present. desktop.ps1 wakes a running
 * browser up on demand; a browser Skadi starts gets the flag as well, so its
 * page tree is there from the first look.
 */
export function withAccessibility(target, args) {
  const text = args ? String(args) : '';
  if (!/^(chrome|msedge)(\.exe)?$/i.test(String(target).trim()) || text.includes('--force-renderer-accessibility')) return text;
  return `--force-renderer-accessibility${text ? ` ${text}` : ''}`;
}

export function desktopTools(helper, { onScreenshot, vision = () => false } = {}) {
  const xy = {
    x: { type: 'number', description: 'X in the pixels of your latest desktop_screenshot.' },
    y: { type: 'number', description: 'Y in the pixels of your latest desktop_screenshot.' },
  };
  const look = async (note, monitor) => {
    await settle(400);
    const shot = await helper.screenshot(monitor);
    onScreenshot?.(shot);
    const where = shot.monitors > 1
      ? (shot.monitor < 0 ? ` All ${shot.monitors} monitors.` : ` Monitor ${shot.monitor} of ${shot.monitors} (0 is the main one).`)
      : '';
    const head = `${note ? `${note}\n` : ''}Screen ${shot.width}x${shot.height} (screenshot pixels).${where} Active window: "${shot.foreground || 'unknown'}".`;
    if (vision()) return `${head} The new screenshot is attached; the red circle is the mouse pointer.`;
    // A model that cannot see gets the window's controls as text instead.
    return `${head}\n${await elementList().catch((err) => `(could not read the window's controls: ${err.message})`)}`;
  };
  // Brings a listed control's window forward when it was read from behind.
  const reach = async (hit) => {
    if (hit.title) {
      await helper.request('focus', { title: hit.title });
      await settle(300);
    }
  };
  const elementList = async (title = '') => {
    const { window, elements } = await helper.listElements({ title });
    if (!elements.length) return `No clickable controls found in "${window}". Try desktop_keys (e.g. "tab", "enter") or desktop_screenshot.`;
    const list = `Controls in "${window}" (click with desktop_click element="N"):\n${elements
      .map((e, i) => `[${i + 1}] ${e.type} "${e.name}"`).join('\n')}`;
    // Toolbar but no links: a browser started without page accessibility.
    const blindBrowser = /(Google Chrome|Microsoft​? Edge)$/.test(window) && !elements.some((e) => e.type === 'Hyperlink');
    return blindBrowser
      ? `${list}\nThe page's own links and buttons are not listed yet (the page may still be loading). Call desktop_elements again in a moment, ` +
        'or go to pages by URL (desktop_open target "chrome" args "<url>", or ctrl+l then type the URL) and use the site\'s keyboard shortcuts.'
      : list;
  };
  const target = { type: 'string', description: 'A number from desktop_elements, or the control\'s visible name such as "Search" or "Play".' };

  return {
    desktop_screenshot: {
      schema: {
        description: 'Look at the user\'s screen (their real computer, not the built-in browser). Returns the screen size and active window; vision models also get the image. Its pixel coordinates are what desktop_click uses, and later actions stay on the same monitor.',
        parameters: {
          type: 'object',
          properties: { monitor: { type: 'integer', description: 'Which monitor: 0 is the main one (default), -1 all of them at once.' } },
        },
      },
      run: ({ monitor } = {}) => look('', Number.isInteger(monitor) ? monitor : undefined),
    },

    desktop_elements: {
      schema: {
        description: 'List the buttons, links, fields, tabs and list items in the active window of the user\'s computer (any app, including web pages in Chrome), numbered. The quickest way to find what to click.',
        parameters: {
          type: 'object',
          properties: { window: { type: 'string', description: 'Read another window instead of the active one: part of its title or its process name, e.g. "chrome". Clicking one of its controls brings it to the front.' } },
        },
      },
      run: ({ window } = {}) => elementList(String(window ?? '').trim()),
    },

    desktop_click: {
      mutates: true,
      schema: {
        description: 'Click on the user\'s real screen: a control by element (number or visible name, see desktop_elements), or a point by x/y from desktop_screenshot. Answers with what the screen shows next.',
        parameters: {
          type: 'object',
          properties: {
            element: target,
            ...xy,
            button: { type: 'string', enum: ['left', 'right', 'middle'] },
            double: { type: 'boolean', description: 'Double-click.' },
          },
        },
      },
      async run({ element, x, y, button = 'left', double = false }) {
        let p;
        let what;
        if (element != null && String(element).trim()) {
          const hit = await helper.resolveElement(element);
          await reach(hit);
          p = { x: hit.x, y: hit.y };
          what = `${hit.type} "${hit.name}"`;
        } else {
          p = helper.toScreen(x, y);
          what = `(${x}, ${y})`;
        }
        await helper.request('click', { ...p, button, count: double ? 2 : 1 });
        return look(`${double ? 'Double-clicked' : 'Clicked'} ${what}.`);
      },
    },

    desktop_drag: {
      mutates: true,
      schema: {
        description: 'Drag with the left mouse button from one point to another on the user\'s screen.',
        parameters: {
          type: 'object',
          properties: { ...xy, to_x: { type: 'number' }, to_y: { type: 'number' } },
          required: ['x', 'y', 'to_x', 'to_y'],
        },
      },
      async run({ x, y, to_x, to_y }) {
        const a = helper.toScreen(x, y);
        const b = helper.toScreen(to_x, to_y);
        await helper.request('drag', { x: a.x, y: a.y, x2: b.x, y2: b.y });
        return look(`Dragged from (${x}, ${y}) to (${to_x}, ${to_y}).`);
      },
    },

    desktop_scroll: {
      mutates: true,
      schema: {
        description: 'Scroll the mouse wheel on the user\'s screen, optionally over a point. Positive clicks scroll up, negative scroll down.',
        parameters: {
          type: 'object',
          properties: { clicks: { type: 'integer', description: 'Wheel notches: 3 = up a bit, -5 = down more.' }, ...xy },
          required: ['clicks'],
        },
      },
      async run({ clicks, x, y }) {
        const at = x != null && y != null ? helper.toScreen(x, y) : {};
        await helper.request('scroll', { ...at, clicks: Math.max(-50, Math.min(50, Math.round(Number(clicks) || 0))) });
        return look(`Scrolled ${clicks}.`);
      },
    },

    desktop_type: {
      mutates: true,
      schema: {
        description: 'Type text on the user\'s computer as if on the keyboard, into whatever has focus or first into a field named by element. Newlines press Enter; set submit to press Enter after.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            element: { ...target, description: 'Optional field to click first: a number from desktop_elements or its name, e.g. "Search".' },
            submit: { type: 'boolean', description: 'Press Enter after typing.' },
          },
          required: ['text'],
        },
      },
      async run({ text, element, submit = false }) {
        const value = String(text ?? '');
        if (!value) throw new Error('text is required');
        if (element != null && String(element).trim()) {
          const hit = await helper.resolveElement(element);
          await reach(hit);
          await helper.request('click', { x: hit.x, y: hit.y, button: 'left', count: 1 });
          await settle(250);
        }
        await helper.request('type', { text: submit ? `${value}\n` : value }, 60000);
        return look(`Typed ${value.length} character(s)${submit ? ' and pressed Enter' : ''}.`);
      },
    },

    desktop_keys: {
      mutates: true,
      schema: {
        description: 'Press a key or shortcut on the user\'s computer, e.g. "enter", "ctrl+c", "alt+tab", "win+d", "ctrl+shift+esc", "volumeup", "playpause".',
        parameters: { type: 'object', properties: { keys: { type: 'string' }, repeat: { type: 'integer', description: 'Press it this many times (default 1).' } }, required: ['keys'] },
      },
      async run({ keys, repeat = 1 }) {
        const vks = parseChord(keys);
        const times = Math.max(1, Math.min(50, Math.round(Number(repeat) || 1)));
        for (let i = 0; i < times; i += 1) await helper.request('keys', { vks });
        return look(`Pressed ${keys}${times > 1 ? ` x${times}` : ''}.`);
      },
    },

    desktop_open: {
      mutates: true,
      schema: {
        description: 'Open an app, file, folder or URL on the user\'s computer the way Windows Run would: "notepad", "calc", "spotify:", "https://youtube.com", "C:/Users/me/Documents". For a site in a particular browser use target "chrome" (or "msedge", "firefox") with the URL as args. The user\'s own browser is signed in to their accounts, so their playlists and libraries are there.',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string' }, args: { type: 'string', description: 'Optional command-line arguments.' } },
          required: ['target'],
        },
      },
      async run({ target, args }) {
        if (!String(target ?? '').trim()) throw new Error('target is required');
        await helper.request('open', { target: String(target), args: withAccessibility(target, args) });
        await settle(1200);
        return look(`Opened ${target}.`);
      },
    },

    desktop_windows: {
      schema: {
        description: 'List the open windows on the user\'s computer (title and process) and which one is active.',
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const { windows = [], foreground } = await helper.request('windows');
        const list = [].concat(windows).map((w) => `- ${w.title} (${w.process})`).join('\n');
        return `Active: ${foreground || 'unknown'}\n${list || '(no windows)'}`;
      },
    },

    desktop_focus: {
      mutates: true,
      schema: {
        description: 'Bring a window to the front by part of its title or its process name (see desktop_windows).',
        parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
      async run({ title }) {
        const hit = await helper.request('focus', { title: String(title ?? '') });
        return look(`Focused "${hit.title}" (${hit.process}).`);
      },
    },
  };
}
