import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topicTitle, cleanModelTitle } from '../src/titles.mjs';
import { SessionStore } from '../src/sessions.mjs';

test('a title names the topic, not the way it was asked', () => {
  assert.equal(topicTitle('are potatoes health?'), 'Are potatoes health?');
  assert.equal(topicTitle("let's improve the ui of the sidebar so it looks better"), 'Improve the ui of the sidebar');
  assert.equal(topicTitle('Hey, can you please fix the login redirect loop'), 'Fix the login redirect loop');
  assert.equal(topicTitle('How do I set up llama.cpp with CUDA on windows?'), 'Set up llama.cpp with CUDA');
});

test('a title is short, one line, and never ends on a dangling word', () => {
  const t = topicTitle('in settings, there should be a switch between light and dark themes\nand more detail below');
  assert.ok(t.length <= 52);
  assert.ok(!t.includes('\n'));
  assert.ok(!/\b(a|the|of|to|and|in|so)$/i.test(t), t);
});

test('code, links and credentials never become a title', () => {
  assert.equal(topicTitle('```js\nconst x = 1\n``` why is this failing'), 'Why is this failing');
  assert.equal(topicTitle('see https://example.com/very/long/path please summarise'), 'See please summarise');
  assert.ok(!topicTitle('use sk-abcdefghijklmnopqrstuvwxyz1234 for the api').includes('sk-abcdefghijklmnop'));
  assert.equal(topicTitle('   '), 'New session');
});

test('the model title is cleaned down to one plain line', () => {
  assert.equal(cleanModelTitle('"Potato nutrition."'), 'Potato nutrition');
  assert.equal(cleanModelTitle('Title: Sidebar redesign\nbecause reasons'), 'Sidebar redesign');
  assert.equal(cleanModelTitle('<think>hmm</think>\nDark theme switch'), 'Dark theme switch');
  assert.equal(cleanModelTitle(''), null);
  assert.equal(cleanModelTitle('a '.repeat(30)), null);
});

test('creating the same group twice gives one group', async () => {
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'skadi-groups-')));
  const a = await store.createGroup('Test', 'p1');
  const b = await store.createGroup(' test ', 'p1');
  const other = await store.createGroup('Test', 'p2');
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, other.id);
  assert.equal((await store.listGroups('p1')).length, 1);
});

test('renaming a chat by hand stops the model from renaming it later', async () => {
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'skadi-title-')));
  const s = await store.create('Topic', 'p1');
  s.titleAuto = true;
  await store.save(s);
  const renamed = await store.update(s.id, { title: 'Mine' });
  assert.equal(renamed.titleAuto, false);
});
