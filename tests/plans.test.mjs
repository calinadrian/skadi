import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyPlanAction, normalisePlan, planPrompt, planStatus, PlanNotice } from '../src/plans.mjs';
import { buildTools } from '../src/tools.mjs';
import { Skadi } from '../src/server.mjs';

const ids = (() => {
  let n = 0;
  return () => `step-${++n}`;
})();

test('plans support set, edit, status, reorder, delete, and restore', () => {
  let plan = applyPlanAction(null, {
    action: 'set',
    items: ['Inspect the current flow', 'Implement the panel', 'Verify it'],
  }, { makeId: ids });
  assert.deepEqual(plan.items.map((item) => item.text), [
    'Inspect the current flow', 'Implement the panel', 'Verify it',
  ]);

  const second = plan.items[1].id;
  plan = applyPlanAction(plan, { action: 'edit', itemId: second, text: 'Implement the editable panel' }, { source: 'user' });
  plan = applyPlanAction(plan, { action: 'status', itemId: second, status: 'working', note: 'Backend is connected' });
  assert.equal(plan.items[1].status, 'working');
  assert.equal(plan.items[1].note, 'Backend is connected');

  const first = plan.items[0].id;
  plan = applyPlanAction(plan, { action: 'status', itemId: first, status: 'working' });
  assert.equal(plan.items.find((item) => item.id === second).status, 'queued', 'only one step may be working');
  assert.equal(plan.items.find((item) => item.id === first).status, 'working');

  plan = applyPlanAction(plan, { action: 'move', itemId: first, index: 2 }, { source: 'user' });
  assert.equal(plan.items[2].id, first);
  plan = applyPlanAction(plan, { action: 'remove', itemId: second }, { source: 'user' });
  assert.equal(plan.items.some((item) => item.id === second), false);
  assert.equal(plan.deleted[0].item.id, second);
  plan = applyPlanAction(plan, { action: 'restore', itemId: second }, { source: 'user' });
  assert.equal(plan.items.some((item) => item.id === second), true);
  assert.equal(plan.deleted.length, 0);
});

test('an agent cannot replace a plan after the user edits it', () => {
  let plan = applyPlanAction(null, { action: 'set', items: ['First', 'Second'] }, { makeId: ids });
  plan = applyPlanAction(plan, { action: 'add', text: 'User priority' }, { source: 'user', makeId: ids });
  assert.throws(
    () => applyPlanAction(plan, { action: 'set', items: ['Start over'] }, { source: 'agent', makeId: ids }),
    /user has edited/,
  );
});

test('a stale agent update cannot revive a step the user skipped', () => {
  let plan = applyPlanAction(null, { action: 'set', items: ['Optional research', 'Build'] }, { makeId: ids });
  const optional = plan.items[0].id;
  plan = applyPlanAction(plan, { action: 'status', itemId: optional, status: 'skipped' }, { source: 'user' });
  assert.throws(
    () => applyPlanAction(plan, { action: 'status', itemId: optional, status: 'done' }, { source: 'agent' }),
    /user skipped/,
  );
  assert.equal(plan.items[0].status, 'skipped');
});

test('normalisation bounds persisted plan data and live guidance is explicit', () => {
  const plan = normalisePlan({
    revision: -9,
    items: [{ id: 'a', text: '  Work   carefully  ', status: 'working' }, { id: 'a', text: 'duplicate' }, { text: '' }],
  });
  assert.equal(plan.revision, 0);
  assert.deepEqual(plan.items.map((item) => item.text), ['Work carefully']);
  assert.match(planPrompt(plan), /1\. \[now\] Work carefully/);
  assert.match(planPrompt(plan), /You are on step 1/);
  assert.match(planPrompt(plan), /Never do skipped work/);
});

test('update_plan is available only when the parent supplies a plan callback', async () => {
  let request = null;
  const parent = buildTools({ workspace: process.cwd(), settings: {}, tasks: null, updatePlan: async (value) => {
    request = value;
    return { revision: 1, items: [] };
  } });
  assert.ok(parent.update_plan);
  const result = await parent.update_plan.run({ action: 'add', text: 'A step' });
  assert.deepEqual(request, { action: 'add', text: 'A step' });
  assert.match(result, /^Plan saved/);
  assert.equal(buildTools({ workspace: process.cwd(), settings: {}, tasks: null }).update_plan, undefined);
});

