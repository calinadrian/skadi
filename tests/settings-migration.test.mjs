import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateSettings } from '../src/config.mjs';

test('the obsolete default round ceiling is disabled once', () => {
  assert.deepEqual(
    migrateSettings({ maxToolRounds: 8, theme: 'oled' }),
    { maxToolRounds: 0, theme: 'oled', settingsSchemaVersion: 2 },
  );
});

test('versioned user choices are preserved', () => {
  assert.deepEqual(
    migrateSettings({ maxToolRounds: 8, settingsSchemaVersion: 1 }),
    { maxToolRounds: 8, settingsSchemaVersion: 2 },
  );
  assert.deepEqual(
    migrateSettings({ maxToolRounds: 20, settingsSchemaVersion: 0 }),
    { maxToolRounds: 20, settingsSchemaVersion: 2 },
  );
});

test('the old shipped progress-check effort moves to none, an explicit later choice stays', () => {
  assert.equal(migrateSettings({ loopReviewEffort: 'low', settingsSchemaVersion: 1 }).loopReviewEffort, 'none');
  assert.equal(migrateSettings({ loopReviewEffort: 'low', settingsSchemaVersion: 2 }).loopReviewEffort, 'low');
  assert.equal(migrateSettings({ loopReviewEffort: 'medium', settingsSchemaVersion: 1 }).loopReviewEffort, 'medium');
});
