// What a release contains: the application, and nothing that belongs to the
// person running it. Config, chats, API keys, memory, skills, workspaces and
// logs never appear here, so neither publishing a release nor installing one
// can touch them.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TOP_LEVEL = ['skadi.mjs', 'package.json', 'README.md', 'LICENSE', 'install.ps1', '.gitignore'];
const BUILD_FILES = ['Skadi.cs', 'build.ps1', 'get-webview2.ps1', 'make-icon.ps1', 'skadi-icon.png', 'skadi.ico'];
const UI_FILE = /\.(?:js|css|html|png|svg|ico|webmanifest)$/;
// Left out of every release: the tooling that moves files between installations.
const MAINTAINER_ONLY = new Set([
  'src/publish.mjs', 'tests/publish.test.mjs', 'tests/github-push.test.mjs', 'tests/ui-preview.mjs',
  'ui/reference-test.html', 'ui/slider-preview.html', 'ui/toggle-preview.html', 'ui/deploy.js',
]);
// A person's own edits win over a release: these are written once, then left alone.
export const SEED_ONLY = new Set(['.gitignore']);

const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

async function listDir(root, dir, pattern) {
  const names = await readdir(join(root, dir)).catch(() => []);
  return names.filter((name) => pattern.test(name)).sort().map((name) => `${dir}/${name}`);
}

async function walkSkills(root, dir = 'defaults/skills') {
  const out = [];
  for (const name of (await readdir(join(root, dir)).catch(() => [])).sort()) {
    const rel = `${dir}/${name}`;
    const info = await stat(join(root, rel)).catch(() => null);
    if (info?.isDirectory()) out.push(...(await walkSkills(root, rel)));
    // A skill is a package, not only its SKILL.md. Search indexes, scripts,
    // references, fixtures and assets are part of its behaviour and must make
    // the same trip to a release as the entrypoint that refers to them.
    else if (info?.isFile()) out.push(rel);
  }
  return out;
}

/** Relative, forward-slashed paths of every file a release carries that exists under `root`. */
export async function releaseFiles(root) {
  const files = [];
  for (const name of TOP_LEVEL) if (await isFile(join(root, name))) files.push(name);
  // Plus the helpers the Node code launches: Windows input and speech, the voice engine.
  files.push(...(await listDir(root, 'src', /\.(?:mjs|ps1|py)$/)));
  files.push(...(await listDir(root, 'ui', UI_FILE)));
  for (const name of BUILD_FILES) if (await isFile(join(root, 'build', name))) files.push(`build/${name}`);
  files.push(...(await listDir(root, 'docs', /\.(?:md|png|jpg|webp)$/)));
  files.push(...(await walkSkills(root)));
  files.push(...(await listDir(root, 'tests', /\.test\.mjs$/)));
  return files.filter((file) => !MAINTAINER_ONLY.has(file));
}
