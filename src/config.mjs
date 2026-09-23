// Config load/save. Everything the harness knows about how to launch a model
// lives in config/profiles.json so the UI can edit it and write it straight back.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_CATALOG, isCatalogId } from './profile-catalog.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'config', 'profiles.json');
export const SETTINGS_PATH = join(ROOT, 'config', 'settings.json');

export const DEFAULT_SETTINGS = {
  settingsSchemaVersion: 2,
  // Directory the agent's file tools are confined to. Changed from the UI.
  workspace: join(ROOT, 'workspace'),
  uiPort: 7777,
  // UI theme. 'polar' is the standard blue-grey dark; 'oled' is pure black
  // with neutral greys, for OLED panels where fully-off pixels stay off.
  theme: 'polar',
  // OLED burn-in care: a stripped-down top bar (static, always-lit chrome
  // is what burns in), dimmed icons, a slow 1px shift of what remains, and a
  // dimmed screen after a few idle minutes. Turned on with the OLED theme.
  oledCare: false,
  // Look for a newer release on GitHub now and then, and offer it in the
  // window. Nothing is installed without being asked.
  updateCheck: true,
  // Poll interval for the GPU memory sampler, milliseconds.
  vramPollMs: 2000,
  // Easy-task emergency ceiling. Medium tasks receive 2x and hard tasks 3.75x;
  // the classifier preserves a tight bug-fix budget without truncating larger
  // builds. 0 disables this count-based fallback.
  maxToolRounds: 0,
  // Implementation requests must converge. After this many successful
  // discovery/test rounds without a file edit, stop instead of spending an
  // unlimited turn re-diagnosing the same small bug. 0 disables the guard.
  maxImplementationDiscoveryRounds: 4,
  // The semantic supervisor uses the same model. Reviewing every action can
  // double local inference time, so deterministic loop checks run every round
  // while the model reviewer samples every N rounds.
  loopReviewEvery: 3,
  loopDetection: true,
  // The supervisor is a yes/no classification, so thinking is off by default:
  // on a local model a thinking trace costs more than the answer is worth.
  loopReviewEffort: 'none',
  // Offer the update_plan checklist tool and show the Plan pane. Off keeps
  // small models from spending steps on bookkeeping.
  planning: true,
  // Offer the desktop_* tools: the agent drives the user's real screen, mouse
  // and keyboard. Off by default because it reaches outside the project.
  computerControl: false,
  // Hand a skill straight to the model when the request matches its
  // triggers (e.g. pixel art), instead of hoping it calls load_skill.
  autoSkills: true,
  // A single autonomous turn should not occupy a local model indefinitely.
  // The transcript and file changes are saved, so this limit is resumable.
  maxTurnMinutes: 45,
  // Route bounded research/search/summary work through a read-only child
  // before the parent turn. Both routing and the default child run without
  // reasoning unless the user raises this setting or the tool argument.
  autoSubagents: true,
  autoSubagentReasoning: 'none',
  // Seconds before a single shell command is killed.
  commandTimeoutSec: 120,
  // Free, keyless agent web search. DuckDuckGo needs no setup; SearXNG points
  // at a user-owned instance and uses its JSON search API.
  webSearchProvider: 'duckduckgo',
  searxngUrl: '',
  searxngAutoStart: false,
  searxngPort: 8888,
  webSearchResults: 6,
  // Require explicit approval in the UI before write_file / edit_file / run_command.
  approveWrites: true,
  approveCommands: true,
  // Permission mode, Claude-style: 'default' (manual: reads run, mutations
  // prompt), 'acceptEdits' (file edits auto-approved, commands still prompt),
  // 'plan' (research only: file mutations blocked, commands prompt),
  // 'auto' (everything runs without prompting), 'dontAsk' (anything that
  // would prompt is denied instead), 'bypassPermissions' (skip all checks).
  permissionMode: 'default',
  // Default sampling temperature for hosted API providers (local models use
  // their profile's temp instead).
  apiTemperature: 1,
  // Auxiliary model for compaction summaries, Hermes-style. Empty means the
  // main model. Only takes effect when the provider can actually serve it: a
  // managed llama-server holds one model, so anything but its alias falls
  // back to main.
  compressionModel: '',
  // Memory index in the system prompt, and which fact types it covers.
  memoryInPrompt: true,
  memoryTypes: ['user', 'project', 'feedback', 'reference'],
  // Skills catalogue in the system prompt. Off saves tokens but the model
  // will not know skills exist unless you name one.
  skillsInPrompt: true,
  // Context compaction (opencode-style auto-checkpoint, Hermes-style summary).
  // The agent compacts the live transcript once it crosses threshold * the
  // window (profile ctx for local models, provider figure for APIs), keeping
  // keepMessages recent messages verbatim beside a model-written summary.
  // Older session messages stay in the session file either way.
  compaction: {
    auto: true,
    threshold: 0.7,
    reserve: 8192,
    keepMessages: 12,
    summaryMaxTokens: 2048,
    summaryInputTokens: 12000,
    toolOutputChars: 2000,
  },
  // Providers bounce requests they cannot serve right now -- rate limits,
  // saturated upstream pools, gateway restarts. Rather than failing the turn,
  // Skadi waits and sends the same request again. `attempts` counts the whole
  // sequence, so 8 means one try plus seven retries; the delay starts at
  // minDelaySec, doubles after each failure, and is capped at maxDelaySec.
  // A `Retry-After` header wins, clamped into the same range.
  retry: {
    attempts: 8,
    minDelaySec: 5,
    maxDelaySec: 25,
  },
  // A ceiling on the images one request may carry, in megabytes of base64.
  //
  // Compaction counts tokens, and a screenshot is cheap in tokens and enormous
  // in bytes -- so a chat that takes a dozen screenshots sails past a
  // gateway's request-size limit while the meter still reads a third full.
  // Measured against OpenRouter: a request of 16k prompt tokens carrying 9.8MB
  // of images is refused with a 502 that no amount of retrying will fix, while
  // the same chat at 7.4MB goes through. Above this ceiling the oldest images
  // are left out of the request -- never out of the chat -- newest first,
  // since the recent screenshot is the one being talked about.
  maxImageMb: 4,
  // Each chat gets its own browser. They are real Chromium processes, so a
  // ceiling keeps a long chat list from filling memory with them: the least
  // recently used browser nobody is watching is closed when the cap is hit.
  // 0 removes the ceiling.
  maxBrowsers: 4,
  // Measured VRAM footprints, keyed by profile id. Filled in automatically
  // after each successful launch so the UI can show real numbers, not guesses.
  // Each entry also carries the prediction it is being compared against, which
  // is what lets the next launch correct for a miss instead of repeating it.
  measured: {},

  // ---- VRAM fitting ------------------------------------------------------
  // Megabytes of VRAM deliberately left free. The desktop compositor, a browser
  // and the driver's own allocations all live on the same card, and once a
  // Vulkan allocation cannot be served from VRAM the driver quietly backs it
  // with system RAM instead of failing -- which is the slow, invisible failure
  // mode this whole mechanism exists to avoid.
  //
  // llama.cpp's own --fit-target defaults to 1024 MiB, and that is measurably
  // too little here: a 27B profile it declared a fit at 1 GB of margin still
  // spilled 3.9 GB, because the desktop's own GPU usage moves by more than the
  // slack it left. 2 GB is the figure that holds on a 16 GB card with a browser
  // open. The measured spill is added on top of this, per profile.
  vramReserveMb: 2048,
  // Run the fitter before every launch. Off means a profile launches exactly as
  // written, spill and all.
  autoFitOnStart: true,
  // What the fitter is allowed to change when a profile does not fit:
  //   'off'  -- nothing; report and launch anyway
  //   'ctx'  -- context length only (safe: same model, shorter memory)
  //   'full' -- context, KV quantisation and GPU layers
  // A profile can override this with its own `autoFit` key.
  fitMode: 'full',
  // Which of the two gives way first in 'full' mode. 'context' keeps the window
  // and pays for it in cache precision; 'quality' keeps the cache exact and pays
  // for it in window. A profile can override with its own `fitPriority`.
  fitPriority: 'context',
  // The fitter will not shrink context below this, even if that means reporting
  // failure instead. A 4K coding assistant is not worth having.
  ctxFloor: 32768,
  // Whether the fitter may leave layers on the CPU as a last resort. It always
  // makes things fit, and it is the only adjustment here that really costs
  // tokens per second -- so off means "I would rather be told it does not fit".
  allowCpuLayers: false,
  // Decode speed below which a profile is worth complaining about, tokens per
  // second. Measured from llama-server's own timings after a turn, not predicted.
  minTokensPerSec: 7,
};

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    // Notepad and Windows PowerShell both like to add a byte-order mark.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const canonical = (value) => JSON.stringify(value, (_, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
    : v));

