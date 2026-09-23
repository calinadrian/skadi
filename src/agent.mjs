// The agent loop: send the conversation to the active provider, stream the
// reply, run whatever tools it asks for, feed the results back, repeat until it
// stops calling tools. Everything interesting is emitted as an event so the UI
// can render it as it happens rather than waiting for the turn to finish.
import { EventEmitter } from 'node:events';
import { ToolError } from './tools.mjs';
import { streamCompletion, INVALID_ARGS_KEY } from './providers.mjs';
import {
  compactionSettings,
  estimateTokens,
  isContextOverflow,
  clipTailToolOutputs,
  splitForCompaction,
  truncateForSummary,
  SUMMARY_PROMPT,
} from './compaction.mjs';
import {
  applyLedgerOverride,
  createProgressLedger,
  ledgerView,
  seedLedger,
  completionGaps,
  incompleteCompletion,
  objectiveFromMessages,
  observeToolRound,
  recordLoop,
  progressLedgerText,
  taskBudgets,
} from './progress-ledger.mjs';

const BASE_PROMPT = `You are Skadi, a coding agent running on the user's Windows machine.

You work by calling tools. Prefer acting over narrating: read the files you need, make the change, and verify it. Do not describe a change you have not made.

Guidelines:
- Read a file before editing it. Never guess at its contents.
- Locate symbols with grep before reading broad files. Read the smallest useful numbered line range; for files over 256 KB, always pass start_line and end_line instead of using the shell as a workaround.
- Make the smallest change that does the job, and match the surrounding style.
- After editing code, run the relevant test or build command if one exists.
- If a tool fails, read the error and adapt. Do not retry the identical call.
- For implementation work, move deliberately through locate, diagnose, implement, and verify. A plausible theory is not a diagnosis, and a syntax check is not runtime proof.
- For medium or hard implementation work, create a concise 3-8 step execution plan with update_plan before broad exploration. Keep exactly one current step marked working, update steps as evidence lands, and follow user edits to the plan. Do not recreate work the user skipped or deleted. A plan is a coordination surface, not an approval gate: continue automatically unless a real permission or product decision blocks you.
- Delegate bounded discovery, searching, code-location, and summarisation work with delegate_task before doing broad exploration yourself. Use reasoning "none" for routine find/search/summary tasks; increase it only when the delegated analysis genuinely needs it. Keep edits and final runtime verification in the parent agent.
- When you are done, say plainly what you changed. If something did not work, say so.
- This chat is the only one you can see. Other sessions are private and the harness blocks every path into them, so never go looking for them: what you know of earlier work is what is in this conversation, in memory, or in the project itself. If the user's request depends on something from another chat, ask them for it.`;

const LOCAL_NOTE = `- You are a quantised local model with limited context. Be economical: read line ranges rather than whole large files, and do not re-read what you already have.`;

// Permission modes, Claude-style. The harness enforces these; the prompt tells
// the model how to behave inside them so it does not fight the gating.
const PERMISSION_NOTES = {
  acceptEdits: 'File edits apply immediately without review; shell commands still ask first. Verify with tests and report what changed.',
  plan: 'PLAN MODE — research only. Read files and explore; do NOT create, edit or delete files. Shell commands still ask first. End your turn with a concrete plan and wait — the user approves it by switching modes. Do not retry blocked edits.',
  auto: 'AUTO MODE — your file edits and commands run without review. Stay strictly within the request; do not escalate (no deploys, no mass deletes, no pushing secrets).',
  dontAsk: "DON'T-ASK MODE — anything that would need approval is denied automatically. Work with reads only, or tell the user exactly what needs enabling.",
  bypassPermissions: 'BYPASS MODE — all permission checks are skipped. Be extra careful: every command runs as-is.',
};

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

/** Assemble the system prompt from the base rules plus context blocks. */
export async function buildSystemPrompt({ skills, memory, project, provider, model, browser, permissionMode }) {
  const parts = [BASE_PROMPT + (provider?.managed ? `\n${LOCAL_NOTE}` : '')];

  if (skills) parts.push(skills);
  if (memory) parts.push(memory);
  if (project) parts.push(`## Project\n\n${project}\n\nEvery file path you use is relative to the project root above.`);
  if (permissionMode && permissionMode !== 'default' && PERMISSION_NOTES[permissionMode]) {
    parts.push(`## Permission mode\n\n${PERMISSION_NOTES[permissionMode]}`);
  }

  if (browser) {
    parts.push(
      `## Review browser\n\nYou can drive a real browser with the browser_* tools to check your own work: open a dev server or page, read the rendered text, check the console for errors, and capture a screenshot the user will see. The browser belongs to this chat alone -- its pages, cookies and console are not shared with other chats -- and the user watches the same page, console and audio in the pane beside you. Load the \`browser-review\` skill before using them.`,
    );
  }

  parts.push(
    `## Environment\n\n- Platform: Windows; run_command uses PowerShell by default\n- Model: ${model || 'unknown'} via ${provider?.label || provider?.id || 'local'}${provider?.vision ? ' (can view images)' : ' (text only)'}`,
  );

  return parts.join('\n\n');
}

