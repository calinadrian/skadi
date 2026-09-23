// Built-in pixel art studio: the agent paints sprites, icons, tiles and scenes
// with drawing tools on a palette-locked canvas, looks at the result as a
// character grid, fixes it, and exports crisp PNGs ready for a web page or a
// game.
//
// The approach -- an agent that places pixels with shapes, noise and per-pixel
// tools and "steps back to look" through a compact character grid, instead of
// a diffusion model approximating pixels -- is ported from Texel Studio by
// Emir Yaman Sivrikaya, https://github.com/EYamanS/texel-studio (Texel Studio
// License: modification and integration permitted with this link). Its canvas
// primitives, noise/Voronoi fills, grid view and autotile generator are
// re-implemented here in dependency-free JavaScript, alongside additions aimed
// at small local models: batched operations with forgiving argument names,
// one-call outline/shade/mirror/gradient helpers, a tiny pixel font, frames and
// sprite sheets, PNG import, and quality hints after every look.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- palettes

/** Well-known pixel art palettes, by the names people search Lospec for. */
export const PALETTES = {
  'pico-8': ['#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8', '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'],
  'sweetie-16': ['#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#A7F070', '#38B764', '#257179', '#29366F', '#3B5DC9', '#41A6F6', '#73EFF7', '#F4F4F4', '#94B0C2', '#566C86', '#333C57'],
  'endesga-32': ['#BE4A2F', '#D77643', '#EAD4AA', '#E4A672', '#B86F50', '#733E39', '#3E2731', '#A22633', '#E43B44', '#F77622', '#FEAE34', '#FEE761', '#63C74D', '#3E8948', '#265C42', '#193C3E', '#124E89', '#0099DB', '#2CE8F5', '#FFFFFF', '#C0CBDC', '#8B9BB4', '#5A6988', '#3A4466', '#262B44', '#181425', '#FF0044', '#68386C', '#B55088', '#F6757A', '#E8B796', '#C28569'],
  // Texel Studio's default "Earth" palette: soils, foliage, stone, sand, wood.
  earth: ['#5C3317', '#7B4B2A', '#8B5E3C', '#A0704B', '#2D6B12', '#3D8B24', '#4CAF50', '#6ECF5C', '#505055', '#68686E', '#7C7C82', '#929298', '#C2A65A', '#D4BE6A', '#E8D47A', '#F0E090', '#8B6533', '#A67B44', '#C49555', '#D4A866', '#C84040', '#D46060', '#4AC8C8', '#80E0E0'],
  gameboy: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'],
  grayscale: ['#000000', '#222222', '#444444', '#666666', '#888888', '#AAAAAA', '#CCCCCC', '#FFFFFF'],
};
export const DEFAULT_PALETTE = 'sweetie-16';
const MAX_COLORS = 36;
const MAX_SIDE = 256;

/** What each kind of image is for, and how to compose it (after Texel's sprite types). */
export const KINDS = {
  icon: { size: [32, 32], hint: 'ITEM ICON: one object on a transparent background (-1). Chunky and readable, 1-2px of empty padding on every side, a dark outline, light from the top-left.' },
  character: { size: [32, 32], hint: 'CHARACTER: one figure on a transparent background (-1), front or side view. Big head, clear silhouette, symmetric body (draw one half, then mirror), dark outline, 2-3 shades per material.' },
  tile: { size: [16, 16], hint: 'TILE: fill EVERY pixel, no transparency. It repeats next to copies of itself, so avoid features that touch one edge but not the opposite one. Texture with noise or voronoi, then shade.' },
  scene: { size: [96, 54], hint: 'SCENE/BACKGROUND: fill the whole canvas. Work back to front: sky gradient, far shapes (low contrast), near shapes (high contrast), details last.' },
  ui: { size: [48, 16], hint: 'UI ELEMENT (button, panel, bar): fill the shape, 1px dark outline, 1px light top edge and dark bottom edge for depth. Text with the text op.' },
  freeform: { size: [32, 32], hint: 'FREEFORM: a standalone object or character goes on transparent background (-1); a scene or pattern fills the canvas.' },
};

// ------------------------------------------------------------------ colours

const hexRgb = (hex) => {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};
const rgbHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A palette from a preset name, a list of hex colours, or nothing (the default). */
export function resolvePalette(value) {
  if (Array.isArray(value)) {
    const colors = value.map((c) => String(c).trim()).filter((c) => HEX.test(c)).map((c) => rgbHex(hexRgb(c)));
    if (!colors.length) throw new PixelError('palette needs at least one hex colour like "#1A1C2C"');
    if (colors.length > MAX_COLORS) throw new PixelError(`a palette can hold at most ${MAX_COLORS} colours`);
    return colors;
  }
  const key = String(value || DEFAULT_PALETTE).trim().toLowerCase().replace(/[\s_]+/g, '-');
  const preset = PALETTES[key] || PALETTES[key.replace(/-/g, '')] || Object.entries(PALETTES).find(([name]) => name.replace(/-/g, '') === key.replace(/-/g, ''))?.[1];
  if (!preset) throw new PixelError(`unknown palette "${value}". Use one of: ${Object.keys(PALETTES).join(', ')}, or a list of hex colours`);
  return [...preset];
}

