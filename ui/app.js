// Skadi UI. One SSE stream in, small JSON POSTs out.

import { languageFor, highlightLines, paintLine } from './highlight.js';
import { makeSlider } from './slider.js';

const $ = (id) => document.getElementById(id);
const redactCredentials = (value) => String(value ?? '').replace(
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
  '[credential redacted]',
);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = redactCredentials(text);
  return node;
};

const api = async (path, body) => {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // A page newer than the server it came from: the endpoint exists in the
    // files on disk, just not in the process serving them.
    if (res.status === 404 && /^no route for /.test(data.error || '')) {
      throw new Error(`${data.error} — Skadi's server is older than this page. Restart Skadi.`);
    }
    throw new Error(data.error || res.statusText);
  }
  return data;
};

const GB = 1073741824;
const gb = (bytes) => (bytes == null ? '—' : `${(bytes / GB).toFixed(2)} GB`);
const num = (n) => (n == null ? '—' : n.toLocaleString());
const kb = (bytes) => `${Math.max(Math.round(bytes / 1024), 1)} KB`;

const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

/**
 * A name for the browser of a chat that does not exist server-side yet. It
 * only has to be unique within this window and survive being handed to the
 * server as a key, so the shape matches what a session id would be.
 */
function newDraftKey() {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const state = {
  config: null,
  settings: null,
  settingsDefaults: null,
  server: null,
  providers: [],
  activeProvider: null,
  projects: [],
  activeProject: null,
  sessionId: null,
  // The browser key for a chat that has not been sent in yet, and so has no
  // id to key on. It is minted fresh for each new chat rather than being the
  // constant 'draft' every unsent chat shared: two new chats in a row both
  // answered to that name, so the second opened on the first one's page --
  // and sending in it handed over the first one's browser for good.
  draftKey: newDraftKey(),
  sessions: [],
  groups: [],
  chatFilter: 'all', // all | unread | archived
  chatQuery: '',
  editing: null,   // profile id shown in the settings panel
  streaming: null, // { raw, bodyEl, thinkEl, thinkBody, metaEl }
  // The compaction summary's own bubble. Kept apart from `streaming` because
  // the summary belongs *above* the prompt whose turn triggered it, not at the
  // end of that turn -- and because the round's real answer still needs its
  // own bubble once compaction is done.
  compacting: null, // { raw, bodyEl, thinkEl, thinkBody, frame }
  lastAssistant: null,
  // Session ids with a turn running right now, as last reported by the
  // server's `turns` event. Several chats can be mid-turn at once, so "busy"
  // is a property of a chat, not of the window. Every agent event names its
  // session and is only rendered when that is the chat on screen, so browsing
  // away mid-turn cannot leak one turn's tokens into another transcript.
  running: new Set(),
  // sessionId -> the approval its turn is waiting on, shown when that chat is
  // the one open.
  approvals: new Map(),
  // Last completion signal per chat. Incomplete ceilings must never be styled
  // as successful completion just because the agent stopped running.
  outcomes: new Map(),
  // Null until the event stream has opened once; false once it drops.
  online: null,
  browserDevice: 'desktop',
  browserViewport: null, // current device viewport; server is authoritative
  // The chat whose browser the pane is showing. Each chat drives its own
  // Chromium, so the pane rebinds when you switch chats.
  browserStreamKey: null,
  browserAudio: { volume: 1, muted: false },
  // What the open chat has written to disk: the bar above the transcript
  // renders this, and it is replaced wholesale on every edit.
  changes: null,
  consoleEntries: [],
  consoleErrorsOnly: false,
  ctxUsed: null, // estimated context tokens in the open session
  ctxLimit: null, // window they are measured against
  attachments: [],
  webSearch: true,
  subagents: true,
  browserStream: null,
  tasks: [],
  undo: [], // this session's file-edit undo entries {callId, path, added, removed, at}
  plan: { version: 1, revision: 0, updatedAt: 0, userEdited: false, items: [], deleted: [] },
};

// The default provider: where a new chat starts, and what Settings edits.
const currentProvider = () => state.providers.find((p) => p.id === state.activeProvider) || null;

// ----------------------------------------------------------------------------
// Each chat has its own provider and model.
//
// `chatProvider` / `chatModel` are the open chat's pick; null means "follow the
// default", which is what a new chat and any chat that has never been sent in
// do. Sending stores the pick on the chat, so it is restored when the chat is
// reopened -- whatever the default has become in the meantime.
// ----------------------------------------------------------------------------
state.chatProvider = null;
state.chatModel = null;
// What the endpoint says about the picked model: { key, contextTokens, reasoning }.
state.chatInfo = null;

// Every llama-server Skadi runs, by profile id, as the server last described it.
state.instances = new Map();
// The .gguf files on disk, for the "Load a model" list.
state.localModels = [];
// The Load area: which model is picked, and which settings to load it with
// (a profile id, or 'default').
state.loadModel = null;
state.loadProfile = null;
// Models whose default profile is being made right now.
state.defaulting = new Set();
// "model|profile" keys of loads in flight, so a second click cannot double-launch.
state.loading = new Set();
state.vramByModel = new Map();
// The llama-server builds on this machine, for the profile's Engine setting.
state.engines = [];

const chatProviderId = () => state.chatProvider || state.activeProvider;

/** The open chat's provider row, with the chat's model laid over the provider's own. */
function chatProvider() {
  const row = state.providers.find((p) => p.id === chatProviderId());
  if (!row) return null;
  const merged = { ...row };
  if (row.managed) {
    const inst = chatLocalInstance();
    merged.instance = inst?.id ?? null;
    merged.model = inst?.alias || inst?.label || null;
    merged.contextTokens = inst?.ctx ?? undefined;
  } else if (state.chatModel) {
    merged.model = state.chatModel;
  }
  // The server resolves the window and the reasoning flag for the default
  // provider only; for any other pick they come from `chatInfo`.
  const key = `${merged.id}|${merged.model || ''}`;
  if (state.chatInfo?.key === key) {
    merged.contextTokens = state.chatInfo.contextTokens ?? undefined;
    merged.reasoning = state.chatInfo.reasoning;
  } else if (merged.id !== state.activeProvider || merged.model !== row.model) {
    delete merged.contextTokens;
    delete merged.reasoning;
  }
  return merged;
}
const isLocal = () => Boolean(chatProvider()?.managed);

/** Loaded models a chat could talk to, oldest first. An attached foreign server counts. */
function chatReadyInstances() {
  return [...state.instances.values()]
    .filter((i) => i.state === 'ready' || i.state === 'external')
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

/**
 * The loaded model the open chat is talking to: the one it picked, else the
 * one loaded most recently -- the same rule the server applies.
 */
function chatLocalInstance() {
  const ready = chatReadyInstances();
  return ready.find((i) => i.id === state.chatModel) || ready.at(-1) || null;
}

// ============================================================================
// Reasoning effort (opencode-style picker below the prompt bar)
//
// llama.cpp understands: default (server default), minimal, low, medium,
// high, xhigh (and max). OpenAI-compatible endpoints take reasoning_effort
// verbatim; Anthropic maps onto a thinking budget server-side. 'default'
// always sends nothing, so it is safe for every provider.
// ============================================================================

// The rungs OpenRouter accepts for `reasoning.effort`, plus Default, which
// sends nothing and leaves the endpoint to its own setting. `none` turns
// thinking off outright; `max` is the top of the ladder above `xhigh`.
const EFFORTS = [
  { value: 'default', label: 'Default' },
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Xhigh' },
  { value: 'max', label: 'Max' },
];

const effortKey = () => `skadi.effort.${chatProviderId() || 'default'}`;

function currentEffort() {
  const sel = $('effortSelect');
  // A picker the model would ignore reports Default rather than its last
  // value, so the request carries nothing instead of a setting that is
  // silently dropped on the way.
  if (!sel || sel.disabled) return 'default';
  return sel.value || 'default';
}

/**
 * Does the active model take a reasoning effort? true / false / null, where
 * null means its endpoint does not publish the answer -- only OpenRouter does
 * -- and the picker is left alone rather than greyed out on a guess.
 */
function reasoningSupported() {
  return chatProvider()?.reasoning ?? null;
}

function renderEffort() {
  const sel = $('effortSelect');
  if (!sel) return;
  sel.replaceChildren(...EFFORTS.map(({ value, label }) => {
    const option = el('option', null, label);
    option.value = value;
    return option;
  }));
  let saved = 'default';
  try {
    saved = localStorage.getItem(effortKey()) || 'default';
  } catch { /* private mode */ }
  if (!EFFORTS.some((e) => e.value === saved)) saved = 'default';
  sel.value = saved;

  const provider = chatProvider();
  // A model that takes no reasoning parameter is the case worth saying out
  // loud: gateways drop what a model does not accept instead of refusing it,
  // so the picker used to look like it worked and change nothing at all.
  const supported = reasoningSupported();
  sel.disabled = supported === false;
  sel.classList.toggle('unsupported', supported === false);
  sel.title = supported === false
    ? `${provider?.model || 'This model'} takes no reasoning setting — the effort would be ignored, so none is sent`
    : `Reasoning effort for ${provider?.label || 'this provider'} — Default uses the server default`;
}

// ============================================================================
// Permission mode (Claude-style selector below the prompt bar)
//
// Manual prompts for every mutation; Accept edits auto-approves file writes;
// Plan blocks file mutations so the model researches and proposes; Auto runs
// everything without asking; Don't ask denies instead of prompting; Bypass
// skips all checks. Persisted server-side, applies mid-turn.
// ============================================================================

const MODES = [
  { value: 'default', label: 'Ask before changes', hint: 'Reads run; every file write or command asks first' },
  { value: 'acceptEdits', label: 'Apply file edits', hint: 'File edits apply immediately; shell commands still ask' },
  { value: 'plan', label: 'Plan only', hint: 'Research only — file edits are blocked until you switch modes' },
  { value: 'auto', label: 'Run automatically', hint: 'Everything runs without asking' },
  { value: 'dontAsk', label: 'Read only', hint: 'Anything that would ask is denied instead' },
  { value: 'bypassPermissions', label: 'Unrestricted', hint: 'Skip all permission checks (unreviewed commands run as-is)' },
];

// Shift+Tab cycle, Claude-style: the everyday modes only, Bypass and
// Don't ask stay on the dropdown.
const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];

function currentMode() {
  // Server state first: right after renderMode's replaceChildren the select's
  // own value is just the first option ('default'), which would mask it.
  const v = state.settings?.permissionMode || $('modeSelect')?.value || 'default';
  return MODES.some((m) => m.value === v) ? v : 'default';
}

function renderMode() {
  const sel = $('modeSelect');
  if (!sel) return;
  sel.replaceChildren(...MODES.map(({ value, label, hint }) => {
    const option = el('option', null, label);
    option.value = value;
    option.title = hint;
    return option;
  }));
  sel.value = currentMode();
  const active = MODES.find((m) => m.value === sel.value);
  sel.title = active ? `Permission mode — ${active.hint}` : 'Permission mode';
  renderEmptyReadiness();
}

async function setMode(value, { confirmed = false } = {}) {
  if (!MODES.some((m) => m.value === value)) value = 'default';
  if (value === 'bypassPermissions' && !confirmed) {
    const ok = await askConfirm(
      'Bypass mode skips ALL permission checks — every file write and shell command runs without review.\n\nUse it only for work you fully trust.',
      { title: 'Switch to Bypass?', ok: 'Switch to Bypass' },
    );
    if (!ok) {
      renderMode();
      return;
    }
  }
  state.settings = await api('settings', { permissionMode: value });
  renderMode();
}

function cycleMode() {
  const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode()) + 1) % MODE_CYCLE.length];
  setMode(next, { confirmed: true }).catch((err) => addMessage('error', err.message));
}

// ============================================================================
// Live activity: a pulsing "what is the AI doing" line below the prompt bar.
// Updated on every agent SSE event; hidden when idle.
// ============================================================================

let activeTurnStartedAt = 0;
let activeTurnText = '';

function renderTurnStatus() {
  const card = $('turnStatus');
  if (!card) return;
  const busy = isBusy();
  card.hidden = !busy;
  if (!busy) return;
  activeTurnStartedAt ||= Date.now();
  $('turnStatusText').textContent = activeTurnText || 'Working…';
  $('turnElapsed').textContent = fmtDur(Date.now() - activeTurnStartedAt);
}

function renderOutcomeBar() {
  const bar = $('outcomeBar');
  if (!bar) return;
  const answers = [...document.querySelectorAll('#messages .msg.assistant .body')];
  const hasAnswer = answers.some((node) => node.textContent.trim());
  const outcome = state.outcomes.get(state.sessionId);
  const lastAnswer = answers.at(-1)?.textContent || '';
  const inferredIncomplete = /\b(?:task is incomplete|task paused|stopped at the adaptive|paused after the \d+(?:\.\d+)?-minute turn safety limit)\b/i.test(lastAnswer);
  const incomplete = Boolean(outcome?.incomplete || outcome?.truncated || inferredIncomplete);
  const title = $('outcomeTitle');
  const hint = $('outcomeHint');
  if (title) title.textContent = incomplete ? 'Task paused — incomplete' : 'Task finished';
  if (hint) hint.textContent = incomplete
    ? 'Review the saved progress and continue from the open gaps'
    : 'Inspect the result before continuing';
  bar.classList.toggle('incomplete', incomplete);
  bar.hidden = isBusy() || !state.sessionId || !hasAnswer;
}

function setActivity(text) {
  const box = $('activity');
  if (!box) return;
  if (!text) {
    box.hidden = true;
    renderTurnStatus();
    return;
  }
  box.hidden = false;
  $('activityText').textContent = text;
  activeTurnText = text;
  renderTurnStatus();
}

async function refreshBranch() {
  const node = $('branchName');
  if (!node) return;
  try {
    const st = await api('git/status');
    node.textContent = st.isRepo ? (st.branch || '') : '';
    node.title = st.isRepo ? `${st.branch} → working tree` : 'Not a git repository';
  } catch {
    node.textContent = '';
    node.title = '';
  }
}

// ============================================================================
// Markdown
//
// Model output is untrusted, so every string is escaped before it can reach
// innerHTML, and code spans are pulled out before any other transform runs so
// their contents cannot be reinterpreted as markup.
// ============================================================================

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(text) {
  return text
    .split(/`([^`]+)`/)
    .map((chunk, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(chunk)}</code>`;
      let out = escapeHtml(chunk);
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
      // Only http(s) links become anchors; anything else stays plain text.
      out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
      return out;
    })
    .join('');
}

function codeBlockNode(raw) {
  const newline = raw.indexOf('\n');
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  const hasLang = firstLine.length > 0 && firstLine.length < 20 && !/\s/.test(firstLine);
  const lang = hasLang ? firstLine : '';
  const code = hasLang ? raw.slice(newline + 1) : raw;

  const block = el('div', 'code-block');
  const head = el('div', 'code-head');
  head.append(el('span', 'lang', lang || 'text'));

  const copy = el('button', 'icon-btn');
  copy.type = 'button';
  copy.title = 'Copy';
  copy.append(icon('copy'));
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code.replace(/\n$/, ''));
      copy.replaceChildren(icon('check'));
      setTimeout(() => copy.replaceChildren(icon('copy')), 1200);
    } catch {
      /* clipboard blocked; nothing useful to show */
    }
  };
  head.append(copy);

  const pre = el('pre');
  const codeEl = el('code');
  // The fence label picks the language; unknown labels fall back to plain text.
  paintCode(codeEl, code.replace(/\n$/, ''), languageFor(lang));
  pre.append(codeEl);
  block.append(head, pre);
  return block;
}

