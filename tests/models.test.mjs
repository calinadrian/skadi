// The model manager's pure parts: sorting a repo's files into models / vision
// towers / drafts, judging a file against a card, the read-only catalog, and the
// download manager's refusal of anything it should not write.
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFiles, quantOf, assessFit, assertRepo, DownloadManager } from '../src/huggingface.mjs';
import { PROFILE_CATALOG, catalogFor, isCatalogId } from '../src/profile-catalog.mjs';
import { parseGgufHeader } from '../src/gguf.mjs';

const GB = 1024 ** 3;
const file = (path, size) => ({ type: 'file', path, size, lfs: { size } });

test('a repo listing splits into models, vision towers and drafts', () => {
  const { models, mmproj, drafts } = classifyFiles([
    file('Model-UD-Q4_K_M.gguf', 16 * GB),
    file('Model-UD-IQ3_XXS.gguf', 10 * GB),
    file('mmproj-BF16.gguf', 1 * GB),
    file('mmproj-F16.gguf', 1 * GB),
    file('MTP/mtp-Model-Q4_0.gguf', 1 * GB),
    file('imatrix_unsloth.gguf', 13e6),
    file('README.md', 7000),
    { type: 'directory', path: 'MTP' },
  ]);
  assert.deepEqual(models.map((m) => m.quant), ['UD-IQ3_XXS', 'UD-Q4_K_M']); // smallest first
  assert.equal(mmproj[0].name, 'mmproj-F16.gguf', 'f16 is preferred over bf16');
  assert.equal(drafts.length, 1);
});

test('split shards are one model, addressed by the first part', () => {
  const { models } = classifyFiles([
    file('BF16/Model-BF16-00002-of-00002.gguf', 5 * GB),
    file('BF16/Model-BF16-00001-of-00002.gguf', 50 * GB),
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].file, 'Model-BF16-00001-of-00002.gguf');
  assert.equal(models[0].shards, 2);
  assert.equal(models[0].bytes, 55 * GB);
});

test('quant names come out of file names', () => {
  assert.equal(quantOf('Qwen3.8-27B-UD-IQ3_XXS.gguf'), 'UD-IQ3_XXS');
  assert.equal(quantOf('Model-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOf('Model-BF16.gguf'), 'BF16');
  assert.equal(quantOf('plain.gguf'), null);
});

const shape = {
  arch: 'qwen35', blockCount: 64, attentionLayers: 16, ssmLayers: 0, ssm: {},
  headsKv: 4, keyLength: 256, valueLength: 256, trainCtx: 262144,
};

test('fit verdicts run from comfortable to too big', () => {
  const budget = 14 * GB;
  assert.equal(assessFit(shape, 6 * GB, budget).verdict, 'fits');
  assert.ok(assessFit(shape, 6 * GB, budget).maxContext >= 32768);
  assert.equal(assessFit(shape, 12.6 * GB, budget).verdict, 'tight');
  assert.equal(assessFit(shape, 20 * GB, budget).verdict, 'offload');
  assert.equal(assessFit(shape, 400 * GB, budget).verdict, 'toobig');
});

test('a vision tower is charged against the card', () => {
  const budget = 14 * GB;
  const without = assessFit(shape, 12 * GB, budget);
  const withTower = assessFit(shape, 12 * GB, budget, { mmprojBytes: 1 * GB });
  assert.ok(withTower.maxContext < without.maxContext);
});

test('no measured card means no verdict, not a wrong one', () => {
  assert.equal(assessFit(shape, 6 * GB, 0).verdict, 'unknown');
});

test('repository ids are checked before they reach a URL', () => {
  assert.equal(assertRepo('unsloth/Qwen3.8-27B-GGUF'), 'unsloth/Qwen3.8-27B-GGUF');
  for (const bad of ['', 'nope', '../etc/passwd', 'a/b/c', 'a/b?x=1', 'a/b#frag']) {
    assert.throws(() => assertRepo(bad), /Hugging Face repository/);
  }
});

test('downloads refuse unsafe names and empty requests', () => {
  const manager = new DownloadManager();
  const ok = { path: 'x.gguf', bytes: 1 };
  assert.throws(() => manager.start('a/b', [{ ...ok, name: '../evil.gguf' }], 'somewhere'), /unsafe/);
  assert.throws(() => manager.start('a/b', [{ ...ok, name: 'C:\\evil.gguf' }], 'somewhere'), /unsafe/);
  assert.throws(() => manager.start('a/b', [{ ...ok, name: 'notes.txt' }], 'somewhere'), /unsafe/);
  assert.throws(() => manager.start('a/b', [], 'somewhere'), /Nothing to download/);
  assert.throws(() => manager.start('a/b', [{ ...ok, name: 'x.gguf' }], ''), /models folder/);
});

test('the catalog is frozen, and finds profiles by model file', () => {
  assert.ok(Object.isFrozen(PROFILE_CATALOG));
  for (const [id, profile] of Object.entries(PROFILE_CATALOG)) {
    assert.equal(profile.catalog, true, id);
    assert.ok(profile.model, `${id} names a model file`);
    assert.ok(isCatalogId(id));
  }
  const any = Object.values(PROFILE_CATALOG)[0];
  assert.ok(catalogFor(any.model.toUpperCase()).length >= 1, 'match ignores case');
  assert.deepEqual(catalogFor('not-a-model.gguf'), []);
});

test('a header cut short says so, so the caller can fetch more', () => {
  const magic = Buffer.from([0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0]); // "GGUF", version 3
  assert.throws(() => parseGgufHeader(magic, 100), RangeError);
  assert.throws(() => parseGgufHeader(Buffer.from('not a gguf file at all'), 100), /not a GGUF/);
});
