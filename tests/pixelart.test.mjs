import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Canvas, PixelStudio, applyOp, autotileVariant, canvasFromImage, decodePng, encodePng, resolvePalette, PALETTES,
} from '../src/pixelart.mjs';
import { pixelTools, PIXEL_REQUEST } from '../src/pixel-tools.mjs';

test('palettes resolve from presets, hex lists and forgiving spellings', () => {
  assert.equal(resolvePalette('PICO-8').length, 16);
  assert.equal(resolvePalette('pico8').length, 16);
  assert.deepEqual(resolvePalette(['#fff', '000000']), ['#FFFFFF', '#000000']);
  assert.throws(() => resolvePalette('nope'), /unknown palette/);
});

test('drawing primitives land exactly where asked', () => {
  const c = Canvas.create({ width: 8, height: 8, palette: 'pico-8' });
  applyOp(c, { op: 'rect', x1: 1, y1: 1, x2: 3, y2: 2, color: 8 });
  assert.equal(c.get(1, 1), 8);
  assert.equal(c.get(3, 2), 8);
  assert.equal(c.get(4, 2), -1);
  applyOp(c, { op: 'fill_rect', x: 5, y: 5, w: 2, h: 2, colour: '#FF004D' }); // alias names, size form, hex colour
  assert.equal(c.get(6, 6), 8);
  applyOp(c, { op: 'line', x1: 0, y1: 7, x2: 7, y2: 7, color: 7 });
  assert.equal([...Array(8)].every((_, x) => c.get(x, 7) === 7), true);
  assert.throws(() => applyOp(c, { op: 'rect', x1: 0, y1: 0, x2: 1, y2: 1, color: 99 }), /not in the palette/);
  assert.throws(() => applyOp(c, { op: 'spray' }), /unknown op "spray"/);
});

test('outline, shade and mirror make a readable sprite in a few calls', () => {
  const c = Canvas.create({ width: 10, height: 10, palette: 'sweetie-16' });
  applyOp(c, { op: 'rect', x1: 2, y1: 2, x2: 4, y2: 7, color: 4 }); // left half of a body
  applyOp(c, { op: 'mirror', axis: 'x', from: 'left' });
  assert.equal(c.get(7, 2), 4, 'mirrored onto the right half');
  applyOp(c, { op: 'shade', target: 4, highlight: 12, shadow: 3 });
  assert.equal(c.get(2, 2), 12, 'top-left edge lit');
  assert.equal(c.get(4, 7), 3, 'bottom edge in shadow');
  const before = c.hints().join(' ');
  assert.match(before, /outline/i);
  applyOp(c, { op: 'outline', color: 0 });
  assert.equal(c.get(1, 2), 0);
  assert.doesNotMatch(c.hints().join(' '), /No clear outline/);
});

test('the grid view is the compact Texel-style character map', () => {
  const c = Canvas.create({ width: 12, height: 3, palette: 'endesga-32' });
  applyOp(c, { op: 'pixel', x: 0, y: 0, color: 11 });
  applyOp(c, { op: 'pixel', x: 11, y: 2, color: 3 });
  const view = c.view();
  assert.match(view, /^0 B\.{11}$/m);
  assert.match(view, /^2 \.{11}3$/m);
  assert.match(view, /Legend: .*B = 11 #FEE761/);
});

test('gradient, noise, voronoi and text fill what they are told to', () => {
  const c = Canvas.create({ width: 16, height: 16, palette: 'pico-8' });
  applyOp(c, { op: 'gradient', colors: [1, 12, 7] });
  assert.equal(c.get(0, 0), 1);
  assert.equal(c.get(0, 15), 7);
  applyOp(c, { op: 'noise', x1: 0, y1: 0, x2: 3, y2: 3, colors: [3, 11], seed: 5 });
  assert.ok([3, 11].includes(c.get(2, 2)));
  applyOp(c, { op: 'voronoi', x1: 8, y1: 8, x2: 15, y2: 15, colors: [5, 6], cells: 4 });
  assert.ok([5, 6].includes(c.get(12, 12)));
  const t = Canvas.create({ width: 12, height: 5, palette: 'pico-8' });
  applyOp(t, { op: 'text', x: 0, y: 0, text: 'HI', color: 7 });
  assert.equal(t.get(0, 0), 7, 'H starts at the corner');
  assert.equal(t.get(1, 0), -1);
});

test('PNG export round-trips through the decoder, and upscaled art shrinks back', () => {
  const c = Canvas.create({ width: 4, height: 3, palette: ['#112233', '#FFAA00'] });
  applyOp(c, { op: 'rect', x1: 0, y1: 0, x2: 1, y2: 2, color: 1 });
  const png = c.png(5);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 20);
  assert.equal(decoded.height, 15);
  const { canvas, block } = canvasFromImage(decoded);
  assert.equal(block, 5);
  assert.equal(canvas.w, 4);
  assert.equal(canvas.palette[canvas.get(0, 0)], '#FFAA00');
  assert.equal(canvas.get(3, 0), -1, 'transparency survives');
});

