import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForCompaction, clipTailToolOutputs, estimateTokens } from '../src/compaction.mjs';

const big = 'x'.repeat(200000);
const turn = (i) => [
  { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `c${i}`, content: big },
];

test('a tail of giant tool results is bounded by tokens, not just message count', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }, ...turn(1), ...turn(2), ...turn(3)];
  const { head, tail } = splitForCompaction(messages, 12, { tailTokens: 70000 });
  assert.ok(head.length > 0);
  assert.notEqual(tail[0].role, 'tool');
  assert.ok(estimateTokens(tail) <= 70000 + 1);
});

test('a single oversized tool result in the tail is clipped', () => {
  const tail = [...turn(1)];
  const clipped = clipTailToolOutputs(tail, 10000);
  assert.ok(estimateTokens(clipped) < 10000);
});
