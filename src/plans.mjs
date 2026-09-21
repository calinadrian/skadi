// Persistent, user-editable execution plans. Plans live beside a session's
// transcript so they survive restarts without becoming chat messages. Both the
// agent tool and the UI use the same reducer, which keeps their behaviour in
// lockstep and makes mid-turn edits deterministic.
import { randomUUID } from 'node:crypto';

export const PLAN_STATUSES = ['queued', 'working', 'blocked', 'review', 'done', 'skipped'];
const STATUS = new Set(PLAN_STATUSES);
const MAX_ITEMS = 50;

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const itemId = () => `p-${randomUUID().slice(0, 8)}`;

function normaliseItem(raw = {}, makeId = itemId) {
  const text = clean(typeof raw === 'string' ? raw : raw.text, 240);
  if (!text) return null;
  return {
    id: clean(raw.id, 80) || makeId(),
    text,
    status: STATUS.has(raw.status) ? raw.status : 'queued',
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

const findItem = (plan, id) => {
  const index = plan.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`unknown plan item: ${id}`);
  return { item: plan.items[index], index };
};

/** Apply one agent or UI action and return a fresh serialisable plan. */
export function applyPlanAction(current, request = {}, { source = 'agent', makeId = itemId } = {}) {
  const plan = normalisePlan(current);
  const action = clean(request.action, 24);
  const now = Date.now();

  if (action === 'set') {
    if (plan.items.length && plan.userEdited && source !== 'user') {
      throw new Error('the user has edited this plan; update its existing items instead of replacing it');
    }
    const next = [];
    for (const value of Array.isArray(request.items) ? request.items : []) {
      const item = normaliseItem(value, makeId);
      if (item && next.length < MAX_ITEMS) next.push(item);
    }
    if (!next.length) throw new Error('a plan needs at least one non-empty item');
    if (source === 'user') for (const item of next) item.userEdited = true;
    plan.items = next;
  } else if (action === 'add') {
    if (plan.items.length >= MAX_ITEMS) throw new Error(`a plan can contain at most ${MAX_ITEMS} items`);
    const item = normaliseItem({
      text: request.text,
      status: request.status,
      note: request.note,
      required: request.required,
    }, makeId);
    if (!item) throw new Error('plan item text is required');
    if (source === 'user') item.userEdited = true;
    const index = Number.isInteger(request.index)
      ? Math.max(0, Math.min(request.index, plan.items.length))
      : plan.items.length;
    plan.items.splice(index, 0, item);
  } else if (action === 'edit') {
    const { item } = findItem(plan, request.itemId);
    if (source !== 'user' && item.userEdited) throw new Error('the user edited this step; preserve its text');
    const text = clean(request.text, 240);
    if (!text) throw new Error('plan item text is required');
    item.text = text;
    if (request.note !== undefined) item.note = clean(request.note, 500);
    if (request.required !== undefined) item.required = request.required !== false;
    item.updatedAt = now;
    if (source === 'user') item.userEdited = true;
  } else if (action === 'status') {
    if (!STATUS.has(request.status)) throw new Error(`invalid plan status: ${request.status}`);
    const { item } = findItem(plan, request.itemId);
    if (source !== 'user' && item.userEdited && item.status === 'skipped') {
      throw new Error('the user skipped this step; do not resume or complete it');
    }
    if (request.status === 'working') {
      for (const other of plan.items) {
        if (other.id !== item.id && other.status === 'working') other.status = 'queued';
      }
    }
    item.status = request.status;
    if (request.note !== undefined) item.note = clean(request.note, 500);
    item.updatedAt = now;
    if (source === 'user') item.userEdited = true;
  } else if (action === 'move') {
    if (source !== 'user' && plan.userEdited) throw new Error('the user reordered this plan; preserve its order');
    const { item, index } = findItem(plan, request.itemId);
    const to = Math.max(0, Math.min(Number(request.index) || 0, plan.items.length - 1));
    plan.items.splice(index, 1);
    plan.items.splice(to, 0, item);
    item.updatedAt = now;
  } else if (action === 'remove') {
    if (source !== 'user' && plan.userEdited) throw new Error('the user edited this plan; do not delete its steps');
    const { item, index } = findItem(plan, request.itemId);
    plan.items.splice(index, 1);
    plan.deleted.unshift({ item, index, removedAt: now });
    plan.deleted = plan.deleted.slice(0, 10);
  } else if (action === 'restore') {
    const deletedIndex = request.itemId
      ? plan.deleted.findIndex((entry) => entry.item.id === request.itemId)
      : 0;
    if (deletedIndex < 0 || !plan.deleted[deletedIndex]) throw new Error('there is no deleted plan item to restore');
    const [entry] = plan.deleted.splice(deletedIndex, 1);
    const index = Math.max(0, Math.min(entry.index, plan.items.length));
    const restored = { ...entry.item, updatedAt: now };
    if (restored.status === 'working' && plan.items.some((item) => item.status === 'working')) restored.status = 'queued';
    plan.items.splice(index, 0, restored);
  } else {
    throw new Error(`unknown plan action: ${action || '(empty)'}`);
  }

  plan.revision += 1;
  plan.updatedAt = now;
  if (source === 'user') plan.userEdited = true;
  return plan;
}

export function planPrompt(raw) {
  const plan = normalisePlan(raw);
  if (!plan.items.length) return '';
  const lines = plan.items.map((item, index) =>
    `${index + 1}. [${item.status}] ${item.text}${item.required ? '' : ' (optional)'}${item.note ? ` — ${item.note}` : ''}`,
  );
  return `## Live execution plan (revision ${plan.revision})\n\n${lines.join('\n')}\n\nThis plan is authoritative and may have been edited by the user while you worked. Never perform skipped or deleted work. Use update_plan when you start, finish, block, or send a step for review. Do not replace a user-edited plan.`;
}
