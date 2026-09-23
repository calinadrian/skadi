// Sharing a loaded model with the outside world.
//
// Two pieces, both deliberately small:
//   * a key store -- OpenAI-style bearer keys, kept only as SHA-256 hashes, so
//     a leaked file never yields a working key. The full key is shown once.
//   * a public path -- an OpenAI-compatible proxy in front of the loaded
//     llama-server(s). This is the one surface Skadi binds outside loopback;
//     an experienced user opens the port on their router and shares their
//     public IP plus a key. The harness server itself stays bound to loopback,
//     and this proxy exposes nothing but /health and /v1/*.

import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEYS_FILE = join(ROOT, 'config', 'share-keys.json');
const KEY_PREFIX = 'sk-sh-';
const CHAT_BODY_MAX = 2 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(payload);
}

// The window's generic api() client reads `error` as a flat string (every
// other /api/* route shapes it that way); the OpenAI-style /v1/* proxy keeps
// `error.message` since that is the shape OpenAI clients expect.
function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function withStatus(err, status) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.status = status;
  return e;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(withStatus('body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(withStatus('body must be JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes = CHAT_BODY_MAX) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(withStatus('request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- key store

function readKeysFile() {
  try {
    const stored = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(stored?.keys) ? stored.keys : [];
  } catch {
    return [];
  }
}

/**
 * Bearer keys for the shared endpoint. Only the hash of each key is kept on
 * disk, so the store can never be turned into a working credential.
 */
class KeyStore {
  constructor() {
    this.keys = new Map(); // id -> { id, hash, prefix, label, createdAt, lastUsedAt, revoked }
    for (const entry of readKeysFile()) this.keys.set(entry.id, entry);
    this._flushTimer = null;
  }

  /** Live entries as the window sees them: everything except the hash. */
  list() {
    return [...this.keys.values()]
      .filter((e) => !e.revoked)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(({ hash, ...rest }) => rest);
  }

  create(label) {
    const raw = KEY_PREFIX + randomBytes(24).toString('base64url');
    const entry = {
      id: randomUUID(),
      hash: sha256(raw),
      prefix: raw.slice(0, KEY_PREFIX.length + 4) + '…',
      label: String(label || '').trim() || 'shared key',
      createdAt: Date.now(),
      lastUsedAt: null,
      revoked: false,
    };
    this.keys.set(entry.id, entry);
    this.flush();
    const { hash, ...view } = entry;
    return { key: raw, entry: view };
  }

  revoke(id) {
    const entry = this.keys.get(id);
    if (!entry) return false;
    entry.revoked = true;
    this.flush();
    return true;
  }

  /** The live entry behind a raw key, or null. */
  verify(raw) {
    if (typeof raw !== 'string' || !raw.startsWith(KEY_PREFIX)) return null;
    const digest = Buffer.from(sha256(raw));
    for (const entry of this.keys.values()) {
      if (entry.revoked) continue;
      const stored = Buffer.from(entry.hash);
      if (stored.length === digest.length && timingSafeEqual(stored, digest)) {
        entry.lastUsedAt = Date.now();
        this.queueFlush();
        return entry;
      }
    }
    return null;
  }

  queueFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, 5000);
    this._flushTimer.unref?.();
  }

  flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    try {
      mkdirSync(dirname(KEYS_FILE), { recursive: true });
      writeFileSync(KEYS_FILE, JSON.stringify({ version: 1, keys: [...this.keys.values()] }, null, 2));
    } catch (err) {
      console.error('[share] could not save keys:', err.message);
    }
  }
}

// ---------------------------------------------------------------- proxy

/**
 * OpenAI-compatible facade in front of the loaded models. The one Skadi
 * surface bound outside loopback: reachability is the user's own port-forward,
 * and this exposes nothing but /health and /v1/*.
 */
export class ShareProxy extends EventEmitter {
  constructor(skadi, port, store) {
    super();
    this.skadi = skadi;
    this.port = port;
    this.store = store;
    this.server = null;
  }

