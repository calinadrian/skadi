// Persistent, user-editable execution plans. Plans live beside a session's
// transcript so they survive restarts without becoming chat messages. Both the
// agent tool and the UI use the same reducer, which keeps their behaviour in
// lockstep and makes mid-turn edits deterministic.
//
// Small local models are the main audience of the agent side, so the reducer
// is forgiving about how a step is named (a 1-based number, "#2", "step 2", an
// id, or the step's text) and about status spellings borrowed from other
// harnesses ("in_progress", "completed", "pending"). Anything it still cannot
// apply is a PlanNotice: a plain explanation plus the current plan, returned
// to the model as ordinary tool output rather than a red error in the chat.
import { randomUUID } from 'node:crypto';

export const PLAN_STATUSES = ['queued', 'working', 'blocked', 'review', 'done', 'skipped'];
const STATUS = new Set(PLAN_STATUSES);
const MAX_ITEMS = 50;

// Spellings models reach for, mapped onto the six statuses above.
const STATUS_ALIASES = {
  pending: 'queued', todo: 'queued', 'to do': 'queued', not_started: 'queued', 'not started': 'queued', open: 'queued', next: 'queued',
  in_progress: 'working', 'in progress': 'working', 'in-progress': 'working', inprogress: 'working', active: 'working',
  doing: 'working', current: 'working', started: 'working', start: 'working', now: 'working', running: 'working',
  completed: 'done', complete: 'done', finished: 'done', finish: 'done', success: 'done', succeeded: 'done', ok: 'done',
  failed: 'blocked', stuck: 'blocked', error: 'blocked', waiting: 'blocked',
  needs_review: 'review', 'needs review': 'review', verify: 'review',
  skip: 'skipped', cancelled: 'skipped', canceled: 'skipped', removed: 'skipped', dropped: 'skipped', 'n/a': 'skipped',
};

/** Map a status spelling onto a known status, or '' when it cannot be read. */
export function planStatus(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (STATUS.has(key)) return key;
  return STATUS_ALIASES[key] || STATUS_ALIASES[key.replace(/[-\s]+/g, '_')] || '';
}

/** A soft refusal: the plan is unchanged, and the message says why. */
export class PlanNotice extends Error {
  constructor(message, plan) {
    super(message);
    this.name = 'PlanNotice';
    this.plan = plan;
  }
}

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const itemId = () => `p-${randomUUID().slice(0, 8)}`;

