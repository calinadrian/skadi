// Minimal unified diffs for file-edit tool results and the changes viewer.
//
// Single contiguous hunk after prefix/suffix trimming: exact for one
// replacement, and a good approximation for full overwrites. Deliberately
// not Myers -- the UI needs a readable hunk, not minimal edit distance.
export function unifiedDiff(beforeText, afterText, { context = 3, maxLines = 80 } = {}) {
  const a = String(beforeText ?? '').replace(/\r\n/g, '\n').split('\n');
  const b = String(afterText ?? '').replace(/\r\n/g, '\n').split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  // A trailing-newline-only change trims to nothing; say so honestly.
  if (!removed.length && !added.length) return { diff: '', added: 0, removed: 0, truncated: false };

  const ctxBefore = Math.max(0, prefix - context);
  const trailStart = a.length - suffix;
  const trailEnd = Math.min(a.length, trailStart + context);
  const lead = prefix - ctxBefore;
  const trail = trailEnd - trailStart;
  const hunkBeforeStart = ctxBefore + 1; // 1-based for the @@ header
  const hunkAfterStart = ctxBefore + 1;

  const body = [];
  for (let i = ctxBefore; i < prefix; i++) body.push(` ${a[i]}`);
  for (const line of removed) body.push(`-${line}`);
  for (const line of added) body.push(`+${line}`);
  for (let i = trailStart; i < trailEnd; i++) body.push(` ${a[i]}`);

  const truncated = body.length > maxLines;
  const shown = truncated ? body.slice(0, maxLines) : body;
  const lines = [
    `@@ -${hunkBeforeStart},${lead + removed.length + trail} +${hunkAfterStart},${lead + added.length + trail} @@`,
    ...shown,
  ];
  if (truncated) lines.push(`... (${body.length - maxLines} more diff lines truncated)`);
  return { diff: lines.join('\n'), added: added.length, removed: removed.length, truncated };
}

/** First line of an edit result, carrying machine-readable stats for the UI. */
export function statLine(verb, path, added, removed) {
  return `${verb} ${path} [+${added} -${removed}]`;
}

/** Pull [+A -R] stats out of a tool result, or null when it has none. */
export function parseStats(content) {
  const m = /\[\+(\d+) -(\d+)\]/.exec(String(content ?? ''));
  return m ? { added: Number(m[1]), removed: Number(m[2]) } : null;
}

/** Pull the ```diff fenced block out of a tool result, or null. */
export function parseDiff(content) {
  const m = /```diff\n([\s\S]*?)(?:\n```|$)/.exec(String(content ?? ''));
  return m ? m[1] : null;
}
