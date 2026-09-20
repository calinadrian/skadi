import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { SkillStore } from '../src/skills.mjs';
import { releaseFiles } from '../src/release.mjs';

const root = join(import.meta.dirname, '..');

test('the bundled UI/UX skill is loadable and ships in releases', async () => {
  const store = new SkillStore(join(root, 'defaults', 'skills'));
  const skill = await store.load('ui-ux-pro-max');
  assert.match(skill.description, /web and desktop interfaces/i);
  assert.ok(skill.body.length > 2000, 'the loaded body should contain the substantive workflow, not an empty scaffold');
  assert.ok((await releaseFiles(root)).includes('defaults/skills/ui-ux-pro-max/SKILL.md'));
});