function pipeTable(lines) {
  const rows = lines
    .filter((l) => !/^\s*\|?[\s:-]*\|[\s:|-]*$/.test(l))
    .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  if (rows.length < 2) return null;
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  for (const cell of rows[0]) {
    const th = el('th');
    th.innerHTML = inlineHtml(cell);
    htr.append(th);
  }
  thead.append(htr);
  const tbody = el('tbody');
  for (const row of rows.slice(1)) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      td.innerHTML = inlineHtml(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

function renderProse(text, frag) {
  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const h = el(`h${heading[1].length}`);
      h.innerHTML = inlineHtml(heading[2]);
      frag.append(h);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      frag.append(el('hr'));
      continue;
    }
    if (lines.length >= 2 && lines.every((l) => l.includes('|'))) {
      const table = pipeTable(lines);
      if (table) { frag.append(table); continue; }
    }
    if (lines.every((l) => /^\s*>/.test(l))) {
      const quote = el('blockquote');
      quote.innerHTML = inlineHtml(lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'));
      frag.append(quote);
      continue;
    }
    const isBullet = lines.every((l) => /^\s*[-*+]\s+/.test(l));
    const isNumber = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
    if ((isBullet || isNumber) && lines.length) {
      const list = el(isBullet ? 'ul' : 'ol');
      for (const line of lines) {
        const li = el('li');
        li.innerHTML = inlineHtml(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        list.append(li);
      }
      frag.append(list);
      continue;
    }
    const p = el('p');
    p.innerHTML = inlineHtml(trimmed).replace(/\n/g, '<br>');
    frag.append(p);
  }
}

function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  redactCredentials(src).split(/```/).forEach((part, i) => {
    if (i % 2 === 1) frag.append(codeBlockNode(part));
    else renderProse(part, frag);
  });
  return frag;
}

// ============================================================================
// Chat rendering
// ============================================================================

let pinned = true;
function scrollDown(force) {
  const box = $('messages');
  if (!force && !pinned) return;
  box.scrollTop = box.scrollHeight;
}
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
});

function addMessage(role, text, extras) {
  $('emptyState')?.remove();
  const wrap = el('div', `msg ${role}`);
  wrap.append(el('div', 'role', role));
  const body = el('div', 'body');
  if (role === 'assistant') body.append(renderMarkdown(text || ''));
  else body.textContent = redactCredentials(text || '');
  wrap.append(body);
  if (extras) wrap.append(extras);
  $('messages').append(wrap);
  scrollDown();
  return body;
}

function beginAssistant() {
  $('emptyState')?.remove();
  const wrap = el('div', 'msg assistant');
  wrap.append(el('div', 'role', 'assistant'));

  const think = el('details', 'think');
  think.hidden = true;
  think.append(el('summary', null, 'reasoning'), el('div', 'think-body'));

  const body = el('div', 'body');
  const meta = el('div', 'msg-meta');
  meta.hidden = true;
  wrap.append(think, body, meta);
  $('messages').append(wrap);

  state.streaming = {
    raw: '',
    bodyEl: body,
    thinkEl: think,
    thinkBody: think.querySelector('.think-body'),
    metaEl: meta,
    frame: 0,
    chars: 0,
    startedAt: null,
  };
  state.lastAssistant = state.streaming;
  scrollDown();
}

/** Re-render the streaming message, coalesced to one repaint per frame. */
function scheduleRender() {
  const s = state.streaming;
  if (!s || s.frame) return;
  s.frame = requestAnimationFrame(() => {
    s.frame = 0;
    s.bodyEl.replaceChildren(renderMarkdown(s.raw));
    scrollDown();
  });
}

/**
 * Bubble for the compaction summary as it streams.
 *
 * The summary condenses everything that came *before* the current prompt, and
 * that is where the saved transcript puts it: compaction replaces the head and
 * the tail it keeps always ends with the prompt that started the turn. Letting
 * it stream into the round's own bubble showed it underneath that prompt --
 * the opposite order -- until `agent_done` reopened the chat and silently
 * moved it. So it gets its own bubble, inserted ahead of the last user
 * message, and the round's answer keeps the one the `round` event made.
 */
function beginCompaction() {
  $('emptyState')?.remove();
  const wrap = el('div', 'msg assistant compaction');
  wrap.append(el('div', 'role', 'compacted context'));

  const think = el('details', 'think');
  think.hidden = true;
  think.append(el('summary', null, 'reasoning'), el('div', 'think-body'));

  const body = el('div', 'body');
  wrap.append(think, body);

  // Ahead of the prompt this turn is answering. No user message on screen
  // (a replay that has not reached it yet) means the end is the right place.
  const users = $('messages').querySelectorAll('.msg.user');
  const anchor = users[users.length - 1];
  if (anchor) $('messages').insertBefore(wrap, anchor);
  else $('messages').append(wrap);

  state.compacting = {
    raw: '',
    bodyEl: body,
    thinkEl: think,
    thinkBody: think.querySelector('.think-body'),
    frame: 0,
  };
  scrollDown();
}

/** Same per-frame coalescing as scheduleRender, for the compaction bubble. */
function scheduleCompactRender() {
  const c = state.compacting;
  if (!c || c.frame) return;
  c.frame = requestAnimationFrame(() => {
    c.frame = 0;
    c.bodyEl.replaceChildren(renderMarkdown(c.raw));
    scrollDown();
  });
}

/** Rough live rate while tokens arrive; replaced by the exact figure on stats. */
function liveRate(s) {
  if (!s?.startedAt || !s.chars) return null;
  const seconds = (Date.now() - s.startedAt) / 1000;
  if (seconds < 0.8) return null;
  return (s.chars / 4) / seconds; // ~4 characters per token
}

function setMeta(target, stats) {
  if (!target?.metaEl) return;
  const bits = [];
  if (stats.tps) bits.push(`${stats.tps.toFixed(1)} tok/s`);
  if (stats.completionTokens) bits.push(`${num(stats.completionTokens)} tok`);
  if (stats.ttftMs != null) bits.push(`${(stats.ttftMs / 1000).toFixed(1)}s to first token`);
  if (stats.promptTps) bits.push(`prefill ${stats.promptTps.toFixed(0)} tok/s`);
  if (!bits.length) return;
  target.metaEl.hidden = false;
  target.metaEl.replaceChildren(...bits.map((b, i) => el('span', i === 0 ? 'rate' : null, b)));
}

// Estimated context pressure for the open session. The server is authoritative
// mid-turn (stats carry promptTokens + contextTokens); when a session is opened
// we estimate from the stored transcript until the next turn lands.
function ctxLimitForUi() {
  if (isLocal()) {
    return chatLocalInstance()?.ctx ?? state.config?.profiles?.[state.config?.activeProfile]?.ctx ?? null;
  }
  // The server resolves this from the endpoint's own catalogue. Only when it
  // could not is the old constant used -- and then the meter says so.
  return chatProvider()?.contextTokens ?? 128000;
}

/** True when nothing authoritative is known and the meter is guessing. */
function ctxLimitIsGuess() {
  return !isLocal() && chatProvider()?.contextTokens == null;
}

function renderCtx(used, limit) {
  if (used != null) state.ctxUsed = used;
  if (limit != null) state.ctxLimit = limit;
  if (state.ctxUsed == null && state.ctxLimit == null) return;
  state.ctxLimit ??= ctxLimitForUi();
  const guess = ctxLimitIsGuess() && state.ctxLimit === ctxLimitForUi();
  $('ctxInfo').textContent = state.ctxUsed == null
    ? ''
    : state.ctxLimit
      ? `${num(state.ctxUsed)} / ${num(state.ctxLimit)} ctx${guess ? ' (assumed)' : ''}`
      : `${num(state.ctxUsed)} ctx (est)`;
  $('ctxInfo').title = guess
    ? 'The endpoint does not publish this model\u2019s window, so Skadi assumes 128k. Set it in Model & provider.'
    : '';
}

function resetCtx() {
  state.ctxUsed = null;
  state.ctxLimit = null;
  $('ctxInfo').textContent = '';
}

// ============================================================================
// Tool calls in the transcript
//
// The calls the agent makes between two of its messages are one piece of work,
// so they are shown as one line -- "Ran 4 commands, created x.mjs, used 2
// tools  +86 -0" -- that opens into a row per call, and each row opens into its
// input and output. Reading a long turn is then reading what was said, not
// scrolling past every command that was run.
// ============================================================================

const TOOL_KIND = {
  run_command: 'command', write_file: 'create', edit_file: 'edit', delete_file: 'delete',
  read_file: 'read', list_dir: 'search', glob: 'search', grep: 'search',
};

const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim())?.trim() || '';
const clipText = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** What a row says: a verb, and the thing it was done to. A file is a link that opens it. */
function toolLabel(name, args) {
  const path = args?.path ? String(args.path) : '';
  switch (name) {
    case 'run_command': return { verb: 'Ran', target: clipText(firstLine(args?.command) || 'a command', 90), mono: true };
    case 'write_file': return { verb: 'Created', file: path };
    case 'edit_file': return { verb: 'Edited', file: path };
    case 'read_file': return { verb: 'Read', file: path };
    case 'delete_file': return { verb: 'Deleted', file: path };
    case 'list_dir': return { verb: 'Listed', target: path || 'the project' };
    case 'glob': return { verb: 'Found files', target: args?.pattern || '' };
    case 'grep': return { verb: 'Searched for', target: clipText(String(args?.pattern ?? ''), 60) };
    case 'browser_open': return { verb: 'Opened a page', target: args?.url || '' };
    case 'browser_screenshot': return { verb: 'Took a screenshot' };
    case 'browser_click': case 'browser_click_at': return { verb: 'Clicked in the page', target: args?.selector || args?.text || '' };
    case 'browser_type': case 'browser_fill': return { verb: 'Typed in the page', target: clipText(String(args?.selector ?? ''), 50) };
    case 'browser_scroll': return { verb: 'Scrolled the page' };
    case 'browser_read': case 'browser_elements': return { verb: 'Read the page' };
    case 'browser_extract': return { verb: 'Extracted page data' };
    case 'browser_console': return { verb: 'Read the browser console' };
    case 'browser_eval': return { verb: 'Ran page script' };
    case 'web_search': return { verb: 'Searched the web', target: args?.query || '' };
    case 'task_log': return { verb: 'Read a task log' };
    case 'task_stop': return { verb: 'Stopped a task' };
    case 'result': return { verb: 'Result' };
    default: {
      const words = String(name).replace(/_/g, ' ');
      return { verb: words.charAt(0).toUpperCase() + words.slice(1) };
    }
  }
}

function setCardOpen(card, open) {
  card.classList.toggle('open', open);
  for (const part of card.querySelectorAll(':scope > .args, :scope > .out')) {
    part.hidden = !open || (part.classList.contains('args') && !part.textContent);
  }
}

function addTool(name, args, result) {
  $('emptyState')?.remove();
  const card = el('div', `tool ${result ? (result.ok ? 'ok' : 'err') : 'pending'}`);
  card.dataset.tool = name;
  card._args = args;

  const label = toolLabel(name, args);
  const head = el('div', 'tool-head');
  head.append(el('span', 'status'));
  const text = el('span', 'tname');
  text.append(el('span', 'tverb', label.verb));
  if (label.file) {
    const link = el('button', 'tool-file', baseName(label.file));
    link.type = 'button';
    link.title = `Open ${label.file}`;
    link.onclick = (e) => { e.stopPropagation(); openFileViewer(label.file, card); };
    text.append(link);
  } else if (label.target) {
    text.append(el('span', `ttarget${label.mono ? ' mono' : ''}`, redactCredentials(String(label.target))));
  }
  head.append(text, el('span', 'tool-stats'));
  const ms = el('span', 'ms', result?.ms != null ? `${result.ms}ms` : '');
  head.append(ms, icon('chevron'));

  // The call as made. A command reads best as the command; the rest as their arguments.
  const argsEl = el('pre', 'args');
  if (name === 'run_command' && args?.command) argsEl.textContent = redactCredentials(`$ ${args.command}`);
  else if (args && Object.keys(args).length && !FILE_TOOLS.has(name)) argsEl.textContent = redactCredentials(JSON.stringify(args, null, 2));
  argsEl.hidden = true;

  const out = el('pre', 'out');
  out.hidden = true;
  if (result) out.textContent = redactCredentials(String(result.content ?? '').slice(0, 8000));

  head.onclick = () => {
    setCardOpen(card, out.hidden);
    scrollDown();
  };

  card.append(head, argsEl, out);
  renderFileChip(card, name, args);
  toolGroupFor().querySelector('.tool-group-body').append(card);
  refreshToolGroup(card);
  scrollDown();
  return card;
}

/** An assistant bubble with nothing in it yet: it does not separate two runs of calls. */
function isEmptyBubble(node) {
  if (!node.classList?.contains('msg') || !node.classList.contains('assistant')) return false;
  if (node.classList.contains('compaction')) return false;
  const think = node.querySelector('.think');
  return !node.querySelector('.body')?.textContent.trim() && (!think || think.hidden);
}

/** The group the next call belongs to: the one that is last on screen, else a new one. */
function toolGroupFor() {
  const box = $('messages');
  let last = box.lastElementChild;
  while (last && (isEmptyBubble(last) || isThoughtBubble(last))) last = last.previousElementSibling;
  if (last?.classList.contains('tool-group')) {
    foldThoughts(last);
    return last;
  }

  const group = el('div', 'tool-group');
  const head = el('button', 'tool-group-head');
  head.type = 'button';
  head.append(el('span', 'status'), el('span', 'tg-summary'), el('span', 'tg-stats'), icon('chevron'));
  const body = el('div', 'tool-group-body');
  body.hidden = true;
  head.onclick = () => setToolGroupOpen(group, body.hidden);
  group.append(head, body);
  box.append(group);
  foldThoughts(group);
  return group;
}

/**
 * Reasoning that led straight to a tool call belongs to that call. A model
 * that thinks before every step used to leave a "reasoning" dropdown between
 * each pair of groups; it now goes into the group's own dropdown, in order,
 * ahead of the call it produced. Only rounds with no answer text are folded --
 * a round that also wrote something keeps its bubble.
 */
function foldThoughts(group) {
  const box = $('messages');
  const body = group.querySelector('.tool-group-body');
  const folded = [];
  // A group that was just made is the last thing on screen, with its reasoning
  // above it; an older one has the new round's bubbles below it.
  const first = group === box.lastElementChild ? group.previousElementSibling : box.lastElementChild;
  for (let node = first; node && node !== group; node = node.previousElementSibling) {
    if (!isEmptyBubble(node) && !isThoughtBubble(node)) break;
    if (isThoughtBubble(node)) folded.unshift(node);
  }
  for (const bubble of folded) {
    const think = bubble.querySelector('.think');
    const meta = bubble.querySelector('.msg-meta');
    think.open = false;
    think.classList.add('in-group');
    body.append(think);
    if (meta && !meta.hidden) body.append(meta);
    bubble.remove();
  }
}

/** An assistant bubble holding nothing but reasoning (and its speed line). */
function isThoughtBubble(node) {
  if (!node.classList?.contains('msg') || !node.classList.contains('assistant')) return false;
  if (node.classList.contains('compaction')) return false;
  const think = node.querySelector('.think');
  return Boolean(think) && !think.hidden && !node.querySelector('.body')?.textContent.trim();
}

function setToolGroupOpen(group, open) {
  group.classList.toggle('open', open);
  group.querySelector('.tool-group-body').hidden = !open;
  scrollDown();
}

/** "Ran 4 commands, created a.mjs, used 2 tools" -- what the calls in a group add up to. */
function summariseCalls(cards) {
  const by = { command: 0, create: [], edit: [], delete: [], read: [], search: 0, other: 0 };
  for (const card of cards) {
    const kind = TOOL_KIND[card.dataset.tool];
    const path = card._args?.path ? String(card._args.path) : null;
    if (kind === 'command' || kind === 'search') by[kind] += 1;
    else if (kind) { if (!by[kind].includes(path)) by[kind].push(path); }
    else by.other += 1;
  }
  const files = (verb, list) => {
    if (!list.length) return null;
    return list.length === 1 ? `${verb} ${baseName(list[0] || 'a file')}` : `${verb} ${list.length} files`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    by.command ? `ran ${plural(by.command, 'command', 'commands')}` : null,
    files('created', by.create),
    files('edited', by.edit),
    files('deleted', by.delete),
    files('read', by.read),
    by.search ? `ran ${plural(by.search, 'search', 'searches')}` : null,
    by.other ? `used ${plural(by.other, 'tool', 'tools')}` : null,
  ].filter(Boolean);
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Re-say what a group holds. Called whenever a call in it is added or finishes. */
function refreshToolGroup(card) {
  const group = card.closest('.tool-group');
  if (!group) return;
  const cards = [...group.querySelectorAll('.tool')];
  group.querySelector('.tg-summary').textContent = summariseCalls(cards);
  let added = 0;
  let removed = 0;
  let counted = false;
  for (const c of cards) {
    if (c.dataset.tool !== 'edit_file' && c.dataset.tool !== 'write_file') continue;
    const m = STAT_RE.exec(c._full || '');
    if (m) { added += Number(m[1]); removed += Number(m[2]); counted = true; }
  }
  group.querySelector('.tg-stats').replaceChildren(...(counted ? statParts(added, removed) : []));
  group.classList.toggle('pending', cards.some((c) => c.classList.contains('pending')));
  group.classList.toggle('err', cards.some((c) => c.classList.contains('err')));
}

// ============================================================================
// File chips: every read/edit/write shows a clickable file row that opens the
// diff viewer; edits additionally offer Undo while the snapshot is kept.
// Stats come from the [+A -R] marker the tools put on their first line, so
// history replay renders identically without extra fetches.
// ============================================================================

const FILE_TOOLS = new Set(['read_file', 'edit_file', 'write_file', 'delete_file']);
const STAT_RE = /\[\+(\d+) -(\d+)\]/;

const baseName = (p) => String(p).split('/').pop();

/** Added/removed counts as two spans, so removals read red and writes green. */
function statParts(added, removed) {
  const out = [];
  // A zero side is greyed rather than coloured: a red "-0" reads as a removal
  // at a glance when nothing was removed at all.
  if (added != null) out.push(el('span', `stat-add${Number(added) ? '' : ' zero'}`, `+${added}`));
  if (removed != null) out.push(el('span', `stat-del${Number(removed) ? '' : ' zero'}`, `-${removed}`));
  return out;
}

function undoEntryFor(card) {
  const id = card.dataset.callId;
  return id ? state.undo.find((u) => u.callId && u.callId === id) || null : null;
}

function renderFileChip(card, name, args) {
  if (!FILE_TOOLS.has(name) || !args?.path) return;
  card.dataset.path = args.path;
  const row = el('div', 'file-row');
  const chip = el('button', 'file-chip');
  chip.type = 'button';
  chip.title = `Open ${args.path}`;
  chip.append(icon('file'));
  chip.append(el('span', 'file-chip-name', baseName(args.path)));
  chip.append(el('span', 'file-chip-stats', ''));
  chip.onclick = (e) => {
    e.stopPropagation();
    openFileModal(card);
  };
  row.append(chip);
  const undo = el('button', 'btn tiny file-undo', 'Undo');
  undo.hidden = true;
  undo.title = 'Revert this edit';
  undo.onclick = (e) => {
    e.stopPropagation();
    moveEdit(card, 'undo');
  };
  row.append(undo);
  // Undoing no longer discards the edit, so the way back is a button and not
  // a second run of the same work.
  const redo = el('button', 'btn tiny file-redo', 'Redo');
  redo.hidden = true;
  redo.title = 'Apply this edit again';
  redo.onclick = (e) => {
    e.stopPropagation();
    moveEdit(card, 'redo');
  };
  row.append(redo);
  card.append(row);
}

/** Fold a fresh tool result into the chip: stats text, full content for the
 *  modal, and Undo visibility. Called on live results and history replay. */
function updateFileChip(card, result) {
  card._full = String(result?.content ?? '');
  const m = STAT_RE.exec(card._full);
  const parts = m ? statParts(m[1], m[2]) : [];
  card.querySelector('.file-chip-stats')?.replaceChildren(...parts);
  // The same figures on the row itself, so they read without opening it.
  if (FILE_TOOLS.has(card.dataset.tool) && card.dataset.tool !== 'read_file') {
    card.querySelector('.tool-stats')?.replaceChildren(...statParts(m?.[1], m?.[2]).filter(() => m));
  }
  refreshToolGroup(card);
  refreshUndoButtons();
}

function refreshUndoButtons() {
  for (const card of document.querySelectorAll('.tool[data-call-id]')) {
    const entry = undoEntryFor(card);
    // An edit whose copy was dropped for size shows neither button: there is
    // nothing to put back, and offering it would only raise an error.
    const reversible = entry && !entry.truncated;
    const undo = card.querySelector('.file-undo');
    const redo = card.querySelector('.file-redo');
    if (undo) undo.hidden = !reversible || entry.undone;
    if (redo) redo.hidden = !reversible || !entry.undone;
    const chip = card.querySelector('.file-chip');
    if (chip && entry) chip.classList.toggle('undone', Boolean(entry.undone));
  }
  renderChatChanges();
}

/** Paint `text` into `target` as highlighted spans, newlines and all. */
function paintCode(target, text, lang) {
  target.replaceChildren();
  const lines = highlightLines(text, lang);
  lines.forEach((tokens, i) => {
    if (i > 0) target.append(document.createTextNode('\n'));
    paintLine(target, tokens);
  });
  return target;
}

/**
 * A file listing with a gutter. read_file hands back "  123\tsource", so the
 * numbers are lifted out of the text into their own column -- they stop being
 * something to read past, and copying a line no longer drags its number along.
 */
function renderSourceLines(container, text, lang) {
  container.replaceChildren();
  const raw = String(text ?? '').split('\n');
  const numbered = raw.filter((l) => /^\s*\d+\t/.test(l)).length > raw.length * 0.6;
  const numbers = numbered ? raw.map((l) => (/^\s*(\d+)\t/.exec(l) || [])[1] || '') : null;
  const body = numbered ? raw.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n') : String(text ?? '');
  const lines = highlightLines(body, lang);
  const box = el('div', `cd${numbered ? ' numbered' : ''}`);
  lines.forEach((tokens, i) => {
    const row = el('div', 'cd-line');
    if (numbered) row.append(el('span', 'cd-num', numbers[i] ?? ''));
    const src = el('span', 'cd-src');
    paintLine(src, tokens);
    row.append(src);
    box.append(row);
  });
  container.append(box);
  return box;
}

function extractDiff(content) {
  const m = /```diff\n([\s\S]*?)(?:\n```|$)/.exec(String(content ?? ''));
  return m ? m[1].replace(/\n$/, '') : null;
}

/**
 * Render unified-diff text into coloured rows (hunk headers, +/-/context).
 * The code inside a row is syntax-highlighted too, with the +/- marker in its
 * own column so the tint says added-or-removed and the colours say what the
 * line actually is -- the way a diff reads in an editor.
 *
 * Each row is highlighted on its own: a hunk is a fragment, so carrying string
 * or comment state across the gaps between hunks would only mislead.
 */
function renderDiffLines(container, text, lang = 'text') {
  container.replaceChildren();
  const lines = String(text).split('\n').slice(0, 3000);
  for (const line of lines) {
    let cls = 'df-ctx';
    let marker = '';
    let body = line;
    if (line.startsWith('@@')) cls = 'df-hunk';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) cls = 'df-file';
    else if (line.startsWith('+')) { cls = 'df-add'; marker = '+'; body = line.slice(1); }
    else if (line.startsWith('-')) { cls = 'df-del'; marker = '-'; body = line.slice(1); }
    else if (line.startsWith(' ')) { marker = ' '; body = line.slice(1); }

    const row = el('div', `df-line ${cls}`);
    if (cls === 'df-hunk' || cls === 'df-file') {
      row.textContent = line || ' ';
    } else {
      row.append(el('span', 'df-mark', marker || ' '));
      const src = el('span', 'df-src');
      paintLine(src, highlightLines(body, lang)[0] || []);
      row.append(src);
    }
    container.append(row);
  }
  if (String(text).split('\n').length > 3000) {
    container.append(el('div', 'df-line df-hunk', '... [rendering truncated]'));
  }
}

let fileModalCallId = null;
let fileModalPath = null;

// ============================================================================
// Image lightbox
//
// The app is a bare WebView2 window, so window.open() has nowhere to go: a
// click on a photo did nothing. Any image the chat shows -- a sent photo, a
// staged attachment, a browser screenshot -- opens full size in a popup here.
// One delegated listener covers all of them, including ones drawn later.
// ============================================================================

const ZOOMABLE = 'img.msg-thumb, img.chip-thumb, img.shot-thumb, figure.shot img';
let lightboxEl = null;

function openLightbox(src, alt = '') {
  closeLightbox();
  const veil = el('div', 'lightbox');
  veil.setAttribute('role', 'dialog');
  veil.setAttribute('aria-modal', 'true');
  veil.setAttribute('aria-label', 'Image preview');
  const img = el('img', 'lightbox-img');
  img.src = src;
  img.alt = alt;
  const close = el('button', 'icon-btn lightbox-close');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close');
  close.append(icon('x'));
  close.onclick = closeLightbox;
  // Clicking the dimmed backdrop closes; clicking the picture itself does not.
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) closeLightbox(); });
  veil.append(img, close);
  document.body.append(veil);
  lightboxEl = veil;
  close.focus();
}

function closeLightbox() {
  lightboxEl?.remove();
  lightboxEl = null;
}

document.addEventListener('click', (e) => {
  const img = e.target instanceof Element ? e.target.closest(ZOOMABLE) : null;
  if (img?.src) openLightbox(img.src, img.alt);
});
// Capture phase, so Escape closes the preview and not the dialog behind it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !lightboxEl) return;
  e.stopImmediatePropagation();
  closeLightbox();
}, true);

// ============================================================================
// File viewer
//
// A file opened from the chat or the Files tab is read whole from the project,
// not from whatever slice a tool happened to return. Files stay open as tabs;
// one that was edited in this chat also offers what that edit changed.
// ============================================================================

const viewer = { tabs: [], active: null, project: null };

/** Open a file, in full. `card` is the tool call it came from, when it came from one. */
async function openFileViewer(path, card = null) {
  if (!path) return;
  selectWorkspaceTool?.('files');
  // Tabs belong to a project: another project's files are not what was open.
  if (viewer.project !== state.activeProject) {
    viewer.tabs = [];
    viewer.project = state.activeProject;
  }
  let tab = viewer.tabs.find((t) => t.path === path);
  if (!tab) {
    tab = { path, card: null, mode: 'file', file: null, error: null, loading: false };
    viewer.tabs.push(tab);
  }
  if (card) tab.card = card;
  tab.mode = 'file';
  activateViewerTab(tab);
  $('fileHost').hidden = false;
  $('fileViewerGutter').hidden = false;
  $('fileVeil').hidden = false;
  await loadViewerFile(tab);
}

/** Older name, still what a file chip calls. */
function openFileModal(card) {
  return openFileViewer(card.dataset.path, card);
}

function activateViewerTab(tab) {
  viewer.active = tab;
  fileModalCallId = tab.card?.dataset.callId || null;
  fileModalPath = tab.path;
  renderViewer();
}

async function loadViewerFile(tab) {
  tab.loading = true;
  tab.error = null;
  if (viewer.active === tab) renderViewer();
  try {
    tab.file = await api(`fs/file?path=${encodeURIComponent(tab.path)}`);
  } catch (err) {
    tab.file = null;
    tab.error = err.message;
  }
  tab.loading = false;
  if (viewer.active === tab) renderViewer();
}

function closeViewerTab(tab) {
  const i = viewer.tabs.indexOf(tab);
  if (i < 0) return;
  viewer.tabs.splice(i, 1);
  if (viewer.active !== tab) { renderViewer(); return; }
  const next = viewer.tabs[i] || viewer.tabs[i - 1];
  if (next) activateViewerTab(next);
  else { viewer.active = null; closeFileModal(); }
}

const MAX_VIEW_LINES = 8000;

function renderViewer() {
  const tab = viewer.active;
  if (!tab) return;

  const tabs = $('fileTabs');
  tabs.replaceChildren(...viewer.tabs.map((t) => {
    const button = el('div', `file-tab${t === tab ? ' active' : ''}`);
    button.setAttribute('role', 'tab');
    button.title = t.path;
    const name = el('button', 'file-tab-name', baseName(t.path));
    name.type = 'button';
    name.onclick = () => { activateViewerTab(t); if (!t.file && !t.loading) loadViewerFile(t); };
    const close = el('button', 'icon-btn file-tab-close');
    close.type = 'button';
    close.title = 'Close this file';
    close.setAttribute('aria-label', `Close ${baseName(t.path)}`);
    close.append(icon('x'));
    close.onclick = () => closeViewerTab(t);
    button.append(name, close);
    return button;
  }));
  tabs.hidden = viewer.tabs.length < 2;

  $('fileTitle').textContent = baseName(tab.path);
  $('fileTitle').title = tab.path;
  $('filePath').textContent = tab.path;
  const lang = languageFor(tab.path);
  $('fileLang').textContent = lang === 'text' ? '' : lang;
  const m = STAT_RE.exec(tab.card?._full || '');
  $('fileStats').replaceChildren(...(m ? statParts(m[1], m[2]) : []));

  // What this chat changed in the file, when it changed it: a second way to look at it.
  const diff = tab.card ? extractDiff(tab.card._full || '') : null;
  if (tab.mode === 'diff' && !diff) tab.mode = 'file';
  $('fileMode').hidden = !diff;
  for (const b of $('fileMode').querySelectorAll('[data-mode]')) {
    const on = b.dataset.mode === tab.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }

  const body = $('fileBody');
  body.scrollTop = 0;
  if (tab.mode === 'diff') {
    renderDiffLines(body, diff, lang);
  } else if (tab.file?.image) {
    const img = el('img', 'file-image');
    img.src = tab.file.image;
    img.alt = tab.path;
    body.replaceChildren(img);
  } else if (tab.file?.binary) {
    body.replaceChildren(el('p', 'hint', `This is a binary file (${kb(tab.file.size)}), so there is nothing to show.`));
  } else if (tab.file) {
    const text = tab.file.content.replace(/\n$/, '');
    const lines = text.split('\n');
    const shown = lines.slice(0, MAX_VIEW_LINES);
    renderSourceLines(body, shown.map((l, i) => `${i + 1}\t${l}`).join('\n'), lang);
    if (lines.length > shown.length || tab.file.truncated) {
      body.append(el('p', 'hint', `Showing the first ${num(shown.length)} lines. Open the location to see the rest.`));
    }
  } else if (tab.loading) {
    body.replaceChildren(el('p', 'hint', 'Loading…'));
  } else {
    // The file is not on disk (deleted, or outside the project): fall back to
    // what the tool call reported, and say why.
    body.replaceChildren(el('p', 'hint', tab.error || 'This file could not be read.'));
    if (tab.card?._full) renderSourceLines(body.appendChild(el('div')), tab.card._full, lang);
  }
  syncFileModalButtons();
}

/** The viewer offers whichever way the open edit can still be moved. */
function syncFileModalButtons() {
  const entry = fileModalCallId
    ? state.undo.find((u) => u.callId && u.callId === fileModalCallId) || null
    : null;
  const reversible = entry && !entry.truncated;
  $('fileUndo').hidden = !reversible || entry.undone;
  $('fileRedo').hidden = !reversible || !entry.undone;
}

function closeFileModal() {
  $('fileVeil').hidden = true;
  $('fileHost').hidden = true;
  $('fileViewerGutter').hidden = true;
  fileModalCallId = null;
  fileModalPath = null;
}

$('fileMode').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  if (!mode || !viewer.active) return;
  viewer.active.mode = mode;
  renderViewer();
});

/** Undo or redo one edit. The server answers with the whole history and the
 *  bar's figures, so nothing here has to guess what the other edits now are. */
async function moveEdit(card, direction) {
  const entry = undoEntryFor(card);
  if (!entry || !state.sessionId) return;
  try {
    const res = await api(`edit/${direction}`, { sessionId: state.sessionId, callId: entry.callId });
    applyEditState(res);
    if (fileModalCallId === entry.callId) syncFileModalButtons();
    // Whatever the viewer shows of that file is now out of date.
    const open = viewer.tabs.find((t) => t.path === entry.path);
    if (open) loadViewerFile(open);
    addMessage('assistant', direction === 'undo'
      ? `Reverted **${entry.path}** to its state before that edit.`
      : `Reapplied the edit to **${entry.path}**.`);
  } catch (err) {
    addMessage('error', err.message);
  }
}

/** Fold a server answer carrying `history` and the bar's counts into state. */
function applyEditState(res) {
  if (Array.isArray(res?.history)) state.undo = res.history;
  state.changes = res && typeof res.applied === 'number' ? res : state.changes;
  refreshUndoButtons();
}

// ---------------------------------------------------------- chat changes ----

/** The bar above the transcript: what this chat has written, and the two
 *  buttons that take all of it back or put all of it back. */
function renderChatChanges() {
  const bar = $('chatChanges');
  if (!bar) return;
  const c = state.changes;
  // No chat open, or a chat that has not written anything: no bar at all.
  if (!state.sessionId || !c || (!c.applied && !c.undone)) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.classList.toggle('all-undone', c.applied === 0);
  const files = `${c.files} file${c.files === 1 ? '' : 's'}`;
  $('chatChangesLabel').textContent = c.applied
    ? `This chat changed ${files}`
    : `This chat's changes are reverted`;
  $('chatChangesStats').replaceChildren(...(c.applied ? statParts(c.added, c.removed) : []));
  const note = $('chatChangesNote');
  const parts = [];
  if (c.undone) parts.push(`${c.undone} reverted`);
  // An edit whose copy was dropped for size is neither revertible nor
  // reappliable; saying so beats a button that only ever errors.
  if (c.stale) parts.push(`${c.stale} too large to reverse`);
  note.textContent = parts.join(' · ');
  note.hidden = !parts.length;
  $('chatChangesRevert').hidden = !c.canRevert;
  $('chatChangesReapply').hidden = !c.canReapply;
}

/** Everything this chat wrote, newest first, as a readable list. */
function changeListText() {
  const rows = [...state.undo].reverse();
  if (!rows.length) return 'This chat has not changed any files.';
  return rows.map((e) => {
    const stats = [e.added != null ? `+${e.added}` : null, e.removed != null ? `-${e.removed}` : null]
      .filter(Boolean).join(' ');
    const mark = e.truncated ? ' — too large to reverse' : e.undone ? ' — reverted' : '';
    return `${e.path}${stats ? `  ${stats}` : ''}${mark}`;
  }).join('\n');
}

/** Revert or reapply every edit in the open chat, behind one confirmation. */
async function moveAllEdits(direction) {
  if (!state.sessionId) return;
  const c = state.changes;
  if (!c) return;
  const reverting = direction === 'revert';
  // Count the edits this run will actually move, and the files they sit in.
  // The bar's own file count is of applied edits only, which is zero exactly
  // when Reapply is the button being pressed.
  const moving = state.undo.filter((e) => !e.truncated && (reverting ? !e.undone : e.undone));
  const count = moving.length;
  const fileCount = new Set(moving.map((e) => e.path)).size;
  const lines = [
    reverting
      ? `Put every file this chat changed back as it was before it started?`
      : `Apply every reverted edit in this chat again?`,
    '',
    `${count} edit${count === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}:`,
    changeListText(),
  ];
  if (c.stale) lines.push('', `${c.stale} edit(s) were too large to keep a copy of. Nothing will be changed until they are the only ones left.`);
  lines.push('', 'Either all of them are applied or none are — if any file cannot be written, every file is put back as it was.');
  if (!await askConfirm(lines.join('\n'), {
    title: reverting ? 'Revert all changes' : 'Reapply all changes',
    ok: reverting ? 'Revert all' : 'Reapply all',
    danger: reverting,
  })) return;
  const button = $(reverting ? 'chatChangesRevert' : 'chatChangesReapply');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = reverting ? 'Reverting…' : 'Reapplying…';
  try {
    const res = await api(`session/changes/${reverting ? 'revert' : 'reapply'}`, {
      sessionId: state.sessionId,
      confirm: reverting ? 'REVERT ALL' : 'REAPPLY ALL',
    });
    applyEditState(res);
    syncFileModalButtons();
    addMessage('assistant', reverting
      ? `Reverted ${res.count} edit(s) across ${res.paths.length} file(s). The files are back as they were before this chat started.`
      : `Reapplied ${res.count} edit(s) across ${res.paths.length} file(s).`);
  } catch (err) {
    addMessage('error', err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function wireChatChanges() {
  $('chatChangesOpen').onclick = () => {
    askConfirm(changeListText(), { title: 'Changes in this chat', ok: 'Done', danger: false });
  };
  $('chatChangesRevert').onclick = guard(() => moveAllEdits('revert'));
  $('chatChangesReapply').onclick = guard(() => moveAllEdits('reapply'));
}

// ============================================================================
// Background tasks: inspector panel, composer pill, completion toasts.
// The server pushes task_update/task_done over SSE; this only renders.
// ============================================================================

let toastTimer = 0;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

// ============================================================================
// Per-chat execution plan. The server owns ordering and revision numbers; this
// renderer replaces its local copy after every action, avoiding merge races
// between the user and an agent that updates progress at the same time.
// ============================================================================

const PLAN_STATUS = [
  ['queued', 'Queued'],
  ['working', 'Working'],
  ['blocked', 'Blocked'],
  ['review', 'Needs review'],
  ['done', 'Done'],
  ['skipped', 'Skipped'],
];

function emptyPlan() {
  return { version: 1, revision: 0, updatedAt: 0, userEdited: false, items: [], deleted: [] };
}

function acceptPlan(plan, { announce = false } = {}) {
  state.plan = plan && Array.isArray(plan.items) ? plan : emptyPlan();
  renderPlan();
  if (announce) {
    const current = state.plan.items.find((item) => item.status === 'working');
    $('planLive').textContent = current ? `Plan updated. Working on ${current.text}` : 'Plan updated.';
  }
}

async function planAction(action, extra = {}) {
  if (!state.sessionId) throw new Error('Send the first message before editing its plan.');
  const { plan } = await api('session/plan', { id: state.sessionId, action, ...extra });
  acceptPlan(plan);
  return plan;
}

function planIconButton(name, label, onClick, disabled = false) {
  const button = el('button', 'icon-btn plan-action');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  const glyph = icon(name);
  glyph.setAttribute('aria-hidden', 'true');
  button.append(glyph);
  button.onclick = guard(onClick);
  return button;
}

let draggedPlanItem = null;

function renderPlan() {
  const plan = state.plan || emptyPlan();
  const list = $('planList');
  if (!list) return;
  const open = plan.items.filter((item) => !['done', 'skipped'].includes(item.status));
  const done = plan.items.filter((item) => item.status === 'done').length;
  const working = plan.items.find((item) => item.status === 'working');
  $('planSummary').textContent = plan.items.length
    ? `${done} of ${plan.items.length} complete${open.length ? ` · ${open.length} open` : ''}`
    : 'The agent will create a plan for substantial work.';
  $('planAdd').disabled = !state.sessionId;
  $('planAdd').title = state.sessionId ? 'Insert a new step' : 'Send the first message before adding steps';

  const tabCount = $('planTabCount');
  tabCount.hidden = open.length === 0;
  tabCount.textContent = String(open.length);
  const planTab = tabCount.closest('[data-tool]');
  if (planTab) planTab.setAttribute('aria-label', open.length ? `Plan, ${open.length} open steps` : 'Plan');

  if (!plan.items.length) {
    list.replaceChildren();
    const empty = el('li', 'plan-empty');
    empty.append(
      icon('list'),
      el('strong', null, state.sessionId ? 'No plan yet' : 'Start a chat first'),
      el('span', null, state.sessionId
        ? 'For medium and hard work, the agent creates a plan before broad exploration. You can also add the first step.'
        : 'A plan is saved with each chat and appears here as work begins.'),
    );
    list.append(empty);
  } else {
    const rows = plan.items.map((item, index) => {
      const row = el('li', `plan-item status-${item.status}`);
      row.dataset.planId = item.id;
      const grip = el('span', 'plan-grip');
      grip.title = 'Drag to reorder';
      grip.setAttribute('aria-hidden', 'true');
      grip.draggable = true;
      grip.append(icon('list'));
      grip.addEventListener('dragstart', (event) => {
        draggedPlanItem = item.id;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
      });
      grip.addEventListener('dragend', () => {
        draggedPlanItem = null;
        row.classList.remove('dragging');
      });
      row.addEventListener('dragover', (event) => {
        if (!draggedPlanItem || draggedPlanItem === item.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', guard(async (event) => {
        event.preventDefault();
        row.classList.remove('drop-target');
        if (!draggedPlanItem || draggedPlanItem === item.id) return;
        await planAction('move', { itemId: draggedPlanItem, index });
      }));

      const body = el('div', 'plan-item-body');
      const input = el('input', 'plan-text');
      input.type = 'text';
      input.value = item.text;
      input.maxLength = 240;
      input.setAttribute('aria-label', `Step ${index + 1}`);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        if (event.key === 'Escape') { input.value = item.text; input.blur(); }
      });
      input.addEventListener('blur', guard(async () => {
        const text = input.value.trim();
        if (!text) { input.value = item.text; return; }
        if (text !== item.text) await planAction('edit', { itemId: item.id, text });
      }));

      const meta = el('div', 'plan-item-meta');
      const status = el('select', 'plan-status');
      status.setAttribute('aria-label', `Status for ${item.text}`);
      for (const [value, label] of PLAN_STATUS) {
        const option = el('option', null, label);
        option.value = value;
        option.selected = item.status === value;
        status.append(option);
      }
      status.onchange = guard(() => planAction('status', { itemId: item.id, status: status.value }));
      meta.append(status);
      if (item.note) {
        const note = el('span', 'plan-note', item.note);
        note.title = item.note;
        meta.append(note);
      }
      body.append(input, meta);

      const actions = el('div', 'plan-actions');
      const up = planIconButton('chevron', `Move ${item.text} up`, () => planAction('move', { itemId: item.id, index: index - 1 }), index === 0);
      up.classList.add('move-up');
      const down = planIconButton('chevron', `Move ${item.text} down`, () => planAction('move', { itemId: item.id, index: index + 1 }), index === plan.items.length - 1);
      const remove = planIconButton('trash', `Delete ${item.text}`, () => planAction('remove', { itemId: item.id }));
      remove.classList.add('danger-icon');
      actions.append(up, down, remove);
      row.append(grip, body, actions);
      return row;
    });
    list.replaceChildren(...rows);
  }

  const deleted = plan.deleted?.[0];
  $('planUndo').hidden = !deleted;
  if (deleted) $('planUndoText').textContent = `Deleted “${deleted.item.text}”.`;
  $('planLive').textContent = working ? `Working: ${working.text}` : '';
}

function wirePlan() {
  $('planAdd').onclick = guard(async () => {
    const before = new Set(state.plan.items.map((item) => item.id));
    const plan = await planAction('add', { text: 'New step' });
    const added = plan.items.find((item) => !before.has(item.id));
    requestAnimationFrame(() => {
      const input = document.querySelector(`[data-plan-id="${CSS.escape(added?.id || '')}"] .plan-text`);
      input?.focus();
      input?.select();
    });
  });
  $('planUndoButton').onclick = guard(() => planAction('restore', {}));
  renderPlan();
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

async function refreshTasks() {
  try {
    state.tasks = await api('tasks');
  } catch {
    state.tasks = [];
  }
  renderTasks();
  renderTaskPill();
}

function taskCard(t) {
  const card = el('div', 'task');
  const head = el('div', 'task-head');
  head.append(el('span', `task-dot ${t.status}`));
  head.append(el('div', 'task-name', t.command));
  if (t.status === 'running') {
    const stop = el('button', 'icon-btn');
    stop.title = 'Stop this task';
    stop.append(icon('stop'));
    stop.onclick = async () => {
      try {
        await api('task/stop', { task_id: t.id });
        await refreshTasks();
      } catch (err) { addMessage('error', err.message); }
    };
    head.append(stop);
  }
  card.append(head);

  const meta = el('div', 'task-meta');
  if (t.status === 'running') {
    const elapsed = el('span', 'task-elapsed', '…');
    elapsed.dataset.runningSince = String(t.startedAt);
    meta.append(elapsed, el('span', null, t.shell === 'cmd' ? 'cmd' : 'pwsh'));
  } else {
    meta.append(el('span', t.exitCode === 0 ? 'task-ok' : 'task-bad',
      t.exitCode === 0 ? 'Completed' : (t.exitCode == null ? 'Stopped' : `exit ${t.exitCode}`)));
    meta.append(el('span', null, fmtDur((t.finishedAt ?? t.startedAt) - t.startedAt)));
  }
  card.append(meta);

  const tail = (t.tail || '').trim();
  if (tail) {
    const pre = el('pre', 'task-tail', tail.length > 900 ? `…${tail.slice(-900)}` : tail);
    card.append(pre);
  }
  return card;
}

function renderTasks() {
  const box = $('taskList');
  if (!box) return;
  box.replaceChildren();
  const running = state.tasks.filter((t) => t.status === 'running');
  const done = state.tasks.filter((t) => t.status !== 'running');
  $('taskCount').textContent = running.length || '';
  const tabCount = $('taskTabCount');
  if (tabCount) {
    tabCount.hidden = running.length === 0;
    tabCount.textContent = String(running.length);
    tabCount.closest('[data-tool]')?.setAttribute('aria-label', running.length
      ? `Tasks, ${running.length} running`
      : 'Tasks');
  }
  if (!state.tasks.length) {
    box.append(el('p', 'hint', 'No background tasks. Long builds started with background:true stream here.'));
    return;
  }
  if (running.length) {
    box.append(el('div', 'task-section', `Running (${running.length})`));
    for (const t of running) box.append(taskCard(t));
  }
  if (done.length) {
    const head = el('div', 'task-section-row');
    head.append(el('div', 'task-section', `Finished ${done.length}`));
    const clear = el('button', 'icon-btn');
    clear.title = 'Clear finished tasks';
    clear.append(icon('trash'));
    clear.onclick = async () => {
      await api('tasks/clear', {}).catch((err) => addMessage('error', err.message));
      await refreshTasks();
    };
    head.append(clear);
    box.append(head);
    for (const t of done.slice(0, 6)) box.append(taskCard(t));
  }
}

function renderTaskPill() {
  const n = state.tasks.filter((t) => t.status === 'running').length;
  const pill = $('taskPill');
  pill.hidden = n === 0;
  pill.textContent = n === 1 ? '● 1 running task' : `● ${n} running tasks`;
}

function wireTasks() {
  $('taskPill').onclick = () => {
    selectWorkspaceTool?.('tasks');
    const panel = $('tasksPanel');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    panel.classList.remove('flash');
    void panel.offsetWidth;
    panel.classList.add('flash');
  };
  setInterval(() => {
    const now = Date.now();
    for (const n of document.querySelectorAll('[data-running-since]')) {
      n.textContent = fmtDur(now - Number(n.dataset.runningSince));
    }
    if (isBusy()) renderTurnStatus();
  }, 1000);
}

// ============================================================================
// Working-tree changes modal: branch → working tree, file list plus hunks.
// Opened from the topbar; purely a viewer, it never touches git state.
// ============================================================================

// One project's working tree, Codex-style: every changed file is a row that
// opens into its own diff. Small change sets open straight away; a big one
// stays collapsed, because rendering forty diffs at once helps nobody.
let changesProject = null;      // project id being reviewed
let changesFiles = [];          // rows from git/status
const changesOpen = new Set();  // paths currently expanded
const changesDiffs = new Map(); // path -> diff text, for this load
let changesQuery = '';

const AUTO_EXPAND_FILES = 4;
const AUTO_EXPAND_LINES = 400;
const EXPAND_ALL_LIMIT = 25;

function splitPath(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

/** The file glyph, tinted by what happened to the file. */
function changeIcon(f) {
  const code = `${f.index}${f.worktree}`;
  const kind = code.includes('D') ? 'del' : code.includes('?') || code.includes('A') ? 'new' : 'mod';
  const glyph = icon('file');
  glyph.classList.add('review-file-icon', kind);
  return glyph;
}

async function openChanges(path = null) {
  changesProject = state.activeProject;
  changesOpen.clear();
  changesQuery = '';
  $('changesSearch').value = '';
  $('changesSearchRow').hidden = true;
  if (path) changesOpen.add(path);
  $('changesVeil').hidden = false;
  await loadChanges({ auto: !path });
}

function closeChanges() {
  $('changesVeil').hidden = true;
  changesOpen.clear();
  changesDiffs.clear();
}

function renderChangesProjects() {
  const select = $('changesProject');
  select.replaceChildren(...state.projects.map((p) => {
    const option = el('option', null, p.name);
    option.value = p.id;
    return option;
  }));
  if (changesProject) select.value = changesProject;
  select.hidden = state.projects.length < 2;
}

async function loadChanges({ auto = false } = {}) {
  const box = $('changesFiles');
  box.replaceChildren(el('p', 'hint', 'Loading…'));
  $('changesNote').hidden = true;
  changesDiffs.clear();
  renderChangesProjects();
  let st;
  try {
    st = await api(`git/status${changesProject ? `?project=${encodeURIComponent(changesProject)}` : ''}`);
  } catch (err) {
    box.replaceChildren(el('p', 'hint', err.message));
    return;
  }
  changesFiles = st.files || [];
  const where = st.project?.name ? `${st.project.name} · ` : '';
  if (!st.isRepo) {
    $('changesTitle').textContent = 'Working tree';
    box.replaceChildren(el('p', 'hint', `${where}This project is not a git repository.`));
    return;
  }
  $('changesTitle').textContent = `${st.branch} → working tree`;
  if (!changesFiles.length) {
    box.replaceChildren(el('p', 'hint', `${where}Clean — nothing to show.`));
    return;
  }
  if (auto) {
    const lines = changesFiles.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
    if (changesFiles.length <= AUTO_EXPAND_FILES && lines <= AUTO_EXPAND_LINES) {
      for (const f of changesFiles) changesOpen.add(f.path);
    }
  }
  renderChangesList(st.truncated);
}

function renderChangesList(truncated = false) {
  const box = $('changesFiles');
  const q = changesQuery.trim().toLowerCase();
  const rows = changesFiles.filter((f) => !q || f.path.toLowerCase().includes(q));
  $('changesNote').hidden = !changesFiles.length || changesOpen.size === changesFiles.length;
  syncChangesToggle();
  if (!rows.length) {
    box.replaceChildren(el('p', 'hint', 'No changed file matches.'));
    return;
  }
  box.replaceChildren(...rows.map(changeRow));
  if (truncated) box.append(el('p', 'hint', 'Only the first files are listed.'));
}

function changeRow(f) {
  const { dir, name } = splitPath(f.path);
  const open = changesOpen.has(f.path);
  const item = el('div', `review-file${open ? ' open' : ''}`);
  const head = el('button', 'review-file-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.title = f.path;
  const stats = el('span', 'change-stats');
  if (f.added == null && f.removed == null) stats.append(el('span', 'stat-flat', f.index === '?' ? 'new' : 'binary'));
  else stats.append(...statParts(f.added, f.removed));
  head.append(icon('chevron'), changeIcon(f), el('span', 'review-file-name', name));
  if (dir) head.append(el('span', 'review-file-dir', dir));
  head.append(stats);
  head.onclick = () => {
    if (changesOpen.has(f.path)) changesOpen.delete(f.path);
    else changesOpen.add(f.path);
    const now = changesOpen.has(f.path);
    item.classList.toggle('open', now);
    head.setAttribute('aria-expanded', String(now));
    if (now) fillChangeBody(item, f); else item.querySelector('.review-file-body')?.remove();
    $('changesNote').hidden = changesOpen.size === changesFiles.length;
    syncChangesToggle();
  };
  item.append(head);
  if (open) fillChangeBody(item, f);
  return item;
}

async function fillChangeBody(item, f) {
  item.querySelector('.review-file-body')?.remove();
  const body = el('div', 'diff-body review-file-body');
  item.append(body);
  body.append(el('p', 'hint', 'Loading…'));
  try {
    if (!changesDiffs.has(f.path)) {
      const q = `path=${encodeURIComponent(f.path)}${changesProject ? `&project=${encodeURIComponent(changesProject)}` : ''}`;
      changesDiffs.set(f.path, (await api(`git/diff?${q}`)).diff || '');
    }
    const diff = changesDiffs.get(f.path);
    if (!diff.trim()) body.replaceChildren(el('p', 'hint', 'No textual diff (binary or empty file).'));
    // The row already names the file; drop git's header (diff --git, index, ---/+++).
    else renderDiffLines(body, diff.slice(Math.max(0, diff.indexOf('\n@@') + 1)), languageFor(f.path));
  } catch (err) {
    body.replaceChildren(el('p', 'hint', err.message));
  }
}

function syncChangesToggle() {
  const btn = $('changesToggleAll');
  btn.title = changesOpen.size ? 'Collapse all' : 'Expand all';
  btn.setAttribute('aria-label', btn.title);
}

function toggleAllChanges() {
  if (changesOpen.size) changesOpen.clear();
  else for (const f of changesFiles.slice(0, EXPAND_ALL_LIMIT)) changesOpen.add(f.path);
  renderChangesList();
}

function wireOverlays() {
  $('btnChanges').onclick = () => selectWorkspaceTool?.('review');
  $('changesClose').onclick = closeChanges;
  $('changesRefresh').onclick = () => loadChanges();
  $('changesToggleAll').onclick = toggleAllChanges;
  $('changesProject').onchange = () => {
    changesProject = $('changesProject').value;
    changesOpen.clear();
    loadChanges({ auto: true });
  };
  $('changesSearchToggle').onclick = () => {
    const row = $('changesSearchRow');
    row.hidden = !row.hidden;
    if (row.hidden) { changesQuery = ''; $('changesSearch').value = ''; renderChangesList(); } else $('changesSearch').focus();
  };
  $('changesSearch').oninput = () => { changesQuery = $('changesSearch').value; renderChangesList(); };
  $('changesVeil').addEventListener('mousedown', (e) => {
    if (e.target === $('changesVeil')) closeChanges();
  });
  $('fileClose').onclick = closeFileModal;
  $('fileCloseBtn').onclick = closeFileModal;
  $('fileVeil').addEventListener('mousedown', (e) => {
    if (e.target === $('fileVeil')) closeFileModal();
  });
  const modalMove = (direction) => () => {
    const card = [...document.querySelectorAll('.tool')]
      .find((x) => x.dataset.callId === fileModalCallId);
    if (card) moveEdit(card, direction);
  };
  $('fileUndo').onclick = modalMove('undo');
  $('fileRedo').onclick = modalMove('redo');
  $('fileReveal').onclick = guard(async () => {
    if (!fileModalPath) return;
    await api('file/reveal', { path: fileModalPath });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('editorVeil').hidden && $('settingsVeil').hidden && $('promptVeil').hidden
        && $('confirmVeil').hidden) {
      if (!$('fileVeil').hidden) closeFileModal();
      else if (!$('changesVeil').hidden) closeChanges();
    }
  });
}

/** A screenshot the agent captured, shown inline and in the side strip. */
function addScreenshot(name) {
  $('emptyState')?.remove();
  const src = `/api/shot?name=${encodeURIComponent(name)}`;

  const figure = el('figure', 'shot');
  const img = el('img');
  img.src = src;
  img.alt = 'Page screenshot captured by the agent';
  img.loading = 'lazy';
  figure.append(img, el('figcaption', null, 'browser screenshot'));
  $('messages').append(figure);
  scrollDown();

  const thumb = el('img', 'shot-thumb');
  thumb.src = src;
  thumb.title = 'Open full size';
  $('shotStrip').prepend(thumb);
  while ($('shotStrip').children.length > 6) $('shotStrip').lastChild.remove();
}

// ============================================================================
// Embedded browser
//
// Chromium runs headless; its frames arrive over SSE and are painted into an
// <img>. Mapping a click on that image back to page coordinates is the
// displayed rect scaled into the *current* device viewport, so frames keep
// matching clicks in every mode.
// ============================================================================

function browserPoint(event) {
  const img = $('browserFrame');
  const rect = img.getBoundingClientRect();
  const vp = state.browserViewport || { width: 1280, height: 800 };
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.round((event.clientX - rect.left) * (vp.width / rect.width)),
    y: Math.round((event.clientY - rect.top) * (vp.height / rect.height)),
  };
}

/** Device toggle state from a browser status payload. */
function applyBrowserDevice(s) {
  state.browserDevice = s.device || 'desktop';
  state.browserViewport = s.viewport || { width: 1280, height: 800 };
  const mobile = state.browserDevice === 'mobile';
  $('btnDevice').textContent = mobile ? 'Mobile' : 'Desktop';
  const vp = state.browserViewport;
  $('btnDevice').title =
    `Viewport ${vp.width}×${vp.height} — switch to ${mobile ? 'desktop' : 'mobile'}`;
}

function setBrowserStatus(text, running) {
  $('browserStatus').textContent = text;
  if (running !== undefined) $('browserDot').dataset.state = running ? 'ready' : 'stopped';
}

/**
 * The chat the pane is browsing for. A chat that has been sent in keys on its
 * id; one that has not keys on this window's current draft key, which is what
 * keeps two unsent chats from sharing a browser.
 */
const browserKey = () => state.sessionId || state.draftKey;

/** Every browser call is scoped to the chat that made it. */
const browserApi = (path, body = {}) => api(path, { sessionId: browserKey(), ...body });

/**
 * The read-only browser routes, which are GETs and take their chat in the
 * query string. Going through `browserApi` sent them as POSTs, which matched
 * no route at all: every status and console read 404'd, and the callers'
 * `.catch(() => {})` swallowed it. The pane's URL bar and console stayed
 * empty on every chat switch, which read as the browser not following the
 * chat -- it was following; nothing was ever asked what it was showing.
 */
const browserGet = (path) => api(`${path}?session=${encodeURIComponent(browserKey())}`);

function openBrowserStream() {
  const key = browserKey();
  if (state.browserStream && state.browserStreamKey === key) return;
  closeBrowserStream();
  state.browserStreamKey = key;
  const es = new EventSource(`/api/browser/stream?session=${encodeURIComponent(key)}`);
  state.browserStream = es;

  es.addEventListener('frame', (e) => {
    const { data } = JSON.parse(e.data);
    $('browserFrame').src = `data:image/jpeg;base64,${data}`;
    $('browserEmpty').hidden = true;
  });
  es.addEventListener('console', (e) => addConsoleEntry(JSON.parse(e.data)));
  es.addEventListener('console_history', (e) => setConsoleEntries(JSON.parse(e.data).entries || []));
  es.addEventListener('console_clear', () => setConsoleEntries([]));
  es.addEventListener('error', (e) => {
    try {
      const { error } = JSON.parse(e.data);
      if (error) setBrowserStatus(error, false);
    } catch {
      /* transport-level error; EventSource retries on its own */
    }
  });
}

function closeBrowserStream() {
  state.browserStream?.close();
  state.browserStream = null;
  state.browserStreamKey = null;
}

/**
 * Point the pane at the open chat's browser. Called whenever the chat
 * changes: the frame, the console and the audio controls all belong to one
 * chat, so they are cleared and re-read rather than carried across.
 */
function syncBrowserPane() {
  if (state.browserStreamKey === browserKey()) return;
  $('browserFrame').removeAttribute('src');
  $('browserEmpty').hidden = false;
  setConsoleEntries([]);
  setBrowserStatus('idle', false);
  $('browserUrl').value = '';
  closeBrowserStream();
  if (!isBrowserOpen()) return;
  openBrowserStream();
  browserGet('browser/status')
    .then((s) => {
      applyBrowserStatus(s);
      return browserGet('browser/console');
    })
    .then((c) => setConsoleEntries(c.entries || []))
    .catch(() => {});
}

/** Everything a status payload says, applied to the pane. */
function applyBrowserStatus(s) {
  if (!s) return;
  setBrowserStatus(s.url || (s.running ? 'ready' : 'idle'), s.running);
  if (s.url) $('browserUrl').value = s.url;
  if (s.viewport) applyBrowserDevice(s);
  if (s.volume != null || s.muted != null) {
    applyAudioState({ volume: s.volume ?? state.browserAudio.volume, muted: Boolean(s.muted) });
  }
}

// ---------------------------------------------------------------- page audio

let volSlider; // built below; applyAudioState keeps it in sync

/** Reflect volume/mute in the controls without sending anything back. */
function applyAudioState({ volume, muted }) {
  state.browserAudio = { volume, muted };
  if (volSlider) volSlider.set(Math.round(volume * 100));
  const btn = $('btnMute');
  if (btn) {
    btn.setAttribute('aria-pressed', String(muted));
    btn.classList.toggle('active', muted);
    btn.title = muted ? 'Unmute the page' : 'Mute the page';
    btn.querySelector('use').setAttribute('href', muted || !volume ? '#i-mute' : '#i-volume');
  }
  $('browserVolume')?.classList.toggle('muted', muted || !volume);
}

async function setAudio(patch) {
  applyAudioState({ ...state.browserAudio, ...patch });
  try {
    applyBrowserStatus(await browserApi('browser/audio', patch));
  } catch (err) {
    setBrowserStatus(err.message, false);
  }
}

// -------------------------------------------------------------- page console

const CONSOLE_MAX = 400;

function consoleRow(entry) {
  const level = /error|assert|exception/i.test(entry.level) ? 'error'
    : /warn/i.test(entry.level) ? 'warn' : 'log';
  const row = el('div', `console-row ${level}`);
  row.append(el('span', 'console-level', level));
  row.append(el('span', 'console-text', entry.text || ''));
  if (entry.url) {
    const where = el('span', 'console-where', `${entry.url.split('/').pop()}:${entry.line ?? '?'}`);
    where.title = entry.url;
    row.append(where);
  }
  return row;
}

function consoleVisible(entry) {
  return !state.consoleErrorsOnly || /error|warn|assert|exception/i.test(entry.level);
}

function renderConsole() {
  const box = $('consoleRows');
  if (!box) return;
  box.replaceChildren(...state.consoleEntries.filter(consoleVisible).map(consoleRow));
  box.scrollTop = box.scrollHeight;
  const count = state.consoleEntries.length;
  const errors = state.consoleEntries.filter((e) => /error|exception/i.test(e.level)).length;
  $('consoleCount').textContent = `${count} line${count === 1 ? '' : 's'}${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`;
  $('btnConsole')?.classList.toggle('has-errors', Boolean(errors));
}

function setConsoleEntries(entries) {
  state.consoleEntries = entries.slice(-CONSOLE_MAX);
  renderConsole();
}

function addConsoleEntry(entry) {
  state.consoleEntries.push(entry);
  if (state.consoleEntries.length > CONSOLE_MAX) state.consoleEntries.shift();
  const box = $('consoleRows');
  if (!box || $('browserConsole').hidden) return renderConsole();
  // Cheap path while the panel is open: append, and keep it pinned to the end.
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (consoleVisible(entry)) box.append(consoleRow(entry));
  while (box.children.length > CONSOLE_MAX) box.firstChild.remove();
  if (atEnd) box.scrollTop = box.scrollHeight;
  const count = state.consoleEntries.length;
  const errors = state.consoleEntries.filter((e) => /error|exception/i.test(e.level)).length;
  $('consoleCount').textContent = `${count} line${count === 1 ? '' : 's'}${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`;
  $('btnConsole')?.classList.toggle('has-errors', Boolean(errors));
}

// ============================================================================
// Docked browser pane
//
// The browser sits beside the chat, Claude-style, instead of replacing it.
// Opening starts the screencast stream; closing stops it so idle panes cost
// nothing. The split width/height persist across restarts.
// ============================================================================

const SPLIT_MIN_W = 300;   // narrowest the browser pane may be dragged
const SPLIT_MIN_CHAT = 300; // narrowest the chat may be squeezed to
const SPLIT_MIN_H = 180;
const SPLIT_W_KEY = 'skadi.browserW';
const SPLIT_H_KEY = 'skadi.browserH';

const isBrowserOpen = () => $('centre')?.classList.contains('browser-open') ?? false;

function setBrowserOpen(open, { focus = false } = {}) {
  const centre = $('centre');
  if (!centre) return;
  if (open && !centre.classList.contains('browser-open')) {
    // First open defaults to ~45% of the centre; afterwards the drag size wins.
    if (!document.documentElement.style.getPropertyValue('--browser-w')) {
      const w = Math.round(centre.getBoundingClientRect().width * 0.45) || 480;
      setSplitWidth(w);
    }
  }
  centre.classList.toggle('browser-open', open);
  $('gutterSplit').hidden = !open;
  const btn = $('btnBrowser');
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-pressed', String(open));
  if (open) {
    openBrowserStream();
    browserGet('browser/status').then(applyBrowserStatus).catch(() => {});
    browserGet('browser/console').then((c) => setConsoleEntries(c.entries || [])).catch(() => {});
    if (focus) $('browserStage').focus({ preventScroll: true });
  } else {
    closeBrowserStream();
  }
}

function splitWidth() {
  const raw = Number(document.documentElement.style.getPropertyValue('--browser-w').replace('px', ''));
  if (Number.isFinite(raw) && raw >= SPLIT_MIN_W) return raw;
  return $('browserView')?.getBoundingClientRect().width || 480;
}

function splitHeight() {
  const raw = Number(document.documentElement.style.getPropertyValue('--browser-h').replace('px', ''));
  if (Number.isFinite(raw) && raw >= SPLIT_MIN_H) return raw;
  return $('browserView')?.getBoundingClientRect().height || 0;
}

function setSplitWidth(px, { save = false } = {}) {
  const centreW = $('centre')?.getBoundingClientRect().width ?? 1200;
  const max = Math.max(SPLIT_MIN_W, centreW - SPLIT_MIN_CHAT);
  const w = Math.min(max, Math.max(SPLIT_MIN_W, Math.round(px)));
  document.documentElement.style.setProperty('--browser-w', `${w}px`);
  if (save) {
    try { localStorage.setItem(SPLIT_W_KEY, String(w)); } catch { /* private mode */ }
  }
  return w;
}

function setSplitHeight(px, { save = false } = {}) {
  const centreH = $('centre')?.getBoundingClientRect().height ?? 800;
  const max = Math.max(SPLIT_MIN_H, centreH - 220);
  const h = Math.min(max, Math.max(SPLIT_MIN_H, Math.round(px)));
  document.documentElement.style.setProperty('--browser-h', `${h}px`);
  if (save) {
    try { localStorage.setItem(SPLIT_H_KEY, String(h)); } catch { /* private mode */ }
  }
  return h;
}

function wireSplitResize() {
  const gutter = $('gutterSplit');
  const centre = $('centre');
  const pane = $('browserView');
  if (!gutter || !centre || !pane) return;

  try {
    const savedW = Number(localStorage.getItem(SPLIT_W_KEY));
    if (savedW >= SPLIT_MIN_W) setSplitWidth(savedW);
    const savedH = Number(localStorage.getItem(SPLIT_H_KEY));
    if (savedH >= SPLIT_MIN_H) setSplitHeight(savedH);
  } catch { /* storage unavailable */ }

  const stacked = () => getComputedStyle(centre).flexDirection === 'column';

  let dragging = false;
  let vertical = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    vertical = stacked();
    startX = e.clientX;
    startY = e.clientY;
    startW = pane.getBoundingClientRect().width;
    startH = pane.getBoundingClientRect().height;
    gutter.classList.add('dragging');
    document.body.classList.add(vertical ? 'resizing-split-v' : 'resizing-rail');
    try { gutter.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    e.preventDefault();
  });

  gutter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // The browser sits right of (or below, when stacked) the divider, so
    // dragging towards it shrinks the pane -- the mirror of the rail gutter.
    if (stacked()) setSplitHeight(startH + (e.clientY - startY));
    else setSplitWidth(startW - (e.clientX - startX));
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.classList.remove('resizing-rail', 'resizing-split-v');
    if (stacked()) setSplitHeight(splitHeight(), { save: true });
    else setSplitWidth(splitWidth(), { save: true });
  };
  gutter.addEventListener('pointerup', endDrag);
  gutter.addEventListener('pointercancel', endDrag);

  gutter.addEventListener('dblclick', () => {
    if (stacked()) {
      document.documentElement.style.removeProperty('--browser-h');
    } else {
      setSplitWidth(centre.getBoundingClientRect().width * 0.45, { save: true });
    }
  });

  gutter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 24 : 8;
    if (stacked()) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setSplitHeight(splitHeight() - step, { save: true }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSplitHeight(splitHeight() + step, { save: true }); }
    } else {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setSplitWidth(splitWidth() + step, { save: true }); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setSplitWidth(splitWidth() - step, { save: true }); }
    }
    if (e.key === 'Home') {
      e.preventDefault();
      if (stacked()) document.documentElement.style.removeProperty('--browser-h');
      else setSplitWidth(SPLIT_MIN_W, { save: true });
    }
  });

  // A shrinking window must not leave the pane wider than the centre allows.
  window.addEventListener('resize', () => {
    if (!isBrowserOpen() || stacked()) return;
    const centreW = centre.getBoundingClientRect().width;
    if (splitWidth() > Math.max(SPLIT_MIN_W, centreW - SPLIT_MIN_CHAT)) {
      setSplitWidth(centreW - SPLIT_MIN_CHAT, { save: true });
    }
  });
}