const nearest = (palette, rgb) => {
  let best = 0;
  let bestDist = Infinity;
  palette.forEach((hex, index) => {
    const [r, g, b] = hexRgb(hex);
    const d = (r - rgb[0]) ** 2 * 0.3 + (g - rgb[1]) ** 2 * 0.59 + (b - rgb[2]) ** 2 * 0.11;
    if (d < bestDist) { bestDist = d; best = index; }
  });
  return best;
};
const luminance = (hex) => { const [r, g, b] = hexRgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

export class PixelError extends Error {}

// ------------------------------------------------------------------- canvas

export class Canvas {
  constructor(width, height, palette, pixels = null) {
    this.w = width;
    this.h = height;
    this.palette = palette;
    this.px = pixels ? Int16Array.from(pixels) : new Int16Array(width * height).fill(-1);
  }

  static create({ width, height, palette, background = -1 }) {
    const w = clampSide(width);
    const h = clampSide(height ?? width);
    const canvas = new Canvas(w, h, resolvePalette(palette));
    const bg = canvas.color(background ?? -1);
    canvas.px.fill(bg);
    return canvas;
  }

  clone() { return new Canvas(this.w, this.h, [...this.palette], this.px); }

  /** A palette index from an index, a hex colour, or a "transparent" word. */
  color(value) {
    if (value === undefined || value === null || value === '') throw new PixelError('a color is required (a palette index, a hex colour, or -1 for transparent)');
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['transparent', 'none', 'clear', 'empty', 'erase', '.'].includes(v)) return -1;
      if (HEX.test(v)) return nearest(this.palette, hexRgb(v));
      if (/^-?\d+$/.test(v)) return this.color(Number(v));
      if (/^[a-z]$/.test(v)) return this.color(v.charCodeAt(0) - 87); // grid letters: a = 10
      throw new PixelError(`"${value}" is not a colour; use a palette index 0-${this.palette.length - 1}, a hex colour, or -1`);
    }
    const n = Math.trunc(Number(value));
    if (n === -1) return -1;
    if (!Number.isFinite(n) || n < 0 || n >= this.palette.length) {
      throw new PixelError(`colour ${value} is not in the palette; use 0-${this.palette.length - 1}, or -1 for transparent`);
    }
    return n;
  }

  inside(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { return this.inside(x, y) ? this.px[y * this.w + x] : -1; }
  set(x, y, c) {
    if (!this.inside(x, y)) return 0;
    this.px[y * this.w + x] = c;
    return 1;
  }

  rect(x1, y1, x2, y2, c, fill = true) {
    [x1, x2] = [Math.min(x1, x2), Math.max(x1, x2)];
    [y1, y2] = [Math.min(y1, y2), Math.max(y1, y2)];
    let n = 0;
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (fill || x === x1 || x === x2 || y === y1 || y === y2) n += this.set(x, y, c);
      }
    }
    return n;
  }

  line(x1, y1, x2, y2, c) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let n = 0;
    for (let guard = 0; guard < 4 * MAX_SIDE; guard++) {
      n += this.set(x1, y1, c);
      if (x1 === x2 && y1 === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x1 += sx; }
      if (e2 < dx) { err += dx; y1 += sy; }
    }
    return n;
  }

  ellipse(cx, cy, rx, ry, c, fill = true) {
    rx = Math.max(0, rx);
    ry = Math.max(0, ry);
    let n = 0;
    const inside = (x, y) => ((x - cx) / (rx + 0.5)) ** 2 + ((y - cy) / (ry + 0.5)) ** 2 <= 1;
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (!inside(x, y)) continue;
        // Outline: a pixel inside whose 4-neighbour is outside.
        if (!fill && inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1)) continue;
        n += this.set(x, y, c);
      }
    }
    return n;
  }

  triangle(x1, y1, x2, y2, x3, y3, c) {
    const sign = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);
    let n = 0;
    for (let y = Math.min(y1, y2, y3); y <= Math.max(y1, y2, y3); y++) {
      for (let x = Math.min(x1, x2, x3); x <= Math.max(x1, x2, x3); x++) {
        const d1 = sign(x, y, x1, y1, x2, y2);
        const d2 = sign(x, y, x2, y2, x3, y3);
        const d3 = sign(x, y, x3, y3, x1, y1);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) n += this.set(x, y, c);
      }
    }
    return n;
  }

  rotatedRect(cx, cy, w, h, angle, c) {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const reach = Math.ceil(Math.hypot(w / 2, h / 2)) + 1;
    let n = 0;
    for (let y = cy - reach; y <= cy + reach; y++) {
      for (let x = cx - reach; x <= cx + reach; x++) {
        const lx = (x - cx) * cos + (y - cy) * sin;
        const ly = -(x - cx) * sin + (y - cy) * cos;
        if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) n += this.set(x, y, c);
      }
    }
    return n;
  }

  /** Texel's hash noise: a stable pseudo-random value in [0, 1). */
  static noise(x, y, seed) {
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n & 0x7fffffff) / 0x80000000;
  }

  /** Colours spread by noise. density < 1 only sprinkles over what is there. */
  noiseRect(x1, y1, x2, y2, colors, seed = 42, density = 1, mask = null) {
    let n = 0;
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        if (!this.inside(x, y) || (mask && !mask(x, y))) continue;
        if (density < 1 && Canvas.noise(x, y, seed + 7919) >= density) continue;
        n += this.set(x, y, colors[Math.floor(Canvas.noise(x, y, seed) * colors.length) % colors.length]);
      }
    }
    return n;
  }

  voronoi(x1, y1, x2, y2, colors, cells = 8, seed = 42) {
    const w = Math.abs(x2 - x1) + 1;
    const h = Math.abs(y2 - y1) + 1;
    const ox = Math.min(x1, x2);
    const oy = Math.min(y1, y2);
    const points = Array.from({ length: Math.max(1, cells) }, (_, i) => [
      ox + Math.floor(Canvas.noise(i, 0, seed) * w),
      oy + Math.floor(Canvas.noise(0, i, seed + 99) * h),
      colors[i % colors.length],
    ]);
    let n = 0;
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        let best = Infinity;
        let color = colors[0];
        for (const [px, py, pc] of points) {
          const d = (x - px) ** 2 + (y - py) ** 2;
          if (d < best) { best = d; color = pc; }
        }
        n += this.set(x, y, color);
      }
    }
    return n;
  }

  /** Bands of colour with ordered (Bayer) dithering where they meet. */
  gradient(x1, y1, x2, y2, colors, direction = 'vertical') {
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
    const horizontal = /^h/i.test(direction);
    const span = Math.max(1, horizontal ? bx - ax : by - ay);
    let n = 0;
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const t = ((horizontal ? x - ax : y - ay) / span) * (colors.length - 1);
        const band = Math.min(colors.length - 2, Math.floor(t));
        const frac = colors.length === 1 ? 0 : t - Math.max(0, band);
        const threshold = (bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        const pick = colors.length === 1 ? colors[0] : colors[Math.max(0, band) + (frac > threshold ? 1 : 0)];
        n += this.set(x, y, pick);
      }
    }
    return n;
  }

  /** The pixels connected to (x, y) that share its colour, as a lookup. */
  region(x, y) {
    const inside = new Set();
    if (!this.inside(x, y)) return () => false;
    const target = this.get(x, y);
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      const key = py * this.w + px;
      if (!this.inside(px, py) || inside.has(key) || this.get(px, py) !== target) continue;
      inside.add(key);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    return (qx, qy) => inside.has(qy * this.w + qx);
  }

  floodFill(x, y, c) {
    if (!this.inside(x, y)) return 0;
    const target = this.get(x, y);
    if (target === c) return 0;
    const stack = [[x, y]];
    let n = 0;
    while (stack.length) {
      const [px, py] = stack.pop();
      if (!this.inside(px, py) || this.get(px, py) !== target) continue;
      n += this.set(px, py, c);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    return n;
  }

  /** A 1px outline hugging every drawn shape from outside. */
  outline(c, { corners = false, only = null } = {}) {
    const marks = [];
    const drawn = (x, y) => { const v = this.get(x, y); return v !== -1 && (only === null || v === only); };
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y) !== -1) continue;
        const near = drawn(x + 1, y) || drawn(x - 1, y) || drawn(x, y + 1) || drawn(x, y - 1)
          || (corners && (drawn(x + 1, y + 1) || drawn(x - 1, y - 1) || drawn(x + 1, y - 1) || drawn(x - 1, y + 1)));
        if (near) marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.set(x, y, c);
    return marks.length;
  }

  /**
   * Form shading in one call: pixels of one colour get a highlight where
   * their top/left edge meets something else and a shadow along the
   * bottom/right. Light comes from the top-left, as pixel art convention has it.
   */
  shade(target, highlight, shadow, width = 1, within = null) {
    const marks = [];
    const same = (x, y) => this.get(x, y) === target;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!same(x, y) || (within && !within(x, y))) continue;
        let lit = false;
        let dark = false;
        for (let d = 1; d <= width; d++) {
          if (!same(x, y - d) || !same(x - d, y)) lit = true;
          if (!same(x, y + d) || !same(x + d, y)) dark = true;
        }
        if (dark && shadow !== null) marks.push([x, y, shadow]);
        else if (lit && highlight !== null) marks.push([x, y, highlight]);
      }
    }
    for (const [x, y, c] of marks) this.set(x, y, c);
    return marks.length;
  }

  /** Copy one half onto the other: draw half a character, mirror it. */
  mirror(axis = 'x', from = 'left') {
    let n = 0;
    if (/^x|^h|left|right/i.test(axis)) {
      const fromRight = /right/i.test(from);
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < Math.floor(this.w / 2); x++) {
          const src = fromRight ? this.w - 1 - x : x;
          const dst = fromRight ? x : this.w - 1 - x;
          n += this.set(dst, y, this.get(src, y));
        }
      }
    } else {
      const fromBottom = /bottom/i.test(from);
      for (let y = 0; y < Math.floor(this.h / 2); y++) {
        for (let x = 0; x < this.w; x++) {
          const src = fromBottom ? this.h - 1 - y : y;
          const dst = fromBottom ? y : this.h - 1 - y;
          n += this.set(x, dst, this.get(x, src));
        }
      }
    }
    return n;
  }

  replace(from, to, box = null) {
    let n = 0;
    const [x1, y1, x2, y2] = box || [0, 0, this.w - 1, this.h - 1];
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) if (this.get(x, y) === from) n += this.set(x, y, to);
    }
    return n;
  }

  shift(dx, dy) {
    const old = Int16Array.from(this.px);
    this.px.fill(-1);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const v = old[y * this.w + x];
        if (v !== -1) this.set(x + dx, y + dy, v);
      }
    }
    return this.w * this.h;
  }

  /** Paint another canvas onto this one; its colours map to this palette. */
  stamp(other, ox, oy, { flip = false } = {}) {
    const map = other.palette.map((hex) => (this.palette.includes(hex) ? this.palette.indexOf(hex) : nearest(this.palette, hexRgb(hex))));
    let n = 0;
    for (let y = 0; y < other.h; y++) {
      for (let x = 0; x < other.w; x++) {
        const v = other.get(flip ? other.w - 1 - x : x, y);
        if (v !== -1) n += this.set(ox + x, oy + y, map[v]);
      }
    }
    return n;
  }

  text(x, y, value, c, scale = 1) {
    let n = 0;
    let cx = x;
    for (const ch of String(value).toUpperCase()) {
      if (ch === '\n') { cx = x; y += 6 * scale; continue; }
      const glyph = FONT[ch] || FONT['?'];
      glyph.forEach((row, gy) => [...row].forEach((bit, gx) => {
        if (bit !== '#') return;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) n += this.set(cx + gx * scale + sx, y + gy * scale + sy, c);
      }));
      cx += 4 * scale;
    }
    return n;
  }

  // ---------------------------------------------------------------- views

  counts() {
    const counts = new Map();
    for (const v of this.px) counts.set(v, (counts.get(v) || 0) + 1);
    return counts;
  }

  /** Texel's compact grid: one character per pixel, 0-9 then A-Z, '.' empty. */
  grid(x1 = 0, y1 = 0, x2 = this.w - 1, y2 = this.h - 1) {
    const ch = (v) => (v < 0 ? '.' : v < 10 ? String(v) : String.fromCharCode(55 + v));
    const cols = [];
    for (let x = x1; x <= x2; x++) cols.push(x);
    const width = String(y2).length;
    const pad = ' '.repeat(width + 1);
    const ruler = cols.some((x) => x >= 10)
      ? `${pad}${cols.map((x) => (x >= 10 ? String(Math.floor(x / 10) % 10) : ' ')).join('')}\n${pad}${cols.map((x) => x % 10).join('')}`
      : `${pad}${cols.join('')}`;
    const rows = [];
    for (let y = y1; y <= y2; y++) rows.push(`${String(y).padStart(width)} ${cols.map((x) => ch(this.get(x, y))).join('')}`);
    return `${ruler}\n${rows.join('\n')}`;
  }

  legend() {
    const counts = this.counts();
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => (v < 0
      ? `. transparent ×${n}`
      : `${v < 10 ? v : String.fromCharCode(55 + v)} = ${v} ${this.palette[v]} ×${n}`)).join(', ');
  }

  /** Cheap self-critique, the "step back and look" a small model skips. */
  hints() {
    const out = [];
    const counts = this.counts();
    const filled = this.w * this.h - (counts.get(-1) || 0);
    if (!filled) return ['The canvas is empty. Start with the biggest shapes (rect, ellipse), then add detail.'];
    const used = [...counts.keys()].filter((v) => v >= 0);
    if (used.length < 3) out.push('Only 1-2 colours: give each material a highlight and a shadow shade (op "shade").');
    const transparent = counts.get(-1) || 0;
    if (transparent) {
      // Edge pixels: drawn pixels touching transparency. Art reads best when
      // most of them are dark, i.e. there is an outline. "Dark" is the bottom
      // third of the brightness range this drawing actually uses.
      const lums = used.map((v) => luminance(this.palette[v]));
      const cut = Math.min(...lums) + 0.35 * (Math.max(...lums) - Math.min(...lums));
      const isDark = (v) => luminance(this.palette[v]) <= cut;
      const darkest = used.reduce((a, b) => (luminance(this.palette[a]) <= luminance(this.palette[b]) ? a : b));
      let edge = 0;
      let dark = 0;
      let touchesBorder = false;
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          const v = this.get(x, y);
          if (v === -1) continue;
          if (x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1) touchesBorder = true;
          if (this.get(x + 1, y) === -1 || this.get(x - 1, y) === -1 || this.get(x, y + 1) === -1 || this.get(x, y - 1) === -1) {
            edge++;
            if (isDark(v)) dark++;
          }
        }
      }
      if (edge > 8 && dark / edge < 0.6) out.push(`No clear outline: add {"op":"outline","color":${darkest}} (or a dark colour) so the shape reads against any background.`);
      if (touchesBorder && transparent > filled * 0.2) out.push('The drawing touches the canvas edge; leave 1px of transparent padding (op "shift" can move it).');
    }
    const [top, topCount] = [...counts.entries()].filter(([v]) => v >= 0).sort((a, b) => b[1] - a[1])[0];
    if (topCount > 96 && topCount / filled > 0.6) out.push(`Colour ${top} covers ${Math.round((100 * topCount) / filled)}% of the drawing as one flat area: add texture (op "noise" with density 0.15) or shading (op "shade").`);
    return out;
  }

  view({ x1, y1, x2, y2 } = {}) {
    const limit = 64;
    const ax = clampInt(x1, 0, this.w - 1, 0);
    const ay = clampInt(y1, 0, this.h - 1, 0);
    const bx = clampInt(x2, ax, this.w - 1, Math.min(this.w - 1, ax + limit - 1));
    const by = clampInt(y2, ay, this.h - 1, Math.min(this.h - 1, ay + limit - 1));
    const cropped = ax > 0 || ay > 0 || bx < this.w - 1 || by < this.h - 1;
    const counts = this.counts();
    const hints = this.hints();
    return [
      `Canvas ${this.w}x${this.h}${cropped ? `, showing x ${ax}-${bx}, y ${ay}-${by} (pass x1,y1,x2,y2 to see more)` : ''}. x goes right, y goes down, (0,0) is top-left.`,
      this.grid(ax, ay, bx, by),
      `Legend: ${this.legend()}`,
      `Filled ${this.w * this.h - (counts.get(-1) || 0)}/${this.w * this.h} px.`,
      hints.length ? `Suggestions:\n- ${hints.join('\n- ')}` : 'Looks well formed: outline, shading and texture checks pass.',
    ].join('\n');
  }

  // ---------------------------------------------------------------- images

  rgba(scale = 1) {
    const s = Math.max(1, Math.floor(scale));
    const w = this.w * s;
    const out = Buffer.alloc(w * this.h * s * 4);
    const rgb = this.palette.map(hexRgb);
    for (let y = 0; y < this.h * s; y++) {
      for (let x = 0; x < w; x++) {
        const v = this.px[Math.floor(y / s) * this.w + Math.floor(x / s)];
        if (v < 0) continue;
        const o = (y * w + x) * 4;
        out[o] = rgb[v][0]; out[o + 1] = rgb[v][1]; out[o + 2] = rgb[v][2]; out[o + 3] = 255;
      }
    }
    return { width: w, height: this.h * s, data: out };
  }

  png(scale = 1) {
    const { width, height, data } = this.rgba(scale);
    return encodePng(width, height, data);
  }

  toJSON() {
    return { w: this.w, h: this.h, palette: this.palette, px: Buffer.from(Uint8Array.from(this.px, (v) => v + 1)).toString('base64') };
  }

  static fromJSON(data) {
    const bytes = Buffer.from(String(data.px || ''), 'base64');
    return new Canvas(data.w, data.h, data.palette, Array.from(bytes, (v) => v - 1));
  }
}

