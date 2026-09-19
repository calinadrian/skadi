// Does the reasoning effort actually reach the model?
//
// Two separate things are covered here.
//
// The spelling: OpenRouter documents a `reasoning` object where OpenAI has a
// flat `reasoning_effort`. Both are accepted in practice -- the gateway
// normalises the alias -- so the translation below is about sending what is
// documented, and these tests pin the shape rather than claim a fix.
//
// The capability: that one is real. OpenRouter drops parameters a model does
// not accept instead of refusing the request, so on a model like
// stealth/union-alpha, which declares no reasoning parameter of any kind, an
// effort picker looks like it works and changes nothing at all. Marking that
// case is what lets the composer say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  streamCompletion, isOpenRouter, applyReasoningDialect, listModels, modelLimits,
} from '../src/providers.mjs';

/** Captures the request body an adapter actually puts on the wire. */
function capturingEndpoint() {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  return { server, seen };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/**
 * Run one completion against a local capture and return the body sent.
 * `host` decides which dialect the adapter should choose, so the OpenRouter
 * path can be exercised without leaving the machine.
 */
async function sent(sampling, { host = '127.0.0.1' } = {}) {
  const { server, seen } = capturingEndpoint();
  const port = await listen(server);
  const provider = {
    id: 'p', kind: 'openai', label: 'Gateway',
    baseUrl: `http://${host}:${port}/v1`, apiKey: 'k', vision: false,
  };
  try {
    await streamCompletion(provider, {
      model: 'm', messages: [{ role: 'user', content: 'hi' }], sampling,
      retry: { attempts: 1, minDelayMs: 1, maxDelayMs: 1 },
    }, {});
    return seen[0];
  } finally {
    server.close();
  }
}

// ------------------------------------------------------------- the dialect --

test('an OpenRouter endpoint is recognised, and a look-alike is not', () => {
  assert.equal(isOpenRouter({ baseUrl: 'https://openrouter.ai/api/v1' }), true);
  assert.equal(isOpenRouter({ baseUrl: 'https://OpenRouter.AI/api/v1' }), true);
  // A subdomain is still OpenRouter; a domain that merely ends in the same
  // letters is not.
  assert.equal(isOpenRouter({ baseUrl: 'https://api.openrouter.ai/v1' }), true);
  assert.equal(isOpenRouter({ baseUrl: 'https://notopenrouter.ai/v1' }), false);
  assert.equal(isOpenRouter({ baseUrl: 'https://api.openai.com/v1' }), false);
  assert.equal(isOpenRouter({ baseUrl: 'not a url' }), false);
  assert.equal(isOpenRouter(null), false);
});

test('a plain OpenAI endpoint keeps the flat reasoning_effort', async () => {
  const body = await sent({ temperature: 1, reasoning_effort: 'high' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.reasoning, undefined);
});

// The adapter cannot be pointed at a local server *and* at openrouter.ai at
// once, so the step that chooses the spelling is exercised directly -- it is
// the same function `streamOpenAi` calls, not a copy of its rule.
const openrouter = { baseUrl: 'https://openrouter.ai/api/v1' };

test('OpenRouter gets its own reasoning object instead', () => {
  const body = applyReasoningDialect({ model: 'm', temperature: 1, reasoning_effort: 'xhigh' }, openrouter);
  assert.deepEqual(body.reasoning, { effort: 'xhigh' });
  assert.equal(body.reasoning_effort, undefined, 'and not both at once');
  assert.equal(body.temperature, 1, 'the rest of the body is untouched');
});

test('every rung survives the translation, including the ones just added', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const body = applyReasoningDialect({ reasoning_effort: effort }, openrouter);
    assert.deepEqual(body.reasoning, { effort }, `${effort} should reach OpenRouter`);
  }
});

test('a body with no effort is left exactly as it is', () => {
  const body = applyReasoningDialect({ model: 'm', temperature: 1 }, openrouter);
  assert.deepEqual(body, { model: 'm', temperature: 1 });
});

test('a non-OpenRouter endpoint is not rewritten', () => {
  const body = applyReasoningDialect({ reasoning_effort: 'high' }, { baseUrl: 'https://api.openai.com/v1' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.reasoning, undefined);
});

test('Default sends no reasoning parameter at all', async () => {
  const body = await sent({ temperature: 1 });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.reasoning, undefined);
  assert.equal(body.temperature, 1, 'the rest of the sampling is untouched');
});

// -------------------------------------------------------- model capability --

/** A /models endpoint answering in OpenRouter's shape. */
function catalogue(models) {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: models }));
  });
}

async function capabilities(models, id) {
  const server = catalogue(models);
  const port = await listen(server);
  try {
    // A fresh port each time, so the per-baseUrl model cache never serves a
    // previous test's catalogue.
    const provider = { id: 'p', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' };
    return { list: await listModels(provider), limits: await modelLimits(provider, id) };
  } finally {
    server.close();
  }
}

test('a model that declares no reasoning parameter is marked unsupported', async () => {
  // stealth/union-alpha's real declaration, verbatim.
  const { limits } = await capabilities([{
    id: 'stealth/union-alpha',
    context_length: 262144,
    supported_parameters: ['max_tokens', 'response_format', 'temperature', 'tool_choice', 'tools', 'top_p'],
  }], 'stealth/union-alpha');
  assert.equal(limits.reasoning, false);
  assert.equal(limits.contextTokens, 262144, 'the rest of the entry still reads');
});

test('either spelling counts as support', async () => {
  const both = await capabilities([
    { id: 'a', supported_parameters: ['reasoning', 'temperature'] },
    { id: 'b', supported_parameters: ['reasoning_effort', 'temperature'] },
  ], 'a');
  assert.equal(both.limits.reasoning, true);
  assert.equal(both.list.find((m) => m.id === 'b').reasoning, true);
});

test('an endpoint that says nothing leaves it unknown, not unsupported', async () => {
  // Plain OpenAI lists bare ids with no supported_parameters. "It did not say"
  // must not grey out the picker.
  const { limits, list } = await capabilities([{ id: 'gpt-4o' }], 'gpt-4o');
  assert.equal(list[0].reasoning, undefined, 'absent rather than false');
  assert.equal(limits.reasoning, null, 'and null once resolved, which the UI reads as unknown');
});

test('a model missing from the catalogue reports nothing rather than guessing', async () => {
  const { limits } = await capabilities([{ id: 'a', supported_parameters: ['reasoning'] }], 'not-listed');
  assert.equal(limits, null);
});