const sendInput = (payload) => browserApi('browser/input', payload).catch(() => {});

function wireBrowser() {
  const stage = $('browserStage');

  stage.addEventListener('mousedown', (e) => {
    if ($('browserEmpty').hidden === false) return;
    const point = browserPoint(e);
    if (!point) return;
    e.preventDefault();
    stage.focus();
    sendInput({ kind: 'click', ...point, clickCount: e.detail > 1 ? 2 : 1 });
  });

  stage.addEventListener('wheel', (e) => {
    const point = browserPoint(e);
    if (!point) return;
    e.preventDefault();
    sendInput({ kind: 'scroll', ...point, deltaY: e.deltaY, deltaX: e.deltaX });
  }, { passive: false });

  const SPECIAL = new Set([
    'Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  ]);
  stage.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (SPECIAL.has(e.key)) {
      e.preventDefault();
      sendInput({ kind: 'key', key: e.key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      sendInput({ kind: 'text', text: e.key });
    }
  });

  const go = async () => {
    let url = $('browserUrl').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    $('browserUrl').value = url;
    setBrowserStatus('loading…', true);
    setBrowserOpen(true, { focus: true });
    try {
      await browserApi('browser/open', { url });
      setBrowserStatus(url, true);
    } catch (err) {
      setBrowserStatus(err.message, false);
    }
  };

  $('btnOpenUrl').onclick = go;
  $('browserUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
  });

  const nav = (path) => async () => {
    try {
      const { url } = await browserApi(path);
      if (url) $('browserUrl').value = url;
    } catch (err) {
      setBrowserStatus(err.message);
    }
  };
  $('btnBack').onclick = nav('browser/back');
  $('btnForward').onclick = nav('browser/forward');
  $('btnReload').onclick = nav('browser/reload');

  $('btnShot').onclick = async () => {
    try {
      const { name } = await browserApi('browser/shot');
      if (name) addScreenshot(name);
    } catch (err) {
      setBrowserStatus(err.message);
    }
  };

  $('btnDevice').onclick = async () => {
    const btn = $('btnDevice');
    btn.disabled = true;
    try {
      applyBrowserDevice(await browserApi('browser/device', {
        mode: state.browserDevice === 'mobile' ? 'desktop' : 'mobile',
      }));
    } catch (err) {
      setBrowserStatus(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  $('btnCloseBrowser').onclick = async () => {
    setBrowserOpen(false);
    await browserApi('browser/close').catch(() => {});
    $('browserFrame').removeAttribute('src');
    $('browserEmpty').hidden = false;
    setConsoleEntries([]);
    setBrowserStatus('idle', false);
  };

  $('btnBrowser').onclick = () => setBrowserOpen(!isBrowserOpen(), { focus: true });

  // ---- page audio ---------------------------------------------------------
  $('btnMute').onclick = () => setAudio({ muted: !state.browserAudio.muted });
  volSlider = makeSlider({
    min: 0,
    max: 100,
    step: 1,
    value: Math.round(state.browserAudio.volume * 100),
    label: 'Page volume',
    compact: true,
    onInput: (v) => {
      const volume = v / 100;
      // Dragging the slider off zero is how you unmute, as in any player.
      applyAudioState({ volume, muted: volume === 0 ? state.browserAudio.muted : false });
    },
    onCommit: (v) => {
      const volume = v / 100;
      setAudio({ volume, muted: volume === 0 ? state.browserAudio.muted : false });
    },
  });
  volSlider.el.title = 'Page volume';
  $('browserVolume').append(volSlider.el);

  // ---- page console -------------------------------------------------------
  $('btnConsole').onclick = () => {
    const panel = $('browserConsole');
    panel.hidden = !panel.hidden;
    $('btnConsole').classList.toggle('active', !panel.hidden);
    $('btnConsole').setAttribute('aria-pressed', String(!panel.hidden));
    if (!panel.hidden) renderConsole();
  };
  $('consoleErrorsOnly').addEventListener('change', (e) => {
    state.consoleErrorsOnly = e.target.checked;
    renderConsole();
  });
  $('btnConsoleClear').onclick = async () => {
    setConsoleEntries([]);
    await browserApi('browser/console/clear').catch(() => {});
  };
}

// ============================================================================
// Attachments
// ============================================================================

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.next|\.venv|__pycache__|target)(\/|$)/;
const MAX_ATTACH_BYTES = 12 * 1024 * 1024;
const MAX_FOLDER_FILES = 120;

const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

async function addAttachments(files, { fromFolder = false } = {}) {
  let list = [...files];
  if (fromFolder) {
    list = list.filter((f) => !SKIP_DIRS.test(f.webkitRelativePath || '')).slice(0, MAX_FOLDER_FILES);
  }

  for (const file of list) {
    if (file.size > MAX_ATTACH_BYTES) {
      addMessage('error', `${file.name} is ${kb(file.size)} — too large to attach.`);
      continue;
    }
    try {
      state.attachments.push({
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        data: await toBase64(file),
        relPath: fromFolder ? file.webkitRelativePath || file.name : null,
        bytes: file.size,
      });
    } catch (err) {
      addMessage('error', err.message);
    }
  }
  renderAttachTray();
}

function renderAttachTray() {
  const tray = $('attachTray');
  tray.hidden = state.attachments.length === 0;
  tray.replaceChildren(
    ...state.attachments.map((a, index) => {
      const chip = el('span', 'chip');
      if (a.mediaType.startsWith('image/')) {
        const thumb = el('img', 'chip-thumb');
        thumb.src = `data:${a.mediaType};base64,${a.data}`;
        chip.append(thumb);
      } else {
        chip.append(icon(a.relPath ? 'folder' : 'clip'));
      }
      chip.append(el('span', 'chip-name', a.relPath || a.name));
      const remove = el('button', 'icon-btn');
      remove.type = 'button';
      remove.append(icon('x'));
      remove.onclick = () => {
        state.attachments.splice(index, 1);
        renderAttachTray();
      };
      chip.append(remove);
      return chip;
    }),
  );
}

// ============================================================================
// Panels
// ============================================================================

function applyProviderVisibility() {
  const local = isLocal();
  for (const node of document.querySelectorAll('.local-only')) {
    // The dedicated Local AI workspace is an explicit request to manage the
    // local runtime, so its controls stay available even while a hosted
    // provider (or no provider) is selected.
    node.hidden = node.closest('.local-ai-pane') ? false : !local;
  }
  renderChatPicker();
}

async function renderProviders(providers, active) {
  state.providers = providers;
  state.activeProvider = active;
  // A chat pointing at a provider that has since been removed follows the default again.
  if (state.chatProvider && !providers.some((p) => p.id === state.chatProvider)) {
    state.chatProvider = null;
    state.chatModel = null;
  }
  applyProviderVisibility();
  renderEffort();
  await refreshChatInfo();
}

/**
 * Ask the server what the picked model can do -- its window and whether it
 * takes a reasoning effort -- so the context meter and the effort picker
 * describe the chat's own model rather than the default provider's.
 */
async function refreshChatInfo() {
  const p = chatProvider();
  if (!p || p.managed) {
    state.chatInfo = null;
    return;
  }
  const key = `${p.id}|${p.model || ''}`;
  if (state.chatInfo?.key === key) return;
  try {
    const info = await api(`provider/info?id=${encodeURIComponent(p.id)}&model=${encodeURIComponent(p.model || '')}`);
    // The pick may have moved on while the answer was in flight.
    const now = chatProvider();
    if (`${now?.id}|${now?.model || ''}` !== key) return;
    state.chatInfo = { key, contextTokens: info.contextTokens, reasoning: info.reasoning };
  } catch {
    return; // the picker and the meter work without it
  }
  renderEffort();
  state.ctxLimit = null;
  renderCtx(null, null);
}

// ----------------------------------------------------------------------------
// Chat model picker: the chip in the composer and the menu behind it.
// ----------------------------------------------------------------------------

/** Provider id -> { models, error, at }. OpenRouter's list is large; ask once in a while. */
const modelLists = new Map();

async function loadModelList(id) {
  const hit = modelLists.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
  let entry;
  try {
    const { models, error } = await api(`provider/models?id=${encodeURIComponent(id)}`);
    const fallback = state.providers.find((p) => p.id === id)?.models || [];
    const list = (models?.length ? models : fallback).map((m) => (typeof m === 'string' ? { id: m } : m));
    entry = { models: list, error: list.length ? null : error || null, at: Date.now() };
  } catch (err) {
    entry = { models: [], error: err.message, at: Date.now() };
  }
  modelLists.set(id, entry);
  return entry;
}

/** "anthropic/claude-sonnet-4.5" -> "claude-sonnet-4.5"; the vendor is noise in a chip. */
const shortModel = (id) => String(id || '').split('/').pop();

/** Status colour for a provider row: the local server's own state, or whether a key is set. */
function providerState(p) {
  if (!p.managed) return p.hasKey ? 'ready' : 'error';
  const all = [...state.instances.values()];
  if (all.some((i) => i.state === 'ready' || i.state === 'external')) return 'ready';
  if (all.some((i) => i.state === 'starting')) return 'starting';
  return all.some((i) => i.state === 'error') ? 'error' : 'stopped';
}

/** The name a loaded model goes by in the chip and the menu. */
const instanceName = (inst) => inst.alias || inst.label || inst.id;

/** What the local provider is serving for the open chat, for the chip. */
function localModelName() {
  const inst = chatLocalInstance();
  return inst ? instanceName(inst) : 'no model loaded';
}

/** "2 models loaded", "qwen3.8-27b", or "nothing loaded" -- the local row's subtitle. */
function localSummary() {
  const ready = chatReadyInstances();
  if (!ready.length) return 'nothing loaded';
  return ready.length === 1 ? instanceName(ready[0]) : `${ready.length} models loaded`;
}

function renderChatPicker() {
  const chip = $('modelChip');
  if (!chip) return;
  const p = chatProvider();
  chip.replaceChildren();
  if (!p) {
    chip.append(el('span', 'mc-model', 'No provider'));
    return;
  }
  const dot = el('span', 'dot');
  dot.dataset.state = p.managed ? (chatLocalInstance() ? 'ready' : providerState(p)) : providerState(p);
  const model = p.managed ? localModelName() : shortModel(p.model) || 'choose a model';
  chip.append(dot, el('span', 'mc-provider', p.managed ? 'Local' : p.label), el('span', 'mc-model', model), icon('chevron'));
  chip.title = `${p.label} · ${p.managed ? localModelName() : p.model || 'no model'} — choose which AI answers in this chat`;
  if (!$('modelMenu').hidden) renderModelMenu();
}

/**
 * Point the open chat at a provider (and model). An existing chat stores the
 * pick on itself. A chat that has not been sent yet has nowhere to store it, so
 * the pick becomes the default the next new chat starts from as well -- the way
 * every other chat app remembers the last model you used.
 */
async function pickChat(providerId, model = null) {
  const row = state.providers.find((p) => p.id === providerId);
  if (!row) return;
  // Local: the model is which loaded instance answers (null follows the newest).
  // Hosted: a model id, defaulting to what the provider is set to.
  const next = row.managed
    ? model || null
    : model || (state.chatProvider === providerId && state.chatModel) || row.model || null;
  state.chatProvider = providerId;
  state.chatModel = next;
  applyProviderVisibility();
  renderEffort();
  refreshChatInfo();
  try {
    if (state.sessionId) {
      await api('session/provider', { id: state.sessionId, provider: providerId, model: next });
    } else {
      let res = await api('provider/select', { id: providerId });
      if (!row.managed && next && next !== row.model) res = await api('provider/model', { id: providerId, model: next });
      state.providers = res.providers;
      state.activeProvider = providerId;
      applyProviderVisibility();
    }
  } catch (err) {
    addMessage('error', err.message);
  }
}

function openModelMenu() {
  $('modelMenu').hidden = false;
  $('modelChip').setAttribute('aria-expanded', 'true');
  renderModelMenu();
}

function closeModelMenu() {
  $('modelMenu').hidden = true;
  $('modelChip').setAttribute('aria-expanded', 'false');
}

function renderModelMenu() {
  const menu = $('modelMenu');
  const cur = chatProvider();
  const keepSearch = menu.querySelector('.menu-search')?.value || '';
  menu.replaceChildren();
  if (!cur) return;

  menu.append(el('div', 'menu-label', 'Answer this chat with'));
  const providers = el('div', 'menu-providers');
  for (const p of state.providers) {
    const row = el('button', `menu-row${p.id === cur.id ? ' on' : ''}`);
    row.type = 'button';
    const dot = el('span', 'dot');
    dot.dataset.state = providerState(p);
    const text = el('span', 'menu-text');
    text.append(el('span', 'menu-name', p.managed ? 'Local' : p.label));
    const sub = p.managed
      ? localSummary()
      : (p.id === cur.id ? shortModel(cur.model) : shortModel(p.model)) || 'no model chosen';
    text.append(el('span', 'menu-sub', sub));
    row.append(dot, text);
    if (!p.managed && !p.hasKey) row.append(el('span', 'menu-tag warn', 'no key'));
    if (p.id === cur.id) row.append(icon('check'));
    row.onclick = async () => {
      if (p.id !== cur.id) await pickChat(p.id, null);
      renderModelMenu();
    };
    providers.append(row);
  }
  menu.append(providers);

  if (cur.managed) {
    menu.append(el('div', 'menu-label', 'Loaded models'));
    const ready = chatReadyInstances();
    const loaded = el('div', 'menu-models local');
    for (const inst of ready) {
      const row = el('button', `menu-row model${inst.id === cur.instance ? ' on' : ''}`);
      row.type = 'button';
      const text = el('span', 'menu-text');
      text.append(el('span', 'menu-name', instanceName(inst)));
      text.append(el('span', 'menu-sub', [inst.label !== instanceName(inst) ? inst.label : null, inst.ctx ? `${fmtCtx(inst.ctx)} context` : null].filter(Boolean).join(' · ')));
      row.append(text);
      if (inst.id === cur.instance) row.append(icon('check'));
      row.onclick = async () => { await pickChat(cur.id, inst.id); closeModelMenu(); };
      loaded.append(row);
    }
    if (!ready.length) loaded.append(el('div', 'menu-more', 'No model is loaded yet.'));
    menu.append(loaded);
    const note = el('div', 'menu-note');
    const open = el('button', 'menu-link', ready.length ? 'Load another model…' : 'Load a model…');
    open.type = 'button';
    open.onclick = () => { closeModelMenu(); selectWorkspaceTool?.('ai'); };
    note.append(open);
    menu.append(note);
    return;
  }

  if (!cur.hasKey) {
    const note = el('div', 'menu-note warn');
    note.append(el('span', null, `${cur.label} has no credential yet, so a message would fail. Add one in Settings → Model & provider.`));
    menu.append(note);
  }

  menu.append(el('div', 'menu-label', `Models · ${cur.label}`));
  const search = el('input', 'menu-search');
  search.type = 'search';
  search.placeholder = 'Search or type a model id…';
  search.spellcheck = false;
  search.autocomplete = 'off';
  search.value = keepSearch;
  const rows = el('div', 'menu-models');
  menu.append(search, rows);

  const draw = (entry) => {
    rows.replaceChildren();
    const q = search.value.trim().toLowerCase();
    let list = entry.models.filter((m) => !q || `${m.id} ${m.name || ''}`.toLowerCase().includes(q));
    // The current model first, then free ones, then the rest by name.
    const rank = (m) => (m.id === cur.model ? 0 : m.free ? 1 : 2);
    list = list.sort((a, b) => rank(a) - rank(b) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const shown = list.slice(0, 150);
    for (const m of shown) {
      const row = el('button', `menu-row model${m.id === cur.model ? ' on' : ''}`);
      row.type = 'button';
      row.title = m.id;
      const text = el('span', 'menu-text');
      text.append(el('span', 'menu-name', m.name || m.id));
      if (m.name && m.name !== m.id) text.append(el('span', 'menu-sub mono', m.id));
      row.append(text);
      if (m.free) row.append(el('span', 'menu-tag free', 'free'));
      if (m.contextTokens) row.append(el('span', 'menu-tag', fmtCtx(m.contextTokens)));
      if (m.id === cur.model) row.append(icon('check'));
      row.onclick = async () => { await pickChat(cur.id, m.id); closeModelMenu(); };
      rows.append(row);
    }
    if (q && !entry.models.some((m) => m.id.toLowerCase() === q)) {
      const custom = el('button', 'menu-row model custom');
      custom.type = 'button';
      custom.append(el('span', 'menu-text', `Use “${search.value.trim()}”`));
      custom.onclick = async () => { await pickChat(cur.id, search.value.trim()); closeModelMenu(); };
      rows.append(custom);
    }
    if (list.length > shown.length) rows.append(el('div', 'menu-more', `${list.length - shown.length} more — keep typing to narrow it down`));
    if (!list.length && !q) {
      rows.append(el('div', 'menu-more', entry.error ? `Could not list models: ${entry.error}` : 'This provider publishes no model list — type an id above.'));
    }
  };

  rows.append(el('div', 'menu-more', 'Loading models…'));
  let entry = null;
  search.oninput = () => { if (entry) draw(entry); };
  loadModelList(cur.id).then((loaded) => {
    // The menu may have been closed or redrawn for another provider meanwhile.
    if (!rows.isConnected) return;
    entry = loaded;
    draw(entry);
  });
  if (keepSearch) search.focus();
}

function renderProjects(projects, active) {
  state.projects = projects;
  state.activeProject = active;
  const sel = $('projectSelect');
  sel.replaceChildren();
  for (const p of projects) {
    const option = el('option', null, p.name);
    option.value = p.id;
    option.title = p.path;
    sel.append(option);
  }
  sel.value = active;
  sel.title = projects.find((p) => p.id === active)?.path || '';
  updateChromeContext();
  refreshBranch().catch(() => {});
}

function updateChromeContext() {
  const project = state.projects.find((p) => p.id === state.activeProject);
  const session = state.sessions.find((s) => s.id === state.sessionId);
  if ($('topbarProject')) $('topbarProject').textContent = project?.name || 'No project';
  if ($('topbarSession')) $('topbarSession').textContent = redactCredentials(session?.title || 'New session');
}

function renderEstimate(est) {
  const table = $('estimateTable');
  const verdict = $('verdict');
  $('estApprox').hidden = !est?.approx;

  if (!est?.available) {
    table.replaceChildren();
    verdict.className = 'callout';
    verdict.textContent = est?.reason || '';
    $('estNotes').textContent = '';
    return;
  }

  state.estimate = est;
  const ctx = state.config.profiles[state.editing]?.ctx;
  const rows = [
    ['Weights', gb(est.weightsBytes)],
    [`KV cache @ ${num(ctx)}`, gb(est.kvBytes)],
    ['Compute + runtime', gb(est.overheadBytes)],
  ];
  // The correction can be large and negative — a MoE profile keeps most of its
  // weights off the card — so it earns a row rather than hiding inside another.
  if (est.biasBytes) {
    rows.push([est.biasBytes < 0 ? 'Measured off the card' : 'Measured correction', gb(est.biasBytes), 'measured']);
  }
  rows.push(
    ['Predicted total', gb(est.totalBytes), 'total'],
    ['Budget', gb(est.budgetBytes)],
  );
  if (est.reserveBytes) rows.push(['Kept free', gb(est.reserveBytes)]);
  if (est.measured) {
    rows.push(['Last measured', gb(est.measured.dedicated), 'measured']);
    // The number that matters on a spill is the part that did not fit.
    if (est.measured.shared > 64 * 1024 * 1024) {
      rows.push(['…of which in RAM', gb(est.measured.shared), 'measured']);
    }
    if (est.measured.tokensPerSec) {
      const slow = est.minTokensPerSec && est.measured.tokensPerSec < est.minTokensPerSec;
      rows.push(['Last decode speed', `${est.measured.tokensPerSec.toFixed(1)} tok/s`, slow ? 'measured bad' : 'measured']);
    }
  }
  if (est.maxContext != null) rows.push(['Max context here', num(est.maxContext)]);

  table.replaceChildren(...rows.map(([k, v, cls]) => {
    const tr = el('tr', cls);
    tr.append(el('td', null, k), el('td', null, v));
    return tr;
  }));

  const headroom = est.budgetBytes - est.totalBytes;
  verdict.replaceChildren();
  if (est.blocked) {
    // Memory is beside the point when the server will not accept the arguments.
    verdict.className = 'callout bad';
    verdict.append(icon('warn'), el('span', null, est.blocked));
  } else if (est.totalBytes == null) {
    verdict.className = 'callout';
    verdict.textContent = 'Not enough model metadata to forecast.';
  } else if (headroom < 0) {
    verdict.className = 'callout bad';
    verdict.append(icon('warn'), el('span', null, `Over budget by ${gb(-headroom)} — this will spill into system RAM.`));
  } else if (headroom < 0.6 * GB) {
    verdict.className = 'callout tight';
    verdict.append(el('span', null, `Fits with only ${gb(headroom)} to spare. Close other GPU apps first.`));
  } else {
    verdict.className = 'callout good';
    verdict.append(el('span', null, `Fits, ${gb(headroom)} to spare.`));
  }
  $('estNotes').textContent = (est.notes || []).join(' · ');

  // What auto-fit would do, offered rather than done -- except at launch, where
  // it is done for you unless you have turned that off.
  const hint = $('fitHint');
  const steps = est.suggestion?.steps || [];
  if (steps.length) {
    hint.textContent = `${steps.join('; ')}${est.autoFitOnStart ? ' — applied automatically on start' : ''}`;
  } else {
    hint.textContent = est.fits ? '' : `Nothing left to adjust in ${est.fitMode} mode.`;
  }
  $('btnFit').disabled = est.fitMode === 'off';
  $('btnFit').title =
    est.fitMode === 'off'
      ? 'Auto-fit is off for this profile.'
      : 'Ask llama.cpp what fits right now and write it into this profile.';
}

/** A log line, tagged with its model once there is more than one to tell apart. */
function logLine(entry) {
  const inst = state.instances.get(entry.id);
  return state.instances.size > 1 && inst ? `[${instanceName(inst)}] ${entry.line}` : entry.line;
}

function renderVram(v) {
  state.vramByModel = new Map((v.perModel || []).map((m) => [m.id, m]));
  for (const inst of state.instances.values()) renderLoadedFacts(inst);
  const total = v.totalBytes || 1;
  const mine = v.llama?.dedicated || 0;
  const others = Math.max((v.usedBytes || 0) - mine, 0);
  $('segLlama').style.width = `${(mine / total) * 100}%`;
  $('segOthers').style.width = `${(others / total) * 100}%`;
  $('vramLlama').textContent = gb(mine);
  $('vramOthers').textContent = gb(others);
  $('vramFree').textContent = gb(Math.max(total - (v.usedBytes || 0), 0));
  $('vramTotal').textContent = `${(total / GB).toFixed(1)} GB`;
  // Host memory a profile asked for is not the same event as host memory the
  // driver took because the card was full, and they must not look the same.
  const shared = v.llama?.shared || 0;
  const design = v.offloadByDesign && shared > 64 * 1024 * 1024;
  $('spill').hidden = !v.spilling && !design;
  $('spill').classList.toggle('neutral', design);
  $('spillAmount').textContent = gb(shared);
  $('spillText').textContent = design
    ? ' held in system RAM by design — this profile offloads expert tensors to the CPU.'
    : ' into system RAM — decode speed will drop hard.';
  $('spillLead').textContent = design ? 'Offloading ' : 'Spilling ';
}

/** Replace everything known about the running models, from a fresh /api/state. */
function setInstances(list) {
  state.instances = new Map((list || []).map((i) => [i.id, i]));
  renderInstances();
  // A failed load offers the other builds; the list of them may not be known yet.
  if ((list || []).some((i) => i.state === 'error') && !state.engines.length) {
    refreshEngines().then(() => renderInstances());
  }
}

/** One model changed state. A stopped one is gone; anything else replaces its card. */
function applyInstance(view) {
  // A failed load offers the other builds; the list of them may not be known yet.
  if (view.state === 'error' && !state.engines.length) refreshEngines().then(() => renderInstances());
  if (view.removed || view.state === 'stopped') state.instances.delete(view.id);
  else state.instances.set(view.id, view);
  renderInstances();
}

const INSTANCE_STATE_LABEL = { starting: 'Loading…', ready: 'Ready', error: 'Failed', external: 'Attached' };

/** Everything that shows which models are loaded: the pill, the cards, the Load area, the chip. */
function renderInstances() {
  const all = [...state.instances.values()];
  const live = all.filter((i) => i.state === 'ready' || i.state === 'starting' || i.state === 'external');

  // The top-bar pill: one line for the whole set.
  const worst = all.some((i) => i.state === 'error') && !live.length ? 'error'
    : live.some((i) => i.state === 'ready' || i.state === 'external') ? (live.some((i) => i.state === 'external') ? 'external' : 'ready')
    : live.length ? 'starting' : 'stopped';
  $('serverState').querySelector('.dot').dataset.state = worst;
  $('serverStateText').textContent = !all.length ? 'no model loaded'
    : all.length === 1 ? `${instanceName(all[0])}${all[0].state === 'ready' ? '' : ` · ${(INSTANCE_STATE_LABEL[all[0].state] || all[0].state).toLowerCase()}`}`
    : `${live.length} models loaded`;

  renderLoadedList(all);
  renderLoadArea();
  renderRestartButton();

  renderEmptyReadiness();
  renderChatPicker();
}

/** "Apply & restart" belongs to the profile on screen, and only means something while it is loaded. */
function renderRestartButton() {
  const inst = state.instances.get(state.editing);
  const running = inst && (inst.state === 'ready' || inst.state === 'starting');
  $('btnRestart').disabled = !running;
  $('btnRestart').title = running ? 'Reload this model with the settings above' : 'Load this profile first';
}

function renderLoadedList(all) {
  const list = $('loadedList');
  list.replaceChildren();
  $('loadedCount').textContent = all.length ? String(all.length) : '';
  $('btnEjectAll').hidden = all.filter((i) => !i.external).length < 2;

  if (!all.length) {
    list.append(el('p', 'loaded-empty', 'Nothing is loaded. Pick a model below and press Load.'));
    return;
  }
  for (const inst of all) {
    const card = el('div', `loaded-card${inst.id === state.editing ? ' on' : ''}`);
    card.dataset.id = inst.id;
    const dot = el('span', 'dot');
    dot.dataset.state = inst.state;

    const main = el('button', 'loaded-main');
    main.type = 'button';
    main.title = 'Show this model\u2019s settings';
    const title = el('span', 'loaded-title');
    title.append(dot, el('span', 'loaded-name', inst.label || inst.id));
    if (state.config.profiles[inst.id]?.temporary) title.append(el('span', 'menu-tag', 'not saved'));
    if (inst.state !== 'ready') title.append(el('span', `menu-tag${inst.state === 'error' ? ' warn' : ''}`, INSTANCE_STATE_LABEL[inst.state] || inst.state));
    main.append(title);
    const facts = el('span', 'loaded-facts');
    facts.dataset.id = inst.id;
    main.append(facts);
    if (inst.state === 'error' && inst.lastError) main.append(el('span', 'loaded-error', inst.lastError.slice(0, 420)));
    main.onclick = () => { if (!inst.external) guard(() => selectProfile(inst.id))(); };

    const eject = el('button', 'btn tiny loaded-eject', inst.state === 'error' ? 'Dismiss' : 'Eject');
    eject.type = 'button';
    if (inst.external) {
      eject.disabled = true;
      eject.title = 'Started outside Skadi. Stop it where you launched it.';
    } else {
      eject.title = 'Unload this model and free its memory';
      eject.onclick = guard(async () => {
        eject.disabled = true;
        try { await api('server/stop', { profileId: inst.id }); } finally { eject.disabled = false; }
      });
    }
    card.append(main, eject);
    // A load can fail because of the build, not the model. Other builds on this
    // machine are one click away, for a profile that can be pointed at one.
    if (inst.state === 'error' && state.config.profiles[inst.id] && !state.config.profiles[inst.id].catalog) {
      const used = String(inst.engine || '').replace(/\\/g, '/').toLowerCase();
      const others = state.engines.filter((e) => e.path.toLowerCase() !== used);
      if (others.length) {
        const row = el('div', 'loaded-retry');
        row.append(el('span', null, 'Try with'));
        for (const engine of others) {
          const button = el('button', 'btn tiny', engine.name);
          button.type = 'button';
          button.title = engine.path;
          button.onclick = guard(() => retryWithEngine(inst.id, engine.path));
          row.append(button);
        }
        card.append(row);
      }
    }
    list.append(card);
    renderLoadedFacts(inst);
  }
}

/** Point a profile at another llama.cpp build and load it again. */
async function retryWithEngine(id, path) {
  await api('profile', { profileId: id, patch: { serverExe: path } });
  state.config.profiles[id].serverExe = path;
  if (state.editing === id) await selectProfile(id);
  await api('server/restart', { profileId: id });
}

/** The small print under a card: port, memory, window, speed. Refreshed as numbers arrive. */
function renderLoadedFacts(inst) {
  const node = document.querySelector(`.loaded-facts[data-id="${CSS.escape(inst.id)}"]`);
  if (!node) return;
  const vram = state.vramByModel.get(inst.id) || inst.vram;
  const bits = [
    inst.port ? `port ${inst.port}` : null,
    vram?.dedicated ? `${gb(vram.dedicated)} VRAM` : null,
    inst.ctx ? `${fmtCtx(inst.ctx)} ctx` : null,
    inst.throughput?.decode ? `${inst.throughput.decode.toFixed(1)} t/s` : null,
  ].filter(Boolean);
  node.textContent = bits.join('  ·  ');
}

// ---------------------------------------------------------- profile settings

const KV_TYPES = ['f16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'kvarn4', 'kvarn3'];

/**
 * What this particular model can and cannot do, read from its own file header.
 * Settings that only mean something for one kind of model -- expert layers on
 * the CPU for a Mixture-of-Experts model, the speculative-decoding head for one
 * that ships it -- are shown for that model and hidden for the rest. Each value
 * is true / false / undefined, where undefined means the header could not be
 * read and nothing should be hidden on a guess.
 */
function capsFor(estimate) {
  const shape = estimate?.available ? estimate.shape : null;
  if (!shape) return {};
  return {
    blocks: shape.blockCount || undefined,
    trainCtx: shape.trainCtx || undefined,
    moe: Number(shape.expertCount) > 1,
    mtp: Number(shape.nextnPredictLayers) > 0,
  };
}

const usesKvarn = (p) => /^kvarn/i.test(String(p.cacheK || '')) || /^kvarn/i.test(String(p.cacheV || ''));

// A field with `section` opens a collapsible group. Groups the model has no use
// for are left out entirely, fields and all. Everyday choices are open; the rest
// are one click away.
const FIELDS = [
  { section: 'model', title: 'Model', open: true },
  { key: 'label', label: 'Name', type: 'text' },
  {
    key: 'serverExe',
    label: 'Engine',
    type: 'select',
    options: (p) => {
      const list = state.engines.map((e) => ({ value: e.path, label: e.name }));
      // A build named by the profile that is no longer on disk stays choosable, so the field never lies.
      if (p?.serverExe && !list.some((e) => e.value === p.serverExe)) list.push({ value: p.serverExe, label: `${p.serverExe} (not found)` });
      const def = state.engines.find((e) => e.path === state.engineDefault);
      return [{ value: '', label: `default — ${def?.name || 'llama.cpp'}` }, ...list.filter((e) => e.value !== state.engineDefault)];
    },
    hint: 'Which llama.cpp build runs this model. Some formats only load on a fork built for them.',
  },
  {
    key: 'ctx',
    label: 'Context length',
    type: 'range',
    min: 4096,
    // The model's own trained window is the honest ceiling; a profile already
    // beyond it keeps its value reachable.
    max: (p, c) => Math.min(Math.max(c.trainCtx || 262144, Number(p.ctx) || 0), 1048576),
    step: 4096,
    fmt: num,
    hint: 'How much text the model can hold in mind at once. A longer window needs more VRAM for the KV cache.',
  },
  {
    key: 'ngl',
    label: 'GPU layers',
    type: 'range',
    min: 0,
    max: (p, c) => (c.blocks ? c.blocks + 1 : 99),
    step: 1,
    fmt: (v, c = {}) => (c.blocks && v >= c.blocks + 1 ? `all (${c.blocks + 1})` : String(v)),
    hint: 'How many of the model\u2019s layers run on the GPU. Fewer saves VRAM but is slower.',
  },
  {
    key: 'nCpuMoe',
    label: 'Expert layers on CPU',
    type: 'number',
    hidden: (p, c) => c.moe === false && !p.nCpuMoe,
    hint: 'Mixture-of-Experts models only. Keeps the expert weights of this many layers in system RAM: saves VRAM and can beat offloading whole layers. Not needed if the model fits in VRAM.',
  },
  {
    key: 'overrideTensor',
    label: 'Tensor placement (-ot)',
    type: 'text',
    hidden: (p) => !p.overrideTensor,
    hint: 'A hand-tuned map of which expert tensors stay on the CPU. Set by the fitter; clear it to fall back to the simple layer count above.',
  },
  // Off keeps the filename, so switching vision back on does not mean finding
  // the file again. Hidden entirely when the profile has no tower to toggle.
  {
    key: 'vision',
    label: 'Vision',
    type: 'bool',
    default: true,
    hidden: (p) => !p.mmproj,
    hint: 'Let the model see images. Uses about 1 GB more VRAM for the vision tower.',
  },
  { key: 'mmproj', label: 'Vision tower', type: 'text', hidden: (p) => !p.mmproj },

  { section: 'memory', title: 'Memory & speed', open: false },
  { key: 'cacheK', label: 'KV cache K', type: 'select', options: KV_TYPES, hint: 'Precision of the attention cache (keys). Lower uses less VRAM at some quality cost.' },
  { key: 'cacheV', label: 'KV cache V', type: 'select', options: KV_TYPES, hint: 'Precision of the attention cache (values). Lower uses less VRAM at some quality cost.' },
  { key: 'kvTailTokens', label: 'KV tail tokens', type: 'number', hidden: (p) => !usesKvarn(p) && !p.kvTailTokens, hint: 'Recent tokens kept at full precision when the cache is kvarn-compressed.' },
  { key: 'flashAttn', label: 'Flash attention', type: 'select', options: ['on', 'off', 'auto'], hint: 'A faster, leaner attention kernel. Leave on unless a model misbehaves.' },
  { key: 'batch', label: 'Batch size', type: 'number', hint: 'Tokens processed per step while reading the prompt. Larger is faster but uses more memory.' },
  { key: 'ubatch', label: 'Micro-batch size', type: 'number', hint: 'The physical slice of the batch. Usually a quarter to half of the batch size.' },
  { key: 'threads', label: 'CPU threads', type: 'range', min: 1, max: 32, step: 1, hint: 'Threads for generation. Match your performance cores.' },
  { key: 'threadsBatch', label: 'Prompt threads', type: 'range', min: 1, max: 32, step: 1, hint: 'Threads while reading the prompt. Often more than generation uses.' },
  { key: 'parallel', label: 'Parallel slots', type: 'number', hint: 'How many requests the server works on at once. Each slot divides the context window between them.' },
  { key: 'kvUnified', label: 'Unified KV cache', type: 'bool', hint: 'Let all slots share one cache instead of splitting it.' },
  // Populated from llama.cpp's own device list when the forecast arrives; the
  // static fallback is there so the field still works if the probe failed.
  {
    key: 'device',
    label: 'GPU',
    type: 'select',
    options: () => [
      { value: '', label: `default — ${state.estimate?.defaultDevice || 'discrete card'}` },
      ...(state.estimate?.devices || []).map((d) => ({
        value: d.id,
        label: `${d.id} — ${d.name} (${(d.totalMiB / 1024).toFixed(1)} GB)`,
      })),
      { value: 'auto', label: 'auto — every device llama.cpp finds' },
    ],
    hint: 'Which graphics device to load onto. Integrated graphics borrow system RAM, so the default is the discrete card.',
  },

  {
    section: 'spec',
    title: 'Speculative decoding',
    open: false,
    hidden: (p, c) => c.mtp === false && !p.specType && !p.draftModel,
  },
  { key: 'specType', label: 'Method', type: 'select', options: [{ value: '', label: 'off' }, { value: 'draft-mtp', label: 'draft-mtp (built-in head)' }], hint: 'Guess several tokens ahead with a small draft head and keep the ones the model agrees with. Faster when the guesses land.' },
  { key: 'draftModel', label: 'Draft model file', type: 'text', hidden: (p) => !p.draftModel, hint: 'A separate file holding the draft head, for models that do not carry it themselves.' },
  { key: 'specDraftNMax', label: 'Tokens per guess', type: 'range', min: 1, max: 8, step: 1, hidden: (p) => !p.specType, hint: 'The most tokens to guess at once.' },
  { key: 'specDraftPMin', label: 'Guess confidence', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), hidden: (p) => !p.specType, hint: 'Only keep a guess the draft is at least this sure of.' },

  { section: 'sampling', title: 'Sampling', open: false },
  { key: 'temp', label: 'Temperature', type: 'range', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), hint: 'Randomness. Lower is more focused, higher is more varied.' },
  { key: 'topK', label: 'Top-K', type: 'range', min: 0, max: 100, step: 1, hint: 'Only consider the K most likely next tokens. 0 turns it off.' },
  { key: 'topP', label: 'Top-P', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), hint: 'Only consider the smallest set of tokens whose probabilities add up to this.' },
  { key: 'minP', label: 'Min-P', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), hint: 'Drop tokens less likely than this fraction of the best one.' },

  { section: 'reasoning', title: 'Reasoning & template', open: false },
  { key: 'reasoning', label: 'Thinking', type: 'select', options: [{ value: '', label: 'server default' }, 'on', 'off', 'auto'], hint: 'Whether the model thinks before answering.' },
  { key: 'reasoningEffort', label: 'Reasoning effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh'], hint: 'How much the model thinks by default. A chat can override it per message.' },
  { key: 'reasoningFormat', label: 'Thinking format', type: 'select', options: [{ value: '', label: 'server default' }, 'deepseek', 'deepseek-legacy', 'none'], hint: 'How thinking is separated from the answer.' },
  { key: 'reasoningPreserve', label: 'Keep thinking in history', type: 'bool', hint: 'Send earlier thinking back with each turn.' },
  { key: 'jinja', label: 'Jinja templates', type: 'bool', hint: 'Use the model\u2019s own chat template. Needed for tools and thinking.' },
  { key: 'useChatTemplate', label: 'Custom chat template', type: 'bool', hint: 'Use the template file from the harness config instead of the model\u2019s built-in one.' },

  { section: 'fit', title: 'Auto-fit', open: false },
  {
    key: 'autoFit',
    label: 'Auto-fit',
    type: 'select',
    options: [
      { value: '', label: 'use the global setting' },
      { value: 'off', label: 'off — launch exactly as written' },
      { value: 'ctx', label: 'context only' },
      { value: 'full', label: 'full — context, cache, layers' },
    ],
    hint: 'What Skadi may change to make this fit the free VRAM when it loads.',
  },
  {
    key: 'fitPriority',
    label: 'When it does not fit',
    type: 'select',
    options: [
      { value: '', label: 'use the global setting' },
      { value: 'speed', label: 'keep context + cache — move layers to CPU' },
      { value: 'context', label: 'keep context — coarsen the KV cache' },
      { value: 'quality', label: 'keep cache exact — shorten context' },
    ],
  },
  { key: 'ctxFloor', label: 'Never fit below (tokens)', type: 'number' },
  { key: 'allowCpuLayers', label: 'May move layers to CPU', type: 'bool' },
];

