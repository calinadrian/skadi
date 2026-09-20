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
  createProgressLedger,
  observeToolRound,
  recordLoop,
  progressLedgerText,
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
    // Messages the user typed while this turn was running, waiting for a
    // boundary where a user message is legal. See steer().
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
  steer(content) {
    if (!this.running) return false;
    this.pendingSteers.push(content);
    this.emit('steer', { queued: this.pendingSteers.length });
    return true;
  }

  /** Splice queued steers into `messages`. Returns how many landed. */
  async _drainSteers(messages) {
    if (!this.pendingSteers.length) return 0;
    const queued = this.pendingSteers;
    this.pendingSteers = [];
    for (const content of queued) await this._append(messages, { role: 'user', content });
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
    // Positive values are an optional emergency ceiling. Zero leaves stopping
    // to semantic loop detection and the model completing the task.
    const configuredRounds = Number(this.settings.maxToolRounds);
    const maxRounds = Number.isFinite(configuredRounds) && configuredRounds > 0 ? Math.floor(configuredRounds) : 0;
    const bounded = maxRounds > 0;
    const turnStarted = Date.now();
    let totalTokens = 0;
    let loopGuidance = '';
    const initialRequest = [...messages].reverse().find((message) => message.role === 'user');
    const ledger = createProgressLedger(typeof initialRequest?.content === 'string' ? initialRequest.content : '');

    try {
      while (!bounded || rounds < maxRounds) {
        rounds++;
        this.emit('round', { round: rounds, maxRounds });
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
          reply = await this._stream(messages, sampling, [progressLedgerText(ledger), loopGuidance].filter(Boolean).join('\n\n'));
        } catch (err) {
          // Overflow recovery: one compact-and-retry per round. A second
          // rejection means the window genuinely cannot hold the work, and
          // looping compactions would only grind the session into the ground.
          if (isContextOverflow(err) && !roundRetried) {
            roundRetried = true;
            const result = await this.compact(messages, { manual: false });
            if (!result.compacted) throw err;
            reply = await this._stream(messages, sampling, [progressLedgerText(ledger), loopGuidance].filter(Boolean).join('\n\n'));
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

        const deterministic = observeToolRound(ledger, reply.message.tool_calls, toolResults).repeated;

        if (this.settings.loopDetection !== false && this.reviewProgress && !this.pendingImages.length) {
          let review = deterministic;
          if (!review) {
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

      const note = `Stopped at the optional emergency ceiling of ${maxRounds} tool rounds. Semantic loop detection remained active; raise or disable the ceiling if this task is intentionally larger.`;
      await this._append(messages, { role: 'assistant', content: note });
      this.emit('done', { rounds, truncated: true, totalTokens, turnMs: Date.now() - turnStarted });
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
      dropped += truncated.dropped;
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
      const content = await tool.run(args, { callId: call.id });
      return { content: String(content), ok: true, ms: Date.now() - startedAt };
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `${err.name}: ${err.message}`;
      return { content: `Error: ${message}`, ok: false, ms: Date.now() - startedAt };
    }
  }

  async _stream(messages, sampling, guidance = '') {
    this.abortController = new AbortController();
    const partial = { content: '', reasoning: '' };
    this.partial = partial;
    const result = await streamCompletion(
      this.provider,
      {
        model: this.model,
        messages: guidance ? [...messages, { role: 'system', content: guidance }] : messages,
        tools: this.schemas,
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
