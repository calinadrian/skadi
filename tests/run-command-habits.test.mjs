// Shell habits from bash that Windows PowerShell 5.1 does not share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildTools, chainForPowerShell, looksLikeServer, unixHabitHint } from '../src/tools.mjs';

test('&& and || chains become PowerShell conditionals', () => {
  assert.equal(chainForPowerShell('cd app && npm test'), 'cd app; if ($?) { npm test }');
  assert.equal(chainForPowerShell('a && b && c'), 'a; if ($?) { b; if ($?) { c } }');
  assert.equal(chainForPowerShell('npm ci || npm install'), 'npm ci; if (-not $?) { npm install }');
});

test('quoted text, pipes, redirects and mixed chains are left alone', () => {
  assert.equal(chainForPowerShell('echo "a && b"'), 'echo "a && b"');
  assert.equal(chainForPowerShell("git log | Select-String 'x || y'"), "git log | Select-String 'x || y'");
  assert.equal(chainForPowerShell('npm test 2>&1'), 'npm test 2>&1');
  assert.equal(chainForPowerShell('a && b || c'), 'a && b || c');
  assert.equal(chainForPowerShell('&& a'), '&& a');
});

test('server commands are recognised, one-shot commands are not', () => {
  for (const cmd of ['npm run dev', 'npm start', 'pnpm dev', 'yarn preview', 'npx vite', 'npx next dev',
    'python -m http.server 8000', 'cd web && npm run dev', 'uvicorn app:app --reload', 'php -S localhost:8000']) {
    assert.ok(looksLikeServer(cmd), cmd);
  }
  for (const cmd of ['npm test', 'npm run build', 'npm install', 'node build.mjs', 'git status', 'npx vitest run']) {
    assert.ok(!looksLikeServer(cmd), cmd);
  }
});

test('Unix commands that failed get their PowerShell spelling', () => {
  assert.match(
    unixHabitHint("touch : The term 'touch' is not recognized as the name of a cmdlet"),
    /`touch` → New-Item -ItemType File/,
  );
  assert.match(
    unixHabitHint("Remove-Item : A parameter cannot be found that matches parameter name 'rf'."),
    /`rm -rf` → Remove-Item -Recurse -Force/,
  );
  assert.equal(unixHabitHint('all 12 tests passed'), '');
});

test('run_command sends a server to the background and says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skadi-habits-'));
  try {
    const started = [];
    const tools = buildTools({
      workspace: root,
      settings: {},
      startBackground: (job) => { started.push(job); return { id: 't1' }; },
    });
    const result = await tools.run_command.run({ command: 'cd web && npm run dev' });
    assert.match(result, /server that keeps running, so it was started in the background/);
    assert.match(result, /background task t1/);
    assert.equal(started[0].command, 'cd web; if ($?) { npm run dev }');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run_command runs a chained command in real PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'skadi-habits-'));
  try {
    const tools = buildTools({ workspace: root, settings: {} });
    const ok = await tools.run_command.run({ command: 'echo first && echo second' });
    assert.match(ok, /^exit code 0\nfirst\r?\nsecond/);
    // rm is PowerShell's own alias whatever else is on PATH (touch may not be).
    const hinted = await tools.run_command.run({ command: 'rm -rf missing-dir' });
    assert.match(hinted, /Hint: this shell is Windows PowerShell 5\.1\. Use `rm -rf` → Remove-Item -Recurse -Force/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