const SKADI_FIELDS = [
  { key: 'loopDetection', label: 'Semantic loop detection', type: 'bool' },
  { key: 'loopReviewEffort', label: 'Loop supervisor reasoning', type: 'select', options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { key: 'loopReviewEvery', label: 'Semantic review cadence', type: 'range', min: 1, max: 10, step: 1, fmt: (v) => `every ${v} rounds` },
  { key: 'maxImplementationDiscoveryRounds', label: 'Discovery budget', type: 'range', min: 1, max: 20, step: 1 },
  { key: 'autoSubagents', label: 'Automatic research subagents', type: 'bool' },
  { key: 'autoSubagentReasoning', label: 'Subagent reasoning', type: 'select', options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { key: 'maxToolRounds', label: 'Easy-task tool ceiling', type: 'range', min: 0, max: 60, step: 1, fmt: (v) => (Number(v) === 0 ? 'off' : String(v)) },
  { key: 'maxTurnMinutes', label: 'Turn safety limit (min)', type: 'number' },
  { key: 'commandTimeoutSec', label: 'Command timeout (s)', type: 'number' },
  { key: 'approveWrites', label: 'Confirm file writes', type: 'bool' },
  { key: 'approveCommands', label: 'Confirm shell commands', type: 'bool' },
  { key: 'browserHeadless', label: 'Headless review browser', type: 'bool' },
  { key: 'maxBrowsers', label: 'Browsers kept open', type: 'number' },
  { key: 'vramPollMs', label: 'VRAM poll (ms)', type: 'number' },
  { key: 'vramReserveMb', label: 'VRAM kept free (MB)', type: 'number' },
  { key: 'autoFitOnStart', label: 'Fit before every launch', type: 'bool' },
  {
    key: 'fitMode',
    label: 'Auto-fit may change',
    type: 'select',
    options: [
      { value: 'off', label: 'nothing' },
      { value: 'ctx', label: 'context only' },
      { value: 'full', label: 'context, cache, layers' },
    ],
  },
  {
    key: 'fitPriority',
    label: 'When it does not fit',
    type: 'select',
    options: [
      { value: 'speed', label: 'keep context + cache — move layers to CPU' },
      { value: 'context', label: 'keep context — coarsen the KV cache' },
      { value: 'quality', label: 'keep cache exact — shorten context' },
    ],
  },
  { key: 'ctxFloor', label: 'Never fit below (tokens)', type: 'number' },
  { key: 'allowCpuLayers', label: 'May move layers to CPU', type: 'bool' },
  { key: 'minTokensPerSec', label: 'Warn below (tokens/s)', type: 'number' },
];

/** Which collapsible groups are open, remembered across redraws. */
const sectionOpen = new Map();

/** A label, with a small ? that explains the setting on hover when it has something to say. */
function fieldLabel(field) {
  const label = el('label', null, field.label);
  if (field.hint) {
    label.title = field.hint;
    const help = el('span', 'help', '?');
    help.title = field.hint;
    label.append(help);
  }
  return label;
}

function renderFields(container, fields, values, onChange, caps = {}) {
  container.replaceChildren();
  let target = container;
  let skipping = false;
  for (const field of fields) {
    if (field.section) {
      // A group this model has no use for disappears with everything in it.
      skipping = typeof field.hidden === 'function' && field.hidden(values, caps);
      if (skipping) continue;
      const group = el('details', 'field-section');
      if (sectionOpen.get(field.section) ?? field.open) group.open = true;
      group.addEventListener('toggle', () => sectionOpen.set(field.section, group.open));
      group.append(el('summary', null, field.title));
      const body = el('div', 'field-section-body');
      group.append(body);
      container.append(group);
      target = body;
      continue;
    }
    if (skipping) continue;
    // A field can be irrelevant to this profile rather than merely unset -- a
    // vision switch on a model with no vision tower is noise, not a choice.
    if (typeof field.hidden === 'function' && field.hidden(values, caps)) continue;
    // `default` is what an absent value means, which is not always false: a
    // switch added after a profile was written has to keep it behaving as it did.
    const value = values[field.key] ?? field.default;

    if (field.type === 'range') {
      const wrap = el('div', 'field');
      const row = el('div', 'field-row');
      const label = fieldLabel(field);
      const out = el('span', 'val');
      const fmt = (v) => (field.fmt ? field.fmt(Number(v), caps) : String(v));
      // The ceiling can depend on the model (its layer count, its trained window).
      const max = typeof field.max === 'function' ? field.max(values, caps) : field.max;
      const shown = Math.min(value ?? field.min, max);
      out.textContent = fmt(shown);
      const slider = makeSlider({
        min: field.min,
        max,
        step: field.step,
        value: shown,
        label: field.label,
        format: fmt,
        onInput: (v) => { out.textContent = fmt(v); },
        onCommit: (v) => onChange(field.key, v),
      });
      // The field panel is narrower than a settings row: the bar spans it.
      slider.el.classList.add('full');
      row.append(label, out);
      wrap.append(row, slider.el);
      target.append(wrap);
      continue;
    }

    const wrap = el('div', 'field inline');
    const label = fieldLabel(field);
    let input;

    if (field.type === 'select') {
      input = el('select');
      // Options are plain values, except '' which has always meant "omit the
      // flag". An option can also be { value, label } to name that case
      // honestly (e.g. 'server default' instead of 'off').
      const norm = (o) => (typeof o === 'string' ? { value: o, label: o === '' ? 'off' : o } : o);
      // Options may be a function when the list is only known at render time --
      // the GPUs llama.cpp reports, for one.
      const options = typeof field.options === 'function' ? field.options(values) : field.options;
      for (const raw of options) {
        const opt = norm(raw);
        const option = el('option', null, opt.label);
        option.value = opt.value;
        input.append(option);
      }
      input.value = value ?? '';
      // null (not undefined) so the key survives JSON: picking the default
      // writes null, which the launcher reads as "omit the flag".
      input.addEventListener('change', () => onChange(field.key, input.value || null));
    } else if (field.type === 'bool') {
      // The same switch the settings panel uses: a button whose click handler
      // owns the state, so a failed save can roll it back instead of stranding
      // it in the wrong place.
      input = el('button', 'switch');
      input.type = 'button';
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-checked', String(Boolean(value)));
      input.setAttribute('aria-label', field.label);
      const knob = el('span', 'knob');
      input.append(knob);
      let pending = false;
      input.addEventListener('click', async () => {
        if (pending || input.disabled) return;
        const previous = input.getAttribute('aria-checked') === 'true';
        const next = !previous;
        // Flip first: visual state, ARIA state and the save all follow the click.
        pending = true;
        input.classList.add('pending');
        input.setAttribute('aria-checked', String(next));
        try {
          await onChange(field.key, next);
        } catch (err) {
          // Roll back over the same 250 ms ease-out, then announce the failure.
          input.setAttribute('aria-checked', String(previous));
          addMessage('error', err.message);
        } finally {
          pending = false;
          input.classList.remove('pending');
        }
      });
    } else {
      input = el('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      input.value = value ?? '';
      input.addEventListener('change', () =>
        onChange(field.key, field.type === 'number' ? Number(input.value) : input.value));
    }

    wrap.append(label, input);
    target.append(wrap);
  }
}

/**
 * The profile on screen. Choosing which one to load happens in the Load area;
 * this panel only edits the one that was chosen, so it names it rather than
 * offering a second way to pick.
 */
function renderProfileSelect() {
  const profile = state.config.profiles[state.editing];
  const name = $('profileName');
  name.replaceChildren(el('span', 'profile-name-text', profile?.label || state.editing || ''));
  if (state.instances.get(state.editing)?.state === 'ready') name.append(el('span', 'menu-tag free', 'loaded'));
  renderLoadArea();
}

async function refreshEngines() {
  try {
    const res = await api('engines');
    state.engines = res.engines;
    state.engineDefault = res.default?.replace(/\\/g, '/');
  } catch { /* the Engine field still shows its current value */ }
}

/** Bring a catalog profile into the profile list. */
async function importCatalogProfile(id) {
  const res = await api('catalog/import', { profileId: id });
  state.config = res.config;
  renderProfileSelect();
}

/** Take a catalog profile back out of the profile list. It stays in the catalog. */
async function removeCatalogProfile(id) {
  const res = await api('catalog/remove', { profileId: id });
  state.config = res.config;
  if (state.editing === id) await selectProfile(res.config.activeProfile);
  else renderProfileSelect();
}

const catalogGB = () => Object.values(state.config.profiles).find((p) => p.catalog)?.vramGB || 16;

/** A catalog profile is read-only: its fields go inert and only Duplicate is offered. */
function applyProfileLock(id) {
  const locked = Boolean(state.config.profiles[id]?.catalog);
  $('profileLock').hidden = !locked;
  $('profileTemp').hidden = !state.config.profiles[id]?.temporary;
  if (locked) $('profileLockVram').textContent = `${catalogGB()} GB`;
  $('settings').inert = locked;
  $('settings').classList.toggle('locked', locked);
  $('btnFit').disabled = locked;
  $('btnFit').title = locked ? 'Catalog profiles are read-only — duplicate it to apply a fit' : '';
  // A catalog profile cannot be deleted, but it can be taken off the list.
  $('btnDeleteProfile').disabled = !locked && Object.keys(state.config.profiles).length <= 1;
  $('btnDeleteProfile').title = locked
    ? 'Remove from your profiles — it stays in the Skadi catalog and can be imported again'
    : 'Delete this profile';
}

function renderModelLine(id) {
  const profile = state.config.profiles[id] || {};
  const line = $('modelLine');
  line.replaceChildren();
  const file = profile.modelPath || profile.model;
  if (!file) return;
  line.append(icon('chip'));
  const name = el('span', 'model-name', String(file).split(/[\/]/).pop());
  name.title = file;
  line.append(name);
}

async function selectProfile(id) {
  state.editing = id;
  // Picking a profile anywhere -- a loaded card, a catalog row -- points the
  // Load area at its model and settings too, so the two never disagree.
  const picked = state.config.profiles[id];
  if (picked) {
    state.loadModel = modelBase(picked);
    state.loadProfile = id;
  }
  renderProfileSelect();
  renderRestartButton();
  renderLoadedList([...state.instances.values()]);
  renderModelLine(id);
  // The forecast first: some fields are built from what it reports -- the GPU
  // list, for one -- so rendering them before it arrives offers a stale choice.
  await refreshEngines();
  const estimate = await api(`estimate?profile=${encodeURIComponent(id)}`);
  renderEstimate(estimate);
  const caps = capsFor(estimate);
  renderFields($('settings'), FIELDS, state.config.profiles[id], async (key, value) => {
    // Commit only after the save lands: a failed patch must leave the profile
    // (and the switch that rolled back with it) holding the old value.
    const next = await api('profile', { profileId: id, patch: { [key]: value } });
    state.config.profiles[id][key] = value;
    if (key === 'label') renderProfileSelect();
    renderEstimate(next);
  }, caps);
  applyProfileLock(id);
  renderRestartButton();
}

async function refreshLists() {
  // Every project's chats, because the rail lists every project's chats. The
  // scope is what makes a chat filed elsewhere reachable -- and deletable --
  // without having to go and find the project it is in first.
  const [sessions, groups] = await Promise.all([api('sessions?scope=all'), api('groups')]);
  state.sessions = sessions;
  state.groups = groups;
  renderChatList();
}

// ============================================================================
// Chats-only left rail
//
// Pinned chats float to the top, then groups (alphabetical), then ungrouped,
// then archived at the bottom. Every row has a … button and a right-click menu
// with Pin, Rename, Mark as unread/read, Archive and Move to Group.
// ============================================================================

function sessionById(id) {
  return state.sessions.find((s) => s.id === id);
}

// ----------------------------------------------------------------------------
// Composer drafts.
//
// What is in the composer belongs to a chat, not to the window. Switching
// chats used to carry the half-written message -- and, worse, the staged
// attachments -- into whatever you opened next, so a photo picked for one
// chat was sent with another. Each chat keeps its own; the unsent new chat
// parks its draft under `null` until the server gives it an id.
// ----------------------------------------------------------------------------
const drafts = new Map(); // sessionId | null -> { text, attachments }

/** Park the composer under the chat that is open now. */
function stashDraft() {
  const text = $('input').value;
  if (!text && !state.attachments.length) drafts.delete(state.sessionId);
  else drafts.set(state.sessionId, { text, attachments: state.attachments });
}

/**
 * Leave the open chat for `nextId` (null = a fresh unsent chat).
 *
 * Every exit has to do the same things: park the draft under the chat being
 * left, put the next chat's own draft up, re-read whether *that* chat is
 * mid-turn, and hand the browser pane over. Skipping the third is what left a
 * new chat holding the previous one's "Stop generating" state, with a
 * composer that refused to send.
 *
 * Going to a new chat also mints a new draft key, so the browser the last
 * unsent chat opened stays with it instead of being inherited.
 */
function leaveSession(nextId = null) {
  stashDraft();
  if (nextId === null) state.draftKey = newDraftKey();
  state.sessionId = nextId;
  // A new chat starts on the default; an existing one is set by openSession.
  if (nextId === null) followChatChoice(null);
  restoreDraft(nextId);
  syncBusy();
  syncBrowserPane();
}

/**
 * Show the provider and model a chat was last sent with. A chat that has never
 * been sent in (or predates per-chat providers) follows the default.
 */
function followChatChoice(session) {
  const known = session?.provider && state.providers.some((p) => p.id === session.provider);
  state.chatProvider = known ? session.provider : null;
  state.chatModel = known ? session.model || null : null;
  state.webSearch = session ? session.webSearch !== false : true;
  state.subagents = session ? session.subagents !== false : state.settings?.autoSubagents !== false;
  renderWebSearchToggle();
  renderSubagentsToggle();
  closeModelMenu();
  applyProviderVisibility();
  renderEffort();
  refreshChatInfo();
}

function renderWebSearchToggle() {
  const button = $('btnWebSearch');
  if (!button) return;
  const enabled = state.webSearch !== false;
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} web search for this chat`);
  button.title = `Web search ${enabled ? 'enabled' : 'disabled'} for this chat`;
  button.disabled = isBusy();
}

function renderSubagentsToggle() {
  const button = $('btnSubagents');
  if (!button) return;
  const enabled = state.subagents !== false;
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} subagents for this chat`);
  button.title = `Subagents ${enabled ? 'enabled' : 'disabled'} for this chat`;
  button.disabled = isBusy();
}

/** Forget a chat's draft: it is being deleted, not left. */
function dropDraft(id) {
  drafts.delete(id);
}

/** Put `id`'s own draft in the composer -- empty when it has none. */
function restoreDraft(id) {
  const draft = drafts.get(id) || { text: '', attachments: [] };
  const input = $('input');
  input.value = draft.text;
  input.style.height = 'auto';
  if (draft.text) input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  state.attachments = draft.attachments;
  renderAttachTray();
}

/** A chat belongs to the project the rail is showing. */
const inProject = (s) => (s.projectId ?? null) === state.activeProject;

/** Does this chat pass the search box and the All/Unread/Archived tabs? */
function matchesChatFilter(s) {
  const q = state.chatQuery.trim().toLowerCase();
  if (state.chatFilter === 'unread' && !s.unread) return false;
  if (state.chatFilter === 'archived' && !s.archived) return false;
  if (state.chatFilter === 'all' && s.archived) return false;
  if (q && !String(s.title || '').toLowerCase().includes(q)) return false;
  return true;
}

function filteredSessions() {
  // One flat list of every chat, Claude-style, whatever project it lives in.
  // Scoping the rail to the active project made clicking a chat reshuffle the
  // list: the chat you opened jumped to the top and dragged its project-mates
  // with it, while the old project's chats dropped into "Other projects" -- so
  // the same rail read as one chat, then three, depending on where you clicked.
  // A chat outside the active project says so in its sub-line instead.
  return state.sessions.filter(matchesChatFilter);
}

const projectName = (id) => state.projects.find((p) => p.id === id)?.name || id || 'No project';

/** Open a chat that lives in another project, switching to that project first. */
async function openElsewhere(session) {
  // A plain function rather than guard(): this is declared long before guard
  // exists, and guard() would run at load time.
  try {
    await api('project/select', { id: session.projectId });
    state.activeProject = session.projectId;
    $('projectSelect').value = session.projectId;
    await refreshBranch().catch(() => {});
    await openSession(session.id);
  } catch (err) {
    addMessage('error', err.message);
    // Whatever went wrong, the rail is now describing a chat that would not
    // open. Re-read it so a row for a chat that is gone goes with it, instead
    // of sitting there failing every time it is clicked.
    refreshLists().catch(() => {});
  }
}

/** The rail row standing in for an unsent new chat. */
function draftRow() {
  const row = el('div', 'chat-row active draft');
  row.append(el('span', 'unread-dot placeholder', ''));
  const main = el('div', 'chat-main');
  const top = el('div', 'chat-top');
  top.append(el('span', 'chat-title', 'New session'));
  main.append(top);
  main.append(el('div', 'chat-sub', 'draft · send a message to keep it'));
  row.append(main);
  return row;
}

function chatRow(session) {
  const elsewhere = !inProject(session);
  const running = state.running.has(session.id);
  const row = el('div', `chat-row${session.id === state.sessionId ? ' active' : ''}${session.unread ? ' unread' : ''}${running ? ' running' : ''}`);
  row.dataset.id = session.id;
  if (elsewhere) {
    row.classList.add('elsewhere-row');
    row.title = `Open in ${projectName(session.projectId)}`;
  }

  // A chat with a turn in flight pulses, whether or not it is the open one --
  // several can run at once, so the rail is where you see what is working.
  if (session.unread) row.append(el('span', 'unread-dot', ''));
  else row.append(el('span', 'unread-dot placeholder', ''));

  const main = el('div', 'chat-main');
  const top = el('div', 'chat-top');
  if (session.pinned) top.append(icon('pin'));
  if (running) {
    const mark = el('span', 'chat-running-mark');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', 'Working');
    mark.title = 'Working';
    top.append(mark);
  }
  top.append(el('span', 'chat-title', redactCredentials(session.title || 'Untitled')));
  // The rail lists every chat, so a row has to say where it lives. Only the
  // ones filed elsewhere need to: naming the project on all of them would
  // repeat the project picker down the whole list.
  const state_ = running ? 'working…'
    : session.turns ? `${session.turns} turn${session.turns === 1 ? '' : 's'}` : 'empty';
  const sub = el('div', 'chat-sub', elsewhere ? `${projectName(session.projectId)} · ${state_}` : state_);
  main.append(top, sub);

  const menuBtn = el('button', 'icon-btn chat-menu-btn');
  menuBtn.type = 'button';
  menuBtn.title = 'Chat actions';
  menuBtn.append(icon('dots'));
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    openChatMenu(session.id, menuBtn);
  };

  row.append(main, menuBtn);
  // `openElsewhere` reports its own failures, and re-reads the rail when a row
  // turns out to name a chat that will not open. A chat in this project gets
  // the same treatment rather than a row that fails silently on every click.
  row.onclick = async () => {
    if (elsewhere) return openElsewhere(session);
    try {
      await openSession(session.id);
    } catch (err) {
      addMessage('error', err.message);
      refreshLists().catch(() => {});
    }
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    openChatMenu(session.id, row, { x: e.clientX, y: e.clientY });
  };
  // Inline rename via double-click.
  row.ondblclick = (e) => {
    e.stopPropagation();
    startInlineRename(row, session);
  };
  return row;
}

// Which groups are folded away; kept here because the rail is rebuilt on every change.
const collapsedGroups = new Set();

function groupSection(group, sessions) {
  const wrap = el('div', `chat-group${collapsedGroups.has(group.id) ? ' collapsed' : ''}`);
  const head = el('div', 'chat-group-head');
  head.append(icon('folder'));
  head.append(el('span', 'chat-group-name', group.name));
  head.append(el('span', 'count', String(sessions.length)));
  const menu = el('button', 'icon-btn');
  menu.type = 'button';
  menu.title = 'Group actions';
  menu.append(icon('dots'));
  menu.onclick = (e) => {
    e.stopPropagation();
    openGroupMenu(group.id, menu);
  };
  head.append(menu);
  head.onclick = () => {
    wrap.classList.toggle('collapsed');
    if (wrap.classList.contains('collapsed')) collapsedGroups.add(group.id);
    else collapsedGroups.delete(group.id);
  };
  wrap.append(head);
  const body = el('div', 'chat-group-body');
  body.append(...sessions.map(chatRow));
  wrap.append(body);
  return wrap;
}

function renderChatList() {
  const box = $('chatList');
  if (!box) return;
  const list = state.sessions.filter((s) => !s.archived && matchesChatFilter(s));
  const count = $('sessionCount');
  if (count) count.textContent = list.length || '';
  updateChromeContext();

  box.replaceChildren();
  if (!list.length) {
    box.append(el('div', 'empty-note', state.chatQuery ? 'No chats match' : 'No chats yet'));
    return;
  }

  box.append(el('div', 'chat-section-title rail-section-title', 'Projects'));
  const projectIds = [...new Set([
    ...state.projects.map((project) => project.id),
    ...list.map((session) => session.projectId ?? null),
  ])];
  for (const projectId of projectIds) {
    const sessions = list.filter((session) => (session.projectId ?? null) === projectId);
    if (!sessions.length) continue;
    const section = el('section', 'project-chat-section');
    const heading = el('div', 'project-chat-heading');
    heading.append(icon('folder'), el('span', null, projectName(projectId)));
    section.append(heading);
    const rows = el('div', 'project-chat-rows');
    // Groups belong to the project the rail is scoped to, so only that
    // project's section can have them. A chat whose group is gone (deleted, or
    // from another project) is listed loose rather than lost.
    const groups = projectId === state.activeProject ? state.groups : [];
    const known = new Set(groups.map((g) => g.id));
    // An empty group still shows, so a group you just made has somewhere to be;
    // while searching or filtering, only the groups that have a match.
    const filtering = state.chatQuery.trim() || state.chatFilter !== 'all';
    for (const group of groups) {
      const inside = sessions.filter((session) => session.groupId === group.id);
      if (inside.length || !filtering) rows.append(groupSection(group, inside));
    }
    for (const session of sessions.filter((x) => !known.has(x.groupId)).slice(0, 6)) rows.append(chatRow(session));
    section.append(rows);
    box.append(section);
  }

}

function startInlineRename(row, session) {
  const titleEl = row.querySelector('.chat-title');
  if (!titleEl || row.querySelector('.chat-rename')) return;
  const input = el('input', 'chat-rename');
  input.type = 'text';
  input.value = redactCredentials(session.title || '');
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  // Once, whatever ends it. Committing re-renders the rail, which takes the
  // input out of the document and fires `blur` -- so without this, Escape
  // saved the edit it was meant to abandon, and Enter saved it twice.
  let settled = false;
  const commit = async (save) => {
    if (settled) return;
    settled = true;
    if (save && input.value.trim() && input.value.trim() !== session.title) {
      try {
        await api('session/update', { id: session.id, patch: { title: input.value.trim() } });
        await refreshLists();
      } catch (err) { addMessage('error', err.message); renderChatList(); }
    } else {
      renderChatList();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => commit(true));
  input.onclick = (e) => e.stopPropagation();
}

// ---------------------------------------------------------------- menus ----

function closeChatMenu() {
  const menu = $('chatMenu');
  if (menu) menu.hidden = true;
}

function placeMenu(menu, anchor, point) {
  menu.hidden = false;
  const pad = 8;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = anchor?.getBoundingClientRect?.();
  let x = point?.x ?? (rect ? rect.left : pad);
  let y = point?.y ?? (rect ? rect.bottom + 4 : pad);
  // Anchor right-aligned for the … button so the menu opens under it.
  if (!point && rect) x = Math.max(pad, rect.right - 220);
  x = Math.min(x, window.innerWidth - 232);
  y = Math.min(y, window.innerHeight - menu.children.length * 34 - 40);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
}

function menuButton(labelText, iconName, onClick) {
  const b = el('button', 'ctx-item');
  b.type = 'button';
  b.append(icon(iconName), el('span', null, labelText));
  b.onclick = (e) => {
    e.stopPropagation();
    closeChatMenu();
    onClick();
  };
  return b;
}

function menuSeparator() {
  return el('div', 'ctx-sep');
}

function openChatMenu(sessionId, anchor, point) {
  const s = sessionById(sessionId);
  if (!s) return;
  const menu = $('chatMenu');
  menu.replaceChildren();

  menu.append(menuButton(s.pinned ? 'Unpin' : 'Pin', 'pin',
    guard(async () => {
      await api('session/update', { id: s.id, patch: { pinned: !s.pinned } });
      await refreshLists();
    })));
  menu.append(menuButton('Rename', 'edit', () => {
    const row = document.querySelector(`.chat-row[data-id="${CSS.escape(s.id)}"]`);
    if (row) startInlineRename(row, s);
    else askName('Rename chat', 'Title', redactCredentials(s.title || ''), guard(async (v) => {
      await api('session/update', { id: s.id, patch: { title: v } });
      await refreshLists();
    }));
  }));
  menu.append(menuButton(s.unread ? 'Mark as read' : 'Mark as unread', s.unread ? 'eye' : 'eye-off',
    guard(async () => {
      await api('session/update', { id: s.id, patch: { unread: !s.unread } });
      await refreshLists();
    })));
  menu.append(menuButton(s.archived ? 'Unarchive' : 'Archive', 'archive',
    guard(async () => {
      await api('session/update', { id: s.id, patch: { archived: !s.archived } });
      await refreshLists();
    })));

  // Groups are scoped to the active project; do not file an elsewhere chat
  // into one of this project's groups without switching projects first.
  if (inProject(s)) {
    menu.append(menuSeparator());
    const moveHead = el('div', 'ctx-head', 'Move to group');
    menu.append(moveHead);
    if (!state.groups.length) {
      menu.append(el('div', 'ctx-empty', 'No groups yet'));
    } else {
      for (const g of state.groups) {
        const item = el('button', `ctx-item${s.groupId === g.id ? ' current' : ''}`);
        item.type = 'button';
        item.append(icon('folder'), el('span', null, g.name));
        if (s.groupId === g.id) item.append(icon('check'));
        item.onclick = guard(async () => {
          closeChatMenu();
          await api('session/update', { id: s.id, patch: { groupId: g.id } });
          await refreshLists();
        });
        menu.append(item);
      }
      if (s.groupId) {
        menu.append(menuButton('Remove from group', 'x', guard(async () => {
          await api('session/update', { id: s.id, patch: { groupId: null } });
          await refreshLists();
        })));
      }
    }
    menu.append(menuSeparator());
    menu.append(menuButton('Create group', 'plus', () => askName('Create group', 'Group name', '', guard(async (v) => {
      const { group } = await api('group/create', { name: v });
      await refreshLists();
      // Move this chat straight into the group it was created from.
      await api('session/update', { id: s.id, patch: { groupId: group.id } });
      await refreshLists();
    }))));
  }
  menu.append(menuSeparator());
  menu.append(menuButton('Delete chat', 'trash', guard(async () => {
    if (!await askConfirm(`Delete "${redactCredentials(s.title)}"?`, { title: 'Delete chat' })) return;
    await api('session/delete', { id: s.id });
    dropDraft(s.id);
    if (state.sessionId === s.id) {
      // Its draft went with it, so there is nothing to park.
      state.sessionId = null;
      restoreDraft(null);
      syncBusy();
      syncBrowserPane();
      state.undo = [];
      state.changes = null;
      renderChatChanges();
      resetCtx();
      $('messages').replaceChildren();
    }
    await refreshLists();
  })));

  placeMenu(menu, anchor, point);
}

function openGroupMenu(groupId, anchor) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return;
  const menu = $('chatMenu');
  menu.replaceChildren();
  menu.append(menuButton('Rename group', 'edit', () => askName('Rename group', 'Group name', g.name, guard(async (v) => {
    await api('group/rename', { id: g.id, name: v });
    await refreshLists();
  }))));
  menu.append(menuButton('Delete group', 'trash', guard(async () => {
    if (!await askConfirm(`Delete group "${g.name}"?

Chats inside become ungrouped.`, { title: 'Delete group' })) return;
    await api('group/delete', { id: g.id });
    await refreshLists();
  })));
  placeMenu(menu, anchor, null);
}

// ------------------------------------------------------------ confirm ------

// The app runs in a bare WebView2 window, so a native confirm() would paint a
// chrome-styled popup over it. This keeps every yes/no question inside Skadi.
let confirmResolve = null;

function askConfirm(text, { title = 'Confirm', ok = 'Delete', danger = true } = {}) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  const okBtn = $('confirmOk');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  $('confirmVeil').hidden = false;
  setTimeout(() => okBtn.focus(), 0);
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(answer) {
  if ($('confirmVeil').hidden) return;
  $('confirmVeil').hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(answer);
}

// ------------------------------------------------------------- prompt ------

let promptCallback = null;

function askName(title, label, initial, onSave) {
  $('promptTitle').textContent = title;
  $('promptLabel').textContent = label;
  $('promptInput').value = initial || '';
  promptCallback = onSave;
  $('promptVeil').hidden = false;
  setTimeout(() => { $('promptInput').focus(); $('promptInput').select(); }, 0);
}

function closePrompt() {
  $('promptVeil').hidden = true;
  promptCallback = null;
}

async function savePrompt() {
  const v = $('promptInput').value.trim();
  if (!v) { $('promptInput').focus(); return; }
  const cb = promptCallback;
  closePrompt();
  if (cb) await cb(v);
}

// ============================================================================
// Built-in folder picker
//
// An in-app modal for choosing a project folder: places (workspace, home,
// drives), a path bar, a clickable subfolder list and create-folder. No
// native dialog ever opens; everything goes through dir/list and dir/mkdir.
// ============================================================================

const folderBrowser = { path: null, onPick: null };

async function openFolderBrowser(startPath, onPick) {
  folderBrowser.onPick = onPick || null;
  folderBrowser.path = null;
  $('folderVeil').hidden = false;
  $('folderList').replaceChildren(el('p', 'hint', 'Loading…'));
  let places;
  try {
    places = await api('drives');
  } catch (err) {
    $('folderList').replaceChildren(el('p', 'hint', err.message));
    return;
  }
  const box = $('folderPlaces');
  box.replaceChildren();
  const placeBtn = (label, path) => {
    const b = el('button', 'btn tiny');
    b.type = 'button';
    b.textContent = label;
    b.title = path;
    b.onclick = () => loadFolderDir(path);
    return b;
  };
  box.append(placeBtn('Workspace', places.workspace));
  box.append(placeBtn('Home', places.home));
  for (const d of places.drives || []) box.append(placeBtn(d, d));
  await loadFolderDir(startPath || places.workspace);
}

async function loadFolderDir(path) {
  const list = $('folderList');
  list.replaceChildren(el('p', 'hint', 'Loading…'));
  try {
    const dir = await api(`dir/list?path=${encodeURIComponent(path)}`);
    folderBrowser.path = dir.path;
    $('folderPath').value = dir.path;
    const up = $('folderUp');
    up.disabled = !dir.parent;
    up.onclick = () => { if (dir.parent) loadFolderDir(dir.parent); };
    list.replaceChildren();
    if (!dir.entries.length) list.append(el('p', 'hint', 'No subfolders'));
    for (const e of dir.entries) {
      const row = el('button', 'folder-row');
      row.type = 'button';
      row.title = e.path;
      row.append(icon('folder'));
      row.append(el('span', 'folder-name', e.name));
      row.onclick = () => loadFolderDir(e.path);
      list.append(row);
    }
    if (dir.truncated) list.append(el('p', 'hint', '…showing first 2000'));
  } catch (err) {
    list.replaceChildren(el('p', 'hint', err.message));
  }
}

function closeFolderBrowser() {
  $('folderVeil').hidden = true;
  folderBrowser.onPick = null;
}

function wireFolderBrowser() {
  $('folderClose').onclick = closeFolderBrowser;
  $('folderCancel').onclick = closeFolderBrowser;
  $('folderVeil').addEventListener('mousedown', (e) => {
    if (e.target === $('folderVeil')) closeFolderBrowser();
  });
  $('folderUp').onclick = () => {};
  $('folderGo').onclick = () => loadFolderDir($('folderPath').value.trim());
  $('folderPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFolderDir($('folderPath').value.trim());
    e.stopPropagation();
  });
  $('folderMkdir').onclick = guard(async () => {
    const name = $('folderNewName').value.trim();
    if (!name || !folderBrowser.path) return;
    const dir = await api('dir/mkdir', { path: folderBrowser.path, name });
    $('folderNewName').value = '';
    folderBrowser.path = dir.path;
    $('folderPath').value = dir.path;
    await loadFolderDir(dir.path);
  });
  $('folderNewName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('folderMkdir').click();
    e.stopPropagation();
  });
  $('folderSelect').onclick = guard(async () => {
    const cb = folderBrowser.onPick;
    const path = folderBrowser.path;
    if (!cb || !path) { closeFolderBrowser(); return; }
    closeFolderBrowser();
    await cb(path);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('folderVeil').hidden) closeFolderBrowser();
  });
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

