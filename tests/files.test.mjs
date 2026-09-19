// The project's files, as the Files tab and the file viewer read them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectory, readProjectFile, findFiles } from '../src/files.mjs';

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'skadi-files-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'B.mjs'), 'export const b = 2;\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'a.mjs'), 'nope');
  writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  return root;
};

test('a folder lists folders first, then files by name, and leaves .git out', () => {
  const root = project();
  try {
    const { entries } = listDirectory(root, '');
    assert.deepEqual(entries.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`), ['d:node_modules', 'd:src', 'f:blob.bin', 'f:README.md']);
    assert.deepEqual(listDirectory(root, 'src').entries.map((e) => e.path), ['src/a.mjs', 'src/B.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file comes back whole; a binary one says so instead of returning noise', () => {
  const root = project();
  try {
    assert.equal(readProjectFile(root, 'src/a.mjs').content, 'export const a = 1;\n');
    assert.equal(readProjectFile(root, 'blob.bin').binary, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nothing outside the project can be listed or read', () => {
  const root = project();
  try {
    assert.throws(() => readProjectFile(root, '../outside.txt'), /escapes the workspace/);
    assert.throws(() => listDirectory(root, '../..'), /escapes the workspace/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('search matches on the path, shallow first, and skips node_modules', () => {
  const root = project();
  try {
    assert.deepEqual(findFiles(root, 'a.mjs').results.map((r) => r.path), ['src/a.mjs']);
    assert.deepEqual(findFiles(root, 'MJS').results.map((r) => r.path).sort(), ['src/B.mjs', 'src/a.mjs']);
    assert.deepEqual(findFiles(root, '').results, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
