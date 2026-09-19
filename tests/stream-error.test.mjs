// A gateway can accept the request, answer 200, open the stream -- and only
// then have the model behind it fall over. The failure arrives as a frame
// inside a stream that already succeeded at the HTTP level.
//
// These frames used to be dropped on the floor: the stream ended, the turn
// stopped with no text and no error, and the chat read as though the model had
// chosen to say nothing. This is the regression test for that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamCompletion } from '../src/providers.mjs';

/**
 * A fake OpenAI-compatible endpoint. Each step is either `{ ok: true }` (a
 * clean completion), `{ frames: [...] }` (a 200 whose stream carries exactly
 * those frames), or `{ status, body }` (an HTTP-level failure).
 */
function fakeProvider(script) {
  let hit = 0;
  const server = createServer((req, res) => {
    const step = script[Math.min(hit, script.length - 1)];
    hit += 1;
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(step.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = step.frames ?? [{ choices: [{ delta: { content: 'hi' } }] }];
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return { server, hits: () => hit };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function run(script, retry = { attempts: 3, minDelayMs: 1, maxDelayMs: 2 }) {
  const fake = fakeProvider(script);
  const port = await listen(fake.server);
  const provider = {
    id: 'test', label: 'OpenRouter', kind: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', vision: false,
  };
  const text = [];
  try {
    const result = await streamCompletion(
      provider,
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], retry },
      { onText: (t) => text.push(t) },
    );
    return { ok: true, result, text: text.join(''), hits: fake.hits() };
  } catch (err) {
    return { ok: false, err, text: text.join(''), hits: fake.hits() };
  } finally {
    fake.server.close();
  }
}

// Exactly what OpenRouter puts on the wire when an upstream drops out of the
// pool after the request was accepted -- the 502 that started all this.
const upstream502 = {
  error: {
    code: 502,
    message: 'Provider returned error',
    metadata: { raw: 'ERROR', provider_name: 'Stealth' },
  },
};

test('a 502 inside a 200 stream is raised, not swallowed', async () => {
  const { ok, err } = await run([{ frames: [upstream502] }], { attempts: 1, minDelayMs: 1, maxDelayMs: 2 });
  assert.equal(ok, false, 'the turn must fail rather than return an empty message');
  assert.match(err.message, /OpenRouter returned 502: ERROR/);
  assert.match(err.message, /upstream Stealth failed; the request itself was accepted/);
  assert.equal(err.status, 502);
  assert.equal(err.upstream, true);
});

test('a 502 inside a 200 stream is retried, and the retry can succeed', async () => {
  const { ok, result, hits } = await run([{ frames: [upstream502] }, { ok: true }]);
  assert.equal(ok, true);
  assert.equal(hits, 2, 'the request should have been replayed once');
  assert.equal(result.message.content, 'hi');
});

test('a stream that errors after text is not replayed, so nothing duplicates', async () => {
  const frames = [{ choices: [{ delta: { content: 'half ' } }] }, upstream502];
  const { ok, err, text, hits } = await run([{ frames }, { ok: true }]);
  assert.equal(ok, false);
  assert.equal(hits, 1, 'deltas already reached the caller; replaying would double them');
  assert.equal(text, 'half ', 'what did arrive is still handed over');
  assert.match(err.message, /502/);
});

test('an error frame with no status still retries, as the gateway failure it is', async () => {
  const frames = [{ error: { message: 'upstream error', metadata: { provider_name: 'Stealth' } } }];
  const { ok, hits } = await run([{ frames }, { ok: true }]);
  assert.equal(ok, true);
  assert.equal(hits, 2);
});

test('an error carried on the choice rather than the frame is caught too', async () => {
  const frames = [{ choices: [{ error: { code: 503, message: 'upstream error' } }] }];
  const { ok, hits } = await run([{ frames }, { ok: true }]);
  assert.equal(ok, true);
  assert.equal(hits, 2);
});

test('an auth failure inside a stream is not retried', async () => {
  const frames = [{ error: { code: 401, message: 'Invalid API key' } }];
  const { ok, err, hits } = await run([{ frames }, { ok: true }]);
  assert.equal(ok, false);
  assert.equal(hits, 1, 'replaying a rejected key only burns time');
  assert.match(err.message, /Invalid API key/);
});

test('ordinary frames are untouched', async () => {
  const frames = [
    { choices: [{ delta: { content: 'one ' } }] },
    { choices: [{ delta: { content: 'two' } }] },
    { usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ];
  const { ok, result, text } = await run([{ frames }]);
  assert.equal(ok, true);
  assert.equal(text, 'one two');
  assert.equal(result.usage.completion_tokens, 2);
});

test("an Anthropic overloaded event ends the stream instead of truncating it", async () => {
  // Anthropic's shape: `{"type":"error","error":{"type":"overloaded_error"}}`.
  // It has no numeric code, so it retries as the transient failure it is.
  const frames = [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
  const { ok, hits } = await run([{ frames }, { ok: true }]);
  assert.equal(ok, true);
  assert.equal(hits, 2);
});
