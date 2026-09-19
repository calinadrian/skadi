// Context compaction: keep long sessions inside the model's window.
//
// Two triggers, both borrowed from established harnesses:
// - preflight (opencode's `compactIfNeeded`): before each model round, estimate
//   the request size and compact when it crosses threshold * context;
// - overflow recovery (opencode's one-shot retry): when the provider rejects a
//   request as too large, compact once and retry the same step. A second
//   overflow is returned as an error rather than looping forever.
//
// The summary itself is produced by the active model with tools disabled, the
// same way opencode's compaction agent and Hermes' /compress work. Older
// session messages stay in the session file; only the live transcript sent to
// the model is rewritten.
//
// Everything here is pure and dependency-free, like the rest of the harness.
// The agent loop owns the orchestration; this module owns the maths.

export const DEFAULTS = {
  // Master switch for the automatic preflight. Manual compaction and the
  // single overflow-recovery attempt still work when this is false.
  auto: true,
  // Compact when the estimated request reaches this fraction of context.
  // 0.7 leaves room for the reply plus the summary call's own headroom.
  threshold: 0.7,
  // Tokens of headroom the summary request must leave below the window.
  reserve: 8192,
  // Recent messages kept verbatim beside the summary. The split walks back to
  // a user boundary so tool call/result pairs are never torn in half.
  keepMessages: 12,
  // Upper bound on the summary the model may produce.
  summaryMaxTokens: 2048,
  // Upper bound on what gets *summarised*, in tokens. The fit-based budget
  // above can admit 80k+ tokens on a 128k window, and asking a 9 tok/s local
  // model to prefill, think over and condense that takes minutes. Capping the
  // input keeps compaction in the tens of seconds; the oldest overflow beyond
  // the cap is dropped and counted, never silently kept.
  summaryInputTokens: 12000,
  // Per-message cap applied to tool results inside the summary request, so a
  // single huge `grep` cannot itself overflow the summariser (opencode caps at
  // 2000 chars for the same reason).
  toolOutputChars: 2000,
};

// Characters per token for the local estimate. Code- and JSON-heavy agent
// transcripts tokenise denser than prose (a real 286KB session measured ~2.9),
// so this is deliberately conservative: over-estimating only compacts early,
// under-estimating kills the session with a 400.
export const CHARS_PER_TOKEN = 3.5;

// Rough per-image cost when there is no better figure. Local text models never
// see pixels (attachments are flattened to a placeholder line), so this only
// matters for vision-capable API providers.
export const IMAGE_TOKEN_ESTIMATE = 1024;

/** Effective settings: user keys over these defaults, so old settings files work. */
export function compactionSettings(settings) {
  return { ...DEFAULTS, ...(settings?.compaction || {}) };
}

function contentChars(content) {
  if (typeof content === 'string' || content == null) return (content || '').length;
  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (block?.type === 'image') images++;
    else chars += block?.text?.length || 0;
  }
  return { chars, images };
}

/**
 * Heuristic request size in tokens. CHARS_PER_TOKEN per token, plus framing
 * overhead per message and the serialised tool calls. Mirrors opencode's
 * approach of estimating locally when there is no authoritative usage figure
 * yet.
 */
export function estimateTokens(messages) {
  let tokens = 0;
  for (const m of messages || []) {
    const counted = contentChars(m.content);
    const chars = typeof counted === 'number' ? counted : counted.chars;
    const images = typeof counted === 'number' ? 0 : counted.images;
    tokens += chars / CHARS_PER_TOKEN + images * IMAGE_TOKEN_ESTIMATE;
    for (const call of m.tool_calls || []) {
      tokens += ((call.function?.name?.length || 0) + (call.function?.arguments?.length || 0)) / CHARS_PER_TOKEN;
    }
    tokens += (m.reasoning_content?.length || 0) / CHARS_PER_TOKEN;
    tokens += 8; // role framing, tool ids, separators
  }
  return Math.ceil(tokens);
}

/**
 * Does this provider error mean "the request did not fit the context window"?
 * llama.cpp reports `exceed_context_size_error` (HTTP 400); OpenAI uses
 * `context_length_exceeded`; Anthropic reports a prompt that is too long.
 */
export function isContextOverflow(err) {
  const text = `${err?.message || err || ''}`;
  if (!/40[04]|41[34]|52[29]|529/.test(text)) return false;
  return /exceed_?context|context[ _\-]?(size|length|window)|too many tokens|maximum context|prompt is too long|input.*too (long|large)/i
    .test(text);
}

/**
 * Split a transcript into head (to summarise), tail (kept verbatim) and the
 * leading system messages (always kept).
 *
 * The cut prefers a user message so the tail starts on a clean turn boundary,
 * but that search is *bounded*. An agentic turn can run dozens of tool rounds
 * without a single user message in between: an unbounded walk-back then slides
 * all the way to the first user message, leaving an empty head — compaction
 * reports "nothing to compact" while the window keeps growing, which is
 * exactly how a session ends up at 167k inside a 98k context. When no user
 * boundary is near, cut at the ideal point instead and only step back over
 * `tool` messages, so a tool result never loses the call that produced it.
 */
