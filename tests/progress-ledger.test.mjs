import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionFingerprint,
  applyLedgerOverride,
  completionGaps,
  ledgerSnapshot,
  seedLedger,
  createProgressLedger,
  implementationRequest,
  incompleteCompletion,
  objectiveFromMessages,
  observeToolRound,
  progressLedgerText,
  taskBudgets,
  taskComplexity,
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
  assert.match(progressLedgerText(ledger), /material deliverable edits: 1; valid post-edit verification actions: 1/i);
});

test('task sizing keeps a small fix tight and gives a researched website room', () => {
  assert.equal(taskComplexity('Fix the Open location button.'), 'easy');
  assert.equal(taskComplexity('Add a settings panel and verify it.'), 'medium');
  assert.equal(
    taskComplexity('Build a TFT website from scratch using current patch data, real icons, and multiple pages.'),
    'hard',
  );
  assert.deepEqual(taskBudgets({ maxToolRounds: 8, maxImplementationDiscoveryRounds: 4 }, 'easy'), {
    maxRounds: 8,
    discoveryRounds: 4,
  });
  assert.deepEqual(taskBudgets({ maxToolRounds: 8, maxImplementationDiscoveryRounds: 4 }, 'medium'), {
    maxRounds: 16,
    discoveryRounds: 6,
  });
  assert.deepEqual(taskBudgets({ maxToolRounds: 8, maxImplementationDiscoveryRounds: 4 }, 'hard'), {
    maxRounds: 30,
    discoveryRounds: 8,
  });
});

test('continuation turns retain the substantive implementation objective', () => {
  assert.match(objectiveFromMessages([
    { role: 'user', content: 'Build a TFT website with current comps, real icons, and multiple pages.' },
    { role: 'assistant', content: 'Working.' },
    { role: 'user', content: [{ type: 'image', data: 'x' }, { type: 'text', text: 'Screenshot of the current page.' }] },
    { role: 'user', content: 'continue' },
  ]), /Build a TFT website/);
});

test('hard-task completion gaps are detected instead of presented as success', () => {
  assert.equal(incompleteCompletion('One honest gap: the actual meta content is still empty.'), true);
  assert.equal(incompleteCompletion("I hit a blocker and can't responsibly build this before I have the data."), true);
  assert.equal(incompleteCompletion('Implemented the requested data and verified both pages.'), false);
});

test('placeholder website data remains an explicit completion gap', () => {
  const ledger = createProgressLedger('Build a current TFT website with real comps and icons.');
  observeToolRound(ledger, [call('write_file', {
    path: 'js/data.js',
    content: 'window.META = { openers: [], comps: [] };',
  })], [{ ok: true, content: 'Created js/data.js' }]);
  observeToolRound(ledger, [call('browser_read', {})], [{
    ok: true,
    content: 'Meta data for patch 18.2 will appear here.',
  }]);
  assert.equal(ledger.phase, 'implement');
  assert.match(progressLedgerText(ledger), /js\/data\.js: placeholder/i);
  assert.match(progressLedgerText(ledger), /rendered output.*placeholder/i);
});

test('research downloads and dev-server commands do not count as verification', () => {
  const ledger = createProgressLedger('Build a current TFT website with real comps and icons.');
  observeToolRound(ledger, [call('write_file', { path: 'index.html', content: '<h1>TFT</h1>' })], [{ ok: true, content: 'Created' }]);
  observeToolRound(ledger, [call('run_command', { command: "Invoke-WebRequest 'https://example.com/data'" })], [{ ok: true, content: 'downloaded' }]);
  observeToolRound(ledger, [call('run_command', { command: 'node server.js' })], [{ ok: true, content: 'started' }]);
  assert.equal(ledger.verifications, 0);
  observeToolRound(ledger, [call('run_command', { command: 'node --test tests/site.test.mjs' })], [{ ok: true, content: 'pass' }]);
  assert.equal(ledger.verifications, 1);
});

