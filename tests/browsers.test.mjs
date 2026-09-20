// One browser per chat, and it stays there.
//
// The browsers themselves are real Chromium processes, so nothing here
// launches one: what is tested is the keying, which is the part that decided
// whose browser you were looking at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/sessions.mjs';
import { Skadi } from '../src/server.mjs';

/** Enough of a Skadi to exercise the browser bookkeeping. */
function skadi() {
  const events = [];
  return {
    browsers: new Map(),
    browserClients: new Map(),
    settings: {},
    events,
    broadcast: (type, data) => events.push({ type, data }),
    browserKey: Skadi.prototype.browserKey,
    rekeyBrowser: Skadi.prototype.rekeyBrowser,
    wireBrowser: Skadi.prototype.wireBrowser,
  };
}

/** A stand-in for AgentBrowser: an emitter that can report a status. */
const fakeBrowser = (url) => Object.assign(new EventEmitter(), {
  port: 9333,
  status: () => ({ running: true, url }),
});

test('two unsent chats do not share a browser', () => {
  const s = skadi();
  // What the window sends while a chat has no id: its own draft key.
  const first = s.browserKey('draft-abc123');
  const second = s.browserKey('draft-def456');
  assert.notEqual(first, second,
    'every unsent chat browses under its own name, or the second new chat opens on the first one\'s page');
});

test('a key is sanitised without collapsing distinct chats together', () => {
  const s = skadi();
  assert.equal(s.browserKey(null), 'draft');
  assert.equal(s.browserKey(''), 'draft');
  assert.equal(s.browserKey('../../etc/passwd'), '.._.._etc_passwd');
  assert.notEqual(s.browserKey('a/b'), s.browserKey('a/c'));
});

test('sending in a draft hands that draft its own browser, not another one\'s', () => {
  const s = skadi();
  const mine = fakeBrowser('https://example.com/mine');
  const theirs = fakeBrowser('https://example.com/theirs');
  s.browsers.set('draft-mine', mine);
  s.browsers.set('draft-theirs', theirs);

  s.rekeyBrowser('draft-mine', '2026-09-17-chat');

  assert.equal(s.browsers.get('2026-09-17-chat'), mine, 'the chat keeps the page it was on');
  assert.equal(s.browsers.get('draft-theirs'), theirs, 'the other unsent chat is untouched');
  assert.equal(s.browsers.has('draft-mine'), false);
});

test('the watchers move with the browser, so the pane does not go blank', () => {
  const s = skadi();
  s.browsers.set('draft-x', fakeBrowser('https://example.com'));
  const watcher = {};
  s.browserClients.set('draft-x', new Set([watcher]));

  s.rekeyBrowser('draft-x', 'real-id');

  assert.equal(s.browserClients.has('draft-x'), false);
  assert.ok(s.browserClients.get('real-id').has(watcher));
  assert.ok(s.events.some((e) => e.type === 'browser_rekey' && e.data.to === 'real-id'),
    'the window is told which stream to follow');
});

test('a rekey onto a chat that already browses is refused', () => {
  const s = skadi();
  const draft = fakeBrowser('https://example.com/draft');
  const existing = fakeBrowser('https://example.com/existing');
  s.browsers.set('draft-x', draft);
  s.browsers.set('real-id', existing);

  s.rekeyBrowser('draft-x', 'real-id');

  assert.equal(s.browsers.get('real-id'), existing,
    'a chat that already has a browser keeps it rather than being taken over');
});

// ------------------------------------------------------------- the handover --

test('a new chat inherits the browser of the draft the window names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-browsers-'));
  try {
    const store = new SessionStore(dir);
    const handovers = [];
    const agent = {
      running: false, toolCtx: {}, on() {}, abort() {},
      async run() {},
    };
    const self = {
      sessions: store,
      turns: new Map(),
      subagents: new Map(),
      settings: {},
      config: { profiles: {}, activeProfile: 'p' },
      skills: { list: async () => [] },
      memory: { promptBlock: async () => '' },
      providerFor: () => ({ id: 'stub', kind: 'openai', label: 'Stub', managed: false, vision: false }),
      chatReady: () => true,
      modelFor: () => 'stub-model',
      makeAgent: async () => agent,
      closeBrowser: async () => {},
      broadcast: () => {},
      rekeyBrowser: (from, to) => handovers.push({ from, to }),
      chat: Skadi.prototype.chat,
      userContent: Skadi.prototype.userContent,
      appendUserMessage: Skadi.prototype.appendUserMessage,
      workingSessionIds: Skadi.prototype.workingSessionIds,
      liveSession: Skadi.prototype.liveSession,
      broadcastTurns: Skadi.prototype.broadcastTurns,
      refineTitle() {},
    };

    const session = await self.chat(null, 'hello', [], { draftKey: 'draft-mine' });

    assert.deepEqual(handovers, [{ from: 'draft-mine', to: session.id }],
      'the browser that moves is the one the window was actually looking at');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chat that already exists takes no browser from any draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-browsers-'));
  try {
    const store = new SessionStore(dir);
    const handovers = [];
    const agent = { running: false, toolCtx: {}, on() {}, abort() {}, async run() {} };
    const existing = await store.create('Already here', null);
    const self = {
      sessions: store,
      turns: new Map(),
      subagents: new Map(),
      settings: {},
      config: { profiles: {}, activeProfile: 'p' },
      skills: { list: async () => [] },
      memory: { promptBlock: async () => '' },
      providerFor: () => ({ id: 'stub', kind: 'openai', label: 'Stub', managed: false, vision: false }),
      chatReady: () => true,
      modelFor: () => 'stub-model',
      makeAgent: async () => agent,
      closeBrowser: async () => {},
      broadcast: () => {},
      rekeyBrowser: (from, to) => handovers.push({ from, to }),
      chat: Skadi.prototype.chat,
      userContent: Skadi.prototype.userContent,
      appendUserMessage: Skadi.prototype.appendUserMessage,
      workingSessionIds: Skadi.prototype.workingSessionIds,
      liveSession: Skadi.prototype.liveSession,
      broadcastTurns: Skadi.prototype.broadcastTurns,
    };

    await self.chat(existing.id, 'hello again', [], { draftKey: 'draft-mine' });

    assert.deepEqual(handovers, [], 'it has its own browser already');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
