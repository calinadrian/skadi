// Where the context window comes from, and what happens when nobody knows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { modelLimits } from '../src/providers.mjs';
import { resolveContextTokens } from '../src/compaction.mjs';

/** An OpenAI-compatible /models endpoint, OpenRouter-shaped. */
async function catalogue(models) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: models }));
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, baseUrl: `http://127.0.0.1:${port}/v1` };
}

test('a model’s window is read from the endpoint that serves it', async () => {
  const { server, baseUrl } = await catalogue([
    { id: 'stealth/union-alpha', context_length: 262144, top_provider: { max_completion_tokens: 131072 } },
  ]);
  try {
    const limits = await modelLimits({ id: 'or', kind: 'openai', baseUrl, apiKey: 'k' }, 'stealth/union-alpha');
    assert.equal(limits.contextTokens, 262144);
    assert.equal(limits.maxCompletionTokens, 131072);
  } finally {
    server.close();
  }
});

test('an endpoint that publishes no window says so rather than inventing one', async () => {
  const { server, baseUrl } = await catalogue([{ id: 'plain/model' }]);
  try {
    const limits = await modelLimits({ id: 'p', kind: 'openai', baseUrl, apiKey: 'k' }, 'plain/model');
    assert.equal(limits.contextTokens, null);
  } finally {
    server.close();
  }
});

test('an unreachable catalogue is null, not a thrown turn', async () => {
  const provider = { id: 'dead', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' };
  assert.equal(await modelLimits(provider, 'whatever'), null);
});

test('the endpoint’s figure beats the 128k fallback', () => {
  const provider = { id: 'or', model: 'm' };
  assert.equal(resolveContextTokens({ provider, modelCtx: 262144 }), 262144);
  assert.equal(resolveContextTokens({ provider, modelCtx: null }), 128000);
});

test('a hand-pinned window beats what the endpoint claims', () => {
  const provider = { id: 'or', model: 'm', contextTokens: 32768 };
  assert.equal(resolveContextTokens({ provider, modelCtx: 262144 }), 32768);
});

test('a managed llama-server still answers from its own profile', () => {
  const provider = { id: 'local', managed: true };
  assert.equal(resolveContextTokens({ provider, profileCtx: 16384, modelCtx: 262144 }), 16384);
  assert.equal(resolveContextTokens({ provider, externalCtx: 8192, profileCtx: 16384 }), 8192);
  assert.equal(resolveContextTokens({ provider }), null);
});