const clampSide = (value) => {
  const n = Math.trunc(Number(value) || 32);
  if (n < 1 || n > MAX_SIDE) throw new PixelError(`canvas sides must be 1-${MAX_SIDE} pixels (16, 32 or 64 suit most sprites)`);
  return n;
};
const clampInt = (value, min, max, fallback) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

// A 3x5 pixel font; each glyph advances 4px (times the scale).
const FONT = Object.fromEntries(Object.entries({
  A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.', C: '.##|#..|#..|#..|.##', D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..', G: '.##|#..|#.#|#.#|.##', H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###', J: '..#|..#|..#|#.#|.#.', K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###',
  M: '#.#|###|###|#.#|#.#', N: '##.|#.#|#.#|#.#|#.#', O: '.#.|#.#|#.#|#.#|.#.', P: '##.|#.#|##.|#..|#..',
  Q: '.#.|#.#|#.#|##.|.##', R: '##.|#.#|##.|#.#|#.#', S: '.##|#..|.#.|..#|##.', T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###', V: '#.#|#.#|#.#|#.#|.#.', W: '#.#|#.#|###|###|#.#', X: '#.#|#.#|.#.|#.#|#.#',
  Y: '#.#|#.#|.#.|.#.|.#.', Z: '###|..#|.#.|#..|###',
  0: '###|#.#|#.#|#.#|###', 1: '.#.|##.|.#.|.#.|###', 2: '##.|..#|.#.|#..|###', 3: '##.|..#|.#.|..#|##.',
  4: '#.#|#.#|###|..#|..#', 5: '###|#..|##.|..#|##.', 6: '.##|#..|###|#.#|###', 7: '###|..#|.#.|.#.|.#.',
  8: '###|#.#|###|#.#|###', 9: '###|#.#|###|..#|##.',
  ' ': '...|...|...|...|...', '.': '...|...|...|...|.#.', ',': '...|...|...|.#.|#..', '!': '.#.|.#.|.#.|...|.#.',
  '?': '##.|..#|.#.|...|.#.', '-': '...|...|###|...|...', '+': '...|.#.|###|.#.|...', ':': '...|.#.|...|.#.|...',
  '/': '..#|..#|.#.|#..|#..', "'": '.#.|.#.|...|...|...', '(': '.#.|#..|#..|#..|.#.', ')': '.#.|..#|..#|..#|.#.',
  '=': '...|###|...|###|...', '%': '#.#|..#|.#.|#..|#.#', '#': '#.#|###|#.#|###|#.#', '<': '..#|.#.|#..|.#.|..#',
  '>': '#..|.#.|..#|.#.|#..', '*': '...|#.#|.#.|#.#|...', '_': '...|...|...|...|###', '$': '.##|##.|.#.|.##|##.',
}).map(([k, v]) => [k, v.split('|')]));

