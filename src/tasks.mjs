// Background tasks: long builds and test suites the model starts with
// run_command background:true. The turn continues (or ends) while the process
// runs; output streams to the UI panel via throttled events, and completion
// lands in the session transcript so the model picks it up next round.
//
// Tasks live in memory only. A harness restart orphans the child process and
// drops the registry -- task_log then says so honestly instead of hanging.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ToolError } from './tools.mjs';

const MAX_KEPT_CHARS = 192 * 1024;
const UPDATE_THROTTLE_MS = 800;

let seq = 0;

export class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  start({ command, shell, sessionId = null, cwd }) {
    if (!command || !String(command).trim()) throw new ToolError('command is required');
    const isCmd = shell === 'cmd';
    const exe = isCmd ? 'cmd.exe' : 'powershell.exe';
    const args = isCmd
      ? ['/c', command]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];

    const id = `t-${Date.now().toString(36)}${(seq++).toString(36)}`;
    const task = {
      id,
      command: String(command),
      shell: isCmd ? 'cmd' : 'powershell',
      sessionId,
      status: 'running',
      output: '',
      truncated: false,
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      lastEmit: 0,
      proc: null,
    };

    let child;
    try {
      child = spawn(exe, args, { cwd: resolve(cwd), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new ToolError(`failed to start: ${err.message}`);
    }
    task.proc = child;
    this.tasks.set(id, task);

    const append = (d) => {
      task.output += d;
      if (task.output.length > MAX_KEPT_CHARS) {
        task.output = task.output.slice(-MAX_KEPT_CHARS);
        task.truncated = true;
      }
      const now = Date.now();
      if (now - task.lastEmit > UPDATE_THROTTLE_MS) {
        task.lastEmit = now;
        this.emit('update', this.summarize(task));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      task.output += `\n[harness] failed to start: ${err.message}`;
      this.finish(task, null);
    });
    child.on('close', (code) => this.finish(task, code));

    this.emit('update', this.summarize(task));
    return this.summarize(task);
  }

  finish(task, code) {
    if (task.status !== 'running') return task;
    task.status = 'finished';
    task.exitCode = code;
    task.finishedAt = Date.now();
    task.proc = null;
    this.emit('update', this.summarize(task));
    this.emit('done', this.summarize(task));
    return task;
  }

  stop(task_id) {
    const task = this.tasks.get(task_id);
    if (!task) throw new ToolError(`no background task "${task_id}" (it may predate a restart)`);
    if (task.status !== 'running') return `Task ${task_id} already finished (exit ${task.exitCode}).`;
    try {
      task.proc?.kill();
    } catch {
      /* already gone */
    }
    task.output += '\n[harness] stopped by user';
    this.finish(task, null);
    return `Stopped background task ${task_id}.`;
  }

  log(task_id, maxChars = 8000) {
    const task = this.tasks.get(task_id);
    if (!task) throw new ToolError(`no background task "${task_id}" (it may predate a restart)`);
    const tail = task.output.slice(-Math.max(512, maxChars));
    const head = `Task ${task.id} [${task.status}] ${task.command}\n` +
      (task.status === 'running'
        ? `Running for ${Math.round((Date.now() - task.startedAt) / 1000)}s.`
        : `Finished with exit code ${task.exitCode}.`);
    return `${head}\n${tail.trim() || '(no output yet)'}`;
  }

  summarize(task) {
    return {
      id: task.id,
      command: task.command,
      shell: task.shell,
      sessionId: task.sessionId,
      status: task.status,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      truncated: task.truncated,
      tail: task.output.slice(-2000),
    };
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((t) => this.summarize(t));
  }

  /** Drop finished tasks from the registry. Returns how many were cleared. */
  clearFinished() {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if (t.status !== 'running') {
        this.tasks.delete(id);
        n++;
      }
    }
    return n;
  }
}
