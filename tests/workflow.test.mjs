import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSession, contextDetails, turnReview, recordCommand } from '../src/workflow.mjs';
import { TaskManager } from '../src/tasks.mjs';
import { recordEdit, applyTurn } from '../src/edits.mjs';
import { SessionStore } from '../src/sessions.mjs';
import { Skadi } from '../src/server.mjs';
import { Readable } from 'node:stream';

test('search finds archived messages, command paths and redacts results without indexing image data', () => {
  const session = { title: 'Example', archive: [{ role: 'user', content: 'Remember the frobnicator' }], messages: [
    { role: 'assistant', tool_calls: [{ function: { name: 'run_command', arguments: '{"command":"node src/rare-file.mjs"}' } }] },
    { role: 'user', content: [{ type: 'text', text: `credential sk-${'a'.repeat(32)}` }, { type: 'image', source: { data: 'secretPixels' } }] },
  ] };
  assert.equal(searchSession(session, 'frobnicator').index, 0);
  assert.equal(searchSession(session, 'rare-file').index, 1);
  assert.match(searchSession(session, 'credential').snippet, /redacted/);
  assert.equal(searchSession(session, 'secretPixels'), null);
});

test('context breakdown excludes archives and surfaces the actual compaction summary', () => {
  const session = { requirements: 'Keep offline support', archive: [{ role: 'user', content: 'x'.repeat(9000) }], messages: [
    { role: 'system', content: 'Instructions' }, { role: 'assistant', content: '[Compacted context — date]\nKeep the renderer' },
    { role: 'tool', content: 'Read source' }, { role: 'user', content: [{ type: 'text', text: 'Image' }, { type: 'image', source: { data: 'x'.repeat(10000) } }] },
  ] };
  const context = contextDetails(session);
  assert.equal(Object.values(context.buckets).reduce((a, b) => a + b, 0), context.total);
  assert.ok(context.buckets.attachments > 0);
  assert.match(context.summary, /Keep the renderer/);
  assert.equal(context.requirements, 'Keep offline support');
});

test('turn evidence distinguishes failed exit codes from successful tool invocation and unknown background results', () => {
  const turn = { id: 't', name: 'Change', startedAt: 10, finishedAt: 20, commands: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  recordCommand(turn, { id: 'a', ok: true, content: 'exit code 1\nfailure' });
  recordCommand(turn, { id: 'b', ok: true, content: 'exit code 0\npassed' });
  recordCommand(turn, { id: 'c', ok: true, content: 'Task running in background' });
  assert.deepEqual(turn.commands.map(c => c.status), ['failed', 'passed', 'unknown']);
  const [review] = turnReview({ id: 's', workTurns: [turn], undo: [{ turnId: 't', path: 'a.js', before: 'old', after: 'new' }, { turnId: 'other', path: 'b.js' }] }, [{ sessionId: 's', startedAt: 15 }]);
  assert.deepEqual(review.files, ['a.js']);
  assert.match(review.edits[0].diff, /\+new/);
  assert.equal(review.background.length, 1);
});

test('task recovery retains output, probes old PIDs, and does not turn uncertain completion into success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-task-recovery-'));
  try {
    const file = join(dir, 'tasks.json');
    const manager = new TaskManager({ file });
    manager.tasks.set('a', { id: 'a', command: 'build', output: 'last output', status: 'running', pid: 123, startedAt: 1 });
    manager.tasks.set('b', { id: 'b', command: 'test', output: `sk-${'z'.repeat(32)}`, status: 'finished', exitCode: 0, startedAt: 2 });
    manager.persist();
    const restarted = new TaskManager({ file, probe: () => true });
    assert.equal(restarted.tasks.get('a').status, 'interrupted');
    assert.match(restarted.tasks.get('a').recovery, /unverified/);
    assert.match(restarted.log('a'), /last output/);
    assert.equal(restarted.tasks.get('a').proc, null);
    assert.match(await readFile(file, 'utf8'), /credential redacted/);
    assert.equal(restarted.tasks.get('b').exitCode, 0);
    const gone = new TaskManager({ file, probe: () => false });
    assert.match(gone.tasks.get('a').recovery, /no longer present/);
    restarted.clearFinished();
    assert.equal(new TaskManager({ file }).list().length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint undo/redo preserves other turns and refuses external changes and later edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-checkpoint-'));
  try {
    const session = {};
    recordEdit(session, { turnId: 'one', path: 'a.txt', before: 'old', after: 'new' });
    await writeFile(join(dir, 'a.txt'), 'external');
    await assert.rejects(applyTurn(session, dir, 'one', 'undo'), /outside/);
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'external');
    await writeFile(join(dir, 'a.txt'), 'new');
    await applyTurn(session, dir, 'one', 'undo');
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'old');
    await applyTurn(session, dir, 'one', 'redo');
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'new');
    recordEdit(session, { turnId: 'two', path: 'a.txt', before: 'new', after: 'later' });
    await writeFile(join(dir, 'a.txt'), 'later');
    await assert.rejects(applyTurn(session, dir, 'one', 'undo'), /Later edits/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workflow APIs persist requirements and checkpoint names and search full history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-workflow-api-'));
  try {
    const server = Object.create(Skadi.prototype);
    server.sessions = new SessionStore(dir);
    server.turns = new Map(); server.tasks = new TaskManager(); server.liveSession = () => null;
    server.isSessionWorking = () => false;
    const session = await server.sessions.create('Fixture');
    session.messages = [{ role: 'user', content: 'Find the goldfinch' }];
    session.workTurns = [{ id: 't', name: 'Original', status: 'finished', commands: [] }];
    await server.sessions.save(session);
    const call = async (path, body) => {
      let status, result;
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      req.method = body ? 'POST' : 'GET'; req.headers = {};
      await server.handleApi(req, { writeHead: code => { status = code; }, end: text => { result = JSON.parse(text); } }, new URL(`http://127.0.0.1/api/${path}`));
      assert.equal(status, 200, JSON.stringify(result)); return result;
    };
    assert.equal((await call('sessions/search?q=goldfinch'))[0].match.index, 0);
    await call('session/requirements', { id: session.id, requirements: 'Keep offline' });
    await call('session/checkpoint', { id: session.id, turnId: 't', name: 'Verified checkpoint' });
    const workflow = await call(`session/workflow?id=${session.id}`);
    assert.equal(workflow.context.requirements, 'Keep offline');
    assert.equal(workflow.turns[0].name, 'Verified checkpoint');
    assert.equal((await new SessionStore(dir).get(session.id)).requirements, 'Keep offline');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
