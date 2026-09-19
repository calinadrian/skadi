// The fitter is pure arithmetic over a model shape, so it can be tested without
// a GGUF on disk or a GPU in the machine. The shape below is the one that makes
// the interesting cases interesting: a hybrid model where only a quarter of the
// layers cache KV, sized so that a 16 GB card is genuinely marginal.
import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateFootprint, maxContextFor, fitProfile } from '../src/gguf.mjs';

const GB = 1024 ** 3;

const shape = {
  arch: 'qwen35',
  name: 'test-27b',
  blockCount: 64,
  attentionLayers: 16,
  ssmLayers: 48,
  fullAttentionInterval: 4,
  ssm: { convKernel: 4, stateSize: 128, innerSize: 4096, groupCount: 1 },
  embedding: 4096,
  heads: 32,
  headsKv: 4,
  keyLength: 256,
  valueLength: 256,
  trainCtx: 262144,
  fileBytes: 12 * GB,
  sampling: {},
};

const profile = () => ({ ctx: 98304, ngl: 99, cacheK: 'q8_0', cacheV: 'q8_0' });

// Every type in the fitter's ladder that an upstream llama.cpp build accepts.
const UPSTREAM = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];

test('mmproj counts against the budget', () => {
  const without = estimateFootprint(shape, profile());
  const mmprojBytes = 899283680;
  const with_ = estimateFootprint(shape, profile(), { mmprojBytes });
  assert.equal(with_.totalBytes - without.totalBytes, mmprojBytes);
  assert.match(with_.notes.join(' '), /vision tower/);
});

test('a learned bias inflates the estimate and is reported', () => {
  const base = estimateFootprint(shape, profile());
  const biasBytes = 1610612736; // 1.5 GB, exactly
  const biased = estimateFootprint(shape, profile(), { biasBytes });
  assert.equal(biased.totalBytes - base.totalBytes, biasBytes);
  assert.match(biased.notes.join(' '), /learned from the last launch/);
});

test('-ngl below the layer count scales the weights pro rata', () => {
  const full = estimateFootprint(shape, profile());
  const half = estimateFootprint(shape, { ...profile(), ngl: 32 });
  assert.equal(half.weightsBytes, Math.round(shape.fileBytes / 2));
  assert.ok(half.totalBytes < full.totalBytes);
  assert.match(half.notes.join(' '), /stay on the CPU/);
});

test('off mode reports the overflow and changes nothing', () => {
  const r = fitProfile(shape, profile(), 10 * GB, { mode: 'off' });
  assert.equal(r.fits, false);
  assert.deepEqual(r.patch, {});
  assert.deepEqual(r.steps, []);
});

test('ctx mode shrinks context to what fits and nothing else', () => {
  const r = fitProfile(shape, profile(), 14.5 * GB, { mode: 'ctx', ctxFloor: 16384 });
  assert.equal(r.fits, true);
  assert.deepEqual(Object.keys(r.patch), ['ctx']);
  assert.ok(r.patch.ctx < 98304);
  assert.ok(r.patch.ctx >= 16384);
  assert.ok(r.estimate.totalBytes <= 14.5 * GB);
});

test('a profile that already fits is left alone', () => {
  const r = fitProfile(shape, profile(), 40 * GB, { mode: 'full' });
  assert.equal(r.fits, true);
  assert.deepEqual(r.patch, {});
});

test('context is never raised above what the profile asked for', () => {
  const r = fitProfile(shape, { ...profile(), ctx: 32768 }, 14.5 * GB, { mode: 'full' });
  assert.ok((r.patch.ctx ?? 32768) <= 32768);
});

test('ctx mode refuses rather than going under the floor', () => {
  const r = fitProfile(shape, profile(), 13 * GB, { mode: 'ctx', ctxFloor: 65536 });
  assert.equal(r.fits, false);
  // It still reports the best it could do, so the overflow shown is honest.
  assert.equal(r.patch.ctx, 65536);
});