// ------------------------------------------------------------------ PNG I/O

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** RGBA8 pixels to a PNG file. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG file to RGBA8 pixels. Non-interlaced; every colour type and depth. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new PixelError('not a PNG file');
  let off = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new PixelError('PNG has no header');
  if (ihdr.interlace) throw new PixelError('interlaced PNGs are not supported; re-save it without interlacing');
  if (ihdr.w > 2048 || ihdr.h > 2048) throw new PixelError('image is larger than 2048px; pixel art should be much smaller');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.type];
  const bitsPP = channels * ihdr.depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const stride = Math.ceil((ihdr.w * bitsPP) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * ihdr.h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(rows, y * stride);
    prev = line;
  }
  const out = Buffer.alloc(ihdr.w * ihdr.h * 4);
  const sample = (row, index) => {
    if (ihdr.depth === 8) return rows[row * stride + index];
    if (ihdr.depth === 16) return rows[row * stride + index * 2];
    const perByte = 8 / ihdr.depth;
    const byte = rows[row * stride + Math.floor(index / perByte)];
    const shift = 8 - ihdr.depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << ihdr.depth) - 1);
  };
  const scaleBits = (v) => (ihdr.depth >= 8 ? v : Math.round((v * 255) / ((1 << ihdr.depth) - 1)));
  for (let y = 0; y < ihdr.h; y++) {
    for (let x = 0; x < ihdr.w; x++) {
      const o = (y * ihdr.w + x) * 4;
      if (ihdr.type === 3) {
        const i = sample(y, x);
        out[o] = plte[i * 3]; out[o + 1] = plte[i * 3 + 1]; out[o + 2] = plte[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else {
        const v = (k) => scaleBits(sample(y, x * channels + k));
        if (ihdr.type === 0 || ihdr.type === 4) { out[o] = out[o + 1] = out[o + 2] = v(0); out[o + 3] = ihdr.type === 4 ? v(1) : 255; }
        else { out[o] = v(0); out[o + 1] = v(1); out[o + 2] = v(2); out[o + 3] = ihdr.type === 6 ? v(3) : 255; }
      }
    }
  }
  return { width: ihdr.w, height: ihdr.h, data: out };
}

/** The pixel size of upscaled pixel art: the largest block that is always one colour. */
export function detectBlock({ width, height, data }) {
  for (let k = 16; k > 1; k--) {
    if (width % k || height % k) continue;
    let uniform = true;
    for (let y = 0; y < height && uniform; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const b = ((y - (y % k)) * width + (x - (x % k))) * 4;
        if (data.readUInt32BE(o) !== data.readUInt32BE(b)) { uniform = false; break; }
      }
    }
    if (uniform) return k;
  }
  return 1;
}

