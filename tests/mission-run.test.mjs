// A Mission Control chat keeps filing tickets after its first turn.
//
// A dwarf that said "I identified 6 tickets" filed none: file_ticket existed
// only on the run's first turn, so a wrap-up at the deadline, a resumed
// background task or "continue" from the user ran without it -- and only the
// first turn's report was ever read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissionStore } from '../src/mission.mjs';
import { Skadi } from '../src/server.mjs';

/** Enough of a Skadi to exercise the mission bookkeeping. */
function skadi() {
  const mission = new MissionStore(join(mkdtempSync(join(tmpdir(), 'mc-run-')), 'mission.json'));
  const agent = mission.upsertAgent({ name: 'Inky' });
  const s = {
    mission,
    agent,
    changed: 0,
    missionChanged() { this.changed++; },
  };
  for (const name of ['missionTools', 'missionFiled', 'missionFile', 'missionAfterTurn']) s[name] = Skadi.prototype[name];
  return s;
}

const session = (agent, room) => ({
  id: 'chat-1',
  mission: { agentId: agent.id, agentName: agent.name, room, projectId: 'p1' },
  messages: [],
});

test('every turn of a ticket room gets file_ticket and stays read-only', () => {
  const s = skadi();
  const chat = session(s.agent, 'research');
  const kit = s.missionTools(chat);
  assert.equal(kit.readOnly, true);
  assert.ok(kit.tools.file_ticket);
  assert.match(kit.tools.file_ticket.run({ title: 'Add dark mode', plain: 'p', summary: 's' }), /Filed ticket/);
  assert.match(kit.tools.file_ticket.run({ title: 'add DARK mode', plain: 'p', summary: 's' }), /Already filed/);
  assert.equal(s.missionFiled('chat-1').length, 1);
  assert.equal(s.mission.data.tickets[0].kind, 'idea');
});

test('a later turn that lists its findings files them, once', () => {
  const s = skadi();
  const chat = session(s.agent, 'research');
  // Turn one: the model only talks.
  chat.messages.push({ role: 'user', content: 'brief' }, { role: 'assistant', content: 'I identified 2 tickets, filing them now.' });
  s.missionAfterTurn(chat, chat.messages[0]);
  assert.equal(s.missionFiled('chat-1').length, 0);

  // Turn two (the reminder): the findings arrive as a block.
  const mark = { role: 'system', content: 'Mission Control: file your tickets' };
  chat.messages.push(mark, {
    role: 'assistant',
    content: 'Here they are:\n```json\n[{"title":"Cache search results","summary":"a"},{"title":"Add offline mode","plain":"b"},]\n```',
  });
  s.missionAfterTurn(chat, mark);
  assert.deepEqual(s.missionFiled('chat-1').map((t) => t.title), ['Cache search results', 'Add offline mode']);

  // The user deletes one; a turn that repeats the list does not bring it back.
  s.mission.setTicket(s.missionFiled('chat-1')[0].id, 'delete');
  const again = { role: 'user', content: 'continue' };
  chat.messages.push(again, { role: 'assistant', content: chat.messages.at(-1).content });
  s.missionAfterTurn(chat, again);
  assert.deepEqual(s.missionFiled('chat-1').map((t) => t.title), ['Add offline mode']);
});

test('development keeps report_ticket on later turns', () => {
  const s = skadi();
  const [t] = s.mission.addTickets([{ title: 'Fix crash', summary: 's' }], { agent: s.agent, projectId: 'p1', room: 'quality', sessionId: 'x' });
  s.mission.setTicket(t.id, 'approved');
  const chat = session(s.agent, 'development');
  chat.mission.ticketIds = [t.id];
  const kit = s.missionTools(chat);
  assert.equal(kit.readOnly, false);
  assert.match(kit.tools.report_ticket.run({ id: t.id, fixed: true, note: 'guarded the null' }), /fixed/);
  assert.equal(t.status, 'check');
  assert.equal(t.attempts.at(-1).sessionId, 'chat-1');
});
