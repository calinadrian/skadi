// In-app updates from GitHub.
//
// Checking is two small requests: the newest commit on the branch, and how far
// the installed commit is behind it. Installing downloads the branch as a zip,
// checks that every module in it still parses, backs up each file it is about
// to replace, and only then writes. Only release files are touched (see
// release.mjs), so chats, keys, config, memory and skills are never in play.
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './config.mjs';
import { releaseFiles, SEED_ONLY } from './release.mjs';

const exec = promisify(execFile);

export const REPO = 'calinadrian/skadi';
export const BRANCH = 'main';
// Overridable so tests can point at a local stand-in for GitHub.
const API = process.env.SKADI_UPDATE_API || 'https://api.github.com';
const CODELOAD = process.env.SKADI_UPDATE_DOWNLOAD || 'https://codeload.github.com';
const RAW = process.env.SKADI_UPDATE_RAW || 'https://raw.githubusercontent.com';
const STAMP = '.skadi-version.json';
const KEEP_BACKUPS = 5;
const CACHE_MS = 10 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;

export const backupsDir = (root = ROOT) => join(root, 'build', 'update-backups');

const headers = { 'User-Agent': 'Skadi-updater', Accept: 'application/vnd.github+json' };

async function githubJson(path) {
  const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub is rate limiting update checks from this network. Try again in a little while.');
  }
  if (res.status === 409) throw new Error('Nothing has been published on GitHub yet.');
  if (res.status === 404) throw new Error(`GitHub has no ${REPO} at ${BRANCH} to update from.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res.json();
}

const runningVersion = (root) => {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null; } catch { return null; }
};

async function gitHead(root) {
  if (!existsSync(join(root, '.git'))) return null;
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000, windowsHide: true });
    const sha = stdout.trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The commit this installation is on: what the last update recorded, else the checkout's HEAD. */
export async function installedVersion(root = ROOT) {
  const stamp = await readFile(join(root, STAMP), 'utf8').then((t) => JSON.parse(t.replace(/^\uFEFF/, ''))).catch(() => null);
  const sha = (SHA.test(stamp?.sha || '') ? stamp.sha : null) ?? (await gitHead(root));
  return { sha, version: runningVersion(root), updatedAt: stamp?.updatedAt ?? null };
}

const firstLine = (message) => String(message || '').split('\n')[0].trim();
const FIX = /^(?:\w+(?:\([^)]*\))?!?:\s*)?(?:fix(?:e[sd])?|hotfix|bug|repair(?:ed)?|correct(?:ed)?|resolve[sd]?|patch(?:ed)?)\b/i;
const PREFIX = /^\w+(?:\([^)]*\))?!?:\s*/;

/** Sort commit messages into "what's new" and "fixed", newest first, a few of each. */
export function summariseCommits(commits, show = 3) {
  const added = [];
  const fixed = [];
  let counted = 0;
  for (const commit of [...commits].reverse()) {
    const line = firstLine(commit.commit?.message);
    if (!line || /^merge\b/i.test(line)) continue;
    counted++;
    const text = line.replace(PREFIX, '').replace(/^./, (c) => c.toUpperCase());
    const bucket = FIX.test(line) ? fixed : added;
    if (bucket.length < show) bucket.push(text);
  }
  return { added, fixed, more: Math.max(0, counted - added.length - fixed.length) };
}

let cache = null;

/** Ask GitHub whether there is anything newer than what is installed. */
export async function checkForUpdate({ root = ROOT, force = false } = {}) {
  if (!force && cache && cache.root === root && Date.now() - cache.at < CACHE_MS) return cache.result;
  const current = await installedVersion(root);
  const latest = await githubJson(`/repos/${REPO}/commits/${BRANCH}`);
  const latestSha = String(latest.sha || '');
  if (!SHA.test(latestSha)) throw new Error('GitHub returned an unexpected answer.');

  let behind = null;
  let notes = { added: [], fixed: [], more: 0 };
  if (current.sha && current.sha !== latestSha) {
    try {
      const compare = await githubJson(`/repos/${REPO}/compare/${current.sha}...${latestSha}`);
      behind = compare.ahead_by ?? compare.total_commits ?? null;
      notes = summariseCommits(compare.commits || []);
      // The compare answer holds at most 250 commits; the count is still exact.
      if (behind != null) notes.more = Math.max(notes.more, behind - notes.added.length - notes.fixed.length);
    } catch {
      // An installed commit GitHub does not know (a local build, a rewritten
      // history) cannot be compared; it can still be updated over.
    }
  }
  const latestVersion = await fetch(`${RAW}/${REPO}/${latestSha}/package.json`, { headers: { 'User-Agent': headers['User-Agent'] }, signal: AbortSignal.timeout(15000) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.version ?? null).catch(() => null);

  const result = {
    available: current.sha !== latestSha,
    known: Boolean(current.sha),
    current,
    latest: {
      sha: latestSha,
      version: latestVersion,
      date: latest.commit?.committer?.date ?? null,
      message: firstLine(latest.commit?.message),
    },
    behind,
    notes,
    checkedAt: Date.now(),
  };
  cache = { root, at: Date.now(), result };
  return result;
}

export const forgetCheck = () => { cache = null; };

// ---------------------------------------------------------------- install

async function download(sha, to) {
  const res = await fetch(`${CODELOAD}/${REPO}/zip/${sha}`, { headers: { 'User-Agent': headers['User-Agent'] }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`GitHub would not send the update (${res.status}).`);
  await writeFile(to, Buffer.from(await res.arrayBuffer()));
}

// bsdtar has shipped with Windows since 10 (1803) and reads zip archives.
async function extract(zip, into) {
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  await exec(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', into], { timeout: 120000, windowsHide: true });
  const entries = await readdir(into, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) throw new Error('The downloaded update is not laid out as expected.');
  return join(into, dirs[0].name);
}

/** A release that would not start must be turned away here, with the running one untouched. */
export async function verifyRelease(tree, files) {
  const problems = [];
  await Promise.all(files.filter((f) => f.endsWith('.mjs')).map(async (name) => {
    try {
      await exec(process.execPath, ['--check', join(tree, name)], { windowsHide: true, timeout: 20000 });
    } catch (err) {
      problems.push(`${name}: ${String(err.stderr || err.message).trim().split('\n').slice(0, 2).join(' ')}`);
    }
  }));
  for (const name of ['skadi.mjs', 'src/server.mjs', 'ui/index.html', 'package.json']) {
    if (!files.includes(name) || (await stat(join(tree, name)).then((s) => s.size, () => 0)) <= 0) {
      problems.push(`${name}: missing or empty`);
    }
  }
  try {
    JSON.parse(await readFile(join(tree, 'package.json'), 'utf8'));
  } catch (err) {
    problems.push(`package.json: ${err.message}`);
  }
  if (problems.length) throw new Error(`The update was rejected and nothing was changed:\n${problems.sort().join('\n')}`);
}

/** Write every file of `tree` into `root`, backing up what it replaces; undo all of it if one write fails. */
export async function installRelease(tree, root, files, backup) {
  const existing = new Set();
  for (const name of files) {
    const dest = join(root, name);
    if (existsSync(dest)) {
      existing.add(name);
      await mkdir(dirname(join(backup, name)), { recursive: true });
      await copyFile(dest, join(backup, name));
    }
  }
  const written = [];
  try {
    for (const name of files) {
      const dest = join(root, name);
      const tmp = `${dest}.update-${process.pid}.tmp`;
      await mkdir(dirname(dest), { recursive: true });
      try {
        await copyFile(join(tree, name), tmp);
        await rename(tmp, dest);
        written.push(name);
      } finally {
        await rm(tmp, { force: true });
      }
    }
  } catch (err) {
    for (const name of written.reverse()) {
      if (existing.has(name)) await copyFile(join(backup, name), join(root, name)).catch(() => {});
      else await rm(join(root, name), { force: true }).catch(() => {});
    }
    throw new Error(`The update could not be written and was rolled back: ${err.message}`);
  }
  await writeFile(join(backup, 'manifest.json'), JSON.stringify({ at: Date.now(), replaced: [...existing], created: files.filter((f) => !existing.has(f)) }, null, 2));
  return { count: files.length, replaced: existing.size };
}

async function pruneBackups(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.startsWith('update-')).sort();
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
    await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
}

let installing = false;

/** Download the newest commit and install it over this one. The caller restarts the server. */
export async function applyUpdate({ root = ROOT } = {}) {
  if (installing) throw new Error('An update is already being installed.');
  installing = true;
  let work;
  try {
    const check = await checkForUpdate({ root, force: true });
    if (!check.available) return { updated: false, sha: check.latest.sha };
    await mkdir(join(root, 'build'), { recursive: true });
    work = await mkdtemp(join(root, 'build', '.update-'));
    const zip = join(work, 'release.zip');
    await download(check.latest.sha, zip);
    const unpacked = join(work, 'tree');
    await mkdir(unpacked);
    const tree = await extract(zip, unpacked);
    const all = await releaseFiles(tree);
    const files = all.filter((name) => !(SEED_ONLY.has(name) && existsSync(join(root, name))));
    await verifyRelease(tree, all);
    const backup = join(backupsDir(root), `update-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(backup, { recursive: true });
    const result = await installRelease(tree, root, files, backup);
    const version = await readFile(join(tree, 'package.json'), 'utf8').then((t) => JSON.parse(t).version).catch(() => null);
    await writeFile(join(root, STAMP), JSON.stringify({ sha: check.latest.sha, version, updatedAt: Date.now() }, null, 2) + '\n');
    await pruneBackups(backupsDir(root));
    forgetCheck();
    return { updated: true, sha: check.latest.sha, version, ...result };
  } finally {
    installing = false;
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
