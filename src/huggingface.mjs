// Hugging Face access for the model manager: search GGUF repos, list a repo's
// files, read a model's shape straight from the remote header (a Range request,
// not a download), and fetch files into modelsDir with resume and cancel.
//
// Only huggingface.co is ever contacted, and only for the repo the user is
// looking at. Set HF_TOKEN in the environment for gated repos and higher rate
// limits; without it everything public still works.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { GGUF_HEADER_WINDOWS, parseGgufHeader, modelShape, estimateFootprint, maxContextFor } from './gguf.mjs';

const HF = 'https://huggingface.co';
const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const GGUF_NAME = /^[\w.\-+()[\] ]+\.gguf$/i;

const headers = (extra = {}) => ({
  'User-Agent': 'Skadi',
  ...(process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {}),
  ...extra,
});

async function hfJson(path, { signal } = {}) {
  const res = await fetch(`${HF}${path}`, { headers: headers(), signal });
  if (res.status === 401 || res.status === 403) {
    throw new Error('This repository is gated or private. Accept its terms on huggingface.co and set the HF_TOKEN environment variable, then restart Skadi.');
  }
  if (res.status === 404) throw new Error('Repository not found on Hugging Face.');
  if (res.status === 429) throw new Error('Hugging Face is rate limiting requests. Wait a minute, or set HF_TOKEN.');
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}.`);
  return res.json();
}

export function assertRepo(id) {
  if (!REPO_ID.test(String(id || ''))) throw new Error(`"${id}" is not a Hugging Face repository id (owner/name).`);
  return id;
}

// ------------------------------------------------------------------ search

export async function searchModels(query, { sort = 'downloads', limit = 24 } = {}) {
  const q = String(query || '').trim();
  const params = new URLSearchParams({ filter: 'gguf', limit: String(limit), direction: '-1' });
  params.set('sort', ['downloads', 'likes', 'lastModified', 'trendingScore'].includes(sort) ? sort : 'downloads');
  if (q) params.set('search', q);
  for (const field of ['downloads', 'likes', 'lastModified', 'pipeline_tag', 'tags', 'gguf', 'gated']) {
    params.append('expand[]', field);
  }
  const list = await hfJson(`/api/models?${params}`);
  return list.map((m) => ({
    id: m.id,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    updated: m.lastModified || null,
    gated: Boolean(m.gated),
    arch: m.gguf?.architecture || null,
    params: m.gguf?.total || null,
    context: m.gguf?.context_length || null,
    vision: (m.tags || []).some((t) => /image-text|vision|multimodal/i.test(t)),
  }));
}

/** Everything the detail pane needs about one repo, minus the fit verdicts. */
export async function repoDetail(id) {
  assertRepo(id);
  const [info, tree] = await Promise.all([
    hfJson(`/api/models/${id}`),
    hfJson(`/api/models/${id}/tree/main?recursive=true`),
  ]);
  return {
    id,
    downloads: info.downloads ?? 0,
    likes: info.likes ?? 0,
    updated: info.lastModified || null,
    gated: Boolean(info.gated),
    arch: info.gguf?.architecture || null,
    params: info.gguf?.total || null,
    context: info.gguf?.context_length || null,
    tags: (info.tags || []).filter((t) => !/^(gguf|endpoints_compatible|region:|arxiv:|base_model:|license:)/.test(t)).slice(0, 12),
    license: (info.tags || []).find((t) => t.startsWith('license:'))?.slice(8) || null,
    ...classifyFiles(tree),
  };
}

// -------------------------------------------------------------- repo files

// Quant name out of a file name: UD-IQ3_XXS, Q4_K_M, BF16, MXFP4 ...
const QUANT = /((?:UD-)?(?:IQ\d(?:_[A-Z]+)?|Q\d(?:_K)?(?:_[A-Z0-9]+)?|BF16|F16|F32|MXFP\d|TQ\d(?:_\d)?))(?=[-_.]|$)/i;
const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

export const quantOf = (name) => (QUANT.exec(name.replace(/\.gguf$/i, ''))?.[1] || '').toUpperCase() || null;

/** Split a repo's file list into models, vision towers and everything else. */
export function classifyFiles(tree) {
  const files = tree
    .filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path))
    .map((f) => ({ path: f.path, name: basename(f.path), bytes: f.lfs?.size ?? f.size ?? 0 }));

  const mmproj = [];
  const drafts = [];
  const groups = new Map();
  for (const f of files) {
    if (/imatrix/i.test(f.name)) continue;
    if (/mmproj/i.test(f.name)) { mmproj.push(f); continue; }
    if (/^mtp[-_]/i.test(f.name) || /(^|\/)mtp\//i.test(f.path)) { drafts.push(f); continue; }
    const shard = SHARD.exec(f.name);
    const key = shard ? shard[1] : f.name.replace(/\.gguf$/i, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...f, shard: shard ? Number(shard[2]) : 1 });
  }

  const models = [...groups.entries()].map(([key, parts]) => {
    parts.sort((a, b) => a.shard - b.shard);
    return {
      id: key,
      quant: quantOf(key),
      // The first shard is what llama.cpp is pointed at; the rest sit beside it.
      file: parts[0].name,
      files: parts.map((p) => ({ path: p.path, name: p.name, bytes: p.bytes })),
      bytes: parts.reduce((sum, p) => sum + p.bytes, 0),
      shards: parts.length,
    };
  }).sort((a, b) => a.bytes - b.bytes);

  // f16 is the reference; bf16 is the same size and less widely accelerated.
  mmproj.sort((a, b) => Number(/[-_.]f16/i.test(b.name)) - Number(/[-_.]f16/i.test(a.name)));
  return { models, mmproj, drafts };
}

// ------------------------------------------------------------ remote shape

const shapeCache = new Map(); // repo -> shape

async function fetchRange(url, length, signal) {
  const res = await fetch(url, { headers: headers({ Range: `bytes=0-${length - 1}` }), signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not read the model header (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The model's shape (layers, KV heads, context) read from its own GGUF header,
 * fetched with a Range request. Every quant of a repo shares one, so it is read
 * once per repo from the smallest file.
 */
export async function remoteShape(repo, model, { signal } = {}) {
  if (shapeCache.has(repo)) return shapeCache.get(repo);
  const file = model.files?.[0] ?? model; // a classified model, or a bare { path, bytes }
  const url = `${HF}/${repo}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`;
  let meta = null;
  for (const window of GGUF_HEADER_WINDOWS) {
    const length = Math.min(window, file.bytes || window);
    const buf = await fetchRange(url, length, signal);
    try {
      meta = parseGgufHeader(buf, file.bytes, url);
      break;
    } catch (err) {
      if (!(err instanceof RangeError) || length >= file.bytes) throw err;
    }
  }
  if (!meta) throw new Error('GGUF header too large to read remotely.');
  const shape = modelShape(meta);
  shapeCache.set(repo, shape);
  return shape;
}

// --------------------------------------------------------------- fit check

const GIB = 1024 ** 3;
const CTX_GRAIN = 4096;
const COMFORTABLE_CTX = 32768;

/**
 * Whether a model file suits this card, in the terms LM Studio uses:
 *   fits    -- all weights on the GPU with a comfortable context
 *   tight   -- fits, but only with a short context
 *   offload -- too big for the card; runs with layers on the CPU, slower
 *   toobig  -- too big even for that
 *   unknown -- the card's size is not known yet
 */
export function assessFit(shape, fileBytes, budgetBytes, { mmprojBytes = 0, cacheType = 'q8_0' } = {}) {
  if (!budgetBytes) return { verdict: 'unknown', maxContext: null, needBytes: null };
  const sized = { ...(shape || {}), fileBytes };
  const profile = { ngl: 99, cacheK: cacheType, cacheV: cacheType };
  const extras = { mmprojBytes };
  const raw = shape ? maxContextFor(sized, profile, budgetBytes, extras) : null;
  const trainCtx = shape?.trainCtx || Infinity;
  const spillable = fileBytes <= budgetBytes + totalmem() * 0.6;

  // No KV arithmetic (thin metadata): judge on weights alone.
  if (raw === null) {
    const need = fileBytes + mmprojBytes + 0.9 * GIB;
    return { verdict: need <= budgetBytes ? 'fits' : spillable ? 'offload' : 'toobig', maxContext: null, needBytes: need };
  }

  const usable = Math.min(raw, trainCtx);
  const maxContext = Math.floor(usable / CTX_GRAIN) * CTX_GRAIN;
  const needAt = (ctx) => estimateFootprint(sized, { ...profile, ctx }, extras).totalBytes;
  if (maxContext >= Math.min(COMFORTABLE_CTX, trainCtx)) {
    return { verdict: 'fits', maxContext, needBytes: needAt(Math.min(maxContext, COMFORTABLE_CTX)) };
  }
  if (maxContext >= CTX_GRAIN) return { verdict: 'tight', maxContext, needBytes: needAt(maxContext) };
  return { verdict: spillable ? 'offload' : 'toobig', maxContext: 0, needBytes: needAt(CTX_GRAIN) };
}

// --------------------------------------------------------------- downloads

/**
 * Resumable downloads into one directory. Data lands in `<name>.part` and is
 * renamed only when complete, so a model file that exists is a whole one.
 * Emits 'update' with the public view of a job as it progresses.
 */
export class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.seq = 0;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  view(job) {
    const { controller, ...rest } = job;
    return rest;
  }

  #push(job) {
    this.emit('update', this.view(job));
  }

  /** Start downloading `files` ([{ path, name, bytes }]) from `repo` into `dir`. */
  start(repo, files, dir, meta = {}) {
    assertRepo(repo);
    if (!dir) throw new Error('No models folder is configured.');
    if (!files.length) throw new Error('Nothing to download.');
    for (const f of files) {
      if (!GGUF_NAME.test(f.name) || f.name.includes('..')) throw new Error(`Refusing unsafe file name "${f.name}".`);
    }
    const running = [...this.jobs.values()].filter((j) => j.state === 'running');
    if (running.some((j) => j.files.some((x) => files.some((y) => y.name === x.name)))) {
      throw new Error('That file is already downloading.');
    }

    const job = {
      id: `dl-${Date.now().toString(36)}-${++this.seq}`,
      repo,
      meta,
      files: files.map((f) => ({ name: f.name, bytes: f.bytes, done: 0 })),
      totalBytes: files.reduce((s, f) => s + (f.bytes || 0), 0),
      doneBytes: 0,
      speed: 0,
      state: 'running',
      error: null,
      current: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.#run(job, files, dir).catch((err) => {
      job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.state === 'failed' ? err.message : null;
      job.speed = 0;
      this.#push(job);
    });
    return this.view(job);
  }

  /** Stop a running job (its partial files are kept, so it can resume) or dismiss a finished one. */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'running') job.controller.abort();
    else this.jobs.delete(id);
    return true;
  }

  async #run(job, files, dir) {
    mkdirSync(dir, { recursive: true });
    const remaining = files.reduce((sum, f) => {
      const whole = join(dir, f.name);
      const part = `${whole}.part`;
      const have = existsSync(whole) ? f.bytes : existsSync(part) ? statSync(part).size : 0;
      return sum + Math.max((f.bytes || 0) - have, 0);
    }, 0);
    let free = Infinity;
    try {
      const fs = await statfs(dir);
      free = Number(fs.bavail) * Number(fs.bsize);
    } catch { /* an unreadable disk is not a reason to refuse */ }
    if (remaining > free) {
      throw new Error(`Not enough disk space in ${dir}: needs ${(remaining / GIB).toFixed(1)} GB, ${(free / GIB).toFixed(1)} GB free.`);
    }

    let lastTick = Date.now();
    let lastBytes = 0;
    const tally = () => { job.doneBytes = job.files.reduce((s, f) => s + f.done, 0); };

    for (const [i, file] of files.entries()) {
      const target = join(dir, file.name);
      const entry = job.files[i];
      job.current = file.name;
      if (existsSync(target) && (!file.bytes || statSync(target).size === file.bytes)) {
        entry.done = file.bytes;
        tally();
        this.#push(job);
        continue;
      }

      const part = `${target}.part`;
      const offset = existsSync(part) ? statSync(part).size : 0;
      const url = `${HF}/${job.repo}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url, {
        headers: headers(offset ? { Range: `bytes=${offset}-` } : {}),
        signal: job.controller.signal,
        redirect: 'follow',
      });
      if (res.status === 401 || res.status === 403) throw new Error('Gated repository: accept its terms on huggingface.co and set HF_TOKEN.');
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${file.name}.`);
      // A 200 means the server ignored the range: start the file over.
      const resumed = res.status === 206 && offset > 0;
      let received = resumed ? offset : 0;
      entry.done = received;

      const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!out.write(value)) await once(out, 'drain');
          received += value.byteLength;
          entry.done = received;
          tally();
          const now = Date.now();
          if (now - lastTick >= 500) {
            job.speed = Math.round(((job.doneBytes - lastBytes) * 1000) / (now - lastTick));
            lastTick = now;
            lastBytes = job.doneBytes;
            this.#push(job);
          }
        }
        out.end();
        await once(out, 'finish');
      } catch (err) {
        out.destroy();
        throw err;
      }

      if (file.bytes && received !== file.bytes) {
        throw new Error(`${file.name}: received ${received} of ${file.bytes} bytes. Download again to resume.`);
      }
      renameSync(part, target);
    }
    job.state = 'done';
    job.speed = 0;
    job.current = null;
    this.#push(job);
    this.emit('done', this.view(job));
  }
}
