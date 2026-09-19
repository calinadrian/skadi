// Device ids belong to the backend: `Vulkan0` under the Vulkan build, `CUDA0`
// under CUDA. A profile that names a device this engine does not have must fall
// back to the discrete card, or llama-server refuses to start.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArgs, resolveDevice } from '../src/llama.mjs';
import { PROFILE_CATALOG } from '../src/profile-catalog.mjs';

const cuda = { defaultDevice: 'CUDA0', devices: ['CUDA0'] };

test('a saved Vulkan device falls back to the discrete card on a CUDA build', () => {
  assert.equal(resolveDevice({ device: 'Vulkan0' }, cuda), 'CUDA0');
});

test('a device this build has is kept', () => {
  const opts = { defaultDevice: 'Vulkan1', devices: ['Vulkan0', 'Vulkan1'] };
  assert.equal(resolveDevice({ device: 'Vulkan0' }, opts), 'Vulkan0');
});

test('no device means the discrete card, and auto means every device', () => {
  assert.equal(resolveDevice({}, cuda), 'CUDA0');
  assert.equal(resolveDevice({ device: 'auto' }, cuda), undefined);
});

test('an unprobed device list trusts the name it was given', () => {
  assert.equal(resolveDevice({ device: 'Vulkan0' }, {}), 'Vulkan0');
});

test('buildArgs passes the resolved device to llama-server', () => {
  const cfg = { serverExe: 'x', modelsDir: 'C:/m', host: '127.0.0.1', port: 8080, chatTemplateFile: '' };
  const args = buildArgs(cfg, { model: 'm.gguf', device: 'Vulkan0' }, 'm.gguf', cuda);
  assert.equal(args[args.indexOf('-dev') + 1], 'CUDA0');
});

test('bundled profiles do not pin a backend-specific device', () => {
  for (const [id, p] of Object.entries(PROFILE_CATALOG)) {
    assert.equal(p.device, undefined, `${id} pins ${p.device}`);
  }
});
