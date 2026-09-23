// Desktop control: key chords, coordinates, UI Automation elements and
// browser accessibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseChord, DesktopHelper, withAccessibility } from '../src/desktop.mjs';
import { releaseFiles } from '../src/release.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('key chords map to virtual-key codes', () => {
  assert.deepEqual(parseChord('ctrl+c'), [0x11, 0x43]);
  assert.deepEqual(parseChord('Win + R'), [0x5b, 0x52]);
  assert.deepEqual(parseChord('alt+f4'), [0x12, 0x73]);
  assert.deepEqual(parseChord('enter'), [0x0d]);
  assert.throws(() => parseChord('hyper+x'), /unknown key "hyper"/);
  assert.throws(() => parseChord(''), /keys is required/);
});

test('screenshot pixels map back to screen pixels on the right monitor', () => {
  const helper = new DesktopHelper();
  assert.deepEqual(helper.toScreen(10, 20), { x: 10, y: 20 });
  helper.view = { left: 2560, top: 0, scale: 0.5, monitor: 1 };
  assert.deepEqual(helper.toScreen(100, 50), { x: 2760, y: 100 });
  assert.throws(() => helper.toScreen('a', 1), /x and y/);
});

test('an element number refers to the list the model was shown', async () => {
  const helper = new DesktopHelper();
  helper.elements = [{ name: 'Search', type: 'Edit', x: 5, y: 6, title: '' }];
  assert.equal((await helper.resolveElement('1')).name, 'Search');
  await assert.rejects(helper.resolveElement('2'), /no element 2/);
  await assert.rejects(helper.resolveElement(' '), /say which element/);
});

test('browsers Skadi starts expose their pages to UI Automation', () => {
  assert.equal(withAccessibility('chrome', 'https://youtube.com'), '--force-renderer-accessibility https://youtube.com');
  assert.equal(withAccessibility('msedge.exe', ''), '--force-renderer-accessibility');
  assert.equal(withAccessibility('notepad', 'a.txt'), 'a.txt');
  assert.equal(withAccessibility('chrome', '--force-renderer-accessibility x'), '--force-renderer-accessibility x');
});

test('a release carries the helpers the Node code launches', async () => {
  const files = await releaseFiles(ROOT);
  for (const f of ['src/desktop.ps1', 'src/desktop.mjs']) assert.ok(files.includes(f), f);
});
