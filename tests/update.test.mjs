import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

async function put(root, file, text) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

const release = (tag, { broken = false } = {}) => ({
  'skadi.mjs': `export const tag = '${tag}';\n`,
  'package.json': JSON.stringify({ name: 'skadi', version: tag === 'new' ? '0.2.0' : '0.1.0' }),
  'README.md': `# ${tag}\n`,
  'src/server.mjs': broken ? 'export const = ;\n' : `export const tag = '${tag}';\n`,
  'src/publish.mjs': 'export const maintainerOnly = true;\n',
  'ui/index.html': `<html>${tag}</html>`,
  'ui/app.js': `// ${tag}\n`,
  'config/settings.json': '{"from":"the release"}',
  'sessions/leak.json': '{"from":"the release"}',
});

async function fakeGithub({ broken = false } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'skadi-gh-'));
  const tree = join(work, `skadi-${NEW}`);
  for (const [file, text] of Object.entries(release('new', { broken }))) await put(tree, file, text);
  // Windows' own bsdtar: the tar on PATH may be GNU tar, which reads C: as a host.
  execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-cf', 'release.zip', `skadi-${NEW}`], { cwd: work });
  const zip = await readFile(join(work, 'release.zip'));
  const server = createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/repos/calinadrian/skadi/commits/main') {
      return json({ sha: NEW, commit: { message: 'Add a thing\n\nbody', committer: { date: '2026-09-19T00:00:00Z' } } });
    }
    if (req.url === `/api/repos/calinadrian/skadi/compare/${OLD}...${NEW}`) {
      return json({ ahead_by: 4, commits: [
        { commit: { message: 'Add first feature' } },
        { commit: { message: 'Fix a crash on start' } },
        { commit: { message: 'Merge branch x' } },
        { commit: { message: 'feat(ui): second feature' } },
        { commit: { message: 'Tidy up' } },
      ] });
    }
    if (req.url === `/raw/calinadrian/skadi/${NEW}/package.json`) return json({ version: '0.2.0' });
    if (req.url === `/zip/calinadrian/skadi/zip/${NEW}`) { res.writeHead(200); return res.end(zip); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { work, base, close: () => new Promise((r) => server.close(r)) };
}

async function install(root) {
  for (const [file, text] of Object.entries(release('old'))) {
    if (!/^(config|sessions)\//.test(file)) await put(root, file, text);
  }
  await put(root, 'config/settings.json', '{"mine":true}');
  await put(root, 'config/secrets.json', '{"key":"secret"}');
  await put(root, 'sessions/chat.json', '{"mine":true}');
  await put(root, '.skadi-version.json', JSON.stringify({ sha: OLD }));
}

async function load(gh) {
  process.env.SKADI_UPDATE_API = `${gh.base}/api`;
  process.env.SKADI_UPDATE_RAW = `${gh.base}/raw`;
  process.env.SKADI_UPDATE_DOWNLOAD = `${gh.base}/zip`;
  return import(`../src/update.mjs?${Math.random()}`);
}

test('a newer commit is reported with what changed, sorted into new and fixed', async () => {
  const gh = await fakeGithub();
  const root = await mkdtemp(join(tmpdir(), 'skadi-upd-'));
  try {
    await install(root);
    const { checkForUpdate } = await load(gh);
    const result = await checkForUpdate({ root, force: true });
    assert.equal(result.available, true);
    assert.equal(result.behind, 4);
    assert.equal(result.latest.version, '0.2.0');
    assert.deepEqual(result.notes.fixed, ['Fix a crash on start']);
    assert.deepEqual(result.notes.added, ['Tidy up', 'Second feature', 'Add first feature']);
  } finally {
    await gh.close();
    await rm(root, { recursive: true, force: true });
    await rm(gh.work, { recursive: true, force: true });
  }
});

test('installing replaces release files only, and leaves config, chats and keys alone', async () => {
  const gh = await fakeGithub();
  const root = await mkdtemp(join(tmpdir(), 'skadi-upd-'));
  try {
    await install(root);
    const { applyUpdate, checkForUpdate } = await load(gh);
    const result = await applyUpdate({ root });
    assert.equal(result.updated, true);
    assert.match(await readFile(join(root, 'src/server.mjs'), 'utf8'), /'new'/);
    assert.match(await readFile(join(root, 'ui/index.html'), 'utf8'), /new/);
    // Yours, not the release's.
    assert.equal(await readFile(join(root, 'config/settings.json'), 'utf8'), '{"mine":true}');
    assert.equal(await readFile(join(root, 'config/secrets.json'), 'utf8'), '{"key":"secret"}');
    assert.equal(await readFile(join(root, 'sessions/chat.json'), 'utf8'), '{"mine":true}');
    assert.equal(existsSync(join(root, 'sessions/leak.json')), false);
    // Maintainer tooling never arrives.
    assert.equal(await readFile(join(root, 'src/publish.mjs'), 'utf8'), 'export const maintainerOnly = true;\n');
    // The old bytes are kept, and the stamp says where we are now.
    const [backup] = await readdir(join(root, 'build/update-backups'));
    assert.match(await readFile(join(root, 'build/update-backups', backup, 'src/server.mjs'), 'utf8'), /'old'/);
    assert.equal(JSON.parse(await readFile(join(root, '.skadi-version.json'), 'utf8')).sha, NEW);
    assert.equal((await checkForUpdate({ root, force: true })).available, false);
    assert.deepEqual((await readdir(join(root, 'build'))).filter((n) => n.startsWith('.update-')), []);
  } finally {
    await gh.close();
    await rm(root, { recursive: true, force: true });
    await rm(gh.work, { recursive: true, force: true });
  }
});

test('a release whose modules do not parse is refused and nothing changes', async () => {
  const gh = await fakeGithub({ broken: true });
  const root = await mkdtemp(join(tmpdir(), 'skadi-upd-'));
  try {
    await install(root);
    const { applyUpdate } = await load(gh);
    await assert.rejects(applyUpdate({ root }), /rejected/);
    assert.match(await readFile(join(root, 'src/server.mjs'), 'utf8'), /'old'/);
    assert.equal(JSON.parse(await readFile(join(root, '.skadi-version.json'), 'utf8')).sha, OLD);
  } finally {
    await gh.close();
    await rm(root, { recursive: true, force: true });
    await rm(gh.work, { recursive: true, force: true });
  }
});