/** Message content may be a string or multimodal blocks. */
function contentToText(content) {
  if (typeof content === 'string' || content == null) return content || '';
  return content.filter((b) => b.type !== 'image').map((b) => b.text).join('\n');
}

/** Thumbnails for the image blocks in a multimodal content array, or null. */
function contentToThumbs(content) {
  if (!Array.isArray(content)) return null;
  const images = content.filter((b) => b.type === 'image' && b.data);
  if (!images.length) return null;
  const wrap = el('div', 'msg-attachments');
  for (const b of images) {
    const img = el('img', 'msg-thumb');
    img.src = `data:${b.mediaType};base64,${b.data}`;
    wrap.append(img);
  }
  return wrap;
}

async function openSession(id) {
  const session = await api(`session?id=${encodeURIComponent(id)}`);
  // Nothing below can run without a transcript, and everything below has
  // already changed the window when it finds that out. A chat deleted from
  // another window, a half-written file, an endpoint that answered with
  // something else: refuse here, while the chat on screen is still whole,
  // rather than switching to a chat that cannot be drawn and leaving the rail
  // pointing at it.
  if (!session || !Array.isArray(session.messages)) {
    throw new Error('That chat could not be read — it may have been deleted.');
  }
  // Hand the composer over before the chat changes under it: what you typed
  // stays with the chat you typed it in.
  if (id !== state.sessionId) stashDraft();
  const switched = id !== state.sessionId;
  state.sessionId = id;
  if (switched) restoreDraft(id);
  followChatChoice(session);
  state.undo = session.undo || [];
  // The bar belongs to the chat, so it is replaced with it rather than
  // left showing the last chat's figures.
  state.changes = session.changes || null;
  acceptPlan(session.plan);
  renderChatChanges();
  // The browser belongs to the chat: show this one's, not the last one's.
  syncBrowserPane();
  // Opening marks it read.
  const cached = sessionById(id);
  if (cached?.unread) {
    api('session/update', { id, patch: { unread: false } })
      .then(refreshLists)
      .catch(() => {});
    cached.unread = false;
    renderChatList();
  }
  $('messages').replaceChildren();
  // The old chat's bubbles are gone with it -- including the one `stats` and
  // the live renderer write into. Left set, they would keep writing into a
  // node that is no longer in the document.
  state.streaming = null;
  state.compacting = null;
  state.lastAssistant = null;
  // Meter from the stored transcript until the next turn reports real usage.
  // The server's figure counts the live transcript -- what the model actually
  // carries, with an image costed as an image rather than as the length of its
  // base64 -- so anything compaction has already archived is rightly left out.
  // Cleared first: the previous chat's reading is not this one's.
  resetCtx();
  renderCtx(session.estimatedTokens ?? null, null);

  // Tool results arrive as their own messages, but belong to the call that
  // produced them -- fold them back into that card.
  const cards = new Map();
  for (const m of session.messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const card = cards.get(m.tool_call_id);
      const ok = !String(m.content ?? '').startsWith('Error:');
      if (card) {
        card.classList.remove('pending');
        card.classList.add(ok ? 'ok' : 'err');
        card.querySelector('.out').textContent = String(m.content ?? '').slice(0, 8000);
        updateFileChip(card, { content: m.content });
      } else {
        addTool('result', null, { content: m.content, ok });
      }
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls) {
      // Text first, then the calls it introduced -- the order it streamed in.
      if (m.content) addMessage('assistant', contentToText(m.content));
      for (const c of m.tool_calls) {
        const card = addTool(c.function.name, safeJson(c.function.arguments), null);
        card.dataset.callId = c.id;
        cards.set(c.id, card);
      }
      continue;
    }
    addMessage(m.role, contentToText(m.content), contentToThumbs(m.content));
  }
  // Reopening a chat whose turn is still running: the saved transcript stops
  // at the user's message, so put the live part back on screen rather than
  // leaving the answer to reappear only once the turn ends.
  replayLive(id);
  syncBusy();
  renderOutcomeBar();
  scrollDown(true);
  // The rail is a nicety here; the transcript is already on screen, and a
  // failed refresh must not read as a failure to open the chat.
  refreshLists().catch(() => {});
}

// ============================================================================
// Skill & memory editors
//
// Skills and memory now live in Settings, not the rail. The lists below are
// catalogue rows; clicking one opens the full item here, where its body can
// be read and edited. Same stores the agent tools use, so what you write is
// what the model loads next session.
// ============================================================================

const MEMORY_TYPES = ['user', 'project', 'feedback', 'reference'];
const editor = { kind: null, previousName: null, fields: {} };

function editorField(label, input) {
  const wrap = el('div', 'field');
  wrap.append(el('label', null, label), input);
  return wrap;
}

function editorInput(value, rows = 1) {
  const input = rows > 1 ? el('textarea') : el('input');
  if (rows > 1) input.rows = rows;
  else input.type = 'text';
  input.value = value ?? '';
  return input;
}

function openEditor(kind, item) {
  editor.kind = kind;
  editor.previousName = item?.name ?? null;
  editor.fields = {};
  const isNew = !item;
  $('editorTitle').textContent = kind === 'skill'
    ? (isNew ? 'New skill' : `Skill: ${item.name}`)
    : (isNew ? 'New memory' : `Memory: ${item.name}`);
  $('editorDelete').hidden = isNew;

  const fields = $('editorFields');
  fields.replaceChildren();
  const add = (label, input, key) => {
    editor.fields[key] = input;
    fields.append(editorField(label, input));
  };
  add('Name (kebab-case)', editorInput(item?.name), 'name');
  add('Description (one line — this is the catalogue row)', editorInput(item?.description), 'description');
  if (kind === 'memory') {
    const select = el('select');
    for (const t of MEMORY_TYPES) {
      const opt = el('option', null, t);
      opt.value = t;
      select.append(opt);
    }
    select.value = item?.type || 'project';
    add('Type', select, 'type');
    add('Content (Markdown)', editorInput(item?.body, 12), 'body');
  } else {
    fields.append(el('p', 'hint', 'Saved as skills/<name>/SKILL.md. Only the name and description enter the prompt; the model loads the body on demand.'));
    add('Body (Markdown instructions)', editorInput(item?.body, 14), 'body');
  }
  $('editorVeil').hidden = false;
  editor.fields.name.focus();
}

function closeEditor() {
  $('editorVeil').hidden = true;
  editor.kind = null;
  editor.previousName = null;
  editor.fields = {};
}

async function saveEditor() {
  const { kind, previousName, fields } = editor;
  if (!kind) return;
  const name = fields.name.value.trim();
  const description = fields.description.value.trim();
  const body = fields.body.value.trim();
  if (!name) throw new Error('name is required');
  if (!body) throw new Error('body is required');
  if (kind === 'skill') {
    await api('skill/save', { name, description, body, previousName });
  } else {
    await api('memory/save', { name, description, type: fields.type.value, content: body });
  }
  closeEditor();
  if (!$('settingsVeil').hidden) renderSettingsPane();
}

async function deleteEditor() {
  const { kind, previousName } = editor;
  if (!kind || !previousName) return;
  if (!await askConfirm(`Delete ${kind} "${previousName}"?`, { title: `Delete ${kind}` })) return;
  await api(kind === 'skill' ? 'skill/delete' : 'memory/delete', { name: previousName });
  closeEditor();
  if (!$('settingsVeil').hidden) renderSettingsPane();
}

async function openSkill(name) {
  openEditor('skill', await api(`skill?name=${encodeURIComponent(name)}`));
}

async function openMemory(name) {
  const all = await api('memory');
  const hit = all.find((m) => m.name === name);
  if (!hit) throw new Error(`memory "${name}" is gone; the list will refresh`);
  openEditor('memory', hit);
}

/**
 * Reflect the open chat's state in the composer. Busy is per chat now: a turn
 * running in another chat leaves this one fully usable.
 */
function setBusy(busy) {
  document.body.classList.toggle('generating', busy);
  if (busy) {
    activeTurnStartedAt ||= Date.now();
    activeTurnText ||= 'Starting…';
  } else {
    activeTurnStartedAt = 0;
    activeTurnText = '';
  }
  // The composer stays live while the model works: a message sent now is a
  // steer -- it joins the running turn instead of waiting for the next one.
  // Compact mid-turn is a 409 (the transcript is moving under it); make that
  // unpressable instead of answering with a red error.
  $('btnCompact').disabled = busy;
  $('btnWebSearch').disabled = busy;
  $('btnSubagents').disabled = busy;
  // The composer's send button flips into the stop control: same button,
  // different role — red square while a turn runs, accent arrow when idle.
  const send = $('btnSend');
  send.classList.toggle('stop', busy);
  send.querySelector('use').setAttribute('href', busy ? '#i-stop' : '#i-send');
  send.title = busy ? 'Stop generating' : 'Send';
  send.setAttribute('aria-label', send.title);
  $('input').placeholder = busy
    ? 'Steer the agent — your message joins this turn…'
    : 'Ask Skadi to do something in your project…';
  if (!busy) {
    $('roundInfo').textContent = '';
    setActivity(null);
  }
  renderTurnStatus();
  renderOutcomeBar();
}

/** Is the chat on screen mid-turn? */
const isBusy = () => document.body.classList.contains('generating');

/** Re-apply the composer state for whichever chat is on screen. */
function syncBusy() {
  setBusy(state.running.has(state.sessionId));
  renderApproval();
}

/** A chat's title, short enough for a toast. */
function shortTitle(sessionId) {
  const t = redactCredentials(sessionById(sessionId)?.title || 'Another chat');
  return t.length > 32 ? `${t.slice(0, 32)}…` : t;
}

/**
 * Show the approval the open chat is waiting on, if any. Approvals are held
 * per chat: a background turn asking for permission must not hijack the card
 * of the chat you are reading, and it is still there when you switch to it.
 */
function renderApproval() {
  const pending = state.approvals.get(state.sessionId);
  const card = $('approval');
  card.hidden = !pending;
  if (!pending) return;
  card.dataset.callId = pending.id;
  card.dataset.sessionId = state.sessionId;
  $('approvalTitle').textContent = `Allow ${pending.name}?`;
  $('approvalArgs').textContent = JSON.stringify(pending.args, null, 2);
  if (isPendingView(state.sessionId)) setActivity(`Waiting for approval: ${pending.name}…`);
}

/** Mark a chat running or idle: composer, and the dot in the rail. */
function setRunning(sessionId, running) {
  if (!sessionId) return;
  if (running) state.running.add(sessionId);
  else state.running.delete(sessionId);
  if (sessionId === state.sessionId) syncBusy();
  renderChatList();
}

// ============================================================================
// Event stream
// ============================================================================

// Every agent event names its session. An event for a chat other than the one
// on screen is still recorded -- just not rendered into someone else's
// transcript.
function isPendingView(sessionId) {
  return sessionId != null && sessionId === state.sessionId;
}

// ----------------------------------------------------------------------------
// Live turn buffer.
//
// The server saves every message as it is appended, but the message being
// *streamed* exists only in this window until the round closes. Switching to
// another chat and back used to wipe it: the half-written answer -- or the
// reasoning it was still in the middle of -- simply vanished until the turn
// finished. So each live event is recorded here as it is rendered, and
// openSession replays the buffer through the very same renderer.
//
// The buffer holds only what is NOT yet on disk. The server persists a
// message before emitting the event that announces it, so `stats`,
// `tool_result` and `compact_end` each mean "everything so far is saved" --
// and the buffer is cleared there, leaving exactly the streaming remainder.
// Replaying more than that would double-render the saved transcript.
// ----------------------------------------------------------------------------
// One buffer per running chat, so a turn in the background keeps its place
// while you read another chat.
const buffers = new Map(); // sessionId -> { events, startedAt }
// A pathological turn can emit tens of thousands of token deltas; coalescing
// text into the previous entry keeps the buffer flat instead of unbounded.
const LIVE_MAX_EVENTS = 4000;

function bufferFor(sessionId) {
  let b = buffers.get(sessionId);
  if (!b) buffers.set(sessionId, (b = { events: [], startedAt: null }));
  return b;
}

function resetLive(sessionId) {
  buffers.delete(sessionId);
}

function recordLive(sessionId, type, data) {
  if (!sessionId) return;
  const live = bufferFor(sessionId);
  // When the first chunk of this round was really produced. Replay hands the
  // whole buffer over at once; without the original clock the live rate would
  // divide a round's worth of characters by the age of the replay -- a wild
  // number that then decays to the true one as time passes.
  if (type === 'token' || type === 'reasoning') live.startedAt ??= Date.now();
  const last = live.events[live.events.length - 1];
  if (last && last.type === type && (type === 'token' || type === 'reasoning')) {
    last.data += data;
    return;
  }
  live.events.push({ type, data });
  if (live.events.length > LIVE_MAX_EVENTS) live.events.splice(0, live.events.length - LIVE_MAX_EVENTS);
}

/**
 * Render one agent event into the transcript. Called live as events arrive
 * and again, in order, when a mid-turn chat is reopened -- so what comes back
 * on screen is exactly what was there before the user navigated away.
 */
function applyAgentEvent(type, d, startedAt = null) {
  if (type === 'round') {
    beginAssistant();
    return;
  }
  if (type === 'reasoning') {
    const s = state.streaming || (beginAssistant(), state.streaming);
    s.startedAt ??= startedAt ?? Date.now();
    s.chars += d.length;
    s.thinkEl.hidden = false;
    // Open the reasoning pane while it streams so thinking is visible live.
    s.thinkEl.open = true;
    s.thinkBody.textContent += d;
    s.thinkBody.scrollTop = s.thinkBody.scrollHeight;
    setActivity('Thinking…');
    tickLiveRate();
    scrollDown();
    return;
  }
  if (type === 'token') {
    if (!state.streaming) beginAssistant();
    const s = state.streaming;
    s.startedAt ??= startedAt ?? Date.now();
    s.chars += d.length;
    s.raw += d;
    setActivity('Writing…');
    tickLiveRate();
    scheduleRender();
    return;
  }
  if (type === 'stats') {
    setMeta(state.lastAssistant, d);
    renderCtx(d.promptTokens, d.contextTokens);
    return;
  }
  if (type === 'tool_call') {
    state.streaming = null;
    addTool(d.name, d.args, null).dataset.callId = d.id;
    return;
  }
  if (type === 'tool_result') {
    const card = [...document.querySelectorAll('.tool')].reverse().find((x) => x.dataset.callId === d.id);
    if (!card) { addTool(d.name, null, d); return; }
    card.classList.remove('pending');
    card.classList.add(d.ok ? 'ok' : 'err');
    card.querySelector('.ms').textContent = d.ms != null ? `${d.ms}ms` : '';
    card.querySelector('.out').textContent = String(d.content ?? '').slice(0, 8000);
    // The server snapshot for this edit exists from here on; track it so the
    // Undo button appears without reopening the session (openSession and the
    // undo response reconcile with the server as source of truth).
    if (d.ok && (d.name === 'edit_file' || d.name === 'write_file') && card.dataset.path) {
      if (!state.undo.some((u) => u.callId === d.id)) {
        state.undo.push({ callId: d.id, path: card.dataset.path });
      }
    }
    updateFileChip(card, d);
    if (!d.ok) {
      // A failure is the one thing worth seeing without asking.
      setCardOpen(card, true);
      const group = card.closest('.tool-group');
      if (group) setToolGroupOpen(group, true);
    }
    scrollDown();
    return;
  }
  if (type === 'compact_progress') {
    // The summary is a real assistant message that will persist: stream it
    // into a bubble of its own, reasoning into the think pane. agent_done
    // re-opens the session afterwards, so this preview is replaced by the
    // canonical render — never duplicated. It goes above the prompt that
    // triggered the turn, matching where the saved transcript keeps it.
    if (!state.compacting) beginCompaction();
    const c = state.compacting;
    if (d.reasoning) {
      c.thinkEl.hidden = false;
      c.thinkBody.textContent += d.reasoning;
      c.thinkBody.scrollTop = c.thinkBody.scrollHeight;
    }
    if (d.text) {
      c.raw += d.text;
      scheduleCompactRender();
    }
    scrollDown();
  }
}

// Events that arrive only after the server has written the transcript, so
// everything buffered before them is now redundant with the saved file.
// `tool_call` included: the assistant message that carries the call is saved
// before the call is announced, so a reopened chat already renders the pending
// card from the file -- replaying it too would show the tool twice.
const PERSISTED_AFTER = new Set(['stats', 'tool_call', 'tool_result']);

/** Record an event against its chat, and render it if that chat is open. */
function liveEvent(type, d, payload = d) {
  const sessionId = d?.sessionId ?? null;
  if (PERSISTED_AFTER.has(type)) resetLive(sessionId);
  else recordLive(sessionId, type, payload);
  if (isPendingView(sessionId)) applyAgentEvent(type, payload, buffers.get(sessionId)?.startedAt ?? null);
}

/** Put a reopened mid-turn chat back exactly where the live stream had it. */
function replayLive(sessionId) {
  const live = buffers.get(sessionId);
  if (!live) return;
  state.streaming = null;
  state.compacting = null;
  for (const ev of live.events) applyAgentEvent(ev.type, ev.data, live.startedAt);
}

/**
 * Whether the server is still there. An EventSource reconnects on its own, but
 * until it does the window keeps showing whatever the last frame said -- a turn
 * mid-retry, a chat marked "working…" -- for a backend that may be gone. After
 * a short grace period (so a blink does not flap the UI) the window stops
 * claiming anything is running and says it lost the server.
 */
let offlineTimer = 0;

function markOffline() {
  if (state.online === false) return;
  state.online = false;
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => {
    if (state.online) return;
    $('offlineBar').hidden = false;
    // Nothing can be running in a server we cannot reach.
    state.running.clear();
    syncBusy();
    renderChatList();
  }, 3000);
}

async function markOnline() {
  clearTimeout(offlineTimer);
  const wasOffline = state.online === false;
  state.online = true;
  $('offlineBar').hidden = true;
  if (!wasOffline) return;
  // Re-read the world: anything could have changed while we were blind.
  try {
    const s = await api('state');
    state.settings = s.settings;
    await renderProviders(s.providers, s.activeProvider);
    setInstances(s.instances);
    for (const id of s.turns || []) setRunning(id, true);
    await refreshLists();
  } catch {
    // The server answered the stream but not this; the next event will retry.
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => { markOnline(); });
  es.addEventListener('error', () => {
    // Fired for a dropped connection *and* for a failed reconnect attempt.
    if (es.readyState !== EventSource.OPEN) markOffline();
  });

  es.addEventListener('update', () => refreshUpdate().catch(() => {}));
  es.addEventListener('vram', (e) => renderVram(JSON.parse(e.data)));
  es.addEventListener('server_state', (e) => { applyInstance(JSON.parse(e.data)); refreshModels(); });
  es.addEventListener('measured', () => selectProfile(state.editing));
  es.addEventListener('download', (e) => onDownloadEvent(JSON.parse(e.data).job));
  es.addEventListener('models_changed', () => refreshModels());
  // Profiles came or went on the server -- a model's default settings were
  // dropped on eject, or saved. Take its word for what exists now.
  es.addEventListener('profiles_changed', async (e) => {
    state.config = JSON.parse(e.data).config;
    if (!state.config.profiles[state.editing]) {
      await reselectAfterRemoval().catch(() => {});
    } else {
      applyProfileLock(state.editing);
      renderProfileSelect();
    }
    renderLoadedList([...state.instances.values()]);
  });
  es.addEventListener('screenshot', (e) => {
    const shot = JSON.parse(e.data);
    // A screenshot belongs to the chat whose agent took it.
    if (shot.sessionId && shot.sessionId !== state.sessionId) return;
    addScreenshot(shot.name);
  });

  es.addEventListener('browser_status', (e) => {
    const s = JSON.parse(e.data);
    // Another chat's browser: its status is none of this pane's business.
    if (s.key && s.key !== browserKey()) return;
    applyBrowserStatus(s);
  });

  es.addEventListener('web_search_status', (e) => {
    const status = JSON.parse(e.data);
    if (status.state === 'ready') toast(`Local SearXNG is ready at ${status.url}`);
    if (status.state === 'error') toast(status.error || 'Local SearXNG failed to start.');
  });

  // A draft chat was saved: its browser moved onto the new session id.
  es.addEventListener('browser_rekey', (e) => {
    const { from, to } = JSON.parse(e.data);
    if (state.browserStreamKey !== from) return;
    state.browserStreamKey = to;
    if (browserKey() === to && isBrowserOpen()) {
      closeBrowserStream();
      openBrowserStream();
    }
  });

  es.addEventListener('server_log', (e) => {
    const box = $('logBox');
    box.textContent += `${logLine(JSON.parse(e.data))}\n`;
    if (box.textContent.length > 60000) box.textContent = box.textContent.slice(-40000);
    box.scrollTop = box.scrollHeight;
  });

  es.addEventListener('throughput', (e) => {
    const t = JSON.parse(e.data);
    const inst = state.instances.get(t.id);
    if (inst) {
      inst.throughput = t;
      renderLoadedFacts(inst);
    }
    const bits = [];
    if (state.instances.size > 1 && inst) bits.push(instanceName(inst));
    if (t.prompt) bits.push(`prefill ${t.prompt.toFixed(0)} t/s`);
    if (t.decode) bits.push(`decode ${t.decode.toFixed(1)} t/s`);
    if (t.draftAccept != null) bits.push(`draft ${(t.draftAccept * 100).toFixed(0)}%`);
    $('throughput').textContent = bits.join('  ·  ');
  });

  es.addEventListener('agent_round', (e) => {
    const d = JSON.parse(e.data);
    setRunning(d.sessionId, true);
    if (isPendingView(d.sessionId)) {
      const phase = ({ locate: 'Locating', diagnose: 'Diagnosing', implement: 'Building', verify: 'Verifying', complete: 'Finishing' })[d.phase] || 'Working';
      const count = d.maxRounds > 0 ? `round ${d.round} of ${d.maxRounds}` : `round ${d.round}`;
      const label = `${phase} · ${count}`;
      $('roundInfo').textContent = label;
      setActivity(`Working… ${label}`);
    }
    liveEvent('round', d);
  });

  es.addEventListener('agent_progress', (e) => {
    const d = JSON.parse(e.data);
    if (!isPendingView(d.sessionId)) return;
    const phase = ({ locate: 'Locating', diagnose: 'Diagnosing', implement: 'Building', verify: 'Verifying', complete: 'Finishing' })[d.phase] || 'Working';
    const facts = [`${d.edits || 0} deliverable edit${d.edits === 1 ? '' : 's'}`];
    if (d.verifications) facts.push(`${d.verifications} verification${d.verifications === 1 ? '' : 's'}`);
    if (d.gaps?.length) facts.push(`${d.gaps.length} open gap${d.gaps.length === 1 ? '' : 's'}`);
    setActivity(`${phase} — ${facts.join(' · ')}`);
  });

  // A retry means the provider bounced the request (rate limit, gateway
  // error) and Skadi is waiting to send it again. Nothing has been streamed
  // yet, so this is a status line, not transcript.
  es.addEventListener('agent_retry', (e) => {
    const d = JSON.parse(e.data);
    if (!isPendingView(d.sessionId)) return;
    const secs = Math.round(d.delayMs / 100) / 10;
    setActivity(`Provider returned ${d.status} — retrying in ${secs}s (attempt ${d.attempt} of ${d.attempts})…`);
  });

  es.addEventListener('agent_steer', (e) => {
    const d = JSON.parse(e.data);
    if (!isPendingView(d.sessionId)) return;
    setActivity(d.queued > 1
      ? `Steering (${d.queued} queued) — the agent picks these up at its next step…`
      : 'Steering — the agent picks this up at its next step…');
  });

  // Token and reasoning deltas travel as { text, sessionId }; the renderer
  // wants the text itself.
  es.addEventListener('agent_reasoning', (e) => {
    const d = JSON.parse(e.data);
    liveEvent('reasoning', d, d.text ?? '');
  });

  es.addEventListener('agent_token', (e) => {
    const d = JSON.parse(e.data);
    liveEvent('token', d, d.text ?? '');
  });

  // The authoritative rate, once the round closes.
  es.addEventListener('agent_stats', (e) => liveEvent('stats', JSON.parse(e.data)));

  es.addEventListener('agent_tool_call', (e) => {
    const d = JSON.parse(e.data);
    if (isPendingView(d.sessionId)) setActivity(`Running ${d.name}…`);
    liveEvent('tool_call', d);
    // Watching the agent drive the page is the point of the browser pane.
    // It docks beside the chat; the turn stays visible, and focus is left
    // alone so typing in the composer is never interrupted.
    if (d.name.startsWith('browser_') && !isBrowserOpen()) setBrowserOpen(true);
  });

  es.addEventListener('agent_tool_result', (e) => {
    const d = JSON.parse(e.data);
    if (isPendingView(d.sessionId)) setActivity(d.ok
      ? `Finished ${d.name} — deciding the next step…`
      : `Recovering from a failed ${d.name} call — reading the error and adapting…`);
    liveEvent('tool_result', d);
  });

  es.addEventListener('agent_subagent', (e) => {
    const d = JSON.parse(e.data);
    if (!isPendingView(d.sessionId)) return;
    if (d.state === 'running') setActivity(`Research subagent (${d.reasoning || 'none'} reasoning)…`);
    else if (d.state === 'done') setActivity('Subagent report received — parent agent is continuing…');
    else setActivity(`Subagent unavailable — parent agent is continuing${d.error ? `: ${d.error}` : '…'}`);
  });

  es.addEventListener('agent_loop_detected', (e) => {
    const d = JSON.parse(e.data);
    if (!isPendingView(d.sessionId)) return;
    setActivity(`Loop corrected — ${d.next || 'redirecting to the shortest path…'}`);
  });

  es.addEventListener('agent_loop_review_error', (e) => {
    const d = JSON.parse(e.data);
    if (isPendingView(d.sessionId)) setActivity('Progress review unavailable — continuing normally…');
  });

  es.addEventListener('agent_approval_request', (e) => {
    const d = JSON.parse(e.data);
    // Held per chat: a turn waiting in a background chat must not replace the
    // card of the one you are looking at. Switching chats shows its own.
    state.approvals.set(d.sessionId, d);
    renderApproval();
    if (!isPendingView(d.sessionId)) toast(`${shortTitle(d.sessionId)} needs approval: ${d.name}`);
  });

  es.addEventListener('agent_done', async (e) => {
    if (filesPaneActive()) refreshFilesTab().catch(() => {});
    const outcome = JSON.parse(e.data || '{}');
    const finishedSessionId = outcome.sessionId ?? null;
    if (finishedSessionId) state.outcomes.set(finishedSessionId, outcome);
    // The transcript is on disk now, so the live buffer has nothing left to
    // protect; keeping it would replay the turn on top of the saved render.
    resetLive(finishedSessionId);
    state.approvals.delete(finishedSessionId);
    setRunning(finishedSessionId, false);
    compactedThisTurn = false;
    // If the finished turn belongs to the chat on screen, reload it from the
    // saved transcript -- the source of truth -- rather than trust whatever
    // partial DOM the live stream left behind (nothing, if the user was
    // looking elsewhere while it ran).
    if (finishedSessionId && state.sessionId === finishedSessionId) {
      state.streaming = null;
      state.compacting = null;
      await openSession(state.sessionId);
      renderOutcomeBar();
      return;
    }
    await refreshLists();
  });

  // The model has named a new chat; the rail shows the topic instead of the
  // first words of the message.
  es.addEventListener('session_title', () => { refreshLists().catch(() => {}); });

  es.addEventListener('agent_session', async (e) => {
    const { id, title } = JSON.parse(e.data);
    // A turn that created a session while another one is open leaves the new
    // one unread so it stands out in the rail.
    const prev = state.sessionId;
    // The event means "a turn is starting on this chat" and is sent once, at
    // the start -- the server's `turns` list follows immediately and is
    // authoritative. Marking it here as well is what keeps the composer from
    // blinking out of its busy state while a brand-new chat takes its id.
    setRunning(id, true);
    // Anything still parked under the unsent chat belongs to this one now.
    if (prev === null && drafts.has(null)) {
      drafts.set(id, drafts.get(null));
      drafts.delete(null);
    }
    // Only adopt it as the visible chat if nothing else was open -- if the
    // user has since navigated to another chat, leave that view alone; the
    // new/continuing chat is surfaced via the unread marker below instead.
    // The chat just took its id, so the pane's key changed with it. `browser_rekey`
    // normally has it covered; this heals the case where the pane was open and
    // that event was missed, and costs nothing when the keys already agree.
    if (prev === null) { state.sessionId = id; syncBusy(); syncBrowserPane(); }
    // Optimistic row so a new chat appears instantly, even before the
    // follow-up list fetch lands.
    if (id && !sessionById(id)) {
      state.sessions.unshift({
        id,
        title: title || 'New session',
        projectId: state.activeProject,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: 1,
        pinned: false,
        archived: false,
        unread: Boolean(prev && prev !== id),
        groupId: null,
      });
      renderChatList();
    }
    try {
      await refreshLists();
    } catch {
      /* the optimistic row above still shows; next event retries */
    }
    // The save can land just after our fetch on a fast turn; if the new
    // session is still missing, fetch once more instead of leaving the
    // rail on "No chats in this project".
    if (id && !sessionById(id)) {
      try {
        await new Promise((r) => setTimeout(r, 800));
        await refreshLists();
      } catch { /* optimistic row remains */ }
    }
    const cached = sessionById(id);
    if (cached && prev && prev !== id && !cached.unread) {
      cached.unread = true;
      renderChatList();
      api('session/update', { id, patch: { unread: true } }).catch(() => {});
    }
  });

  // The server's own list of live turns -- authoritative over anything this
  // window inferred from the event stream.
  es.addEventListener('turns', (e) => {
    const { sessionIds } = JSON.parse(e.data);
    state.running = new Set(sessionIds);
    syncBusy();
    renderChatList();
  });

  // Files written during a turn: keep the bar and the chips in step as they
  // land, but only for the chat actually on screen.
  es.addEventListener('edits', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.sessionId) return;
    applyEditState(data);
  });

  es.addEventListener('task_update', () => refreshTasks());
  es.addEventListener('session_plan', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.sessionId) return;
    acceptPlan(data.plan, { announce: true });
  });
  es.addEventListener('task_done', (e) => {
    const { task } = JSON.parse(e.data);
    refreshTasks();
    toast(`Background task finished (exit ${task.exitCode ?? '?'}): ${task.command.slice(0, 90)}`);
    // The completion note landed in the session transcript; pull it into view
    // when it belongs to the open session and no turn is running over it.
    if (task.sessionId && task.sessionId === state.sessionId && !isBusy()) {
      openSession(state.sessionId).catch(() => {});
    }
  });

  es.addEventListener('agent_error', (e) => {
    const { error, sessionId } = JSON.parse(e.data);
    // A turn that failed before its chat existed -- no provider, no key --
    // names no session. That failure belongs to the unsent chat, and it is on
    // screen exactly when no other chat is.
    const draft = sessionId == null;
    if (draft ? state.sessionId == null : isPendingView(sessionId)) {
      addMessage('error', error);
      state.streaming = null;
      state.compacting = null;
    } else {
      toast(`Chat error: ${error}`);
    }
    resetLive(sessionId);
    state.approvals.delete(sessionId);
    setRunning(sessionId, false);
    // setRunning keys off a session id, so the unsent chat has to be released
    // by hand -- otherwise the composer stays on “Stop generating” for good.
    if (draft && state.sessionId == null) setBusy(false);
  });

  es.addEventListener('agent_compact_start', (e) => {
    if (!isPendingView(JSON.parse(e.data || '{}').sessionId)) return;
    $('roundInfo').textContent = 'compacting context…';
    setActivity('Compacting context…');
  });

  es.addEventListener('agent_compact_progress', (e) => {
    const d = JSON.parse(e.data);
    if (isPendingView(d.sessionId)) {
      $('roundInfo').textContent = `compacting context… ${(d.chars / 1000).toFixed(1)}k chars summarised`;
    }
    liveEvent('compact_progress', d);
  });

  es.addEventListener('agent_compact_end', (e) => {
    const d = JSON.parse(e.data);
    // The rewritten transcript is on disk; the streamed summary preview in
    // the buffer is now part of the saved file.
    if (d.compacted) resetLive(d.sessionId);
    // This summary is finished. Releasing the bubble means a second
    // compaction later in the session writes its own instead of appending to
    // the first one'''s text.
    state.compacting = null;
    if (!isPendingView(d.sessionId)) return;
    if (d.compacted) {
      compactedThisTurn = true;
      renderCtx(d.after, d.contextTokens);
      $('roundInfo').textContent = `compacted ${num(d.before)} → ${num(d.after)} tokens`;
    } else {
      $('roundInfo').textContent = `compaction skipped: ${d.reason}`;
    }
  });
}

// Set when a turn compacted, so agent_done re-syncs the pane afterwards.
let compactedThisTurn = false;

let rateTimer = 0;
function tickLiveRate() {
  if (rateTimer) return;
  rateTimer = setTimeout(() => {
    rateTimer = 0;
    const rate = liveRate(state.streaming);
    if (rate) $('roundInfo').textContent = `~${rate.toFixed(1)} tok/s`;
  }, 400);
}

// ============================================================================
// Wiring
// ============================================================================

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { addMessage('error', err.message); }
};

$('btnRestart').onclick = guard(() => api('server/restart', { profileId: state.editing }));
$('btnFit').onclick = guard(async () => {
  const res = await api('profile/fit', { profileId: state.editing, apply: true });
  state.config = res.config;
  // Re-render the fields so the new context and layer counts show up in them,
  // not just in the forecast above.
  await selectProfile(state.editing);
  const caveat = res.busyWith
    ? ` Fitted while ${res.busyWith} still holds the card — stop it and fit again for the exact numbers.`
    : '';
  $('fitHint').textContent =
    (res.changed
      ? `${res.steps.join('; ')} — via ${res.via}. Apply & restart to load it.`
      : 'Already fits; nothing changed.') + caveat;
});
// Stops the chat on screen, not every chat that happens to be running. The
// button is still type="submit" so Enter can keep steering a running turn;
// a click while busy has to claim the stop action and block the submit.
$('btnSend').onclick = (e) => {
  if (!isBusy()) return;
  e.preventDefault();
  stopTurn();
};
let stopping = false;
async function stopTurn() {
  // One request per press: mashing the button used to stack a red error per click.
  if (stopping) return;
  stopping = true;
  const id = state.sessionId;
  try {
    await api('abort', { sessionId: id });
  } catch (err) {
    // A network failure (fetch throws TypeError) means the server is not
    // answering, so no turn of ours is running there. Say so once and let the
    // composer go idle instead of leaving a stop button that cannot stop.
    if (err instanceof TypeError) {
      state.running.delete(id);
      syncBusy();
      markOffline();
      addMessage('error', 'Lost the server, so nothing is running. Stopped.');
    } else {
      addMessage('error', err.message);
    }
  } finally {
    stopping = false;
  }
}
$('btnSettings').onclick = () => openSettings('model');
$('settingsClose').onclick = closeSettings;
$('btnBenchmarks').onclick = () => openBenchmarks();
$('benchClose').onclick = () => closeBenchmarks();
$('benchVeil').addEventListener('mousedown', (e) => {
  if (e.target === $('benchVeil')) closeBenchmarks();
});
$('settingsVeil').addEventListener('mousedown', (e) => {
  if (e.target === $('settingsVeil')) closeSettings();
});
function wireChatPanel() {
  $('chatSearch').addEventListener('input', (e) => {
    state.chatQuery = e.target.value || '';
    renderChatList();
  });
  for (const btn of $('chatFilter').querySelectorAll('button')) {
    btn.onclick = () => {
      state.chatFilter = btn.dataset.filter;
      for (const b of $('chatFilter').querySelectorAll('button')) {
        b.classList.toggle('active', b === btn);
      }
      renderChatList();
    };
  }
  $('btnNewGroup').onclick = () => askName('Create group', 'Group name', '', guard(async (v) => {
    await api('group/create', { name: v });
    await refreshLists();
  }));
  document.addEventListener('click', (e) => {
    const menu = $('chatMenu');
    if (menu && !menu.hidden && !menu.contains(e.target)) closeChatMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('chatMenu').hidden) closeChatMenu();
  });
}

function wireMobileChats() {
  const button = $('btnChats');
  const rail = $('chatRail');
  if (!button || !rail) return;
  const setOpen = (open) => {
    document.body.classList.toggle('mobile-chats-open', open);
    button.classList.toggle('active', open);
    button.setAttribute('aria-pressed', String(open));
  };
  button.onclick = () => setOpen(!document.body.classList.contains('mobile-chats-open'));
  rail.addEventListener('click', (event) => {
    if (window.innerWidth <= 720 && event.target.closest('.chat-row')) setOpen(false);
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 720) setOpen(false); });
}

// ============================================================================
// Resizable left rail (Hermes-style drag divider)
//
// The divider writes --left-w, which the grid reads per breakpoint. The width
// persists in localStorage; double-click resets to the default.
// ============================================================================

const RAIL_MIN = 180;
const RAIL_MAX = 520;
const RAIL_DEFAULT = 236;
const RAIL_KEY = 'skadi.leftW';

function railWidth() {
  const raw = Number(document.documentElement.style.getPropertyValue('--left-w').replace('px', ''));
  if (Number.isFinite(raw) && raw >= RAIL_MIN && raw <= RAIL_MAX) return raw;
  return document.querySelector('.rail.left')?.getBoundingClientRect().width ?? RAIL_DEFAULT;
}

function setRailWidth(px, { save = false } = {}) {
  const w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
  document.documentElement.style.setProperty('--left-w', `${w}px`);
  const gutter = $('gutterLeft');
  if (gutter) gutter.setAttribute('aria-valuenow', String(w));
  if (save) {
    try { localStorage.setItem(RAIL_KEY, String(w)); } catch { /* private mode */ }
  }
  return w;
}

function wireRailResize() {
  const gutter = $('gutterLeft');
  const rail = document.querySelector('.rail.left');
  if (!gutter || !rail) return;

  try {
    const saved = Number(localStorage.getItem(RAIL_KEY));
    if (saved >= RAIL_MIN && saved <= RAIL_MAX) setRailWidth(saved);
  } catch { /* storage unavailable */ }

  let dragging = false;
  let startX = 0;
  let startW = RAIL_DEFAULT;

  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startW = rail.getBoundingClientRect().width;
    gutter.classList.add('dragging');
    document.body.classList.add('resizing-rail');
    try { gutter.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    e.preventDefault();
  });

  gutter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setRailWidth(startW + (e.clientX - startX));
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.classList.remove('resizing-rail');
    setRailWidth(railWidth(), { save: true });
  };
  gutter.addEventListener('pointerup', endDrag);
  gutter.addEventListener('pointercancel', endDrag);

  gutter.addEventListener('dblclick', () => setRailWidth(RAIL_DEFAULT, { save: true }));

  gutter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setRailWidth(railWidth() - step, { save: true }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setRailWidth(railWidth() + step, { save: true }); }
    else if (e.key === 'Home') { e.preventDefault(); setRailWidth(RAIL_MIN, { save: true }); }
    else if (e.key === 'End') { e.preventDefault(); setRailWidth(RAIL_MAX, { save: true }); }
  });

  // Keep a wide rail from squeezing the centre when the window itself shrinks.
  window.addEventListener('resize', () => {
    const layoutW = document.querySelector('.layout')?.getBoundingClientRect().width ?? 0;
    const cap = Math.floor(layoutW * 0.45);
    if (cap >= RAIL_MIN && railWidth() > Math.min(cap, RAIL_MAX)) {
      setRailWidth(Math.min(cap, RAIL_MAX), { save: true });
    }
  });
}

