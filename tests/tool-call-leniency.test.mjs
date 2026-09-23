// A small model's tool call is often right in intent and wrong in form: a
// misspelt tool name, or arguments that are almost JSON. The ones with a
// single reading run; the rest come back with the fix spelled out.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../src/agent.mjs';
import { looseToolArguments, repairToolArguments, INVALID_ARGS_KEY } from '../src/providers.mjs';
import { suggestToolName } from '../src/tools.mjs';

const NAMES = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'run_command', 'delete_file', 'browser_read'];

test('fenced, prefixed and trailing-comma arguments are read as meant', () => {
  assert.deepEqual(looseToolArguments('```json\n{"path": "a.js"}\n```'), { path: 'a.js' });
  assert.deepEqual(looseToolArguments('```\n{"path": "a.js",}\n```'), { path: 'a.js' });
  assert.deepEqual(looseToolArguments('Sure, here it is: {"path": "a.js"}'), { path: 'a.js' });
  assert.deepEqual(
    looseToolArguments('{"steps": ["one", "two",], "action": "set",}'),
    { steps: ['one', 'two'], action: 'set' },
  );
});

test('raw line breaks and tabs inside a string are escaped, not rejected', () => {
  const raw = '{"path": "a.py", "content": "def f():\n\treturn 1\n"}';
  assert.deepEqual(looseToolArguments(raw), { path: 'a.py', content: 'def f():\n\treturn 1\n' });
});

test('a comma inside a string is left alone', () => {
  assert.deepEqual(looseToolArguments('{"text": "a, }", "n": 1,}'), { text: 'a, }', n: 1 });
});

test('arguments cut off mid-string stay broken rather than guessed', () => {
  assert.equal(looseToolArguments('{"command": "echo unterminated'), null);
  assert.equal(looseToolArguments('no json here'), null);
  assert.equal(looseToolArguments('```json\n[1, 2]\n```'), null);
});

test('the provider repair stores fixable arguments as clean JSON', () => {
  const call = { id: 'c', type: 'function', function: { name: 'read_file', arguments: '```json\n{"path": "a.js",}\n```' } };
  repairToolArguments(call);
  assert.equal(call.function.arguments, '{"path":"a.js"}');
  const cut = { id: 'd', type: 'function', function: { name: 'run_command', arguments: '{"command": "ls' } };
  repairToolArguments(cut);
  assert.ok(JSON.parse(cut.function.arguments)[INVALID_ARGS_KEY]);
});

test('tool names that differ only in spelling resolve exactly', () => {
  for (const typo of ['readFile', 'read-file', 'READ_FILE', 'ReadFile']) {
    assert.equal(suggestToolName(typo, NAMES).exact, 'read_file', typo);
  }
});

test('near names and habits from other harnesses are suggested', () => {
  assert.equal(suggestToolName('read', NAMES).suggestions[0], 'read_file');
  assert.equal(suggestToolName('bash', NAMES).suggestions[0], 'run_command');
  assert.equal(suggestToolName('str_replace', NAMES).suggestions[0], 'edit_file');
  assert.equal(suggestToolName('ls', NAMES).suggestions[0], 'list_dir');
  assert.equal(suggestToolName('grepp', NAMES).suggestions[0], 'grep');
  assert.equal(suggestToolName('run_comand', NAMES).suggestions[0], 'run_command');
  assert.deepEqual(suggestToolName('teleport', NAMES), { exact: null, suggestions: [] });
});

function agentWith(tools) {
  return new Agent({
    provider: { id: 'fake', kind: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'k' },
    model: 'm',
    tools,
    schemas: [],
    settings: {},
  });
}

const readTool = { schema: {}, run: async ({ path }) => `contents of ${path}` };

test('a misspelt tool runs as the real one, and the transcript is corrected', async () => {
  const agent = agentWith({ read_file: readTool });
  const call = { id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a.js"}' } };
  const result = await agent._invoke(call);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'contents of a.js');
  assert.equal(call.function.name, 'read_file');
});

test('an unknown tool gets suggestions and the list of real tools', async () => {
  const agent = agentWith({ read_file: readTool, grep: readTool });
  const result = await agent._invoke({ id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } });
  assert.equal(result.ok, false);
  assert.match(result.content, /no tool named "read"\. Did you mean "read_file"\?/);
  assert.match(result.content, /Available tools: read_file, grep\./);
});

test('fenced arguments that reach the agent unrepaired still run', async () => {
  const agent = agentWith({ read_file: readTool });
  const call = { id: 'c3', type: 'function', function: { name: 'read_file', arguments: '```json\n{"path": "b.js",}\n```' } };
  const result = await agent._invoke(call);
  assert.equal(result.content, 'contents of b.js');
  assert.equal(call.function.arguments, '{"path":"b.js"}');
});
