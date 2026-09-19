// Minimal GGUF metadata reader, so the harness can predict a profile's VRAM
// footprint *before* launching it -- weights come from the file size, but the KV
// cache is the part that actually decides whether 128K context fits in 16 GB.
import { open, stat } from 'node:fs/promises';

const MAGIC = 0x46554747; // "GGUF" little-endian

const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

// Bytes per element for llama.cpp KV cache types. Quantised types store a block
// of 32 values plus scale bytes, hence the fractional sizes.
const KV_TYPE_BYTES = {
  f32: 4, f16: 2, bf16: 2,
  q8_0: 34 / 32, q8_1: 36 / 32,
  q5_0: 22 / 32, q5_1: 24 / 32,
  q4_0: 18 / 32, q4_1: 20 / 32,
  iq4_nl: 18 / 32,
};

// Types whose on-disk layout this table does not model exactly. Estimates using
// these are flagged so the UI can say "approximate" rather than quietly lie.
const APPROX_KV_TYPES = { kvarn4: 0.5625, kvarn3: 0.4375, kvarn5: 0.6875 };

class Cursor {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.byteLength) throw new RangeError('gguf: header truncated');
  }
  u8() { this.need(1); return this.view.getUint8(this.pos++); }
  i8() { this.need(1); const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  u64() { this.need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return Number(v); }
  i64() { this.need(8); const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return Number(v); }
  str() {
    const len = this.u64();
    this.need(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  /** Advance past `count` elements of `itemType` without decoding them. */
  skipArray(itemType, count) {
    const fixed = { [T.UINT8]: 1, [T.INT8]: 1, [T.BOOL]: 1, [T.UINT16]: 2, [T.INT16]: 2,
      [T.UINT32]: 4, [T.INT32]: 4, [T.FLOAT32]: 4,
      [T.UINT64]: 8, [T.INT64]: 8, [T.FLOAT64]: 8 }[itemType];
    if (fixed !== undefined) {
      const bytes = fixed * count;
      this.need(bytes);
      this.pos += bytes;
      return;
    }
    if (itemType === T.STRING) {
      for (let i = 0; i < count; i++) {
        const len = this.u64();
        this.need(len);
        this.pos += len;
      }
      return;
    }
    throw new Error(`gguf: cannot skip array of type ${itemType}`);
  }

  value(type) {
    switch (type) {
      case T.UINT8: return this.u8();
      case T.INT8: return this.i8();
      case T.UINT16: return this.u16();
      case T.INT16: return this.i16();
      case T.UINT32: return this.u32();
      case T.INT32: return this.i32();
      case T.FLOAT32: return this.f32();
      case T.BOOL: return this.u8() !== 0;
      case T.STRING: return this.str();
      case T.UINT64: return this.u64();
      case T.INT64: return this.i64();
      case T.FLOAT64: return this.f64();
      case T.ARRAY: {
        const itemType = this.u32();
        const count = this.u64();
        // Token vocabularies run to hundreds of thousands of entries and we never
        // need them. Walk past the bytes without materialising a JS array --
        // skipping still has to consume the contents, since element sizes vary.
        if (count > 1024) {
          this.skipArray(itemType, count);
          return { array: itemType, count, skipped: true };
        }
        const out = [];
        for (let i = 0; i < count; i++) out.push(this.value(itemType));
        return out;
      }
      default: throw new Error(`gguf: unknown value type ${type}`);
    }
  }
}

/**
 * Parse the key/value header out of a buffer holding the start of a GGUF file.
 * Throws a RangeError when the buffer ends inside the header, so callers can
 * fetch more bytes and try again -- from disk or over HTTP alike.
 */
export function parseGgufHeader(buf, fileBytes, path = null) {
  const c = new Cursor(buf);
  if (c.u32() !== MAGIC) throw new Error(`${path || 'data'} is not a GGUF file`);
  const version = c.u32();
  const tensorCount = c.u64();
  const kvCount = c.u64();
  const kv = {};
  for (let i = 0; i < kvCount; i++) {
    const key = c.str();
    kv[key] = c.value(c.u32());
  }
  return { path, fileBytes, version, tensorCount, kv };
}

// Header windows tried in turn: a vocabulary alone can run past 4 MB.
export const GGUF_HEADER_WINDOWS = [4 << 20, 32 << 20, 128 << 20];

/**
 * Read the GGUF key/value header. Reads a growing prefix of the file rather than
 * the whole 12 GB, retrying with more bytes if the header spills past the window.
 */
export async function readGgufMetadata(path) {
  const { size } = await stat(path);
  const fh = await open(path, 'r');
  try {
    for (const window of GGUF_HEADER_WINDOWS) {
      const length = Math.min(window, size);
      const buf = Buffer.allocUnsafe(length);
      await fh.read(buf, 0, length, 0);
      try {
        return parseGgufHeader(buf, size, path);
      } catch (err) {
        if (err instanceof RangeError && length < size) continue; // widen and retry
        throw err;
      }
    }
    throw new Error(`${path}: GGUF header larger than 128 MB, giving up`);
  } finally {
    await fh.close();
  }
}

/** Pull the handful of fields that drive the KV-cache arithmetic. */
export function modelShape(meta) {
  const arch = meta.kv['general.architecture'] || 'llama';
  const g = (suffix) => meta.kv[`${arch}.${suffix}`];
  const embedding = g('embedding_length');
  const heads = g('attention.head_count');
  const headsKv = g('attention.head_count_kv') ?? heads;
  const keyLength = g('attention.key_length') ?? (embedding && heads ? embedding / heads : undefined);
  const valueLength = g('attention.value_length') ?? keyLength;
  const blockCount = g('block_count');

  // Hybrid architectures (Qwen3.5's qwen35, Jamba, Granite-hybrid...) interleave
  // full-attention layers with linear/SSM layers. Only the full-attention layers
  // grow a KV cache with context length; the SSM layers hold a fixed-size
  // recurrent state. Ignoring this overstates a 27B model's KV by ~4x, which is
  // the difference between "96K will not fit" and "96K fits with room to spare".
  const fullAttentionInterval = g('full_attention_interval') ?? null;
  const attentionLayers =
    fullAttentionInterval && blockCount
      ? Math.floor(blockCount / fullAttentionInterval)
      : blockCount;

  const ssm = {
    convKernel: g('ssm.conv_kernel') ?? null,
    stateSize: g('ssm.state_size') ?? null,
    innerSize: g('ssm.inner_size') ?? null,
    groupCount: g('ssm.group_count') ?? null,
  };
  const ssmLayers = ssm.stateSize && blockCount ? blockCount - attentionLayers : 0;

  return {
    arch,
    name: meta.kv['general.name'] || null,
    blockCount,
    attentionLayers,
    ssmLayers,
    fullAttentionInterval,
    ssm,
    embedding,
    heads,
    headsKv,
    keyLength,
    valueLength,
    trainCtx: g('context_length'),
    nextnPredictLayers: g('nextn_predict_layers') ?? 0,
    // Mixture-of-Experts: how many experts, and how many run per token. A dense
    // model has none, and the settings that only make sense for experts are
    // hidden for it.
    expertCount: g('expert_count') ?? 0,
    expertUsedCount: g('expert_used_count') ?? 0,
    fileBytes: meta.fileBytes,
    // Some publishers ship the sampling settings they tuned for. Honour them
    // rather than imposing generic defaults on a model we know nothing about.
    sampling: {
      temp: meta.kv['general.sampling.temp'],
      topK: meta.kv['general.sampling.top_k'],
      topP: meta.kv['general.sampling.top_p'],
      minP: meta.kv['general.sampling.min_p'],
    },
  };
}

const round = (value, fallback) =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : fallback);

// Context sizes worth offering. Anything between these is a false precision.
const CTX_LADDER = [4096, 8192, 16384, 32768, 49152, 65536, 98304, 131072, 163840, 196608, 262144];

/**
 * Build a launch profile for an arbitrary .gguf from its own metadata plus the
 * VRAM actually available, choosing the largest sensible context that fits.
 */
/**
 * What to call a model. The name inside the file is preferred, but converters
 * leave junk there ("Hf") often enough that a name too short to mean anything
 * loses to the file's own.
 */
function displayName(shape, fileName, alias) {
  const inside = String(shape.name || '').trim();
  if (inside.length >= 4 && !/^(hf|model|unknown|llama)$/i.test(inside)) return inside;
  return String(fileName || '').replace(/\.gguf$/i, '') || alias;
}

export function suggestProfile(shape, budgetBytes, { name, modelPath: file, threads = 8 } = {}) {
  const alias = String(name || shape.name || 'model')
    .toLowerCase()
    .replace(/\.gguf$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  const base = {
    cacheK: 'q8_0',
    cacheV: 'q8_0',
    ngl: 99,
    threads,
    threadsBatch: threads * 2,
    flashAttn: 'on',
    kvUnified: true,
    fit: 'on',
    parallel: 1,
    jinja: true,
  };

  const ceiling = maxContextFor(shape, base, budgetBytes);
  const trainCtx = shape.trainCtx || 32768;
  // Largest rung that both fits in VRAM and the model was trained for.
  let ctx = CTX_LADDER[0];
  for (const rung of CTX_LADDER) {
    if (rung <= trainCtx && (ceiling === null || rung <= ceiling)) ctx = rung;
  }

  return {
    ...base,
    label: `${displayName(shape, name, alias)} — ${(ctx / 1024).toFixed(0)}K`,
    modelPath: file,
    model: file ? file.split(/[\\/]/).pop() : undefined,
    alias,
    ctx,
    // GGUF stores these as float32, so 0.95 reads back as 0.949999988079071.
    temp: round(shape.sampling?.temp, 0.7),
    topK: shape.sampling?.topK ?? 40,
    topP: round(shape.sampling?.topP, 0.95),
    minP: round(shape.sampling?.minP, 0.05),
    extraArgs: [],
    // Recorded so the UI can say why it picked this context.
    _fitCeiling: ceiling,
    _trainCtx: trainCtx,
  };
}


function bytesPerElement(type) {
  const key = String(type || 'f16').toLowerCase();
  if (key in KV_TYPE_BYTES) return { bytes: KV_TYPE_BYTES[key], approx: false };
  if (key in APPROX_KV_TYPES) return { bytes: APPROX_KV_TYPES[key], approx: true };
  return { bytes: KV_TYPE_BYTES.f16, approx: true };
}

/** KV bytes consumed per token of context, or null if metadata is too thin. */
function kvBytesPerToken(shape, kBytes, vBytes) {
  const layers = shape.attentionLayers ?? shape.blockCount;
  if (!layers || !shape.headsKv || !shape.keyLength) return null;
  return layers * shape.headsKv * (shape.keyLength * kBytes + shape.valueLength * vBytes);
}

/**
 * Recurrent state held by SSM layers. Constant in context length -- it depends on
 * the sequence count, not the sequence length -- and small next to the KV cache,
 * but worth counting so the total is not quietly short by a couple of hundred MB.
 * llama.cpp keeps these states in f32.
 */
function ssmStateBytes(shape, sequences = 1) {
  const { convKernel, stateSize, innerSize } = shape.ssm || {};
  if (!shape.ssmLayers || !stateSize || !innerSize) return 0;
  const conv = innerSize * Math.max((convKernel || 1) - 1, 0);
  const recurrent = innerSize * stateSize;
  return shape.ssmLayers * (conv + recurrent) * 4 * sequences;
}

const gb = (bytes) => `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;

const BASE_OVERHEAD_BYTES = 900 * 1024 * 1024;

/**
 * Fixed costs that sit beside the weights and the KV cache:
 *
 *   * compute buffers, the Vulkan context and allocator fragmentation -- a flat
 *     allowance, deliberately conservative;
 *   * the vision tower, when a profile carries an --mmproj. It is a second file
 *     loaded onto the same card and at f16 it is most of a gigabyte, which is
 *     the difference between "fits" and "spills" on a 16 GB card;
 *   * `bias`, the gap between what we predicted last launch and what the card
 *     actually reported. Quantised KV types like kvarn4 are modelled from a
 *     published bits-per-value figure rather than llama.cpp's real layout, so
 *     the arithmetic below is never going to be exact -- measuring the miss once
 *     and carrying it forward beats pretending otherwise.
 */
function fixedBytes(profile, extras = {}) {
  return (
    BASE_OVERHEAD_BYTES + (Number(extras.mmprojBytes) || 0) + (Number(extras.draftBytes) || 0)
  );
}

/**
 * The correction learned from the last launch, kept as its own term rather than
 * folded into the overhead.
 *
 * It runs both ways. Usually it is positive: we under-predicted and the card
 * said so. It is strongly negative for a profile that deliberately places
 * tensors on the CPU (-ot, -ncmoe), where the file size overstates what lands
 * on the card by however much was offloaded -- 15 GB of 21, for a 35B A3B on a
 * 16 GB card. Nothing here reads the tensor table, so the measurement is the
 * only way to know by how much; clamping it at zero, as an "overhead" term
 * would have to, throws that away and reports a working profile as too big.
 */
function biasOf(extras = {}) {
  return Number(extras.biasBytes) || 0;
}

/**
 * Weight bytes that actually land on the GPU. -ngl at or above block_count (the
 * usual 99) means all of them; below that, llama.cpp offloads the first N layers
 * and the rest run on the CPU, so the GPU footprint shrinks roughly pro rata.
 */
function gpuWeightBytes(shape, profile) {
  const total = shape.fileBytes || 0;
  const layers = shape.blockCount || 0;
  const ngl = Number(profile.ngl);
  if (!total || !layers || !Number.isFinite(ngl) || ngl >= layers) return total;
  if (ngl <= 0) return 0;
  return Math.round(total * (ngl / layers));
}

/**
 * Predicted GPU footprint for a profile.
 *
 * weights  -- the .gguf file size, scaled by -ngl.
 * kv       -- ctx * layers * heads_kv * (key_len + value_len) scaled by the cache quant.
 * overhead -- see fixedBytes above.
 *
 * Speculative decoding (MTP) carries extra draft state that this does not model;
 * the measured bias is what covers it in practice.
 */
export function estimateFootprint(shape, profile, extras = {}) {
  const ctx = Number(profile.ctx) || 0;
  const notes = [];
  let approx = false;

  const k = bytesPerElement(profile.cacheK);
  const v = bytesPerElement(profile.cacheV);
  if (k.approx || v.approx) {
    approx = true;
    notes.push(`KV quant ${profile.cacheK}/${profile.cacheV} is estimated, not exact`);
  }

  let kvBytes = null;
  const perToken = kvBytesPerToken(shape, k.bytes, v.bytes);
  if (perToken !== null) {
    kvBytes = perToken * ctx + ssmStateBytes(shape);
    if (shape.ssmLayers > 0) {
      notes.push(
        `hybrid arch: ${shape.attentionLayers}/${shape.blockCount} layers cache KV, ` +
          `${shape.ssmLayers} hold a fixed SSM state`,
      );
    }
  } else {
    notes.push('model metadata incomplete; KV size unknown');
  }

  if (profile.specType) {
    approx = true;
    notes.push('speculative draft state not included');
  }

  // A type the binary will refuse is not a footprint problem, but it is the
  // reason the launch is about to fail, so it belongs in the same panel.
  if (Array.isArray(extras.cacheTypes)) {
    for (const [key, type] of [['K', profile.cacheK], ['V', profile.cacheV]]) {
      const name = String(type || '').toLowerCase();
      if (name && !extras.cacheTypes.includes(name)) {
        notes.push(`this llama.cpp build will not accept cache-type-${key.toLowerCase()} "${name}"`);
      }
    }
  }

  const weightsBytes = gpuWeightBytes(shape, profile);
  if (weightsBytes < (shape.fileBytes || 0)) {
    notes.push(`-ngl ${profile.ngl}: ${gb(shape.fileBytes - weightsBytes)} of weights stay on the CPU`);
  }

  const mmprojBytes = Number(extras.mmprojBytes) || 0;
  if (mmprojBytes) notes.push(`includes ${gb(mmprojBytes)} vision tower (--mmproj)`);

  // A draft model is a second set of weights on the same card, and its own KV
  // cache on top -- which this does not model, hence the flag below.
  const draftBytes = Number(extras.draftBytes) || 0;
  if (draftBytes) notes.push(`includes ${gb(draftBytes)} draft model (-md)`);

  const biasBytes = biasOf(extras);
  if (biasBytes > 0) notes.push(`+${gb(biasBytes)} correction learned from the last launch`);
  if (biasBytes < 0) notes.push(`${gb(biasBytes)} of weights measured off the card (CPU offload)`);
  if (profile.overrideTensor && !biasBytes) {
    approx = true;
    notes.push('this profile places tensors on the CPU (-ot); launch it once and the measurement will correct this forecast');
  }

  const overheadBytes = fixedBytes(profile, extras);
  const totalBytes =
    kvBytes === null ? null : Math.max(weightsBytes + kvBytes + overheadBytes + biasBytes, 0);

  return {
    weightsBytes,
    kvBytes,
    overheadBytes,
    mmprojBytes,
    draftBytes,
    biasBytes,
    totalBytes,
    approx,
    notes,
  };
}

/** Largest context that fits a VRAM budget, by inverting the KV term. */
export function maxContextFor(shape, profile, budgetBytes, extras = {}) {
  const k = bytesPerElement(profile.cacheK);
  const v = bytesPerElement(profile.cacheV);
  const perToken = kvBytesPerToken(shape, k.bytes, v.bytes);
  if (perToken === null) return null;
  const spare =
    budgetBytes -
    gpuWeightBytes(shape, profile) -
    fixedBytes(profile, extras) -
    biasOf(extras) -
    ssmStateBytes(shape);
  if (spare <= 0) return 0;
  return Math.floor(spare / perToken);
}

// ----------------------------------------------------------------- auto-fit

// KV cache types ordered from most to least accurate. Auto-fit walks down this
// list only in 'full' mode: dropping from q8_0 to q4_0 changes what the model
// remembers, which is not a thing to do behind your back.
const KV_TIGHTEN_LADDER = ['f16', 'q8_0', 'q5_1', 'q5_0', 'kvarn4', 'q4_0', 'kvarn3'];

// Context is chosen in whole blocks of this many tokens. The ladder used for
// *suggesting* a profile is deliberately coarse -- offering 98,304 or 131,072 is
// a clearer choice than a number with five significant figures. Fitting is a
// different job: rounding a 29,000-token ceiling down to the ladder's 16,384
// throws away nearly half the context the card can actually hold.
const CTX_GRAIN = 4096;

/** Largest multiple of CTX_GRAIN at or below `ceiling`, or null if under `floor`. */
function fitCtxWithin(ceiling, floor) {
  const value = Math.floor(ceiling / CTX_GRAIN) * CTX_GRAIN;
  return value >= floor ? value : null;
}

/**
 * Adjust a profile so its predicted footprint fits `budgetBytes`, and say what
 * changed and why.
 *
 * mode:
 *   'off'  -- never touch the profile; only report whether it fits.
 *   'ctx'  -- context length only. Nothing about how the model behaves token to
 *             token changes; you just hold less history.
 *   'full' -- context, KV quantisation and GPU layers, in the order `priority`
 *             asks for.
 *
 * priority (mode 'full' only) -- what the fitter spends first. There are only
 * three things it can give away, and you have to give away one of them:
 *   'speed'   -- move layers to the CPU first, keeping both the full context
 *                and an exact KV cache. The right choice when throughput has
 *                headroom above whatever floor you need and the other two do
 *                not.
 *   'context' -- shorten nothing, coarsen the KV cache. Keeps the window at
 *                the cost of what the model remembers precisely.
 *   'quality' -- shorten the window, keep the cache exact.
 *
 * `allowCpuLayers` gates the CPU-offload lever entirely. With it off, 'speed'
 * has nothing to spend and behaves like 'context'.
 *
 * Returns { fits, patch, steps, estimate }. `patch` is empty when nothing had to
 * change, so callers can skip writing the profile back.
 */
export function fitProfile(shape, profile, budgetBytes, opts = {}) {
  const {
    mode = 'ctx',
    priority = 'context',
    ctxFloor = 16384,
    allowCpuLayers = true,
    extras = {},
    cacheTypes = null,
  } = opts;
  const steps = [];
  const patch = {};
  const candidate = { ...profile };

  const estimate = () => estimateFootprint(shape, candidate, extras);
  const verdict = () => {
    const est = estimate();
    return est.totalBytes === null ? null : est.totalBytes <= budgetBytes;
  };
  const done = (fits) => withCtxStep({ fits, patch, steps, estimate: estimate() });

  if (mode === 'off' || verdict() !== false) {
    return { fits: verdict(), patch, steps, estimate: estimate() };
  }

  const trainCtx = shape.trainCtx || Infinity;
  const wantedCtx = Number(profile.ctx) || 0;

  // Context can be set more than once -- shrunk to make room, then given back
  // once a smaller cache or fewer GPU layers freed some. Only the net move is
  // worth reporting, so it is prepended at the end rather than logged each time.
  const withCtxStep = (result) => {
    if (patch.ctx !== undefined && patch.ctx !== wantedCtx) {
      result.steps = [
        `context ${wantedCtx.toLocaleString()} -> ${patch.ctx.toLocaleString()}`,
        ...result.steps,
      ];
    }
    return result;
  };

  /**
   * Set context to the largest value that fits, never below the floor and never
   * above what was asked for. When even the floor is too big this still drops to
   * the floor: the profile is over budget either way, and reporting the overflow
   * from the smallest context worth having is the honest number.
   */
  const setCtx = () => {
    const ceiling = maxContextFor(shape, candidate, budgetBytes, extras);
    if (ceiling === null) return;
    const target = Math.min(
      Math.max(fitCtxWithin(Math.min(ceiling, trainCtx), ctxFloor) ?? ctxFloor, ctxFloor),
      wantedCtx || Infinity,
    );
    if (target === Number(candidate.ctx)) return;
    candidate.ctx = target;
    patch.ctx = target;
  };

  /**
   * Tighten the KV cache quant one rung at a time, K and V kept in step, and
   * only to types the running binary actually accepts -- picking kvarn4 for a
   * build that has never heard of it just moves the failure from "spills" to
   * "will not load".
   */
  const tightenKv = () => {
    const ladder = cacheTypes
      ? KV_TIGHTEN_LADDER.filter((t) => cacheTypes.includes(t))
      : KV_TIGHTEN_LADDER;
    if (!ladder.length) return false;

    // A profile can name a type this ladder does not list (or that this build
    // dropped), in which case start at the first supported type no larger than
    // what was asked for.
    const current = String(candidate.cacheK || '').toLowerCase();
    let index = ladder.indexOf(current);
    if (index < 0) {
      const currentBytes = bytesPerElement(current).bytes;
      index = ladder.findIndex((t) => bytesPerElement(t).bytes <= currentBytes) - 1;
      if (index < -1) return false;
    }
    for (let i = Math.max(index + 1, 0); i < ladder.length; i++) {
      const next = ladder[i];
      steps.push(`KV cache ${candidate.cacheK}/${candidate.cacheV} -> ${next}`);
      candidate.cacheK = next;
      candidate.cacheV = next;
      patch.cacheK = next;
      patch.cacheV = next;
      if (verdict() !== false) return true;
    }
    return verdict() !== false;
  };

  /**
   * Last resort: leave some layers on the CPU. Honest and measured, unlike the
   * driver quietly paging VRAM to system RAM -- but it is also the one lever
   * that really costs tokens per second, so it runs last and can be switched off.
   */
  const dropLayers = () => {
    const layers = shape.blockCount || 0;
    if (!layers || !allowCpuLayers) return false;
    const est = estimate();
    const nonWeights = (est.kvBytes ?? 0) + est.overheadBytes;
    const perLayer = (shape.fileBytes || 0) / layers;
    const affordable = perLayer > 0 ? Math.floor((budgetBytes - nonWeights) / perLayer) : layers;
    const ngl = Math.max(Math.min(affordable, layers), 0);
    if (ngl >= layers) return verdict() !== false;
    steps.push(`-ngl ${candidate.ngl} -> ${ngl} (${layers - ngl} of ${layers} layers on the CPU, expect fewer tokens/s)`);
    candidate.ngl = ngl;
    patch.ngl = ngl;
    return verdict() !== false;
  };

  // 'ctx' mode is allowed one lever. 'full' gets all three, ordered by what you
  // said you care about: 'context' spends cache precision to keep the window,
  // 'quality' spends the window to keep the cache exact.
  const levers =
    mode !== 'full'
      ? [setCtx]
      : priority === 'speed'
        ? [dropLayers, setCtx, tightenKv]
        : priority === 'context'
          ? [tightenKv, setCtx, dropLayers]
          : [setCtx, tightenKv, dropLayers];

  for (const lever of levers) {
    lever();
    if (verdict() !== false) {
      // Whatever we just freed may buy context back; take it before reporting.
      setCtx();
      return done(true);
    }
  }
  return done(verdict());
}
