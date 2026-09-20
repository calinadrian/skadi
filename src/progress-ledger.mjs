import { createHash } from 'node:crypto';

const MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'memory_write', 'skill_write']);
const VERIFICATION_TOOLS = new Set(['run_command', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'task_log']);
const DISCOVERY_TOOLS = new Set(['grep', 'glob', 'list_dir', 'read_file', 'web_search', 'memory_search', 'skill_read']);

const clip = (value, length = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};

const argsOf = (call) => {
  try { return stable(JSON.parse(call?.function?.arguments || '{}')); }
  catch { return clip(call?.function?.arguments, 1000); }
};

export const actionFingerprint = (call) => `${call?.function?.name || 'unknown'}:${JSON.stringify(argsOf(call))}`;
const digest = (value) => createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 12);

export function implementationRequest(text) {
  return /\b(fix|implement|add|change|remove|replace|update|improve|build|create|make|repair|refactor|doesn(?:'|’)t work|not working|broken)\b/i.test(String(text || ''));
}

export function createProgressLedger(request = '') {
  return {
    request: clip(request, 1600),
    implementation: implementationRequest(request),
    phase: 'locate',
    rounds: 0,
    mutations: 0,
    verifications: 0,
    inspected: new Set(),
    actions: new Map(),
    loopStrikes: new Map(),
    last: '',
  };
}

export function observeToolRound(ledger, calls, results) {
  ledger.rounds++;
  let repeated = null;
  let mutated = false;
  let verified = false;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const result = results[i] || {};
    const name = call?.function?.name || 'unknown';
    const args = argsOf(call);
    const fingerprint = actionFingerprint(call);
    const outcome = `${result.ok === false ? 'error' : 'ok'}:${digest(result.content)}`;
    const previous = ledger.actions.get(fingerprint);
    if (previous?.outcome === outcome) {
      const strikes = (ledger.loopStrikes.get(fingerprint) || 0) + 1;
      ledger.loopStrikes.set(fingerprint, strikes);
      repeated ||= {
        loop: true,
        fingerprint,
        strikes,
        reason: result.ok === false
          ? `${name} repeated the same failed action without adapting`
          : `${name} repeated an action that returned the same evidence`,
        next: strikes > 1
          ? 'abandon this approach; choose a different decisive test or report the precise blocker'
          : 'use the evidence already collected and take the next implementation or verification step',
      };
    }
    ledger.actions.set(fingerprint, { outcome, round: ledger.rounds });

    if (DISCOVERY_TOOLS.has(name)) {
      const target = args?.path || args?.glob || args?.pattern;
      if (target) ledger.inspected.add(clip(target, 180));
      if (ledger.phase === 'locate') ledger.phase = 'diagnose';
    }
    if (MUTATION_TOOLS.has(name) && result.ok !== false) {
      ledger.mutations++;
      mutated = true;
      ledger.phase = 'verify';
    }
    if (VERIFICATION_TOOLS.has(name) && result.ok !== false && ledger.mutations > 0) {
      ledger.verifications++;
      verified = true;
      ledger.phase = 'complete';
    }
    ledger.last = `${name} ${result.ok === false ? 'failed' : 'completed'}: ${clip(result.content, 260)}`;
  }
  return { repeated, mutated, verified };
}

export function recordLoop(ledger, fingerprint = 'semantic') {
  const strikes = (ledger.loopStrikes.get(fingerprint) || 0) + 1;
  ledger.loopStrikes.set(fingerprint, strikes);
  return strikes;
}

export function progressLedgerText(ledger) {
  const inspected = [...ledger.inspected].slice(-8);
  return [
    'PROGRESS LEDGER (authoritative; do not repeat completed discovery):',
    `Objective: ${ledger.request || '(unknown)'}`,
    `Phase: ${ledger.phase}`,
    `Material edits: ${ledger.mutations}; post-edit verification actions: ${ledger.verifications}`,
    `Inspected: ${inspected.length ? inspected.join(', ') : '(none)'}`,
    `Latest result: ${ledger.last || '(none)'}`,
    ledger.implementation
      ? 'Completion contract: locate the responsible code, establish a falsifiable cause, edit it, then run a relevant verification. Syntax-only checks do not prove runtime behavior.'
      : 'Completion contract: answer the objective directly and stop when sufficient evidence exists.',
  ].join('\n');
}
