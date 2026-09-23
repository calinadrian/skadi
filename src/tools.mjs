// The agent's tool surface. Every tool is defined once here: its JSON schema for
// the model, and the function that runs it. Keeping both together means the
// schema can never drift from the implementation.
//
// All file paths are resolved inside the configured workspace. A model that has
// been talked into writing to C:\Windows should fail on the path check, not on
// good intentions.
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, relative, join, sep, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { unifiedDiff, statLine } from './diff.mjs';
import { styleWarning } from './style-check.mjs';
import { ROOT } from './config.mjs';
import { PlanNotice, planText, planToolResult } from './plans.mjs';
import { trackProcess } from './processes.mjs';
import { movePortsIfTaken, movedPortsNote } from './ports.mjs';

/**
 * Kill a spawned shell and whatever it started. `child.kill()` alone only
 * signals powershell.exe/cmd.exe itself -- a grandchild it launched (e.g.
 * `Start-Process node ...`, or a detached dev server) is not part of that
 * process and survives, becoming an orphan that keeps a port bound.
 */
export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill();
  }
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 30000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next']);
// Same image cap as the edit history (edits.mjs keeps its own copy -- no
// import cycle) and a total budget so a snapshot never holds unbounded text.
const MAX_SNAPSHOT_IMAGE = 1024 * 1024;
const MAX_SNAPSHOT_TOTAL = 32 * 1024 * 1024;

export class ToolError extends Error {}

// Harness internals the agent must never reach, even when the workspace is the
// Skadi folder itself. Chats are private the way they are in Claude: one
// session cannot read another's transcript, and nothing can read the stored
// provider keys. Memory and skills are deliberately absent -- those are the
// sanctioned way to carry something across sessions.
export const PRIVATE_DIRS = ['sessions', 'config', 'logs', 'attachments', 'voices'].map((d) => resolve(ROOT, d));

const PRIVATE_LABEL = {
  sessions: 'other chats are private; use memory to carry something across sessions',
  config: 'it holds provider credentials',
  logs: 'it holds raw prompt and server logs',
  attachments: 'it holds files from other chats',
  voices: "it holds the user's voice recording",
};

/** The private directory `target` sits in, or null. Also matches the dir itself. */
export function privateRoot(target) {
  const abs = resolve(target);
  for (const dir of PRIVATE_DIRS) {
    const rel = relative(dir, abs);
    if (rel === '' || (!rel.startsWith('..') && !(rel.includes(':') && rel !== ''))) return dir;
  }
  return null;
}

const dirName = (dir) => basename(dir).toLowerCase();

function refusePrivate(dir, input) {
  throw new ToolError(`${input} is off limits: ${PRIVATE_LABEL[dirName(dir)] ?? 'it is harness-internal'}`);
}

/**
 * A shell is not a sandbox, so this is a guard rail rather than a wall: it
 * catches a command that names a private directory, which is how a model
 * actually stumbles into one -- reading a sibling chat's transcript because it
 * wondered what it had been doing. Anything the shell could still reach by
 * obfuscating a path is out of scope here; the deterrent is that the plain way
 * fails and says why.
 */