function normaliseItem(raw = {}, makeId = itemId) {
  const text = clean(typeof raw === 'string' ? raw : raw.text ?? raw.step ?? raw.title, 240);
  if (!text) return null;
  return {
    id: clean(raw.id, 80) || makeId(),
    text,
    status: planStatus(raw.status) || 'queued',
    note: clean(raw.note, 500),
    required: raw.required !== false,
    userEdited: Boolean(raw.userEdited),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export function normalisePlan(raw = null) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const items = [];
  for (const value of Array.isArray(source.items) ? source.items : []) {
    const item = normaliseItem(value);
    if (!item || seen.has(item.id) || items.length >= MAX_ITEMS) continue;
    seen.add(item.id);
    items.push(item);
  }
  const deleted = [];
  for (const value of Array.isArray(source.deleted) ? source.deleted : []) {
    const item = normaliseItem(value?.item);
    if (!item || deleted.length >= 10) continue;
    deleted.push({ item, index: Math.max(0, Number(value.index) || 0), removedAt: Number(value.removedAt) || Date.now() });
  }
  return {
    version: 1,
    revision: Math.max(0, Number(source.revision) || 0),
    updatedAt: Number(source.updatedAt) || 0,
    userEdited: Boolean(source.userEdited),
    items,
    deleted,
  };
}

/**
 * Find the step a request means. Accepts an id, a 1-based `step` number, a
 * number written as an id ("2", "#2", "step 2"), or the step's exact text.
 */
function findItem(plan, request) {
  const byIndex = (n) => (Number.isInteger(n) && n >= 1 && n <= plan.items.length ? n - 1 : -1);
  let index = -1;
  const id = typeof request.itemId === 'number' ? String(request.itemId) : clean(request.itemId, 80);
  if (id) index = plan.items.findIndex((item) => item.id === id);
  if (index < 0 && request.step !== undefined && request.step !== null && request.step !== '') {
    index = byIndex(Number(String(request.step).replace(/^\D+/, '')));
  }
  if (index < 0 && id) {
    const numbered = /^(?:#|step\s*|p)?(\d{1,3})$/i.exec(id);
    if (numbered) index = byIndex(Number(numbered[1]));
  }
  if (index < 0 && id) {
    const wanted = id.toLowerCase();
    index = plan.items.findIndex((item) => item.text.toLowerCase() === wanted);
  }
  if (index < 0) {
    const named = request.step ?? request.itemId;
    const range = plan.items.length ? `steps are numbered 1-${plan.items.length}` : 'the plan is empty; use action "set" first';
    throw new PlanNotice(`there is no step ${named === undefined || named === '' ? '(none given)' : JSON.stringify(named)}; ${range}`, plan);
  }
  return { item: plan.items[index], index };
}

/** After a step finishes, the next open step becomes the current one. */
function advance(plan) {
  if (plan.items.some((item) => item.status === 'working')) return;
  const next = plan.items.find((item) => item.status === 'queued');
  if (next) next.status = 'working';
}

/**
 * Apply one agent or UI action and return a fresh serialisable plan.
 * Throws PlanNotice when an agent request conflicts with the user's edits or
 * names a step that does not exist; the plan itself is never half-applied.
 */
export function applyPlanAction(current, request = {}, { source = 'agent', makeId = itemId } = {}) {
  const plan = normalisePlan(current);
  const agent = source !== 'user';
  const action = clean(request.action, 24).toLowerCase();
  const now = Date.now();
  const notice = (message) => new PlanNotice(message, plan);

  if (action === 'set' || action === 'create') {
    if (agent && plan.items.length && plan.userEdited) {
      throw notice('the user has edited this plan, so it was kept as it is. Update the existing steps with action "status" instead of replacing them');
    }
    const next = [];
    const values = Array.isArray(request.steps) ? request.steps : Array.isArray(request.items) ? request.items : [];
    for (const value of values) {
      const item = normaliseItem(value, makeId);
      if (item && next.length < MAX_ITEMS) next.push(item);
    }
    if (!next.length) throw notice('a plan needs at least one step; pass "steps" as a list of short strings');
    if (!agent) for (const item of next) item.userEdited = true;
    // A fresh agent plan starts on its first step without a second call.
    if (agent) advance({ items: next });
    plan.items = next;
  } else if (action === 'add') {
    if (plan.items.length >= MAX_ITEMS) throw notice(`a plan can contain at most ${MAX_ITEMS} steps`);
    const item = normaliseItem({
      text: request.text,
      status: request.status,
      note: request.note,
      required: request.required,
    }, makeId);
    if (!item) throw notice('the new step needs "text"');
    if (!agent) item.userEdited = true;
    const position = Number.isInteger(request.index)
      ? request.index
      : Number.isInteger(request.step) ? request.step - 1 : plan.items.length;
    plan.items.splice(Math.max(0, Math.min(position, plan.items.length)), 0, item);
  } else if (action === 'edit') {
    const { item } = findItem(plan, request);
    if (agent && item.userEdited) throw notice(`the user wrote step ${plan.items.indexOf(item) + 1}; keep its text`);
    const text = clean(request.text, 240);
    if (!text) throw notice('the edited step needs "text"');
    item.text = text;
    if (request.note !== undefined) item.note = clean(request.note, 500);
    if (request.required !== undefined) item.required = request.required !== false;
    item.updatedAt = now;
    if (!agent) item.userEdited = true;
  } else if (action === 'status' || action === 'update' || action === 'done' || action === 'start') {
    const wanted = action === 'done' ? 'done' : action === 'start' ? 'working' : request.status;
    const status = planStatus(wanted);
    if (!status) throw notice(`"${clean(wanted, 30) || '(missing)'}" is not a status; use one of ${PLAN_STATUSES.join(', ')}`);
    const { item } = findItem(plan, request);
    if (agent && item.userEdited && item.status === 'skipped' && status !== 'skipped') {
      throw notice(`the user skipped step ${plan.items.indexOf(item) + 1}; leave it skipped and do not do that work`);
    }
    if (status === 'working') {
      for (const other of plan.items) {
        if (other.id !== item.id && other.status === 'working') other.status = 'queued';
      }
    }
    item.status = status;
    if (request.note !== undefined) item.note = clean(request.note, 500);
    item.updatedAt = now;
    if (!agent) item.userEdited = true;
    if (agent && ['done', 'skipped'].includes(status)) advance(plan);
  } else if (action === 'move') {
    if (agent && plan.userEdited) throw notice('the user arranged this plan; keep its order');
    const { item, index } = findItem(plan, request);
    const to = Math.max(0, Math.min(Number(request.index) || 0, plan.items.length - 1));
    plan.items.splice(index, 1);
    plan.items.splice(to, 0, item);
    item.updatedAt = now;
  } else if (action === 'remove' || action === 'delete') {
    if (agent && plan.userEdited) throw notice('the user edited this plan; mark a step "skipped" instead of deleting it');
    const { item, index } = findItem(plan, request);
    plan.items.splice(index, 1);
    plan.deleted.unshift({ item, index, removedAt: now });
    plan.deleted = plan.deleted.slice(0, 10);
  } else if (action === 'restore') {
    const deletedIndex = request.itemId
      ? plan.deleted.findIndex((entry) => entry.item.id === request.itemId)
      : 0;
    if (deletedIndex < 0 || !plan.deleted[deletedIndex]) throw notice('there is no deleted step to restore');
    const [entry] = plan.deleted.splice(deletedIndex, 1);
    const index = Math.max(0, Math.min(entry.index, plan.items.length));
    const restored = { ...entry.item, updatedAt: now };
    if (restored.status === 'working' && plan.items.some((item) => item.status === 'working')) restored.status = 'queued';
    plan.items.splice(index, 0, restored);
  } else if (action === 'clear') {
    if (agent) throw notice('only the user can clear the plan; mark steps "skipped" instead');
    // Clearing hands the plan back: the agent may write a fresh one.
    plan.items = [];
    plan.deleted = [];
    plan.userEdited = false;
    plan.revision += 1;
    plan.updatedAt = now;
    return plan;
  } else {
    throw notice(`unknown action "${action || '(empty)'}"; use set, status, add or edit`);
  }

  plan.revision += 1;
  plan.updatedAt = now;
  if (!agent) plan.userEdited = true;
  return plan;
}

const MARK = { queued: 'todo', working: 'now', blocked: 'blocked', review: 'review', done: 'done', skipped: 'skipped' };

/** The plan as a short numbered checklist, the shape small models follow best. */
export function planText(raw) {
  const plan = normalisePlan(raw);
  if (!plan.items.length) return '(no plan)';
  return plan.items.map((item, index) => {
    const tags = [item.required ? '' : 'optional', item.userEdited ? 'from the user' : ''].filter(Boolean);
    return `${index + 1}. [${MARK[item.status]}] ${item.text}${tags.length ? ` (${tags.join(', ')})` : ''}${item.note ? ` - ${item.note}` : ''}`;
  }).join('\n');
}

/** What update_plan hands back to the model after a change. */
export function planToolResult(raw) {
  const plan = normalisePlan(raw);
  const current = plan.items.findIndex((item) => item.status === 'working');
  const open = plan.items.filter((item) => !['done', 'skipped'].includes(item.status)).length;
  const next = current >= 0
    ? `Current step: ${current + 1}. When it is finished, mark it done in the same response as your next tool call: update_plan {"action":"status","step":${current + 1},"status":"done"}.`
    : open ? 'No step is marked "now". Mark the step you start with status "working".' : 'Every step is finished or skipped.';
  return `Plan saved.\n${planText(plan)}\n${next}`;
}

export function planPrompt(raw) {
  const plan = normalisePlan(raw);
  if (!plan.items.length) return '';
  const current = plan.items.findIndex((item) => item.status === 'working');
  return [
    '## Plan',
    planText(plan),
    current >= 0 ? `You are on step ${current + 1}.` : '',
    `When a step is finished, mark it done alongside your next tool call (never as a response of its own): update_plan {"action":"status","step":N,"status":"done"}; the next step starts automatically.${plan.userEdited ? ' The user has edited this plan: follow it as written, and never do skipped work.' : ' Never do skipped work.'}`,
  ].filter(Boolean).join('\n');
}
