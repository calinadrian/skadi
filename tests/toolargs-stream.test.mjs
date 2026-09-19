// End to end: a model that stops mid-arguments in a *new* chat must still
// leave a transcript the next request can be built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { streamCompletion, INVALID_ARGS_KEY } from '../src/providers.mjs';
import { Agent } from '../src/agent.mjs';

/**
 * An OpenAI-compatible endpoint that streams one tool call, with the arguments
 * split across deltas the way a real stream arrives -- and cut off, the way the
 * one that broke the Metin2 chat was.
 */
async function brokenModel(chunks) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '' } }] } }] })}\n\n`);
    for (const piece of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { server, provider: { id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', vision: false } };
}

const CUT_OFF = ['{"command": "Select-String -Pattern ', "'Restart'", '", "shell": " Greenville, NC, US\\n'];

test('a cut-off tool call arrives as legal JSON, not as poison', async () => {
  const { server, provider } = await brokenModel(CUT_OFF);
  try {
    const { message } = await streamCompletion(provider, { model: 'm', messages: [{ role: 'user', content: 'go' }] }, {});
    const args = message.tool_calls[0].function.arguments;
    JSON.parse(args); // the whole point: this must not throw
    assert.ok(JSON.parse(args)[INVALID_ARGS_KEY], 'the raw text should be preserved inside');
    assert.match(JSON.parse(args)[INVALID_ARGS_KEY].received, /Select-String/);
  } finally {
    server.close();
  }
});

test('the model still gets told what it did wrong, and the turn continues', async () => {
  const { server, provider } = await brokenModel(CUT_OFF);
  try {
    const ran = [];
    const agent = new Agent({
      provider,
      model: 'm',
      tools: { run_command: { schema: {}, run: async (a) => { ran.push(a); return 'ok'; } } },
      schemas: [],
      settings: { maxToolRounds: 1, permissionMode: 'bypassPermissions', compaction: { auto: false } },
    });
    const messages = [{ role: 'user', content: 'go' }];
    await agent.run(messages);

    const result = messages.find((m) => m.role === 'tool');
    assert.ok(result, 'the broken call should still produce a tool result');
    assert.match(result.content, /arguments were not valid JSON/);
    assert.match(result.content, /Select-String/, 'the model must see what it actually sent');
    assert.equal(ran.length, 0, 'a call with unusable arguments must never execute');

    // And the transcript that turn leaves behind is replayable.
    for (const m of messages) {
      for (const call of m.tool_calls || []) JSON.parse(call.function.arguments);
    }
  } finally {
    server.close();
  }
});