const forward = (path) => path.replaceAll('\\', '/');

/**
 * What a fresh checkout starts with: the engine and the models beside the app,
 * which is where install.ps1 puts them. Nothing here names a folder that only
 * exists on one machine.
 */
export function defaultConfig() {
  const exe = forward(join(ROOT, 'engine', 'llama-server.exe'));
  return {
    serverExe: exe,
    engines: { beellama: exe },
    modelsDir: forward(join(ROOT, 'models')),
    chatTemplateFile: forward(join(ROOT, 'models', 'chat_template.jinja')),
    host: '127.0.0.1',
    port: 8080,
    activeProfile: 'qwen38-27b-iq3s-128k',
    profiles: {},
  };
}

/** Turn a catalog profile's "@engine" into a path, else leave the main server in charge. */
function resolveEngine(profile, cfg) {
  if (typeof profile.serverExe === 'string' && profile.serverExe.startsWith('@')) {
    const path = cfg.engines?.[profile.serverExe.slice(1)];
    if (path) profile.serverExe = path;
    else delete profile.serverExe;
  }
  return profile;
}

/**
 * The saved profiles with the read-only catalog laid over them. Catalog entries
 * carry `catalog: true`; they are never written back (see saveConfig), so a
 * release can refresh them without touching anything the user made.
 *
 * A saved profile that reuses a catalog id but differs from it was edited back
 * when those profiles were ordinary ones. Keep that copy as "<id>-custom"
 * rather than silently replacing the user's tuning with the catalog's.
 */
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, defaultConfig());
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg) throw new Error(`Missing ${CONFIG_PATH}`);
  const saved = cfg.profiles || {};
  const profiles = {};
  for (const [id, profile] of Object.entries(PROFILE_CATALOG)) profiles[id] = resolveEngine(structuredClone(profile), cfg);
  for (const [id, profile] of Object.entries(saved)) {
    if (!isCatalogId(id)) {
      profiles[id] = profile;
      continue;
    }
    // Display-only fields differ by design; everything else must match.
    const launchSettings = ({ catalog, vramGB, info, label, ...rest }) => canonical(rest);
    if (launchSettings(resolveEngine(structuredClone(profile), cfg)) === launchSettings(profiles[id])) continue;
    let copyId = `${id}-custom`;
    for (let n = 2; copyId in profiles || copyId in saved; n++) copyId = `${id}-custom-${n}`;
    profiles[copyId] = { ...profile, label: `${profile.label || id} (mine)` };
  }
  if (!profiles[cfg.activeProfile]) cfg.activeProfile = Object.keys(profiles)[0];
  return { ...cfg, profiles, catalogImported: importedCatalogIds(cfg, profiles) };
}

