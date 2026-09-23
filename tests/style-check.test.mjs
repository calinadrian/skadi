import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classesAdded, classStyling, styleWarning } from '../src/style-check.mjs';
import { unverifiedFix } from '../src/mission.mjs';

test('finds classes an edit starts toggling', () => {
  assert.deepEqual(classesAdded('a.classList.add("x")', 'a.classList.add("x"); b.classList.add("hidden", \'on\')'), ['hidden', 'on']);
  assert.deepEqual(classesAdded('', 'el.classList.toggle(`open`, flag)'), ['open']);
  assert.deepEqual(classesAdded('', 'el.classList.contains("x")'), []);
});

test('tells a class styled on its own from one only styled joined to another', () => {
  assert.equal(classStyling('.overlay.hidden { display: none; }', 'hidden'), 'compound');
  assert.equal(classStyling('.hidden { display: none; }', 'hidden'), 'alone');
  assert.equal(classStyling('main .card, .hidden:not(.x) { display: none; }', 'hidden'), 'alone');
  assert.equal(classStyling('.hidden-thing { color: red }', 'hidden'), 'none');
  assert.equal(classStyling('/* .hidden */ .a { color: red }', 'hidden'), 'none');
});

test('warns when an edit toggles a class that only a compound selector styles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-style-'));
  try {
    await writeFile(join(dir, 'game.css'), '.overlay.hidden { display: none; }\n.open { color: red }\n');
    const warn = await styleWarning(dir, 'game.js', 'x();', 'x(); btn.classList.add("hidden");');
    assert.match(warn, /"hidden"/);
    assert.equal(await styleWarning(dir, 'game.js', '', 'btn.classList.add("open");'), '');
    assert.equal(await styleWarning(dir, 'notes.md', '', 'btn.classList.add("hidden");'), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const call = (name) => ({ role: 'assistant', tool_calls: [{ id: name, function: { name, arguments: '{}' } }] });

test('a fix is only accepted after a check that follows the last edit', () => {
  assert.match(unverifiedFix([call('read_file')]), /no file/);
  assert.match(unverifiedFix([call('edit_file'), call('browser_open'), call('browser_console')]), /after the last edit/);
  assert.match(unverifiedFix([call('run_command'), call('edit_file')]), /after the last edit/);
  assert.equal(unverifiedFix([call('edit_file'), call('browser_eval')]), '');
  assert.equal(unverifiedFix([call('write_file'), call('run_command')]), '');
});