export function privateCommandHit(command, cwd) {
  // Compare with one slash flavour so a Windows path and its forward-slash
  // spelling of the same directory both hit.
  const slash = (s) => String(s ?? '').split(sep).join('/').toLowerCase();
  const text = slash(command);
  const base = resolve(cwd || ROOT);
  for (const dir of PRIVATE_DIRS) {
    if (text.includes(slash(dir))) return dir;
  }
  const names = new Set(PRIVATE_DIRS.map(dirName));
  for (const token of text.split(/[\s'"`,;|()=]+/)) {
    if (!token || !token.split('/').some((seg) => names.has(seg))) continue;
    const hit = privateRoot(resolve(base, token));
    if (hit) return hit;
  }
  return null;
}

export function safePath(workspace, input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ToolError('path is required');
  }
  const root = resolve(workspace);
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (rel.startsWith('..') || (rel.includes(':') && rel !== '')) {
    throw new ToolError(`path escapes the workspace: ${input}`);
  }
  const priv = privateRoot(target);
  if (priv) refusePrivate(priv, input);
  return target;
}

// Long output keeps both ends. The start says what ran; the end is where a
// failing build or test run says why, and it is the part a head-only cut threw
// away. The cut lands on line boundaries so no line arrives half-read.
const CLIP_HEAD_CHARS = 8000;

export function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let headEnd = text.lastIndexOf('\n', CLIP_HEAD_CHARS);
  if (headEnd < CLIP_HEAD_CHARS / 2) headEnd = CLIP_HEAD_CHARS;
  let tailStart = text.indexOf('\n', text.length - (MAX_OUTPUT_CHARS - CLIP_HEAD_CHARS));
  if (tailStart < 0 || tailStart - (text.length - (MAX_OUTPUT_CHARS - CLIP_HEAD_CHARS)) > 2000) {
    tailStart = text.length - (MAX_OUTPUT_CHARS - CLIP_HEAD_CHARS);
  }
  const cut = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n... [${cut} characters cut from the middle; the start and the end are kept] ...${text.slice(tailStart)}`;
}

// ---- shell habits from elsewhere -------------------------------------------------

/**
 * Rewrite `a && b` / `a || b` for Windows PowerShell 5.1, which has neither:
 * `a; if ($?) { b }` and `a; if (-not $?) { b }`. Quoted text is left alone.
 */
export function chainForPowerShell(command) {
  const parts = [];
  const ops = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      parts.push(buf.trim());
      ops.push(ch);
      buf = '';
      i += 1;
    } else {
      buf += ch;
    }
  }
  if (!ops.length) return command;
  parts.push(buf.trim());
  // Not a chain with one reading (an empty side, or && and || mixed, whose
  // $? after a skipped `if` no longer means what bash means): leave it for
  // PowerShell to report.
  if (parts.some((p) => !p) || new Set(ops).size > 1) return command;
  // Nested, so each step still sees the $? of the step before it.
  const test = ops[0] === '&' ? '$?' : '-not $?';
  let out = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i -= 1) out = `${parts[i]}; if (${test}) { ${out} }`;
  return out;
}

// Commands that start something meant to keep running.
const SERVER_COMMAND = new RegExp(
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b`,
    String.raw`\bnpx\s+(vite|next\s+dev|serve|http-server|live-server)\b`,
    String.raw`^\s*(vite|http-server|live-server|serve)\b`,
    String.raw`\bnext\s+dev\b`,
    // python, py, or Start-Process with 'http.server' in its argument list.
    String.raw`\bhttp\.server\b`,
    String.raw`\b(flask\s+run|uvicorn\s|php\s+-S\s|manage\.py\s+runserver)`,
  ].join('|'),
  'i',
);

export const looksLikeServer = (command) => SERVER_COMMAND.test(String(command));

// Unix commands that fail in PowerShell, with what to write instead.
const UNIX_HABITS = [
  [/parameter name '(rf|fr|r|f)'/i, 'rm -rf', 'Remove-Item -Recurse -Force <path>'],
  [/'touch' is not recognized/i, 'touch', 'New-Item -ItemType File <path> (or edit with write_file)'],
  [/'which' is not recognized/i, 'which', 'Get-Command <name>'],
  [/'export' is not recognized/i, 'export', "$env:NAME = 'value'"],
  [/'head' is not recognized/i, 'head', 'Get-Content <file> -TotalCount 20 (or read_file with a line range)'],
  [/'tail' is not recognized/i, 'tail', 'Get-Content <file> -Tail 20'],
  [/'grep' is not recognized/i, 'grep', 'Select-String -Pattern <text> <files> (or the grep tool)'],
  [/'sed' is not recognized/i, 'sed', 'the edit_file tool'],
  [/'wc' is not recognized/i, 'wc -l', '(Get-Content <file>).Count'],
  [/parameter name 'p'.*\n?.*mkdir|mkdir.*parameter name 'p'/i, 'mkdir -p', 'New-Item -ItemType Directory -Force <path>'],
];

/** A line naming the PowerShell spelling of a Unix command that just failed. */
export function unixHabitHint(output) {
  const hits = UNIX_HABITS.filter(([re]) => re.test(output)).map(([, unix, ps]) => `\`${unix}\` → ${ps}`);
  return hits.length ? `Hint: this shell is Windows PowerShell 5.1. Use ${hits.join('; ')}.` : '';
}

// ---- helping a small model recover from a near miss --------------------------
//
// A small model's edits and paths are often almost right: \n where the file has
// \r\n, a tab where the file indents with spaces, src/app.js for app.js. Each of
// those used to end in a bare "not found", which it tends to answer by sending
// the identical call again. These helpers either apply the evidently intended
// change or say precisely what to send instead.

/** Paths in the workspace that are probably the one that was meant. */
async function suggestPaths(workspace, input, limit = 5) {
  const wanted = basename(String(input).replace(/\\/g, '/')).toLowerCase();
  if (!wanted) return [];
  const stem = wanted.replace(/\.[^.]+$/, '');
  const exact = [];
  const close = [];
  let seen = 0;
  const root = resolve(workspace);
  for await (const rel of walk(root, root)) {
    if (++seen > 20000) break;
    const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
    if (name === wanted) exact.push(rel);
    else if (stem.length >= 3 && name.replace(/\.[^.]+$/, '') === stem) close.push(rel);
    if (exact.length >= limit) break;
  }
  return [...exact, ...close].slice(0, limit);
}

