import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTools } from '../src/tools.mjs';
import { recordEdit, applyOne } from '../src/edits.mjs';

// A workspace whose run_command changes land in a session's edit history the
// way the server wires them: the tool records, edits.mjs keeps the images.
async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'skadi-run-cmd-'));
  const session = { undo: [] };
  const tools = buildTools({
    workspace: root,
    settings: {},
    recordEdit: (entry) => recordEdit(session, entry),
  });
  try {
    return await fn(root, tools, session);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const run = (tools, command, callId) => tools.run_command.run({ command }, { callId });

test('a file the shell creates shows up in the result and the history', async () => {
  await withWorkspace(async (root, tools, session) => {
    const out = await run(tools,
      "Set-Content -Path 'made.txt' -Value 'alpha','beta' -Encoding ascii", 'c1');

    assert.match(out, /\[harness\] workspace changes:.*made\.txt/);
    assert.equal(session.undo.length, 1);
    const entry = session.undo[0];
    assert.equal(entry.path, 'made.txt');
    assert.equal(entry.existed, false);
    assert.equal(entry.truncated, false);
    assert.equal(entry.callId, 'c1');
    assert.equal(entry.before, '');
    assert.ok(entry.added >= 2);

    // Undoing a shell creation removes the file again.
    await applyOne(session, root, 'c1', 'undo');
    assert.equal(existsSync(join(root, 'made.txt')), false);
  });
});

test('a file the shell edits is recorded with its before-image', async () => {
  await withWorkspace(async (root, tools, session) => {
    await writeFile(join(root, 'edited.txt'), 'one\ntwo\n', 'utf8');

    const out = await run(tools,
      "Set-Content -Path 'edited.txt' -Value 'one','TWO' -Encoding ascii", 'c2');

    assert.match(out, /\[harness\] workspace changes:.*edited\.txt.*\+\d+.*-\d+/);
    const entry = session.undo[0];
    assert.equal(entry.existed, true);
    assert.equal(entry.truncated, false);
    assert.ok(entry.removed >= 1);

    // Undo puts the before-image back byte for byte.
    await applyOne(session, root, 'c2', 'undo');
    assert.equal(await readFile(join(root, 'edited.txt'), 'utf8'), 'one\ntwo\n');
  });
});

test('a file the shell deletes is recorded, and undo restores it', async () => {
  await withWorkspace(async (root, tools, session) => {
    await writeFile(join(root, 'doomed.txt'), 'bye\n', 'utf8');

    const out = await run(tools, "Remove-Item 'doomed.txt'", 'c3');

    assert.match(out, /\[harness\] workspace changes:.*doomed\.txt/);
    const entry = session.undo[0];
    assert.equal(entry.existed, true);
    assert.equal(entry.truncated, false);
    assert.match(entry.before, /bye/);

    await applyOne(session, root, 'c3', 'undo');
    assert.equal(await readFile(join(root, 'doomed.txt'), 'utf8'), 'bye\n');
  });
});

test('a command that changes nothing adds no history entry', async () => {
  await withWorkspace(async (root, tools, session) => {
    const out = await run(tools, 'Write-Output nothing-to-see-here', 'c4');
    assert.doesNotMatch(out, /workspace changes/);
    assert.equal(session.undo.length, 0);
  });
});

test('a shell change to a file too big to snapshot is counted but not reversible', async () => {
  await withWorkspace(async (root, tools, session) => {
    // Just over the 1 MB image cap, so the before-snapshot skips its content.
    await writeFile(join(root, 'big.txt'), 'x'.repeat(1024 * 1024) + '\n', 'utf8');

    const out = await run(tools, "Add-Content -Path 'big.txt' -Value 'one more line'", 'c5');

    // Counted in the bar, but without a diff.
    assert.match(out, /\[harness\] workspace changes:.*big\.txt/);
    assert.doesNotMatch(out, /big\.txt.*\+\d+.*-\d+/);
    const entry = session.undo[0];
    assert.equal(entry.path, 'big.txt');
    assert.equal(entry.truncated, true);
    assert.equal(entry.added, null);

    // And undo refuses it, exactly like any clipped pair.
    await assert.rejects(
      applyOne(session, root, 'c5', 'undo'),
      /cannot be reversed/,
    );
  });
});
