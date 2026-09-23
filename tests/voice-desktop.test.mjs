// Voice control (wake word, the note on spoken turns, voice samples) and
// desktop control (key chords, coordinates, browser accessibility).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterWakeWord, soundsLike } from '../src/voice.mjs';
import { parseChord, DesktopHelper, withAccessibility } from '../src/desktop.mjs';
import { voiceTurnNote } from '../src/server.mjs';
import { saveVoiceSample, voiceFor, BUILTIN_VOICES } from '../src/tts.mjs';
import { releaseFiles } from '../src/release.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('wake word strips itself and polite prefixes', () => {
  assert.equal(afterWakeWord('Skadi, open notepad', 'skadi'), 'open notepad');
  assert.equal(afterWakeWord('hey Jarvis open Spotify.', 'jarvis'), 'open Spotify.');
  assert.equal(afterWakeWord('OK computer: lock the screen', 'computer'), 'lock the screen');
});

test('the wake word survives how speech recognition spells it', () => {
  for (const heard of ['Skadi', 'Scotty', 'Skaddy', 'Scottie', 'skadi,']) assert.ok(soundsLike(heard, 'skadi'), heard);
  for (const heard of ['sky', 'Katie', 'skating', 'Jarvis']) assert.ok(!soundsLike(heard, 'skadi'), heard);
  assert.equal(afterWakeWord('Scotty, open Google Chrome', 'skadi'), 'open Google Chrome');
});

test('the bare wake word arms, anything else is ignored', () => {
  assert.equal(afterWakeWord('Skadi', 'skadi'), '');
  assert.equal(afterWakeWord('Skadi.', 'skadi'), '');
  assert.equal(afterWakeWord('open notepad', 'skadi'), null);
  assert.equal(afterWakeWord('I told Skadi', 'skadi'), null);
});

test('no wake word sends everything', () => {
  assert.equal(afterWakeWord('  open notepad ', ''), 'open notepad');
});

test('a spoken turn asks for a short answer and says whether the computer is in reach', () => {
  const on = voiceTurnNote({ computerControl: true });
  assert.match(on, /read aloud/);
  assert.match(on, /desktop_\* tools/);
  assert.match(on, /which playlist/);
  assert.match(voiceTurnNote({ computerControl: false }), /switched off/);
});

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

test('voice samples must be real WAV recordings', async () => {
  await assert.rejects(saveVoiceSample({ name: 'me.mp3', data: 'AAAA' }), /WAV/);
  await assert.rejects(saveVoiceSample({ name: 'me.wav', data: '' }), /empty/);
});

test('the engine gets a built-in voice unless a recording is set', () => {
  assert.equal(voiceFor({ voiceName: 'marius' }), 'marius');
  assert.equal(voiceFor({ voiceName: 'nobody' }), 'alba');
  assert.equal(voiceFor({ voiceName: 'jean', voiceSample: 'missing.wav' }), 'jean');
  assert.ok(BUILTIN_VOICES.includes('alba'));
});

test('a release carries the helpers the Node code launches', async () => {
  const files = await releaseFiles(ROOT);
  for (const f of ['src/desktop.ps1', 'src/voice.ps1', 'src/tts_server.py', 'src/tts.mjs']) assert.ok(files.includes(f), f);
});
