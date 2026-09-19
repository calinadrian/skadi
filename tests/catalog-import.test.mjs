// Which catalog profiles are on the user's profile list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importedCatalogIds } from '../src/config.mjs';
import { PROFILE_CATALOG } from '../src/profile-catalog.mjs';

const [first, second] = Object.keys(PROFILE_CATALOG);
const profiles = { ...PROFILE_CATALOG, mine: { label: 'Mine' } };

test('a config from before the import list keeps only the catalog profile in use', () => {
  assert.deepEqual(importedCatalogIds({ activeProfile: first }, profiles), [first]);
});

test('and none at all when the profile in use is the user\'s own', () => {
  assert.deepEqual(importedCatalogIds({ activeProfile: 'mine' }, profiles), []);
});

test('a saved list is kept as it is, minus anything the catalog no longer ships', () => {
  const cfg = { activeProfile: 'mine', catalogImported: [second, 'retired-profile', second] };
  assert.deepEqual(importedCatalogIds(cfg, profiles), [second]);
});

test('an empty saved list stays empty: the user removed them all', () => {
  assert.deepEqual(importedCatalogIds({ activeProfile: first, catalogImported: [] }, profiles), []);
});
