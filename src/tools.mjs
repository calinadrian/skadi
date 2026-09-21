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
import { ROOT } from './config.mjs';

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 30000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next']);

export class ToolError extends Error {}

// Harness internals the agent must never reach, even when the workspace is the
// Skadi folder itself. Chats are private the way they are in Claude: one
// session cannot read another's transcript, and nothing can read the stored
// provider keys. Memory and skills are deliberately absent -- those are the
// sanctioned way to carry something across sessions.
export const PRIVATE_DIRS = ['sessions', 'config', 'logs', 'attachments'].map((d) => resolve(ROOT, d));

const PRIVATE_LABEL = {
  sessions: 'other chats are private; use memory to carry something across sessions',
  config: 'it holds provider credentials',
  logs: 'it holds raw prompt and server logs',
  attachments: 'it holds files from other chats',
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

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated, ${text.length - MAX_OUTPUT_CHARS} more characters]`;
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
        if (!info) throw new ToolError(`no such file: ${path}`);
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
        return `${statLine(existed ? 'Overwrote' : 'Created', path, added, removed)} (${lines} lines)${diff ? `\n\`\`\`diff\n${diff}\n\`\`\`` : ''}`;
      },
    },

    edit_file: {
      mutates: true,
      schema: {
        description:
          'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.',
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
        if (!existsSync(file)) throw new ToolError(`no such file: ${path}`);
        const before = await readFile(file, 'utf8');
        const count = before.split(old_string).length - 1;
        if (count === 0) throw new ToolError(`old_string not found in ${path}`);
        if (count > 1 && !replace_all) {
          throw new ToolError(
            `old_string appears ${count} times in ${path}. Add more surrounding context, or pass replace_all.`,
          );
        }
        const after = replace_all
          ? before.split(old_string).join(new_string)
          : before.replace(old_string, new_string);
        await writeFile(file, after, 'utf8');
        const { diff, added, removed } = unifiedDiff(before, after);
        ctx.recordEdit?.({ callId: meta?.callId ?? null, path, before, after, added, removed, existed: true });
        const n = replace_all ? count : 1;
        return `${statLine('Edited', path, added, removed)} (${n} replacement${n > 1 ? 's' : ''})${diff ? `\n\`\`\`diff\n${diff}\n\`\`\`` : ''}`;
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
          'to the Background tasks panel, and a note with the result lands in the session when it finishes. Use task_log ' +
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
      async run({ command, shell, background }) {
        const priv = privateCommandHit(command, ctx.workspace);
        if (priv) {
          const name = dirName(priv);
          throw new ToolError(
            `this command reaches into ${name}/, which is harness-internal and off limits` +
              (name === 'sessions' ? '. Each chat is private -- you cannot read another session.' : '.'),
          );
        }
        if (background && ctx.startBackground) {
          const task = ctx.startBackground({ command, shell });
          return (
            `Started background task ${task.id}: ${command}\n` +
            `It keeps running while you continue. Read its output anytime with task_log (task_id "${task.id}"); ` +
            `its result lands in this session when it finishes.`
          );
        }
        const timeoutSec = ctx.settings.commandTimeoutSec ?? 120;
        const isCmd = shell === 'cmd';
        const exe = isCmd ? 'cmd.exe' : 'powershell.exe';
        const args = isCmd
          ? ['/c', command]
          : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];

        return new Promise((resolvePromise) => {
          const child = spawn(exe, args, {
            cwd: resolve(ctx.workspace),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          const append = (d) => {
            out += d;
            if (out.length > MAX_OUTPUT_CHARS * 2) child.kill();
          };
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', append);
          child.stderr.on('data', append);

          const timer = setTimeout(() => {
            child.kill();
            out += `\n[harness] killed after ${timeoutSec}s`;
          }, timeoutSec * 1000);

          child.on('error', (err) => {
            clearTimeout(timer);
            resolvePromise(`[harness] failed to start: ${err.message}`);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolvePromise(clip(`exit code ${code}\n${out.trim() || '(no output)'}`));
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
        if (!existsSync(file)) throw new ToolError(`no such file: ${path}`);
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
          'Create and maintain the chat execution plan. For medium or hard implementation work, set a concise 3-8 step outcome plan before broad work, then mark a step working/done/blocked/review as progress changes. The user can edit, reorder, skip, or delete items at any time; never recreate skipped/deleted work or replace a user-edited plan.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'add', 'edit', 'status', 'move', 'remove', 'restore'] },
            items: {
              type: 'array',
              description: 'Initial ordered steps for action=set.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: ['queued', 'working', 'blocked', 'review', 'done', 'skipped'] },
                  note: { type: 'string' },
                  required: { type: 'boolean' },
                },
                required: ['text'],
              },
            },
            itemId: { type: 'string', description: 'Target item id for edit/status/move/remove/restore.' },
            text: { type: 'string', description: 'Short outcome-focused step text for add/edit.' },
            status: { type: 'string', enum: ['queued', 'working', 'blocked', 'review', 'done', 'skipped'] },
            note: { type: 'string', description: 'Optional concise progress evidence or blocker.' },
            required: { type: 'boolean' },
            index: { type: 'integer', description: 'Zero-based insertion or destination position.' },
          },
          required: ['action'],
        },
      },
      async run(args) {
        return JSON.stringify(await ctx.updatePlan(args), null, 2);
      },
    };
  }

  return tools;
}

/** OpenAI-format tool list for the chat completions request. */
export function toolSchemas(tools) {
  return Object.entries(tools).map(([name, def]) => ({
    type: 'function',
    function: { name, description: def.schema.description, parameters: def.schema.parameters ?? { type: 'object', properties: {} } },
  }));
}