/** An RGBA image to a canvas: shrink upscaled art, then map to a palette. */
export function canvasFromImage(image, { palette = null, maxColors = 32 } = {}) {
  const block = detectBlock(image);
  const w = image.width / block;
  const h = image.height / block;
  if (w > MAX_SIDE || h > MAX_SIDE) throw new PixelError(`image is ${w}x${h} art pixels; the limit is ${MAX_SIDE}x${MAX_SIDE}`);
  const at = (x, y) => {
    const o = ((y * block) * image.width + x * block) * 4;
    return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
  };
  let colors = palette ? resolvePalette(palette) : null;
  if (!colors) {
    const freq = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [r, g, b, a] = at(x, y);
      if (a < 128) continue;
      const hex = rgbHex([r, g, b]);
      freq.set(hex, (freq.get(hex) || 0) + 1);
    }
    colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(MAX_COLORS, Math.max(2, maxColors))).map(([hex]) => hex);
    if (!colors.length) colors = ['#000000'];
  }
  const canvas = new Canvas(w, h, colors);
  const exact = new Map(colors.map((hex, i) => [hex, i]));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = at(x, y);
    if (a < 128) continue;
    const hex = rgbHex([r, g, b]);
    canvas.set(x, y, exact.has(hex) ? exact.get(hex) : nearest(colors, [r, g, b]));
  }
  return { canvas, block };
}

