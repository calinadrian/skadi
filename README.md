<p align="center">
  <img src="build/skadi-icon.png" alt="Skadi" width="132">
</p>

<h1 align="center">Skadi</h1>

<p align="center">
  <b>A local-AI coding harness for Windows.</b><br>
  Runs a model on your own GPU, tunes it to fit, and lets it work in your projects.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6fd8f5"></a>
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-1f2a37">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-1f2a37">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-1f2a37">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#what-you-get">Features</a> ·
  <a href="#using-skadi">Using it</a> ·
  <a href="#updates">Updates</a> ·
  <a href="docs/how-it-works.md">How it works</a>
</p>

---

Skadi launches and tunes `llama-server` for you, shows how much VRAM a setup will
cost *before* you start it, points an agent at a project folder, and embeds a real
browser so the agent can look at what it changed. Prefer a hosted model? OpenAI,
Anthropic, OpenRouter and anything OpenAI-compatible work too.

It is plain Node and one static page. No `node_modules`, no framework, no font CDN.

## Install

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/calinadrian/skadi/main/install.ps1 | iex
```

That one command:

| | |
| --- | --- |
| **Node.js** | installs it with `winget` if you do not have version 20 or newer |
| **Skadi** | downloads the app from this repository |
| **Engine** | fetches [BeeLlama](https://github.com/Anbeeld/beellama.cpp), a llama.cpp build, for your GPU |
| **Launcher** | builds `Skadi.exe` and adds Desktop and Start Menu shortcuts |

It takes a minute: no model is downloaded. You pick and download one inside Skadi
once it is open (see [Using Skadi](#using-skadi)), where it tells you whether a
file will fit your GPU *before* you download it.

No administrator rights needed. Run it again any time: finished downloads are
skipped and your settings are kept.

Want to choose? Save the script, then:

```powershell
.\install.ps1 -ModelsDir D:\models   # where Skadi will look for (and save) models
.\install.ps1 -Backend cuda          # NVIDIA CUDA instead of Vulkan (larger download)
.\install.ps1 -NoShortcuts           # skip the Desktop and Start Menu shortcuts
```

<details>
<summary>Prefer to do it by hand?</summary>

```powershell
git clone https://github.com/calinadrian/skadi.git
cd skadi
.\install.ps1
```

Or skip the installer entirely: `node skadi.mjs` starts the server, and the model
browser inside the app can download anything from Hugging Face.

</details>

**Needs:** Windows 10 or 11, a GPU with 10 GB of VRAM or more for a 27B model
(any vendor — the default engine uses Vulkan), and the WebView2 runtime that
ships with Windows 11. Chrome, Brave or Edge is used for the review browser.

## What you get

**Local models, done properly**
- **A VRAM forecast before you press start.** Skadi reads the model's header and
  predicts weights, KV cache and compute buffers, then measures what the card
  actually used and corrects itself next time.
- **It stops the spill.** Auto-fit places tensors so nothing quietly falls into
  system RAM, where speed collapses. Sliders update the forecast live.
- **Tuned profiles included.** Ready-made launch profiles measured on a 16 GB
  card, with speculative decoding (MTP) and long context.
- **Load several models at once.** Each gets its own port; every chat picks which
  one answers it.
- **A model browser.** Search Hugging Face, see whether a file will fit *before*
  downloading, and get resumable downloads.

**An agent that can actually work**
- **File and shell tools** confined to the project folder you choose: range-safe
  large-file reads, ripgrep-first search with a portable fallback, writes, edits,
  globs and commands.
- **Free web search** through DuckDuckGo out of the box, or your own SearXNG
  instance — no paid search API key required. If Docker is available, Skadi can
  also start and stop a private SearXNG container alongside the app. The globe
  button in the composer enables or disables search separately for each chat.
- **Permission modes** from *Manual* to *Auto*, so you decide what runs unasked.
- **Undo and redo** every file a chat wrote — one file, or the whole chat.
- **A live execution plan** for substantial work. The agent keeps one step active
  while you can edit, insert, skip, delete, restore or reorder steps from the
  workspace without stopping the turn.
- **An embedded browser** per chat, driven by you and the agent together; the agent
  can screenshot, click, type and read the console to check its own work.
- **Skills and memory** the agent can read and write, kept as plain Markdown.
- **Context compaction** so long sessions don't die at the window's edge.
- **Automatic read-only subagents** for bounded search, inspection and summary work, with a configurable reasoning level that defaults to none; children are visible to reconnect/Stop and hand control back when semantic supervision finds no progress.
- **Semantic loop recovery** that judges progress against the request, removes detected bad read-only cycles from active context, and redirects the agent without a fixed call-count cutoff.
- **Photos, files and folders** as attachments, for vision models.

**Bring any model**
- Local `llama.cpp`, **OpenAI**, **Anthropic**, **OpenRouter**, Groq, DeepSeek and
  any OpenAI-compatible endpoint, mixed freely — one per chat.
- Rate limits and gateway hiccups are retried with backoff; broken tool calls are
  repaired instead of poisoning the conversation.

**A window that stays out of the way**
- A native Windows app with its own title bar, snapping and resizing that work.
- Live tokens per second, time to first token, and a context meter.
- OLED-black theme, and a layout that holds up when the window gets narrow.
- **Updates from GitHub**, inside the app.

## Using Skadi

1. **Start it** from the Desktop shortcut (or `node skadi.mjs`).
2. **Pick a project.** The folder icon under the prompt selects the directory the
   agent works in; **+** adds one.
3. **Get a model, then load it.** Open **Local AI** in the top bar and choose
   **Browse models**. The tuned profiles each have a **Get model** button that
   opens the right Hugging Face page (the recommended one is Qwen3.8-27B IQ3_S,
   about 12 GB), or search for any GGUF yourself; Skadi tells you whether a file
   fits your GPU before you download it. Then pick the file and a profile (or
   *Default settings*) and press **Load**. The forecast shows what it will cost
   first.
4. **Ask for something.** *"Add a dark mode toggle to this page and check it in
   the browser."* Watch the tool calls stack up in one collapsible group; open it
   to read the reasoning and every command.

Using a hosted model instead? **Settings → Model & provider**, pick a provider and
paste a key. The key is encrypted for your Windows account and never sent anywhere
but that provider.

## Updates

Skadi checks GitHub for a newer version when it starts and every few hours. When
there is one, a small **Update** tag appears beside the version at the bottom left
of the chat list. Click it to see what's new and press **Update now**: Skadi
downloads the release, checks that it will start, replaces its own files, and
restarts.

- **Settings → Updates** has a manual **Check for updates** and a switch to turn
  the automatic check off.
- Only application files are replaced. Your chats, settings, API keys, memory,
  skills and models are never touched.
- Every file it replaces is backed up under `build/update-backups`.

## Your data stays yours

Everything lives in the Skadi folder, on your machine:

| Folder | Holds |
| --- | --- |
| `config/` | settings, launch profiles, providers, project list; `secrets.json` holds encrypted API keys |
| `sessions/` | your chats |
| `memory/`, `skills/` | facts and skills the agent keeps |
| `attachments/`, `logs/` | files you attached, and logs |

The server listens on `127.0.0.1` only. Skadi can run shell commands by design and
holds API keys, so don't put it behind a tunnel. The only outside connections are
to the model provider you choose, to Hugging Face when you browse or download
models, and to GitHub when checking for updates.

## Build and test

```powershell
node --test "tests/*.test.mjs"     # the test suite; no install step
npm run build                       # rebuild Skadi.exe (uses the C# compiler in Windows)
powershell -File build\make-icon.ps1   # regenerate the icon from build\skadi-icon.png
```

The interesting parts, if you want to read the code:

```
skadi.mjs             entry point
src/server.mjs        HTTP API and the live event stream
src/llama.mjs         starts and supervises llama-server
src/gguf.mjs          reads model headers, forecasts VRAM
src/agent.mjs         the tool-calling loop
src/providers.mjs     local, OpenAI-compatible and Anthropic backends
src/update.mjs        checks GitHub and installs updates
ui/                   the whole interface: index.html, app.js, style.css
build/                launcher source and icon
```

More depth — fitting, providers, compaction, undo — is in
[docs/how-it-works.md](docs/how-it-works.md).

## Credits

Skadi builds on other people's work:
[llama.cpp](https://github.com/ggml-org/llama.cpp) and the
[BeeLlama](https://github.com/Anbeeld/beellama.cpp) fork;
the [Qwen3.8-27B GSQ-RCO GGUF](https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF)
quantisations by ISTA-DASLab (Apache-2.0);
the [fixed Qwen chat templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates)
by froggeric; and Microsoft's WebView2 for the app window.

## License

[MIT](LICENSE)