  listen() {
    this.server = createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        this.handle(req, res, url).catch((err) => {
          sendJson(res, err.status || 500, { error: { message: err.message } });
        });
      } catch (err) {
        sendJson(res, 500, { error: { message: err.message } });
      }
    });
    this.server.on('error', (err) => this.emit('error', err));
    // Deliberately not loopback-only: an experienced user opens this port on
    // their router and shares public-ip:port with a friend. The bearer key is
    // what keeps strangers out; the surface itself is model-only.
    this.server.listen(this.port);
    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /** Ready instances, shaped the way the window sees them. */
  ready() {
    return this.skadi.readyInstances().map((i) => this.skadi.instanceView(i));
  }

  auth(req) {
    const header = String(req.headers.authorization || '');
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const entry = key ? this.store.verify(key) : null;
    if (!entry) throw withStatus('invalid or missing API key (Authorization: Bearer sk-sh-…)', 401);
    return entry;
  }

  /** Match the request's `model` against the loaded instances. */
  resolveInstance(model) {
    const ready = this.ready();
    if (!ready.length) throw withStatus('no model is loaded on this machine', 503);
    if (!model) {
      if (ready.length === 1) return ready[0];
      throw withStatus(`pick a model: ${ready.map((i) => i.id).join(', ')}`, 400);
    }
    const needle = String(model).toLowerCase();
    const hit = ready.find((i) =>
      [i.id, i.alias, i.model].some((v) => v && String(v).toLowerCase() === needle));
    if (hit) return hit;
    const loose = ready.find((i) => i.model && String(i.model).toLowerCase().endsWith(needle));
    if (loose) return loose;
    throw withStatus(`unknown model "${model}" (loaded: ${ready.map((i) => i.id).join(', ')})`, 404);
  }

  async handle(req, res, url) {
    const path = (url.pathname || '/').replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
      });
      return res.end();
    }
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true, models: this.ready().length });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      this.auth(req);
      const ready = this.ready();
      return sendJson(res, 200, {
        object: 'list',
        data: ready.map((i) => {
          const entry = {
            id: i.id,
            object: 'model',
            created: Math.floor((i.startedAt || 0) / 1000),
            owned_by: 'skadi',
            meta: { label: i.label || i.id, alias: i.alias || null, model: i.model || null },
          };
          // The window this model was loaded with. A client that does not
          // know it guesses -- usually high -- and a conversation that fits
          // the guess overflows the model, so the request dies mid-turn.
          if (Number.isFinite(i.ctx) && i.ctx > 0) entry.context_length = i.ctx;
          return entry;
        }),
      });
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      return this.handleChat(req, res);
    }
    throw withStatus(`unknown route: ${req.method} ${path}`, 404);
  }

  async handleChat(req, res) {
    this.auth(req);
    const raw = await readRawBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      throw withStatus('request body must be JSON', 400);
    }
    const inst = this.resolveInstance(body.model);
    const ctx = Number.isFinite(inst.ctx) && inst.ctx > 0 ? inst.ctx : null;
    const host = this.skadi.config?.host || '127.0.0.1';
    const target = `http://${host}:${inst.port}/v1/chat/completions`;
    let upstreamBody = { ...body, model: inst.model || inst.id, stream: Boolean(body.stream) };
    // A max_tokens at or above the whole window can never fit, whatever the
    // prompt is; trim it so the request stands a chance instead of being
    // refused before a single token is generated.
    if (ctx && Number.isFinite(Number(upstreamBody.max_tokens)) && Number(upstreamBody.max_tokens) >= ctx) {
      upstreamBody.max_tokens = Math.max(1, ctx - 2048);
    }
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    let upstream;
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } catch (err) {
      throw withStatus(`model server unreachable: ${err.message}`, 502);
    }

    if (!upstream.ok || !body.stream) {
      const text = await upstream.text();
      let payload = text;
      try {
        payload = JSON.parse(text);
      } catch {
        /* forward it raw */
      }
      // A context rejection forwarded raw is a wall of numbers. Say what the
      // shared model's window actually is, so the client knows where to aim.
      if (upstream.status === 400 && ctx
          && /exceed.*context|context.*(exceed|size|length|window)|too many tokens|prompt is too long|input.*too (long|large)/i.test(text)) {
        const original = (payload?.error?.message || text).toString();
        payload = {
          error: {
            message: `${original} The shared model's context is ${ctx} tokens: point your client's context limit at that number and keep the conversation below it.`,
          },
        };
      }
      sendJson(res, upstream.status, payload);
      return;
    }

    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'text/event-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  }
}

// ---------------------------------------------------------------- facade

/**
 * The one stop for the sharing feature: key store, proxy lifecycle, and the
 * /api/share/* routes the window talks to.
 */
export class Sharing extends EventEmitter {
  constructor(skadi) {
    super();
    this.skadi = skadi;
    this.port = Number(skadi.settings.sharePort) || 7799;
    this.store = new KeyStore();
    this.proxy = null;
  }

  start() {
    this.proxy = new ShareProxy(this.skadi, this.port, this.store);
    this.proxy.on('error', (err) => {
      console.error(`[share] proxy: ${err.message}`);
      this.pushStatus();
    });
    this.proxy.listen();
  }

  status() {
    return {
      port: this.port,
      proxy: this.proxy ? 'up' : 'down',
      models: this.skadi.readyInstances().length,
      keys: this.store.list().length,
    };
  }

  pushStatus() {
    this.emit('status', this.status());
  }

  async stop() {
    if (this.proxy) this.proxy.stop();
    this.proxy = null;
  }

  /** /api/share/* -- the window's side of the feature. */
  async handle(req, res, url) {
    const path = (url.pathname || '/').replace(/\/+$/, '');
    const method = req.method;
    try {
      if (method === 'GET' && path === '/api/share/status') {
        return sendJson(res, 200, this.status());
      }
      if (method === 'GET' && path === '/api/share/keys') {
        return sendJson(res, 200, { keys: this.store.list() });
      }
      if (method === 'POST' && path === '/api/share/keys') {
        const body = await readJsonBody(req);
        const { key, entry } = this.store.create(body?.label);
        this.pushStatus();
        return sendJson(res, 201, { key, entry });
      }
      const revoke = /^\/api\/share\/keys\/([^/]+)\/revoke$/.exec(path);
      if (method === 'POST' && revoke) {
        const ok = this.store.revoke(revoke[1]);
        this.pushStatus();
        return ok
          ? sendJson(res, 200, { ok: true })
          : sendError(res, 404, 'unknown key');
      }
      throw withStatus(`unknown route: ${method} ${path}`, 404);
    } catch (err) {
      sendError(res, err.status || 500, err.message);
    }
  }
}
