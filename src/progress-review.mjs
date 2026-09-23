// Semantic progress supervision for agent tool loops. The reviewer sees the
// original request and the action that just completed, not a timer or an
// arbitrary call counter. Its answer is intentionally tiny and machine-read.

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
};

const clip = (value, length = 1800) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);

export function progressReviewInput(messages, roundStart, ledger = '') {
  const firstUser = [...messages.slice(0, roundStart)].reverse().find((m) => m.role === 'user');
  const prior = messages.slice(Math.max(0, roundStart - 8), roundStart);
  const current = messages.slice(roundStart);
  const render = (rows) => rows.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return `assistant tools: ${m.tool_calls.map((c) => `${c.function.name}(${clip(c.function.arguments, 500)})`).join(', ')}`;
    }
    return `${m.role}: ${clip(textOf(m.content))}`;
  }).join('\n');
  return { request: clip(textOf(firstUser?.content), 2400), prior: render(prior), current: render(current), ledger: clip(ledger, 2400) };
}

// Written for the same small local model that does the work: one yes/no
// question, the evidence it needs, and a default of "no". A false "yes" costs
// the agent a detour, so only a clear repeat or a clear wrong turn counts.
export function progressReviewPrompt(input) {
  return `You check whether a coding agent's latest step was useful. Answer semantically, from the evidence below.

Answer "loop": true ONLY if the latest step clearly added nothing: it fetched information the agent already had, retried a failed step without changing anything, or worked on something unrelated to the request. Reading a new file, editing, running a test, or checking a result is useful, even when it fails. If you are unsure, answer false.

If "loop" is true, "next" must be one short, concrete action that gets back on track (for example "edit src/app.js to fix the handler").

Reply with JSON only, no other text:
{"loop":false,"reason":"short reason","next":""}

USER REQUEST:
${input.request}

EARLIER STEPS:
${input.prior || '(none)'}

LATEST STEP:
${input.current}

PROGRESS SO FAR:
${input.ledger || '(none)'}`;
}

export function parseProgressReview(content) {
  const raw = String(content || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    if (typeof value.loop !== 'boolean') return null;
    return {
      loop: value.loop,
      reason: clip(value.reason, 500),
      next: clip(value.next, 500),
    };
  } catch {
    return null;
  }
}
