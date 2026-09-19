// The chat lifecycle: what gets written, what is read back, and what a turn is
// allowed to lose. Every test here stands for a way chats used to disappear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SessionStore, redactCredentials } from '../src/sessions.mjs';
import { Agent } from '../src/agent.mjs';

const withStore = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-chats-'));
  try {
    return await fn(new SessionStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const read = async (dir, id) => JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));

test('credential-shaped text is never exposed as a chat title', async () => {
  const secret = `sk-${'a'.repeat(32)}`;
  assert.equal(redactCredentials(`configure ${secret}`), 'configure [credential redacted]');
  await withStore(async (store) => {
    const session = await store.create(`configure ${secret}`, 'dev');
    assert.equal((await store.list('dev'))[0].title, 'configure [credential redacted]');
    await store.update(session.id, { title: `replace ${secret}` });
    assert.equal((await store.get(session.id)).title, 'replace [credential redacted]');
  });
});

// ------------------------------------------------------------- persistence --

test('overlapping saves land in order — the newest transcript is the one on disk', async () => {
  await withStore(async (store, dir) => {
    const session = await store.create('Busy turn', 'dev');
    // What a turn does: append, save, append, save, without awaiting in
    // between. The saves coalesce, but the file must end on the last one.
    const saves = [];
    for (let i = 0; i < 40; i++) {
      session.messages.push({ role: 'user', content: `m${i}` });
      saves.push(store.save(session));
    }
    await Promise.all(saves);
    assert.equal((await read(dir, session.id)).messages.length, 40);
    assert.equal(store.dirty.size, 0, 'nothing may be left pending once a save resolves');
  });
});

test('a failed write leaves no older snapshot behind to overwrite a newer one', async () => {
  await withStore(async (store, dir) => {
    const session = await store.create('Failing write', 'dev');
    session.messages.push({ role: 'user', content: 'first' });
    await store.save(session);

    // One write fails. The snapshot parked behind it used to survive in the
    // pending slot and get written *after* the next, newer one — reverting a
    // finished turn to the transcript from two messages ago.
    const real = store._writeAtomic.bind(store);
    let failures = 1;
    store._writeAtomic = async (id, data) => {
      if (failures-- > 0) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return real(id, data);
    };
    session.messages.push({ role: 'user', content: 'second' });
    const parked = store.save(session).catch(() => {});
    session.messages.push({ role: 'user', content: 'third' });
    await store.save(session).catch(() => {});
    await parked;
    store._writeAtomic = real;

    session.messages.push({ role: 'user', content: 'fourth' });
    await store.save(session);
    assert.deepEqual(
      (await read(dir, session.id)).messages.map((m) => m.content),
      ['first', 'second', 'third', 'fourth'],
    );
  });
});

// -------------------------------------------------------------- compaction --

/** A one-shot OpenAI-compatible endpoint that streams `summary` and stops. */
async function summariser(summary) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: summary } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

const compactor = (baseUrl) => new Agent({
  provider: { id: 'stub', kind: 'openai', baseUrl, apiKey: 'k' },
  model: 'stub',
  tools: {},
  schemas: [],
  settings: { compaction: { keepMessages: 2 } },
  contextTokens: 8192,
});

const transcript = () => ([
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
]);

