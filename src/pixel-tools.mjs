// The agent's pixel art tools. Five calls cover the whole job: make a canvas,
// draw on it (many operations per call, since every round costs a local model
// seconds), look at it, export it, or import an existing PNG to edit.
//
// They are offered only on turns that are about pixel art (see
// PIXEL_REQUEST), so every other chat keeps a smaller tool list.
import { readFile } from 'node:fs/promises';
import {
  Canvas, KINDS, OPS, PALETTES, PixelError, applyOp, autotileVariant, canvasFromImage, decodePng,
  encodePng, packSheet, resolvePalette, usageSnippets, writeBinary, DEFAULT_PALETTE,
} from './pixelart.mjs';
import { safePath, ToolError } from './tools.mjs';

/** Requests that are about pixel art, sprites, tiles or retro game graphics. */
export const PIXEL_REQUEST = /\b(pixel[\s-]?art|pixelart|pixel[\s-]?(?:icons?|sprites?|characters?|fonts?|style|graphics?|tiles?|avatars?|logos?|portraits?)|sprites?(?:heets?)?|8[\s-]?bit|16[\s-]?bit|tile[\s-]?(?:sets?|maps?)|retro[\s-](?:game|style|look|graphics|art)|pixelated)\b/i;

const NAME = /^[a-zA-Z0-9_-]{1,40}$/;

const fail = (err) => {
  if (err instanceof PixelError) throw new ToolError(err.message);
  throw err;
};

