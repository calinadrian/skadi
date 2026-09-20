import test from 'node:test';
import assert from 'node:assert/strict';

import { parseProgressReview, progressReviewInput, progressReviewPrompt } from '../src/progress-review.mjs';

test('progress review compares the latest action to the original request', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'Fix Open location.' },
    { role: 'assistant', tool_calls: [{ function: { name: 'grep', arguments: '{"pattern":"fileReveal"}' } }] },
    { role: 'tool', content: 'ui/app.js:10 fileReveal' },
  ];
  const input = progressReviewInput(messages, 2, 'Phase: diagnose');
  assert.equal(input.request, 'Fix Open location.');
  assert.match(input.current, /grep/);
  assert.match(progressReviewPrompt(input), /semantic/i);
  assert.match(progressReviewPrompt(input), /Phase: diagnose/);
});

test('progress review accepts fenced or surrounding JSON', () => {
  assert.deepEqual(
    parseProgressReview('```json\n{"loop":true,"reason":"same file again","next":"test the endpoint"}\n```'),
    { loop: true, reason: 'same file again', next: 'test the endpoint' },
  );
});

test('invalid supervisor output fails open instead of stopping work', () => {
  assert.equal(parseProgressReview('I am not sure.'), null);
  assert.equal(parseProgressReview('{"reason":"missing decision"}'), null);
});