test('compaction hands the replaced messages over before dropping them', async () => {
  const { server, baseUrl } = await summariser('a summary');
  try {
    const agent = compactor(baseUrl);
    const archived = [];
    agent.archive = (replaced) => { archived.push(...replaced); };

    const messages = transcript();
    const result = await agent.compact(messages, { manual: true });

    assert.equal(result.compacted, true);
    // What left the live transcript is exactly what was archived, in order:
    // a compacted chat still reads back whole.
    assert.deepEqual(archived.map((m) => m.content), ['first question', 'first answer']);
    // How the chat is read back: archive first, then the live transcript. The
    // summary stands where the replaced messages used to, and everything is
    // still in the order it was said.
    const display = [...archived, ...messages].filter((m) => m.role !== 'system');
    assert.equal(display.length, 5);
    assert.deepEqual(
      [display[0], display[1], display[3], display[4]].map((m) => m.content),
      ['first question', 'first answer', 'second question', 'second answer'],
    );
    assert.match(display[2].content, /^\[Compacted context/);
  } finally {
    server.close();
  }
});

test('a chat is never compacted at the cost of its history', async () => {
  const { server, baseUrl } = await summariser('a summary');
  try {
    const agent = compactor(baseUrl);
    agent.archive = () => { throw new Error('disk full'); };

    const messages = transcript();
    const before = [...messages];
    const result = await agent.compact(messages, { manual: true });

    assert.equal(result.compacted, false);
    assert.match(result.reason, /archive/);
    assert.deepEqual(messages, before);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------ reading back --

test('a compacted chat reads back whole, in the order it was said', async () => {
  const { Skadi } = await import('../src/server.mjs');
  await withStore(async (store) => {
    const session = await store.create('Compacted chat', 'dev');
    session.archive = [
      { role: 'user', content: 'the original question' },
      { role: 'assistant', content: 'the original answer' },
    ];
    session.messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: '[Compacted context] …' },
      { role: 'user', content: 'and then' },
    ];
    await store.save(session);

    let body;
    // No Skadi constructor: this route needs the session store and nothing
    // else, so it is given exactly that.
    await Skadi.prototype.handleApi.call({ sessions: store }, { method: 'GET' }, {
      writeHead() {},
      end(value) { body = JSON.parse(value); },
    }, new URL(`http://127.0.0.1/api/session?id=${session.id}`));

    assert.deepEqual(body.messages.map((m) => m.content), [
      'the original question',
      'the original answer',
      'system prompt',
      '[Compacted context] …',
      'and then',
    ]);
    // The meter measures what the model carries, not what the chat shows.
    assert.ok(body.estimatedTokens < 60, `context estimate counts the live transcript only (${body.estimatedTokens})`);
  });
});

// ------------------------------------------------------------ turn lifecycle --

/**
 * A Skadi with only the parts `chat()` touches: a real session store and a
 * stub agent whose run() the test drives. Enough to check what a turn tells
 * the window about itself, which is where chats used to get stuck.
 */
function harness(store, run) {
  const events = [];
  const titled = [];
  const agent = {
    running: false,
    toolCtx: {},
    aborted: false,
    on() {},
    abort() { this.aborted = true; },
    async run(messages) {
      this.running = true;
      try {
        return await run(messages, this);
      } finally {
        this.running = false;
      }
    },
  };
  const skadi = {
    sessions: store,
    turns: new Map(),
    settings: {},
    config: { profiles: {}, activeProfile: 'p' },
    skills: { list: async () => [] },
    memory: { promptBlock: async () => '' },
    providerFor: () => ({ id: 'stub', kind: 'openai', label: 'Stub', managed: false, vision: false }),
    chatReady: () => true,
    modelFor: () => 'stub-model',
    rekeyBrowser() {},
    closeBrowser: async () => {},
    broadcast: (type, data) => events.push({ type, data }),
    stopTurn: Skadi.prototype.stopTurn,
    chat: Skadi.prototype.chat,
    userContent: Skadi.prototype.userContent,
    appendUserMessage: Skadi.prototype.appendUserMessage,
    // Naming a new chat asks the model; a test double records the ask instead.
    refineTitle(id, provider, model, text) { titled.push({ id, text }); },
  };
  return { skadi, agent, events, titled, makeAgent: async () => agent };
}

const { Skadi } = await import('../src/server.mjs');

test('a finished turn leaves the chat idle, and says so exactly once', async () => {
  await withStore(async (store) => {
    const h = harness(store, async () => {});
    h.skadi.makeAgent = h.makeAgent;
    const session = await h.skadi.chat(null, 'hello');

    const types = h.events.map((e) => e.type);
    // One `agent_session`, at the start. Sending it again on the way out is
    // what left finished chats pulsing "working…" in the rail.
    assert.equal(types.filter((t) => t === 'agent_session').length, 1);
    // The last word on what is running is an empty list.
    const turns = h.events.filter((e) => e.type === 'turns');
    assert.deepEqual(turns.at(0).data.sessionIds, [session.id]);
    assert.deepEqual(turns.at(-1).data.sessionIds, []);
    assert.equal(h.skadi.turns.size, 0);
  });
});

test('a turn that fails names the chat it failed in', async () => {
  await withStore(async (store) => {
    const h = harness(store, async () => { throw new Error('provider exploded'); });
    h.skadi.makeAgent = h.makeAgent;

    let failedIn = null;
    const onSession = (id) => { failedIn = id; };
    await assert.rejects(h.skadi.chat(null, 'hello', [], { onSession }), /provider exploded/);
    // Without this the window cannot tell which chat to take out of its busy
    // state -- and for a brand-new chat it never learns the id at all, so the
    // composer stays on "Stop generating" for good.
    assert.match(failedIn, /^\d{4}-/);
    assert.equal(h.skadi.turns.size, 0);
  });
});

test('a chat deleted mid-turn stays deleted, however slow the turn is to stop', async () => {
  await withStore(async (store) => {
    let started;
    let finish;
    const running = new Promise((r) => { started = r; });
    const h = harness(store, (messages, agent) => new Promise((resolve) => {
      started();
      // A turn that does not answer `abort` promptly: stopTurn gives up
      // waiting and drops it, and the delete goes ahead without it.
      finish = async () => {
        // Whatever it does on the way out must not put the chat back.
        await agent.persist?.();
        resolve();
      };
    }));
    h.skadi.makeAgent = h.makeAgent;

    const turn = h.skadi.chat(null, 'hello');
    await running;
    const id = [...h.skadi.turns.keys()][0];

    await h.skadi.stopTurn(id);
    await store.remove(id);
    await finish();
    await turn;

    assert.equal(h.agent.aborted, true);
    assert.equal(h.skadi.turns.size, 0);
    await assert.rejects(store.get(id), /no session/);
    assert.deepEqual(await store.list(), [], 'a deleted chat must not be saved back into existence');
  });
});

// --------------------------------------------------------------- rail order --
//
// The rail is ordered by `updatedAt`, so that field has to mean "when this
// conversation last changed". Every test here is a way the list used to
// reshuffle itself under the cursor.

/** The rail's own order: pinned first, then most recently updated. */
const order = async (store) => (await store.list()).map((s) => s.title);

test('opening a chat does not send it to the top', async () => {
  await withStore(async (store) => {
    const first = await store.create('First', 'dev');
    await new Promise((r) => setTimeout(r, 5));
    await store.create('Second', 'dev');
    assert.deepEqual(await order(store), ['Second', 'First']);

    // What opening a chat does: mark it read.
    await store.update(first.id, { unread: false });
    assert.deepEqual(await order(store), ['Second', 'First'],
      'reading a chat is not a change to it');
  });
});

test('renaming, pinning, archiving and grouping all leave the order alone', async () => {
  await withStore(async (store) => {
    const first = await store.create('First', 'dev');
    await new Promise((r) => setTimeout(r, 5));
    await store.create('Second', 'dev');
    const { id: groupId } = await store.createGroup('Work', 'dev');

    await store.update(first.id, { title: 'Renamed' });
    await store.update(first.id, { groupId });
    await store.update(first.id, { archived: true });
    await store.update(first.id, { archived: false });
    assert.deepEqual(await order(store), ['Second', 'Renamed'],
      'organising a chat is not a change to it');

    // Pinning does move it -- to the pinned section, which is the point.
    await store.update(first.id, { pinned: true });
    assert.deepEqual(await order(store), ['Renamed', 'Second']);
  });
});

test('a message does move the chat to the top', async () => {
  await withStore(async (store) => {
    const first = await store.create('First', 'dev');
    await new Promise((r) => setTimeout(r, 5));
    await store.create('Second', 'dev');
    assert.deepEqual(await order(store), ['Second', 'First']);

    const live = await store.get(first.id);
    live.messages.push({ role: 'user', content: 'hello' });
    await new Promise((r) => setTimeout(r, 5));
    await store.save(live);
    assert.deepEqual(await order(store), ['First', 'Second'],
      'saying something is exactly what should reorder the rail');
  });
});

test('an untouched save still writes the file', async () => {
  await withStore(async (store, dir) => {
    const session = await store.create('Kept', 'dev');
    const before = (await read(dir, session.id)).updatedAt;
    await store.update(session.id, { title: 'Renamed' });
    const after = await read(dir, session.id);
    assert.equal(after.title, 'Renamed', 'the change is on disk');
    assert.equal(after.updatedAt, before, 'but the stamp did not move');
  });
});

// ------------------------------------------------------ per-chat provider --

test('each chat runs on the provider it was sent with, and keeps it', async () => {
  await withStore(async (store) => {
    const picks = [];
    const h = harness(store, async () => {});
    h.skadi.makeAgent = h.makeAgent;
    h.skadi.providerFor = (pick) => {
      picks.push(pick);
      return { id: pick.provider || 'default', kind: 'openai', label: 'Stub', managed: false, vision: false, model: pick.model };
    };

    const a = await h.skadi.chat(null, 'one', [], { provider: 'openrouter', model: 'vendor/model-a' });
    const b = await h.skadi.chat(null, 'two', [], { provider: 'anthropic', model: 'model-b' });
    assert.equal(a.provider, 'openrouter');
    assert.equal(a.model, 'vendor/model-a');
    assert.equal(b.provider, 'anthropic');
    assert.equal(b.model, 'model-b');
    // It is on disk, so reopening the chat later goes back to it.
    assert.equal((await store.get(a.id)).provider, 'openrouter');

    // A caller that names nothing gets what the chat used last.
    await h.skadi.chat(a.id, 'again');
    assert.deepEqual(picks.at(-1), { provider: 'openrouter', model: 'vendor/model-a' });

    // Moving one chat does not move the other.
    await h.skadi.chat(a.id, 'switch', [], { provider: 'anthropic', model: 'model-c' });
    assert.equal((await store.get(a.id)).provider, 'anthropic');
    assert.equal((await store.get(b.id)).model, 'model-b');
  });
});

test('a local chat forgets the hosted model it had before', async () => {
  await withStore(async (store) => {
    const h = harness(store, async () => {});
    h.skadi.makeAgent = h.makeAgent;
    h.skadi.providerFor = (pick) => (pick.provider === 'local'
      ? { id: 'local', kind: 'openai', label: 'Local', managed: true }
      : { id: 'openrouter', kind: 'openai', label: 'OR', managed: false, model: pick.model });
    h.skadi.detectExternal = async () => {};

    const s = await h.skadi.chat(null, 'hosted', [], { provider: 'openrouter', model: 'x/y' });
    assert.equal(s.model, 'x/y');
    const again = await h.skadi.chat(s.id, 'local now', [], { provider: 'local' });
    assert.equal(again.provider, 'local');
    assert.equal(again.model, undefined);
  });
});

// ------------------------------------------------------------------ titles --

test('a new chat is named for its topic at once, and the model is asked to do better', async () => {
  await withStore(async (store) => {
    const h = harness(store, async () => {});
    h.skadi.makeAgent = h.makeAgent;
    const session = await h.skadi.chat(null, "let's improve the ui of the sidebar so it looks better");
    assert.equal(session.title, 'Improve the ui of the sidebar');
    assert.equal(session.titleAuto, true);
    assert.deepEqual(h.titled.map((t) => t.id), [session.id]);

    // A follow-up in the same chat neither renames it nor asks again.
    await h.skadi.chat(session.id, 'and make the rows smaller');
    assert.equal((await store.get(session.id)).title, 'Improve the ui of the sidebar');
    assert.equal(h.titled.length, 1);
  });
});