export class Agent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.provider resolved provider record
   * @param {string} opts.model
   * @param {object} opts.tools name -> { schema, run, mutates }
   * @param {(call) => Promise<boolean>} opts.approve gate for mutating tools
   */
  constructor({ provider, model, tools, schemas, settings, approve, contextTokens = null, summaryModel = null, reviewProgress = null, stopOnLoop = false }) {
    super();
    this.provider = provider;
    this.model = model;
    // Auxiliary model for compaction summaries (Hermes-style). Null/empty
    // means the main model. Resolved by the caller, which knows what the
    // provider can actually serve.
    this.summaryModel = summaryModel || null;
    this.tools = tools;
    this.schemas = schemas;
    this.settings = settings;
    this.approve = approve || (async () => true);
    this.abortController = null;
    this.running = false;
    // Context window governing compaction: the active profile's ctx for a
    // managed llama-server, the provider's figure for hosted APIs. Null means
    // unknown -- automatic preflight is skipped but manual compaction works.
    this.contextTokens = contextTokens;
    // Optional semantic supervisor supplied by the server. It judges the
    // completed action against the user's request; it does not use a timer or
    // a round-count heuristic. A detected bad step is removed from the active
    // model context while remaining archived in the saved chat.
    this.reviewProgress = reviewProgress;
    // Focused read-only children should hand control back to their parent as
    // soon as the semantic supervisor confirms they are no longer making
    // progress. A parent agent instead gets guidance and may adapt in place.
    this.stopOnLoop = Boolean(stopOnLoop);
    // Tool schemas ride on every request alongside the transcript, so they
    // count toward the window too. Cached: schemas do not change mid-turn.
    this.schemasTokens = estimateTokens([{ role: 'system', content: JSON.stringify(schemas || []) }]);
    this.abortController = null;
    this.running = false;
    // Images produced by tools mid-turn (screenshots), handed to the model on
    // the next round when it can actually see them.
    this.pendingImages = [];
    // Messages queued while this turn was running, waiting for a boundary
    // where their role is legal. Most are user steers; harness events such as
    // background-task completion use system so they never impersonate user
    // input. See steer().
    this.pendingSteers = [];
    // What the current round has streamed so far. Kept so a turn that dies
    // mid-stream (abort, provider error, the app being closed) can still put
    // the text it produced into the transcript instead of dropping it.
    this.partial = null;
    // Hooks the caller fills in: `persist` writes the transcript out, and
    // `archive` is handed the messages compaction is about to replace, so the
    // stored chat keeps the history the model no longer carries. Both are
    // optional -- a bare Agent (the manual compactor) can run without them.
    this.persist = null;
    this.archive = null;
    // Optional per-round context supplied by the server. Unlike the system
    // prompt, this is evaluated immediately before every provider request, so
    // an execution plan edited mid-turn becomes authoritative next round.
    this.liveGuidance = null;
    // Returns { override, snapshot } for the current session: the user's manual
    // ledger corrections and the counters saved by earlier turns.
    this.liveLedger = null;
  }

  /**
   * Append to the live transcript and persist it before anything else is
   * emitted. `persist` is the caller's save hook; awaiting it here is what
   * makes the ordering guarantee hold -- by the time the UI sees the `stats`
   * or `tool_result` event for a message, that message is already on disk,
   * so a reopened chat can trust the saved transcript and replay only what
   * is still streaming.
   */
  async _append(messages, message) {
    messages.push(message);
    this.emit('transcript', { reason: message.role });
    try {
      await this.persist?.();
    } catch (err) {
      // A failed save must not kill the turn; the final save still tries.
      this.emit('persist_error', { error: err.message });
    }
    return message;
  }

  abort() {
    this.abortController?.abort();
  }

  /**
   * Take a message the user typed while this turn was running.
   *
   * It is not pushed straight onto the transcript: a user message landing
   * between an assistant's tool_calls and their results is a shape no wire
   * format accepts, and the request would be rejected outright. It waits here
   * until the run loop reaches a boundary where it is legal.
   *
   * Returns false when no turn is running, so the caller can start one
   * normally instead -- the turn may have ended while the message was in
   * flight.
   */
  steer(content, { role = 'user' } = {}) {
    if (!this.running) return false;
    this.pendingSteers.push({ role: role === 'system' ? 'system' : 'user', content });
    this.emit('steer', { queued: this.pendingSteers.length });
    return true;
  }

  /** Splice queued steers into `messages`. Returns how many landed. */
  async _drainSteers(messages) {
    if (!this.pendingSteers.length) return 0;
    const queued = this.pendingSteers;
    this.pendingSteers = [];
    for (const item of queued) {
      // A bare value was the pre-role API and remains a user steer.
      const message = item && typeof item === 'object' && 'content' in item
        ? item
        : { role: 'user', content: item };
      await this._append(messages, message);
    }
    return queued.length;
  }

  /** Queue an image for the model to look at on its next round. */
  offerImage({ mediaType, data, label }) {
    if (!this.provider?.vision) return false;
    this.pendingImages.push({ mediaType, data, label });
    return true;
  }

  /**
   * Run one user turn to completion.
   * `messages` is mutated in place so the caller keeps the full transcript.
   */
  async run(messages, { sampling = {} } = {}) {
    if (this.running) throw new Error('agent is already running a turn');
    this.running = true;
    // Auto-compaction is attempted at most once per turn; see the preflight.
    this.autoCompactBlocked = false;
    let rounds = 0;
    let roundRetried = false; // overflow-recovery retry used for this round
    const turnStarted = Date.now();
    let totalTokens = 0;
    let loopGuidance = '';
    let implementationGuidance = '';
    let forceImplementation = false;
    const ledger = createProgressLedger(objectiveFromMessages(messages));
    seedLedger(ledger, this.liveLedger?.()?.snapshot);
    applyLedgerOverride(ledger, this.liveLedger?.()?.override);
    const budgets = taskBudgets(this.settings, ledger.complexity);
    const maxRounds = budgets.maxRounds;
    const bounded = maxRounds > 0;
    const verificationReserve = ledger.complexity === 'hard' ? 4 : ledger.complexity === 'medium' ? 3 : 2;
    // Zero means genuinely unlimited. A post-edit verification reserve may
    // extend a real ceiling, but must not invent a cosmetic denominator that
    // the loop does not enforce (for example "round 50 of 9").
    const activeRoundLimit = () => bounded
      ? Math.max(maxRounds, ledger.firstMaterialMutationRound ? ledger.firstMaterialMutationRound + verificationReserve : 0)
      : 0;
    const maxTurnMinutes = Math.max(0, Number(this.settings.maxTurnMinutes) || 0);
    const turnDeadline = maxTurnMinutes ? turnStarted + maxTurnMinutes * 60_000 : 0;
    const reviewEvery = Math.max(1, Number(this.settings.loopReviewEvery) || 3);

    try {
      while (!bounded || rounds < activeRoundLimit()) {
        if (turnDeadline && Date.now() >= turnDeadline) {
          const gaps = completionGaps(ledger);
          const note = `Paused after the ${maxTurnMinutes}-minute turn safety limit. The task is incomplete. Current phase: ${ledger.phase}. ${gaps.length ? `Open gaps: ${gaps.join('; ')}.` : 'Continue from the saved progress instead of restarting discovery.'}`;
          await this._append(messages, { role: 'assistant', content: note });
          this.emit('done', { rounds, truncated: true, incomplete: true, reason: 'time_limit', totalTokens, turnMs: Date.now() - turnStarted });
          return messages;
        }
        rounds++;
        // Manual edits from the UI apply on the very next round.
        applyLedgerOverride(ledger, this.liveLedger?.()?.override);
        this.emit('round', { round: rounds, maxRounds: activeRoundLimit(), complexity: ledger.complexity, phase: ledger.phase });
        const roundStart = messages.length;

        // Preflight (opencode-style): compact before the request goes out when
        // the transcript is already pressing against the window, so the turn
        // never pays for a rejection it could see coming.
        const cfg = compactionSettings(this.settings);
        if (
          cfg.auto
          && this.contextTokens
          && !this.autoCompactBlocked
          && this.requestTokens(messages) >= cfg.threshold * this.contextTokens
        ) {
          const result = await this.compact(messages, { manual: false });
          // One attempt per turn. A compaction that failed — or that could not
          // get back under the threshold — fails the same way next round, and
          // retrying it every round is minutes of local decode for nothing.
          // Overflow recovery below still gets its own shot.
          if (!result.compacted || result.after >= cfg.threshold * this.contextTokens) {
            this.autoCompactBlocked = true;
          }
        }

        let reply;
        try {
          reply = await this._stream(
            messages,
            sampling,
            [progressLedgerText(ledger), loopGuidance, implementationGuidance].filter(Boolean).join('\n\n'),
            forceImplementation ? this.schemas.filter((schema) => ['edit_file', 'write_file'].includes(schema?.function?.name)) : this.schemas,
          );
        } catch (err) {
          // Overflow recovery: one compact-and-retry per round. A second
          // rejection means the window genuinely cannot hold the work, and
          // looping compactions would only grind the session into the ground.
          if (isContextOverflow(err) && !roundRetried) {
            roundRetried = true;
            const result = await this.compact(messages, { manual: false });
            if (!result.compacted) throw err;
            reply = await this._stream(
              messages,
              sampling,
              [progressLedgerText(ledger), loopGuidance, implementationGuidance].filter(Boolean).join('\n\n'),
              forceImplementation ? this.schemas.filter((schema) => ['edit_file', 'write_file'].includes(schema?.function?.name)) : this.schemas,
            );
          } else {
            throw err;
          }
        }
        roundRetried = false;
        this.partial = null; // the round landed whole; nothing left to salvage
        await this._append(messages, reply.message);
        totalTokens += reply.usage?.completion_tokens || 0;

        this.emit('stats', {
          round: rounds,
          tps: reply.tps,
          promptTps: reply.promptTps,
          ttftMs: reply.ttftMs,
          elapsedMs: reply.elapsedMs,
          promptTokens: reply.usage?.prompt_tokens ?? null,
          completionTokens: reply.usage?.completion_tokens ?? null,
          contextTokens: this.contextTokens,
        });

        if (!reply.message.tool_calls?.length) {
          if (forceImplementation && ledger.materialMutations === 0) {
            const removed = messages.splice(roundStart);
            if (removed.length) await this.archive?.(removed);
            implementationGuidance = 'You tried to end an implementation request without changing a file. Discovery is complete. Use edit_file or write_file now to make the smallest justified fix. Do not explain, search, test, or stop before the edit.';
            this.emit('loop_detected', { round: rounds, reason: 'attempted to finish without implementing', next: 'make the smallest justified file edit', removed: removed.length });
            await this.persist?.();
            continue;
          }
          const gaps = completionGaps(ledger);
          if (ledger.implementation && gaps.length) {
            const removed = messages.splice(roundStart);
            if (removed.length) await this.archive?.(removed);
            implementationGuidance = `You tried to finish while the progress ledger still shows incomplete deliverables: ${gaps.join('; ')}. Replace the placeholder or empty content with the requested real content, then verify the rendered result. Do not claim completion.`;
            this.emit('loop_detected', { round: rounds, reason: 'attempted to finish with unresolved deliverable gaps', next: 'replace placeholder content and verify the rendered result', removed: removed.length });
            this.emit('transcript', { reason: 'incomplete_deliverable' });
            await this.persist?.();
            continue;
          }
          if (ledger.implementation && ledger.materialMutations > 0 && ledger.verifications === 0) {
            const removed = messages.splice(roundStart);
            if (removed.length) await this.archive?.(removed);
            implementationGuidance = 'You tried to finish after editing without a relevant verification. Run the smallest test, build, or rendered-browser check that exercises the changed deliverable. Research downloads, dev-server startup, and syntax-only narration do not count.';
            this.emit('loop_detected', { round: rounds, reason: 'attempted to finish without verifying the edited deliverable', next: 'run a relevant test, build, or rendered-browser check', removed: removed.length });
            this.emit('transcript', { reason: 'unverified_deliverable' });
            await this.persist?.();
            continue;
          }
          if (
            ledger.implementation
            && ledger.complexity === 'hard'
            && incompleteCompletion(reply.message.content)
            && (!bounded || rounds < activeRoundLimit())
          ) {
            const removed = messages.splice(roundStart);
            if (removed.length) await this.archive?.(removed);
            implementationGuidance = 'You tried to declare a hard task complete while admitting that required data, assets, content, or implementation is still missing. A scaffold is not the requested deliverable. Continue now: use browser_extract on the dynamic source, try the next credible source if needed, populate the real data/assets, and verify the completed result. Do not ask the user to supply information that is available from the sources they named.';
            this.emit('loop_detected', {
              round: rounds,
              reason: 'attempted to finish a hard task with an admitted completion gap',
              next: 'retrieve and implement the missing required content, then verify the complete result',
              removed: removed.length,
            });
            await this.persist?.();
            continue;
          }
          // A thinking model can spend a whole round reasoning and emit no
          // visible answer. Surface the reasoning rather than ending on a blank.
          if (!reply.message.content && reply.message.reasoning_content) {
            reply.message.content = `(no answer text; the model only produced reasoning)\n\n${reply.message.reasoning_content}`;
            this.emit('token', reply.message.content);
          }
          // Something the user typed while the answer was streaming: keep the
          // turn alive and answer it now rather than making them send it
          // again. The round budget starts over, because that ceiling exists
          // to stop an unattended model looping -- and a person just spoke.
          if (await this._drainSteers(messages)) {
            rounds = 0;
            continue;
          }
          this.emit('done', {
            rounds,
            usage: reply.usage,
            finishReason: reply.finishReason,
            totalTokens,
            turnMs: Date.now() - turnStarted,
          });
          return messages;
        }

        const toolResults = [];
        for (const call of reply.message.tool_calls) {
          const result = await this._invoke(call);
          toolResults.push(result);
          await this._append(messages, { role: 'tool', tool_call_id: call.id, content: result.content });
          this.emit('tool_result', { id: call.id, name: call.function.name, ...result });
        }

        const observed = observeToolRound(ledger, reply.message.tool_calls, toolResults);
        const deterministic = observed.repeated;
        this.emit('progress', {
          phase: ledger.phase,
          rounds: ledger.rounds,
          edits: ledger.materialMutations,
          verifications: ledger.verifications,
          gaps: completionGaps(ledger),
          ledger: ledgerView(ledger),
        });

        const discoveryLimit = budgets.discoveryRounds;
        if (ledger.implementation && ledger.materialMutations === 0 && discoveryLimit && ledger.rounds >= discoveryLimit) {
          forceImplementation = true;
          implementationGuidance = `Discovery budget reached after ${ledger.rounds} rounds with no edit. Using the evidence already gathered, state the cause and minimal plan internally, then use edit_file or write_file on the next action. Discovery tools are now unavailable. Do not stop, search, or run another test before editing.`;
        } else if (
          ledger.implementation
          && ledger.materialMutations === 0
          && discoveryLimit
          && ledger.rounds >= Math.max(1, discoveryLimit - 2)
        ) {
          implementationGuidance = `Convergence checkpoint: identify the most likely cause from the evidence already gathered and form a minimal edit plan now. At most ${discoveryLimit - ledger.rounds} discovery round(s) remain before the agent must implement. Do not broaden the investigation.`;
        } else if (ledger.materialMutations > 0) {
          forceImplementation = false;
          implementationGuidance = completionGaps(ledger).length
            ? `Implementation has started, but it is not complete. Resolve these detected gaps before reporting success: ${completionGaps(ledger).join('; ')}.`
            : ledger.verifications > 0
              ? 'The deliverable has material edits and a relevant verification. Fix any observed regression or report the completed result plainly.'
              : 'Implementation has started. Run the smallest relevant verification of the actual deliverable, fix regressions caused by the edit, then report the result.';
        }

        if (this.settings.loopDetection !== false && this.reviewProgress && !this.pendingImages.length) {
          let review = deterministic;
          const semanticReviewDue = this.stopOnLoop || ledger.rounds % reviewEvery === 0
            || (ledger.implementation && ledger.materialMutations === 0 && discoveryLimit && ledger.rounds >= discoveryLimit - 1);
          if (!review && semanticReviewDue) {
            try {
              review = await this.reviewProgress({
                messages,
                roundStart,
                round: rounds,
                signal: this.abortController?.signal,
                ledger: progressLedgerText(ledger),
              });
            } catch (err) {
              if (this.abortController?.signal.aborted) throw err;
              this.emit('loop_review_error', { error: err.message });
            }
          }
          if (review?.loop) {
            const strikes = deterministic?.strikes || recordLoop(ledger);
            const safeToPrune = reply.message.tool_calls.every((call) => !this.tools[call.function.name]?.mutates);
            const removed = safeToPrune ? messages.splice(roundStart) : [];
            if (removed.length) await this.archive?.(removed);
            const escalation = strikes >= 2 ? '\nThis approach has now stalled repeatedly. Do not use it again in this turn.' : '';
            loopGuidance = `A progress supervisor detected a loop in the previous action and removed that action from your active context. Reason: ${review.reason || 'it did not add new evidence toward the request.'}\nNext action: ${review.next || 'return to the original request, choose one decisive test, then implement or report a precise blocker.'}${escalation}\nDo not repeat or paraphrase the removed action.`;
            if (!safeToPrune) loopGuidance = loopGuidance.replace(' and removed that action from your active context', '; the action may have had side effects, so its record was retained');
            this.emit('loop_detected', { round: rounds, reason: review.reason || '', next: review.next || '', removed: removed.length });
            this.emit('transcript', { reason: 'loop_prune' });
            await this.persist?.();
            if (this.stopOnLoop) {
              const note = `Research handed back to the parent after the progress supervisor detected no useful progress. ${review.reason ? `Reason: ${review.reason}. ` : ''}${review.next ? `Recommended next action: ${review.next}.` : ''}`.trim();
              await this._append(messages, { role: 'assistant', content: note });
              this.emit('done', {
                rounds,
                semanticHandoff: true,
                totalTokens,
                turnMs: Date.now() - turnStarted,
              });
              return messages;
            }
            continue;
          }
          loopGuidance = '';
        }

        // Hand over any screenshots the tools produced, as a user turn --
        // tool results cannot carry images on either wire format.
        if (this.pendingImages.length) {
          const blocks = [];
          for (const image of this.pendingImages) {
            blocks.push({ type: 'image', mediaType: image.mediaType, data: image.data });
            blocks.push({ type: 'text', text: image.label || 'Screenshot of the current page.' });
          }
          this.pendingImages = [];
          await this._append(messages, { role: 'user', content: blocks });
        }

        // Tool results are in: a user message is legal again.
        if (await this._drainSteers(messages)) rounds = 0;
      }

      const gaps = completionGaps(ledger);
      const note = `Stopped at the adaptive ${ledger.complexity}-task emergency ceiling of ${activeRoundLimit()} tool rounds. Semantic loop detection remained active. The task is incomplete; continue it from the saved progress rather than treating this as a finished result.${gaps.length ? ` Open gaps: ${gaps.join('; ')}.` : ''}`;
      await this._append(messages, { role: 'assistant', content: note });
      this.emit('done', { rounds, truncated: true, incomplete: true, reason: 'round_limit', totalTokens, turnMs: Date.now() - turnStarted });
      return messages;
    } catch (err) {
      // Stopped, rejected or disconnected mid-reply: whatever the model had
      // already said is real work the user watched happen. Keep it, marked as
      // interrupted, rather than throwing the round away.
      const partial = this.partial;
      const text = partial?.content?.trim() || partial?.reasoning?.trim();
      if (text) {
        const body = partial.content.trim()
          ? partial.content.trim()
          : `(interrupted while reasoning)\n\n${partial.reasoning.trim()}`;
        await this._append(messages, { role: 'assistant', content: `${body}\n\n_[interrupted]_` });
      }
      throw err;
    } finally {
      this.partial = null;
      this.running = false;
      this.abortController = null;
      this.pendingImages = [];
      // Anything still queued belongs to a turn that is over; steer() now
      // refuses, so the next send starts a turn of its own.
      this.pendingSteers = [];
    }
  }

  /** Estimated size of the next request: transcript plus tool schemas. */
  requestTokens(messages) {
    return estimateTokens(messages) + (this.schemasTokens || 0);
  }

  /**
   * Rewrite `messages` in place: everything except the system prompt and the
   * recent tail is replaced by a model-written continuation summary.
   * `messages` is mutated (like run does) so callers keep the live transcript.
   *
   * What is replaced is handed to `archive` first. `messages` is the model's
   * view of the chat, not the record of it: the caller files the replaced
   * messages on the session so reading the chat back still shows everything
   * that was said, however many times it has been compacted.
   *
   * Returns { compacted, before, after, dropped, kept }.
   */
  async compact(messages, { manual = false } = {}) {
    const cfg = compactionSettings(this.settings);
    const contextTokens = this.contextTokens;
    const before = this.requestTokens(messages);
    this.emit('compact_start', { manual, before, contextTokens });

    const fail = (reason) => {
      const result = { compacted: false, reason, before, after: before, dropped: 0, kept: messages.length };
      this.emit('compact_end', { manual, ...result });
      return result;
    };

    // Unknown window (API provider without a figure) falls back to a wide
    // static budget.
    const window = contextTokens || 128000;
    const tailTokens = Math.floor(window * cfg.tailFraction);
    const split = splitForCompaction(messages, cfg.keepMessages, { tailTokens });
    const { system, head } = split;
    const tail = clipTailToolOutputs(split.tail, tailTokens);
    if (!head.length && tail === split.tail) return fail('nothing to compact');
    if (!head.length) {
      // Nothing old to summarise: the window is full of a few giant tool
      // results. Clipping them is the whole compaction.
      messages.length = 0;
      messages.push(...system, ...tail);
      this.emit('transcript', { reason: 'compaction' });
      try { await this.persist?.(); } catch { /* the turn's own save covers it */ }
      const result = { compacted: true, before, after: this.requestTokens(messages), dropped: 0, kept: tail.length, contextTokens, summaryModel: null };
      this.emit('compact_end', { manual, ...result });
      return result;
    }

    // The summary request must itself fit: cap tool outputs, then shed the
    // oldest head messages first when even that is not enough.

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    let summary;
    let dropped = 0;
    let progressChars = 0;
    let inputCap = cfg.summaryInputTokens;
    let lastDiag = '';
    // A dedicated summary model (Hermes-style auxiliary model) when the
    // caller configured one the provider can serve, else the main model.
    const summaryModel = this.summaryModel || this.model;
    // Two attempts max. The usual empty-summary shape is a thinking trace
    // eating the whole output budget (empty content, length finish), and the
    // trace grows with the input — so the retry halves the input instead of
    // pointlessly asking again with the same one.
    for (let attempt = 0; attempt < 2 && !summary; attempt++) {
      const truncated = truncateForSummary(head, {
        contextTokens: window,
        reserve: cfg.reserve,
        summaryMaxTokens: cfg.summaryMaxTokens,
        summaryInputTokens: inputCap,
        toolOutputChars: cfg.toolOutputChars,
      });
      dropped = truncated.dropped;
      const summands = truncated.messages;
      try {
        const result = await streamCompletion(
          this.provider,
          {
            model: summaryModel,
            messages: [...summands, { role: 'user', content: SUMMARY_PROMPT }],
            tools: [],
            sampling: {
              max_tokens: cfg.summaryMaxTokens,
              temperature: 0.2,
              // Local llama-server only, verified against the live build: Qwen
              // thinking models dump a long <think> trace before summarising,
              // which is minutes of decode at local speeds. Switching thinking
              // off for the summary keeps the facts and drops the trace.
              // (Unrelated providers never see this key.)
              ...(this.provider.managed ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            },
          },
          {
            // Minutes of silence read as a hang on a local model. Report the
            // summary as it streams — reasoning deltas included, since a
            // thinking model spends most of the wait there — so the UI shows
            // it is alive.
          onText: (t) => {
            progressChars += t.length;
            this.emit('compact_progress', { manual, chars: progressChars, text: t });
          },
          onReasoning: (t) => {
            progressChars += t.length;
            this.emit('compact_progress', { manual, chars: progressChars, reasoning: t });
          },
          },
          signal,
        );
        summary = result.message?.content?.trim();
        if (!summary) {
          const thinkChars = result.message?.reasoning_content?.length || 0;
          lastDiag = `finish=${result.finishReason || 'unknown'}, think=${thinkChars} chars`;
          inputCap = Math.floor(inputCap / 2);
        }
      } catch (err) {
        // Stop means stop: ending the turn beats failing into an immediate
        // re-compact on the next loop pass.
        if (signal.aborted) throw err;
        // A summary that itself overflows (or any other failure) must not eat
        // the transcript: leave `messages` untouched and report.
        return fail(isContextOverflow(err) ? 'summary request overflowed' : `summary failed: ${err.message}`);
      }
    }
    if (!summary) return fail(`model returned an empty summary (${lastDiag})`);

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const note = dropped > 0 ? `\n(Note: the ${dropped} oldest message(s) were dropped without summarisation to fit the summary request.)` : '';
    const replacement = [
      ...system,
      { role: 'assistant', content: `[Compacted context — ${stamp}]\n\n${summary}${note}` },
      ...tail,
    ];
    // Off to the session file before the live array loses them. If that
    // cannot be done, do not compact: the turn may then overflow, which is a
    // visible error, where losing the history silently is not.
    try {
      if (head.length) await this.archive?.(head);
    } catch (err) {
      return fail(`could not archive the replaced messages: ${err.message}`);
    }
    messages.length = 0;
    messages.push(...replacement);
    this.emit('transcript', { reason: 'compaction' });
    try {
      await this.persist?.();
    } catch { /* the turn's own save still covers it */ }

    const result = {
      compacted: true,
      before,
      after: this.requestTokens(messages),
      dropped,
      kept: tail.length,
      contextTokens,
      summaryModel,
    };
    this.emit('compact_end', { manual, ...result });
    return result;
  }

  async _invoke(call) {
    const name = call.function.name;
    const tool = this.tools[name];
    if (!tool) return { content: `Error: no tool named "${name}".`, ok: false };

    let args = {};
    if (call.function.arguments?.trim()) {
      try {
        args = JSON.parse(call.function.arguments);
      } catch (err) {
        // Small models sometimes emit not-quite-JSON. Say so precisely so the
        // model can correct itself next round.
        return {
          content: `Error: arguments were not valid JSON (${err.message}). Received: ${call.function.arguments.slice(0, 300)}`,
          ok: false,
        };
      }
      // Arguments that were already unparseable when they arrived: the text is
      // kept inside legal JSON so the transcript stays replayable. Report it
      // exactly as if it had just been parsed here.
      const broken = args?.[INVALID_ARGS_KEY];
      if (broken) {
        return {
          content: `Error: arguments were not valid JSON (${broken.reason}). Received: ${String(broken.received).slice(0, 300)}`,
          ok: false,
        };
      }
    }

    const mode = this.settings.permissionMode || 'default';

    // Plan mode: research only. Mutating file/memory/skill tools are blocked
    // outright; shell commands still go through the normal approval prompt so
    // exploration (git log, test runs) stays possible with consent.
    if (mode === 'plan' && tool.mutates && name !== 'run_command') {
      return {
        content:
          'Plan mode is on: this action is blocked. Research the codebase and present your plan instead — ' +
          'the user approves it by switching permission modes. Do not retry this call.',
        ok: false,
        denied: true,
      };
    }

    const needsApproval =
      tool.mutates &&
      ((name === 'run_command' && this.settings.approveCommands) ||
        (name !== 'run_command' && this.settings.approveWrites));

    // Mode baselines, Claude-style. acceptEdits auto-approves file-side
    // mutations but still gates shell commands; auto and bypassPermissions
    // run everything without asking.
    const autoApprove =
      mode === 'bypassPermissions' || mode === 'auto' ||
      (mode === 'acceptEdits' && name !== 'run_command');

    if (needsApproval && !autoApprove) {
      // dontAsk: anything that would prompt is denied instead of asked.
      if (mode === 'dontAsk') {
        return {
          content:
            "Permission mode 'Don't ask' denied this action automatically — it would have needed approval. " +
            'Continue with reads only, or tell the user what needs enabling.',
          ok: false,
          denied: true,
        };
      }
      this.emit('approval_request', { id: call.id, name, args });
      const allowed = await this.approve({ id: call.id, name, args });
      if (!allowed) {
        return {
          content: 'The user declined this action. Do not retry it; ask what they would prefer.',
          ok: false,
          denied: true,
        };
      }
    }

    this.emit('tool_call', { id: call.id, name, args });
    const startedAt = Date.now();
    try {
      const content = await tool.run(args, { callId: call.id, signal: this.abortController?.signal });
      return { content: String(content), ok: true, ms: Date.now() - startedAt };
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `${err.name}: ${err.message}`;
      return { content: `Error: ${message}`, ok: false, ms: Date.now() - startedAt };
    }
  }

  async _stream(messages, sampling, guidance = '', schemas = this.schemas) {
    this.abortController = new AbortController();
    const partial = { content: '', reasoning: '' };
    this.partial = partial;
    const live = this.liveGuidance?.() || '';
    const combinedGuidance = [guidance, live].filter(Boolean).join('\n\n');
    const result = await streamCompletion(
      this.provider,
      {
        model: this.model,
        messages: combinedGuidance ? [...messages, { role: 'system', content: combinedGuidance }] : messages,
        tools: schemas,
        sampling,
      },
      {
        onText: (t) => {
          partial.content += t;
          this.emit('token', t);
        },
        onReasoning: (t) => {
          partial.reasoning += t;
          this.emit('reasoning', t);
        },
        onRetry: (d) => this.emit('retry', d),
      },
      this.abortController.signal,
    );
    this.emit('message', result);
    return result;
  }
}