// 15.5 GB is the interesting budget: a rung down the KV ladder is enough to
// reach it, so the two priorities visibly disagree about which lever to pull.
test('context priority spends cache precision before context', () => {
  const r = fitProfile(shape, profile(), 15.5 * GB, {
    mode: 'full',
    priority: 'context',
    ctxFloor: 16384,
    cacheTypes: UPSTREAM,
  });
  assert.equal(r.fits, true);
  assert.equal(r.patch.ctx, undefined, 'context should have been preserved');
  assert.ok(r.patch.cacheK);
});

test('quality priority spends context before cache precision', () => {
  const r = fitProfile(shape, profile(), 15.5 * GB, {
    mode: 'full',
    priority: 'quality',
    ctxFloor: 16384,
    cacheTypes: UPSTREAM,
  });
  assert.equal(r.fits, true);
  assert.ok(r.patch.ctx < 98304);
  assert.equal(r.patch.cacheK, undefined, 'cache type should have been preserved');
});

test('speed priority spends GPU layers before context or cache', () => {
  const r = fitProfile(shape, profile(), 15.5 * GB, {
    mode: 'full',
    priority: 'speed',
    ctxFloor: 16384,
    allowCpuLayers: true,
    cacheTypes: UPSTREAM,
  });
  assert.equal(r.fits, true);
  assert.ok(r.patch.ngl < 64, 'layers should have moved to the CPU');
  assert.equal(r.patch.ctx, undefined, 'context should have been preserved');
  assert.equal(r.patch.cacheK, undefined, 'cache type should have been preserved');
});

test('speed priority falls back to context when CPU layers are forbidden', () => {
  // With nothing to spend, the ordering has to degrade rather than give up.
  const r = fitProfile(shape, profile(), 15.5 * GB, {
    mode: 'full',
    priority: 'speed',
    ctxFloor: 16384,
    allowCpuLayers: false,
    cacheTypes: UPSTREAM,
  });
  assert.equal(r.fits, true);
  assert.equal(r.patch.ngl, undefined);
  assert.ok(r.patch.cacheK || r.patch.ctx, 'something else had to give');
});

test('the fitter only picks cache types the build accepts', () => {
  const r = fitProfile(shape, profile(), 13.5 * GB, {
    mode: 'full',
    priority: 'context',
    ctxFloor: 16384,
    cacheTypes: UPSTREAM,
  });
  if (r.patch.cacheK) assert.ok(UPSTREAM.includes(r.patch.cacheK));
});

test('a profile on an unsupported cache type is still fittable', () => {
  // kvarn4 comes from a fork; against an upstream build the fitter has to find
  // its own way back onto the ladder rather than giving up.
  const r = fitProfile(shape, { ...profile(), cacheK: 'kvarn4', cacheV: 'kvarn4' }, 13.5 * GB, {
    mode: 'full',
    priority: 'context',
    ctxFloor: 16384,
    cacheTypes: UPSTREAM,
  });
  assert.equal(r.fits, true);
});

test('CPU layers are the last resort, and only when allowed', () => {
  const opts = { mode: 'full', priority: 'context', ctxFloor: 16384, cacheTypes: UPSTREAM };
  const refused = fitProfile(shape, profile(), 9 * GB, { ...opts, allowCpuLayers: false });
  assert.equal(refused.fits, false);
  assert.equal(refused.patch.ngl, undefined);

  const allowed = fitProfile(shape, profile(), 9 * GB, { ...opts, allowCpuLayers: true });
  assert.equal(allowed.fits, true);
  assert.ok(allowed.patch.ngl < 64);
});

test('maxContextFor inverts estimateFootprint', () => {
  const budget = 14.5 * GB;
  const ceiling = maxContextFor(shape, profile(), budget);
  const at = estimateFootprint(shape, { ...profile(), ctx: ceiling });
  const over = estimateFootprint(shape, { ...profile(), ctx: ceiling + 4096 });
  assert.ok(at.totalBytes <= budget);
  assert.ok(over.totalBytes > budget);
});