test('a user plan edit mutates the live session, persists and broadcasts without a fake user message', async () => {
  const session = { id: 'chat-1', messages: [], plan: normalisePlan() };
  const events = [];
  const steers = [];
  let saved = 0;
  const skadi = {
    turns: new Map([['chat-1', { session, agent: { running: true, steer: (text) => steers.push(text) } }]]),
    sessions: { save: async () => { saved++; } },
    liveSession: Skadi.prototype.liveSession,
    mutateSession: Skadi.prototype.mutateSession,
    broadcast: (type, data) => events.push({ type, data }),
  };
  const plan = await Skadi.prototype.updateSessionPlan.call(skadi, 'chat-1', { action: 'add', text: 'User step' }, { source: 'user' });
  assert.equal(plan.items[0].text, 'User step');
  assert.equal(plan.userEdited, true);
  assert.equal(saved, 1);
  assert.equal(events[0].type, 'session_plan');
  assert.deepEqual(steers, [], 'the plan reaches the model through the live guidance, not the transcript');
});

test('the Workspace exposes an accessible editable Plan surface', async () => {
  const [html, js, css] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../ui/style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-tool="plan"/);
  assert.match(html, /id="planList"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(js, /Move step \$\{number\} up/);
  assert.match(js, /Mark step \$\{number\} as done/);
  assert.match(js, /quiet\(/, 'plan edits report problems as toasts, not chat errors');
  assert.match(js, /action, \.\.\.extra/);
  assert.match(js, /planAction\('restore'/);
  assert.match(css, /\.plan-item\.status-working/);
  assert.match(css, /@media \(max-width: 520px\)/);
});

test('small-model spellings: step numbers, status synonyms and auto-advance', () => {
  let plan = applyPlanAction(null, { action: 'set', steps: ['Find the bug', 'Fix it', 'Run the tests'] }, { makeId: ids });
  assert.equal(plan.items[0].status, 'working', 'a fresh agent plan starts on step 1');
  plan = applyPlanAction(plan, { action: 'status', step: 1, status: 'completed' });
  assert.equal(plan.items[0].status, 'done');
  assert.equal(plan.items[1].status, 'working', 'finishing a step starts the next one');
  plan = applyPlanAction(plan, { action: 'status', itemId: '#2', status: 'in_progress' });
  assert.equal(plan.items[1].status, 'working');
  plan = applyPlanAction(plan, { action: 'status', itemId: 'Run the tests', status: 'pending' });
  assert.equal(plan.items[2].status, 'queued');
  assert.equal(planStatus('Not Started'), 'queued');
  assert.equal(planStatus('nonsense'), '');
});

test('agent conflicts are notices carrying the current plan, not raw errors', async () => {
  let plan = applyPlanAction(null, { action: 'set', steps: ['One', 'Two'] }, { makeId: ids });
  assert.throws(() => applyPlanAction(plan, { action: 'status', step: 9, status: 'done' }), (err) => {
    assert.ok(err instanceof PlanNotice);
    assert.match(err.message, /steps are numbered 1-2/);
    assert.equal(err.plan.items.length, 2);
    return true;
  });
  plan = applyPlanAction(plan, { action: 'status', step: 2, status: 'skipped' }, { source: 'user' });
  const tools = buildTools({ workspace: process.cwd(), settings: {}, tasks: null, updatePlan: async (request) => applyPlanAction(plan, request) });
  const result = await tools.update_plan.run({ action: 'status', step: 2, status: 'done' });
  assert.match(result, /^Plan not changed: the user skipped step 2/);
  assert.match(result, /2\. \[skipped\] Two \(from the user\)/);
});

test('only the user can clear a plan, which hands it back to the agent', () => {
  let plan = applyPlanAction(null, { action: 'set', steps: ['One'] }, { source: 'user', makeId: ids });
  assert.throws(() => applyPlanAction(plan, { action: 'clear' }), PlanNotice);
  plan = applyPlanAction(plan, { action: 'clear' }, { source: 'user' });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.userEdited, false);
  plan = applyPlanAction(plan, { action: 'set', steps: ['Fresh'] }, { makeId: ids });
  assert.equal(plan.items[0].text, 'Fresh');
});