export function pixelTools(studio, ctx, { onChange = () => {} } = {}) {
  const sessionId = () => ctx.sessionId ?? null;
  const all = () => studio.canvases(sessionId());
  // The canvas last created or drawn on, per chat: a call that forgets the
  // name means that one.
  const recent = new Map();

  /** The canvas a call means: the named one, else the one last worked on. */
  async function target(name) {
    const map = await all();
    if (name) {
      const canvas = map.get(String(name));
      if (!canvas) throw new ToolError(`no canvas named "${name}". ${map.size ? `Canvases: ${[...map.keys()].join(', ')}` : 'Create one with pixel_new first'}.`);
      recent.set(sessionId(), String(name));
      return [String(name), canvas];
    }
    const last = recent.get(sessionId());
    if (last && map.has(last)) return [last, map.get(last)];
    if (map.size) return [...map.entries()].at(-1);
    throw new ToolError('there is no canvas yet; create one with pixel_new');
  }

  const legendLine = (canvas) => canvas.palette.map((hex, i) => `${i < 10 ? i : String.fromCharCode(55 + i)}=${i} ${hex}`).join(', ');

  return {
    pixel_new: {
      schema: {
        description: 'Start a pixel art canvas (or copy one as a new animation frame with "from"). Returns the palette with index numbers. Then draw with pixel_draw.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short id, e.g. "hero", "coin", "grass_tile".' },
            kind: { type: 'string', enum: Object.keys(KINDS), description: 'What it is for; sets a sensible size and composition rules.' },
            width: { type: 'integer', description: 'Pixels. 16 or 32 for icons and tiles, 32-48 for characters, up to 256.' },
            height: { type: 'integer' },
            palette: { description: `Preset name (${Object.keys(PALETTES).join(', ')}) or a list of up to 36 hex colours. Default ${DEFAULT_PALETTE}.` },
            background: { description: 'Starting colour index, or -1 for transparent (default).' },
            from: { type: 'string', description: 'Copy this existing canvas (for the next animation frame or a variant).' },
          },
          required: ['name'],
        },
      },
      async run(args) {
        try {
          const name = String(args.name || '').trim();
          if (!NAME.test(name)) throw new ToolError('name must be 1-40 letters, digits, "_" or "-"');
          const map = await all();
          const kind = KINDS[String(args.kind || '').toLowerCase()] ? String(args.kind).toLowerCase() : 'freeform';
          let canvas;
          if (args.from) {
            const [, source] = await target(args.from);
            canvas = source.clone();
          } else {
            const [dw, dh] = KINDS[kind].size;
            canvas = Canvas.create({
              width: args.width ?? dw,
              height: args.height ?? (args.width ?? dh),
              palette: args.palette,
              background: args.background ?? (kind === 'tile' || kind === 'scene' ? 0 : -1),
            });
          }
          const existed = map.has(name);
          map.set(name, canvas);
          recent.set(sessionId(), name);
          await studio.save(sessionId());
          onChange({ sessionId: sessionId(), name, canvas });
          return [
            `${existed ? 'Replaced' : 'Created'} canvas "${name}" ${canvas.w}x${canvas.h}${args.from ? ` as a copy of "${args.from}"` : ''}.`,
            `Palette (use the index as "color", -1 = transparent): ${legendLine(canvas)}`,
            `Rules: ${KINDS[kind].hint}`,
            'Next: one pixel_draw call with several ops, biggest shapes first. Then pixel_view to check, fix, and pixel_export.',
          ].join('\n');
        } catch (err) { return fail(err); }
      },
    },

    pixel_draw: {
      schema: {
        description: 'Draw on a canvas. Pass many operations at once in "ops"; they run in order. Returns a short report and, for small canvases, the updated grid.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Canvas name (optional when there is only one).' },
            ops: {
              type: 'array',
              description: [
                'Operations, each an object with "op" and its fields. color = palette index (or hex), -1 = transparent.',
                'rect {x1,y1,x2,y2,color,fill}; line {x1,y1,x2,y2,color}; pixel {x,y,color}; pixels {pixels:[[x,y],...],color};',
                'circle {cx,cy,r,color,fill}; ellipse {cx,cy,rx,ry,color,fill}; triangle {x1,y1,x2,y2,x3,y3,color}; rotated_rect {cx,cy,width,height,angle,color};',
                'fill {x,y,color} (bucket); gradient {x1,y1,x2,y2,colors:[top..bottom],direction} (dithered sky/background);',
                'noise {x1,y1,x2,y2,colors,density,on,seed} (texture; density 0.1-0.3 speckles, "on" limits it to one colour); noise_circle {cx,cy,r,colors}; voronoi {x1,y1,x2,y2,colors,cells} (stones);',
                'outline {color} (1px outline around everything drawn); shade {target,highlight,shadow,x,y} (light top-left, shadow bottom-right; x,y = a point inside the one shape to shade, else every pixel of that colour);',
                'mirror {axis:"x",from:"left"} (symmetry); replace {from,to}; shift {dx,dy}; clear {x1,y1,x2,y2}; stamp {from,x,y,flip}; text {x,y,text,color,scale} (3x5 font).',
              ].join(' '),
              items: { type: 'object' },
            },
            view: { type: 'boolean', description: 'Include the grid afterwards (default true up to 32x32).' },
          },
          required: ['ops'],
        },
      },
      async run(args) {
        try {
          const [name, canvas] = await target(args.name);
          const map = await all();
          // Small models send the list as a JSON string, or a single op with
          // no list at all; both still count.
          let list = args.ops;
          if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
          if (list && !Array.isArray(list) && typeof list === 'object') list = [list];
          const ops = Array.isArray(list) ? list : args.op ? [args] : [];
          if (!ops.length) throw new ToolError('pass "ops": a list of operations, e.g. [{"op":"rect","x1":2,"y1":2,"x2":13,"y2":13,"color":3}]');
          const lines = [];
          let failed = 0;
          ops.slice(0, 200).forEach((op, i) => {
            try {
              lines.push(`${i + 1}. ${applyOp(canvas, op, (other) => map.get(other) || null)}`);
            } catch (err) {
              if (!(err instanceof PixelError)) throw err;
              failed++;
              lines.push(`${i + 1}. SKIPPED: ${err.message}`);
            }
          });
          await studio.save(sessionId());
          onChange({ sessionId: sessionId(), name, canvas });
          const showGrid = args.view !== false && canvas.w <= 32 && canvas.h <= 32;
          return [
            `Drew on "${name}" (${ops.length - failed} of ${ops.length} ops applied${ops.length > 200 ? '; only the first 200 run per call' : ''}):`,
            ...lines,
            failed ? 'Fix the skipped ops and send only those again.' : '',
            showGrid ? `\n${canvas.view()}` : 'Call pixel_view to look at the result.',
          ].filter(Boolean).join('\n');
        } catch (err) { return fail(err); }
      },
    },

    pixel_view: {
      schema: {
        description: 'Look at a canvas: a character grid (0-9 then A-Z are palette indices, "." is transparent), the colours used, and suggestions. With no name and several canvases, lists them.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
          },
        },
      },
      async run(args) {
        try {
          const map = await all();
          if (!args.name && map.size > 1) {
            return `Canvases in this chat:\n${[...map].map(([n, c]) => `- ${n}: ${c.w}x${c.h}, ${c.palette.length} colours`).join('\n')}\nPass a name to see one.`;
          }
          const [name, canvas] = await target(args.name);
          onChange({ sessionId: sessionId(), name, canvas, looked: true });
          return `"${name}": ${canvas.view(args)}`;
        } catch (err) { return fail(err); }
      },
    },

    pixel_export: {
      mutates: true,
      schema: {
        description: 'Save a canvas as a PNG in the project, and get the HTML/CSS/canvas code to use it. "frames" makes an animation sprite sheet; "tileset" makes the 16 autotile variants of a tile.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Canvas to export.' },
            path: { type: 'string', description: 'Where to write it, e.g. "assets/hero.png".' },
            scale: { type: 'integer', description: 'Whole-number upscale, 1-16. Default 1: keep the file tiny and scale it with CSS or canvas.' },
            frames: { type: 'array', items: { type: 'string' }, description: 'Canvas names in order, all the same size, packed into one sprite sheet.' },
            columns: { type: 'integer', description: 'Frames per row in the sheet (default: all in one row).' },
            tileset: { type: 'boolean', description: 'Export the 16 autotile edge variants of a tile in a 4x4 sheet.' },
            data_uri: { type: 'boolean', description: 'Also return a data: URI to paste into a single-file HTML page.' },
          },
          required: ['path'],
        },
      },
      async run(args) {
        try {
          const rel = String(args.path || '').trim().replace(/\\/g, '/');
          if (!/\.png$/i.test(rel)) throw new ToolError('path must end in .png');
          const file = safePath(ctx.workspace, rel);
          const scale = Math.max(1, Math.min(16, Math.trunc(Number(args.scale) || 1)));
          const map = await all();
          let png;
          let summary;
          let snippet;
          if (Array.isArray(args.frames) && args.frames.length) {
            const frames = args.frames.map((n) => {
              const c = map.get(String(n));
              if (!c) throw new ToolError(`no canvas named "${n}"`);
              return c;
            });
            const [{ w, h }] = frames;
            if (frames.some((c) => c.w !== w || c.h !== h)) throw new ToolError('every frame must be the same size; make frames with pixel_new {"from": ...}');
            const sheet = packSheet(frames.map((c) => c.rgba(scale).data), w * scale, h * scale, args.columns);
            png = encodePng(sheet.width, sheet.height, sheet.data);
            summary = `sprite sheet of ${frames.length} frames (${w}x${h} each, ${sheet.columns} per row)`;
            snippet = usageSnippets({ path: rel, width: w * scale, height: h * scale, scale: scale > 1 ? 1 : 4, frames: frames.length, frameWidth: w * scale, columns: sheet.columns });
          } else {
            const [name, canvas] = await target(args.name);
            if (args.tileset) {
              if (canvas.w !== canvas.h) throw new ToolError('a tileset needs a square tile');
              const tiles = Array.from({ length: 16 }, (_, mask) => autotileVariant(canvas, mask));
              const sheet = packSheet(tiles, canvas.w, canvas.h, 4);
              png = encodePng(sheet.width, sheet.height, sheet.data);
              summary = `autotile set of "${name}": 16 tiles of ${canvas.w}x${canvas.h} in a 4x4 sheet. Tile index = top + 2*right + 4*bottom + 8*left, where each is 1 when a neighbour of the same type is on that side (index 15 = fully surrounded, 0 = alone)`;
              snippet = usageSnippets({ path: rel, width: canvas.w, height: canvas.h, scale: 4, frames: 16, frameWidth: canvas.w, columns: 4 });
            } else {
              png = canvas.png(scale);
              summary = `"${name}" at ${canvas.w * scale}x${canvas.h * scale}`;
              snippet = usageSnippets({ path: rel, width: canvas.w * scale, height: canvas.h * scale, scale: scale > 1 ? 1 : 4 });
            }
          }
          const existed = await writeBinary(file, png);
          const uri = args.data_uri
            ? png.length <= 24_000
              ? `\nData URI (${png.length} bytes):\ndata:image/png;base64,${png.toString('base64')}`
              : '\nToo large for a data URI (over 24 KB); reference the file instead.'
            : '';
          return `${existed ? 'Overwrote' : 'Wrote'} ${rel}: ${summary}, ${png.length} bytes.\n\n${snippet}${uri}`;
        } catch (err) { return fail(err); }
      },
    },

    pixel_import: {
      schema: {
        description: 'Load a PNG from the project into a canvas to view or edit it. Upscaled pixel art is shrunk back to its real pixels; colours are mapped to a palette.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            name: { type: 'string', description: 'Canvas name to create.' },
            palette: { description: 'Optional preset or hex list to map colours onto; default keeps the image\'s own colours (up to max_colors).' },
            max_colors: { type: 'integer', description: 'Default 32, at most 36.' },
          },
          required: ['path', 'name'],
        },
      },
      async run(args) {
        try {
          const name = String(args.name || '').trim();
          if (!NAME.test(name)) throw new ToolError('name must be 1-40 letters, digits, "_" or "-"');
          const file = safePath(ctx.workspace, String(args.path || ''));
          const { canvas, block } = canvasFromImage(decodePng(await readFile(file)), {
            palette: args.palette ? resolvePalette(args.palette) : null,
            maxColors: Number(args.max_colors) || 32,
          });
          (await all()).set(name, canvas);
          await studio.save(sessionId());
          onChange({ sessionId: sessionId(), name, canvas });
          return `Imported ${args.path} as "${name}": ${canvas.w}x${canvas.h}${block > 1 ? ` (it was upscaled ${block}x; shrunk back to its real pixels)` : ''}, ${canvas.palette.length} colours.\nPalette: ${legendLine(canvas)}\n${canvas.w <= 48 && canvas.h <= 48 ? canvas.view() : 'Call pixel_view to see it.'}`;
        } catch (err) {
          if (err?.code === 'ENOENT') throw new ToolError(`file not found: ${args.path}`);
          return fail(err);
        }
      },
    },
  };
}

export { OPS };