export function splitForCompaction(messages, keepMessages, { maxLookback = keepMessages } = {}) {
  const system = [];
  // Copy: shifting the system prompt off must never mutate the caller's array.
  const rest = [...(messages || [])];
  while (rest.length && rest[0].role === 'system') system.push(rest.shift());

  if (!rest.length) return { system, head: [], tail: [] };

  const ideal = Math.max(rest.length - keepMessages, 0);
  if (ideal === 0) return { system, head: [], tail: rest };

  let start = ideal;
  const floor = Math.max(ideal - maxLookback, 0);
  while (start > floor && rest[start].role !== 'user') start--;
  if (rest[start].role !== 'user') {
    start = ideal;
    // Never cut between an assistant's tool_calls and their results: stepping
    // back over `tool` messages lands on the assistant that issued them, and
    // the whole block stays together in the tail.
    while (start > 0 && rest[start].role === 'tool') start--;
  }
  return { system, head: rest.slice(0, start), tail: rest.slice(start) };
}

/** Shrink one message for the summary request; returns { message, truncated }. */
function shrinkMessage(message, toolOutputChars) {
  if (message.role !== 'tool' || typeof message.content !== 'string') {
    return { message, truncated: false };
  }
  if (message.content.length <= toolOutputChars) return { message, truncated: false };
  const half = Math.floor(toolOutputChars / 2);
  return {
    message: {
      ...message,
      content: `${message.content.slice(0, half)}\n… [${message.content.length - toolOutputChars} chars elided] …\n${message.content.slice(-half)}`,
    },
    truncated: true,
  };
}

/**
 * Prepare the head for summarisation: cap tool outputs, then — if the head
 * still cannot fit alongside the summary allowance — drop the oldest messages
 * first and report how many, so the loss is visible rather than silent.
 */
export function truncateForSummary(head, { contextTokens, reserve, summaryMaxTokens, summaryInputTokens, toolOutputChars }) {
  let shrunk = 0;
  let messages = head.map((m) => {
    const r = shrinkMessage(m, toolOutputChars);
    if (r.truncated) shrunk++;
    return r.message;
  });

  const fitBudget = Math.max(contextTokens - reserve - summaryMaxTokens, 1024);
  const budget = Math.min(fitBudget, summaryInputTokens ?? fitBudget);
  // Cost each message once and subtract as they go. Re-estimating the whole
  // array per drop is O(n^2) over megabytes of transcript -- seconds of dead
  // CPU before the summary request even leaves, on the very sessions where
  // compaction matters most.
  const costs = messages.map((m) => estimateTokens([m]));
  let total = costs.reduce((a, b) => a + b, 0);
  let dropped = 0;
  while (messages.length > 1 && total > budget) {
    total -= costs.shift();
    messages.shift();
    dropped++;
  }
  // Dropping from the front can behead a tool result. An orphan `tool`
  // message (no matching call in the request) is a 400 from every strict
  // OpenAI-compatible endpoint, so shed those too.
  const ids = new Set();
  for (const m of messages) for (const c of m.tool_calls || []) ids.add(c.id);
  const kept = messages.filter((m) => m.role !== 'tool' || !m.tool_call_id || ids.has(m.tool_call_id));
  dropped += messages.length - kept.length;
  return { messages: kept, dropped, shrunk };
}

export const SUMMARY_PROMPT = `You are compacting a coding session so the work can continue in a smaller context window. Summarise ONLY the conversation above; the most recent messages are preserved verbatim elsewhere and are not shown here.

Write a detailed continuation summary covering:
- The user's goal and what has been done so far
- Key decisions and why they were made
- Files created or modified and their current state (concrete paths)
- Commands or tests run and their outcomes, including error messages that still matter
- What remains to do next

Be concrete and omit small talk. A future model must be able to pick up the work from your summary alone.`;

/**
 * Which window governs compaction for this turn. Managed local servers report
 * their slot size (profile ctx, or an adopted external server's n_ctx);
 * hosted providers fall back to their configured figure, then a conservative
 * default that compacts early rather than risking a rejection.
 */
export function resolveContextTokens({ provider, profileCtx, externalCtx, modelCtx }) {
  if (provider?.managed) return externalCtx || profileCtx || null;
  // A window pinned by hand wins; otherwise take the figure the endpoint
  // reports for this model. The constant is a last resort for endpoints that
  // publish no limits, and it is a guess -- it compacts a 262k model at 90k
  // and would sail past a 32k one.
  return provider?.contextTokens || modelCtx || 128000;
}
