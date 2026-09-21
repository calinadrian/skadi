import { estimateTokens } from './compaction.mjs';
import { redactCredentials } from './sessions.mjs';
import { unifiedDiff } from './diff.mjs';

// Never stringify image payloads into search results or token breakdowns.
export function searchableText(message) {
  const content = Array.isArray(message.content)
    ? message.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
    : String(message.content || '');
  return redactCredentials([content, ...(message.tool_calls || []).map(c =>
    `${c.function?.name || ''} ${c.function?.arguments || ''}`)].join('\n'));
}

export function searchSession(session, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const messages = [...(session.archive || []), ...(session.messages || [])];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'system') continue;
    const text = searchableText(messages[index]);
    const at = text.toLowerCase().indexOf(q);
    if (at >= 0) return { index, snippet: text.slice(Math.max(0, at - 45), at + q.length + 110).replace(/\s+/g, ' ') };
  }
  return session.title?.toLowerCase().includes(q) ? { index: null, snippet: session.title } : null;
}

export function contextDetails(session) {
  const buckets = { instructions: 0, conversation: 0, attachments: 0, tools: 0 };
  for (const m of session.messages || []) {
    const key = m.role === 'system' ? 'instructions' : m.role === 'tool' || m.tool_calls?.length ? 'tools' : 'conversation';
    const textOnly = Array.isArray(m.content) ? { ...m, content: m.content.filter(b => b.type !== 'image') } : m;
    const total = estimateTokens([m]);
    const text = estimateTokens([textOnly]);
    buckets[key] += text;
    buckets.attachments += Math.max(0, total - text);
  }
  const total = estimateTokens(session.messages || []);
  const largest = Object.keys(buckets).sort((a, b) => buckets[b] - buckets[a])[0];
  buckets[largest] += total - Object.values(buckets).reduce((sum, count) => sum + count, 0);
  return { buckets, total, requirements: session.requirements || '',
    summary: (session.messages || []).filter(m => m.role === 'assistant' && /^\[Compacted context/.test(searchableText(m))).map(searchableText).join('\n\n').slice(-16000) };
}

export function turnReview(session, tasks = []) {
  return (session.workTurns || []).map(turn => {
    const edits = (session.undo || []).filter(e => e.turnId === turn.id);
    const background = tasks.filter(t => t.sessionId === session.id && t.startedAt >= turn.startedAt && (!turn.finishedAt || t.startedAt <= turn.finishedAt));
    return { ...turn, name: redactCredentials(turn.name), commands: (turn.commands || []).map(c => ({ ...c, command: redactCredentials(c.command) })), background,
      files: [...new Set(edits.map(e => e.path))],
      edits: edits.map(e => ({ callId: e.callId, path: e.path, undone: e.undone, truncated: e.truncated,
        diff: e.truncated ? '' : unifiedDiff(e.before, e.after, { maxLines: 500 }).diff })) };
  });
}

export function recordCommand(turn, event) {
  const command = turn.commands.find(c => c.id === event.id);
  if (!command) return;
  const code = /^exit code (-?\d+)\b/m.exec(String(event.content || ''));
  command.exitCode = code ? Number(code[1]) : null;
  command.status = code ? (Number(code[1]) === 0 ? 'passed' : 'failed') : event.ok === false ? 'failed' : 'unknown';
}
