// Catches a quiet kind of broken fix: script that toggles a CSS class no
// stylesheet styles on its own. `el.classList.add('hidden')` looks right in a
// diff and passes a syntax check, but if the only rule is `.overlay.hidden`
// nothing happens on screen. Reported with the edit, so the model finds out
// while it can still fix it instead of from the user.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const SCRIPT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm', '.vue', '.svelte']);
const STYLE = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.vue', '.svelte']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'vendor']);
const MAX_FILES = 200;
const MAX_BYTES = 512 * 1024;

const CLASS_CALL = /classList\s*\.\s*(?:add|toggle|replace)\s*\(([^)]*)\)/g;
const QUOTED = /['"`]([A-Za-z_-][\w-]*)['"`]/g;

/** Class names the new text toggles that the old text did not. */
export function classesAdded(before, after) {
  const found = (text) => {
    const out = new Set();
    for (const [, args] of String(text || '').matchAll(CLASS_CALL)) {
      for (const [, name] of args.matchAll(QUOTED)) out.add(name);
    }
    return out;
  };
  const old = found(before);
  return [...found(after)].filter((c) => !old.has(c));
}

async function styleSources(root) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 4 || files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
      } else if (STYLE.has(extname(e.name).toLowerCase())) {
        files.push(join(dir, e.name));
      }
    }
  };
  await walk(root, 0);
  const texts = [];
  for (const f of files) {
    const s = await stat(f).catch(() => null);
    if (s && s.size <= MAX_BYTES) texts.push(await readFile(f, 'utf8').catch(() => ''));
  }
  return texts.join('\n');
}

/**
 * How each class is styled: 'alone' when some selector uses `.name` as the
 * whole compound (`.hidden`, `div .hidden`, `[hidden], .hidden`), 'compound'
 * when it only ever appears joined to something else (`.overlay.hidden`), or
 * 'none' when no stylesheet mentions it.
 */
export function classStyling(css, name) {
  const esc = name.replace(/[-]/g, '\\-');
  // Selectors only: drop comments and declaration bodies.
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '{}');
  const any = new RegExp(`\\.${esc}(?![\\w-])`);
  if (!any.test(selectors)) return 'none';
  // Alone: nothing attached before it, and nothing but pseudo-classes after.
  const alone = new RegExp(`(^|[\\s,>+~(}])\\.${esc}(?![\\w-])(?=\\s*(?::[\\w-]+(?:\\([^)]*\\))?)*\\s*[,{>+~)\\s])`, 'm');
  return alone.test(selectors) ? 'alone' : 'compound';
}

/** Warning text for an edit to `path`, or '' when there is nothing to say. */
export async function styleWarning(workspace, path, before, after) {
  if (!SCRIPT.has(extname(String(path)).toLowerCase())) return '';
  const added = classesAdded(before, after);
  if (!added.length) return '';
  const css = await styleSources(workspace);
  if (!css.trim()) return '';
  const lines = [];
  for (const name of added) {
    const how = classStyling(css, name);
    if (how === 'none') lines.push(`- "${name}": no stylesheet in the project mentions .${name}, so toggling it changes nothing on screen.`);
    else if (how === 'compound') lines.push(`- "${name}": .${name} is only styled joined to another selector (e.g. .other.${name}), so on this element it may change nothing.`);
  }
  if (!lines.length) return '';
  return `\n\nWarning: classes this edit toggles may have no visible effect:\n${lines.join('\n')}\n` +
    'Add a CSS rule that targets this element, or set the style directly. Check the result on screen (e.g. getComputedStyle), not just that the class is present.';
}
