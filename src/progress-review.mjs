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

export function progressReviewPrompt(input) {
  return `You are a strict progress supervisor for a coding agent. Judge the latest completed tool action semantically against the original request.

Mark "loop" true only when the latest action made no new useful progress because it repeats already-known evidence, explores an unrelated branch, retries a failed approach without adapting, or investigates after the direct fix/test is already clear. A failed decisive test can still be progress. Be conservative: do not punish necessary verification.

If loop is true, give one concrete next action that returns to the shortest path. Output JSON only:
{"loop":false,"reason":"brief evidence-based reason","next":"single concrete next action"}

ORIGINAL REQUEST:
${input.request}

RECENT PRIOR EVIDENCE:
${input.prior || '(none)'}

LATEST ACTION:
${input.current}

CURRENT PROGRESS LEDGER:
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
