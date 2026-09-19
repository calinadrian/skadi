// Several models loaded at once: which one a chat talks to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Skadi } from '../src/server.mjs';

const inst = (id, port, startedAt, state = 'ready') => ({ id, port, startedAt, state, profileId: id });

const harness = (instances, profiles = {}) => {
  const skadi = Object.create(Skadi.prototype);
  skadi.config = { host: '127.0.0.1', port: 8080, profiles, activeProfile: 'a' };
  skadi.instances = new Map(instances.map((i) => [i.id, i]));
  skadi.external = null;
  return skadi;
};

const profiles = { a: { alias: 'model-a', ctx: 4096 }, b: { alias: 'model-b', ctx: 8192 } };

test('a chat that named a loaded model talks to that model, on its own port', () => {
  const s = harness([inst('a', 8080, 1), inst('b', 8081, 2)], profiles);
  assert.deepEqual(s.localEndpoint('a'), { instance: 'a', baseUrl: 'http://127.0.0.1:8080/v1', model: 'model-a' });
  assert.deepEqual(s.localEndpoint('b'), { instance: 'b', baseUrl: 'http://127.0.0.1:8081/v1', model: 'model-b' });
});

test('a chat that named nothing gets the model loaded most recently', () => {
  const s = harness([inst('a', 8080, 1), inst('b', 8081, 2)], profiles);
  assert.equal(s.localEndpoint('').instance, 'b');
});

test('a model that is no longer loaded, or still loading, is not talked to', () => {
  const s = harness([inst('a', 8080, 1), inst('b', 8081, 2, 'starting')], profiles);
  assert.equal(s.localEndpoint('b').instance, 'a');
  assert.deepEqual(harness([]).localEndpoint('a'), { instance: null });
});

test('chat is ready only when the model it resolved to is', () => {
  const s = harness([inst('a', 8080, 1)], profiles);
  assert.equal(s.chatReady({ managed: true, instance: 'a' }), true);
  assert.equal(s.chatReady({ managed: true, instance: 'b' }), false);
  assert.equal(s.chatReady({ managed: true, instance: null }), false);
  s.external = { alias: 'other' };
  assert.equal(s.chatReady({ managed: true, instance: null }), true);
});

test('a model that failed to load is not counted as loaded', () => {
  const s = harness([inst('a', 8080, 1), inst('b', 8081, 2)], profiles);
  assert.deepEqual(s.liveInstances().map((i) => i.id), ['a', 'b']);
  s.instances.get('b').state = 'error';
  assert.deepEqual(s.liveInstances().map((i) => i.id), ['a']);
  assert.deepEqual(s.readyInstances().map((i) => i.id), ['a']);
});
