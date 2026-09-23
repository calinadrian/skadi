import { createHash } from 'node:crypto';

const MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'memory_write', 'skill_write', 'pixel_export']);
const VERIFICATION_TOOLS = new Set(['browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_read', 'task_log', 'pixel_view']);
const DISCOVERY_TOOLS = new Set(['grep', 'glob', 'list_dir', 'read_file', 'web_search', 'browser_extract', 'memory_search', 'skill_read', 'load_skill']);
// Drawing on a pixel canvas is real work that has not reached a file yet: it
// must never count as "searching without editing".
const CREATIVE_TOOLS = new Set(['pixel_new', 'pixel_draw', 'pixel_import']);

const PLACEHOLDER_PATTERNS = [
  /\b(?:todo|placeholder|coming soon|not implemented)\b/i,
  /\b(?:data|content|results?|items?|comps?|openers?)\b.{0,40}\bwill appear here\b/i,
  /\b(?:openers?|comps?|champions?|items?|builds?|lines?)\s*:\s*\[\s*\]/i,
];

const placeholderReason = (value) => {
  const text = String(value ?? '');
  if (!text) return '';
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'placeholder or empty required content remains';
  }
  return '';
};

const commandVerifies = (command) => {
  const text = String(command || '').toLowerCase();
  if (!text) return false;
  // Acquisition, dev-server startup and file inspection are useful, but they
  // do not prove that the edited deliverable works.
  if (/invoke-webrequest|curl\b|wget\b|start-process|\bserve\b|server\.m?js|http\.server|get-content|select-string/.test(text)) return false;
  return /(?:^|[\s;&|])(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|check)|\bnode\s+--test\b|\b(?:pytest|cargo\s+test|go\s+test|dotnet\s+test|ctest|make\s+test|tsc\b|eslint\b|stylelint\b)/.test(text);
};

const supportArtifact = (path) => /(?:^|[\\/])(?:_?check|probe|scratch|tmp|temp)(?:[._-]|$)/i.test(String(path || ''));

export function completionGaps(ledger) {
  // Gaps the user dismissed stay dismissed even if the detector re-raises them.
  return [...ledger.artifactGaps.entries()]
    .filter(([path]) => !ledger.dismissed?.has(path))
    .map(([path, reason]) => `${path}: ${reason}`);
}

const PHASES = ['locate', 'diagnose', 'implement', 'verify', 'complete'];

/** The user's manual corrections to the ledger; persisted with the session. */
export function normaliseLedgerOverride(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    dismissed: [...new Set((Array.isArray(v.dismissed) ? v.dismissed : []).map((x) => clip(x, 180)).filter(Boolean))].slice(0, 50),
    phase: PHASES.includes(v.phase) ? v.phase : '',
    note: clip(v.note, 800),
  };
}

export function applyLedgerOverride(ledger, override) {
  const o = normaliseLedgerOverride(override);
  ledger.dismissed = new Set(o.dismissed);
  ledger.note = o.note;
  ledger.phaseLock = o.phase;
  if (o.phase) ledger.phase = o.phase;
  return ledger;
}

/** Counters worth carrying across turns, compactions and "continue". */
export function ledgerSnapshot(ledger) {
  return {
    request: ledger.request,
    implementation: ledger.implementation,
    mutations: ledger.mutations,
    materialMutations: ledger.materialMutations,
    verifications: ledger.verifications,
    phase: ledger.phase,
    inspected: [...ledger.inspected].slice(-20),
    gaps: [...ledger.artifactGaps.entries()],
    last: ledger.last,
  };
}

export function seedLedger(ledger, snapshot) {
  // Only within the same objective: a new task must start from zero.
  if (!snapshot || snapshot.request !== ledger.request) return ledger;
  ledger.mutations = Number(snapshot.mutations) || 0;
  ledger.materialMutations = Number(snapshot.materialMutations) || 0;
  ledger.verifications = Number(snapshot.verifications) || 0;
  if (ledger.materialMutations) ledger.firstMaterialMutationRound = 1;
  if (PHASES.includes(snapshot.phase)) ledger.phase = snapshot.phase;
  for (const path of snapshot.inspected || []) ledger.inspected.add(path);
  for (const [path, reason] of snapshot.gaps || []) ledger.artifactGaps.set(path, reason);
  return ledger;
}

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

