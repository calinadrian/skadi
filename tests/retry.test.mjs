// Does the retry loop tell an upstream's bad moment from a bad request?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamCompletion } from '../src/providers.mjs';

/** A fake OpenAI-compatible endpoint that replies with a canned script. */
function fakeProvider(script) {
  let hit = 0;
  const server = createServer((req, res) => {
    const step = script[Math.min(hit, script.length - 1)];
    hit += 1;
    if (step.ok) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(step.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(step.body));
  });
  return { server, hits: () => hit };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const run = async (script, retry = { attempts: 3, minDelayMs: 1, maxDelayMs: 2 }) => {
  const fake = fakeProvider(script);
  const port = await listen(fake.server);
  const provider = { id: 'test', label: 'Gateway', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', vision: false };
  try {
    const result = await streamCompletion(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }], retry }, {});
    return { ok: true, result, hits: fake.hits() };
  } catch (err) {
    return { ok: false, err, hits: fake.hits() };
  } finally {
    fake.server.close();
  }
};

// OpenRouter's shape when the model endpoint behind it fell over.
const upstream400 = {
  status: 400,
  body: { error: { message: 'Provider returned error', code: 400, metadata: { raw: 'ERROR', provider_name: 'Stealth' } } },
};
// What a genuinely malformed request comes back as.
const bad400 = { status: 400, body: { error: { message: 'messages.0.content: field required', code: 400 } } };

test('an upstream failure behind a 400 is retried, and can succeed', async () => {
  const { ok, hits } = await run([upstream400, { ok: true }]);
  assert.equal(ok, true);
  assert.equal(hits, 2, 'the request should have been replayed once');
});

test('the message names the upstream rather than reading like our bug', async () => {
  const { err } = await run([upstream400], { attempts: 1, minDelayMs: 1, maxDelayMs: 2 });
  assert.match(err.message, /Gateway returned 400: ERROR/);
  assert.match(err.message, /upstream Stealth failed/);
  assert.equal(err.upstream, true);
  assert.equal(err.body, JSON.stringify(upstream400.body));
});

test('a malformed request still fails on the first attempt', async () => {
  const { ok, err, hits } = await run([bad400, { ok: true }]);
  assert.equal(ok, false);
  assert.equal(hits, 1, 'a request the gateway rejected must not be replayed');
  assert.equal(err.upstream, false);
  assert.match(err.message, /field required/);
});

test('an auth failure is never retried, even blamed on an upstream', async () => {
  const body = { error: { message: 'No credits', code: 402, metadata: { raw: 'ERROR', provider_name: 'Stealth' } } };
  const { ok, hits } = await run([{ status: 402, body }, { ok: true }]);
  assert.equal(ok, false);
  assert.equal(hits, 1);
});

test('rate limits keep being retried as before', async () => {
  const { ok, hits } = await run([{ status: 429, body: { error: { message: 'slow down' } } }, { ok: true }]);
  assert.equal(ok, true);
  assert.equal(hits, 2);
});

test('an abort during the retry backoff settles immediately, without waiting it out', async () => {
  const fake = fakeProvider([{ status: 429, body: { error: { message: 'slow down' } } }]);
  const port = await listen(fake.server);
  const provider = { id: 'test', label: 'Gateway', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', vision: false };
  const controller = new AbortController();
  const started = Date.now();
  try {
    // Aborting inside onRetry lands the abort between the loop's own abort
    // check and the backoff sleep -- the window the sleep guard covers.
    await streamCompletion(
      provider,
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], retry: { attempts: 2, minDelayMs: 3000, maxDelayMs: 3000 } },
      { onRetry: () => controller.abort() },
      controller.signal,
    );
    assert.fail('the aborted retry should have failed');
  } catch (err) {
    const elapsed = Date.now() - started;
    assert.equal(fake.hits(), 1, 'no second request after the abort');
    assert.ok(elapsed < 1500, `should not wait out the 3000ms backoff (took ${elapsed}ms)`);
    assert.ok(err, 'it must reject, not resolve');
  } finally {
    fake.server.close();
  }
});
