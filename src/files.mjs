// The project's files, for the Files tab and the file viewer: a directory
// listing, one whole file, and a name search. Everything is confined to the
// project folder, and the harness's own private folders (credentials, other
// chats' transcripts) are left out of listings and refused when asked for.
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { safePath, privateRoot } from './tools.mjs';

// Big and never what anyone means to read; listed on demand, skipped by search.
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const MAX_ENTRIES = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};

const slash = (p) => p.replace(/\\/g, '/');

/** Absolute path for a project-relative one ('' is the root), or throws if it leaves the project. */
export function inProject(root, rel) {
  const clean = String(rel || '').trim();
  return clean && clean !== '.' ? safePath(root, clean) : resolve(root);
}

/** The entries of one directory: folders first, then files, each by name. */
export function listDirectory(root, rel) {
  const dir = inProject(root, rel);
  const base = resolve(root);
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (privateRoot(full) || entry.name === '.git') continue;
    const isDir = entry.isDirectory();
    if (!isDir && !entry.isFile()) continue;
    let size = null;
    if (!isDir) {
      try { size = statSync(full).size; } catch { continue; }
    }
    entries.push({ name: entry.name, path: slash(relative(base, full)), dir: isDir, size });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  return { path: slash(relative(base, dir)), entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

/**
 * One whole file. Text comes back as text (cut at 2 MB, and says so), an
 * image as a data URL, and anything else as "binary" -- a viewer has nothing
 * useful to show for it.
 */
export function readProjectFile(root, rel) {
  const file = inProject(root, rel);
  const info = statSync(file);
  if (!info.isFile()) throw new Error('not a file');
  const path = slash(relative(resolve(root), file));
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (type) {
    if (info.size > MAX_IMAGE_BYTES) return { path, size: info.size, binary: true };
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(info.size);
      readSync(fd, buf, 0, info.size, 0);
      return { path, size: info.size, image: `data:${type};base64,${buf.toString('base64')}` };
    } finally { closeSync(fd); }
  }
  const length = Math.min(info.size, MAX_FILE_BYTES);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, length, 0); } finally { closeSync(fd); }
  // A NUL in the first few kilobytes is what tells a binary from a text file.
  if (buf.subarray(0, 8192).includes(0)) return { path, size: info.size, binary: true };
  return { path, size: info.size, content: buf.toString('utf8'), truncated: info.size > MAX_FILE_BYTES };
}

/** Files whose path contains `query`, breadth first so shallow matches come first. */
export function findFiles(root, query, { limit = 200, visit = 20000 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { results: [] };
  const base = resolve(root);
  const queue = [base];
  const results = [];
  let seen = 0;
  while (queue.length && results.length < limit && seen < visit) {
    const dir = queue.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const full = join(dir, entry.name);
      if (privateRoot(full)) continue;
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        const path = slash(relative(base, full));
        if (path.toLowerCase().includes(needle)) results.push({ name: basename(full), path });
        if (results.length >= limit) break;
      }
    }
  }
  return { results, truncated: results.length >= limit };
}