// ============================================================================
// Inspector (right rail): provider, screenshots, GPU, forecast, profile.
//
// Toggleable from the top bar and resizable via its leading-edge divider --
// the mirror image of the left rail gutter: the rail sits right of the
// handle, so dragging towards it shrinks the panel.
// ============================================================================

const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 760;
const INSPECTOR_DEFAULT = 380;
const INSPECTOR_W_KEY = 'skadi.workspaceW';
const INSPECTOR_OPEN_KEY = 'skadi.inspectorOpen';

const isInspectorOpen = () => !document.querySelector('.layout')?.classList.contains('no-inspector');

function setInspectorOpen(open, { save = true } = {}) {
  document.querySelector('.layout')?.classList.toggle('no-inspector', !open);
  const btn = $('btnInspector');
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-pressed', String(open));
  if (save) {
    try { localStorage.setItem(INSPECTOR_OPEN_KEY, open ? '1' : '0'); } catch { /* private mode */ }
  }
}

function inspectorWidth() {
  const raw = Number(document.documentElement.style.getPropertyValue('--right-w').replace('px', ''));
  if (Number.isFinite(raw) && raw >= INSPECTOR_MIN && raw <= INSPECTOR_MAX) return raw;
  return $('inspector')?.getBoundingClientRect().width || INSPECTOR_DEFAULT;
}

function setInspectorWidth(px, { save = false } = {}) {
  const layoutW = document.querySelector('.layout')?.getBoundingClientRect().width ?? 1400;
  const max = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, Math.floor(layoutW * 0.45)));
  const w = Math.min(max, Math.max(INSPECTOR_MIN, Math.round(px)));
  document.documentElement.style.setProperty('--right-w', `${w}px`);
  const gutter = $('gutterRight');
  if (gutter) gutter.setAttribute('aria-valuenow', String(w));
  if (save) {
    try { localStorage.setItem(INSPECTOR_W_KEY, String(w)); } catch { /* private mode */ }
  }
  return w;
}

function wireInspector() {
  const gutter = $('gutterRight');
  const rail = $('inspector');
  if (!gutter || !rail) return;

  try {
    const savedW = Number(localStorage.getItem(INSPECTOR_W_KEY) || localStorage.getItem('skadi.rightW'));
    if (savedW >= INSPECTOR_MIN && savedW <= INSPECTOR_MAX) setInspectorWidth(savedW);
    // Keep the workspace calm by default. The activity panel remains one click away.
    setInspectorOpen(localStorage.getItem(INSPECTOR_OPEN_KEY) === '1', { save: false });
  } catch {
    setInspectorOpen(false, { save: false });
  }

  $('btnInspector').onclick = () => setInspectorOpen(!isInspectorOpen());

  let dragging = false;
  let startX = 0;
  let startW = INSPECTOR_DEFAULT;

  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startW = rail.getBoundingClientRect().width;
    gutter.classList.add('dragging');
    document.body.classList.add('resizing-rail');
    try { gutter.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    e.preventDefault();
  });

  gutter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // The dock sits between Chats and the conversation, so dragging its
    // trailing edge right grows it.
    setInspectorWidth(startW + (e.clientX - startX));
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.classList.remove('resizing-rail');
    setInspectorWidth(inspectorWidth(), { save: true });
  };
  gutter.addEventListener('pointerup', endDrag);
  gutter.addEventListener('pointercancel', endDrag);

  gutter.addEventListener('dblclick', () => setInspectorWidth(INSPECTOR_DEFAULT, { save: true }));

  gutter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setInspectorWidth(inspectorWidth() - step, { save: true }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setInspectorWidth(inspectorWidth() + step, { save: true }); }
    else if (e.key === 'Home') { e.preventDefault(); setInspectorWidth(INSPECTOR_MAX, { save: true }); }
    else if (e.key === 'End') { e.preventDefault(); setInspectorWidth(INSPECTOR_MIN, { save: true }); }
  });

  // A shrinking window must not leave the panel wider than the layout allows.
  window.addEventListener('resize', () => {
    if (!isInspectorOpen()) return;
    const layoutW = document.querySelector('.layout')?.getBoundingClientRect().width ?? 0;
    const cap = Math.min(INSPECTOR_MAX, Math.floor(layoutW * 0.45));
    if (cap >= INSPECTOR_MIN && inspectorWidth() > cap) {
      setInspectorWidth(cap, { save: true });
    }
  });
}

// ============================================================================
// Files tab: the attached project's own files, as a tree.
// Folders load when opened; the filter searches the whole project by name.
// Files with uncommitted changes carry a mark, and so do the folders holding them.
// ============================================================================

const files = {
  project: null,
  root: '',
  dirs: new Map(),   // folder path ('' is the root) -> its entries
  open: new Set(),   // folders shown open
  changed: new Map(), // file path -> 'M' | 'A' | 'D' | '?'
  dirty: new Set(),  // folders that hold a changed file
  timer: 0,
  seq: 0,
};

const filesPaneActive = () => document.querySelector('.files-pane')?.classList.contains('active');

async function loadFolder(path) {
  const res = await api(`fs/tree?path=${encodeURIComponent(path)}`);
  files.dirs.set(path, res);
  if (!path) files.root = res.root;
  return res;
}

async function refreshFilesTab({ force = false } = {}) {
  const tree = $('filesTree');
  // Another project: none of what was open or loaded applies to it.
  if (files.project !== state.activeProject) {
    files.project = state.activeProject;
    files.dirs.clear();
    files.open.clear();
    $('filesFilter').value = '';
    force = true;
  }
  if (force && !files.dirs.size) tree.replaceChildren(el('p', 'hint', 'Loading…'));
  try {
    const open = ['', ...files.open];
    await Promise.all(open.map((p) => loadFolder(p).catch(() => files.dirs.delete(p))));
    if (!files.dirs.has('')) throw new Error('This project folder could not be read.');
  } catch (err) {
    tree.replaceChildren(el('p', 'hint', err.message));
    return;
  }
  // Marks are a nicety: a folder that is not a repository simply has none.
  files.changed.clear();
  files.dirty.clear();
  try {
    const st = await api('git/status');
    for (const f of st.files || []) {
      const code = `${f.index}${f.worktree}`;
      const mark = code.includes('?') ? '?' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : 'M';
      files.changed.set(f.path.replace(/\/$/, ''), mark);
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) files.dirty.add(parts.slice(0, i).join('/'));
    }
  } catch { /* no git here */ }
  $('filesRoot').textContent = files.root || 'Files';
  if ($('filesFilter').value.trim()) await runFilesFilter();
  else renderFilesTree();
}

function treeRow({ name, path, dir, depth, open }) {
  const row = el('button', `tree-row${dir ? ' dir' : ''}`);
  row.type = 'button';
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.setAttribute('role', 'treeitem');
  if (dir) row.setAttribute('aria-expanded', String(Boolean(open)));
  row.title = path;
  row.append(dir ? icon('chevron') : el('span', 'tree-gap'), icon(dir ? 'folder' : 'file'), el('span', 'tree-name', name));
  const mark = dir ? (files.dirty.has(path) ? '•' : '') : files.changed.get(path);
  if (mark) {
    const badge = el('span', `tree-mark${dir ? ' dot' : ''} m-${mark === '•' ? 'dir' : mark === '?' ? 'new' : mark === 'A' ? 'new' : mark === 'D' ? 'del' : 'mod'}`, mark);
    badge.title = dir ? 'Holds changed files' : { M: 'Modified', A: 'Added', D: 'Deleted', '?': 'Not tracked' }[mark];
    row.append(badge);
  }
  if (dir && open) row.classList.add('open');
  return row;
}

function renderFilesTree() {
  const tree = $('filesTree');
  const rows = [];
  const walk = (path, depth) => {
    const dir = files.dirs.get(path);
    if (!dir) return;
    for (const entry of dir.entries) {
      const open = entry.dir && files.open.has(entry.path);
      const row = treeRow({ ...entry, depth, open });
      row.onclick = entry.dir
        ? guard(async () => {
            if (files.open.has(entry.path)) files.open.delete(entry.path);
            else {
              files.open.add(entry.path);
              if (!files.dirs.has(entry.path)) await loadFolder(entry.path);
            }
            renderFilesTree();
          })
        : () => openFileViewer(entry.path);
      rows.push(row);
      if (open) walk(entry.path, depth + 1);
    }
    if (dir.truncated) rows.push(el('p', 'hint tree-note', 'Only the first 1,000 entries are listed. Use the filter to find the rest.'));
  };
  walk('', 0);
  tree.replaceChildren(...(rows.length ? rows : [el('p', 'hint', 'This project has no files yet.')]));
}

async function runFilesFilter() {
  const q = $('filesFilter').value.trim();
  if (!q) { renderFilesTree(); return; }
  const seq = ++files.seq;
  try {
    const { results, truncated } = await api(`fs/find?q=${encodeURIComponent(q)}`);
    if (seq !== files.seq) return; // a newer keystroke has taken over
    const rows = results.map((r) => {
      const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
      const row = treeRow({ name: r.name, path: r.path, dir: false, depth: 0 });
      if (dir) row.append(el('span', 'tree-dir', dir));
      row.onclick = () => openFileViewer(r.path);
      return row;
    });
    $('filesTree').replaceChildren(...(rows.length ? rows : [el('p', 'hint', `No file names contain "${q}".`)]));
    if (truncated) $('filesTree').append(el('p', 'hint tree-note', 'Showing the first 200 matches. Type more to narrow them.'));
  } catch (err) {
    $('filesTree').replaceChildren(el('p', 'hint', err.message));
  }
}

let selectWorkspaceTool = null;

function wireToolDock() {
  const tabs = [...document.querySelectorAll('#toolTabs [data-tool]')];
  const panes = [...document.querySelectorAll('[data-tool-pane]')];

  // These used to be body-level overlays. Keeping the same renderers but
  // mounting them here turns them into persistent mini-panels in the dock.
  $('reviewHost').append($('changesVeil'));
  $('fileHost').append($('fileVeil'));
  for (const dialog of [$('changesVeil').firstElementChild, $('fileVeil').firstElementChild]) {
    dialog?.setAttribute('aria-modal', 'false');
    dialog?.setAttribute('role', 'region');
  }

  const selectTool = (name) => {
    setInspectorOpen(true);
    for (const tab of tabs) {
      const active = tab.dataset.tool === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    }
    for (const pane of panes) {
      const active = pane.dataset.toolPane === name;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    }
  };
  selectWorkspaceTool = (name) => {
    selectTool(name);
    if (name === 'plan') renderPlan();
    if (name === 'files') refreshFilesTab();
    if (name === 'review') openChanges();
  };
  for (const tab of tabs) tab.onclick = () => selectWorkspaceTool(tab.dataset.tool);
  $('filesRefresh').onclick = () => refreshFilesTab({ force: true });
  $('filesFilter').addEventListener('input', () => {
    clearTimeout(files.timer);
    files.timer = setTimeout(() => runFilesFilter(), 180);
  });

  $('btnCloseInspector').onclick = () => setInspectorOpen(false);
  $('outcomeReview').onclick = () => selectWorkspaceTool('review');
  $('outcomeFiles').onclick = () => selectWorkspaceTool('files');
  $('outcomeBrowser').onclick = () => setBrowserOpen(true, { focus: true });
  wirePlan();
  wireFileViewerResize();
}

const FILE_VIEW_MIN_H = 160;
const FILE_VIEW_H_KEY = 'skadi.fileViewH';

function wireFileViewerResize() {
  const gutter = $('fileViewerGutter');
  const host = $('fileHost');
  if (!gutter || !host) return;
  const setHeight = (px, save = false) => {
    const paneH = document.querySelector('.files-pane')?.getBoundingClientRect().height || 700;
    const max = Math.max(FILE_VIEW_MIN_H, paneH - 180);
    const height = Math.min(max, Math.max(FILE_VIEW_MIN_H, Math.round(px)));
    document.documentElement.style.setProperty('--file-view-h', `${height}px`);
    gutter.setAttribute('aria-valuenow', String(height));
    if (save) try { localStorage.setItem(FILE_VIEW_H_KEY, String(height)); } catch { /* storage unavailable */ }
    return height;
  };
  try {
    const saved = Number(localStorage.getItem(FILE_VIEW_H_KEY));
    setHeight(saved >= FILE_VIEW_MIN_H ? saved : 320);
  } catch { setHeight(320); }

  let dragging = false;
  let startY = 0;
  let startH = 0;
  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = host.getBoundingClientRect().height;
    gutter.classList.add('dragging');
    document.body.classList.add('resizing-mini-panel');
    try { gutter.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    e.preventDefault();
  });
  gutter.addEventListener('pointermove', (e) => {
    if (dragging) setHeight(startH - (e.clientY - startY));
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.classList.remove('resizing-mini-panel');
    setHeight(host.getBoundingClientRect().height, true);
  };
  gutter.addEventListener('pointerup', finish);
  gutter.addEventListener('pointercancel', finish);
  gutter.addEventListener('dblclick', () => setHeight(320, true));
  gutter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 32 : 10;
    if (e.key === 'ArrowUp') { e.preventDefault(); setHeight(host.getBoundingClientRect().height + step, true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHeight(host.getBoundingClientRect().height - step, true); }
  });
}

const DOCK_MIN_H = 120;
const DOCK_KEY = 'skadi.terminalH';

function setDockHeight(px, { save = false } = {}) {
  // Leave room for the header and a usable chat above the terminal.
  const max = Math.max(DOCK_MIN_H, window.innerHeight - 260);
  const h = Math.min(max, Math.max(DOCK_MIN_H, Math.round(px)));
  document.documentElement.style.setProperty('--term-h', `${h}px`);
  if (save) {
    try { localStorage.setItem(DOCK_KEY, String(h)); } catch { /* private mode */ }
  }
  return h;
}

function wireDockResize() {
  const gutter = $('gutterDock');
  const dock = $('terminalDock');
  if (!gutter || !dock) return;
  try {
    const saved = Number(localStorage.getItem(DOCK_KEY));
    if (saved >= DOCK_MIN_H) setDockHeight(saved);
  } catch { /* storage unavailable */ }

  let dragging = false;
  let startY = 0;
  let startH = 0;
  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = dock.getBoundingClientRect().height;
    gutter.classList.add('dragging');
    document.body.classList.add('resizing-dock');
    try { gutter.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    e.preventDefault();
  });
  gutter.addEventListener('pointermove', (e) => {
    if (dragging) setDockHeight(startH - (e.clientY - startY));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.classList.remove('resizing-dock');
    setDockHeight(dock.getBoundingClientRect().height, { save: true });
  };
  gutter.addEventListener('pointerup', endDrag);
  gutter.addEventListener('pointercancel', endDrag);
  gutter.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--term-h');
    try { localStorage.removeItem(DOCK_KEY); } catch { /* private mode */ }
  });
  gutter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    const h = dock.getBoundingClientRect().height;
    if (e.key === 'ArrowUp') { e.preventDefault(); setDockHeight(h + step, { save: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setDockHeight(h - step, { save: true }); }
  });
}

function wireTerminalDock() {
  wireDockResize();
  const dock = $('terminalDock');
  const button = $('btnTerminalDock');
  const output = $('terminalOutput');
  const input = $('terminalInput');
  const prompt = $('terminalPrompt');

  const workspace = () => state.projects.find((project) => project.id === state.activeProject)?.path || '';
  const append = (text, className = '') => {
    const line = el('div', `terminal-line${className ? ` ${className}` : ''}`, text);
    output.append(line);
    output.scrollTop = output.scrollHeight;
  };
  const syncPrompt = () => {
    const cwd = workspace();
    $('terminalCwd').textContent = cwd;
    prompt.textContent = `PS ${cwd}>`;
  };
  const setOpen = (open) => {
    dock.hidden = !open;
    document.body.classList.toggle('terminal-open', open);
    button.classList.toggle('active', open);
    button.setAttribute('aria-pressed', String(open));
    if (open) {
      syncPrompt();
      if (!output.childElementCount) {
        append('Windows PowerShell', 'terminal-banner');
        append('Commands run in the active project.', 'terminal-muted');
      }
      input.focus();
    }
  };
  button.onclick = () => setOpen(dock.hidden);
  $('terminalClose').onclick = () => setOpen(false);
  $('terminalClear').onclick = () => { output.replaceChildren(); input.focus(); };
  $('terminalForm').onsubmit = async (event) => {
    event.preventDefault();
    const command = input.value.trim();
    if (!command || input.disabled) return;
    syncPrompt();
    append(`${prompt.textContent} ${command}`, 'terminal-command-line');
    input.value = '';
    input.disabled = true;
    try {
      const result = await api('terminal/run', { command });
      if (result.stdout) append(result.stdout.replace(/\s+$/, ''), 'terminal-stdout');
      if (result.stderr) append(result.stderr.replace(/\s+$/, ''), 'terminal-stderr');
      if (result.code) append(`Process exited with code ${result.code}.`, 'terminal-muted');
    } catch (err) {
      append(err.message, 'terminal-stderr');
    } finally {
      input.disabled = false;
      input.focus();
    }
  };
}
$('confirmClose').onclick = () => settleConfirm(false);
$('confirmCancel').onclick = () => settleConfirm(false);
$('confirmOk').onclick = () => settleConfirm(true);
$('confirmVeil').addEventListener('mousedown', (e) => {
  if (e.target === $('confirmVeil')) settleConfirm(false);
});
$('confirmVeil').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') settleConfirm(true);
  else if (e.key === 'Escape') settleConfirm(false);
  e.stopPropagation();
});
$('promptClose').onclick = closePrompt;
$('promptCancel').onclick = closePrompt;
$('promptSave').onclick = guard(savePrompt);
$('promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') guard(savePrompt)();
  else if (e.key === 'Escape') closePrompt();
  e.stopPropagation();
});
$('promptVeil').addEventListener('mousedown', (e) => {
  if (e.target === $('promptVeil')) closePrompt();
});
$('editorClose').onclick = closeEditor;
$('editorCancel').onclick = closeEditor;
$('editorSave').onclick = guard(saveEditor);
$('editorDelete').onclick = guard(deleteEditor);
$('editorVeil').addEventListener('mousedown', (e) => {
  if (e.target === $('editorVeil')) closeEditor();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('confirmVeil').hidden) settleConfirm(false);
  else if (e.key === 'Escape' && !$('promptVeil').hidden) closePrompt();
  else if (e.key === 'Escape' && !$('editorVeil').hidden) closeEditor();
  else if (e.key === 'Escape' && !$('benchVeil').hidden) closeBenchmarks();
  else if (e.key === 'Escape' && !$('modelsVeil').hidden) closeModels();
  else if (e.key === 'Escape' && !$('settingsVeil').hidden && $('editorVeil').hidden) closeSettings();
});
$('btnCompact').onclick = guard(async () => {
  if (!state.sessionId) throw new Error('open a session first');
  const { compaction } = await api('session/compact', { id: state.sessionId });
  if (compaction.compacted) {
    await openSession(state.sessionId);
    renderCtx(compaction.after, null);
    $('roundInfo').textContent = `compacted ${num(compaction.before)} → ${num(compaction.after)} tokens`;
  } else {
    $('roundInfo').textContent = `compaction skipped: ${compaction.reason}`;
  }
});

$('modelChip').onclick = () => {
  if ($('modelMenu').hidden) openModelMenu();
  else closeModelMenu();
};
document.addEventListener('mousedown', (e) => {
  if (!$('modelMenu').hidden && !e.target.closest('.model-picker')) closeModelMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modelMenu').hidden) {
    closeModelMenu();
    $('modelChip').focus();
  }
});

$('projectSelect').onchange = guard(async () => {
  await api('project/select', { id: $('projectSelect').value });
  state.activeProject = $('projectSelect').value;
  leaveSession(null);
  state.undo = [];
  state.changes = null;
  acceptPlan(emptyPlan());
  renderChatChanges();
  resetCtx();
  $('messages').replaceChildren();
  $('messages').append(createEmptyState());
  renderOutcomeBar();
  await refreshLists();
  await refreshBranch();
});

$('effortSelect').onchange = () => {
  try {
    localStorage.setItem(effortKey(), $('effortSelect').value || 'default');
  } catch { /* private mode */ }
};

$('modeSelect').onchange = guard(async () => {
  await setMode($('modeSelect').value);
});

$('btnWebSearch').onclick = guard(async () => {
  if (isBusy()) return;
  const previous = state.webSearch;
  state.webSearch = !state.webSearch;
  renderWebSearchToggle();
  try {
    if (state.sessionId) {
      await api('session/web-search', { id: state.sessionId, enabled: state.webSearch });
    }
  } catch (error) {
    state.webSearch = previous;
    renderWebSearchToggle();
    throw error;
  }
});

$('btnSubagents').onclick = guard(async () => {
  if (isBusy()) return;
  const previous = state.subagents;
  state.subagents = !state.subagents;
  renderSubagentsToggle();
  try {
    if (state.sessionId) {
      await api('session/subagents', { id: state.sessionId, enabled: state.subagents });
    }
  } catch (error) {
    state.subagents = previous;
    renderSubagentsToggle();
    throw error;
  }
});

$('btnAddProject').onclick = () => {
  const start = state.projects.find((p) => p.id === state.activeProject)?.path || null;
  openFolderBrowser(start, guard(async (path) => {
    const { projects, active } = await api('project/add', { path });
    renderProjects(projects, active);
    leaveSession(null);
    $('messages').replaceChildren();
    await refreshLists();
  }));
};

/**
 * Delete one of your profiles, or take a catalog one off your list. The model
 * file is never touched. Works on any profile, not just the one on screen.
 */
async function deleteProfile(id) {
  const profile = state.config.profiles[id];
  if (!profile) return;
  if (profile.catalog) {
    await removeCatalogProfile(id);
    renderLoadArea();
    return;
  }
  if (isLoaded(id)) throw new Error('That profile is loaded. Eject it first, then delete it.');
  if (!await askConfirm(
    `Delete the profile "${profile.label || id}"?

The .gguf file itself is not touched.`,
    { title: 'Delete profile' },
  )) return;
  const res = await api('profile/delete', { profileId: id });
  state.config = res.config;
  if (state.editing === id) await reselectAfterRemoval();
  else renderProfileSelect();
}

/**
 * The profile on screen is gone (deleted, or ejected defaults). Keep the model
 * in the Load list where it was and edit whichever of its profiles is left,
 * rather than jumping to an unrelated model.
 */
async function reselectAfterRemoval() {
  const model = state.loadModel;
  await selectProfile(state.config.activeProfile);
  state.loadModel = model;
  state.loadProfile = null;
  renderLoadArea();
  if (state.loadProfile && state.loadProfile !== 'default') await selectProfile(state.loadProfile);
}

$('btnDeleteProfile').onclick = guard(async () => deleteProfile(state.editing));


$('btnDuplicateProfile').onclick = guard(async () => {
  const id = state.editing;
  const source = state.config.profiles[id];
  if (!source) return;
  askName('Duplicate profile', 'Name for the copy', `${source.label || id} (copy)`, guard(async (label) => {
    const res = await api('profile/duplicate', { profileId: id, label });
    state.config = res.config;
    await selectProfile(res.profileId);
  }));
});

// ============================================================================
// Model manager
//
// Three tabs, in the order a person uses them:
//   Hugging Face  find a model, see which quants fit this GPU, download it
//   Skadi catalog tested launch profiles per model: speed, quality, context
//   Installed     what is on disk; load one
// Fit verdicts come from each file's own GGUF header, measured server-side
// against this card (read with a Range request for files not yet downloaded).
// ============================================================================

const mm = {
  tab: 'installed',
  local: null,
  catalog: null,
  results: [],
  repo: null,
  detail: null,
  vision: true,
  draft: false,
  jobs: new Map(),
  searchTimer: 0,
  searchSeq: 0,
  repoSeq: 0,
};

const fmtGB = (bytes) => `${(bytes / GB).toFixed(bytes >= 10 * GB ? 1 : 2)} GB`;
const fmtCtx = (n) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const fmtAge = (iso) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (!Number.isFinite(days)) return '';
  return days < 1 ? 'today' : days < 60 ? `${days} days ago` : days < 730 ? `${Math.round(days / 30)} months ago` : `${Math.round(days / 365)} years ago`;
};

/** How a file will sit on this GPU, in plain words: a colour dot and one short phrase. */
function fitBadge(fit) {
  let text;
  let kind = fit?.verdict || 'unknown';
  if (fit?.tuned) {
    text = 'Fits with a Skadi profile';
    kind = 'tuned';
  } else {
    text = {
      fits: fit?.maxContext ? `Fits · up to ${fmtCtx(fit.maxContext)} context` : 'Fits',
      tight: `Tight fit · ${fmtCtx(fit?.maxContext || 0)} context`,
      offload: 'Too big for the GPU alone · slower',
      toobig: 'Too big for this PC',
      unknown: '',
    }[kind];
  }
  const badge = el('span', `mm-fit ${kind}`);
  badge.append(el('i', 'mm-dot'), el('span', null, text));
  const need = fit?.needBytes ? `Needs about ${fmtGB(fit.needBytes)} of VRAM (8-bit KV cache).` : '';
  badge.title = fit?.tuned
    ? `Loading it all on the GPU is tight, but the catalog has a profile tuned for a ${catalogGB()} GB card. ${need}`
    : need;
  return badge;
}

function setModelsTab(tab) {
  mm.tab = tab;
  for (const button of document.querySelectorAll('.mm-tabs [data-tab]')) {
    const on = button.dataset.tab === tab;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', String(on));
  }
  for (const name of ['discover', 'catalog', 'installed']) $(`mm-${name}`).hidden = name !== tab;
  if (tab === 'discover') {
    if (!mm.results.length) runSearch();
    $('mmQuery').focus();
  }
  refreshModels();
  $('mmCard').textContent = cardLine();
}

async function openModels(tab) {
  $('modelsVeil').hidden = false;
  try {
    for (const job of (await api('hf/downloads')).jobs) mm.jobs.set(job.id, job);
  } catch { /* the list itself reports failures */ }
  renderDownloads();
  if (!tab) {
    try {
      mm.local = await api('models/local');
      tab = mm.local.models.length ? 'installed' : 'discover';
    } catch { tab = 'installed'; }
  }
  setModelsTab(tab);
}

function closeModels() {
  $('modelsVeil').hidden = true;
}

/** Re-read whatever the open tab shows. Cheap enough to run on every change. */
async function refreshModels() {
  refreshQuickModels();
  if ($('modelsVeil').hidden) return;
  try {
    if (mm.tab === 'installed') {
      mm.local = await api('models/local');
      renderInstalled();
    } else if (mm.tab === 'catalog') {
      mm.catalog = await api('catalog');
      renderCatalog();
    } else if (mm.repo) {
      loadRepo(mm.repo, { keepScroll: true });
    }
  } catch (err) {
    const pane = { installed: 'mm-installed', catalog: 'mm-catalog' }[mm.tab];
    if (pane) $(pane).replaceChildren(el('p', 'mm-empty', err.message));
  }
  $('mmCard').textContent = cardLine();
}

function cardLine() {
  const data = mm.local || mm.detail;
  if (!data?.totalVramBytes) return 'GPU memory has not been measured yet, so fit verdicts are unavailable.';
  return `Fit is judged against ${fmtGB(data.budgetBytes)} of your ${fmtGB(data.totalVramBytes)} VRAM, with an 8-bit KV cache.`;
}

const mmButton = (label, { iconName, main = false, onClick, title } = {}) => {
  const button = el('button', `mm-btn${main ? ' main' : ''}`);
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  button.append(el('span', null, label));
  if (title) button.title = title;
  if (onClick) button.onclick = onClick;
  return button;
};

// ---- Installed ---------------------------------------------------------------

async function addModelFromDisk() {
  const { path } = await api('model/browse', {});
  if (!path) return;
  const res = await api('profile/from-model', { path });
  state.config = res.config;
  await selectProfile(res.profileId);
  await refreshModels();
}

/** Pick the folder models live in (and downloads go to). Profiles keep working where they were. */
async function chooseModelsFolder() {
  await openFolderBrowser(state.config.modelsDir, guard(async (path) => {
    const res = await api('models/dir', { path });
    state.config = res.config;
    await refreshModels();
    await refreshQuickModels();
    renderSettingsPane?.();
  }));
}

function renderInstalled() {
  const pane = $('mm-installed');
  const data = mm.local;
  pane.replaceChildren();

  const bar = el('div', 'mm-bar');
  bar.append(el('span', 'mm-path', data.dir));
  bar.append(mmButton('Change folder…', { title: 'Where models are kept and downloads are saved', onClick: guard(chooseModelsFolder) }));
  bar.append(mmButton('Add a file from disk…', { onClick: guard(addModelFromDisk) }));
  pane.append(bar);

  if (!data.models.length) {
    const empty = el('div', 'mm-empty');
    empty.append(el('p', null, 'No models here yet.'));
    empty.append(mmButton('Find one on Hugging Face', { main: true, onClick: () => setModelsTab('discover') }));
    pane.append(empty);
    return;
  }

  const list = el('div', 'mm-list');
  for (const m of data.models) {
    const row = el('div', `mm-row${m.loaded ? ' loaded' : ''}`);
    const main = el('div', 'mm-row-main');
    const title = el('div', 'mm-row-title');
    title.append(el('span', 'mm-name', m.name.replace(/\.gguf$/i, '')));
    if (m.loaded) title.append(el('span', 'mm-tag', 'Loaded'));
    main.append(title);

    const meta = [fmtGB(m.bytes), m.quant, m.trainCtx ? `${fmtCtx(m.trainCtx)} context` : null, m.mmproj ? 'Vision' : null];
    main.append(el('div', 'mm-meta', meta.filter(Boolean).join('  ·  ')));

    const foot = el('div', 'mm-row-foot');
    foot.append(fitBadge(m.fit));
    const ready = m.profiles.filter((p) => p.catalog).length;
    if (ready) {
      const link = el('button', 'mm-link', `${ready} tested profile${ready === 1 ? '' : 's'}`);
      link.type = 'button';
      link.onclick = () => setModelsTab('catalog');
      foot.append(link);
    }
    main.append(foot);

    const action = mmButton(m.loaded ? 'Eject' : 'Load', {
      main: !m.loaded,
      iconName: m.loaded ? 'stop' : 'play',
    });
    action.onclick = guard(async () => {
      action.disabled = true;
      try {
        if (m.loaded) {
          await api('server/stop', {});
        } else {
          const res = await api('model/load', { name: m.name });
          state.config = res.config;
          await selectProfile(res.profileId);
        }
      } finally {
        await refreshModels();
      }
    });
    row.append(main, action);
    list.append(row);
  }
  pane.append(list);
}

// ---- Catalog ------------------------------------------------------------------

const TIER_ORDER = { recommended: 0, quality: 1, ok: 2, weak: 3 };
const TIER_LABEL = { recommended: 'Recommended', quality: 'Best quality', weak: 'Superseded' };

function openDiscoverFor(entry) {
  const repo = entry.info.repo;
  setModelsTab('discover');
  $('mmQuery').value = repo || entry.model.replace(/\.gguf$/i, '');
  if (repo) loadRepo(repo);
  else runSearch();
}

function renderCatalog() {
  const pane = $('mm-catalog');
  const data = mm.catalog;
  pane.replaceChildren();

  const intro = el('div', 'mm-intro');
  intro.append(el('b', null, `Tested profiles for a ${data.vramGB} GB GPU`));
  intro.append(el('span', null, 'Each one is a ready-made setting for one model, measured on real hardware. Import the ones you want and they appear in your profile list; the rest stay here, out of the way. You can’t edit these, but you can customise a copy.'));
  const gib = data.totalVramBytes / GB;
  if (gib && Math.abs(gib - data.vramGB) > 1.5) {
    intro.append(el('span', 'mm-warn', `Your GPU has ${gib.toFixed(0)} GB, so speed and context will differ from what is listed.`));
  }
  pane.append(intro);

  const families = new Map();
  for (const e of data.entries) {
    const key = e.info.family || e.model;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(e);
  }

  const scroller = el('div', 'mm-scroll');
  for (const [family, entries] of families) {
    entries.sort((a, b) => (TIER_ORDER[a.info.tier] ?? 9) - (TIER_ORDER[b.info.tier] ?? 9));
    const section = el('section', 'mm-family');
    const head = el('header', 'mm-family-head');
    head.append(el('h3', null, family));
    const cols = el('div', 'mm-cols');
    cols.append(el('span', null, 'Speed'), el('span', null, 'Quality'), el('span', null, 'Context'));
    cols.children[1].title = 'Perplexity (PPL) — lower is better';
    head.append(cols);
    section.append(head);

    for (const e of entries) {
      const row = el('div', `mm-profile${e.info.tier === 'weak' ? ' weak' : ''}${e.loaded ? ' loaded' : ''}`);
      const main = el('div', 'mm-profile-main');
      const title = el('div', 'mm-profile-title');
      title.append(el('span', 'mm-name', `${e.info.quant}${e.info.mtp ? ' + MTP' : ''}`));
      if (TIER_LABEL[e.info.tier]) title.append(el('span', `mm-tag ${e.info.tier}`, TIER_LABEL[e.info.tier]));
      if (e.loaded) title.append(el('span', 'mm-tag', 'Loaded'));
      main.append(title);
      main.append(el('div', 'mm-note-line', e.info.note));

      // The settings a power user will want to see, without opening anything.
      const specs = [
        e.info.kv ? `${e.info.kv} cache` : null,
        e.info.engine && e.info.engine !== 'llama.cpp' ? `${e.info.engine} build` : null,
        e.info.mtp ? 'MTP speedup' : null,
        e.mmproj ? 'Vision' : null,
      ].filter(Boolean);
      main.append(el('div', 'mm-specs', specs.join('  ·  ')));

      const missing = [
        !e.have.model ? 'the model' : null,
        e.have.mmproj === false ? 'vision file' : null,
        e.have.draft === false ? 'MTP draft file' : null,
      ].filter(Boolean);
      if (missing.length && e.have.model) main.append(el('div', 'mm-missing', `Missing: ${missing.join(', ')}. It will load without ${missing.length > 1 ? 'them' : 'it'}.`));
      if (!e.engine.ok) main.append(el('div', 'mm-missing', `Needs the ${e.info.engine} build at ${e.engine.exe}, which was not found.`));

      const stats = el('div', 'mm-stats');
      const speed = e.info.tps
        ? (e.info.tps[0] === e.info.tps[1] ? `${e.info.tps[0]} t/s` : `${e.info.tps[0]}–${e.info.tps[1]} t/s`)
        : '—';
      stats.append(el('span', null, speed), el('span', null, e.info.ppl ? e.info.ppl.toFixed(2) : '—'), el('span', null, e.info.ctxLabel || '—'));

      const actions = el('div', 'mm-actions');
      if (!e.have.model) {
        actions.append(mmButton('Get model', { iconName: 'download', onClick: () => openDiscoverFor(e) }));
      } else if (e.loaded) {
        actions.append(mmButton('Eject', { iconName: 'stop', onClick: guard(async () => { await api('server/stop', {}); await refreshModels(); }) }));
      } else {
        const load = mmButton('Load', { main: true, iconName: 'play' });
        load.disabled = !e.engine.ok;
        load.onclick = guard(async () => {
          load.disabled = true;
          try {
            const res = await api('model/load', { name: e.model, profileId: e.id });
            state.config = res.config;
            await selectProfile(res.profileId);
          } finally {
            await refreshModels();
          }
        });
        actions.append(load);
      }
      // Whether the profile is on the list in the Local AI tab. The catalog is
      // where you pick; the list is what you keep.
      const listed = mmButton(e.imported ? 'Imported' : 'Import', {
        iconName: e.imported ? 'check' : 'plus',
        title: e.imported
          ? 'Remove it from your profile list. It stays in the catalog.'
          : 'Add it to your profile list in the Local AI tab',
      });
      listed.classList.toggle('listed', Boolean(e.imported));
      listed.onclick = guard(async () => {
        listed.disabled = true;
        try {
          if (e.imported) await removeCatalogProfile(e.id);
          else await importCatalogProfile(e.id);
        } finally {
          await refreshModels();
        }
      });
      actions.append(listed);
      const copy = el('button', 'mm-link', 'Customise');
      copy.type = 'button';
      copy.title = 'Make an editable copy of this profile';
      copy.onclick = guard(async () => {
        const res = await api('profile/duplicate', { profileId: e.id });
        state.config = res.config;
        closeModels();
        selectWorkspaceTool?.('ai');
        await selectProfile(res.profileId);
      });
      actions.append(copy);

      row.append(main, stats, actions);
      section.append(row);
    }
    scroller.append(section);
  }
  pane.append(scroller);
}

// ---- Hugging Face ----------------------------------------------------------

const HF_LINK = /huggingface\.co\/([\w.-]+\/[\w.-]+)/i;

function runSearch() {
  clearTimeout(mm.searchTimer);
  mm.searchTimer = setTimeout(async () => {
    const raw = $('mmQuery').value.trim();
    const link = HF_LINK.exec(raw);
    if (link) return loadRepo(link[1]);
    const seq = ++mm.searchSeq;
    const box = $('mmResults');
    box.replaceChildren(el('p', 'mm-hint pad', 'Searching…'));
    try {
      const { results } = await api(`hf/search?q=${encodeURIComponent(raw)}&sort=${encodeURIComponent($('mmSort').value)}`);
      if (seq !== mm.searchSeq) return;
      mm.results = results;
      renderResults();
    } catch (err) {
      if (seq === mm.searchSeq) box.replaceChildren(el('p', 'mm-hint pad err', err.message));
    }
  }, 320);
}

function renderResults() {
  const box = $('mmResults');
  box.replaceChildren();
  if (!mm.results.length) {
    box.append(el('p', 'mm-hint pad', 'No GGUF models found.'));
    return;
  }
  for (const r of mm.results) {
    const item = el('button', `mm-result${r.id === mm.repo ? ' active' : ''}`);
    item.type = 'button';
    item.dataset.id = r.id;
    const [owner, name] = r.id.split('/');
    item.append(el('span', 'mm-result-name', name));
    const stats = [owner, `${fmtCount(r.downloads)} downloads`, r.vision ? 'Vision' : null].filter(Boolean);
    item.append(el('span', 'mm-result-meta', stats.join('  ·  ')));
    item.onclick = () => loadRepo(r.id);
    box.append(item);
  }
}

async function loadRepo(id, { keepScroll = false } = {}) {
  mm.repo = id;
  const seq = ++mm.repoSeq;
  const pane = $('mmDetail');
  const scroll = keepScroll ? pane.scrollTop : 0;
  if (!keepScroll) pane.replaceChildren(el('p', 'mm-hint pad', 'Reading the repository and its file headers…'));
  for (const item of $('mmResults').children) item.classList.toggle('active', item.dataset.id === id);
  try {
    const detail = await api(`hf/repo?id=${encodeURIComponent(id)}`);
    if (seq !== mm.repoSeq) return;
    mm.detail = detail;
    renderRepo();
    pane.scrollTop = scroll;
    $('mmCard').textContent = cardLine();
  } catch (err) {
    if (seq === mm.repoSeq) pane.replaceChildren(el('p', 'mm-hint pad err', err.message));
  }
}