// ---------------------------------------------------------------- autotile

/**
 * Texel Studio's autotile generator: from one full tile, the 16 variants a
 * tilemap needs, by which neighbours are missing (TOP=1, RIGHT=2, BOTTOM=4,
 * LEFT=8 set means "a neighbour is there"). Exposed edges get light/shadow
 * bands, a darker outline and rounded corners.
 */
export function autotileVariant(tile, mask) {
  const size = tile.w;
  const { data } = tile.rgba(1);
  const img = Buffer.from(data);
  const top = !(mask & 1); const right = !(mask & 2); const bottom = !(mask & 4); const left = !(mask & 8);
  const band = Math.max(2, Math.floor(size / 5));
  const intensity = 0.15;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    if (img[o + 3] < 25) continue;
    let f = 0;
    if (top && y < band) f += intensity * (1 - y / band);
    if (left && x < band) f += intensity * 0.6 * (1 - x / band);
    if (bottom && size - 1 - y < band) f -= intensity * (1 - (size - 1 - y) / band);
    if (right && size - 1 - x < band) f -= intensity * 0.6 * (1 - (size - 1 - x) / band);
    if (f) for (let k = 0; k < 3; k++) img[o + k] = Math.max(0, Math.min(255, Math.round(img[o + k] + f * 255)));
  }
  const ow = Math.max(1, Math.floor(size / 16));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    if (img[o + 3] < 25) continue;
    if ((top && y < ow) || (bottom && y >= size - ow) || (left && x < ow) || (right && x >= size - ow)) {
      for (let k = 0; k < 3; k++) img[o + k] = Math.round(img[o + k] * 0.6);
    }
  }
  const radius = Math.max(1, Math.floor(size / 10));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const clear = (top && left && x + y < radius) || (top && right && size - 1 - x + y < radius)
      || (bottom && left && x + size - 1 - y < radius) || (bottom && right && size - 1 - x + size - 1 - y < radius);
    if (clear) img.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 4);
  }
  return img;
}

/** Lay RGBA images out on one sheet, left to right, `columns` per row. */
export function packSheet(images, width, height, columns) {
  const cols = Math.max(1, Math.min(columns || images.length, images.length));
  const rows = Math.ceil(images.length / cols);
  const sheet = Buffer.alloc(cols * width * rows * height * 4);
  images.forEach((img, i) => {
    const ox = (i % cols) * width;
    const oy = Math.floor(i / cols) * height;
    for (let y = 0; y < height; y++) img.copy(sheet, ((oy + y) * cols * width + ox) * 4, y * width * 4, (y + 1) * width * 4);
  });
  return { width: cols * width, height: rows * height, data: sheet, columns: cols, rows };
}

// ------------------------------------------------------------------- store

/** Each chat keeps its own named canvases, saved beside Skadi's data. */
export class PixelStudio {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
  }

  file(sessionId) { return join(this.dir, `${String(sessionId || 'scratch').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`); }

  async canvases(sessionId) {
    const key = sessionId || 'scratch';
    if (!this.cache.has(key)) {
      const map = new Map();
      try {
        const saved = JSON.parse(await readFile(this.file(sessionId), 'utf8'));
        for (const [name, data] of Object.entries(saved.canvases || {})) map.set(name, Canvas.fromJSON(data));
      } catch { /* none yet */ }
      this.cache.set(key, map);
    }
    return this.cache.get(key);
  }

  async has(sessionId) {
    return (await this.canvases(sessionId)).size > 0;
  }

  async save(sessionId) {
    const map = await this.canvases(sessionId);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(sessionId), JSON.stringify({ canvases: Object.fromEntries([...map].map(([k, v]) => [k, v.toJSON()])) }));
  }

  async remove(sessionId) {
    this.cache.delete(sessionId || 'scratch');
    await rm(this.file(sessionId), { force: true });
  }
}

// ----------------------------------------------------------------- the ops

const num = (value, name) => {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) throw new PixelError(`"${name}" must be a number`);
  return Math.round(n);
};
const pick = (op, ...names) => {
  for (const name of names) if (op[name] !== undefined) return op[name];
  return undefined;
};
const bool = (value, fallback) => (value === undefined ? fallback : !(value === false || value === 'false' || value === 0 || value === 'outline'));

// Names other tools and other models use for the same operation.
const OP_ALIASES = {
  fill_rect: 'rect', rectangle: 'rect', box: 'rect', draw_rect: 'rect', rect_outline: 'rect',
  draw_line: 'line', draw_pixel: 'pixel', set_pixel: 'pixel', draw_pixels: 'pixels', points: 'pixels',
  fill_row: 'row', hline: 'row', fill_column: 'column', col: 'column', vline: 'column',
  draw_circle: 'circle', draw_ellipse: 'ellipse', oval: 'ellipse', draw_triangle: 'triangle',
  draw_rotated_rect: 'rotated_rect', noise_fill_rect: 'noise', noise_fill: 'noise', texture: 'noise',
  noise_fill_circle: 'noise_circle', voronoi_fill: 'voronoi', cells: 'voronoi', flood_fill: 'fill', bucket: 'fill',
  dither: 'gradient', sky: 'gradient', clear_rect: 'clear', erase: 'clear', move: 'shift', copy: 'stamp', paste: 'stamp',
  write: 'text', label: 'text', symmetry: 'mirror', flip: 'mirror', recolor: 'replace', swap: 'replace', lighting: 'shade',
};
export const OPS = ['rect', 'line', 'pixel', 'pixels', 'row', 'column', 'circle', 'ellipse', 'triangle', 'rotated_rect',
  'noise', 'noise_circle', 'voronoi', 'gradient', 'fill', 'outline', 'shade', 'mirror', 'replace', 'shift', 'clear', 'stamp', 'text'];

