// The model header facts the settings panel hides and shows fields by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelShape } from '../src/gguf.mjs';

const shape = (kv) => modelShape({ kv: { 'general.architecture': 'arch', ...kv }, fileBytes: 1 });

test('a dense model reports no experts, a Mixture-of-Experts one reports its count', () => {
  assert.equal(shape({ 'arch.block_count': 32 }).expertCount, 0);
  const moe = shape({ 'arch.block_count': 40, 'arch.expert_count': 256, 'arch.expert_used_count': 8 });
  assert.equal(moe.expertCount, 256);
  assert.equal(moe.expertUsedCount, 8);
});

test('the speculative-decoding head is read from the header', () => {
  assert.equal(shape({ 'arch.nextn_predict_layers': 1 }).nextnPredictLayers, 1);
  assert.equal(shape({}).nextnPredictLayers, 0);
});
