// The vision switch has to reach two places that must never disagree: the
// arguments llama-server is launched with, and the footprint the fitter is
// working against. A tower left out of the launch but still charged for in the
// fit silently costs you the context switching it off was meant to free.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArgs, visionOn } from '../src/llama.mjs';

const cfg = {
  serverExe: 'C:/llama/llama-server.exe',
  modelsDir: 'C:/models',
  host: '127.0.0.1',
  port: 8080,
  // Deliberately absent so buildArgs does not try to attach a chat template.
  chatTemplateFile: '',
};

const withVision = () => ({
  model: 'm.gguf',
  alias: 'm',
  mmproj: 'mmproj-f16.gguf',
  ctx: 4096,
});

const valueOf = (args, flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};

test('a tower is used when present and not switched off', () => {
  const p = withVision();
  assert.equal(visionOn(p), true);
  assert.equal(valueOf(buildArgs(cfg, p, 'm.gguf'), '--mmproj'), 'C:/models/mmproj-f16.gguf');
});

test('vision: false omits the tower but keeps the filename', () => {
  const p = { ...withVision(), vision: false };
  assert.equal(visionOn(p), false);
  assert.ok(!buildArgs(cfg, p, 'm.gguf').includes('--mmproj'));
  assert.equal(p.mmproj, 'mmproj-f16.gguf', 'the path must survive being switched off');
});

test('vision: true is the same as leaving it unset', () => {
  assert.equal(visionOn({ ...withVision(), vision: true }), true);
});

test('a profile with no tower is never vision-on, however the flag is set', () => {
  assert.equal(visionOn({ ctx: 4096 }), false);
  assert.equal(visionOn({ ctx: 4096, vision: true }), false);
  assert.ok(!buildArgs(cfg, { ctx: 4096, vision: true }, 'm.gguf').includes('--mmproj'));
});

test('an absolute tower path is passed through, not prefixed with modelsDir', () => {
  const p = { ...withVision(), mmproj: 'E:/elsewhere/mmproj.gguf' };
  assert.equal(valueOf(buildArgs(cfg, p, 'm.gguf'), '--mmproj'), 'E:/elsewhere/mmproj.gguf');
});

test('the switch does not disturb the draft model beside it', () => {
  const p = { ...withVision(), vision: false, draftModel: 'mtp.gguf' };
  const args = buildArgs(cfg, p, 'm.gguf');
  assert.ok(!args.includes('--mmproj'));
  assert.equal(valueOf(args, '-md'), 'C:/models/mtp.gguf');
});
