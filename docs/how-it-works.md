# How Skadi works

The details behind the [README](../README.md): how models are launched and fitted, how the
agent and its tools behave, and where everything lives.

## Contents

- [Projects](#projects)
- [Providers](#providers)
- [Sharing](#sharing)
- [Loading several models](#loading-several-models)
- [The VRAM forecast](#the-vram-forecast)
- [Fitting](#fitting)
- [The embedded browser](#the-embedded-browser)
- [Attachments](#attachments)
- [Speed](#speed)
- [Skills](#skills)
- [Pixel art](#pixel-art)
- [Memory](#memory)
- [Context compaction](#context-compaction)
- [Settings](#settings)
- [Undoing what a chat wrote](#undoing-what-a-chat-wrote)
- [Tools](#tools)

## Projects

A project is a name and a folder. Selecting one re-roots every file tool, so the
agent works inside that folder and nowhere else, and the session list is scoped
to it. **+** in the header opens the real Windows folder picker.

The system prompt gets a short orientation block for the active project — what
kind of project it is and what sits at its root — so the agent does not burn a
tool round on `list_dir` to find its bearings.

## Providers

Skadi speaks two wire formats:

- **openai** — the local `llama-server`, plus OpenAI, OpenRouter, Groq, DeepSeek
  and anything else OpenAI-compatible.
- **anthropic** — its own adapter, including tool use and thinking blocks.

Pick one in the header. API keys are entered in the Provider panel and written
to `config/secrets.json`, which is gitignored; they go nowhere except to that
provider. Where the endpoint can list its models, the model box autocompletes.

The local provider is *managed*: Skadi starts and stops `llama-server` itself.
The others are just endpoints.

### When a provider fails

Rate limits, gateway hiccups and saturated pools are retried with backoff. A
gateway that answers 400 because *its* upstream errored is retried too — that
is a moment, not a mistake — while a request the gateway itself rejected fails
on the first attempt, and an auth or credit failure is never replayed. The
error says which one it was (`OpenRouter returned 400: ERROR (upstream Stealth
failed; the request itself was accepted)`), and the provider's raw response is
written to the log, so a bare "ERROR" is still diagnosable afterwards.

Tool calls are repaired before they are stored. A model that stops mid-
arguments leaves a `tool_calls` entry whose `arguments` is not JSON; kept
verbatim, it makes *every* later request in that chat invalid, and strict
endpoints reject the whole conversation from then on. Skadi rewrites the text
into legal JSON, hands the model the same "arguments were not valid JSON"
result to correct itself, and repairs transcripts saved before this existed on
their way into a turn.

### Chat templates: heavy vs medium thinking

The froggeric fixed templates (`config/profiles.json` → `chatTemplateFile`,
fetched by the installer into your models folder) come in two flavours,
and the Profile panel switches between them per profile:

- **Heavy (full power)** — the model's own built-in template: *Custom chat
  template* OFF, *Thinking format* = server default, *Thinking* on, *Preserve
  thinking* on, *Jinja* on.
- **Medium (token efficient)** — the froggeric file: *Custom chat template* ON,
  *Thinking format* = deepseek, rest as above.

*Server default* options omit the flag outright, which is how the reference
command lines run them. Like everything else in the panel, changes apply on
**Apply & restart**.

## Sharing

The Local AI tab has a **Share** panel that exposes the models you have loaded
to other machines on your network, each behind its own API key. The panel shows
the proxy's status — port, whether the proxy is up, how many models and keys
exist — plus one row per key: the models that key may use, a **Copy** button for
the address-and-key pair, and **Revoke**. The address and key are what you send
to the person you are sharing with.

The shared endpoint is OpenAI-compatible (`/v1/models`,
`/v1/chat/completions`), so any OpenAI client can use it — and so can another
Skadi. On that Skadi, pick **Skadi Share** in the model menu, paste the shared
address and the key, and the shared model appears in its model list. The proxy
publishes each model's actually loaded context window in `/v1/models`, so the
other Skadi's context meter, `max_tokens` clamping and compaction all use the
real window instead of a default: an over-long request is answered with a 400
that names the window, not a raw error from the model server.

## Loading several models

The Local AI tab works like LM Studio's developer page. **Loaded models** lists
everything running, each with its own port, VRAM, window and speed, and its own
**Eject**. **Load a model** is the only way to start one: pick a file, then pick the
settings to load it with — a profile you made for it, an imported catalog profile, or
*Default settings* (sized to the free memory and saved as a profile you can edit).
Loading never replaces what is already loaded; each model is fitted into the VRAM
the others leave free. Every model gets its own llama-server on the next free port
from the configured `port` up, and each chat picks which loaded model answers it from the model chip
in the composer.

## The VRAM forecast

This is the part worth explaining, because the naive version of it is wrong.

Total VRAM comes from the registry (`HardwareInformation.qwMemorySize`), not
from WMI — `Win32_VideoController.AdapterRAM` is a 32-bit field and reports
4 GB for a 16 GB card. Live usage comes from the `\GPU Adapter Memory` and
`\GPU Process Memory` performance counters, which work on any vendor without an
SDK. **Shared Usage** attributed to `llama-server` is the spill signal: once the
driver starts pushing VRAM into system RAM, decode throughput collapses.

The prediction reads the model's GGUF header directly:

```
KV bytes = attention_layers x kv_heads x (key_len + value_len) x bytes_per_element x context
```

The subtlety is `attention_layers`. Qwen3.5 (`qwen35`) is a hybrid architecture
with `full_attention_interval = 4`, so only every fourth layer keeps a KV cache;
the rest are SSM layers holding a fixed-size recurrent state. Counting all 64
layers overstates the KV cache roughly fourfold — enough to report "will not
fit" for a configuration that fits comfortably. Skadi reads the interval and
counts only the layers that actually cache.

Predictions are still predictions. After each launch Skadi records what the
model actually consumed and shows it in the forecast panel; trust that number
over the estimate.

## Fitting

The forecast tells you a profile will spill. Fitting is what stops it.

**`-fit on` alone does nothing.** llama.cpp's own fitter adjusts arguments you
did *not* set, and every profile here sets `-c` and `-ngl` explicitly — so a
profile marked `fit: on` will still cheerfully allocate 16.5 GB on a 16 GB card
and let the driver push the difference into system RAM. That is the bug this
section exists to close.

### Free VRAM is two different numbers

`\GPU Adapter Memory\Dedicated Usage` reports what is **committed** right now.
Vulkan's per-process budget reports what this process **could** allocate if the
driver evicted everyone else — which it does not reliably do. On this card,
measured seconds apart with nothing loaded: Vulkan said 15.0 GB free, the
counters said 2.8 GB committed.

Neither is wrong, and llama.cpp believes Vulkan. Given a 1 GB margin it fitted a
12.24 GB model plus KV cache into "14.2 GB", declared a fit, and 3.9 GB of it
ended up in system RAM. So the margin Skadi passes as `-fitt` is not simply the
reserve: it is whatever it takes to bring llama.cpp's optimistic view down to
the budget the committed-memory counters support, floored at `vramReserveMb`.

The practical consequence is that a 16 GB card with a browser and a desktop on
it has about **11 GB for weights**, not 15.

Skadi fits in two layers:

* **`llama-fit-params`**, which ships with the same llama.cpp build, decides the
  placement. It reads the real tensor table and prints the arguments that fit —
  in about two seconds, without loading the weights — and for a MoE model it
  returns a per-tensor `-ot` map that nothing here could work out for itself.
  Skadi runs it before every launch and writes the answer into the profile. It
  is the authority on *where the tensors go*, but not on how much room there
  is: see the section above, and note that it can see neither `--mmproj` nor
  `-md`, so those weights are added to the margin it is given.
* **Skadi's own arithmetic** (`src/gguf.mjs`) is the instant fallback that keeps
  the sliders live, and covers the case where the binary is missing or refuses a
  profile.

What the fitter is allowed to change is yours to set, globally or per profile:

| Setting | Meaning |
| --- | --- |
| `vramReserveMb` | VRAM left free for the desktop and the driver. Default 1024, matching llama.cpp's own `--fit-target`. Filling the card to the last byte is how the spill starts. |
| `autoFitOnStart` | Fit before every launch, against the card's free memory *now* — not against how much was free the morning you wrote the profile. |
| `fitMode` | `off` / `ctx` (context only) / `full` (context, KV quant, layers). |
| `fitPriority` | What the fitter spends first. There are only three things it can give away and one of them has to go: `speed` moves layers (or expert tensors) to the CPU and keeps both the full window and an exact cache; `context` keeps the window and coarsens the KV cache; `quality` keeps the cache exact and shortens the window. |
| `ctxFloor` | The fitter stops here and reports failure rather than handing you a 4K assistant. |
| `allowCpuLayers` | Whether `-ngl` may be reduced. It is the one adjustment that really costs tokens per second — which is exactly why it is the right currency when you need a long window and an exact cache and have throughput to spare. |
| `minTokensPerSec` | Measured, not predicted. Skadi reads llama-server's own decode timings and says when they fall short. |

For Mixture-of-Experts models the right lever is not `-ngl` but **`-ncmoe`**,
which keeps expert tensors on the CPU. The experts are most of the weights and
only a fraction of them run per token, so a 22 GB A3B model runs usefully on a
16 GB card while a dense 35B at the same size would not. Skadi always lets the
fitter use `-ncmoe`; it is free on a dense model and decisive on a sparse one.

Two things are measured after each launch and folded back in: the gap between
what was predicted and what the card actually reported (carried into the next
estimate, so a profile that spilled once does not spill the same way twice), and
the decode rate.

The correction runs both ways, and for a MoE profile it runs *hard* negative —
a 22 GB A3B model puts about 15 GB of experts in host memory on purpose, so the
file size overstates its footprint by more than the card holds. Which is also
why **host memory is not automatically a spill**: a profile carrying `-ot` or
`-ncmoe` asked for it. Windows counts a GPU process's host-visible allocations
as Shared Usage either way, so the forecast distinguishes the two and only
raises the alarm for memory the driver took because the card was full.

### Vision is a switch, not a filename

A profile's `mmproj` names its vision tower; `vision: false` turns it off
without forgetting the path, so switching back on does not mean finding the file
again. The **Vision** checkbox in the profile panel appears only for profiles
that have a tower.

It is worth having as a switch because the tower is not free: 0.9 GB of the card
whenever the profile is loaded. Measured on the 35B-A3B at 262K context,
switching it off returned two blocks' worth of expert tensors to the GPU and
took decode from 41.5 to 43.7 tok/s — or, if you were short, that 0.9 GB could
go to context instead.

The switch is read in one place, `visionOn()` in `src/llama.mjs`, because the
launcher and the fitter must agree about it. A tower left out of the launch but
still charged for in the fit would silently cost you exactly the room switching
it off was meant to free.

### There is more than one GPU

`--list-devices` on this box reports two Vulkan devices: the discrete card, and
the CPU's integrated graphics claiming 48 GB — which is system RAM wearing a
GPU's hat. Left to itself llama.cpp splits across both, which looks like a fit
and runs like a swap file.

Every launch therefore passes a device (`-dev`), and the fitter is given the
same one. A profile with no `device` falls back to the discrete card, which is
the one with real, bounded memory; `device: "auto"` is the explicit opt-out for
when you do want everything.

Device ids belong to the backend — `Vulkan0` under the Vulkan build, `CUDA0`
under CUDA — so the bundled profiles name none, and a saved profile that names
one this engine does not have is treated as unset (`resolveDevice` in
`src/llama.mjs`). That is what lets the same profiles run on AMD or NVIDIA,
whichever engine `install.ps1 -Backend` fetched.

### Cache types are per build

`kvarn4` and friends come from the ISTA-DASLab fork, not upstream llama.cpp. A
profile asking for them against an upstream build is refused at load time with
an error that names the value but not where it came from. Skadi reads the
accepted list out of `llama-server --help` and says so in the forecast, and the
fitter only ever picks a type the running binary will take.

## The embedded browser

Chromium runs headless and its frames are streamed into Skadi over the DevTools
screencast API — the same mechanism DevTools uses to mirror a phone screen. The
page renders in the **Browser** tab rather than in a separate window, and both
you and the agent drive the same session. Click and type in the pane and the
input is dispatched into the real page.

**Every chat gets its own browser.** Each one is a separate Chromium with its
own profile directory, so pages, cookies, logins, console output and
screenshots stay in the chat that produced them — switching chats swaps the
pane to that chat's browser rather than showing another conversation's page. A
chat that browses before its first message keeps the browser when it is saved.
They are real processes, so `maxBrowsers` (default 4) closes the least recently
used one nobody is watching; 0 keeps them all.

The viewport is pinned at **1280×800**, which is the point: screenshot pixels
and click coordinates share one space, so a vision model can identify a target
in an image and click it with `browser_click_at`.

Tools: `browser_open`, `browser_read`, `browser_elements`, `browser_click`,
`browser_click_at`, `browser_type`, `browser_fill`, `browser_scroll`,
`browser_screenshot`, `browser_console`, `browser_eval`.

Without vision, `browser_elements` is the substitute — it lists every visible
clickable element with its label and centre point, so the agent can click
accurately from text alone. The `browser-review` skill teaches both paths.

The console panel under the pane shows the same lines the agent reads with
`browser_console` — logs, warnings, uncaught exceptions — live, filterable to
errors only. The volume slider and mute button beside it set the page's audio:
there is no CDP command for tab volume, so Skadi injects a small script that
clamps every `<video>`/`<audio>` element and routes Web Audio through a gain
node, re-applied on every navigation. The screencast carries no sound — it
comes out of the Chromium process itself, so turn off **Headless review
browser** in settings if your machine gives headless Chrome a null audio
device.

The **Desktop** button in the browser bar toggles a mobile viewport (390×844,
phone user agent), DevTools-device-toolbar style: layout, UA sniffing and the
click mapping all follow, and the open page reloads so sites re-evaluate. The
agent's tools report the live viewport, so its coordinates stay valid in both
modes.

## Attachments

The paperclip takes files, photos or a whole folder; you can also drag onto the
composer or paste a screenshot.

Images go to vision-capable providers as image blocks and are described honestly
to the ones that cannot see. Text files are inlined as fenced context. A folder
arrives as a manifest plus the small text files inside it, skipping
`node_modules` and friends and capped so a stray repo cannot blow the context
window.

## Speed

Every assistant message carries its own rate: tokens per second, tokens
generated, and time to first token. While the model is streaming, the composer
shows a running estimate. For local models the figure comes from llama.cpp's own
`timings`; for API providers it is measured over the generation window, so
prefill latency is not counted against decode speed.

## Skills

`skills/<name>/SKILL.md`, with YAML front matter:

```markdown
---
name: vram-tuning
description: How to fit a GGUF model into 16 GB of VRAM without spilling.
triggers: vram|out of memory|won'?t fit
---

## Quick start
...the few steps a small model needs...

...full instructions...
```

`triggers` is optional: a pattern matched against each request. When it
matches, the skill's **Quick start** section is handed to the model at once,
once per chat, instead of waiting for it to call `load_skill` (small models
often don't). **Settings → Skills → Load matching skills automatically** turns
this off.

Skills that ship with Skadi stay up to date: an installed copy you never edited
is replaced when the app ships a newer version, while one you edited is left
alone and marked **Edited** in Settings, with a **Restore** button to go back
to the built-in version.

Only the name and description go into the system prompt. The body is fetched
with the `load_skill` tool when the model judges it relevant. That matters more
here than on a hosted model: at single-digit tokens per second, prompt tokens
spent on instructions nobody needed are the most expensive thing in the system.
The model can write its own skills with `save_skill`.

Click a skill in the rail to read and edit it, or **＋** to write a new one
(name, one-line description, Markdown body). Renaming moves the
`skills/<name>/SKILL.md` directory; deleting removes it. What you save is
exactly what the model will load next session.

## Pixel art

Ask for pixel art, sprites, icons, tiles, 8-bit or retro graphics and the
agent gets five extra tools for that turn (they are left out otherwise, to keep
small models' tool lists short), plus the `pixel-art` skill's quick start:

- `pixel_new` — a named canvas (up to 256×256) with a palette: a preset
  (`sweetie-16`, `pico-8`, `endesga-32`, `earth`, `gameboy`, `grayscale`)
  or up to 36 hex colours. `from` copies a canvas for the next animation frame.
- `pixel_draw` — many operations per call: shapes, lines, flood fill, dithered
  gradients, noise and Voronoi texture, plus one-call `outline`, `shade`
  (light from the top-left), `mirror` (symmetry), `stamp` (compose sprites)
  and `text` (a 3×5 pixel font). Argument names are forgiving, and a bad
  operation is skipped with its reason rather than failing the call.
- `pixel_view` — the canvas as a compact character grid (one character per
  pixel), the colours used, and suggestions (missing outline, flat areas,
  art touching the edge). Vision models also get the rendered picture.
- `pixel_export` — a PNG in the project, and the HTML, CSS and canvas code to
  show it sharply (`image-rendering: pixelated`, no smoothing). `frames`
  packs an animation sprite sheet with a CSS `steps()` snippet; `tileset`
  makes the 16 autotile edge variants of a tile; `data_uri` returns an
  inline image for single-file pages.
- `pixel_import` — loads an existing PNG to edit, shrinking upscaled art
  back to its real pixels.

The canvas is shown in the chat as it is painted. Canvases are kept per chat
in `pixel/`. The drawing approach — an agent placing palette-indexed pixels
with tools and checking a text grid, rather than a diffusion model — and the
autotile generator come from Texel Studio by Emir Yaman Sivrikaya,
https://github.com/EYamanS/texel-studio, reimplemented dependency-free.

## Memory

One fact per file in `memory/`, with a generated `MEMORY.md` index. The index is
small enough to inline in every system prompt; bodies are read with `recall`.
The model writes them with `remember` and deletes them with `forget`. Types are
`user`, `project`, `feedback` and `reference`.

The rail's Memory panel works the same way as Skills: click a fact to edit its
content, or **＋** to add one directly — useful for preferences and project
constraints you already know, without spending a turn teaching the model.

## Context compaction

Long sessions outgrow the window — on a 96K local model a 99K request dies as
`llama.cpp returned 400: exceed_context_size_error`, and without compaction the
session stays dead. Skadi compacts the way opencode and Hermes do:

- **Automatic preflight.** Before each model round, the request is estimated
  (conservative ~3.5 chars per token — code-heavy transcripts tokenise denser
  than prose — plus tool calls and schemas) and compacted once it crosses
  `threshold` × the window.
- **The window is asked for, not assumed.** Local models use the active
  profile's `ctx`. API providers are resolved from the endpoint's own
  catalogue: OpenRouter reports `context_length` per model, so
  `stealth/union-alpha` is known to hold 262,144 tokens rather than being
  compacted at 90K under a blanket 128K guess. The figure is cached per model,
  a lookup never blocks a turn, and endpoints that publish nothing fall back to
  128K — the meter then says `(assumed)`. **Context window** in Model &
  provider pins it by hand when an endpoint is silent or wrong; clearing the
  field returns it to automatic.
- **One-shot overflow recovery.** If the provider still rejects a request as too
  large, Skadi compacts once and retries that step. A second rejection is
  returned as an error instead of grinding the session down in a loop.
- **Manual Compact button** beside the composer, the Hermes `/compress`
  equivalent, plus a live `used / window` meter next to it. An opened chat is
  measured with the same estimator the agent uses, so an attached screenshot
  counts as an image and not as the length of its base64.

Compaction keeps the system prompt and the most recent messages verbatim (split
at a user boundary so tool calls keep their results) and replaces the older
middle with a model-written continuation summary — goals, decisions, files,
command outcomes, next steps. The summary input is capped (`summaryInputTokens`,
default 12K) so the summarise call itself stays in the tens of seconds on a
local model; anything older is dropped and counted, never silently kept. If the
summary comes back empty (usually a thinking trace eating the output budget),
it retries once with halved input; a second empty still fails safe with the
diagnostics (`finish=…`, trace length) instead of touching the transcript. What was compacted, and what it shrank from/to,
is logged on the session and announced in the status line, with live progress
while the summary streams. Tune it in
`config/settings.json` under `compaction`:

```json
"compaction": {
  "auto": true,
  "threshold": 0.7,
  "reserve": 8192,
  "keepMessages": 12,
  "summaryMaxTokens": 2048,
  "summaryInputTokens": 12000,
  "toolOutputChars": 2000
}
```

## Plans

For bigger tasks the agent may keep a short checklist (3-6 steps) with the
`update_plan` tool, shown in the **Plan** workspace tab. The tool is built for
small local models: steps are referred to by number
(`{"action":"status","step":2,"status":"done"}`), common spellings such as
`in_progress` or `completed` are understood, and finishing a step starts the
next one automatically. A request that cannot be applied (a step that does not
exist, a step the user skipped) is answered with a plain explanation and the
current plan, never an error in the chat.

The plan is also a control surface for the user. Click a step's circle to tick
it off; edit its text inline; reorder with drag or the arrow buttons; change its
status; delete and **Undo**; or clear the whole plan. Edits are saved at once and
re-read into the model's guidance before its next step, so no message is
injected into the chat. Once a user has changed a plan, a later agent update
cannot replace it, rewrite user-written steps, or revive a skipped step. Only
one step is current at a time. **Settings → Agent → Plan checklist** turns the
tool off entirely for models that spend too many steps on bookkeeping.

## Progress

Every model request ends with a short progress note that Skadi builds from the
agent's own tool results: the task, the stage (Find > Understand > Change >
Check > Done), what it has looked at, changed and checked, any placeholder
content still left, and one `Next:` line. Several parts of Skadi can want
something from the model at once (a loop hint, a blocked finish, a nudge to
stop searching and edit); only the most important reaches that single line, so
a small model is never handed two instructions that pull in different ways.

The **Progress** workspace tab shows the same record in plain words. From there
the user can mark a detected problem as **Not a problem**, leave a note the
model reads before every step, or **Start over** to forget the saved progress.

If the model tries to finish while the record says the work is not there
(nothing changed, the change never checked, placeholder content left), it is
sent back once per reason and at most twice per turn; after that its answer
stands. A sent-back answer stays in the chat, marked as set aside, but is no
longer shown to the model.

## Subagents and loop recovery

Before a parent turn begins, a small no-reasoning router decides whether a
bounded read-only search, repository inspection, factual lookup or summary can
be delegated. When it can, a focused child receives only that task and the
read-only tools, then returns a compact evidence report to the parent. The
parent still owns every edit and final runtime check. **Automatic research
subagents** and their default reasoning level are configurable under
**Settings → Agent**; the `delegate_task` tool also accepts an explicit effort
from `none` through `xhigh`. A child is registered as running before it begins,
so reconnect and Stop can reach it even while the parent is waiting. If the
semantic supervisor detects that a read-only child has stopped making useful
progress, the child returns its evidence and recommended next action to the
parent instead of starting another research round.

Loop recovery works on two levels. An exact repeat (the same call returning
the same result) is caught every step: the duplicate stays in the chat, marked,
but is hidden from the model, since the first copy is still there. Every few
steps (**Progress check every**) the same model is also asked a yes/no
question: did the last step add anything? Small models misjudge this, so the
answer only ever adds a one-line hint to the progress note; it never removes
evidence, and steps that edited or checked something are never questioned. The
check runs without thinking by default, and malformed or unavailable output
fails open. Each intervention appears in the chat as a short note, so it is
clear why the agent changed course. **Emergency tool ceiling** remains available as an optional fallback,
but `0` disables it and relies on semantic recovery.

## Settings

The gear button in the top bar opens settings. The menu on the left groups
pages under General, Model, Agent, Knowledge and System; each page opens with a
sentence on what it is for, and everything applies immediately. The search box
finds any setting by name or description.

- **Model** — active provider, endpoint (editable for API providers; the local
  one is managed by Skadi), model id, API key, API sampling temperature, and
  the **compression model**: the auxiliary model that writes compaction
  summaries. Empty means the main model. A managed server holds a single
  model, so anything but its alias falls back to main — the override earns
  its keep with hosted providers, where a small fast model summarises for a
  fraction of the cost and time.
- **Memory & Skills** — whether the memory index and the skills catalogue
  enter the system prompt, and which memory types are indexed. Both save
  prompt tokens on every turn when trimmed; the facts and skills themselves
  are browsed and edited in the rail.

## Undoing what a chat wrote

Every file a tool writes leaves an entry in the chat's edit history carrying
both images: the bytes the file had before, and the bytes it was given. Holding
both is what makes an edit reversible in either direction.

Each file chip in the transcript offers **Undo** while the edit is applied and
**Redo** once it is not, and the file viewer offers the same pair. Undoing no
longer discards the entry, so nothing has to be done twice to get it back.

Above the transcript is a bar summarising everything that chat has written --
how many files, and the lines added and removed across them. It carries two
buttons:

- **Revert all** puts every file back as it was before the chat started. It
  runs newest edit first, so several edits to one file unwind to the oldest
  before-image rather than to the second-newest.
- **Reapply all** puts them all back, oldest edit first, so the newest
  after-image is what survives.

Both are all-or-nothing. Nothing is written until every entry involved is known
to still hold its images, each file's current bytes are kept first, and a
failure part-way restores every file already touched before reporting. Clicking
the bar itself lists each edit with its stats and whether it is applied.

Both refuse while a turn is running in that chat: an agent still writing files
would race the revert. The model is told what happened either way, so it
continues from what the files now hold rather than from what it believes it
wrote.

An edit whose before or after image is over 1 MB is recorded as unreversible
rather than clipped -- restoring a truncated copy would destroy the file it was
meant to rescue -- and neither button is offered for it. The history holds 200
entries and about 4 MB of images per chat; beyond that the oldest entries give
up their copies. Images never leave the server: the window is sent paths and
line counts only.

## Tools

`read_file`, `write_file`, `edit_file`, `delete_file`, `list_dir`, `glob`,
`grep`, `run_command`, `web_search`, the `browser_*` set, plus `load_skill` / `save_skill` and
`remember` / `recall` / `forget`.

Repository inspection is search-first. `grep` uses native ripgrep when it is
available and falls back to Skadi's own streaming scanner, including for files
larger than the 256 KB whole-file read guard. Results carry `path:line`, which
the agent feeds into `read_file` as an explicit numbered range. Large source
files therefore stay inspectable without dumping them into model context;
returned excerpts remain capped at 30,000 characters.

`web_search` uses DuckDuckGo by default, with no API key or account.
**Settings → Web search → Private search with SearXNG** runs SearXNG natively
on this machine instead — no Docker. The first time it is switched on, Skadi
finds Python 3.10 or newer, downloads SearXNG into `searxng/`, makes a virtual
environment and installs its packages (a minute or two); after that, on and off
just start and stop it on 127.0.0.1. The status row shows each step, and
**Reinstall** starts over from scratch. Until SearXNG answers — or if it fails —
searches quietly use DuckDuckGo. If you already run SearXNG elsewhere, put its
address in **Your own SearXNG server** instead. Both backends return compact
titles, source URLs and snippets.
The globe button in the composer controls whether `web_search` is available in
that chat. The choice is stored with the session, and the button is locked while
a turn is running so its tool set cannot change halfway through the loop.

The bundled `web-research` skill teaches the agent to prefer primary sources,
check freshness, corroborate consequential claims, keep private data out of
queries, and attach traceable links near the conclusions they support.

Every path is resolved inside the project root and paths that escape it are
rejected. A Claude-style **permission mode** picker below the prompt bar (or
`Shift+Tab` in the prompt box) controls what runs without asking: **Manual**
reads only, everything else prompts; **Accept edits** auto-approves file
writes while commands still prompt; **Plan** blocks file edits so the model
researches and proposes; **Auto** runs everything; **Don't ask** denies
instead of prompting; **Bypass** skips all checks. The two **Skadi settings**
toggles fine-tune Manual mode. With no browser attached, approval fails
closed.