/**
 * Which catalog profiles the user has brought into their profile list. The
 * catalog itself is always whole (it is where you shop); the profile dropdown
 * shows only what was imported, so a profile you do not want never has to be
 * looked at.
 *
 * Configs written before this existed have no list. They keep exactly one
 * catalog profile -- the one in use -- rather than either all of them (the
 * clutter this exists to remove) or none (which would pull the rug out from
 * under the model that is loaded).
 */
export function importedCatalogIds(cfg, profiles) {
  const ids = Array.isArray(cfg.catalogImported)
    ? cfg.catalogImported
    : [cfg.activeProfile].filter((id) => profiles[id]?.catalog);
  return [...new Set(ids)].filter(isCatalogId);
}

export function saveConfig(cfg) {
  const profiles = {};
  for (const [id, profile] of Object.entries(cfg.profiles || {})) {
    // Catalog profiles ship with the app; temporary ones (default settings a
    // model was loaded with) exist only until it is ejected, or until saved.
    if (!profile.catalog && !profile.temporary) profiles[id] = profile;
  }
  // A temporary profile can be the one in use, but must not be what the next
  // launch points at: it will not be there.
  let activeProfile = cfg.activeProfile;
  if (cfg.profiles?.[activeProfile]?.temporary) {
    try {
      activeProfile = readJson(CONFIG_PATH, {}).activeProfile ?? Object.keys(profiles)[0];
    } catch {
      activeProfile = Object.keys(profiles)[0];
    }
  }
  writeJson(CONFIG_PATH, { ...cfg, activeProfile, profiles });
  return cfg;
}

