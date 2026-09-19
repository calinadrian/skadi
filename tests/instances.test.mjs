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

// ------------------------------------------------ failures say what happened --
import { explainFailure } from '../src/llama.mjs';

const BONSAI = [
  "0.00.130.163 I srv    load_model: loading model 'D:/AI/models/Ternary-Bonsai-2-27B-PQ2_0.gguf'",
  "0.00.387.428 E gguf_init_from_reader: tensor 'output.weight' has invalid ggml type 142. should be in [0, 43)",
  '0.00.387.435 E gguf_init_from_reader: failed to read tensor info',
  '0.00.392.299 E llama_model_load: error loading model: llama_model_loader: failed to load model from x.gguf',
  '0.00.441.801 E srv llama_server: exiting due to model loading error',
];

test('a format the build does not know is named, along with the build that refused it', () => {
  const why = explainFailure({ lines: BONSAI, exe: 'D:/AI/llama.cpp/llama-server.exe', code: 1 });
  assert.match(why, /ggml type 142/);
  assert.match(why, /llama\.cpp does not know/);
  assert.doesNotMatch(why, /exiting due to model loading error/);
});

test('a crash with nothing in the log is reported as a crash, with its code', () => {
  const why = explainFailure({ lines: BONSAI.slice(0, 1), exe: 'D:/AI/prism-llama.cpp/llama-server.exe', code: 3221225477 });
  assert.match(why, /prism-llama\.cpp crashed while loading/);
  assert.match(why, /3221225477/);
});

test('running out of memory is said plainly, and an unrecognised failure keeps its own last error', () => {
  assert.match(explainFailure({ lines: ['0.01.000.000 E ggml_vulkan: ErrorOutOfDeviceMemory'], exe: 'x/y/llama-server.exe', code: 1 }), /did not fit in memory/);
  assert.equal(
    explainFailure({ lines: ['0.00.100.000 E something odd happened', '0.00.200.000 E srv llama_server: exiting due to model loading error'], code: 1 }),
    'something odd happened',
  );
  assert.equal(explainFailure({ lines: [], code: 1 }), null);
});