function mmSwitch(on, onToggle) {
  const toggle = el('button', 'switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(on));
  toggle.append(el('span', 'knob'));
  toggle.onclick = onToggle;
  return toggle;
}

function renderRepo() {
  const d = mm.detail;
  const pane = $('mmDetail');
  pane.replaceChildren();

  const head = el('header', 'mm-detail-head');
  const [owner, name] = d.id.split('/');
  head.append(el('h3', null, name));
  const facts = [
    owner,
    d.params ? `${(d.params / 1e9).toFixed(d.params >= 1e10 ? 0 : 1)}B parameters` : null,
    d.context ? `${fmtCtx(d.context)} context` : null,
    `${fmtCount(d.downloads)} downloads`,
    d.updated ? `updated ${fmtAge(d.updated)}` : null,
    d.license,
  ].filter(Boolean);
  head.append(el('div', 'mm-meta', facts.join('  ·  ')));
  const link = el('a', 'mm-link', 'Open on huggingface.co ↗');
  link.href = `https://huggingface.co/${d.id}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  head.append(link);
  pane.append(head);

  if (d.gated) pane.append(el('p', 'mm-notice', 'This repository is gated. Accept its terms on huggingface.co and set the HF_TOKEN environment variable to download it.'));
  if (d.shapeError) pane.append(el('p', 'mm-notice', `Could not read the model header, so fit is judged on file size alone (${d.shapeError}).`));

  // Optional extras that travel with the model.
  const extras = el('div', 'mm-extras');
  const extra = (on, toggle, title, text) => {
    const row = el('div', 'mm-extra');
    row.append(mmSwitch(on, toggle));
    const label = el('div', 'mm-extra-text');
    label.append(el('b', null, title), el('span', null, text));
    row.append(label);
    extras.append(row);
  };
  if (d.vision) {
    extra(mm.vision, () => { mm.vision = !mm.vision; renderRepo(); }, 'Vision',
      `Lets the model read images. Adds ${fmtGB(d.vision.bytes)}.`);
  }
  if (d.drafts?.length) {
    extra(mm.draft, () => { mm.draft = !mm.draft; renderRepo(); }, 'MTP draft',
      `Speeds up generation in profiles that use it. Adds ${fmtGB(d.drafts[0].bytes)}.`);
  }
  if (extras.childElementCount) pane.append(extras);

  if (!d.models.length) {
    pane.append(el('p', 'mm-hint pad', 'This repository has no GGUF model files.'));
    return;
  }

  const fitOf = (m) => (mm.vision && m.fitWithVision ? m.fitWithVision : m.fit);
  // The largest quant that still fits comfortably is the one worth pointing at.
  const best = [...d.models].reverse().find((m) => fitOf(m).verdict === 'fits' && !fitOf(m).tuned);

  const files = el('div', 'mm-files');
  for (const m of d.models) {
    const fit = fitOf(m);
    const row = el('div', `mm-file ${fit.tuned ? 'tuned' : fit.verdict}`);
    const main = el('div', 'mm-file-main');
    const title = el('div', 'mm-file-title');
    title.append(el('span', 'mm-name', m.quant || m.id), el('span', 'mm-size', fmtGB(m.bytes)));
    if (m === best) title.append(el('span', 'mm-tag recommended', 'Best fit'));
    if (m.shards > 1) title.append(el('span', 'mm-tag', `${m.shards} parts`));
    main.append(title);
    const foot = el('div', 'mm-row-foot');
    foot.append(fitBadge(fit));
    if (m.catalog.length) {
      const link2 = el('button', 'mm-link', `${m.catalog.length} tested profile${m.catalog.length === 1 ? '' : 's'}`);
      link2.type = 'button';
      link2.onclick = () => setModelsTab('catalog');
      foot.append(link2);
    }
    main.append(foot);

    const active = [...mm.jobs.values()].find((j) => j.state === 'running' && j.files.some((f) => f.name === m.file));
    let side;
    if (m.downloaded) {
      side = el('span', 'mm-done');
      side.append(icon('check'), el('span', null, 'Downloaded'));
    } else if (active) {
      side = fileProgress(active, m.file);
    } else {
      side = mmButton('Download', {
        iconName: 'download',
        main: m === best,
        onClick: guard(async () => {
          side.disabled = true;
          const { job } = await api('hf/download', {
            repo: d.id, file: m.file, vision: Boolean(d.vision) && mm.vision, draft: Boolean(d.drafts?.length) && mm.draft,
          });
          mm.jobs.set(job.id, job);
          renderDownloads();
          renderRepo();
        }),
      });
    }
    row.append(main, side);
    files.append(row);
  }
  pane.append(files);
}

// ---- downloads tray ---------------------------------------------------------

/** The right-hand side of a file row while it downloads: a bar and a percentage that keep moving. */
function fileProgress(job, file) {
  const box = el('div', 'mm-file-progress');
  box.dataset.dlFile = file;
  const bar = el('div', 'mm-dl-bar');
  bar.append(el('div', 'mm-dl-fill'));
  box.append(el('span', 'mm-file-pct'), bar);
  paintFileProgress(box, job);
  return box;
}

function paintFileProgress(box, job) {
  const pct = job.totalBytes ? Math.min(Math.round((job.doneBytes / job.totalBytes) * 100), 100) : 0;
  box.querySelector('.mm-file-pct').textContent = `${pct}%`;
  box.querySelector('.mm-dl-fill').style.width = `${pct}%`;
  box.title = job.speed ? `${(job.speed / 1048576).toFixed(1)} MB/s` : '';
}

function onDownloadEvent(job) {
  const before = mm.jobs.get(job.id)?.state;
  mm.jobs.set(job.id, job);
  // Rows already on screen are updated in place; redrawing the whole repo on
  // every tick would also throw away the scroll position.
  if (job.state === 'running') {
    for (const file of job.files || []) {
      for (const box of document.querySelectorAll(`.mm-file-progress[data-dl-file="${CSS.escape(file.name)}"]`)) paintFileProgress(box, job);
    }
  }
  if ($('modelsVeil').hidden) {
    if (job.state === 'done' && before !== 'done') toast(`Downloaded ${job.meta?.model || job.repo}. Open Browse models to load it.`);
    if (job.state === 'failed' && before !== 'failed') toast(`Download failed: ${job.error}`);
    return;
  }
  renderDownloads();
  if (job.state !== 'running' && before === 'running' && mm.tab === 'discover' && mm.repo) loadRepo(mm.repo, { keepScroll: true });
}

function renderDownloads() {
  const tray = $('mmDownloads');
  const jobs = [...mm.jobs.values()];
  tray.hidden = !jobs.length;
  tray.replaceChildren();
  for (const job of jobs) {
    const row = el('div', `mm-dl ${job.state}`);
    const info = el('div', 'mm-dl-info');
    info.append(el('span', 'mm-dl-name', job.meta?.model || job.repo));
    const pct = job.totalBytes ? Math.min(Math.round((job.doneBytes / job.totalBytes) * 100), 100) : 0;
    const status = job.state === 'running'
      ? `${fmtGB(job.doneBytes)} of ${fmtGB(job.totalBytes)} · ${pct}%${job.speed ? ` · ${(job.speed / 1048576).toFixed(1)} MB/s` : ''}`
      : job.state === 'done' ? 'Downloaded' : job.state === 'cancelled' ? 'Cancelled. The partial file is kept; download again to resume.' : job.error || 'Failed';
    info.append(el('span', 'mm-dl-status', status));
    const bar = el('div', 'mm-dl-bar');
    const fill = el('div', 'mm-dl-fill');
    fill.style.width = `${job.state === 'done' ? 100 : pct}%`;
    bar.append(fill);
    const button = el('button', 'icon-btn');
    button.type = 'button';
    button.title = job.state === 'running' ? 'Cancel download' : 'Dismiss';
    button.setAttribute('aria-label', button.title);
    button.append(icon('x'));
    button.onclick = guard(async () => {
      await api('hf/cancel', { id: job.id });
      if (job.state !== 'running') mm.jobs.delete(job.id);
      renderDownloads();
    });
    row.append(info, bar, button);
    tray.append(row);
  }
}

// ---- "Load a model" in the Local AI panel --------------------------------------
//
// One way to load, in the order you think about it: pick a model, then pick the
// settings to load it with -- a profile you (or the catalog) made for it, or
// the defaults. Loading never replaces what is already loaded.

const modelBase = (profile) => String(profile.modelPath || profile.model || '').split(/[\\/]/).pop();

async function refreshQuickModels() {
  try {
    state.localModels = (await api('models/local')).models;
    renderLoadArea();
  } catch { /* offline or restarting: leave the list as it was */ }
}

/** Profiles that can be loaded for a model file: yours, and the catalog ones you imported. */
function profilesForModel(name) {
  const imported = new Set(state.config.catalogImported || []);
  return Object.entries(state.config.profiles)
    .filter(([id, p]) => modelBase(p).toLowerCase() === name.toLowerCase() && (!p.catalog || imported.has(id)));
}

/** Files on disk, plus models a profile points at from outside the models folder. */
function loadableModels() {
  const byName = new Map(state.localModels.map((m) => [m.name.toLowerCase(), { name: m.name, bytes: m.bytes, catalog: m.profiles.filter((p) => p.catalog) }]));
  for (const p of Object.values(state.config.profiles)) {
    const name = modelBase(p);
    if (p.modelPath && name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, bytes: null, catalog: [] });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const isLoaded = (id) => {
  const s = state.instances.get(id)?.state;
  return s === 'ready' || s === 'starting';
};
const modelLoaded = (name) => [...state.instances.values()].some((i) => {
  const p = state.config.profiles[i.id];
  return p && modelBase(p).toLowerCase() === name.toLowerCase() && (i.state === 'ready' || i.state === 'starting');
});
const loadKey = () => `${state.loadModel}|${state.loadProfile}`;

function renderLoadArea() {
  const select = $('loadModel');
  if (!select || !state.config) return;
  const models = loadableModels();
  select.replaceChildren();
  if (!models.length) {
    select.append(el('option', null, 'No models yet'));
    select.disabled = true;
    $('loadProfiles').replaceChildren();
    $('loadLinks').replaceChildren(linkButton('Find one on Hugging Face', () => openModels('discover')));
    $('btnLoad').disabled = true;
    $('loadSettingsLabel').hidden = true;
    return;
  }
  select.disabled = false;
  $('loadSettingsLabel').hidden = false;

  if (!state.loadModel || !models.some((m) => m.name.toLowerCase() === state.loadModel.toLowerCase())) {
    state.loadModel = (models.find((m) => modelLoaded(m.name)) || models[0]).name;
    state.loadProfile = null;
  }
  for (const m of models) {
    const option = el('option', null, `${m.name.replace(/\.gguf$/i, '')}${m.bytes ? `  (${fmtGB(m.bytes)})` : ''}${modelLoaded(m.name) ? '  ● loaded' : ''}`);
    option.value = m.name;
    select.append(option);
  }
  select.value = models.find((m) => m.name.toLowerCase() === state.loadModel.toLowerCase()).name;

  const profiles = profilesForModel(state.loadModel);
  if (state.loadProfile !== 'default' && !profiles.some(([id]) => id === state.loadProfile)) {
    // Prefer what is already running, then the profile last used, then the first.
    state.loadProfile = (profiles.find(([id]) => isLoaded(id)) || profiles.find(([id]) => id === state.config.activeProfile) || profiles[0])?.[0] ?? 'default';
  }

  const group = $('loadProfiles');
  group.replaceChildren();
  const option = (value, title, sub, tag, extra) => {
    const row = el('label', `load-opt${state.loadProfile === value ? ' on' : ''}`);
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'loadProfile';
    radio.checked = state.loadProfile === value;
    radio.onchange = () => chooseLoadProfile(value);
    const text = el('span', 'load-opt-text');
    text.append(el('span', 'load-opt-title', title));
    if (sub) text.append(el('span', 'load-opt-sub', sub));
    row.append(radio, text);
    if (tag) row.append(el('span', `menu-tag${tag === 'loaded' ? ' free' : ''}`, tag));
    if (extra) row.append(extra);
    return row;
  };
  for (const [id, p] of profiles) {
    const sub = [p.catalog ? 'Skadi catalog' : p.temporary ? 'Default settings, not saved' : 'Your profile', p.ctx ? `${fmtCtx(p.ctx)} context` : null, p.cacheK ? `${p.cacheK} cache` : null].filter(Boolean).join(' · ');
    const actions = el('span', 'load-opt-actions');
    const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); guard(fn)(); };
    if (p.temporary) {
      // Unsaved defaults vanish on eject; this is the way to keep them.
      const save = el('button', 'btn tiny', 'Save');
      save.type = 'button';
      save.title = 'Keep these settings as a profile';
      save.onclick = stop(() => saveProfile(id));
      actions.append(save);
    } else {
      const remove = el('button', 'icon-btn');
      remove.type = 'button';
      remove.append(icon(p.catalog ? 'x' : 'trash'));
      const busy = isLoaded(id);
      remove.disabled = busy;
      remove.title = busy ? 'Eject the model first' : p.catalog ? 'Remove from your profiles — it stays in the catalog' : 'Delete this profile';
      remove.setAttribute('aria-label', remove.title);
      remove.onclick = stop(() => deleteProfile(id));
      actions.append(remove);
    }
    group.append(option(id, p.label || id, sub, isLoaded(id) ? 'loaded' : null, actions));
  }
  // A model with no profile of its own gets a default one, made for it, so the
  // Profile and Forecast panels never describe some other model's settings.
  // Once it exists it is listed above as its own row.
  if (!profiles.length) {
    group.append(option('default', 'Default settings', 'Sized to the memory you have free. Not kept unless you save them.'));
    const model = state.loadModel;
    if (!state.defaulting.has(model)) {
      state.defaulting.add(model);
      guard(async () => {
        try { await chooseLoadProfile('default'); } finally { state.defaulting.delete(model); }
      })();
    }
  }

  // Ways to get more settings than these.
  const links = $('loadLinks');
  links.replaceChildren(linkButton('+ New profile…', guard(newProfileForModel)));
  const model = models.find((m) => m.name.toLowerCase() === state.loadModel.toLowerCase());
  const imported = new Set(state.config.catalogImported || []);
  const more = model.catalog.filter((p) => !imported.has(p.id)).length;
  if (more) links.append(linkButton(`${more} tested profile${more === 1 ? '' : 's'} in the catalog`, () => openModels('catalog')));

  const busy = state.loading.has(loadKey());
  const already = state.loadProfile !== 'default' && isLoaded(state.loadProfile);
  $('btnLoad').disabled = busy || already;
  $('btnLoad').textContent = busy ? 'Loading…' : already ? 'Loaded' : 'Load';

  const held = [...state.instances.values()].reduce((sum, i) => sum + ((state.vramByModel.get(i.id) || i.vram)?.dedicated || 0), 0);
  $('loadHint').textContent = held && !already
    ? `${gb(held)} of VRAM is held by loaded models. This one is fitted into what is left.`
    : '';
}

const linkButton = (label, onClick) => {
  const button = el('button', 'mm-link', label);
  button.type = 'button';
  button.onclick = onClick;
  return button;
};

/** Turn a temporary profile into one of yours. */
async function saveProfile(id) {
  const res = await api('profile/save', { profileId: id });
  state.config = res.config;
  applyProfileLock(id);
  renderProfileSelect();
  renderLoadedList([...state.instances.values()]);
}

$('btnSaveProfile').onclick = guard(async () => saveProfile(state.editing));

async function chooseLoadProfile(value) {
  if (value === 'default') {
    // Build (or reuse) this model's unsaved default profile and show that.
    const model = state.loadModel;
    const res = await api('profile/defaults', { model });
    state.config = res.config;
    if (state.loadModel !== model) return;
    await selectProfile(res.profileId);
    renderLoadArea();
    return;
  }
  state.loadProfile = value;
  await selectProfile(value);
}

$('loadModel').onchange = guard(async () => {
  state.loadModel = $('loadModel').value;
  state.loadProfile = null;
  renderLoadArea();
  if (state.loadProfile && state.loadProfile !== 'default') await selectProfile(state.loadProfile);
});

async function newProfileForModel() {
  const model = state.loadModel;
  if (!model) throw new Error('Pick a model first.');
  askName('New profile', 'Name', `${model.replace(/\.gguf$/i, '')} (new)`, guard(async (label) => {
    const res = await api('profile/new', { model, label });
    state.config = res.config;
    await selectProfile(res.profileId);
  }));
}

$('btnLoad').onclick = guard(async () => {
  const name = state.loadModel;
  const choice = state.loadProfile;
  const key = loadKey();
  if (!name || !choice) return;
  state.loading.add(key);
  renderLoadArea();
  try {
    const res = await api('model/load', choice === 'default' ? { name, defaults: true } : { name, profileId: choice });
    state.config = res.config;
    await selectProfile(res.profileId);
  } finally {
    state.loading.delete(key);
    renderLoadArea();
    refreshModels();
  }
});

$('btnEjectAll').onclick = guard(async () => {
  if (!await askConfirm('Unload every model Skadi started?', { title: 'Eject all' })) return;
  await api('server/stop', {});
});

// "+" in the Profile panel: a new profile with default settings for this model.
$('btnLoadModel').onclick = guard(async () => {
  const model = state.config.profiles[state.editing]?.model;
  if (model) state.loadModel = model;
  await newProfileForModel();
});

$('btnModels').onclick = () => openModels();
$('modelsClose').onclick = closeModels;
$('modelsVeil').addEventListener('mousedown', (e) => {
  if (e.target === $('modelsVeil')) closeModels();
});
for (const button of document.querySelectorAll('.mm-tabs [data-tab]')) {
  button.onclick = () => setModelsTab(button.dataset.tab);
}
$('mmQuery').addEventListener('input', runSearch);
$('mmQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
});
$('mmSort').addEventListener('change', runSearch);
refreshQuickModels();

$('btnNewSession').onclick = () => {
  // leaveSession does the four things every exit owes the chat being left:
  // park its draft, put the new one's up, re-read whether *it* is mid-turn
  // (the previous chat's "Stop generating" state is not this one's), and hand
  // the browser pane over. Doing it by hand here is what left the new chat
  // showing the last chat's page.
  leaveSession(null);
  state.undo = [];
  state.changes = null;
  renderChatChanges();
  resetCtx();
  $('messages').replaceChildren();
  $('messages').append(createEmptyState());
  refreshLists();
};

function createEmptyState() {
  const empty = el('div', 'empty');
  empty.id = 'emptyState';
  empty.append(el('p', 'empty-eyebrow', 'Ready to work'), el('h3', null, 'What should we build?'));
  const readiness = el('div', 'readiness');
  readiness.id = 'readiness';
  readiness.setAttribute('aria-label', 'Chat readiness');
  empty.append(el('p', 'empty-copy', 'Confirm the workspace below, then describe the outcome you want.'), readiness);
  queueMicrotask(renderEmptyReadiness);
  return empty;
}

function renderEmptyReadiness() {
  const box = $('readiness');
  if (!box) return;
  const project = state.projects.find((p) => p.id === state.activeProject);
  const provider = chatProvider();
  const modelReady = !provider?.managed || Boolean(chatLocalInstance());
  const mode = MODES.find((m) => m.value === currentMode());
  const item = (label, value, ready = true) => {
    const row = el('div', `readiness-item ${ready ? 'ready' : 'attention'}`);
    row.append(icon(ready ? 'check' : 'warn'), el('span', null, label), el('strong', null, value));
    return row;
  };
  box.replaceChildren(
    item('Project', project?.name || 'Choose a project', Boolean(project)),
    item('Model', modelReady ? (provider?.model || provider?.label || 'Ready') : 'Load a model', modelReady),
    item('Permissions', mode?.label || 'Ask before changes'),
  );
}

$('messages').addEventListener('click', (event) => {
  const starter = event.target.closest('[data-starter]');
  if (!starter) return;
  $('input').value = starter.dataset.starter;
  $('input').dispatchEvent(new Event('input', { bubbles: true }));
  $('input').focus();
});

const resolveApproval = (allow) => {
  const card = $('approval');
  api('approve', { id: card.dataset.callId, allow });
  state.approvals.delete(card.dataset.sessionId || state.sessionId);
  renderApproval();
};
$('btnAllow').onclick = () => resolveApproval(true);
$('btnDeny').onclick = () => resolveApproval(false);

// ---- attachments ----------------------------------------------------------

$('btnAttach').onclick = (e) => {
  e.stopPropagation();
  $('attachMenu').hidden = !$('attachMenu').hidden;
};
document.addEventListener('click', (e) => {
  if (!$('attachMenu').hidden && !$('attachMenu').contains(e.target)) $('attachMenu').hidden = true;
});
for (const btn of $('attachMenu').querySelectorAll('[data-pick]')) {
  btn.onclick = () => {
    $('attachMenu').hidden = true;
    (btn.dataset.pick === 'folder' ? $('folderInput') : $('fileInput')).click();
  };
}
$('fileInput').onchange = async (e) => {
  await addAttachments(e.target.files);
  e.target.value = '';
};
$('folderInput').onchange = async (e) => {
  await addAttachments(e.target.files, { fromFolder: true });
  e.target.value = '';
};

const box = $('composerBox');
for (const type of ['dragenter', 'dragover']) {
  box.addEventListener(type, (e) => {
    e.preventDefault();
    box.classList.add('dropping');
  });
}
for (const type of ['dragleave', 'drop']) {
  box.addEventListener(type, () => box.classList.remove('dropping'));
}
box.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await addAttachments(e.dataTransfer.files);
});

$('input').addEventListener('paste', async (e) => {
  const images = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (images.length) {
    e.preventDefault();
    await addAttachments(images);
  }
});

// ---- composer -------------------------------------------------------------

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const input = $('input');
  const text = input.value.trim();
  if ((!text && !state.attachments.length) || $('btnSend').disabled) return;
  // A brand-new chat has no session id yet, so the server cannot route a
  // steer to the right turn. Make them wait for it to exist.
  if (isBusy() && !state.sessionId) return;

  const attachments = state.attachments;
  let extras = null;
  if (attachments.length) {
    extras = el('div', 'msg-attachments');
    for (const a of attachments) {
      if (a.mediaType.startsWith('image/')) {
        const thumb = el('img', 'msg-thumb');
        thumb.src = `data:${a.mediaType};base64,${a.data}`;
        extras.append(thumb);
      } else {
        extras.append(el('span', 'chip-name', a.relPath || a.name));
      }
    }
  }
  addMessage('user', text || '(attachments only)', extras);

  input.value = '';
  input.style.height = 'auto';
  state.attachments = [];
  drafts.delete(state.sessionId);
  renderAttachTray();
  pinned = true;
  // Mid-turn, this is a steer: the turn already owns the live buffer and the
  // activity line, so clearing either would wipe the reply being streamed.
  const steering = isBusy();
  if (steering) {
    setActivity('Steering — the agent picks this up at its next step…');
  } else {
    if (state.sessionId) setRunning(state.sessionId, true);
    else setBusy(true);
    resetLive(state.sessionId);
    // Immediate feedback: the first SSE event can take seconds on a local
    // model that is still prefilling, so show activity right away.
    setActivity('Starting…');
    $('roundInfo').textContent = 'starting…';
  }

  // `draftKey` names the browser this chat has been using while it had no id,
  // so the chat the server is about to create inherits the page that is open
  // in the pane right now rather than some other unsent chat's.
  api('chat', {
    sessionId: state.sessionId,
    draftKey: state.draftKey,
    message: text,
    attachments,
    effort: currentEffort(),
    // The chat's own pick, so a chat runs on the provider it shows.
    provider: chatProviderId(),
    model: chatProvider()?.managed ? chatProvider()?.instance || null : chatProvider()?.model || null,
    webSearch: state.webSearch,
    subagents: state.subagents,
  })
    .then(() => {
      // The server answers 202 before the session file lands; if the
      // agent_session SSE is missed, the rail would stay on "No chats".
      // A delayed refresh covers that gap.
      setTimeout(() => {
        if (isBusy()) refreshLists().catch(() => {});
      }, 1500);
    })
    .catch((err) => {
      addMessage('error', err.message);
      // A steer that failed to post leaves the turn itself running; only a
      // turn this send was starting should be marked idle.
      if (steering) return;
      setRunning(state.sessionId, false);
      if (!state.sessionId) setBusy(false);
    });
};

const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  } else if (e.key === 'Tab' && e.shiftKey) {
    // Claude-style: Shift+Tab cycles the everyday permission modes.
    e.preventDefault();
    cycleMode();
  }
});

for (const head of document.querySelectorAll('.panel-head.collapse')) {
  head.onclick = () => {
    const target = $(head.dataset.toggle);
    target.hidden = !target.hidden;
    head.classList.toggle('open', !target.hidden);
  };
}

// ============================================================================
// Settings modal
//
// One scrollable page grouped by task; no save bar. Settings take effect the
// moment they change and the server echoes them back, so "Saved" is a brief
// confirmation, not a commit. Every setting is diffed against the factory
// defaults the server ships (state.settingsDefaults): a changed row grows a
// gutter bar, a dot and a reset; the header counts them all.
//
// The two actions that cannot be undone are quarantined in the red danger
// zone at the bottom, where the button stays dead until you type the word.
// ============================================================================

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const getPath = (obj, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
const settingDefault = (path) => getPath(state.settingsDefaults || {}, path);
const isModifiedSetting = (path) => !deepEq(getPath(state.settings, path), settingDefault(path));

/** Patch body for a (possibly nested) settings path, merged over the rest of that branch. */
function settingPatch(path, value) {
  const parts = path.split('.');
  if (parts.length === 1) return { [path]: value };
  const parent = { ...(getPath(state.settings, parts[0]) || {}) };
  let node = parent;
  for (const k of parts.slice(1, -1)) {
    node[k] = { ...(node[k] || {}) };
    node = node[k];
  }
  node[parts[parts.length - 1]] = value;
  return { [parts[0]]: parent };
}

/** Apply the active UI theme to <html>. 'oled' is pure black (OLED-friendly); anything else is polar. */
function applyTheme() {
  document.documentElement.dataset.theme = (state.settings && state.settings.theme) === 'oled' ? 'oled' : 'polar';
}

let settingsRows = [];
let settingsGroups = [];
let settingsQuery = '';
let activeSettingsGroup = 'appearance';
// renderSettingsPane wipes the pane, so hold the no-match notice and put it back.
const settingsNoMatch = $('settingsNoMatch');
let advancedOpen = false;

function openSettings(section = null) {
  $('settingsSearch').value = '';
  settingsQuery = '';
  if (section) activeSettingsGroup = section;
  renderSettingsPane();
  const sub = $('settingsSub');
  for (const n of [...sub.childNodes]) if (n.nodeType === 3) sub.removeChild(n);
  const proj = state.projects.find((p) => p.id === state.activeProject);
  sub.append(`${proj ? proj.name : 'Skadi'} · applies instantly`);
  $('settingsVeil').hidden = false;
  selectSettingsGroup(activeSettingsGroup);
  // Re-run once the veil is visible: hidden modals report zero rects, so the
  // first pass above could not tell which section sits at the top.
  syncNavActive();
}

// ---- Benchmarks ---------------------------------------------------------
// Measured numbers live in config/benchmarks.json, not in profile labels: a
// label drifts the moment a setting changes, but a recorded run stays true
// about the conditions it was run under. The panel renders whatever suites
// the file declares, so adding a column or a whole suite needs no code here.

const benchNum = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 4 : 2)) : (v ?? ''));

function renderBenchSuite(suite) {
  const cols = suite.columns || Object.keys(suite.rows[0] || {});
  const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = (suite.rows || []).map((row) => {
    const cells = cols.map((c) => {
      const raw = row[c];
      const cls = c === 'tg' || c === 'ppl' ? ' class="num strong"' : (typeof raw === 'number' ? ' class="num"' : '');
      return `<td${cls}>${escapeHtml(benchNum(raw))}</td>`;
    }).join('');
    const note = row.note ? `<tr class="bench-note"><td colspan="${cols.length}">${escapeHtml(row.note)}</td></tr>` : '';
    return `<tr data-verdict="${escapeHtml(row.verdict || '')}">${cells}</tr>${note}`;
  }).join('');
  return `<section class="bench-suite">
    <h3>${escapeHtml(suite.title || suite.id)}</h3>
    ${suite.note ? `<p class="bench-blurb">${escapeHtml(suite.note)}</p>` : ''}
    <table class="bench-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  </section>`;
}

async function openBenchmarks() {
  $('benchVeil').hidden = false;
  const body = $('benchBody');
  body.innerHTML = '<p class="bench-blurb">Loading…</p>';
  try {
    const data = await api('benchmarks');
    $('benchUpdated').textContent = data.updated ? `measured ${data.updated}` : '';
    const suites = data.suites || [];
    if (!suites.length) { body.innerHTML = '<p class="bench-blurb">No benchmarks recorded yet.</p>'; return; }
    body.innerHTML =
      (data.rig ? `<p class="bench-rig">${escapeHtml(data.rig)}</p>` : '') +
      suites.map(renderBenchSuite).join('');
  } catch (err) {
    body.innerHTML = `<p class="bench-blurb err">${escapeHtml(err.message)}</p>`;
  }
}

function closeBenchmarks() {
  $('benchVeil').hidden = true;
}

function closeSettings() {
  $('settingsVeil').hidden = true;
}

function fmtValue(spec, v) {
  return spec.fmt ? spec.fmt(Number(v)) : String(v);
}

/** Current value of a row: provider override, derived check, or the settings path. */
const readValue = (spec) =>
  spec.controlValue ? spec.controlValue()
    : spec.check ? spec.check(getPath(state.settings, spec.key))
    : getPath(state.settings, spec.key);

/** Event handler: persist one setting, then repaint only what it touched. */
function onChange(spec, getValue, entry) {
  return guard(async () => {
    const raw = getValue();
    if (spec.type === 'number' && raw != null && !Number.isFinite(raw)) return;
    const value = spec.saveValue ? spec.saveValue(raw) : raw;
    if (spec.save) {
      await spec.save(value);
      return;
    }
    state.settings = await api('settings', settingPatch(spec.key, value));
    for (const row of settingsRows) if (row.spec.key === spec.key) updateEntry(row);
    flashSaved(entry);
  });
}

function updateEntry(entry) {
  const { spec, el: row, refs } = entry;
  const value = readValue(spec);
  // Member rows (one switch per value in a shared list, e.g. memory types) are
  // modified only when their own member differs from its default, not when the
  // whole list differs -- otherwise flipping one switch marks every sibling.
  const modified = spec.key
    ? (spec.check && spec.saveValue
      ? spec.check(getPath(state.settings, spec.key)) !== spec.check(settingDefault(spec.key))
      : isModifiedSetting(spec.key))
    : false;
  row.classList.toggle('modified', modified);
  refs.dot.hidden = !modified;
  refs.reset.classList.toggle('on', modified);
  if (refs.sync) refs.sync(value);
  if (typeof spec.desc === 'function') refs.descEl.textContent = spec.desc();
}

function flashSaved(entry) {
  clearTimeout(entry.pillTimer);
  const pill = entry.refs.pill;
  pill.classList.add('on');
  entry.pillTimer = setTimeout(() => { pill.classList.remove('on'); }, 1500);
}

function startGroup(pane, { id, title, collapsible = false }) {
  const g = { id, title, items: [], collapsible, open: false };
  const section = el('section', 'settings-group');
  const head = collapsible ? el('button', 'group-head group-toggle') : el('div', 'group-head');
  if (collapsible) {
    const chev = icon('chevron');
    chev.classList.add('chev');
    head.append(chev);
    head.onclick = () => setGroupOpen(g, !g.open);
  }
  head.append(el('span', 'group-title', title));
  section.append(head);
  pane.append(section);
  g.el = section;
  g.head = head;
  settingsGroups.push(g);
  return g;
}

function setGroupOpen(g, open) {
  g.open = open;
  g.el.classList.toggle('collapsed', !open);
  if (g.collapsible && g.id === 'advanced') advancedOpen = open;
}

/** One setting/list row inside a group. spec: see addRow. */
function addRow(group, spec) {
  const entry = { spec, group, pillTimer: null, refs: {} };
  const row = el('div', 'settings-row');
  const descText = typeof spec.desc === 'function' ? spec.desc() : spec.desc || '';
  row.dataset.search = `${spec.label} ${descText}`.toLowerCase();

  const main = el('div', 'settings-row-main');
  const name = el('div', 'settings-row-name');
  const dot = el('span', 'settings-dot');
  dot.hidden = true;
  name.append(dot, el('span', null, spec.label));
  main.append(name);
  const descEl = el('div', 'settings-row-desc');
  descEl.textContent = descText;
  main.append(descEl);
  row.append(main);

  const controls = el('div', 'settings-row-controls');
  // Order: saved pill, reset, then the widget. Pill and reset live in fixed
  // slots left of the widget (visibility, not display, so the slot stays),
  // keeping the widget in the same column on every row whatever its state.
  const pill = el('span', 'saved-pill');
  pill.append(icon('check'), el('span', null, 'Saved'));
  const reset = el('button', 'icon-btn reset-btn');
  reset.title = 'Reset to default';
  reset.append(icon('restart'));
  if (!spec.key) reset.disabled = true;

  const refs = entry.refs;
  // updateEntry/flashSaved reach for these by name, so record them before any
  // type-specific control is built.
  refs.dot = dot;
  refs.reset = reset;
  refs.pill = pill;
  refs.descEl = descEl;

  // Reset to default: write the shipped default back, then re-sync this row.
  // Member rows reset only their own member, not the whole shared list.
  reset.onclick = guard(async () => {
    if (!spec.key) return;
    const value = spec.check && spec.saveValue
      ? spec.saveValue(spec.check(settingDefault(spec.key)))
      : settingDefault(spec.key);
    state.settings = await api('settings', settingPatch(spec.key, value));
    for (const row of settingsRows) if (row.spec.key === spec.key) updateEntry(row);
    flashSaved(entry);
  });

  const valueNow = () => readValue(spec);
  let control;

  if (spec.type === 'toggle') {
    // A button, not a checkbox: the click handler owns the state, so a failed
    // save can roll the switch back instead of stranding it in the wrong place.
    control = el('button', 'switch');
    control.type = 'button';
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-checked', String(Boolean(valueNow())));
    control.setAttribute('aria-label', spec.label);
    const knob = el('span', 'knob');
    control.append(knob);
    if (spec.disabled) control.disabled = true;
    let pending = false;
    control.addEventListener('click', async () => {
      if (pending || control.disabled) return;
      const previous = control.getAttribute('aria-checked') === 'true';
      const next = !previous;
      // Flip first: visual state, ARIA state and the save all follow the click.
      pending = true;
      control.classList.add('pending');
      control.setAttribute('aria-checked', String(next));
      try {
        const value = spec.saveValue ? spec.saveValue(next) : next;
        if (spec.save) {
          await spec.save(value);
        } else {
          state.settings = await api('settings', settingPatch(spec.key, value));
          for (const row of settingsRows) if (row.spec.key === spec.key) updateEntry(row);
        }
        flashSaved(entry);
      } catch (err) {
        // Roll back over the same 250 ms ease-out, then announce the failure.
        control.setAttribute('aria-checked', String(previous));
        addMessage('error', err.message);
      } finally {
        pending = false;
        control.classList.remove('pending');
      }
    });
    refs.sync = (v) => {
      control.setAttribute('aria-checked', String(Boolean(v)));
      if (spec.onSync) spec.onSync(v);
    };
  } else if (spec.type === 'text') {
    control = el('input');
    control.type = 'text';
    control.value = spec.value != null ? spec.value : valueNow() ?? '';
    if (spec.mono) control.classList.add('mono');
    if (spec.placeholder) control.placeholder = spec.placeholder;
    if (spec.disabled) control.disabled = true;
    control.addEventListener('change', onChange(spec, () => control.value.trim(), entry));
    control.addEventListener('keydown', (e) => { if (e.key === 'Enter') control.blur(); });
    refs.input = control;
    refs.sync = (v) => { if (!control.disabled) control.value = v ?? ''; };
    if (spec.browse) {
      const browse = el('button', 'btn tiny', 'Browse…');
      browse.type = 'button';
      browse.onclick = guard(async () => spec.browse());
      refs.extra = browse;
    }
  } else if (spec.type === 'number') {
    control = el('input');
    control.type = 'number';
    control.min = 0;
    control.value = valueNow();
    control.addEventListener('change', onChange(spec, () => (control.value === '' ? null : Number(control.value)), entry));
    refs.input = control;
    refs.sync = (v) => { control.value = v; };
  } else if (spec.type === 'select') {
    control = el('select');
    for (const opt of spec.options || []) {
      let value, label;
      if (Array.isArray(opt)) {
        [value, label] = opt;
      } else if (typeof opt === 'string') {
        value = label = opt;
      } else if (opt && typeof opt === 'object' && 'value' in opt) {
        ({ value, label } = opt);
      } else {
        continue;
      }
      if (label == null) label = String(value);
      const o = el('option', null, label);
      o.value = value ?? '';
      control.append(o);
    }
    control.value = String(valueNow());
    control.addEventListener('change', onChange(spec, () => control.value, entry));
    refs.sel = control;
    refs.sync = (v) => { control.value = String(v); };
  } else if (spec.type === 'range') {
    const wrap = el('div', 'range-wrap');
    const out = el('span', 'range-val');
    out.textContent = fmtValue(spec, valueNow());
    const slider = makeSlider({
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: Number(valueNow()),
      label: spec.label,
      format: (v) => fmtValue(spec, v),
      onInput: (v) => { out.textContent = fmtValue(spec, v); },
      onCommit: (v) => onChange(spec, () => v, entry),
    });
    wrap.append(out, slider.el);
    control = wrap;
    refs.sync = (v) => slider.set(Number(v));
  } else if (spec.type === 'action') {
    // Buttons drawn by the caller, redrawn whenever its state changes.
    control = el('div', 'action-control');
    refs.rerender = () => spec.render(control, entry);
    spec.render(control, entry);
  } else if (spec.type === 'secret') {
    const wrap = el('div', 'credential-control');
    const status = el('span', `credential-status${spec.hasValue ? ' configured' : ''}`);
    status.append(icon(spec.hasValue ? 'check' : 'warn'), el('span', null, spec.hasValue ? 'Saved securely' : 'Not configured'));
    const input = el('input', 'credential-input mono');
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.placeholder = spec.hasValue ? 'Enter a replacement key' : 'Paste API key';
    input.setAttribute('aria-label', `${spec.label} value`);
    const save = el('button', 'btn tiny primary', spec.hasValue ? 'Replace' : 'Save');
    save.type = 'button';
    save.disabled = true;
    const remove = el('button', 'btn tiny danger', 'Remove');
    remove.type = 'button';
    remove.hidden = !spec.hasValue;
    input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); save.click(); }
    });
    const run = async (value) => {
      input.disabled = save.disabled = remove.disabled = true;
      status.classList.remove('error');
      status.replaceChildren(icon('restart'), el('span', null, value ? 'Encrypting…' : 'Removing…'));
      try {
        await spec.save(value);
      } catch (err) {
        input.disabled = remove.disabled = false;
        save.disabled = !input.value.trim();
        status.classList.add('error');
        status.replaceChildren(icon('warn'), el('span', null, err.message));
      }
    };
    save.onclick = () => run(input.value.trim());
    remove.onclick = () => run('');
    wrap.append(status, input, save, remove);
    control = wrap;
  }

  // The widget is the rightmost element of the row; the saved pill and the
  // reset button sit in their fixed slots left of it.
  if (control) {
    // Composite widgets such as the custom range already carry their own
    // accessible name. Native settings controls need one because their text
    // label is visual rather than a wrapping <label>.
    if (control.matches?.('input, select, button') && !control.getAttribute('aria-label')) {
      control.setAttribute('aria-label', spec.label);
    }
    controls.append(pill, reset, ...(refs.extra ? [refs.extra] : []), control);
  }

  row.append(controls);
  group.el.append(row);
  group.items.push(row);
  entry.el = row;
  settingsRows.push(entry);
  if (spec.key) updateEntry(entry);
  return entry;
}

