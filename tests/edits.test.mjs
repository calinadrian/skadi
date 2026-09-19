import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { recordEdit, applyOne, applyAll, changeSummary, publicHistory, MAX_IMAGE_BYTES } from '../src/edits.mjs';

async function workspace() {
  return mkdtemp(join(tmpdir(), 'skadi-edits-'));
}

async function put(root, file, text) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

const read = (root, file) => readFile(join(root, file), 'utf8');

// An edit as the file tools report it: both images, and whether the file was
// there beforehand.
function edit(session, callId, path, before, after, existed = true) {
  return recordEdit(session, {
    callId, path, before, after, existed,
    added: after.split('\n').length, removed: before ? before.split('\n').length : 0,
  });
}

test('undo writes the before-image back, and redo writes the after-image again', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    await put(root, 'a.txt', 'second');
    edit(session, 'c1', 'a.txt', 'first', 'second');

    await applyOne(session, root, 'c1', 'undo');
    assert.equal(await read(root, 'a.txt'), 'first');
    assert.equal(session.undo[0].undone, true);

    await applyOne(session, root, 'c1', 'redo');
    assert.equal(await read(root, 'a.txt'), 'second');
    assert.equal(session.undo[0].undone, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an undone edit stays in the history instead of being dropped', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    await put(root, 'a.txt', 'new');
    edit(session, 'c1', 'a.txt', 'old', 'new');
    await applyOne(session, root, 'c1', 'undo');
    // The old behaviour spliced the entry out, which made Redo impossible.
    assert.equal(session.undo.length, 1);
    assert.equal(publicHistory(session)[0].undone, true);
    await assert.rejects(applyOne(session, root, 'c1', 'undo'), /already undone/);
    await assert.doesNotReject(applyOne(session, root, 'c1', 'redo'));
    await assert.rejects(applyOne(session, root, 'c1', 'redo'), /already applied/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('undoing a creation removes the file, and redo brings it back', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    await put(root, 'made.txt', 'hello');
    edit(session, 'c1', 'made.txt', '', 'hello', false);
    await applyOne(session, root, 'c1', 'undo');
    assert.equal(existsSync(join(root, 'made.txt')), false);
    await applyOne(session, root, 'c1', 'redo');
    assert.equal(await read(root, 'made.txt'), 'hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an edit too large to copy is refused rather than truncating the file', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    const huge = 'x'.repeat(MAX_IMAGE_BYTES + 1);
    await put(root, 'big.txt', huge);
    const entry = edit(session, 'c1', 'big.txt', huge, huge);
    // Holding a clipped image would have undone the file into a truncated one.
    assert.equal(entry.truncated, true);
    assert.equal(entry.before, '');
    await assert.rejects(applyOne(session, root, 'c1', 'undo'), /too large/);
    assert.equal((await read(root, 'big.txt')).length, huge.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reverting a whole chat unwinds to the state before it started', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    // One file edited three times, one file created, one left alone.
    await put(root, 'untouched.txt', 'safe');
    await put(root, 'a.txt', 'v3');
    edit(session, 'c1', 'a.txt', 'v0', 'v1');
    edit(session, 'c2', 'a.txt', 'v1', 'v2');
    edit(session, 'c3', 'a.txt', 'v2', 'v3');
    await put(root, 'b.txt', 'made');
    edit(session, 'c4', 'b.txt', '', 'made', false);

    const out = await applyAll(session, root, 'undo');
    assert.equal(out.count, 4);
    assert.deepEqual(out.paths.sort(), ['a.txt', 'b.txt']);
    // Newest first, so the oldest before-image is what survives.
    assert.equal(await read(root, 'a.txt'), 'v0');
    assert.equal(existsSync(join(root, 'b.txt')), false);
    assert.equal(await read(root, 'untouched.txt'), 'safe');

    const back = await applyAll(session, root, 'redo');
    assert.equal(back.count, 4);
    // Oldest first, so the newest after-image is what survives.
    assert.equal(await read(root, 'a.txt'), 'v3');
    assert.equal(await read(root, 'b.txt'), 'made');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bulk run that cannot finish puts every file back as it found it', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    await put(root, 'a.txt', 'new-a');
    await put(root, 'b.txt', 'new-b');
    edit(session, 'c1', 'a.txt', 'old-a', 'new-a');
    edit(session, 'c2', 'b.txt', 'old-b', 'new-b');
    // b.txt becomes a directory: writing it fails half way through the run.
    await rm(join(root, 'b.txt'));
    await mkdir(join(root, 'b.txt'));

    await assert.rejects(applyAll(session, root, 'undo'), /put back as it was/);
    // a.txt was already rewritten when b.txt failed; it must not stay reverted.
    assert.equal(await read(root, 'a.txt'), 'new-a');
    assert.equal(session.undo.every((e) => !e.undone), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bulk run refuses outright when any edit lost its copy', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    await put(root, 'a.txt', 'new');
    await put(root, 'big.txt', 'x');
    edit(session, 'c1', 'a.txt', 'old', 'new');
    edit(session, 'c2', 'big.txt', 'x'.repeat(MAX_IMAGE_BYTES + 1), 'x');
    await assert.rejects(applyAll(session, root, 'undo'), /nothing was changed/);
    assert.equal(await read(root, 'a.txt'), 'new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the bar counts only edits that are currently applied', async () => {
  const root = await workspace();
  try {
    const session = { undo: [] };
    await put(root, 'a.txt', 'aa');
    await put(root, 'b.txt', 'bb');
    recordEdit(session, { callId: 'c1', path: 'a.txt', before: 'a', after: 'aa', added: 3, removed: 1, existed: true });
    recordEdit(session, { callId: 'c2', path: 'b.txt', before: 'b', after: 'bb', added: 5, removed: 2, existed: true });

    let bar = changeSummary(session);
    assert.deepEqual([bar.files, bar.added, bar.removed, bar.applied, bar.undone], [2, 8, 3, 2, 0]);
    assert.equal(bar.canRevert, true);
    assert.equal(bar.canReapply, false);

    await applyOne(session, root, 'c2', 'undo');
    bar = changeSummary(session);
    assert.deepEqual([bar.files, bar.added, bar.removed, bar.applied, bar.undone], [1, 3, 1, 1, 1]);
    assert.equal(bar.canReapply, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the history the window receives carries no file images', async () => {
  const session = { undo: [] };
  recordEdit(session, { callId: 'c1', path: 'a.txt', before: 'secret', after: 'also secret', added: 1, removed: 1, existed: true });
  const row = publicHistory(session)[0];
  assert.deepEqual(Object.keys(row).sort(), ['added', 'at', 'callId', 'path', 'removed', 'truncated', 'undone']);
  assert.equal(JSON.stringify(row).includes('secret'), false);
});
