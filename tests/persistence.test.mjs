import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../src/sessions.mjs';
import { Skadi } from '../src/server.mjs';
import { ROOT } from '../src/config.mjs';

test('saved chats survive a new store and remain scoped to their project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-persistence-'));
  try {
    const store = new SessionStore(dir);
    const session = await store.create('Synthetic restart check', 'dev');
    session.messages.push({ role: 'user', content: 'Synthetic message' });
    await store.save(session);
    session.messages.push({ role: 'assistant', content: 'Synthetic reply' });
    await store.save(session);

    const restarted = new SessionStore(dir);
    assert.deepEqual((await restarted.get(session.id)).messages, session.messages);
    assert.deepEqual((await restarted.list('dev')).map((s) => s.id), [session.id]);
    assert.deepEqual(await restarted.list('production'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('instance probe identifies the installation without loading chats or model state', async () => {
  let status;
  let headers;
  let body;
  // No Skadi constructor: this route must not depend on config, providers,
  // sessions or a running model. No real user data is read by this test.
  await Skadi.prototype.handleApi.call({}, { method: 'GET' }, {
    writeHead(code, values) { status = code; headers = values; },
    end(value) { body = value; },
  }, new URL('http://127.0.0.1/api/instance'));
  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(body, resolve(ROOT));
});
