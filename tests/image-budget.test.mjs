// A screenshot is cheap in tokens and vast in bytes, so a browsing chat can
// sail past a gateway's request-size limit while the context meter still reads
// a third full. Measured against OpenRouter: 16k prompt tokens carrying 9.8MB
// of images is refused with a 502 on every single retry, while the same chat
// at 7.4MB goes through. These tests pin the trimming that keeps it under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitImageBudget } from '../src/providers.mjs';

/** An image block of a given base64 size. */
const img = (bytes, tag = 'x') => ({ type: 'image', mediaType: 'image/jpeg', data: tag.repeat(bytes) });
const shot = (bytes, tag) => ({ role: 'user', content: [{ type: 'text', text: 'look' }, img(bytes, tag)] });

const imagesIn = (messages) => messages.flatMap((m) =>
  (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'image'));
const bytesIn = (messages) => imagesIn(messages).reduce((n, b) => n + b.data.length, 0);

test('a conversation already under budget is returned untouched', () => {
  const messages = [shot(100, 'a'), shot(100, 'b')];
  assert.equal(fitImageBudget(messages, 1000), messages, 'the same array, not a copy');
});

test('the oldest images go first, and the newest are kept', () => {
  const messages = [shot(100, 'a'), shot(100, 'b'), shot(100, 'c')];
  const out = fitImageBudget(messages, 250);
  const kept = imagesIn(out).map((b) => b.data[0]);
  assert.deepEqual(kept, ['b', 'c'], 'the recent screenshot is the one being talked about');
  assert.ok(bytesIn(out) <= 250);
});

test('what is dropped says so, in place, rather than vanishing', () => {
  const out = fitImageBudget([shot(100, 'a'), shot(100, 'b')], 100);
  const first = out[0].content;
  assert.equal(first.length, 2, 'the block is replaced, not removed');
  assert.equal(first[0].text, 'look', 'the text beside it is untouched');
  assert.equal(first[1].type, 'text');
  assert.match(first[1].text, /screenshot omitted/i);
  assert.match(first[1].text, /still in the chat/i);
});

test('the original messages are never mutated', () => {
  const messages = [shot(100, 'a'), shot(100, 'b')];
  const before = JSON.stringify(messages);
  fitImageBudget(messages, 100);
  assert.equal(JSON.stringify(messages), before, 'the transcript is not what is being trimmed');
});

test('messages that carry no image are left alone entirely', () => {
  const messages = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'plain string content' },
    shot(500, 'a'),
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const out = fitImageBudget(messages, 10);
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1], 'string content is not touched');
  assert.equal(out[3], messages[3]);
  assert.equal(imagesIn(out).length, 0, 'the one oversized image is the only casualty');
});

test('a single image larger than the whole budget is dropped, not sent', () => {
  const out = fitImageBudget([shot(5000, 'a')], 1000);
  assert.equal(imagesIn(out).length, 0);
  assert.match(out[0].content[1].text, /omitted/i);
});

test('a budget of zero or nonsense turns trimming off rather than dropping everything', () => {
  const messages = [shot(100, 'a')];
  assert.equal(fitImageBudget(messages, 0), messages);
  assert.equal(fitImageBudget(messages, -1), messages);
  assert.equal(fitImageBudget(messages, NaN), messages);
});

test('the real shape: many screenshots, budget honoured exactly', () => {
  // Twelve half-megabyte screenshots -- the chat that produced the 502.
  const half = 512 * 1024;
  const messages = Array.from({ length: 12 }, (_, i) => shot(half, String.fromCharCode(97 + i)));
  assert.equal(bytesIn(messages), 12 * half);

  const budget = 4 * 1024 * 1024;
  const out = fitImageBudget(messages, budget);
  assert.ok(bytesIn(out) <= budget, 'under the ceiling');
  assert.equal(imagesIn(out).length, 8, '4MB / 512KB = the eight newest');
  assert.equal(out.length, messages.length, 'no message is lost, only its image');
});
