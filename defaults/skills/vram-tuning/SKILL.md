---
name: vram-tuning
description: How to fit a GGUF model into a 16 GB GPU without spilling into system RAM.
triggers: vram|out of (video )?memory|won'?t fit|doesn'?t fit|spill(ing|s)? (into|to) (system )?ram|kv cache|context (size|length) .{0,20}(gpu|memory)|gpu memory
---

# Fitting a model in 16 GB

## Quick start

1. Read the measured numbers first (the Local AI tab, or the forecast panel
   before launch). Shared memory used by llama-server above a few tens of MB
   means it has spilled into system RAM, which is why it is slow.
2. Fix it in this order, one change at a time, relaunching after each:
   lower the context (`ctx`) -> set the KV cache to `q8_0` -> close the
   browser and other GPU apps -> a smaller quant -> turn off speculative
   decoding.
3. Only lower `-ngl` (layers on the GPU) as a last resort: it prevents a
   crash but is usually slower than a smaller context.
4. Report the before and after numbers you measured, not estimates.

A 16 GB card reports about 15.9 GiB usable. The desktop compositor, a browser and
any Electron apps hold roughly 1.5–2.5 GiB of that before a model loads, so the
realistic budget for llama-server is **13.5–14.5 GiB**.

## What actually consumes VRAM

1. **Weights** — the .gguf file size, essentially all of it at `-ngl 99`.
2. **KV cache** — grows linearly with context length.
3. **Compute buffers and the Vulkan context** — roughly 0.6–1.0 GiB.

## KV cache on hybrid models

Qwen3.5 (`general.architecture = qwen35`) is a hybrid: `full_attention_interval`
is 4, so only every fourth layer keeps a KV cache. The rest are SSM layers whose
recurrent state is a fixed size regardless of context length.

For a 64-layer model that means 16 attention layers, not 64. Per token:

    attention_layers * head_count_kv * (key_length + value_length) * bytes_per_element

With 16 layers, 4 KV heads, 256-wide keys and values and a `q8_0` cache
(1.0625 bytes per element) that is about **34 KB per token** — so 96K context
costs ~3.2 GiB, not the ~13 GiB a naive all-layers calculation predicts.

## Reading the result

Skadi's forecast panel predicts this before launch. After launch, trust the
measured number instead. The signal that matters is **shared memory attributed
to llama-server**: anything above a few tens of MB means the driver has spilled
VRAM into system RAM, and decode throughput falls sharply.

## Levers, roughly in the order worth trying

| Lever | Effect |
| --- | --- |
| Lower `ctx` | Linear reduction in KV cache. The cheapest, most predictable win. |
| `cacheK`/`cacheV` to `q8_0` | Halves KV against `f16` at negligible quality cost. |
| `cacheK`/`cacheV` to `q4_0`/`kvarn4` | Halves it again; measurable quality loss on long contexts. |
| Smaller quant | IQ3_XXS saves ~2 GiB over Q3_K_XL, at some quality cost. |
| Turn off speculative decoding | Draft state costs VRAM; only worth it when there is headroom. |
| Close Chrome | Frequently worth 0.5–1.0 GiB. |

Lowering `-ngl` moves layers to the CPU. It avoids a hard out-of-memory failure
but is usually slower than simply reducing context, because every offloaded
layer is traversed on each token.