async function missingFile(workspace, path) {
  const guesses = await suggestPaths(workspace, path).catch(() => []);
  return new ToolError(
    `no such file: ${path}` +
      (guesses.length ? `. Did you mean: ${guesses.join(', ')}?` : '. Use glob or list_dir to find it.'),
  );
}

const lineBreakOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withBreaks = (text, eol) => String(text).replace(/\r?\n/g, eol);
const leadOf = (line) => /^[ \t]*/.exec(line)[0];

/** The indent step a block uses: a tab, or the smallest gap between space indents. */
function indentUnit(lines, fallback) {
  const leads = lines.filter((l) => l.trim()).map(leadOf);
  if (leads.some((l) => l.includes('\t'))) return '\t';
  const widths = [...new Set(leads.map((l) => l.length))].sort((a, b) => a - b);
  let step = 0;
  for (let i = 1; i < widths.length; i += 1) {
    const gap = widths[i] - widths[i - 1];
    if (gap > 0 && (!step || gap < step)) step = gap;
  }
  if (!step) step = widths.find((w) => w > 0) || 0;
  return step ? ' '.repeat(step) : fallback;
}

/** How many indent steps deep a leading run of whitespace is. */
const levelsOf = (lead, unit) => (unit === '\t'
  ? [...lead].reduce((n, ch) => n + (ch === '\t' ? 1 : 0.25), 0)
  : [...lead].reduce((n, ch) => n + (ch === '\t' ? 1 : 1 / unit.length), 0));

/**
 * old_string matched nowhere exactly: look for the one place it matches when
 * only whitespace at the ends of lines is ignored. Returns the line range and
 * the replacement re-indented to the file's own style, or null when there is no
 * such place or more than one.
 */
function looseMatch(fileLines, oldText, newText) {
  const oldLines = oldText.split(/\r?\n/);
  while (oldLines.length > 1 && !oldLines[oldLines.length - 1].trim()) oldLines.pop();
  while (oldLines.length > 1 && !oldLines[0].trim()) oldLines.shift();
  const want = oldLines.map((l) => l.trim());
  if (!want.some(Boolean)) return null;

  const hits = [];
  for (let i = 0; i + want.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j += 1) ok = fileLines[i + j].trim() === want[j];
    if (ok) hits.push(i);
    if (hits.length > 1) return null;
  }
  if (hits.length !== 1) return null;

  const start = hits[0];
  const matched = fileLines.slice(start, start + want.length);
  const newLines = newText.split(/\r?\n/);
  const anchorOld = oldLines.find((l) => l.trim()) ?? '';
  const anchorFile = matched.find((l) => l.trim()) ?? '';
  const fileUnit = indentUnit(matched.length > 1 ? matched : fileLines, '  ');
  const oldUnit = indentUnit([...oldLines, ...newLines], fileUnit);
  const baseLevels = levelsOf(leadOf(anchorOld), oldUnit);
  const fileLead = leadOf(anchorFile);
  const replacement = newLines.map((line) => {
    if (!line.trim()) return '';
    const rel = Math.round(levelsOf(leadOf(line), oldUnit) - baseLevels);
    const lead = rel >= 0
      ? fileLead + fileUnit.repeat(rel)
      : fileLead.slice(0, Math.max(0, fileLead.length - fileUnit.length * -rel));
    return lead + line.trimStart();
  });
  return { start, count: want.length, replacement };
}

