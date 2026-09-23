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

test('a semantic progress check adds one hint and never removes the evidence', async () => {
  const { messages, archived, bodies } = await run(false);
  assert.equal(messages.some((m) => m.role === 'tool'), true, 'a judgement call must not delete what the model learned');
  assert.equal(archived.length, 0);
  assert.equal(messages.at(-1).content, 'focused result');
  const guidance = bodies[1].messages.at(-1).content;
  assert.match(guidance, /progress check found your last step added nothing new/i);
  assert.match(guidance, /Next: .*run the direct test/i);
  assert.equal((guidance.match(/^Next:/gm) || []).length, 1, 'exactly one instruction reaches the model');
});

test('a semantic hint keeps actions that may have had side effects', async () => {
  const { messages, archived } = await run(true);
  assert.equal(messages.some((m) => m.role === 'tool'), true);
  assert.equal(archived.length, 0);
});

test('a focused subagent hands control back on the first semantic loop', async () => {
  const { messages, archived, bodies } = await run(false, { stopOnLoop: true });
  assert.equal(bodies.length, 1, 'the child must not start another model round');
  assert.equal(archived.length, 0);
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
    assert.equal(archived.length, 0, 'the repeat stays in the chat, in place');
    assert.equal(messages.filter((m) => m.role === 'tool' && m.aside === 'repeat').length, 1);
    assert.equal(bodies[2].messages.filter((m) => m.role === 'tool').length, 1, 'the model sees the first result only');
    assert.equal(bodies[2].messages.some((m) => 'aside' in m), false);
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
    const setAside = messages.find((message) => message.content === 'The website is complete.');
    assert.equal(setAside?.aside, 'unfinished', 'the premature answer stays in the chat, marked');
    assert.equal(bodies[2].messages.some((message) => message.content === 'The website is complete.'), false, 'and the model no longer sees it');
    assert.match(bodies[2].messages.at(-1).content, /still have placeholder or empty content/i);
  } finally {
    server.close();
  }
});

test('a finish gate sends the model back once, then lets the turn end', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.js', old_string: 'x', new_string: 'y' }) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: `answer ${requests}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const tools = { edit_file: { schema: {}, mutates: true, run: async () => 'edited' } };
    const agent = new Agent({
      provider: { id: 'fake', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      model: 'm',
      tools,
      schemas: [{ type: 'function', function: { name: 'edit_file', parameters: {} } }],
      settings: { maxToolRounds: 0, loopDetection: false, permissionMode: 'bypassPermissions', compaction: { auto: false } },
    });
    const messages = [{ role: 'user', content: 'fix the typo in a.js' }];
    await agent.run(messages);
    assert.equal(requests, 3, 'one send-back for the unchecked edit, then the answer stands');
    assert.equal(messages.at(-1).content, 'answer 3');
  } finally {
    server.close();
  }
});
