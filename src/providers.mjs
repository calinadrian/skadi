// Providers: where completions come from.
//
// Skadi speaks two wire formats. `openai` covers the local llama-server plus
// OpenAI, OpenRouter, Groq, DeepSeek and anything else OpenAI-compatible.
// `anthropic` is its own shape and gets a dedicated adapter.
//
// Messages are held internally in an OpenAI-shaped form and converted on the
// way out, so the agent loop never needs to know which provider is active.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { ROOT, DEFAULT_SETTINGS, loadSettings } from './config.mjs';

export const PROVIDERS_PATH = join(ROOT, 'config', 'providers.json');
export const SECRETS_PATH = join(ROOT, 'config', 'secrets.json');
export const SECRETS_KEY_PATH = join(ROOT, 'config', 'secrets.key');
const SECRETS_VERSION = 2;

const DEFAULTS = {
  active: 'local',
  providers: {
    local: {
      kind: 'openai',
      label: 'Local — llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      managed: true, // Skadi launches and supervises this one
      // Default on: text-only models simply ignore image blocks via
      // flattenContent, while VL builds with --mmproj actually see them.
      // Toggle per provider in Settings → Model.
      vision: true,
    },
    anthropic: {
      kind: 'anthropic',
      label: 'Anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-5',
      models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
      vision: true,
      maxTokens: 8192,
    },
    openai: {
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      vision: true,
    },
    openrouter: {
      kind: 'openai',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.5',
      vision: true,
    },
  },
};

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function loadProviders() {
  const cfg = readJson(PROVIDERS_PATH, DEFAULTS);
  // Merge in any provider added to DEFAULTS since the file was written.
  cfg.providers = { ...DEFAULTS.providers, ...cfg.providers };
  return cfg;
}

export function saveProviders(cfg) {
  writeJson(PROVIDERS_PATH, cfg);
  return cfg;
}

/**
 * Protect one value with Windows DPAPI, scoped to the signed-in user.
 *
 * The secret is sent over stdin, never in the process arguments, command
 * history, logs, provider config, or an API response. A copied secrets file
 * therefore cannot be decrypted by another Windows account or machine.
 */
function dpapi(mode, value) {
  const action = mode === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$raw = [Console]::In.ReadToEnd()',
    mode === 'protect'
      ? '$bytes = [Text.Encoding]::UTF8.GetBytes($raw)'
      : '$bytes = [Convert]::FromBase64String($raw)',
    `$result = [Security.Cryptography.ProtectedData]::${action}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    mode === 'protect'
      ? '[Console]::Out.Write([Convert]::ToBase64String($result))'
      : '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], {
    input: String(value),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Windows could not ${mode} the provider credential for this user.`);
  }
  return result.stdout;
}

function restrictToCurrentWindowsUser(path) {
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', windowsHide: true,
  });
  const sid = identity.stdout?.match(/S-1-[\d-]+/i)?.[0];
  if (!sid) throw new Error('Windows could not identify the account used to protect provider credentials.');
  const acl = spawnSync('icacls.exe', [
    path,
    '/inheritance:r',
    '/grant:r', `*${sid}:(F)`,
    '/grant:r', '*S-1-5-18:(F)', // LocalSystem, for an explicitly elevated launch.
  ], { encoding: 'utf8', windowsHide: true });
  if (acl.status !== 0 || acl.error) {
    throw new Error('Windows could not restrict the credential encryption key to this account.');
  }
}

