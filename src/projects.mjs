// Projects: the folder the agent is pointed at.
//
// A project is just a name and an absolute path. Selecting one re-roots every
// file tool, so the agent works inside that folder and nowhere else, and scopes
// the session list to that project's history.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { ROOT } from './config.mjs';

export const PROJECTS_PATH = join(ROOT, 'config', 'projects.json');

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';

function defaults() {
  return {
    active: 'scratch',
    projects: [
      {
        id: 'scratch',
        name: 'Scratch',
        path: join(ROOT, 'workspace').replace(/\\/g, '/'),
        createdAt: Date.now(),
      },
    ],
  };
}

export function loadProjects() {
  if (!existsSync(PROJECTS_PATH)) {
    const initial = defaults();
    saveProjects(initial);
    return initial;
  }
  try {
    return JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`${PROJECTS_PATH} is not valid JSON: ${err.message}`);
  }
}

export function saveProjects(cfg) {
  mkdirSync(dirname(PROJECTS_PATH), { recursive: true });
  writeFileSync(PROJECTS_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg;
}

export function activeProject(cfg = loadProjects()) {
  return cfg.projects.find((p) => p.id === cfg.active) || cfg.projects[0] || null;
}

export function addProject(path, name) {
  const cfg = loadProjects();
  const full = resolve(path).replace(/\\/g, '/');
  if (!existsSync(full)) throw new Error(`No such folder: ${path}`);
  if (!statSync(full).isDirectory()) throw new Error(`Not a folder: ${path}`);

  const existing = cfg.projects.find((p) => p.path.toLowerCase() === full.toLowerCase());
  if (existing) {
    cfg.active = existing.id;
    saveProjects(cfg);
    return existing;
  }

  let id = slug(name || basename(full));
  let n = 2;
  while (cfg.projects.some((p) => p.id === id)) id = `${slug(name || basename(full))}-${n++}`;

  const project = { id, name: name || basename(full), path: full, createdAt: Date.now() };
  cfg.projects.push(project);
  cfg.active = id;
  saveProjects(cfg);
  return project;
}

export function removeProject(id) {
  const cfg = loadProjects();
  cfg.projects = cfg.projects.filter((p) => p.id !== id);
  if (!cfg.projects.length) return saveProjects(defaults());
  if (cfg.active === id) cfg.active = cfg.projects[0].id;
  return saveProjects(cfg);
}

export function selectProject(id) {
  const cfg = loadProjects();
  if (!cfg.projects.some((p) => p.id === id)) throw new Error(`unknown project: ${id}`);
  cfg.active = id;
  saveProjects(cfg);
  return activeProject(cfg);
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', 'target']);

/**
 * A short orientation summary for the system prompt: what kind of project this
 * is and what sits at its root. Cheap enough to regenerate per session and far
 * more useful than making the model spend a tool round on `list_dir`.
 */
export function projectSummary(project) {
  if (!project || !existsSync(project.path)) return null;
  let entries = [];
  try {
    entries = readdirSync(project.path, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirs = entries.filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
    .map((e) => `${e.name}/`);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const markers = [
    ['package.json', 'Node/npm'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['pom.xml', 'Java/Maven'],
    ['*.csproj', '.NET'],
    ['CMakeLists.txt', 'CMake'],
  ];
  const kinds = markers
    .filter(([f]) => (f.startsWith('*') ? files.some((x) => x.endsWith(f.slice(1))) : files.includes(f)))
    .map(([, label]) => label);

  const top = [...dirs, ...files].slice(0, 28).join('  ');
  return [
    `Project: ${project.name} (${project.path})`,
    kinds.length ? `Looks like: ${[...new Set(kinds)].join(', ')}` : null,
    top ? `Root contains: ${top}` : null,
  ].filter(Boolean).join('\n');
}
