import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildTools } from '../src/tools.mjs';

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'skadi-tools-'));
  try {
    return await fn(root, buildTools({ workspace: root, settings: {} }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const largeSource = () => Array.from({ length: 3200 }, (_, i) =>
  i === 2799
    ? 'export function openLocation() { return "TARGET_NEEDLE"; }'
    : `// filler ${String(i + 1).padStart(4, '0')} ${'x'.repeat(100)}`
).join('\n');

test('large files reject whole reads but permit explicit numbered ranges', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'large.js'), largeSource(), 'utf8');

    await assert.rejects(
      tools.read_file.run({ path: 'large.js' }),
      /whole-file limit.*start_line.*end_line/i,
    );

    const excerpt = await tools.read_file.run({ path: 'large.js', start_line: 2798, end_line: 2802 });
    assert.match(excerpt, /^ 2798\t/m);
    assert.match(excerpt, /^ 2800\texport function openLocation/m);
    assert.match(excerpt, /^ 2802\t/m);
    assert.doesNotMatch(excerpt, /^ 2797\t/m);
  });
});

test('grep searches large files and returns an actionable line reference', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'large.js'), largeSource(), 'utf8');
    const result = await tools.grep.run({ pattern: 'TARGET_NEEDLE', glob: '**/*.js' });
    assert.match(result, /^large\.js:2800:/m);
    assert.match(result, /TARGET_NEEDLE/);
  });
});

test('read ranges reject an inverted interval clearly', async () => {
  await withWorkspace(async (root, tools) => {
    await writeFile(join(root, 'small.js'), 'one\ntwo\nthree', 'utf8');
    await assert.rejects(
      tools.read_file.run({ path: 'small.js', start_line: 3, end_line: 2 }),
      /end_line must be greater than or equal to start_line/i,
    );
  });
});
