// A tool call the model cut off mid-arguments must not poison the transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairToolArguments, INVALID_ARGS_KEY } from '../src/providers.mjs';

const call = (args) => ({ id: 'c1', type: 'function', function: { name: 'run_command', arguments: args } });

test('valid arguments are left exactly as they are', () => {
  const good = call('{"command":"ls -la"}');
  repairToolArguments(good);
  assert.equal(good.function.arguments, '{"command":"ls -la"}');
});

test('an unterminated string becomes legal JSON that still carries the text', () => {
  // The real one: the model hallucinated a location mid-arguments and stopped.
  const raw = '{"command": "Select-String -Pattern \'Restart\'", "shell": " Greenville, NC, US\\n';
  const broken = call(raw);
  repairToolArguments(broken);
  const parsed = JSON.parse(broken.function.arguments); // must not throw
  assert.match(parsed[INVALID_ARGS_KEY].reason, /JSON/);
  assert.ok(parsed[INVALID_ARGS_KEY].received.startsWith('{"command": "Select-String'));
});

test('JSON that is not an object is repaired too', () => {
  for (const raw of ['"just a string"', '[1,2,3]', '42']) {
    const odd = call(raw);
    repairToolArguments(odd);
    const parsed = JSON.parse(odd.function.arguments);
    assert.ok(parsed[INVALID_ARGS_KEY], `${raw} should have been repaired`);
  }
});

test('empty arguments stay empty — a call with no arguments is legal', () => {
  const none = call('');
  repairToolArguments(none);
  assert.equal(none.function.arguments, '');
});

test('the repaired form survives a round trip through JSON', () => {
  const broken = call('{"command": "echo unterminated');
  repairToolArguments(broken);
  const message = { role: 'assistant', tool_calls: [broken] };
  assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
});