// Where each downloaded model came from and which vision tower goes with it.
// Kept apart from profiles.json: it describes files, not launch settings.
export const MODEL_META_PATH = join(ROOT, 'config', 'models.json');
export const loadModelMeta = () => readJson(MODEL_META_PATH, {});
export function saveModelMeta(patch) {
  const merged = { ...loadModelMeta(), ...patch };
  writeJson(MODEL_META_PATH, merged);
  return merged;
}

export function loadSettings() {
  const saved = readJson(SETTINGS_PATH, DEFAULT_SETTINGS);
  const migrated = migrateSettings(saved);
  if (existsSync(SETTINGS_PATH) && canonical(saved) !== canonical(migrated)) writeJson(SETTINGS_PATH, migrated);
  return { ...DEFAULT_SETTINGS, ...migrated };
}

/** Migrate settings that were once shipped as defaults without overriding
 * later, explicit choices. Version 0 used an 8-round easy-task limit, which
 * became 30 rounds for hard tasks and paused valid work despite semantic loop
 * detection. The replacement default is opt-out by time/semantics, not count.
 * Version 1 shipped the progress check with 'low' reasoning; on a local model
 * that trace ate the reviewer's whole answer budget, so it moves to 'none'. */
export function migrateSettings(saved = {}) {
  const next = { ...saved };
  const version = Number(next.settingsSchemaVersion) || 0;
  if (version < 1 && Number(next.maxToolRounds) === 8) next.maxToolRounds = 0;
  if (version < 2 && next.loopReviewEffort === 'low') next.loopReviewEffort = 'none';
  next.settingsSchemaVersion = 2;
  return next;
}

export function saveSettings(settings) {
  const merged = { ...loadSettings(), ...settings };
  writeJson(SETTINGS_PATH, merged);
  return merged;
}

/** Remove the user file entirely; every key falls back to the defaults. */
export function resetSettings() {
  if (existsSync(SETTINGS_PATH)) rmSync(SETTINGS_PATH);
  return loadSettings();
}

export function activeProfile(cfg = loadConfig()) {
  const profile = cfg.profiles[cfg.activeProfile];
  if (!profile) throw new Error(`Unknown profile: ${cfg.activeProfile}`);
  return { id: cfg.activeProfile, ...profile };
}

/**
 * Absolute path to a profile's .gguf file.
 *
 * A profile may name a file inside `modelsDir`, or carry an absolute
 * `modelPath` to a .gguf anywhere on disk -- loading a model should not require
 * moving it into a blessed folder first.
 */
export function modelPath(cfg, profile) {
  if (profile.modelPath) return profile.modelPath.replace(/\\/g, '/');
  return join(cfg.modelsDir, profile.model).replace(/\\/g, '/');
}
