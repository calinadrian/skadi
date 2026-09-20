import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Agent } from '../src/agent.mjs';

async function loopingModel() {
  let requests = 0;
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'focused result' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { server, bodies, provider: { id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' } };
}

const run = async (mutates, { stopOnLoop = false } = {}) => {
  const fixture = await loopingModel();
  const archived = [];
  try {
    const agent = new Agent({
      provider: fixture.provider,
      model: 'm',
      tools: { inspect: { schema: {}, mutates, run: async () => 'same known evidence' } },
      schemas: [],
      settings: { maxToolRounds: 0, loopDetection: true, permissionMode: 'bypassPermissions', compaction: { auto: false } },
      reviewProgress: async () => ({ loop: true, reason: 'repeated known evidence', next: 'run the direct test' }),
      stopOnLoop,
    });
    agent.archive = (rows) => archived.push(...rows);
    const messages = [{ role: 'user', content: 'fix it' }];
    await agent.run(messages);
    return { ...fixture, messages, archived };
  } finally {
    fixture.server.close();
  }
};

test('semantic loop detection prunes a bad read-only cycle and redirects the next request', async () => {
  const { messages, archived, bodies } = await run(false);
  assert.equal(messages.some((m) => m.role === 'tool'), false);
  assert.equal(archived.some((m) => m.role === 'tool'), true);
  assert.equal(messages.at(-1).content, 'focused result');
  assert.match(bodies[1].messages.at(-1).content, /progress supervisor detected a loop/i);
  assert.match(bodies[1].messages.at(-1).content, /run the direct test/i);
});

test('semantic loop detection retains actions that may have side effects', async () => {
  const { messages, archived, bodies } = await run(true);
  assert.equal(messages.some((m) => m.role === 'tool'), true);
  assert.equal(archived.length, 0);
  assert.match(bodies[1].messages.at(-1).content, /record was retained/i);
});

test('a focused subagent hands control back on the first semantic loop', async () => {
  const { messages, archived, bodies } = await run(false, { stopOnLoop: true });
  assert.equal(bodies.length, 1, 'the child must not start another model round');
  assert.equal(archived.some((m) => m.role === 'tool'), true);
  assert.match(messages.at(-1).content, /handed back to the parent/i);
  assert.match(messages.at(-1).content, /repeated known evidence/i);
  assert.match(messages.at(-1).content, /run the direct test/i);
});

test('an identical read with identical output is caught even when the semantic reviewer misses it', async () => {
  let requests = 0;
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests <= 2) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function', function: { name: 'inspect', arguments: '{"path":"same.mjs"}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'changed approach' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const archived = [];
  let semanticReviews = 0;
  try {
    const agent = new Agent({
      provider: { id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      model: 'm',
      tools: { inspect: { schema: {}, run: async () => 'unchanged evidence' } },
      schemas: [],
      settings: { maxToolRounds: 0, loopDetection: true, permissionMode: 'bypassPermissions', compaction: { auto: false } },
      reviewProgress: async () => { semanticReviews++; return { loop: false }; },
    });
    agent.archive = (rows) => archived.push(...rows);
    const messages = [{ role: 'user', content: 'fix the bug' }];
    await agent.run(messages);
    assert.equal(semanticReviews, 1, 'the deterministic guard should supersede the second model review');
    assert.equal(archived.filter((m) => m.role === 'tool').length, 1);
    assert.match(bodies[2].messages.at(-1).content, /returned the same evidence/i);
    assert.equal(messages.at(-1).content, 'changed approach');
  } finally {
    server.close();
  }
});
