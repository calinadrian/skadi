// Edits and paths that are almost right -- the usual way a small model misses.
// Each case either lands the evidently intended change or fails with the text
// needed to get it right on the next call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildTools, clip } from '../src/tools.mjs';

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'skadi-near-'));
  try {
    return await fn(root, buildTools({ workspace: root, settings: {} }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a multi-line edit written with \\n lands in a CRLF file and keeps CRLF', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'a.js'), 'function a() {\r\n  return 1;\r\n}\r\n', 'utf8');
    const result = await tools.edit_file.run({
      path: 'a.js',
      old_string: 'function a() {\n  return 1;',
      new_string: 'function a() {\n  const x = 2;\n  return x;',
    });
    assert.match(result, /^Edited a\.js/);
    assert.equal(await readFile(join(root, 'a.js'), 'utf8'), 'function a() {\r\n  const x = 2;\r\n  return x;\r\n}\r\n');
  });
});

test('an exact match is still exact, and $ patterns in new_string are written literally', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'p.js'), 'const price = 1;\n', 'utf8');
    await tools.edit_file.run({ path: 'p.js', old_string: '1', new_string: '"$&5"' });
    assert.equal(await readFile(join(root, 'p.js'), 'utf8'), 'const price = "$&5";\n');
  });
});

test('a tab-indented block matches a space-indented file and takes its indentation', async () => {
  await withWorkspace(async (root, tools) => {
    const file = [
      'export function load(x) {',
      '  if (x) {',
      '    run(x);',
      '  }',
      '  return x;',
      '}',
      '',
    ].join('\n');
    await writeFile(join(root, 'b.js'), file, 'utf8');
    const result = await tools.edit_file.run({
      path: 'b.js',
      old_string: '\tif (x) {\n\t\trun(x);\n\t}',
      new_string: '\tif (x) {\n\t\trun(x);\n\t\tlog(x);\n\t}',
    });
    assert.match(result, /ignoring whitespace/);
    assert.equal(
      await readFile(join(root, 'b.js'), 'utf8'),
      file.replace('    run(x);\n', '    run(x);\n    log(x);\n'),
    );
  });
});

test('trailing spaces and a block shifted left still match once', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'c.py'), 'class A:\n    def f(self):\n        return 1\n', 'utf8');
    await tools.edit_file.run({
      path: 'c.py',
      old_string: 'def f(self):  \n    return 1',
      new_string: 'def f(self):\n    return 2',
    });
    assert.equal(await readFile(join(root, 'c.py'), 'utf8'), 'class A:\n    def f(self):\n        return 2\n');
  });
});

test('a whitespace-only match in two places is refused, not guessed', async () => {
  await withWorkspace(async (root, tools) => {
    const file = 'a() {\n  go();\n}\nb() {\n  go();\n}\n';
    await writeFile(join(root, 'd.js'), file, 'utf8');
    await assert.rejects(
      tools.edit_file.run({ path: 'd.js', old_string: '\tgo();', new_string: '\tstop();' }),
      /old_string not found in d\.js/,
    );
    assert.equal(await readFile(join(root, 'd.js'), 'utf8'), file);
  });
});

test('a miss names the closest lines, numbered, so the retry can copy them', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'e.js'), 'one();\nconst total = sum(items);\nthree();\n', 'utf8');
    await assert.rejects(
      tools.edit_file.run({ path: 'e.js', old_string: 'const total = sum(item);', new_string: 'x' }),
      (err) => {
        assert.match(err.message, /Closest text is lines 2-/);
        assert.match(err.message, /^ {4}2\tconst total = sum\(items\);$/m);
        return true;
      },
    );
  });
});

test('an empty old_string points at write_file', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'f.js'), 'x\n', 'utf8');
    await assert.rejects(tools.edit_file.run({ path: 'f.js', old_string: '', new_string: 'y' }), /use write_file/);
  });
});

test('a wrong path suggests the file that exists', async () => {
  await withWorkspace(async (root, tools) => {
    await mkdir(join(root, 'ui'), { recursive: true });
    await writeFile(join(root, 'ui', 'app.js'), 'x\n', 'utf8');
    await assert.rejects(tools.read_file.run({ path: 'src/app.js' }), /no such file: src\/app\.js\. Did you mean: ui\/app\.js\?/);
    await assert.rejects(
      tools.edit_file.run({ path: 'app.js', old_string: 'x', new_string: 'y' }),
      /Did you mean: ui\/app\.js\?/,
    );
    await assert.rejects(tools.read_file.run({ path: 'nothing-like-it.txt' }), /Use glob or list_dir/);
  });
});

test('long output keeps its start and its end, cut on line boundaries', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${'.'.repeat(20)}`);
  lines[lines.length - 1] = 'FAILED: 3 tests, see above';
  const out = clip(lines.join('\n'));
  assert.ok(out.length < 31000);
  assert.match(out, /^line 1 /);
  assert.match(out, /FAILED: 3 tests, see above$/);
  assert.match(out, /characters cut from the middle/);
  // Every surviving line is whole.
  for (const line of out.split('\n')) assert.match(line, /^(line \d+ \.{20}|\.\.\. \[.*\] \.\.\.|FAILED.*)$/);
  assert.equal(clip('short'), 'short');
});