/** Apply one drawing operation. Returns a one-line description of what changed. */
export function applyOp(canvas, rawOp, lookup = () => null) {
  const op = rawOp && typeof rawOp === 'object' ? rawOp : {};
  const name = String(op.op ?? op.type ?? op.tool ?? op.action ?? '').trim().toLowerCase();
  const kind = OP_ALIASES[name] || name;
  const color = (key = 'color') => canvas.color(pick(op, key, key === 'color' ? 'colour' : key, key === 'color' ? 'c' : key));
  const colors = () => {
    const list = pick(op, 'colors', 'colours', 'palette');
    if (!Array.isArray(list) || !list.length) throw new PixelError(`"${kind}" needs "colors": a list of palette indices, e.g. [3,4,5]`);
    return list.map((c) => canvas.color(c));
  };
  const box = () => [
    num(pick(op, 'x1', 'x', 'left'), 'x1'), num(pick(op, 'y1', 'y', 'top'), 'y1'),
    num(pick(op, 'x2', 'right') ?? (op.w !== undefined || op.width !== undefined ? num(op.x1 ?? op.x, 'x') + num(pick(op, 'w', 'width'), 'width') - 1 : undefined), 'x2'),
    num(pick(op, 'y2', 'bottom') ?? (op.h !== undefined || op.height !== undefined ? num(op.y1 ?? op.y, 'y') + num(pick(op, 'h', 'height'), 'height') - 1 : undefined), 'y2'),
  ];
  const optionalBox = () => (pick(op, 'x1', 'x') === undefined ? null : box());
  const seed = () => Math.trunc(Number(op.seed ?? 42)) || 42;

  switch (kind) {
    case 'rect': {
      const [x1, y1, x2, y2] = box();
      const n = canvas.rect(x1, y1, x2, y2, color(), bool(op.fill, name !== 'rect_outline'));
      return `rect (${x1},${y1})-(${x2},${y2}): ${n}px`;
    }
    case 'line': {
      const n = canvas.line(num(op.x1, 'x1'), num(op.y1, 'y1'), num(op.x2, 'x2'), num(op.y2, 'y2'), color());
      return `line (${op.x1},${op.y1})-(${op.x2},${op.y2}): ${n}px`;
    }
    case 'pixel': return `pixel (${op.x},${op.y}): ${canvas.set(num(op.x, 'x'), num(op.y, 'y'), color())}px`;
    case 'pixels': {
      const list = pick(op, 'pixels', 'points', 'list');
      if (!Array.isArray(list)) throw new PixelError('"pixels" needs "pixels": a list like [[x,y],[x,y]] or [{"x":1,"y":2,"color":3}]');
      const base = pick(op, 'color', 'colour', 'c');
      let n = 0;
      for (const p of list) {
        const [x, y, c] = Array.isArray(p) ? p : [p?.x ?? p?.X, p?.y ?? p?.Y, p?.color ?? p?.colour ?? p?.c];
        n += canvas.set(num(x, 'x'), num(y, 'y'), canvas.color(c ?? base));
      }
      return `pixels: ${n}px`;
    }
    case 'row': {
      const y = num(op.y, 'y');
      const n = canvas.rect(num(pick(op, 'x1', 'x_start', 'from'), 'x1'), y, num(pick(op, 'x2', 'x_end', 'to'), 'x2'), y, color());
      return `row y=${y}: ${n}px`;
    }
    case 'column': {
      const x = num(op.x, 'x');
      const n = canvas.rect(x, num(pick(op, 'y1', 'y_start', 'from'), 'y1'), x, num(pick(op, 'y2', 'y_end', 'to'), 'y2'), color());
      return `column x=${x}: ${n}px`;
    }
    case 'circle': {
      const r = num(pick(op, 'r', 'radius'), 'r');
      const n = canvas.ellipse(num(pick(op, 'cx', 'x'), 'cx'), num(pick(op, 'cy', 'y'), 'cy'), r, r, color(), bool(op.fill, true));
      return `circle r=${r}: ${n}px`;
    }
    case 'ellipse': {
      const n = canvas.ellipse(num(pick(op, 'cx', 'x'), 'cx'), num(pick(op, 'cy', 'y'), 'cy'), num(pick(op, 'rx', 'radius_x'), 'rx'), num(pick(op, 'ry', 'radius_y'), 'ry'), color(), bool(op.fill, true));
      return `ellipse: ${n}px`;
    }
    case 'triangle': {
      const n = canvas.triangle(num(op.x1, 'x1'), num(op.y1, 'y1'), num(op.x2, 'x2'), num(op.y2, 'y2'), num(op.x3, 'x3'), num(op.y3, 'y3'), color());
      return `triangle: ${n}px`;
    }
    case 'rotated_rect': {
      const n = canvas.rotatedRect(num(pick(op, 'cx', 'x'), 'cx'), num(pick(op, 'cy', 'y'), 'cy'), num(pick(op, 'width', 'w'), 'width'), num(pick(op, 'height', 'h'), 'height'), Number(op.angle) || 0, color());
      return `rotated rect: ${n}px`;
    }
    case 'noise': {
      const [x1, y1, x2, y2] = optionalBox() || [0, 0, canvas.w - 1, canvas.h - 1];
      const density = Math.max(0.01, Math.min(1, Number(op.density ?? 1)));
      // With "on", only pixels already that colour are textured: speckle a
      // shape without spilling onto its surroundings.
      const on = op.on !== undefined ? canvas.color(op.on) : null;
      const n = canvas.noiseRect(x1, y1, x2, y2, colors(), seed(), density, on === null ? null : (x, y) => canvas.get(x, y) === on);
      return `noise (${x1},${y1})-(${x2},${y2}): ${n}px`;
    }
    case 'noise_circle': {
      const cx = num(pick(op, 'cx', 'x'), 'cx'); const cy = num(pick(op, 'cy', 'y'), 'cy'); const r = num(pick(op, 'r', 'radius'), 'r');
      const n = canvas.noiseRect(cx - r, cy - r, cx + r, cy + r, colors(), seed(), Math.max(0.01, Math.min(1, Number(op.density ?? 1))), (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
      return `noise circle r=${r}: ${n}px`;
    }
    case 'voronoi': {
      const [x1, y1, x2, y2] = optionalBox() || [0, 0, canvas.w - 1, canvas.h - 1];
      return `voronoi: ${canvas.voronoi(x1, y1, x2, y2, colors(), Math.max(1, Math.min(200, Number(pick(op, 'cells', 'num_cells', 'count')) || 8)), seed())}px`;
    }
    case 'gradient': {
      const [x1, y1, x2, y2] = optionalBox() || [0, 0, canvas.w - 1, canvas.h - 1];
      return `gradient ${op.direction || 'vertical'}: ${canvas.gradient(x1, y1, x2, y2, colors(), String(op.direction || 'vertical'))}px`;
    }
    case 'fill': return `flood fill: ${canvas.floodFill(num(op.x, 'x'), num(op.y, 'y'), color())}px`;
    case 'outline': {
      const only = pick(op, 'around', 'target') !== undefined ? canvas.color(pick(op, 'around', 'target')) : null;
      return `outline: ${canvas.outline(color(), { corners: bool(op.corners, false), only })}px`;
    }
    case 'shade': {
      const target = canvas.color(pick(op, 'target', 'color', 'on'));
      const hi = pick(op, 'highlight', 'light') !== undefined ? canvas.color(pick(op, 'highlight', 'light')) : null;
      const lo = pick(op, 'shadow', 'dark') !== undefined ? canvas.color(pick(op, 'shadow', 'dark')) : null;
      if (hi === null && lo === null) throw new PixelError('"shade" needs "highlight" and/or "shadow" colours');
      // Limit it to one shape (a point inside it) or a box; otherwise every
      // pixel of that colour is shaded, sky included.
      let within = null;
      if (op.x1 !== undefined) {
        const [x1, y1, x2, y2] = box();
        within = (x, y) => x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
      } else if (op.x !== undefined && op.y !== undefined) {
        within = canvas.region(num(op.x, 'x'), num(op.y, 'y'));
      }
      return `shade colour ${target}${within ? ' (one area)' : ''}: ${canvas.shade(target, hi, lo, Math.max(1, Math.min(4, Number(op.width) || 1)), within)}px`;
    }
    case 'mirror': return `mirror: ${canvas.mirror(String(op.axis || 'x'), String(op.from || (/^y|^v/i.test(op.axis || '') ? 'top' : 'left')))}px`;
    case 'replace': {
      const from = canvas.color(pick(op, 'from', 'old'));
      const to = canvas.color(pick(op, 'to', 'new'));
      return `replace ${from}→${to}: ${canvas.replace(from, to, optionalBox())}px`;
    }
    case 'shift': {
      const dx = Math.round(Number(op.dx) || 0);
      const dy = Math.round(Number(op.dy) || 0);
      canvas.shift(dx, dy);
      return `shift by (${dx},${dy})`;
    }
    case 'clear': {
      const [x1, y1, x2, y2] = optionalBox() || [0, 0, canvas.w - 1, canvas.h - 1];
      return `clear: ${canvas.rect(x1, y1, x2, y2, -1)}px`;
    }
    case 'stamp': {
      const source = lookup(String(pick(op, 'from', 'source', 'name') || ''));
      if (!source) throw new PixelError('"stamp" needs "from": the name of another canvas in this chat');
      return `stamp ${op.from}: ${canvas.stamp(source, num(op.x ?? 0, 'x'), num(op.y ?? 0, 'y'), { flip: bool(op.flip, false) })}px`;
    }
    case 'text': {
      const value = String(pick(op, 'text', 'value', 'string') ?? '');
      if (!value) throw new PixelError('"text" needs "text"');
      return `text "${value}": ${canvas.text(num(op.x ?? 0, 'x'), num(op.y ?? 0, 'y'), value, color(), Math.max(1, Math.min(8, Number(op.scale) || 1)))}px`;
    }
    default:
      throw new PixelError(`unknown op "${name || '(missing)'}". Use one of: ${OPS.join(', ')}`);
  }
}

// ---------------------------------------------------------------- snippets

/** Copy-paste code for using an exported image where it is going. */
export function usageSnippets({ path, width, height, scale, frames = 1, frameWidth = width, columns = frames }) {
  const displayW = frameWidth * scale;
  const displayH = height * scale;
  const lines = [
    'HTML (keep pixels sharp, never blur):',
    `  <img src="${path}" width="${displayW}" height="${displayH}" alt="" style="image-rendering: pixelated;">`,
    'CSS:',
    `  .sprite { width: ${displayW}px; height: ${displayH}px; background: url("${path}") 0 0 / ${frames > 1 ? columns * displayW : displayW}px auto no-repeat; image-rendering: pixelated; }`,
    'Canvas game (JavaScript):',
    `  const img = new Image(); img.src = "${path}";`,
    '  ctx.imageSmoothingEnabled = false; // draw at whole-number scales only',
    frames > 1
      ? `  ctx.drawImage(img, frame * ${frameWidth}, 0, ${frameWidth}, ${height}, x, y, ${displayW}, ${displayH});`
      : `  ctx.drawImage(img, x, y, ${displayW}, ${displayH});`,
  ];
  if (frames > 1 && columns === frames) {
    lines.push('CSS animation of the frames:',
      `  .sprite { animation: play 0.6s steps(${frames}) infinite; }`,
      `  @keyframes play { to { background-position: -${frames * displayW}px 0; } }`);
  }
  return lines.join('\n');
}

export async function writeBinary(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const existed = existsSync(file);
  await writeFile(file, data);
  return existed;
}