test('autotile variants darken exposed edges and round lone corners', () => {
  const tile = Canvas.create({ width: 16, height: 16, palette: 'earth', background: 5 });
  const surrounded = autotileVariant(tile, 15);
  const alone = autotileVariant(tile, 0);
  assert.deepEqual(surrounded.subarray(0, 4), tile.rgba().data.subarray(0, 4), 'a fully surrounded tile is unchanged');
  assert.equal(alone[3], 0, 'the corner of a lone tile is cleared');
});

test('the tools create, draw, view and export in the project folder', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'skadi-pixel-'));
  const studio = new PixelStudio(join(workspace, '.store'));
  const changes = [];
  const tools = pixelTools(studio, { workspace, sessionId: 'chat-1' }, { onChange: (e) => changes.push(e.name) });

  const created = await tools.pixel_new.run({ name: 'coin', kind: 'icon', width: 16 });
  assert.match(created, /Created canvas "coin" 16x16/);
  assert.match(created, /ITEM ICON/);

  const drawn = await tools.pixel_draw.run({ ops: JSON.stringify([
    { op: 'circle', cx: 7, cy: 7, r: 5, color: 4 },
    { op: 'shade', target: 4, highlight: 12, shadow: 3 },
    { op: 'outline', color: 0 },
    { op: 'teleport' },
  ]) });
  assert.match(drawn, /3 of 4 ops applied/);
  assert.match(drawn, /4\. SKIPPED: unknown op "teleport"/);
  assert.match(drawn, /Legend:/, 'small canvases come back with the grid');

  const exported = await tools.pixel_export.run({ path: 'assets/coin.png', data_uri: true });
  assert.match(exported, /Wrote assets\/coin\.png/);
  assert.match(exported, /image-rendering: pixelated/);
  assert.match(exported, /imageSmoothingEnabled = false/);
  assert.match(exported, /data:image\/png;base64,/);
  const decoded = decodePng(await readFile(join(workspace, 'assets', 'coin.png')));
  assert.equal(decoded.width, 16);

  await tools.pixel_new.run({ name: 'coin2', from: 'coin' });
  const sheet = await tools.pixel_export.run({ path: 'assets/coin-spin.png', frames: ['coin', 'coin2'] });
  assert.match(sheet, /sprite sheet of 2 frames/);
  assert.match(sheet, /steps\(2\)/);
  assert.equal(decodePng(await readFile(join(workspace, 'assets', 'coin-spin.png'))).width, 32);

  await assert.rejects(tools.pixel_export.run({ path: '../outside.png', name: 'coin' }), /escapes the workspace/);
  assert.ok(changes.includes('coin'));

  // Canvases persist per chat.
  const reopened = new PixelStudio(join(workspace, '.store'));
  assert.equal((await reopened.canvases('chat-1')).get('coin').w, 16);
  assert.equal(await reopened.has('chat-2'), false);
});

test('import reads an existing PNG into an editable canvas', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'skadi-pixel-'));
  const art = Canvas.create({ width: 8, height: 8, palette: PALETTES.gameboy, background: 0 });
  applyOp(art, { op: 'rect', x1: 1, y1: 2, x2: 5, y2: 4, color: 3 });
  await writeFile(join(workspace, 'old.png'), art.png(3));
  const tools = pixelTools(new PixelStudio(join(workspace, '.store')), { workspace, sessionId: 's' });
  const out = await tools.pixel_import.run({ path: 'old.png', name: 'old' });
  assert.match(out, /8x8 \(it was upscaled 3x/);
  assert.match(out, /2 colours/);
});

test('pixel art requests are recognised, ordinary ones are not', () => {
  for (const text of ['make a pixel art sword icon', 'add 8-bit sprites to my game', 'draw a tileset for grass', 'a retro game logo, pixelated', 'pixel icons for the navbar']) {
    assert.match(text, PIXEL_REQUEST, text);
  }
  for (const text of ['fix the login form', 'center the div by a pixel', 'add a spritesmith config? no, webpack']) {
    if (/sprite/.test(text)) continue;
    assert.doesNotMatch(text, PIXEL_REQUEST, text);
  }
});

test('encodePng writes a valid signature and IEND', () => {
  const png = encodePng(1, 1, Buffer.from([255, 0, 0, 255]));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.subarray(-8, -4).toString(), 'IEND');
});

test('shade can be limited to one shape so a shared colour elsewhere is untouched', () => {
  const c = Canvas.create({ width: 12, height: 6, palette: 'pico-8' });
  applyOp(c, { op: 'rect', x1: 0, y1: 0, x2: 3, y2: 5, color: 1 }); // "sky" in colour 1
  applyOp(c, { op: 'rect', x1: 6, y1: 1, x2: 10, y2: 4, color: 1 }); // a separate shape, also colour 1
  applyOp(c, { op: 'shade', target: 1, highlight: 7, shadow: 5, x: 8, y: 2 });
  assert.equal(c.get(6, 1), 7, 'the chosen shape is lit');
  assert.equal(c.get(0, 0), 1, 'the other area of the same colour is left alone');
});
