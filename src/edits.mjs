// The edit history behind Undo, Redo, and the change bar above a chat.
//
// Every file-writing tool call leaves an entry here carrying both images: the
// bytes the file had before the edit, and the bytes it was given. That is what
// makes the pair reversible -- Undo writes `before` back, Redo writes `after`
// again -- and it is why an entry too large to hold both is marked unusable
// rather than kept in half: restoring a clipped image would truncate the file
// it was meant to rescue.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { safePath } from './tools.mjs';

// Per image, per entry, and across the whole history. A session file is
// rewritten after every turn, so the history rides along in it and has to stay
// small enough not to dominate that write.
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_ENTRIES = 200;
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

const size = (text) => (text ? Buffer.byteLength(text, 'utf8') : 0);

/** Fold one tool call's before/after pair into a session's history. */
export function recordEdit(session, entry) {
  const before = String(entry.before ?? '');
  const after = String(entry.after ?? '');
  // Either image alone being oversized makes the pair unusable, so neither is
  // stored: a clipped image is worse than no history at all.
  const truncated = size(before) > MAX_IMAGE_BYTES || size(after) > MAX_IMAGE_BYTES;
  session.undo ??= [];
  session.undo.push({
    callId: entry.callId ?? null,
    path: entry.path,
    before: truncated ? '' : before,
    after: truncated ? '' : after,
    added: entry.added ?? null,
    removed: entry.removed ?? null,
    existed: entry.existed ?? true,
    at: Date.now(),
    undone: false,
    truncated,
  });
  prune(session);
  return session.undo.at(-1);
}

// Oldest entries go first, by count and by total weight. An entry that is
// currently undone is kept ahead of an applied one of the same age: dropping it
// would strand production -- or the workspace -- on a change nothing can put
// back.
function prune(session) {
  const entries = session.undo;
  while (entries.length > MAX_ENTRIES) entries.shift();
  let total = entries.reduce((sum, e) => sum + size(e.before) + size(e.after), 0);
  for (let i = 0; i < entries.length && total > MAX_HISTORY_BYTES; i++) {
    if (entries[i].truncated) continue;
    total -= size(entries[i].before) + size(entries[i].after);
    entries[i].before = '';
    entries[i].after = '';
    entries[i].truncated = true;
  }
}

/** An entry can only be reversed while both of its images are still held. */
export const usable = (entry) => Boolean(entry) && !entry.truncated;

/** Put one entry's `before` (undo) or `after` (redo) back on disk. */
async function writeImage(workspace, entry, direction) {
  const file = safePath(workspace, entry.path);
  // Undoing a creation removes the file again rather than leaving it empty.
  if (direction === 'undo' && entry.existed === false) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, direction === 'undo' ? entry.before : entry.after, 'utf8');
}

// What a file holds right now, so a bulk run that fails part-way can put every
// file it already touched back exactly as it found it.
async function snapshot(workspace, paths) {
  const held = new Map();
  for (const path of paths) {
    const file = safePath(workspace, path);
    held.set(path, existsSync(file) ? await readFile(file, 'utf8').catch(() => null) : null);
  }
  return held;
}

async function restore(workspace, held) {
  for (const [path, content] of held) {
    const file = safePath(workspace, path);
    try {
      if (content === null) await rm(file, { force: true });
      else await writeFile(file, content, 'utf8');
    } catch { /* best effort: the error that got us here is the one reported */ }
  }
}

/** Undo or redo a single edit, named by the tool call that made it. */
export async function applyOne(session, workspace, callId, direction) {
  const entry = (session.undo || []).find((e) => e.callId && e.callId === callId);
  if (!entry) throw new Error('that edit is no longer in this chat’s history');
  if (!usable(entry)) throw new Error('that edit was too large to keep a copy of, so it cannot be reversed');
  if (direction === 'undo' && entry.undone) throw new Error('that edit is already undone');
  if (direction === 'redo' && !entry.undone) throw new Error('that edit is already applied');
  await writeImage(workspace, entry, direction);
  entry.undone = direction === 'undo';
  return entry;
}

// Reverting runs newest first so that several edits to one file unwind down to
// the oldest `before`; reapplying runs oldest first so the newest `after` is
// what survives. Nothing is written until every entry involved is known to be
// usable, and a failure part-way puts back every file already touched.
export async function applyAll(session, workspace, direction) {
  const all = session.undo || [];
  const wanted = direction === 'undo'
    ? [...all].reverse().filter((e) => !e.undone)
    : all.filter((e) => e.undone);
  const blocked = wanted.filter((e) => !usable(e));
  if (blocked.length) {
    const names = [...new Set(blocked.map((e) => e.path))];
    throw new Error(`${blocked.length} edit(s) were too large to keep a copy of, so nothing was changed (${names.join(', ')}).`);
  }
  if (!wanted.length) {
    throw new Error(direction === 'undo' ? 'Nothing in this chat is left to revert.' : 'Nothing in this chat is waiting to be reapplied.');
  }
  const held = await snapshot(workspace, [...new Set(wanted.map((e) => e.path))]);
  const touched = [];
  try {
    for (const entry of wanted) {
      await writeImage(workspace, entry, direction);
      entry.undone = direction === 'undo';
      touched.push(entry);
    }
  } catch (err) {
    await restore(workspace, held);
    for (const entry of touched) entry.undone = direction !== 'undo';
    throw new Error(`${direction === 'undo' ? 'Revert' : 'Reapply'} failed: ${err.message}. Every file was put back as it was.`);
  }
  return { count: touched.length, paths: [...new Set(touched.map((e) => e.path))] };
}

// The figures behind the bar above a chat: what its edits currently add up to,
// and whether there is anything to revert or to put back.
export function changeSummary(session) {
  const entries = (session?.undo || []);
  const applied = entries.filter((e) => !e.undone);
  const undone = entries.filter((e) => e.undone);
  const sum = (rows, key) => rows.reduce((total, e) => total + (Number(e[key]) || 0), 0);
  return {
    files: [...new Set(applied.map((e) => e.path))].length,
    added: sum(applied, 'added'),
    removed: sum(applied, 'removed'),
    applied: applied.length,
    undone: undone.length,
    // A history that has lost an image can still be shown; it just cannot be
    // reversed, and the bar says so rather than offering a button that throws.
    stale: entries.filter((e) => e.truncated).length,
    canRevert: applied.some(usable),
    canReapply: undone.some(usable),
  };
}

/** The history as the UI needs it: no file images, which are large. */
export const publicHistory = (session) => (session?.undo || []).map(
  ({ callId, path, added, removed, at, undone, truncated }) => ({ callId, path, added, removed, at, undone, truncated }),
);
