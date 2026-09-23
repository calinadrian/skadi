import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTickets, roomBrief, MissionStore } from '../src/mission.mjs';

test('parseTickets reads the fenced tickets block', () => {
  const text = 'Report...\n```tickets\n[{"title":"Add pause","plain":"Players can stop the game","summary":"s","priority":"HIGH"},{"summary":"no title"}]\n```';
  assert.deepEqual(parseTickets(text), [{ title: 'Add pause', plain: 'Players can stop the game', summary: 's', details: '', priority: 'high' }]);
});

test('parseTickets tolerates junk', () => {
  assert.deepEqual(parseTickets('no json here'), []);
  assert.deepEqual(parseTickets('```tickets\n[not json]\n```'), []);
});

test('parseTickets forgives the ways models actually write the block', () => {
  // A "]" inside a string, a trailing comma and a ```json fence.
  const text = 'I identified 2 tickets.\n```json\n[\n {"title":"Support [x] syntax","summary":"a"},\n {"title":"Cache results","plain":"faster","priority":"low"},\n]\n```\nThanks!';
  assert.deepEqual(parseTickets(text).map((t) => t.title), ['Support [x] syntax', 'Cache results']);
  // Wrapped in an object, fence with no language.
  assert.deepEqual(parseTickets('```\n{"tickets":[{"title":"Add dark mode","summary":"s"}]}\n```').map((t) => t.title), ['Add dark mode']);
  // Bare array in prose, no fence at all.
  assert.deepEqual(parseTickets('Findings: [{"title":"Fix crash","details":"on empty input"}] done').map((t) => t.title), ['Fix crash']);
  // The last block that holds tickets wins over an unrelated later one.
  assert.deepEqual(parseTickets('```tickets\n[{"title":"Real one","summary":"s"}]\n```\n```js\nconst x = [1];\n```').map((t) => t.title), ['Real one']);
});

test('parseTickets ignores quoted JSON that is not ticket-shaped', () => {
  // Search results or API output with a title field are not tickets...
  assert.deepEqual(parseTickets('The API returned:\n```json\n[{"title":"Issue 12","url":"https://x"}]\n```'), []);
  // ...unless the model put them in a tickets block itself.
  assert.deepEqual(parseTickets('```tickets\n[{"title":"Only a title"}]\n```').map((t) => t.title), ['Only a title']);
});

test('development brief lists approved tickets; store round-trips', () => {
  const store = new MissionStore(join(mkdtempSync(join(tmpdir(), 'mc-')), 'mission.json'));
  const agent = store.upsertAgent({ name: 'Inky', description: 'dev' });
  const [t] = store.addTickets([{ title: 'Fix wall collision', summary: 'x', priority: 'high' }], { agent, projectId: 'p1', room: 'quality', sessionId: 's' });
  assert.equal(t.kind, 'bug');
  store.setTicket(t.id, 'approved');
  const brief = roomBrief('development', { agent, project: { name: 'Snake', path: 'C:/snake' }, approved: store.approvedFor('p1') });
  assert.match(brief, /Fix wall collision/);
  assert.equal(new MissionStore(store.file).data.tickets[0].status, 'approved');
});

test('a reported fix waits for the user; a failed one stays approved with the reason', () => {
  const store = new MissionStore(join(mkdtempSync(join(tmpdir(), 'mc-')), 'mission.json'));
  const agent = store.upsertAgent({ name: 'Brokk' });
  const [fix, stuck] = store.addTickets([{ title: 'A', summary: 'a' }, { title: 'B', summary: 'b' }], { agent, projectId: 'p1', room: 'quality', sessionId: 's' });
  store.setTicket(fix.id, 'approved');
  store.setTicket(stuck.id, 'approved');

  store.recordAttempt(fix.id, { outcome: 'fixed', note: 'changed loop start', agent, sessionId: 'run1' });
  store.recordAttempt(stuck.id, { outcome: 'not-fixed', note: 'needs a design decision', agent, sessionId: 'run1' });
  assert.equal(fix.status, 'check');
  assert.equal(stuck.status, 'approved');
  assert.equal(stuck.attempts[0].note, 'needs a design decision');
  assert.deepEqual(store.approvedFor('p1').map((t) => t.id), [stuck.id]);

  // A second report in the same run replaces the first.
  store.recordAttempt(stuck.id, { outcome: 'fixed', note: 'found a way', agent, sessionId: 'run1' });
  assert.equal(stuck.attempts.length, 1);
  assert.equal(stuck.status, 'check');

  // Leaving "check" records the user's verdict.
  store.setTicket(fix.id, 'done');
  store.setTicket(stuck.id, 'approved');
  assert.equal(fix.attempts.at(-1).verdict, 'accepted');
  assert.equal(stuck.attempts.at(-1).verdict, 'rejected');
});
