import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Agent } from '../src/agent.mjs';

test('automatic steers retain their system role', async () => {
  const agent = new Agent({
    provider: { id: 'fake', kind: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'k' },
    model: 'm',
    tools: {},
    schemas: [],
    settings: {},
  });
  const messages = [];
  agent.running = true;
  assert.equal(agent.steer('background task finished', { role: 'system' }), true);
  await agent._drainSteers(messages);
  assert.deepEqual(messages, [{ role: 'system', content: 'background task finished' }]);
});

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
      settings: { maxToolRounds: 0, loopDetection: true, loopReviewEvery: 1, permissionMode: 'bypassPermissions', compaction: { auto: false } },
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
    assert.equal(semanticReviews, 0, 'the deterministic guard should avoid an unnecessary model review');
    assert.equal(archived.filter((m) => m.role === 'tool').length, 1);
    assert.match(bodies[2].messages.at(-1).content, /returned the same evidence/i);
    assert.equal(messages.at(-1).content, 'changed approach');
  } finally {
    server.close();
  }
});

test('implementation work is forced from discovery into an edit', async () => {
  let requests = 0;
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const forced = requests === 4;
    const verifying = requests === 5;
    const finished = requests === 6;
    if (finished) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'implemented and verified' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const name = forced ? 'edit_file' : verifying ? 'run_command' : 'inspect';
    const args = forced
      ? { path: 'button.mjs', old_string: 'broken', new_string: 'fixed' }
      : verifying
        ? { command: 'node --test tests/button.test.mjs' }
      : { path: `file-${requests}.mjs` };
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const agent = new Agent({
      provider: { id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      model: 'm',
      tools: {
        inspect: { schema: {}, mutates: false, run: async ({ path }) => `new evidence from ${path}` },
        edit_file: { schema: {}, mutates: true, run: async () => 'edited button.mjs' },
        write_file: { schema: {}, mutates: true, run: async () => 'wrote button.mjs' },
        run_command: { schema: {}, mutates: true, run: async () => 'tests passed' },
      },
      schemas: ['inspect', 'edit_file', 'write_file', 'run_command'].map((name) => ({ type: 'function', function: { name, parameters: {} } })),
      settings: {
        maxToolRounds: 0,
        maxImplementationDiscoveryRounds: 3,
        loopDetection: false,
        permissionMode: 'bypassPermissions',
        compaction: { auto: false },
      },
    });
    const roundEvents = [];
    agent.on('round', (event) => roundEvents.push(event));
    const messages = [{ role: 'user', content: 'fix the broken button' }];
    await agent.run(messages);
    assert.equal(requests, 6);
    assert.deepEqual(bodies[3].tools.map((tool) => tool.function.name), ['edit_file', 'write_file']);
    assert.match(bodies[3].messages.at(-1).content, /discovery tools are now unavailable/i);
    assert.equal(messages.at(-1).content, 'implemented and verified');
    assert.equal(roundEvents.every((event) => event.maxRounds === 0), true,
      'unlimited turns must not display a finite denominator after editing');
  } finally {
    server.close();
  }
});

test('a placeholder deliverable cannot be reported as finished', async () => {
  let requests = 0;
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const calls = {
      1: ['write_file', { path: 'js/data.js', content: 'window.META = { openers: [], comps: [] };' }],
      3: ['write_file', { path: 'js/data.js', content: 'window.META = { openers: [{name:"Void"}], comps: [{name:"Arcanist"}] };' }],
      4: ['run_command', { command: 'node --test tests/site.test.mjs' }],
    };
    if (calls[requests]) {
      const [name, args] = calls[requests];
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      const content = requests === 2 ? 'The website is complete.' : 'Implemented real data and verified the site.';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const archived = [];
  try {
    const tools = {
      write_file: { schema: {}, mutates: true, run: async () => 'file written' },
      run_command: { schema: {}, mutates: true, run: async () => 'tests passed' },
    };
    const agent = new Agent({
      provider: { id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      model: 'm',
      tools,
      schemas: Object.keys(tools).map((name) => ({ type: 'function', function: { name, parameters: {} } })),
      settings: { maxToolRounds: 0, loopDetection: false, permissionMode: 'bypassPermissions', compaction: { auto: false } },
    });
    agent.archive = (rows) => archived.push(...rows);
    const messages = [{ role: 'user', content: 'Build a current TFT website with real comps and icons.' }];
    await agent.run(messages);
    assert.equal(requests, 5);
    assert.equal(messages.at(-1).content, 'Implemented real data and verified the site.');
    assert.equal(archived.some((message) => message.content === 'The website is complete.'), true);
    assert.match(bodies[2].messages.at(-1).content, /incomplete deliverables/i);
  } finally {
    server.close();
  }
});