test('debug check files do not satisfy the deliverable edit requirement', () => {
  const ledger = createProgressLedger('Build a current TFT website with real comps and icons.');
  observeToolRound(ledger, [call('write_file', {
    path: 'tft/_check.html',
    content: '<title>image matrix</title>',
  })], [{ ok: true, content: 'Created tft/_check.html' }]);
  assert.equal(ledger.mutations, 1);
  assert.equal(ledger.materialMutations, 0);
  assert.equal(ledger.firstMaterialMutationRound, 0);
  assert.equal(ledger.phase, 'locate');
});

test('a compacted transcript still yields the implementation objective', () => {
  const objective = objectiveFromMessages([
    { role: 'assistant', content: ['[Compacted context - 2026-09-20 20:16]', '', '# Continuation Summary', '', '## User Goal', 'Build and fix the TFT site so every image loads.', '', '## Status', 'research done'].join(String.fromCharCode(10)) },
    { role: 'user', content: 'continue' },
  ]);
  assert.match(objective, /Build and fix the TFT site/);
  assert.equal(createProgressLedger(objective).implementation, true);
});

test('the ledger text says an unedited implementation is not complete', () => {
  const ledger = createProgressLedger('Fix the broken images on the site.');
  assert.doesNotMatch(progressLedgerText(ledger), /NOT complete/);
  ledger.rounds = 3;
  assert.match(progressLedgerText(ledger), /NOT complete: no deliverable file has been edited/);
  ledger.materialMutations = 1;
  assert.doesNotMatch(progressLedgerText(ledger), /NOT complete/);
});

test('words like todo in test output or diffs do not raise a rendered-output gap', () => {
  const ledger = createProgressLedger('Fix the prune bug in edits.');
  observeToolRound(ledger, [call('run_command', { command: 'git diff' })], [{ ok: true, content: '+ // TODO: tidy this placeholder' }]);
  assert.deepEqual(completionGaps(ledger), []);
});

test('a rendered placeholder gap is cleared by a passing verification command', () => {
  const ledger = createProgressLedger('Fix the page layout.');
  observeToolRound(ledger, [call('edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' })], [{ ok: true, content: 'ok' }]);
  observeToolRound(ledger, [call('browser_read', {})], [{ ok: true, content: 'Results will appear here' }]);
  assert.equal(completionGaps(ledger).length, 1);
  observeToolRound(ledger, [call('run_command', { command: 'npm test' })], [{ ok: true, content: 'pass 3' }]);
  assert.deepEqual(completionGaps(ledger), []);
});

test('user-dismissed gaps stay dismissed and the user note reaches the agent', () => {
  const ledger = createProgressLedger('Fix the page layout.');
  observeToolRound(ledger, [call('browser_read', {})], [{ ok: true, content: 'Results will appear here' }]);
  applyLedgerOverride(ledger, { dismissed: ['(rendered output)'], note: 'Already verified by hand.', phase: 'complete' });
  assert.deepEqual(completionGaps(ledger), []);
  observeToolRound(ledger, [call('browser_read', {})], [{ ok: true, content: 'Results will appear here' }]);
  assert.deepEqual(completionGaps(ledger), []);
  const text = progressLedgerText(ledger);
  assert.match(text, /Already verified by hand/);
  assert.equal(ledger.phase, 'complete');
});

test('saved counters seed a new run of the same objective only', () => {
  const first = createProgressLedger('Fix the prune bug in edits.');
  observeToolRound(first, [call('edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' })], [{ ok: true, content: 'ok' }]);
  const snapshot = ledgerSnapshot(first);
  assert.equal(seedLedger(createProgressLedger('Fix the prune bug in edits.'), snapshot).materialMutations, 1);
  assert.equal(seedLedger(createProgressLedger('Add a dark theme.'), snapshot).materialMutations, 0);
});
