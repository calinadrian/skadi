// Read-only git access for the working-tree viewer. Everything runs with
// `git -C <workspace>` so a repo is never required and nothing can escape it.
// No staging, no commits, no pushes -- the model already has run_command for
// anything beyond looking.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const MAX_DIFF_CHARS = 200 * 1024;

function runGit(cwd, args, { maxBuffer = MAX_DIFF_CHARS } = {}) {
  return new Promise((resolvePromise) => {
    execFile('git', ['-C', resolve(cwd), ...args], { maxBuffer, windowsHide: true }, (err, stdout) => {
      // exit code 1 from `git diff --quiet`-style checks is data, not failure,
      // but here every call tolerates output-on-error by just returning it.
      if (err && !stdout) return resolvePromise({ ok: false, error: err.message });
      resolvePromise({ ok: true, out: stdout });
    });
  });
}

export async function isRepo(cwd) {
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.out.trim() === 'true';
}

/** Branch name for the "X → working tree" header (short SHA when detached). */
export async function branchName(cwd) {
  const b = await runGit(cwd, ['branch', '--show-current']);
  if (b.ok && b.out.trim()) return b.out.trim();
  const h = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
  return h.ok && h.out.trim() ? `detached @ ${h.out.trim()}` : 'HEAD';
}

// What every diff is measured against when the repo has no commits yet.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 1000;
const MAX_COUNTED_BYTES = 1024 * 1024;

/** HEAD, or the empty tree in a repo that has no commits: `diff HEAD` fails there. */
async function baseRef(cwd) {
  const r = await runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.ok && r.out.trim() ? 'HEAD' : EMPTY_TREE;
}

/** Lines in a new file, or null for binary/unreadable/huge -- what `+N` would say. */
async function countLines(cwd, path) {
  try {
    const file = resolve(cwd, path);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_COUNTED_BYTES) return null;
    const buf = await readFile(file);
    if (buf.subarray(0, 8192).includes(0)) return null;
    if (!buf.length) return 0;
    let n = 0;
    for (const byte of buf) if (byte === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}

/**
 * Working-tree status for the project folder: one row per changed file with
 * index/worktree codes and added/removed line counts against HEAD (staged +
 * unstaged together, one "branch -> working tree" column). Paths are relative
 * to `cwd`, so a project that is a subfolder of a larger repo lists only its
 * own files and can diff them by the names it shows. New files are counted
 * too, and every file inside a new folder is listed, not just the folder.
 */
export async function gitStatus(cwd) {
  if (!(await isRepo(cwd))) return { isRepo: false, files: [] };

  const base = await baseRef(cwd);
  const [branch, porcelain, numstat] = await Promise.all([
    branchName(cwd),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.'], { maxBuffer: 16 * 1024 * 1024 }),
    runGit(cwd, ['-c', 'core.quotepath=false', 'diff', base, '--numstat', '-z', '--no-renames', '--relative', '--', '.'], { maxBuffer: 16 * 1024 * 1024 }),
  ]);
  // status paths are relative to the repo root; strip down to `cwd`.
  const prefix = (await runGit(cwd, ['rev-parse', '--show-prefix'])).out?.trim() || '';

  const counts = new Map();
  if (numstat.ok) {
    for (const entry of numstat.out.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry.replace(/^\n/, ''));
      if (m) counts.set(m[3], { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
    }
  }

  const files = [];
  let truncated = false;
  if (porcelain.ok) {
    for (const entry of porcelain.out.split('\0')) {
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      let path = entry.slice(3);
      if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
      if (files.length >= MAX_FILES) { truncated = true; break; }
      files.push({ path, index: code[0], worktree: code[1], added: null, removed: null });
    }
  }
  await Promise.all(files.map(async (f) => {
    const c = counts.get(f.path);
    if (c) { f.added = c.added; f.removed = c.removed; return; }
    if (f.index === '?') { f.added = await countLines(cwd, f.path); f.removed = f.added == null ? null : 0; }
  }));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { isRepo: true, branch, files, truncated };
}

/** Diff one path: against HEAD when tracked, against nothing when new. */
async function diffOne(cwd, path) {
  const clean = String(path).replace(/\/$/, '');
  const base = await baseRef(cwd);
  const tracked = await runGit(cwd, ['ls-files', '--error-unmatch', '--', clean]);
  // --no-index exit code 1 on differences is data, and runGit keeps stdout.
  const args = tracked.ok
    ? ['diff', base, '-U3', '--no-color', '--no-ext-diff', '--', clean]
    : ['diff', '--no-index', '--no-color', '-U3', '--', '/dev/null', clean];
  const r = await runGit(cwd, args);
  return r.ok ? r.out : '';
}

const capDiff = (diff) =>
  diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated]` : diff;

/** Unified diff of the working tree against HEAD, optionally one path. */
export async function gitDiff(cwd, path = null) {
  if (!(await isRepo(cwd))) return { isRepo: false, diff: '' };
  if (path) return { isRepo: true, diff: capDiff(await diffOne(cwd, path)) };

  const r = await runGit(cwd, ['diff', await baseRef(cwd), '-U3', '--no-color', '--no-ext-diff', '--', '.']);
  let diff = r.ok ? r.out : '';
  // `git diff HEAD` skips untracked files; render those as additions.
  const st = await gitStatus(cwd);
  const fresh = (st.files || []).filter((f) => f.index === '?').slice(0, 30);
  for (const f of fresh) {
    const one = await diffOne(cwd, f.path);
    if (one) diff += (diff ? '\n' : '') + one;
  }
  if ((st.files || []).filter((f) => f.index === '?').length > fresh.length) {
    diff += '\n... [more untracked files omitted]';
  }
  return { isRepo: true, diff: capDiff(diff) };
}