/** The lines most like old_string, numbered, for a retry that copies them exactly. */
function closestLines(fileLines, oldText) {
  const want = oldText.split(/\r?\n/).map((l) => l.trim());
  const size = Math.max(1, want.length);
  let best = { score: 0, at: -1 };
  for (let i = 0; i < fileLines.length; i += 1) {
    let score = 0;
    for (let j = 0; j < size && i + j < fileLines.length; j += 1) {
      const have = fileLines[i + j].trim();
      if (want[j] && have === want[j]) score += 2;
      else if (want[j] && have && (have.includes(want[j]) || want[j].includes(have))) score += 1;
    }
    if (score > best.score) best = { score, at: i };
  }
  if (best.at < 0) {
    // Nothing lines up: fall back to the first line naming the longest identifier.
    const word = (oldText.match(/[A-Za-z_$][\w$]{3,}/g) || []).sort((a, b) => b.length - a.length)[0];
    const at = word ? fileLines.findIndex((l) => l.includes(word)) : -1;
    if (at < 0) return null;
    best = { at };
  }
  const from = best.at;
  const to = Math.min(fileLines.length, from + Math.min(size + 1, 12));
  const body = fileLines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(5)}\t${l}`).join('\n');
  return { from: from + 1, to, body };
}

const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
};

/**
 * Fast content search when ripgrep is installed. Returns null only when rg is
 * unavailable or cannot parse a pattern that JavaScript may still support.
 */
function searchWithRipgrep(root, { pattern, glob, ignoreCase }) {
  const args = [
    '--line-number', '--no-heading', '--color', 'never', '--hidden',
    '--max-columns', '240', '--max-columns-preview',
  ];
  if (ignoreCase) args.push('--ignore-case');
  if (glob) args.push('--glob', glob);
  for (const dir of SKIP_DIRS) args.push('--glob', `!**/${dir}/**`);
  for (const dir of PRIVATE_DIRS) {
    if (!inside(root, dir)) continue;
    const rel = relative(root, dir).split(sep).join('/');
    if (rel) args.push('--glob', `!${rel}/**`);
  }
  args.push('--', pattern, '.');

  return new Promise((resolveSearch) => {
    let settled = false;
    let text = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveSearch(value);
    };
    let child;
    try {
      child = spawn('rg', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const lines = text.split(/\r?\n/);
      if (lines.length > 200) {
        text = lines.slice(0, 200).join('\n');
        child.kill();
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && code !== 1 && !text.trim()) return finish(null);
      const normalized = text.trim().split(/\r?\n/).map((line) => {
        const colon = line.indexOf(':');
        if (colon < 0) return line;
        const path = line.slice(0, colon).replace(/^\.[/\\]/, '').replace(/\\/g, '/');
        return `${path}${line.slice(colon)}`;
      }).join('\n');
      finish(normalized || '');
    });
  });
}

/** Portable fallback that searches files line-by-line instead of loading them whole. */
async function searchWithJavaScript(root, { re, fileFilter }) {
  const hits = [];
  for await (const rel of walk(root, root)) {
    if (fileFilter && !fileFilter.test(rel)) continue;
    const input = createReadStream(join(root, rel), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        // A NUL is a strong binary-file signal. Stop before binary noise can
        // consume the search output or model context.
        if (line.includes('\0')) break;
        if (!re.test(line)) continue;
        hits.push(`${rel}:${lineNumber}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= 200) {
          input.destroy();
          return hits.join('\n');
        }
      }
    } catch {
      // Unreadable or concurrently replaced files are simply skipped, matching
      // ripgrep's repository-search behavior.
    } finally {
      lines.close();
      input.destroy();
    }
  }
  return hits.join('\n');
}

/** Convert a glob to a regex. Supports *, **, ? and {a,b} alternation. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') out += '(';
    else if (ch === '}') out += ')';
    else if (ch === ',') out += '|';
    else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

async function* walk(dir, root, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (privateRoot(full)) continue;
      yield* walk(full, root, depth + 1);
    } else if (entry.isFile()) {
      yield relative(root, full).split(sep).join('/');
    }
  }
}

// A shell is not a sandbox: a command can write anything the workspace owns,
// so run_command catches its changes the way the file tools do -- snapshot
// before, diff after, fold each changed file into the session's edit history.
// Background tasks are excluded on purpose: they outlive the call, so their
// writes would be attributed to whoever runs the next command.
//
// A file counts as changed when its mtime or size moves; a same-size rewrite
// landing in the same millisecond is accepted as a miss rather than paying
// for a full content compare.
async function snapshotTree(root, { images = false } = {}) {
  const files = new Map();
  let held = 0;
  for await (const rel of walk(root, root)) {
    const info = await stat(join(root, rel)).catch(() => null);
    if (!info || !info.isFile()) continue;
    let content = null;
    if (images && info.size <= MAX_SNAPSHOT_IMAGE && held + info.size <= MAX_SNAPSHOT_TOTAL) {
      try {
        content = await readFile(join(root, rel), 'utf8');
      } catch {
        content = null; // unreadable: still counted, just not diffable
      }
      if (content != null) held += info.size;
    }
    files.set(rel, { mtime: info.mtimeMs, size: info.size, content });
  }
  return files;
}

function changeEntry(verb, rel, existed, beforeContent, afterContent) {
  // A NUL marks a binary file; a missing image means the file was too big to
  // hold. Either way the change is counted in the bar but cannot be diffed
  // or undone.
  const text = (s) => s != null && !s.includes('\0');
  if (!text(beforeContent) || !text(afterContent)) {
    return { verb, rel, existed, before: null, after: null, added: null, removed: null };
  }
  const d = unifiedDiff(beforeContent, afterContent);
  return { verb, rel, existed, before: beforeContent, after: afterContent, added: d.added, removed: d.removed };
}

async function diffSnapshots(root, before, after) {
  const readAfter = async (rel, size) => {
    if (size > MAX_SNAPSHOT_IMAGE) return null;
    try {
      return await readFile(join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const changes = [];
  for (const [rel, b] of before) {
    const a = after.get(rel);
    if (!a) {
      changes.push(changeEntry('Deleted', rel, true, b.content ?? '', ''));
      continue;
    }
    if (a.mtime === b.mtime && a.size === b.size) continue;
    changes.push(changeEntry('Changed', rel, true, b.content ?? '', await readAfter(rel, a.size)));
  }
  for (const [rel, a] of after) {
    if (before.has(rel)) continue;
    changes.push(changeEntry('Created', rel, false, '', await readAfter(rel, a.size)));
  }
  return changes;
}

/** One line for the tool result: the files a command changed, with stats. */
function workspaceChangesLine(changes) {
  const shown = changes.slice(0, 8).map((c) =>
    c.added == null ? c.rel : statLine(c.verb, c.rel, c.added, c.removed),
  );
  return `[harness] workspace changes: ${shown.join(', ')}${changes.length > 8 ? ` (+${changes.length - 8} more)` : ''}`;
}

/**
 * ctx carries { workspace, settings, approve } where `approve` is an async
 * predicate the server wires to the UI's approval prompt.
 */
export function buildTools(ctx) {
  const tools = {
    read_file: {
      schema: {
        description:
          'Read numbered lines from a UTF-8 workspace file. Search with grep first, then use start_line/end_line for the relevant region. Files over 256 KB require an explicit line range.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the workspace root.' },
            start_line: { type: 'integer', description: 'First line to return (1-based).' },
            end_line: { type: 'integer', description: 'Last line to return, inclusive.' },
          },
          required: ['path'],
        },
      },
      async run({ path, start_line, end_line }) {
        const file = safePath(ctx.workspace, path);
        const info = await stat(file).catch(() => null);
        if (!info) throw await missingFile(ctx.workspace, path);
        if (info.isDirectory()) throw new ToolError(`${path} is a directory; use list_dir`);
        const ranged = Number.isInteger(start_line) || Number.isInteger(end_line);
        if (info.size > MAX_READ_BYTES && !ranged) {
          throw new ToolError(
            `${path} is ${(info.size / 1024).toFixed(0)} KB, over the ${MAX_READ_BYTES / 1024} KB whole-file limit. Retry with an explicit range, for example: {"path":"${path}","start_line":1,"end_line":200}.`,
          );
        }
        const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
        const from = Math.max(1, start_line || 1);
        const to = Math.min(lines.length, end_line || lines.length);
        if (to < from) throw new ToolError(`end_line must be greater than or equal to start_line (${from})`);
        const body = lines
          .slice(from - 1, to)
          .map((line, i) => `${String(from + i).padStart(5)}\t${line}`)
          .join('\n');
        return clip(body || '(empty file)');
      },
    },

    write_file: {
      mutates: true,
      schema: {
        description:
          'Create a file or overwrite it completely. For a small change to an existing file prefer edit_file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      async run({ path, content }, meta) {
        const file = safePath(ctx.workspace, path);
        await mkdir(dirname(file), { recursive: true });
        const existed = existsSync(file);
        const before = existed ? await readFile(file, 'utf8').catch(() => '') : '';
        await writeFile(file, content ?? '', 'utf8');
        const { diff, added, removed } = unifiedDiff(before, content ?? '');
        ctx.recordEdit?.({ callId: meta?.callId ?? null, path, before, after: content ?? '', added, removed, existed });
        const lines = String(content ?? '').split('\n').length;
        const warn = await styleWarning(ctx.workspace, path, before, content ?? '').catch(() => '');
        return `${statLine(existed ? 'Overwrote' : 'Created', path, added, removed)} (${lines} lines)${diff ? `\n\`\`\`diff\n${diff}\n\`\`\`` : ''}${warn}`;
      },
    },

    edit_file: {
      mutates: true,
      schema: {
        description:
          'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. ' +
          'Copy old_string from read_file output without the line-number prefix.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: 'Exact text to find, including indentation.' },
            new_string: { type: 'string', description: 'Text to put in its place.' },
            replace_all: { type: 'boolean' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
      async run({ path, old_string, new_string, replace_all }, meta) {
        const file = safePath(ctx.workspace, path);
        if (!existsSync(file)) throw await missingFile(ctx.workspace, path);
        if (typeof old_string !== 'string' || !old_string) {
          throw new ToolError('old_string is empty. To create or replace a whole file use write_file.');
        }
        const before = await readFile(file, 'utf8');
        // The model writes \n; a Windows file has \r\n. Speak the file's
        // dialect, or every multi-line edit to a CRLF file misses.
        const eol = lineBreakOf(before);
        const next = withBreaks(new_string ?? '', eol);
        let old = old_string;
        let count = before.split(old).length - 1;
        if (count === 0 && withBreaks(old, eol) !== old) {
          old = withBreaks(old, eol);
          count = before.split(old).length - 1;
        }
        let after;
        let note = '';
        if (count === 0) {
          const fileLines = before.split(/\r?\n/);
          const loose = replace_all ? null : looseMatch(fileLines, old_string, new_string ?? '');
          if (!loose) {
            const near = closestLines(fileLines, old_string);
            throw new ToolError(
              `old_string not found in ${path}.` +
                (near
                  ? ` Closest text is lines ${near.from}-${near.to}; copy it exactly (without the line numbers) and retry:\n${near.body}`
                  : ' Read the file again with read_file and copy the text exactly.'),
            );
          }
          // One place matches once whitespace is ignored: apply it there,
          // indented the way the file indents, and say so.
          const lines = [...fileLines];
          lines.splice(loose.start, loose.count, ...loose.replacement);
          after = lines.join(eol);
          count = 1;
          note = `; matched lines ${loose.start + 1}-${loose.start + loose.count} ignoring whitespace, indented as the file is -- check the diff`;
        } else if (count > 1 && !replace_all) {
          throw new ToolError(
            `old_string appears ${count} times in ${path}. Add more surrounding context, or pass replace_all.`,
          );
        } else {
          // A function replacement, so "$&" or "$1" in the new text is written literally.
          after = replace_all ? before.split(old).join(next) : before.replace(old, () => next);
        }
        await writeFile(file, after, 'utf8');
        const { diff, added, removed } = unifiedDiff(before, after);
        ctx.recordEdit?.({ callId: meta?.callId ?? null, path, before, after, added, removed, existed: true });
        const n = replace_all ? count : 1;
        const warn = await styleWarning(ctx.workspace, path, before, after).catch(() => '');
        return `${statLine('Edited', path, added, removed)} (${n} replacement${n > 1 ? 's' : ''}${note})${diff ? `\n\`\`\`diff\n${diff}\n\`\`\`` : ''}${warn}`;
      },
    },

    list_dir: {
      schema: {
        description: 'List the entries of a directory in the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Defaults to the workspace root.' } },
        },
      },
      async run({ path }) {
        const dir = safePath(ctx.workspace, path || '.');
        let entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
        if (!entries) throw new ToolError(`no such directory: ${path || '.'}`);
        // Private dirs are not listed at all -- a name is a hint worth hiding.
        entries = entries.filter((e) => !privateRoot(join(dir, e.name)));
        if (!entries.length) return '(empty directory)';
        const rows = await Promise.all(
          entries.map(async (e) => {
            if (e.isDirectory()) return `${e.name}/`;
            const info = await stat(join(dir, e.name)).catch(() => null);
            return `${e.name}\t${info ? `${(info.size / 1024).toFixed(1)} KB` : ''}`;
          }),
        );
        return clip(rows.sort().join('\n'));
      },
    },

    glob: {
      schema: {
        description: 'Find files by glob pattern, e.g. "src/**/*.mjs". Returns paths only.',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern'],
        },
      },
      async run({ pattern }) {
        const re = globToRegExp(pattern);
        const hits = [];
        for await (const rel of walk(resolve(ctx.workspace), resolve(ctx.workspace))) {
          if (re.test(rel)) hits.push(rel);
          if (hits.length >= 500) break;
        }
        return hits.length ? clip(hits.join('\n')) : `no files match ${pattern}`;
      },
    },

    grep: {
      schema: {
        description: 'Search repository contents before reading files. Uses ripgrep when available and a streaming fallback otherwise. Searches large files and returns path:line: match.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'JavaScript regular expression.' },
            glob: { type: 'string', description: 'Optional file filter, e.g. "**/*.mjs".' },
            ignore_case: { type: 'boolean' },
          },
          required: ['pattern'],
        },
      },
      async run({ pattern, glob, ignore_case }) {
        let re;
        try {
          re = new RegExp(pattern, ignore_case ? 'i' : '');
        } catch (err) {
          throw new ToolError(`bad regular expression: ${err.message}`);
        }
        const fileFilter = glob ? globToRegExp(glob) : null;
        const root = resolve(ctx.workspace);
        const native = await searchWithRipgrep(root, { pattern, glob, ignoreCase: ignore_case });
        const result = native == null
          ? await searchWithJavaScript(root, { re, fileFilter })
          : native;
        return result ? clip(result) : `no matches for ${pattern}`;
      },
    },

    run_command: {
      mutates: true,
      schema: {
        description:
          'Run a shell command in the workspace and return its output. Use for builds, tests and git. Not for editing files. ' +
          'Pass background:true for long builds or test suites: the task keeps running after this turn, its output streams ' +
          'to the Background tasks panel, and completion resumes the owning chat with a system event. Use task_log ' +
          'to check on it and task_stop to kill it.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Defaults to powershell.' },
            background: {
              type: 'boolean',
              description: 'Run detached: returns a task id immediately instead of waiting for output.',
            },
          },
          required: ['command'],
        },
      },
      async run({ command, shell, background }, meta = {}) {
        const priv = privateCommandHit(command, ctx.workspace);
        if (priv) {
          const name = dirName(priv);
          throw new ToolError(
            `this command reaches into ${name}/, which is harness-internal and off limits` +
              (name === 'sessions' ? '. Each chat is private -- you cannot read another session.' : '.'),
          );
        }
        const root = resolve(ctx.workspace);
        // Windows PowerShell 5.1 refuses && and || outright; cmd has them.
        if (shell !== 'cmd') command = chainForPowerShell(command);
        // A server started on a taken port fails, or seems to work while the
        // page shows whatever held the port first. Move it to a free one.
        let portNote = '';
        if (looksLikeServer(command)) {
          const { command: freed, moved } = await movePortsIfTaken(command);
          if (moved.length) {
            command = freed;
            portNote = `${movedPortsNote(moved)}\n`;
          }
        }
        // A dev server never exits: in the foreground it would hold the turn
        // until the timeout killed it. Such commands go to the background.
        const server = !background && ctx.startBackground && looksLikeServer(command);
        if (server) background = true;
        // Background tasks are not snapshot-diffed: the process outlives this
        // call, so its writes would land in the next command's before/after.
        if (background && ctx.startBackground) {
          const task = ctx.startBackground({ command, shell });
          return (
            portNote +
            (server ? 'This looks like a server that keeps running, so it was started in the background.\n' : '') +
            `Started background task ${task.id}: ${command}\n` +
            `It keeps running while you continue. Read its output anytime with task_log (task_id "${task.id}"); ` +
            `when it finishes, its result is delivered to this chat and the agent resumes automatically.`
          );
        }
        const timeoutSec = ctx.settings.commandTimeoutSec ?? 120;
        const isCmd = shell === 'cmd';
        const exe = isCmd ? 'cmd.exe' : 'powershell.exe';
        const args = isCmd
          ? ['/c', command]
          : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];

        // Snapshot before the command so its writes can be folded into the
        // session's edit history the way write_file/edit_file do. Best effort:
        // a failed snapshot only means this command's changes go uncounted.
        let before;
        try {
          before = await snapshotTree(root, { images: true });
        } catch {
          before = null;
        }

        return new Promise((resolvePromise) => {
          const child = spawn(exe, args, {
            cwd: root,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          // Whatever this starts and leaves running stops when Skadi does.
          trackProcess(child.pid);
          let out = '';
          const append = (d) => {
            out += d;
            if (out.length > MAX_OUTPUT_CHARS * 2) killTree(child);
          };
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', append);
          child.stderr.on('data', append);

          const timer = setTimeout(() => {
            killTree(child);
            out += `\n[harness] killed after ${timeoutSec}s`;
          }, timeoutSec * 1000);

          // Stop must be immediate even while a command is running: without
          // this, aborting the turn only stopped the agent loop, leaving the
          // child (and this promise) running until the timeout above fired.
          const onAbort = () => {
            killTree(child);
            out += '\n[harness] stopped by user';
          };
          meta.signal?.addEventListener('abort', onAbort);

          child.on('error', (err) => {
            clearTimeout(timer);
            meta.signal?.removeEventListener('abort', onAbort);
            resolvePromise(`[harness] failed to start: ${err.message}`);
          });
          child.on('close', async (code) => {
            clearTimeout(timer);
            meta.signal?.removeEventListener('abort', onAbort);
            const hint = isCmd ? '' : unixHabitHint(out);
            const base = `${portNote}exit code ${code}\n${out.trim() || '(no output)'}${hint ? `\n\n${hint}` : ''}`;
            let changes = [];
            if (before) {
              try {
                const after = await snapshotTree(root, { images: false });
                changes = await diffSnapshots(root, before, after);
                for (const c of changes) {
                  ctx.recordEdit?.({
                    callId: meta?.callId ?? null,
                    path: c.rel,
                    before: c.before,
                    after: c.after,
                    added: c.added,
                    removed: c.removed,
                    existed: c.existed,
                  });
                }
              } catch {
                changes = []; // output is the contract; change tracking is best effort
              }
            }
            resolvePromise(clip(changes.length ? `${base}\n${workspaceChangesLine(changes)}` : base));
          });
        });
      },
    },

    delete_file: {
      mutates: true,
      schema: {
        description: 'Delete a file from the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      async run({ path }) {
        const file = safePath(ctx.workspace, path);
        if (!existsSync(file)) throw await missingFile(ctx.workspace, path);
        await rm(file);
        return `Deleted ${path}`;
      },
    },

    task_log: {
      schema: {
        description:
          'Read a background task started with run_command background:true. Without a task_id, lists all tasks.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            max_chars: { type: 'integer', description: 'Tail of output to return. Defaults to 8000.' },
          },
        },
      },
      async run({ task_id, max_chars }) {
        if (!ctx.tasks) throw new ToolError('background tasks are unavailable');
        if (!task_id) {
          const all = ctx.tasks.list();
          if (!all.length) return 'no background tasks';
          return all
            .map((t) => `${t.id} [${t.status}] ${t.command} (started ${new Date(t.startedAt).toLocaleTimeString()})`)
            .join('\n');
        }
        return ctx.tasks.log(task_id, max_chars ?? 8000);
      },
    },

    task_stop: {
      mutates: true,
      schema: {
        description: 'Stop a running background task.',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
      async run({ task_id }) {
        if (!ctx.tasks) throw new ToolError('background tasks are unavailable');
        return ctx.tasks.stop(task_id);
      },
    },
  };

  // Only parent chat agents receive this callback. Read-only subagents use the
  // same filesystem tools but must not own or rewrite the user's live plan.
  if (ctx.updatePlan) {
    tools.update_plan = {
      schema: {
        description:
          'A short checklist for bigger, multi-step tasks (skip it for small ones). Start with action "set" and 3-6 short steps; the first step becomes current. ' +
          'When a step is finished, use action "status" with its step number and status "done"; the next step starts automatically. ' +
          'Never spend a response on the plan alone: call update_plan in the same response as your next real tool call. ' +
          'The user can edit the plan at any time: follow it as written and never do skipped steps.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'status', 'add', 'edit'], description: 'set = write the whole plan; status = change one step; add = append a step; edit = reword a step.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'For action=set: the steps in order, each a short outcome such as "Fix the login check".' },
            step: { type: 'integer', description: 'Step number, starting at 1 (for status and edit).' },
            status: { type: 'string', enum: ['working', 'done', 'blocked', 'skipped', 'queued'], description: 'For action=status.' },
            text: { type: 'string', description: 'Step text for add or edit.' },
            note: { type: 'string', description: 'Optional short note, e.g. what blocked the step.' },
          },
          required: ['action'],
        },
      },
      async run(args) {
        // A conflict with the user's edits, or a step number that does not
        // exist, is explained rather than raised: an error card in the chat
        // gives a small model nothing to act on, where the current plan does.
        try {
          return planToolResult(await ctx.updatePlan(args));
        } catch (err) {
          if (err instanceof PlanNotice) return `Plan not changed: ${err.message}.\n${planText(err.plan)}`;
          throw err;
        }
      },
    };
  }

  return tools;
}

// Names models reach for out of habit -- other harnesses' tools and shell
// commands -- mapped to the tool here that does that job.
const TOOL_HABITS = {
  bash: 'run_command', shell: 'run_command', sh: 'run_command', cmd: 'run_command', powershell: 'run_command',
  exec: 'run_command', execute: 'run_command', terminal: 'run_command', run: 'run_command',
  cat: 'read_file', open: 'read_file', view: 'read_file', open_file: 'read_file', view_file: 'read_file',
  ls: 'list_dir', dir: 'list_dir', list_files: 'list_dir', list_directory: 'list_dir',
  write: 'write_file', create_file: 'write_file', save_file: 'write_file',
  str_replace: 'edit_file', replace: 'edit_file', replace_in_file: 'edit_file', apply_patch: 'edit_file',
  search: 'grep', search_files: 'grep', rg: 'grep', find: 'glob', find_files: 'glob',
  rm: 'delete_file', remove_file: 'delete_file',
};

const squash = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * What a tool name that does not exist most likely meant. `exact` is set when
 * the difference is only case and separators (readFile, read-file, READ_FILE):
 * one reading, safe to run as is. Otherwise `suggestions` holds up to three
 * real names, closest first, to offer back to the model.
 */
export function suggestToolName(name, names) {
  const want = squash(name);
  const exact = names.find((n) => squash(n) === want);
  if (exact) return { exact, suggestions: [exact] };
  const scored = [];
  const habit = TOOL_HABITS[String(name).toLowerCase().replace(/[-\s]/g, '_')];
  if (habit && names.includes(habit)) scored.push({ n: habit, score: -1 });
  for (const n of names) {
    if (n === habit) continue;
    const have = squash(n);
    const distance = editDistance(want, have);
    // "read" for read_file, "file_read" for read_file: containment either way.
    const contains = want.length >= 3 && (have.includes(want) || want.includes(have));
    if (contains) scored.push({ n, score: 0.5 + Math.abs(have.length - want.length) / 100 });
    else if (distance <= Math.max(2, Math.floor(want.length / 3))) scored.push({ n, score: distance });
  }
  scored.sort((a, b) => a.score - b.score);
  return { exact: null, suggestions: scored.slice(0, 3).map((s) => s.n) };
}

/** OpenAI-format tool list for the chat completions request. */
export function toolSchemas(tools) {
  return Object.entries(tools).map(([name, def]) => ({
    type: 'function',
    function: { name, description: def.schema.description, parameters: def.schema.parameters ?? { type: 'object', properties: {} } },
  }));
}