function localMasterKey() {
  if (existsSync(SECRETS_KEY_PATH)) {
    const key = Buffer.from(readFileSync(SECRETS_KEY_PATH, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('The local credential encryption key is invalid.');
    return key;
  }
  mkdirSync(dirname(SECRETS_KEY_PATH), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(SECRETS_KEY_PATH, key.toString('base64'), { encoding: 'utf8', flag: 'wx' });
  try { chmodSync(SECRETS_KEY_PATH, 0o600); } catch { /* Windows uses the ACL below. */ }
  restrictToCurrentWindowsUser(SECRETS_KEY_PATH);
  return key;
}

function aesProtect(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join('.');
}

function aesUnprotect(value, key) {
  const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64'));
  if (iv?.length !== 12 || tag?.length !== 16 || !encrypted) throw new Error('The protected credential is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function writeSecrets(secrets) {
  let payload = secrets;
  if (process.platform === 'win32') {
    try {
      payload = {
        version: SECRETS_VERSION,
        protection: 'dpapi-user',
        protected: Object.fromEntries(
          Object.entries(secrets).map(([id, secret]) => [id, dpapi('protect', secret)]),
        ),
      };
    } catch {
      const key = localMasterKey();
      payload = {
        version: SECRETS_VERSION,
        protection: 'aes-256-gcm-user-acl',
        protected: Object.fromEntries(
          Object.entries(secrets).map(([id, secret]) => [id, aesProtect(secret, key)]),
        ),
      };
    }
  }
  writeJson(SECRETS_PATH, payload);
  try {
    chmodSync(SECRETS_PATH, 0o600);
  } catch {
    // Best effort; Windows ACLs are not POSIX modes.
  }
}

/** API keys live apart from config and are decrypted only inside the server. */
export function loadSecrets() {
  const stored = readJson(SECRETS_PATH, {});
  if (stored?.version === SECRETS_VERSION && stored.protected) {
    if (stored.protection === 'aes-256-gcm-user-acl') {
      const key = localMasterKey();
      return Object.fromEntries(
        Object.entries(stored.protected).map(([id, secret]) => [id, aesUnprotect(secret, key)]),
      );
    }
    return Object.fromEntries(
      Object.entries(stored.protected).map(([id, secret]) => [id, dpapi('unprotect', secret)]),
    );
  }

  // Transparently migrate the old plaintext file the first time this build
  // reads it. Never leave a newly supplied credential in the legacy format.
  if (process.platform === 'win32' && Object.keys(stored).length) writeSecrets(stored);
  return stored;
}

export function saveSecret(providerId, apiKey) {
  const secrets = loadSecrets();
  if (apiKey) secrets[providerId] = apiKey;
  else delete secrets[providerId];
  writeSecrets(secrets);
  return Object.keys(secrets);
}

/** Which providers have a usable key, without ever returning the key itself. */
export function providerStatus() {
  const cfg = loadProviders();
  const secrets = loadSecrets();
  return Object.entries(cfg.providers).map(([id, p]) => ({
    id,
    label: p.label || id,
    kind: p.kind,
    managed: Boolean(p.managed),
    vision: Boolean(p.vision),
    model: p.model || null,
    // What the user pinned by hand, if anything. The resolved window (this,
    // or the figure the endpoint reports for the model) is filled in by the
    // server for the active provider.
    contextOverride: Number(p.contextTokens) || null,
    models: p.models || [],
    baseUrl: p.baseUrl,
    hasKey: p.managed ? true : Boolean(secrets[id] || (p.apiKeyEnv && process.env[p.apiKeyEnv])),
  }));
}

export function resolveProvider(id, cfg = loadProviders()) {
  const provider = cfg.providers[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  const secrets = loadSecrets();
  const apiKey =
    secrets[id] || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : null) ||
    (provider.managed ? 'sk-no-key-required' : null);
  return { id, ...provider, apiKey };
}

// Model lists are cached per endpoint: OpenRouter's catalogue is large and the
// provider panel refetches on every render, so repulling it each time is waste.
const modelCache = new Map(); // baseUrl -> { at, models }
const MODEL_LIST_TTL_MS = 5 * 60 * 1000;

/**
 * Ask an endpoint what it can serve. One entry per model:
 * { id, name?, free?, contextTokens?, maxCompletionTokens?, reasoning? }.
 * Endpoints that report a display name, pricing and limits (OpenRouter) fill
 * them in; `free` is true when prompt and completion are both priced at zero.
 * Plain endpoints (OpenAI, local llama-server) yield bare ids, so the UI falls
 * back to showing the id itself.
 *
 * `reasoning` is deliberately tri-state: true, false, or absent. Absent means
 * the endpoint did not say, which is not the same as "no" -- only OpenRouter
 * declares this, and a picker greyed out because we simply did not ask would
 * be worse than one that does nothing.
 */
export async function listModels(provider) {
  if (provider.kind !== 'openai') return (provider.models || []).map((id) => ({ id }));
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const cached = modelCache.get(baseUrl);
  if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.models;

  const res = await fetch(`${baseUrl}/models`, {
    headers: authHeaders(provider),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`/models returned ${res.status}`);
  const body = await res.json();
  const models = (body.data || [])
    .map((m) => {
      const entry = { id: m.id };
      if (m.name) entry.name = m.name;
      if (m.pricing != null) {
        entry.free = Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0;
      }
      // The window the endpoint says this model has. Guessing it wrong is not
      // cosmetic: the same number decides when a session gets compacted.
      const ctx = Number(m.context_length ?? m.context_window);
      if (Number.isFinite(ctx) && ctx > 0) entry.contextTokens = ctx;
      const maxOut = Number(m.top_provider?.max_completion_tokens ?? m.max_completion_tokens);
      if (Number.isFinite(maxOut) && maxOut > 0) entry.maxCompletionTokens = maxOut;
      // Whether an effort setting would reach this model at all. OpenRouter
      // drops parameters a model does not take rather than refusing the
      // request, so without this a reasoning picker on a model like
      // stealth/union-alpha -- which lists no reasoning parameter of any kind
      // -- looks like it works and silently does nothing.
      if (Array.isArray(m.supported_parameters)) {
        entry.reasoning = m.supported_parameters.includes('reasoning')
          || m.supported_parameters.includes('reasoning_effort');
      }
      return entry;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  modelCache.set(baseUrl, { at: Date.now(), models });
  return models;
}

/**
 * What one model can actually take, as its own endpoint reports it. Null when
 * the endpoint does not say, or cannot be reached -- the caller then falls
 * back to its own default rather than pretending to know.
 */
export async function modelLimits(provider, model = provider?.model) {
  if (!provider || !model) return null;
  let models;
  try {
    models = await listModels(provider);
  } catch {
    return null;
  }
  const entry = models.find((m) => m.id === model);
  if (!entry) return null;
  return {
    contextTokens: entry.contextTokens ?? null,
    maxCompletionTokens: entry.maxCompletionTokens ?? null,
    // null, not false, when the endpoint did not say. See `listModels`.
    reasoning: entry.reasoning ?? null,
  };
}

/**
 * Does this endpoint speak OpenRouter's reasoning dialect?
 *
 * OpenRouter's documented field is a `reasoning` object rather than OpenAI's
 * flat `reasoning_effort`. Measured against the live API, the flat form works
 * too -- the gateway normalises it, including for models whose
 * `supported_parameters` advertise only the object -- so this is the
 * documented spelling, not a fix for a behaviour difference, and nothing is
 * known to be lost by the alias today. It is here so the request says what
 * OpenRouter documents instead of relying on an alias it happens to accept.
 *
 * What does change behaviour is `listModels` marking a model that takes no
 * reasoning parameter at all; that is the case the picker has to refuse.
 */
export function isOpenRouter(provider) {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(provider?.baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Put the reasoning effort into the spelling this endpoint reads, in place.
 *
 * The caller states the effort once, in OpenAI's flat form; which field a
 * given gateway actually looks at is decided here. Returns the same body, so
 * it reads as a step in building the request.
 */
export function applyReasoningDialect(body, provider) {
  if (body?.reasoning_effort && isOpenRouter(provider)) {
    body.reasoning = { effort: body.reasoning_effort };
    delete body.reasoning_effort;
  }
  return body;
}

/**
 * The marker a repaired tool call carries. A model can cut off mid-arguments
 * -- a dropped stream, or simply a bad generation -- leaving a `arguments`
 * string that is not JSON. Storing that verbatim poisons the transcript: every
 * later request replays it, and endpoints that validate tool calls reject the
 * whole conversation from then on, often with nothing more useful than
 * "ERROR". So the text is preserved *inside* valid JSON instead, and the agent
 * turns it back into the same "not valid JSON" result for the model to correct.
 */
export const INVALID_ARGS_KEY = '__skadi_invalid_arguments';

/**
 * Make one tool call's arguments legal JSON without losing what was said.
 * Valid arguments pass through untouched.
 */
export function repairToolArguments(call) {
  const raw = call?.function?.arguments;
  if (typeof raw !== 'string' || !raw.trim()) return call;
  try {
    const parsed = JSON.parse(raw);
    // Legal JSON that is not an object is just as unusable as no JSON at all.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return call;
    throw new Error('arguments must be a JSON object');
  } catch (err) {
    call.function.arguments = JSON.stringify({
      [INVALID_ARGS_KEY]: { reason: err.message, received: raw.slice(0, 500) },
    });
    return call;
  }
}

// --------------------------------------------------------------- HTTP errors

/**
 * A non-2xx response from a provider. Carries the status so the retry loop can
 * tell a transient upstream hiccup from a request that will never succeed.
 */
export class ProviderHttpError extends Error {
  constructor(message, { status, body, retryAfterMs, upstream = false, upstreamName = null }) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs ?? null;
    // The gateway accepted the request and the model behind it failed, rather
    // than the request itself being wrong. Transient, whatever the status says.
    this.upstream = upstream;
    this.upstreamName = upstreamName;
  }
}

// Worth another attempt: rate limits and the gateway errors that OpenRouter
// and friends return while an upstream pool is saturated or restarting.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Never worth another attempt, whoever the failure came from: the key is
// wrong, unpaid or not allowed to use the model. Replaying only burns time.
const NEVER_RETRY = new Set([401, 402, 403]);

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * The readable part of a gateway's failure payload. Gateways bury the useful
 * sentence inside `error.message` or `error.metadata.raw`; dumping 400 chars of
 * JSON at the user hides it.
 *
 * A gateway failure has two authors: the gateway, and the model endpoint it
 * proxied to. OpenRouter reports the second in `error.metadata` -- the
 * upstream's verbatim body in `raw`, its name in `provider_name`. Knowing
 * which one failed is the difference between "fix your request" and "try
 * again in a moment", so it is carried on the error rather than discarded.
 */
function describeFailure(err, fallback = '') {
  let detail = fallback;
  let upstream = false;
  let upstreamName = null;
  let remedy = null;
  const meta = err?.metadata;
  if (typeof meta?.provider_name === 'string') upstreamName = meta.provider_name;
  // Gateways sometimes say what would actually fix it. Worth repeating.
  if (typeof meta?.remedy_hint === 'string') remedy = meta.remedy_hint;
  if (typeof meta?.raw === 'string') {
    detail = meta.raw;
    upstream = true;
  } else if (typeof err?.message === 'string') {
    detail = err.message;
    if (/provider returned error|upstream error|overloaded/i.test(err.message)) upstream = true;
  }
  // Anthropic names the condition rather than describing it.
  if (/overloaded/i.test(String(err?.type || ''))) upstream = true;
  return { detail, upstream, upstreamName, remedy };
}

/** Say whose failure it was, and whether waiting is likely to help. */
function failureMessage(label, status, { detail, upstream, upstreamName, remedy }) {
  let message = `${label} returned ${status}: ${detail}`;
  // "400: ERROR" reads like a bug in the request until you know the request
  // was fine and the model behind it fell over. A 429 is the upstream
  // refusing to serve right now rather than failing, so it gets the
  // attribution without the "we were accepted" reassurance.
  if (upstream) {
    const who = `upstream${upstreamName ? ` ${upstreamName}` : ''}`;
    message += status === 429
      ? ` (${who} is rate-limiting)`
      : ` (${who} failed; the request itself was accepted)`;
  }
  if (remedy) message += ` ${remedy.split(/\s*\(https?:/)[0].trim()}`;
  return message;
}

/** Turn a failed response into an error worth reading. */
async function httpError(provider, res, label = provider.label || provider.id) {
  const raw = await res.text().catch(() => '');
  let parsed = null;
  try {
    const body = JSON.parse(raw);
    parsed = body?.error ?? body;
  } catch {
    // Not JSON: the raw slice is the best detail available.
  }
  const described = describeFailure(parsed, raw.slice(0, 400));
  let message = failureMessage(label, res.status, described);
  // OpenRouter rejects the whole request when no endpoint behind the chosen
  // model accepts tool definitions. Retrying cannot help, and the stock
  // message ("try disabling <some tool>") points at the wrong fix.
  if (res.status === 404 && /support tool use/i.test(raw)) {
    message = `${label}: the model "${provider.model || 'selected'}" has no endpoint that supports tool calling. ` +
      'Pick a tool-capable model in the provider panel.';
  }

  return new ProviderHttpError(message, {
    status: res.status,
    body: raw.slice(0, 2000),
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    upstream: described.upstream,
    upstreamName: described.upstreamName,
  });
}

/**
 * The failure a 200 can still carry.
 *
 * A gateway answers the request, opens the stream, and only then does the
 * model behind it fall over -- so the failure arrives as a frame inside a
 * stream that has already succeeded at the HTTP level. OpenRouter does this
 * whenever an upstream drops out of its pool mid-request; Anthropic sends an
 * `error` event for an overloaded server the same way.
 *
 * Ignored, as these frames were, the stream just ends: the turn stops with no
 * text, no error and no retry, and the chat reads as though the model chose
 * to say nothing. Raising the error an HTTP failure would have raised puts
 * them back under the retry loop, which is where a 502 belongs.
 *
 * Returns null for every frame that is not a failure -- which is nearly all
 * of them.
 */
function streamError(frame, label) {
  const err = frame?.error ?? frame?.choices?.[0]?.error;
  if (!err || typeof err !== 'object') return null;
  const described = describeFailure(err, JSON.stringify(err).slice(0, 400));
  // The frame carries the upstream's own status when it has one. A stream
  // that breaks without one is still a gateway failing after saying yes, so
  // it is treated as the 502 it behaves like rather than passed over.
  const status = Number(err.code ?? err.status) || 502;
  return new ProviderHttpError(failureMessage(label, status, described), {
    status,
    body: JSON.stringify(frame).slice(0, 2000),
    upstream: described.upstream,
    upstreamName: described.upstreamName,
  });
}

function authHeaders(provider) {
  if (provider.kind === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${provider.apiKey || ''}`,
  };
}

// ---------------------------------------------------------------- SSE helper

/** Yield decoded `data:` payloads from a fetch response body. */
async function* sseEvents(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Keep-alive comments and partial frames are not fatal.
        }
      }
    }
  }
}

// ------------------------------------------------------- message conversion

/** Internal blocks -> OpenAI content. Images become data URLs. */
function toOpenAiContent(content) {
  if (typeof content === 'string' || content == null) return content;
  return content.map((block) =>
    block.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
      : { type: 'text', text: block.text });
}

/** The base64 payload an image block costs on the wire. */
const imageBytes = (block) => (block?.type === 'image' ? String(block.data || '').length : 0);

/**
 * Keep a request's images under a byte ceiling, newest first.
 *
 * Compaction measures the window in tokens, and an image is the one thing
 * that is cheap in tokens and vast in bytes: a screenshot costs about 1,300
 * tokens and half a megabyte. A chat that takes a dozen of them is still only
 * a sixth of the way through its context while the request itself has grown
 * past what a gateway will accept -- and the failure is a 502 with no
 * explanation, identical on every retry, because nothing about it is
 * transient.
 *
 * So the oldest images are left out of the *request* once the budget is
 * spent, each replaced by a line saying so. They stay in the session file and
 * in the chat: this trims what is sent, never what was said. The newest
 * images survive, because the screenshot just taken is the one the turn is
 * about.
 *
 * Returns the original array untouched when everything already fits, so the
 * ordinary chat pays nothing for this.
 */
export function fitImageBudget(messages, maxBytes) {
  if (!Array.isArray(messages) || !(maxBytes > 0)) return messages;
  let total = 0;
  for (const m of messages) {
    if (Array.isArray(m?.content)) for (const b of m.content) total += imageBytes(b);
  }
  if (total <= maxBytes) return messages;

  // Walk backwards: the newest images get first claim on the budget.
  let spent = 0;
  const out = messages.slice();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!Array.isArray(message?.content)) continue;
    if (!message.content.some((b) => b.type === 'image')) continue;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== 'image') return block;
      const cost = imageBytes(block);
      if (spent + cost <= maxBytes) {
        spent += cost;
        return block;
      }
      changed = true;
      return {
        type: 'text',
        text: '[earlier screenshot omitted from this request to stay within the provider’s size limit — it is still in the chat]',
      };
    });
    if (changed) out[i] = { ...message, content };
  }
  return out;
}

/** Flatten multimodal content for a model that cannot see images. */
function flattenContent(content) {
  if (typeof content === 'string' || content == null) return content;
  return content
    .map((block) => (block.type === 'image' ? '[image attached — this model cannot view images]' : block.text))
    .join('\n');
}

function toAnthropic(messages) {
  const system = [];
  const out = [];

  for (const message of messages) {
    if (message.role === 'system') {
      system.push(typeof message.content === 'string' ? message.content : flattenContent(message.content));
      continue;
    }

    if (message.role === 'tool') {
      // Anthropic carries tool results as user-role blocks, and consecutive
      // results must be merged into a single message.
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const blocks = [];
      const text = typeof message.content === 'string' ? message.content : flattenContent(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        let input = {};
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : (message.content || []).map((block) =>
          block.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } }
            : { type: 'text', text: block.text });
    out.push({ role: 'user', content });
  }

  return { system: system.join('\n\n'), messages: out };
}

// ------------------------------------------------------------------ adapters

async function streamOpenAi(provider, params, handlers, signal) {
  const { model, messages, tools, sampling } = params;
  const vision = provider.vision !== false;

  const body = {
    model,
    messages: messages.map((m) => ({
      ...m,
      content: vision ? toOpenAiContent(m.content) : flattenContent(m.content),
    })),
    stream: true,
    stream_options: { include_usage: true },
    ...sampling,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // The caller states the effort once, in OpenAI's spelling; each endpoint's
  // own spelling is this adapter's business, the way the Anthropic one turns
  // the same value into a thinking budget. See `applyReasoningDialect`.
  applyReasoningDialect(body, provider);

  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(provider, res);

  const message = { role: 'assistant', content: '' };
  const toolCalls = new Map();
  let reasoning = '';
  let usage = null;
  let timings = null;
  let finishReason = null;

  for await (const parsed of sseEvents(res)) {
    // A 200 that fails halfway through still fails; see streamError.
    const failure = streamError(parsed, provider.label || provider.id);
    if (failure) throw failure;
    if (parsed.usage) usage = parsed.usage;
    if (parsed.timings) timings = parsed.timings; // llama.cpp extension
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;

    const think = delta.reasoning_content ?? delta.reasoning;
    if (think) {
      reasoning += think;
      handlers.onReasoning?.(think);
    }
    if (delta.content) {
      message.content += delta.content;
      handlers.onText?.(delta.content);
    }
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      const existing = toolCalls.get(index) || {
        id: part.id || `call_${index}`,
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (part.id) existing.id = part.id;
      if (part.function?.name) existing.function.name += part.function.name;
      if (part.function?.arguments) existing.function.arguments += part.function.arguments;
      toolCalls.set(index, existing);
    }
  }

  if (toolCalls.size) message.tool_calls = [...toolCalls.values()].map(repairToolArguments);
  if (reasoning) message.reasoning_content = reasoning;
  if (!message.content && message.tool_calls) delete message.content;
  return { message, usage, timings, finishReason };
}

async function streamAnthropic(provider, params, handlers, signal) {
  const { model, messages, tools, sampling } = params;
  const { system, messages: converted } = toAnthropic(messages);

  const body = {
    model,
    max_tokens: sampling?.max_tokens || provider.maxTokens || 8192,
    messages: converted,
    stream: true,
  };
  if (system) body.system = system;
  if (sampling?.temperature != null) body.temperature = Math.min(sampling.temperature, 1);
  if (sampling?.top_p != null) body.top_p = sampling.top_p;
  // Opencode-style effort ladder mapped onto Anthropic's thinking budget.
  // 'default' (or absent) sends nothing, preserving the provider default.
  const effortBudget = { minimal: 1024, low: 4096, medium: 10000, high: 20000, xhigh: 32000, max: 32000 };
  const effort = String(sampling?.reasoning_effort || '').toLowerCase();
  if (effort && effort !== 'default' && effortBudget[effort]) {
    body.thinking = { type: 'enabled', budget_tokens: Math.min(effortBudget[effort], (body.max_tokens || 8192) - 1) };
    // Thinking requires temperature 1 on Anthropic.
    body.temperature = 1;
  }
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/messages`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(provider, res, 'Anthropic');

  const message = { role: 'assistant', content: '' };
  const blocks = new Map(); // index -> { type, name, id, json }
  let reasoning = '';
  let usage = null;
  let finishReason = null;

  for await (const event of sseEvents(res)) {
    // A 200 that fails halfway through still fails; see streamError.
    const failure = streamError(event, 'Anthropic');
    if (failure) throw failure;
    switch (event.type) {
      case 'message_start':
        usage = event.message?.usage || usage;
        break;
      case 'content_block_start':
        blocks.set(event.index, {
          type: event.content_block?.type,
          id: event.content_block?.id,
          name: event.content_block?.name,
          json: '',
        });
        break;
      case 'content_block_delta': {
        const delta = event.delta || {};
        if (delta.type === 'text_delta') {
          message.content += delta.text;
          handlers.onText?.(delta.text);
        } else if (delta.type === 'thinking_delta') {
          reasoning += delta.thinking;
          handlers.onReasoning?.(delta.thinking);
        } else if (delta.type === 'input_json_delta') {
          const block = blocks.get(event.index);
          if (block) block.json += delta.partial_json;
        }
        break;
      }
      case 'message_delta':
        if (event.usage) usage = { ...usage, ...event.usage };
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        break;
      default:
        break;
    }
  }

  const calls = [...blocks.values()]
    .filter((b) => b.type === 'tool_use')
    .map((b) => repairToolArguments({ id: b.id, type: 'function', function: { name: b.name, arguments: b.json || '{}' } }));
  if (calls.length) message.tool_calls = calls;
  if (reasoning) message.reasoning_content = reasoning;
  if (!message.content && message.tool_calls) delete message.content;

  // Normalise usage onto the OpenAI field names the UI already understands.
  if (usage) {
    usage = {
      prompt_tokens: usage.input_tokens ?? usage.prompt_tokens,
      completion_tokens: usage.output_tokens ?? usage.completion_tokens,
    };
  }
  return { message, usage, timings: null, finishReason };
}

// ------------------------------------------------------------------- retries

/**
 * The image ceiling in bytes, from settings. 0 or a nonsensical value turns
 * the trimming off rather than clamping every image away.
 */
function imageBudget(settings = loadSettings()) {
  const mb = Number(settings.maxImageMb ?? DEFAULT_SETTINGS.maxImageMb);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 0;
}

/**
 * Read the retry policy out of settings, repairing anything the user (or an
 * older settings.json) left missing or nonsensical -- a max below the min
 * would otherwise clamp every wait to the wrong bound.
 */
function retryPolicy(settings = loadSettings()) {
  const d = DEFAULT_SETTINGS.retry;
  const r = settings.retry || {};
  const num = (v, fallback, lo, hi) =>
    (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), lo), hi) : fallback);
  const minDelayMs = num(r.minDelaySec, d.minDelaySec, 0, 600) * 1000;
  const maxDelayMs = Math.max(num(r.maxDelaySec, d.maxDelaySec, 0, 600) * 1000, minDelayMs);
  return { attempts: num(r.attempts, d.attempts, 1, 50), minDelayMs, maxDelayMs };
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // An abort that landed before we got here has already fired, so its
    // listener would never fire: settle immediately instead of sleeping out
    // a backoff the caller has already told us to stop.
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run one streaming completion against the active provider.
 * Returns { message, usage, timings, finishReason, tps, elapsedMs }.
 */
export async function streamCompletion(provider, params, handlers = {}, signal) {
  if (!provider.apiKey && !provider.managed) {
    throw new Error(`No API key set for ${provider.label || provider.id}. Add one in the provider panel.`);
  }

  let startedAt = Date.now();
  let firstTokenAt = null;
  const wrapped = {
    onText: (t) => {
      firstTokenAt ??= Date.now();
      handlers.onText?.(t);
    },
    onReasoning: (t) => {
      firstTokenAt ??= Date.now();
      handlers.onReasoning?.(t);
    },
  };

  // Trim the images down to what the endpoint will accept before any attempt,
  // so a request that is simply too large to be served is never sent eight
  // times over. See `fitImageBudget`.
  const maxImageBytes = params.maxImageBytes ?? imageBudget();
  const fitted = fitImageBudget(params.messages, maxImageBytes);
  if (fitted !== params.messages) {
    handlers.onImagesTrimmed?.({ maxImageBytes });
    params = { ...params, messages: fitted };
  }

  const run = provider.kind === 'anthropic' ? streamAnthropic : streamOpenAi;
  const { attempts, minDelayMs, maxDelayMs } = params.retry ?? retryPolicy();
  let result;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await run(provider, params, wrapped, signal);
      break;
    } catch (err) {
      // A 400 normally means the request is malformed and replaying it is
      // pointless -- but a gateway that answers 400 because *its* upstream
      // errored is describing a moment, not a mistake, and the next attempt
      // often lands on a healthy endpoint.
      const retryable = err instanceof ProviderHttpError
        && !NEVER_RETRY.has(err.status)
        && (RETRY_STATUSES.has(err.status) || err.upstream);
      // Only a request that produced nothing can be replayed: once deltas have
      // reached the caller, a second attempt would duplicate them.
      if (!retryable || attempt >= attempts || firstTokenAt || signal?.aborted) {
        // Say how hard it was tried. "OpenRouter returned 502" on its own
        // reads like one unlucky request, and the answer it actually calls
        // for -- this upstream has been down for minutes, pick another model
        // -- stays invisible unless the count is on the message.
        if (retryable && attempt > 1) {
          err.attempts = attempt;
          err.message += ` — gave up after ${attempt} attempts.`;
        }
        throw err;
      }
      // Back off from the floor, doubling per failure, capped at the ceiling.
      // The provider's own Retry-After is honoured but clamped into the same
      // range: a gateway asking for ten minutes should not stall the turn.
      const backoff = err.retryAfterMs ?? minDelayMs * 2 ** (attempt - 1);
      const delayMs = Math.min(Math.max(backoff, minDelayMs), maxDelayMs);
      handlers.onRetry?.({ attempt, attempts, delayMs, status: err.status, error: err.message });
      await sleep(delayMs, signal);
      startedAt = Date.now();
    }
  }

  const elapsedMs = Date.now() - startedAt;
  // Prefer the server's own timings (llama.cpp reports them); otherwise derive
  // decode speed from the generation window, excluding time spent on prefill.
  const completion = result.usage?.completion_tokens ?? null;
  let tps = result.timings?.predicted_per_second ?? null;
  if (tps == null && completion && firstTokenAt) {
    const decodeMs = Math.max(Date.now() - firstTokenAt, 1);
    tps = (completion / decodeMs) * 1000;
  }

  return {
    ...result,
    elapsedMs,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
    tps,
    promptTps: result.timings?.prompt_per_second ?? null,
  };
}
