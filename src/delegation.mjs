const clip = (value, length = 1600) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);

export function delegationPrompt(request) {
  return `You route work for a coding agent. Decide whether a focused read-only subagent should first gather evidence.

Delegate when there is a bounded search, code-location, repository inspection, factual lookup, or summary that can be completed independently and will reduce the parent agent's exploration. Do not delegate greetings, purely conversational answers, a single obvious edit, or work that inherently requires changing files. Prefer reasoning "none" for find/search/summary, "low" for comparison, and "medium" only for difficult analysis.

Output JSON only:
{"delegate":true,"task":"self-contained research objective with expected evidence","reasoning":"none"}
or
{"delegate":false,"task":"","reasoning":"none"}

USER REQUEST:
${clip(request, 3000)}`;
}

export function parseDelegation(content) {
  const match = String(content || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    if (typeof value.delegate !== 'boolean') return null;
    const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    return {
      delegate: value.delegate,
      task: clip(value.task, 3000),
      reasoning: allowed.has(value.reasoning) ? value.reasoning : 'none',
    };
  } catch {
    return null;
  }
}