/** Facts / skills list block under a group. kind: 'memory' | 'skill'. */
function listBlock(group, kind) {
  const head = el('div', 'settings-list-head');
  head.append(el('h3', null, kind === 'memory' ? 'Facts' : 'Installed'));
  const count = el('span', 'count');
  head.append(count);
  const add = el('button', 'btn tiny');
  add.append(icon('plus'), el('span', null, 'New'));
  add.onclick = () => openEditor(kind, null);
  head.append(add);
  group.el.append(head);

  const list = el('div', 'settings-list');
  group.el.append(list);
  api(kind === 'skill' ? 'skills' : kind)
    .then((items) => {
      count.textContent = items.length || '';
      list.replaceChildren();
      if (!items.length) {
        list.append(el('p', 'hint', kind === 'memory' ? 'Nothing remembered yet.' : 'No skills yet.'));
        return;
      }
      for (const item of items) {
        const row = el('div', 'settings-row clickable');
        row.dataset.search = `${item.name} ${item.description || ''}`.toLowerCase();
        const main = el('div', 'settings-row-main');
        main.append(el('span', 'settings-row-name', item.name));
        main.append(el('span', 'settings-row-desc', item.description || ''));
        row.append(main);
        // Tag sits after the text at a fixed width, so names line up in both lists.
        if (kind === 'memory') row.append(el('span', 'tag', item.type || 'project'));
        row.onclick = () =>
          (kind === 'memory' ? openMemory(item.name) : openSkill(item.name)).catch((err) => addMessage('error', err.message));
        list.append(row);
        group.items.push(row);
      }
    })
    .catch((err) => list.replaceChildren(el('p', 'hint', err.message)))
    .finally(() => applySettingsFilter($('settingsSearch').value));
  return list;
}

function renderDangerZone(pane) {
  const zone = el('section', 'settings-group danger-zone');
  const head = el('header', 'danger-head');
  head.append(icon('warn'));
  head.append(el('h3', null, 'Danger zone'));
  head.append(el('span', 'danger-tag', 'Owner only'));
  zone.append(head);
  zone.append(el('p', 'danger-desc', 'Irreversible project actions. Each button opens a typed confirmation below it.'));
  settingsGroups.push({ id: 'danger', title: 'Danger zone', el: zone, items: [], collapsible: false });

  // Two-step arming, after the reference danger zone: the row's own button
  // moves down into the inline confirmation â€” no duplicate â€” stays dead
  // until the word is typed exactly, and a cancel or a successful confirm
  // moves it back up. On a failed confirm it stays open, next to the error
  // that guard raises in the chat. Only one confirmation can be armed at a
  // time: arming a row folds any other open confirmation back.
  const armed = [];
  const disarm = (s) => {
    const i = armed.indexOf(s);
    if (i !== -1) armed.splice(i, 1);
    s.box.hidden = true;
    s.input.value = '';
    s.controls.append(s.btn);
    s.btn.disabled = false;
    s.btn.onclick = s.arm;
  };

  const dangerRow = (label, desc, word, buttonLabel, action) => {
    const row = el('div', 'settings-row danger-row');
    row.dataset.search = `${label} ${desc}`.toLowerCase();
    const main = el('div', 'settings-row-main');
    main.append(el('span', 'settings-row-name', label));
    main.append(el('span', 'settings-row-desc', desc));
    row.append(main);

    const box = el('div', 'danger-confirm-box');
    box.hidden = true;
    const input = el('input');
    input.type = 'text';
    input.className = 'danger-confirm';
    input.id = `danger-word-${word}`;
    input.spellcheck = false;
    input.setAttribute('aria-label', `Type ${word} to confirm`);
    const prompt = el('label', 'danger-confirm-label');
    prompt.htmlFor = input.id;
    prompt.append('Type ', el('span', 'danger-code', word), ' to confirm');
    const cRow = el('div', 'danger-confirm-row');
    const cancel = el('button', 'btn', 'Cancel');

    // Controls come before the box in the DOM: the box spans the whole grid
    // row, so anything appended after it drops below it, out of the row.
    const controls = el('div', 'settings-row-controls');
    const btn = el('button', 'btn danger', buttonLabel);
    const state = { box, input, btn, controls };
    const arm = () => {
      for (const other of armed) if (other !== state) disarm(other);
      if (!armed.includes(state)) armed.push(state);
      cRow.append(btn);
      btn.disabled = true;
      box.hidden = false;
      btn.onclick = guard(async () => {
        await action();
        disarm(state);
      });
      input.focus();
    };
    state.arm = arm;
    btn.onclick = arm;
    cancel.onclick = () => { disarm(state); btn.focus(); };
    input.addEventListener('input', () => { btn.disabled = input.value.trim().toLowerCase() !== word.toLowerCase(); });
    cRow.append(input, cancel);
    box.append(prompt, cRow);
    controls.append(btn);
    row.append(controls);
    row.append(box);
    zone.append(row);
    settingsGroups.at(-1).items.push(row);
  };

  dangerRow(
    'Reset all settings',
    'Every setting returns to its factory default. Profiles, skills and sessions are untouched.',
    'reset',
    'Reset settings',
    async () => {
      state.settings = await api('settings/reset', {});
      renderSettingsPane();
    }
  );
  dangerRow(
    'Delete all sessions',
    'Every chat transcript in this project is removed. Groups stay.',
    'sessions',
    'Delete sessions',
    async () => {
      const { count } = await api('sessions/wipe', {});
      // Every chat here is gone; so is anything drafted for one.
      drafts.clear();
      if (state.sessionId) {
        state.sessionId = null;
        restoreDraft(null);
        syncBusy();
        state.undo = [];
        state.changes = null;
        renderChatChanges();
        $('messages').replaceChildren(el('p', 'empty-state', 'All sessions deleted.'));
      }
      await refreshLists();
      addMessage('system', `Deleted ${count} chat${count === 1 ? '' : 's'}.`);
    }
  );
  pane.append(zone);
}

/** One sidebar link per page. Search temporarily shows every matching page. */
function renderSettingsNav() {
  const nav = $('settingsNav');
  nav.replaceChildren();
  for (const g of settingsGroups) {
    const b = el('button', g.id === 'danger' ? 'danger' : null, g.id === 'danger' ? 'Danger zone' : g.title);
    b.onclick = () => {
      if (g.collapsible) setGroupOpen(g, true);
      $('settingsSearch').value = '';
      applySettingsFilter('');
      selectSettingsGroup(g.id);
    };
    g.navBtn = b;
    nav.append(b);
  }
  syncNavActive();
}

function selectSettingsGroup(id) {
  const chosen = settingsGroups.find((g) => g.id === id) || settingsGroups[0];
  if (!chosen) return;
  activeSettingsGroup = chosen.id;
  for (const g of settingsGroups) {
    g.el.classList.toggle('settings-section-active', g === chosen);
    if (g.navBtn) g.navBtn.classList.toggle('active', g === chosen);
  }
  $('settingsPane').scrollTop = 0;
}

/** Keep the persistent page selection reflected in the navigation. */
function syncNavActive() {
  const active = settingsGroups.find((g) => g.id === activeSettingsGroup) || settingsGroups[0];
  for (const g of settingsGroups) {
    g.el.classList.toggle('settings-section-active', g === active);
    if (g.navBtn) g.navBtn.classList.toggle('active', g === active);
  }
}

function applySettingsFilter(raw) {
  settingsQuery = String(raw || '').trim().toLowerCase();
  $('settingsPane').classList.toggle('searching', Boolean(settingsQuery));
  let any = false;
  for (const g of settingsGroups) {
    let hit = false;
    for (const item of g.items) {
      const ok = !settingsQuery || item.dataset.search.includes(settingsQuery);
      item.hidden = !ok;
      if (ok) hit = true;
    }
    g.el.hidden = settingsQuery ? !hit : false;
    if (g.navBtn) g.navBtn.hidden = settingsQuery ? !hit : false;
    if (hit && settingsQuery && g.collapsible) setGroupOpen(g, true);
    any = any || hit;
  }
  settingsNoMatch.hidden = any;
  if (!settingsQuery) selectSettingsGroup(activeSettingsGroup);
}

/** Enter in the search box: scroll to, flash and focus the next matching row. */
function jumpToNextMatch() {
  const target = settingsGroups
    .flatMap((g) => g.items)
    .find((n) => !n.hidden && n.offsetParent !== null);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('jumped');
  void target.offsetWidth;
  target.classList.add('jumped');
  const focusable = target.matches('input, select')
    ? target
    : target.querySelector('input, select, button');
  if (focusable && focusable !== $('settingsSearch')) focusable.focus({ preventScroll: true });
}

function renderSettingsPane() {
  const pane = $('settingsPane');
  pane.replaceChildren(settingsNoMatch);
  settingsRows = [];
  settingsGroups = [];

  // ---- Appearance -------------------------------------------------------------
  const appearance = startGroup(pane, { id: 'appearance', title: 'Appearance' });
  addRow(appearance, {
    key: 'theme',
    type: 'toggle',
    icon: 'eye',
    label: 'OLED black mode',
    desc: 'Pure black ground, neutral greys and a muted accent — pixels fully off, best on OLED panels. Off is the standard dark theme.',
    controlValue: () => (state.settings.theme || 'polar') === 'oled',
    // The row's sync runs on every update, including resets, so the <html>
    // theme class can never drift from the saved setting.
    onSync: () => applyTheme(),
    save: async (v) => {
      state.settings = await api('settings', settingPatch('theme', v ? 'oled' : 'polar'));
      applyTheme();
      for (const row of settingsRows) if (row.spec.key === 'theme') updateEntry(row);
    },
  });

  // ---- Updates ---------------------------------------------------------------
  const updates = startGroup(pane, { id: 'updates', title: 'Updates' });
  update.row = addRow(updates, {
    type: 'action',
    icon: 'download',
    label: 'Skadi version',
    desc: () => {
      const cur = update.info?.current;
      const id = [cur?.version ? `v${cur.version}` : null, shortSha(cur?.sha)].filter(Boolean).join(' · ');
      return `${id || 'Unknown version'} — ${updateSummary()}`;
    },
    render: (wrap, entry) => {
      wrap.replaceChildren();
      const check = el('button', 'btn tiny', update.checking ? 'Checking…' : 'Check for updates');
      check.type = 'button';
      check.disabled = update.checking || update.info?.enabled === false;
      check.onclick = guard(() => refreshUpdate({ force: true }));
      wrap.append(check);
      if (updateAvailable() && update.info?.installable !== false) {
        const now = el('button', 'btn tiny primary', 'Update now');
        now.type = 'button';
        now.onclick = openUpdateDialog;
        wrap.append(now);
      }
      entry.refs.descEl.textContent = entry.spec.desc();
    },
  });
  addRow(updates, {
    key: 'updateCheck',
    type: 'toggle',
    icon: 'download',
    label: 'Check for updates automatically',
    desc: 'Look for a newer release on GitHub when Skadi starts and every few hours. Nothing is installed until you choose Update now.',
    save: async (v) => {
      state.settings = await api('settings', settingPatch('updateCheck', v));
      refreshUpdate().catch(() => {});
    },
  });

  // ---- Model & provider ------------------------------------------------------
  const model = startGroup(pane, { id: 'model', title: 'Model & provider' });
  addRow(model, {
    type: 'text',
    mono: true,
    icon: 'archive',
    label: 'Models folder',
    desc: 'Where downloaded models are saved and where Skadi looks for them. Changing it leaves profiles pointing at the models they already use.',
    value: state.config.modelsDir || '',
    browse: () => chooseModelsFolder(),
    save: async (v) => {
      const res = await api('models/dir', { path: v });
      state.config = res.config;
      await refreshModels();
      await refreshQuickModels();
      renderSettingsPane();
    },
  });
  addRow(model, {
    type: 'select',
    icon: 'chip',
    label: 'Default provider',
    desc: 'Where a new chat starts. Each chat can pick its own from the model chip in the composer.',
    controlValue: () => state.activeProvider,
    options: state.providers.map((p) => [p.id, p.label]),
    save: async (v) => {
      const r = await api('provider/select', { id: v });
      await renderProviders(r.providers, r.active);
      renderSettingsPane();
    },
  });
  const provider = currentProvider();
  const managed = Boolean(provider?.managed);
  if (!managed && provider) {
    addRow(model, {
      type: 'secret',
      icon: 'key',
      label: 'API credential',
      desc: 'Write-only. Encrypted for your Windows account and never returned to this interface.',
      hasValue: Boolean(provider.hasKey),
      save: async (apiKey) => {
        const r = await api('provider/key', { id: provider.id, apiKey });
        await renderProviders(r.providers, state.activeProvider);
        activeSettingsGroup = 'model';
        renderSettingsPane();
      },
    });
  }
  addRow(model, {
    type: 'text',
    mono: true,
    icon: 'globe',
    label: 'Endpoint',
    desc: managed
      ? 'Served by Skadi. Each loaded model gets its own port, counting up from this one.'
      : 'OpenAI-compatible chat completions endpoint.',
    value: managed ? `http://${state.config.host}:${state.config.port}` : provider?.baseUrl || '',
    disabled: managed,
    save: async (v) => {
      const r = await api('provider/endpoint', { id: state.activeProvider, baseUrl: v });
      await renderProviders(r.providers, state.activeProvider);
      renderSettingsPane();
    },
  });
  addRow(model, {
    type: 'text',
    mono: true,
    icon: 'chip',
    label: 'Model',
    desc: managed
      ? 'Set per chat: pick a loaded model from the model chip in the composer.'
      : 'Model id sent to the endpoint.',
    value: managed ? (state.config.profiles[state.config.activeProfile]?.alias || '') : provider?.model || '',
    disabled: managed,
    save: async (v) => {
      const r = await api('provider/model', { id: state.activeProvider, model: v });
      await renderProviders(r.providers, state.activeProvider);
      renderSettingsPane();
    },
  });
  if (!managed) {
    const detected = provider?.contextTokens ?? null;
    const pinned = provider?.contextOverride ?? null;
    addRow(model, {
      type: 'text',
      mono: true,
      icon: 'archive',
      label: 'Context window',
      desc: pinned
        ? 'Pinned by hand. Clear the field to use what the endpoint reports.'
        : detected
          ? `${num(detected)} tokens, as ${provider?.label || 'the endpoint'} reports it for this model. Override only if it is wrong.`
          : 'This endpoint publishes no window for the model, so Skadi assumes 128,000. Set the real figure here — it decides when a chat is compacted.',
      value: pinned ? String(pinned) : '',
      placeholder: detected ? num(detected) : '128000',
      save: async (v) => {
        const r = await api('provider/context', { id: state.activeProvider, contextTokens: v.trim() });
        await renderProviders(r.providers, r.active);
        // Re-resolve the meter against the window that is now in force.
        state.ctxLimit = null;
        renderCtx(null, null);
        renderSettingsPane();
      },
    });
  }
  addRow(model, {
    type: 'toggle',
    icon: 'eye',
    label: 'Send images as vision',
    desc: 'Managed servers pass image blocks through; endpoint providers need a vision model.',
    controlValue: () => provider?.vision,
    save: async (v) => {
      const r = await api('provider/vision', { id: state.activeProvider, vision: v });
      await renderProviders(r.providers, r.active);
      renderSettingsPane();
    },
  });
  if (!managed) {
    addRow(model, {
      key: 'apiTemperature',
      type: 'range',
      min: 0,
      max: 2,
      step: 0.05,
      fmt: (v) => Number(v).toFixed(2),
      icon: 'sliders',
      label: 'Temperature',
      desc: 'Sampling randomness. 0 is near-deterministic; 2 is wild.',
    });
  }
  addRow(model, {
    key: 'compressionModel',
    type: 'text',
    mono: true,
    icon: 'archive',
    label: 'Compression model',
    desc: 'Optional cheap model used to summarise old turns. Empty uses the main model.',
  });

  const R = 'retry';
  addRow(model, {
    key: `${R}.attempts`,
    type: 'range',
    min: 1,
    max: 20,
    step: 1,
    fmt: (v) => (Number(v) === 1 ? 'no retries' : `${Number(v) - 1} retries`),
    icon: 'restart',
    label: 'Retry attempts',
    desc: 'How many times a request is sent before the turn fails. Covers rate limits (429) and gateway errors; nothing is retried once tokens have streamed.',
  });
  addRow(model, {
    key: `${R}.minDelaySec`,
    type: 'range',
    min: 1,
    max: 60,
    step: 1,
    fmt: (v) => `${v}s`,
    icon: 'stop',
    label: 'Retry wait, shortest',
    desc: 'Wait before the first retry. Each further failure doubles it.',
  });
  addRow(model, {
    key: `${R}.maxDelaySec`,
    type: 'range',
    min: 1,
    max: 120,
    step: 1,
    fmt: (v) => `${v}s`,
    icon: 'stop',
    label: 'Retry wait, longest',
    desc: 'Ceiling on the wait, including one the provider asks for itself.',
  });

  // ---- Fitting -----------------------------------------------------------------
  const fit = startGroup(pane, {
    id: 'fit',
    title: 'VRAM fitting',
  });
  addRow(fit, {
    key: 'autoFitOnStart',
    type: 'toggle',
    icon: 'chip',
    label: 'Fit before every launch',
    desc: 'Ask llama.cpp what fits on the card right now, and launch with that. Off launches the profile exactly as written.',
  });
  addRow(fit, {
    key: 'vramReserveMb',
    type: 'range',
    min: 256,
    max: 4096,
    step: 128,
    fmt: (v) => `${(v / 1024).toFixed(2)} GB`,
    icon: 'chip',
    label: 'VRAM kept free',
    desc: 'Room left for the desktop and the driver. Fill the card to the last byte and the driver quietly moves someone’s allocation to system RAM instead of refusing it — which is the slow, silent failure this whole panel exists to avoid.',
  });
  addRow(fit, {
    key: 'fitMode',
    type: 'select',
    icon: 'sliders',
    label: 'Auto-fit may change',
    options: [
      { value: 'off', label: 'Nothing' },
      { value: 'ctx', label: 'Context only' },
      { value: 'full', label: 'Context, cache and layers' },
    ],
    desc: 'How far the fitter may go. Context only is the safe setting: same model, shorter memory.',
  });
  addRow(fit, {
    key: 'fitPriority',
    type: 'select',
    icon: 'sliders',
    label: 'When it does not fit',
    options: [
      { value: 'speed', label: 'Keep context and cache — move layers to the CPU' },
      { value: 'context', label: 'Keep context — allow a coarser KV cache' },
      { value: 'quality', label: 'Keep the cache exact — allow a shorter context' },
    ],
    desc: 'What the fitter spends first. You have to give away one of the three; this says which. Spending speed needs "May move layers to CPU" on.',
  });
  addRow(fit, {
    key: 'ctxFloor',
    type: 'number',
    icon: 'chip',
    label: 'Never fit below',
    desc: 'Tokens. The fitter stops here and tells you it does not fit rather than handing you a 4K assistant.',
  });
  addRow(fit, {
    key: 'allowCpuLayers',
    type: 'toggle',
    icon: 'chip',
    label: 'May move layers to CPU',
    desc: 'The last resort, and the only adjustment that really costs tokens per second. On a Mixture-of-Experts model the fitter prefers moving expert tensors instead, which is far cheaper and is always allowed.',
  });
  addRow(fit, {
    key: 'minTokensPerSec',
    type: 'number',
    icon: 'chip',
    label: 'Warn below',
    desc: 'Tokens per second. Measured from llama-server’s own timings after a turn — nothing here can predict it, so the honest thing is to measure it and say when it is missed.',
  });

  // ---- Agent -------------------------------------------------------------------
  const agent = startGroup(pane, { id: 'agent', title: 'Agent' });
  addRow(agent, {
    key: 'permissionMode',
    type: 'select',
    icon: 'sliders',
    label: 'Permission mode',
    desc: () => (MODES.find((m) => m.value === (state.settings.permissionMode || 'default')) || MODES[0]).hint,
    options: MODES.map((m) => [m.value, m.label]),
  });
  addRow(agent, {
    key: 'approveWrites',
    type: 'toggle',
    icon: 'edit',
    label: 'Confirm file writes',
    desc: 'Ask before the agent writes or edits a file.',
  });
  addRow(agent, {
    key: 'approveCommands',
    type: 'toggle',
    icon: 'diff',
    label: 'Confirm shell commands',
    desc: 'Ask before the agent runs a command.',
  });
  addRow(agent, {
    key: 'autoSubagents',
    type: 'toggle',
    icon: 'chip',
    label: 'Automatic research subagents',
    desc: 'Automatically delegate bounded search, inspection, and summary work to a focused read-only child.',
  });
  addRow(agent, {
    key: 'autoSubagentReasoning',
    type: 'select',
    icon: 'chip',
    label: 'Subagent reasoning',
    desc: 'Default effort for automatically delegated work. None is fastest for routine research.',
    options: [['none', 'None'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']],
  });
  addRow(agent, {
    key: 'loopDetection',
    type: 'toggle',
    icon: 'restart',
    label: 'Semantic loop detection',
    desc: 'A lightweight supervisor detects non-progress, removes the bad step from active context, and redirects the agent.',
  });
  addRow(agent, {
    key: 'loopReviewEffort',
    type: 'select',
    icon: 'chip',
    label: 'Loop supervisor reasoning',
    desc: 'Reasoning used by the progress supervisor. None is fastest and is usually enough.',
    options: [['none', 'None'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']],
  });
  addRow(agent, {
    key: 'loopReviewEvery',
    type: 'range',
    min: 1,
    max: 10,
    step: 1,
    fmt: (v) => `every ${v} round${Number(v) === 1 ? '' : 's'}`,
    icon: 'restart',
    label: 'Semantic review cadence',
    desc: 'Exact repeats are caught immediately. The slower model-based reviewer runs at this interval.',
  });
  addRow(agent, {
    key: 'maxImplementationDiscoveryRounds',
    type: 'range',
    min: 1,
    max: 20,
    step: 1,
    fmt: (v) => String(v),
    icon: 'search',
    label: 'Discovery budget',
    desc: 'Base research rounds before an implementation request must start changing the deliverable.',
  });
  addRow(agent, {
    key: 'maxToolRounds',
    type: 'range',
    min: 0,
    max: 60,
    step: 1,
    fmt: (v) => (Number(v) === 0 ? 'off' : String(v)),
    icon: 'restart',
    label: 'Easy-task tool ceiling',
    desc: 'Skadi classifies each request. Medium tasks receive 2x and hard tasks 3.75x, with a small verification reserve after the first edit.',
  });
  addRow(agent, {
    key: 'commandTimeoutSec',
    type: 'number',
    icon: 'stop',
    label: 'Command timeout',
    desc: 'Seconds before a single shell command is killed.',
  });
  addRow(agent, {
    key: 'maxTurnMinutes',
    type: 'number',
    icon: 'stop',
    label: 'Turn safety limit',
    desc: 'Minutes before a long autonomous turn pauses with resumable progress. Set 0 to disable.',
  });
  addRow(agent, {
    key: 'webSearchProvider',
    type: 'select',
    icon: 'globe',
    label: 'Web search',
    desc: 'DuckDuckGo works without setup. SearXNG uses your own instance.',
    options: [['duckduckgo', 'DuckDuckGo'], ['searxng', 'SearXNG']],
  });
  addRow(agent, {
    key: 'searxngUrl',
    type: 'text',
    icon: 'globe',
    label: 'SearXNG URL',
    desc: 'Base URL of your SearXNG instance, for example http://localhost:8080.',
  });
  addRow(agent, {
    key: 'searxngAutoStart',
    type: 'toggle',
    icon: 'globe',
    label: 'Run SearXNG with Skadi',
    desc: 'Start and use a private local SearXNG container with Docker when Skadi runs. The first run downloads the image.',
  });
  addRow(agent, {
    key: 'searxngPort',
    type: 'number',
    icon: 'globe',
    label: 'Local SearXNG port',
    desc: 'Port for the bundled SearXNG service. Defaults to 8888.',
  });
  addRow(agent, {
    key: 'webSearchResults',
    type: 'number',
    icon: 'globe',
    label: 'Search results',
    desc: 'Default number returned to the agent (1–10).',
  });

  // ---- Memory --------------------------------------------------------------------
  const memory = startGroup(pane, { id: 'memory', title: 'Memory' });
  addRow(memory, {
    key: 'memoryInPrompt',
    type: 'toggle',
    icon: 'file',
    label: 'Memory index in prompt',
    desc: 'One line per durable fact, included every turn.',
  });
  for (const t of MEMORY_TYPES) {
    addRow(memory, {
      key: 'memoryTypes',
      type: 'toggle',
      icon: 'file',
      label: `Facts: ${t}`,
      desc: 'Shipped in the index.',
      check: (cur) => (cur || MEMORY_TYPES).includes(t),
      saveValue: (on) => {
        const set = new Set(state.settings.memoryTypes || MEMORY_TYPES);
        if (on) set.add(t);
        else set.delete(t);
        return MEMORY_TYPES.filter((x) => set.has(x));
      },
    });
  }
  listBlock(memory, 'memory');

  // ---- Skills --------------------------------------------------------------------
  const skills = startGroup(pane, { id: 'skills', title: 'Skills' });
  addRow(skills, {
    key: 'skillsInPrompt',
    type: 'toggle',
    icon: 'check',
    label: 'Skills catalogue in prompt',
    desc: 'Names and descriptions; bodies load on demand. Off hides skills until named.',
  });
  listBlock(skills, 'skill');

  // ---- Advanced (collapsed by default) -------------------------------------------
  const adv = startGroup(pane, { id: 'advanced', title: 'Advanced', collapsible: true });
  setGroupOpen(adv, advancedOpen);
  const C = 'compaction';
  addRow(adv, { key: `${C}.auto`, type: 'toggle', icon: 'archive', label: 'Auto-compact context', desc: 'Summarise older turns once context grows past the threshold.' });
  addRow(adv, { key: `${C}.threshold`, type: 'range', min: 0.1, max: 0.95, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`, icon: 'archive', label: 'Compact at', desc: 'Fraction of the context window that triggers compaction.' });
  addRow(adv, { key: `${C}.keepMessages`, type: 'number', icon: 'archive', label: 'Keep recent messages', desc: 'Recent messages kept verbatim beside the summary.' });
  addRow(adv, { key: `${C}.reserve`, type: 'number', icon: 'archive', label: 'Reserve tokens', desc: 'Tokens left free for the summary to write.' });
  addRow(adv, { key: `${C}.summaryMaxTokens`, type: 'number', icon: 'archive', label: 'Summary max output', desc: 'Token ceiling for the summary itself.' });
  addRow(adv, { key: `${C}.summaryInputTokens`, type: 'number', icon: 'archive', label: 'Summary input window', desc: 'How much of the older transcript the summary sees.' });
  addRow(adv, { key: `${C}.toolOutputChars`, type: 'number', icon: 'archive', label: 'Tool output kept', desc: 'Characters of tool output kept in the summary context.' });
  addRow(adv, { key: 'vramPollMs', type: 'number', icon: 'chip', label: 'VRAM poll interval', desc: 'Milliseconds between GPU memory samples.' });
  addRow(adv, { key: 'browserHeadless', type: 'toggle', icon: 'globe', label: 'Headless review browser', desc: 'The embedded browser the agent drives. Off gives it a real window — and audible sound.' });
  addRow(adv, { key: 'maxBrowsers', type: 'number', icon: 'globe', label: 'Browsers kept open', desc: 'Every chat drives its own browser; the least recently used one closes past this. 0 keeps them all.' });
  addRow(adv, { key: 'workspace', type: 'text', mono: true, icon: 'folder', label: 'Agent workspace', desc: 'Directory the agent’s file tools are confined to.' });

  // ---- Danger zone ----------------------------------------------------------------
  renderDangerZone(pane);

  renderSettingsNav();
  applyTheme();
  applySettingsFilter($('settingsSearch').value);
  pane.scrollTop = 0;
  syncNavActive();
}

$('settingsSearch').addEventListener('input', (e) => applySettingsFilter(e.target.value));
$('settingsSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    jumpToNextMatch();
  }
});
// ============================================================================
// Shell integration
//
// When Skadi runs inside its own frameless window the top bar *is* the title
// bar: it carries the window controls and it is what you drag. In an ordinary
// browser tab none of that applies, so the controls stay hidden.
// ============================================================================

function wireShell() {
  const shell = window.__SKADI_SHELL__ && window.skadiWindow;
  document.documentElement.classList.toggle('shell', Boolean(shell));
  $('windowControls').hidden = !shell;
  if (!shell) return;

  $('wcMin').onclick = () => window.skadiWindow.minimize();
  $('wcMax').onclick = () => window.skadiWindow.toggleMaximize();
  $('wcClose').onclick = () => window.skadiWindow.close();

  // Anything interactive in the bar must stay clickable, so only blank areas
  // start a drag.
  const draggable = (target) => !target.closest('button, select, input, a, summary, details, .status-pill');

  const bar = document.querySelector('.topbar');
  // A double-click on a real Windows title bar toggles maximise, but each of
  // our mousedowns is handed to Windows as a caption drag, so the button-up is
  // consumed by the move loop and the page never assembles a dblclick event.
  // Detect the second press here instead, with the same time-and-distance
  // limits Windows uses (500ms, a few pixels).
  let lastBarDown = null;
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !draggable(e.target)) return;
    const now = performance.now();
    if (
      lastBarDown &&
      now - lastBarDown.t < 500 &&
      Math.abs(e.clientX - lastBarDown.x) < 6 &&
      Math.abs(e.clientY - lastBarDown.y) < 6
    ) {
      lastBarDown = null;
      window.skadiWindow.toggleMaximize();
      return;
    }
    lastBarDown = { t: now, x: e.clientX, y: e.clientY };
    e.preventDefault();
    window.skadiWindow.drag();
  });
}

// The host toggles `is-maximized` on <html>; keep the glyph in step with it.
const maximizeObserver = new MutationObserver(() => {
  const maximized = document.documentElement.classList.contains('is-maximized');
  const use = $('wcMax')?.querySelector('use');
  if (use) use.setAttribute('href', maximized ? '#i-win-restore' : '#i-win-max');
  const btn = $('wcMax');
  if (btn) btn.title = maximized ? 'Restore' : 'Maximize';
});
maximizeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

// ============================================================================
// Updates from GitHub: a version chip under the chat list, a "what's new"
// dialog, and the same controls in Settings. The server does the checking and
// the installing; this only asks, shows and waits for it to come back.
// ============================================================================

const update = { info: null, checking: false, installing: false, row: null };
const shortSha = (sha) => (sha ? sha.slice(0, 7) : null);

async function refreshUpdate({ force = false } = {}) {
  update.checking = true;
  renderVersionChip();
  try {
    update.info = await api(force ? 'update/check' : 'update/status', force ? {} : undefined);
  } catch (err) {
    update.info = { enabled: true, current: update.info?.current, error: err.message };
  } finally {
    update.checking = false;
  }
  renderVersionChip();
  update.row?.refs.rerender?.();
  return update.info;
}

function updateAvailable() {
  return Boolean(update.info?.enabled && update.info.available);
}

function updateInstallable() {
  return updateAvailable() && update.info?.installable !== false;
}

function renderVersionChip() {
  const chip = $('versionChip');
  const info = update.info;
  const current = info?.current;
  if (!current?.version && !current?.sha) { chip.hidden = true; return; }
  chip.hidden = false;
  const available = updateAvailable();
  chip.classList.toggle('has-update', available);
  chip.classList.toggle('checking', update.checking);
  $('versionFlag').hidden = !available;
  const parts = [current.version ? `v${current.version}` : null, available && info.behind ? `(+${num(info.behind)})` : null, shortSha(current.sha)];
  $('versionText').textContent = parts.filter(Boolean).join(' ');
  chip.title = [
    available
      ? (info.behind != null ? `${num(info.behind)} commit${info.behind === 1 ? '' : 's'} behind main` : 'Update available')
      : 'Up to date',
    `Skadi${current.version ? ` v${current.version}` : ''}`,
    current.sha ? `commit ${shortSha(current.sha)}` : null,
  ].filter(Boolean).join(' · ');
}

function updateSummary() {
  const info = update.info;
  if (!info) return 'Not checked yet.';
  if (!info.enabled) return 'Updates are not available in this installation.';
  if (info.error && !info.latest) return `Could not check: ${info.error}`;
  if (!info.available) {
    const at = info.checkedAt ? new Date(info.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    return `Up to date${at ? ` — checked ${at}` : ''}.`;
  }
  const version = info.latest?.version ? `v${info.latest.version}` : shortSha(info.latest?.sha);
  const unavailable = info.installable === false ? ' — automatic install is disabled in the development checkout' : '';
  return `${version} is available${info.behind ? ` — ${num(info.behind)} change${info.behind === 1 ? '' : 's'} since this version` : ''}${unavailable}.`;
}

function openUpdateDialog() {
  const info = update.info;
  if (!updateInstallable()) return;
  const version = info.latest?.version ? `v${info.latest.version}` : null;
  $('updateTitle').textContent = 'New update available';
  $('updateSub').textContent = version
    ? `Skadi ${version} is ready to install.`
    : 'A new version of Skadi is ready to install.';
  const notes = $('updateNotes');
  notes.replaceChildren();
  const section = (title, items) => {
    if (!items?.length) return;
    notes.append(el('h3', null, title));
    const list = el('ul');
    for (const item of items) list.append(el('li', null, item));
    notes.append(list);
  };
  section("What's new", info.notes?.added);
  section('Fixed', info.notes?.fixed);
  if (!notes.children.length && info.latest?.message) section("What's new", [info.latest.message]);
  const more = info.notes?.more || 0;
  $('updateMore').textContent = more ? `+ ${num(more)} more change${more === 1 ? '' : 's'} included` : '';
  const go = $('updateGo');
  go.disabled = false;
  go.textContent = 'Update now';
  $('updateLater').hidden = false;
  $('updateVeil').querySelector('.update-error')?.remove();
  $('updateVeil').hidden = false;
  setTimeout(() => go.focus(), 0);
}

function closeUpdateDialog() {
  if (update.installing) return;
  $('updateVeil').hidden = true;
}

/** Install, then wait for the restarted server and load the new page. */
async function installUpdate() {
  if (update.installing) return;
  const go = $('updateGo');
  const previousPid = await fetch('/api/instance/pid').then((r) => r.text()).catch(() => null);
  update.installing = true;
  go.disabled = true;
  $('updateLater').hidden = true;
  $('updateVeil').querySelector('.update-error')?.remove();
  go.textContent = 'Downloading…';
  try {
    const result = await api('update/apply', { confirm: 'UPDATE' });
    if (!result.updated) { go.textContent = 'Already up to date'; return; }
    go.textContent = 'Restarting Skadi…';
    // The old server steps aside; wait for a different process to answer.
    const deadline = Date.now() + 90_000;
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < deadline) {
      const pid = await fetch('/api/instance/pid', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
      if (pid && pid !== previousPid) { location.reload(); return; }
      await new Promise((r) => setTimeout(r, 700));
    }
    go.textContent = 'Restart Skadi to finish';
  } catch (err) {
    go.disabled = false;
    go.textContent = 'Try again';
    $('updateLater').hidden = false;
    $('updateNotes').before(el('p', 'update-error', err.message));
  } finally {
    update.installing = false;
  }
}

function wireUpdates() {
  $('versionChip').onclick = () => {
    if (updateInstallable()) openUpdateDialog();
    else openSettings('updates');
  };
  $('updateGo').onclick = installUpdate;
  $('updateLater').onclick = closeUpdateDialog;
  $('updateClose').onclick = closeUpdateDialog;
  $('updateVeil').addEventListener('mousedown', (e) => { if (e.target === $('updateVeil')) closeUpdateDialog(); });
  refreshUpdate().catch(() => {});
}

async function boot() {
  wireUpdates();
  wireShell();
  wireChatPanel();
  wireMobileChats();
  wireRailResize();
  wireSplitResize();
  wireInspector();
  wireChatChanges();
  const s = await api('state');
  document.title = s.appName || 'Skadi';
  document.querySelector('.brand-name').textContent = document.title;
  // This page is read from disk on every load; the server's code is whatever
  // it imported when it started. When the files are newer, a fresh page can
  // call an endpoint the running process has never heard of -- which shows up
  // as "no route for ...". Say so plainly instead.
  if (s.staleSources?.length) {
    const names = s.staleSources.slice(0, 4).join(', ');
    toast(`Skadi's server is running older code than these files: ${names}${
      s.staleSources.length > 4 ? `, +${s.staleSources.length - 4} more` : ''}. Restart Skadi to load them.`);
  }
  // Tooling for whoever maintains this app; loaded only where the server offers it.
  if (s.canPublish || s.canFetch) {
    import('./deploy.js').then((m) => m.initDeploy({ s, api, askConfirm, askName, guard, $ })).catch(() => {});
  }
  state.config = s.config;
  state.settings = s.settings;
  state.settingsDefaults = s.settingsDefaults;
  applyTheme();
  state.editing = s.config.activeProfile;

  renderProjects(s.projects, s.activeProject);
  renderMode();
  await renderProviders(s.providers, s.activeProvider);
  setInstances(s.instances);
  renderEmptyReadiness();
  if (s.vram) renderVram(s.vram);
  if (s.logs?.length) $('logBox').textContent = s.logs.map(logLine).join('\n');

  wireBrowser();
  wireTasks();
  wireOverlays();
  wireToolDock();
  wireTerminalDock();
  wireFolderBrowser();
  await selectProfile(state.editing);
  refreshQuickModels();
  renderFields($('skadiSettings'), SKADI_FIELDS, state.settings, async (key, value) => {
    state.settings = await api('settings', { [key]: value });
  });
  await refreshLists();
  await refreshTasks();
  connect();

  // Turns survive a window reload -- they run in the server, not here. Pick
  // them back up rather than showing an idle composer that would start a
  // second turn over the same chat.
  if (s.turns?.length) {
    state.running = new Set(s.turns);
    renderChatList();
    if (!state.sessionId) {
      try {
        await openSession(s.turns[0]);
        setActivity('Working…');
      } catch { /* deleted mid-turn; the stream events still land */ }
    }
    syncBusy();
  }
}

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<pre style="color:#ff6f7d;padding:18px;font:13px ui-monospace,monospace">Skadi failed to start: ${escapeHtml(err.message)}</pre>`,
  );
});
