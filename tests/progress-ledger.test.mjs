import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFingerprint,
  createProgressLedger,
  implementationRequest,
  observeToolRound,
  progressLedgerText,
} from '../src/progress-ledger.mjs';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('equivalent tool arguments have one deterministic fingerprint', () => {
  assert.equal(
    actionFingerprint(call('grep', { pattern: 'fileReveal', ignore_case: true })),
    actionFingerprint(call('grep', { ignore_case: true, pattern: 'fileReveal' })),
  );
});

test('the progress ledger catches repeated evidence without a model judgment', () => {
  const ledger = createProgressLedger('Fix Open location.');
  const action = call('read_file', { path: 'src/server.mjs', start_line: 3160, end_line: 3180 });
  assert.equal(observeToolRound(ledger, [action], [{ ok: true, content: 'same lines' }]).repeated, null);
  const repeat = observeToolRound(ledger, [action], [{ ok: true, content: 'same lines' }]).repeated;
  assert.equal(repeat.loop, true);
  assert.equal(repeat.strikes, 1);
  assert.match(repeat.reason, /same evidence/i);
});

test('repeating the same failed edit escalates instead of retrying forever', () => {
  const ledger = createProgressLedger('Implement the fix.');
  const action = call('edit_file', { path: 'src/server.mjs', old_string: 'missing', new_string: 'fixed' });
  const failed = { ok: false, content: 'Error: old_string not found' };
  observeToolRound(ledger, [action], [failed]);
  const first = observeToolRound(ledger, [action], [failed]).repeated;
  const second = observeToolRound(ledger, [action], [failed]).repeated;
  assert.equal(first.strikes, 1);
  assert.equal(second.strikes, 2);
  assert.match(second.next, /abandon/i);
});

test('implementation phases advance from discovery through edit and verification', () => {
  const ledger = createProgressLedger('Improve the agent.');
  assert.equal(implementationRequest(ledger.request), true);
  observeToolRound(ledger, [call('grep', { pattern: 'loop' })], [{ ok: true, content: 'src/agent.mjs:1' }]);
  assert.equal(ledger.phase, 'diagnose');
  observeToolRound(ledger, [call('edit_file', { path: 'src/agent.mjs', old_string: 'a', new_string: 'b' })], [{ ok: true, content: 'Edited' }]);
  assert.equal(ledger.phase, 'verify');
  observeToolRound(ledger, [call('run_command', { command: 'npm test' })], [{ ok: true, content: 'pass' }]);
  assert.equal(ledger.phase, 'complete');
  assert.match(progressLedgerText(ledger), /Material edits: 1; post-edit verification actions: 1/);
});
