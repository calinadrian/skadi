import test from 'node:test';
import assert from 'node:assert/strict';

import { delegationPrompt, parseDelegation } from '../src/delegation.mjs';

test('delegation router is explicitly scoped to independent read-only work', () => {
  const prompt = delegationPrompt('Find where Open location is implemented, then fix it.');
  assert.match(prompt, /read-only subagent/i);
  assert.match(prompt, /code-location/i);
  assert.match(prompt, /Do not delegate.*changing files/i);
});

test('delegation parser keeps the chosen reasoning level', () => {
  assert.deepEqual(
    parseDelegation('{"delegate":true,"task":"Find the handler and endpoint.","reasoning":"low"}'),
    { delegate: true, task: 'Find the handler and endpoint.', reasoning: 'low' },
  );
});

test('delegation parser defaults unknown effort to none and fails open', () => {
  assert.deepEqual(
    parseDelegation('{"delegate":false,"task":"","reasoning":"turbo"}'),
    { delegate: false, task: '', reasoning: 'none' },
  );
  assert.equal(parseDelegation('not json'), null);
});