const messageText = (content) => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text || '').trim())
    .filter(Boolean)
    .join('\n');
};

const compactedGoal = (messages) => {
  for (const message of [...(messages || [])].reverse()) {
    if (message?.role !== 'assistant') continue;
    const text = messageText(message.content);
    if (!text.startsWith('[Compacted context')) continue;
    const goal = text.match(/^#+\s*User Goal\s*\n+([\s\S]*?)(?=\n#+\s|$)/im);
    return goal ? goal[1].trim() : '';
  }
  return '';
};

export function objectiveFromMessages(messages) {
  const userTexts = (messages || [])
    .filter((message) => message?.role === 'user')
    .map((message) => messageText(message.content))
    .filter(Boolean);
  const continuation = /^(?:continue|go on|keep going|finish(?: it)?|proceed|try again|yes|ok(?:ay)?)\W*$/i;
  const generatedHandoff = /^(?:screenshot|image) of (?:the )?(?:current )?page/i;
  const candidates = userTexts.filter((text) => !continuation.test(text) && !generatedHandoff.test(text));
  // Compaction can drop every user message. The summary then holds the only
  // record of the goal; without it the ledger reads the run as a non-
  // implementation task and the discovery budget never applies.
  if (!candidates.length) return compactedGoal(messages) || userTexts.at(-1) || '';

  const objective = [...candidates].reverse().find((text) => implementationRequest(text) && text.length >= 30)
    || candidates.at(-1);
  const latest = candidates.at(-1);
  return latest && latest !== objective && latest.length >= 12
    ? `${objective}\nLatest user direction: ${latest}`
    : objective;
}

export function incompleteCompletion(text) {
  return /\b(?:still empty|actual .{0,30} (?:is|are) (?:still )?empty|placeholder(?:s| data)?|not (?:yet )?(?:implemented|finished|included)|couldn(?:'|’)t (?:fetch|extract|finish|complete)|can(?:not|'t) responsibly (?:build|implement)|hit a blocker|before I (?:can )?start building|to finish (?:it|this)|one honest gap|remaining work|missing (?:data|assets?|icons?|content)|once I have the data)\b/i.test(String(text || ''));
}

export function taskComplexity(text) {
  const request = String(text || '').toLowerCase();
  const product = /\b(website|web app|application|dashboard|portal|game|redesign|migration)\b/.test(request);
  const externalData = /\b(current|latest|popular|best|patch|live|website|web|api|scrap|fetch|research|real (?:icons|images|data)|assets?)\b/.test(request);
  const broadScope = /\b(complete|full|entire|end[- ]to[- ]end|multiple|all|everything|from scratch|main (?:page|lines))\b/.test(request);
  const actionCount = (request.match(/\b(build|create|make|design|implement|add|fix|fetch|research|verify|test|deploy)\b/g) || []).length;
  if ((product && (externalData || broadScope)) || (externalData && broadScope) || actionCount >= 4) return 'hard';

  const directFix = /\b(fix|repair|rename|change|remove|replace)\b/.test(request);
  const multiPart = /\b(and|also|then|plus|as well as)\b/.test(request) || actionCount >= 2;
  if (directFix && !externalData && !broadScope && !multiPart && request.length <= 220) return 'easy';
  return 'medium';
}

export function taskBudgets(settings, complexity) {
  const baseRounds = Number(settings?.maxToolRounds);
  const baseDiscovery = Number(settings?.maxImplementationDiscoveryRounds ?? 4);
  const roundScale = { easy: 1, medium: 2, hard: 3.75 }[complexity] || 2;
  const discoveryScale = { easy: 1, medium: 1.5, hard: 2 }[complexity] || 1.5;
  return {
    maxRounds: Number.isFinite(baseRounds) && baseRounds > 0
      ? Math.min(60, Math.max(1, Math.round(baseRounds * roundScale)))
      : 0,
    discoveryRounds: Number.isFinite(baseDiscovery) && baseDiscovery > 0
      ? Math.min(20, Math.max(1, Math.round(baseDiscovery * discoveryScale)))
      : 0,
  };
}

export function createProgressLedger(request = '') {
  return {
    request: clip(request, 1600),
    implementation: implementationRequest(request),
    complexity: taskComplexity(request),
    phase: 'locate',
    rounds: 0,
    mutations: 0,
    firstMutationRound: 0,
    firstMaterialMutationRound: 0,
    verifications: 0,
    materialMutations: 0,
    lastMaterialProgressAt: Date.now(),
    artifactGaps: new Map(),
    inspected: new Set(),
    actions: new Map(),
    loopStrikes: new Map(),
    last: '',
    creative: false,
    pixelViewed: false,
    dismissed: new Set(),
    note: '',
    phaseLock: '',
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
          ? `${name} failed the same way as the last time it was called with these arguments`
          : `${name} was called again with the same arguments and returned the same evidence`,
        next: strikes > 1
          ? 'Abandon this approach: try a different one, or tell the user exactly what is blocking you.'
          : 'Use the result you already have and move on to the next step.',
      };
    }
    ledger.actions.set(fingerprint, { outcome, round: ledger.rounds });

    if (DISCOVERY_TOOLS.has(name)) {
      const target = args?.path || args?.glob || args?.pattern;
      if (target) ledger.inspected.add(clip(target, 180));
      if (ledger.phase === 'locate' && !ledger.phaseLock) ledger.phase = 'diagnose';
    }
    if (CREATIVE_TOOLS.has(name) && result.ok !== false) {
      ledger.creative = true;
      if (ledger.phase === 'locate' || ledger.phase === 'diagnose') ledger.phase = ledger.phaseLock || 'implement';
    }
    // The drawing tools return the grid; the model has looked at its art.
    if ((name === 'pixel_draw' || name === 'pixel_view') && result.ok !== false) ledger.pixelViewed = true;
    if (MUTATION_TOOLS.has(name) && result.ok !== false) {
      ledger.mutations++;
      if (!ledger.firstMutationRound) ledger.firstMutationRound = ledger.rounds;
      mutated = true;

      const path = String(args?.path || '(edited artifact)');
      const evidence = name === 'write_file' ? args?.content : args?.new_string;
      const oldEvidence = name === 'edit_file' ? args?.old_string : '';
      const gap = placeholderReason(evidence);
      if (gap) ledger.artifactGaps.set(path, gap);
      else if (name === 'write_file' || placeholderReason(oldEvidence)) ledger.artifactGaps.delete(path);

      if (!supportArtifact(path)) {
        ledger.materialMutations++;
        if (!ledger.firstMaterialMutationRound) ledger.firstMaterialMutationRound = ledger.rounds;
        ledger.lastMaterialProgressAt = Date.now();
        ledger.phase = ledger.phaseLock || 'verify';
      }
    }

    // Only what the page renders can prove a placeholder is still visible.
    // Test names, diffs and file reads routinely contain "todo" or
    // "placeholder" without the deliverable being incomplete.
    const rendered = VERIFICATION_TOOLS.has(name) && name !== 'task_log';
    // Exporting art the model has already looked at is checked art.
    const verifies = VERIFICATION_TOOLS.has(name) || (name === 'run_command' && commandVerifies(args?.command))
      || (name === 'pixel_export' && ledger.pixelViewed);
    const runtimeGap = rendered ? placeholderReason(result.content) : '';
    if (runtimeGap && ledger.implementation) ledger.artifactGaps.set('(rendered output)', runtimeGap);
    else if (verifies && result.ok !== false) ledger.artifactGaps.delete('(rendered output)');

    if (verifies && result.ok !== false && ledger.materialMutations > 0) {
      ledger.verifications++;
      verified = true;
      ledger.lastMaterialProgressAt = Date.now();
      ledger.phase = ledger.phaseLock || (completionGaps(ledger).length ? 'implement' : 'complete');
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

/** Plain names for the phases, shared with the UI. */
export const STAGE_NAMES = { locate: 'Find', diagnose: 'Understand', implement: 'Change', verify: 'Check', complete: 'Done' };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The one thing the model should do next, judged from the ledger alone. The
 * agent loop may replace it with a sharper instruction (a loop hint, a
 * blocked finish); either way the model is handed exactly one.
 */
export function nextStep(ledger, { planning = false, hasPlan = false } = {}) {
  const gaps = completionGaps(ledger);
  if (!ledger.implementation) return 'Answer the user directly as soon as you have enough information. Do not keep searching once you have it.';
  if (gaps.length) return `Replace the placeholder or empty content in ${gaps.map((gap) => gap.split(':')[0]).join(', ')} with the real content, then check the result again.`;
  if (ledger.materialMutations === 0 && ledger.creative) {
    return 'Keep drawing: read the grid, fix what its suggestions point out, then pixel_export the art to a file and use it where it belongs.';
  }
  if (ledger.materialMutations === 0) {
    if (ledger.rounds === 0 && planning && !hasPlan && ledger.complexity === 'hard') {
      return 'This is a bigger task. First write a short plan with update_plan (3-6 steps), then start on step 1.';
    }
    if (ledger.rounds === 0) return 'Find the code that needs to change: search for it, then read only the lines you need.';
    return 'As soon as you know which file to change, edit it. Do not re-read files you have already looked at.';
  }
  if (ledger.verifications === 0) return 'Check your change: run the relevant test or build, or open the result in the browser. Then report.';
  return 'Your change is made and checked. If the check showed a problem, fix it; otherwise tell the user what you changed and how you checked it, then stop.';
}

/**
 * The progress block sent with every model request. Written for small local
 * models: a handful of short, plain lines, facts first, and a single "Next"
 * instruction last, where recency gives it the most weight.
 */
export function progressLedgerText(ledger, { next = '', planning = false, hasPlan = false } = {}) {
  const inspected = [...ledger.inspected].slice(-6);
  const gaps = completionGaps(ledger);
  const unedited = ledger.implementation && ledger.rounds > 0 && ledger.materialMutations === 0;
  const sofar = [
    inspected.length ? `looked at ${plural(ledger.inspected.size, 'file or search', 'files or searches')} (${inspected.join(', ')})` : 'looked at nothing yet',
    ledger.implementation ? `changed ${plural(ledger.materialMutations, 'project file')}` : '',
    ledger.implementation ? `${plural(ledger.verifications, 'passing check')}` : '',
  ].filter(Boolean).join('; ');
  return [
    '## Progress (kept by Skadi from your tool results; trust it over your memory)',
    `Task: ${ledger.request || '(unknown)'}`,
    ledger.implementation ? `Stage: ${STAGE_NAMES[ledger.phase] || ledger.phase} (Find > Understand > Change > Check > Done)` : '',
    `So far: ${sofar}.`,
    unedited ? 'Not done yet: no project file has been changed, and research alone does not finish this task.' : '',
    gaps.length ? `Still wrong: ${gaps.join('; ')}.` : '',
    ledger.last ? `Last step: ${ledger.last}` : '',
    ledger.dismissed?.size ? `The user checked these and says they are fine; ignore them: ${[...ledger.dismissed].join(', ')}.` : '',
    ledger.note ? `Note from the user (follow it over everything above): ${ledger.note}` : '',
    `Next: ${next || nextStep(ledger, { planning, hasPlan })}`,
  ].filter(Boolean).join('\n');
}

/** What the UI shows: everything in the ledger, including dismissed gaps. */
export function ledgerView(ledger) {
  return {
    request: ledger.request,
    implementation: ledger.implementation,
    complexity: ledger.complexity,
    phase: ledger.phase,
    rounds: ledger.rounds,
    edits: ledger.mutations,
    materialEdits: ledger.materialMutations,
    verifications: ledger.verifications,
    inspected: [...ledger.inspected].slice(-12),
    gaps: [...ledger.artifactGaps.entries()].map(([key, reason]) => ({ key, reason, dismissed: ledger.dismissed.has(key) })),
    last: ledger.last,
    snapshot: ledgerSnapshot(ledger),
  };
}
