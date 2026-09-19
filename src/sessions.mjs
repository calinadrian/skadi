// Session persistence. One JSON file per session under sessions/, holding the
// full message array so a conversation survives a harness restart.
//
// `messages` is the transcript the model is given; `archive` holds whatever
// compaction has replaced with a summary, oldest first. The chat as a person
// reads it is `archive` followed by `messages` -- the server joins the two on
// the way out, so compacting a long chat never costs it its history.
//
// Sessions also carry lightweight organisation state used by the chats-only
// left rail: pinned, archived, unread and an optional groupId. Groups live in
// sessions/groups.json so they survive restarts and scope to a project.
import { readFile, writeFile, readdir, rename, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const id = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
const groupId = () => `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// Titles are derived from the first prompt and are shown in several places.
// Never let a pasted provider token become navigation text or a tooltip.
export const redactCredentials = (value) => String(value ?? '').replace(
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
  '[credential redacted]',
);

const normaliseSession = (s) => ({
  ...s,
  title: typeof s.title === 'string' && s.title.trim() ? redactCredentials(s.title) : 'New session',
  pinned: Boolean(s.pinned),
  archived: Boolean(s.archived),
  // Sessions start unread only when explicitly marked; default to read so the
  // list is quiet until something actually needs attention.
  unread: Boolean(s.unread),
  groupId: typeof s.groupId === 'string' && s.groupId ? s.groupId : null,
});

export class SessionStore {
  constructor(dir) {
    this.dir = dir;
    // One write at a time per session, and only the newest snapshot pending.
    // The agent saves after every single message now, so without this a busy
    // turn would queue hundreds of overlapping writes of the same file.
    this.writing = new Map(); // id -> the drain running for it
    this.dirty = new Map();   // id -> the newest snapshot not yet written
  }

  async create(title = 'New session', projectId = null) {
    await mkdir(this.dir, { recursive: true });
    const session = normaliseSession({ id: id(), title, projectId, createdAt: Date.now(), updatedAt: Date.now(), messages: [] });
    await this.save(session);
    return session;
  }

  /**
   * Persist a session.
   *
   * Every save parks a snapshot of the whole document in a single pending
   * slot and makes sure a drain is running. The slot holds only the newest
   * snapshot, and a drain always takes whatever is in the slot at the moment
   * it writes, so an older snapshot can never land on top of a newer one --
   * which is how a finished turn used to revert to the transcript from two
   * messages ago. Snapshots are taken at call time, so the file always
   * reflects a consistent moment even though the agent keeps mutating the
   * live array.
   *
   * Returns once *this* snapshot (or something newer) is on disk. The loop is
   * what makes that true: a drain that had already passed its last look at
   * the slot resolves without taking ours, so another one is started.
   *
   * `touch: false` writes the file without moving `updatedAt`. The rail is
   * ordered by it, so it has to mean "when this conversation last changed",
   * not "when this file was last written". Marking a chat read on open is a
   * write; so are pin, archive, rename and moving to a group. Bumping the
   * stamp for those is what made the rail reshuffle itself under the cursor:
   * clicking a chat to read it sent it to the top, and the chat you were
   * looking for was never where you left it.
   */
  async save(session, { touch = true } = {}) {
    if (touch) session.updatedAt = Date.now();
    this.dirty.set(session.id, JSON.stringify(session, null, 2));
    while (this.dirty.has(session.id)) await this._drainer(session.id);
    return session;
  }

  /** The drain running for `id`, started if there is not one already. */
  _drainer(id) {
    let run = this.writing.get(id);
    if (!run) {
      run = this._drain(id).finally(() => {
        if (this.writing.get(id) === run) this.writing.delete(id);
      });
      this.writing.set(id, run);
    }
    return run;
  }

  /**
   * Write pending snapshots for `id` until the slot is empty. The snapshot is
   * taken out of the slot *before* it is written: a write that fails must not
   * leave it there to be replayed after newer data, and anything newer that
   * arrives meanwhile is a superset of what was lost anyway.
   */
  async _drain(id) {
    await mkdir(this.dir, { recursive: true });
    for (;;) {
      const data = this.dirty.get(id);
      if (data == null) return;
      this.dirty.delete(id);
      await this._writeAtomic(id, data);
    }
  }

  async _writeAtomic(id, data) {
    const file = join(this.dir, `${id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, data, 'utf8');
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    // Windows fails the replace outright while anything holds the file open --
    // a reader in this process, Explorer, a scanner. It is always momentary,
    // so back off and retry rather than dropping to a non-atomic write that
    // could be read half-finished.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (err) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)) {
          await rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
        if (attempt >= 6) {
          // Still blocked: an in-place write risks a torn read, but losing the
          // turn is worse.
          await writeFile(file, data, 'utf8');
          await rm(tmp, { force: true }).catch(() => {});
          return;
        }
        await new Promise((r) => setTimeout(r, 5 * 2 ** attempt));
      }
    }
  }

  async get(sessionId) {
    const file = join(this.dir, `${sessionId}.json`);
    if (!existsSync(file)) throw new Error(`no session ${sessionId}`);
    return normaliseSession(JSON.parse(await readFile(file, 'utf8')));
  }

  /** Scoped to one project when given an id; sessions from before projects existed have none. */
  async list(projectId = null, { includeArchived = true } = {}) {
    if (!existsSync(this.dir)) return [];
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json') && f !== 'groups.json');
    const out = [];
    for (const file of files) {
      try {
        const raw = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
        // Guard against groups.json or any non-session payload sharing the dir.
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) continue;
        const s = normaliseSession(raw);
        if (projectId && s.projectId && s.projectId !== projectId) continue;
        if (!includeArchived && s.archived) continue;
        out.push({
          id: s.id,
          title: s.title,
          projectId: s.projectId ?? null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          turns: s.messages.filter((m) => m.role === 'user').length,
          pinned: s.pinned,
          archived: s.archived,
          unread: s.unread,
          groupId: s.groupId,
        });
      } catch {
        // A half-written file from a crash should not break the session list.
      }
    }
    // Pinned first, then most recently updated. Groups are applied in the UI;
    // the ordering here stays stable so every view sorts the same way.
    return out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  async remove(sessionId) {
    const file = join(this.dir, `${sessionId}.json`);
    if (existsSync(file)) await rm(file);
  }

  /** Every transcript for the project, groups left standing. Returns the count. */
  async wipe(projectId = null) {
    if (!existsSync(this.dir)) return 0;
    let count = 0;
    for (const file of (await readdir(this.dir)).filter((f) => f.endsWith('.json') && f !== 'groups.json')) {
      try {
        const raw = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) continue;
        if (projectId && raw.projectId && raw.projectId !== projectId) continue;
        await rm(join(this.dir, file));
        count++;
      } catch {
        // Not a session file (or half-written); leave it alone.
      }
    }
    return count;
  }

  /**
   * Patch organisation fields on a session. Only whitelisted keys are applied
   * so a client cannot rewrite the transcript through this path.
   */
  async update(sessionId, patch = {}) {
    const session = await this.get(sessionId);
    if (patch.title !== undefined) {
      const title = redactCredentials(patch.title).trim().slice(0, 120);
      if (!title) throw new Error('title cannot be empty');
      session.title = title;
      session.titleAuto = false;
    }
    if (patch.pinned !== undefined) session.pinned = Boolean(patch.pinned);
    if (patch.archived !== undefined) session.archived = Boolean(patch.archived);
    if (patch.unread !== undefined) session.unread = Boolean(patch.unread);
    if (patch.groupId !== undefined) {
      if (patch.groupId === null || patch.groupId === '') {
        session.groupId = null;
      } else {
        const groups = await this.listGroups(session.projectId ?? null);
        if (!groups.some((g) => g.id === patch.groupId)) throw new Error('unknown group');
        session.groupId = patch.groupId;
      }
    }
    // Organisation, not conversation: the chat has not changed, so it keeps
    // its place in the rail. See `save`.
    await this.save(session, { touch: false });
    return session;
  }

  // -------------------------------------------------------------- groups ---

  get groupsFile() {
    return join(this.dir, 'groups.json');
  }

  /** Groups are scoped per project; legacy groups without one are visible everywhere. */
  async listGroups(projectId = null) {
    if (!existsSync(this.groupsFile)) return [];
    try {
      const raw = JSON.parse(await readFile(this.groupsFile, 'utf8'));
      const all = Array.isArray(raw) ? raw : [];
      return all
        .filter((g) => g && typeof g.id === 'string')
        .filter((g) => !projectId || !g.projectId || g.projectId === projectId)
        .map((g) => ({
          id: g.id,
          name: String(g.name || 'Untitled group').slice(0, 80),
          projectId: g.projectId ?? null,
          createdAt: g.createdAt ?? 0,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } catch {
      return [];
    }
  }

  async readAllGroups() {
    if (!existsSync(this.groupsFile)) return [];
    try {
      const raw = JSON.parse(await readFile(this.groupsFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  async writeAllGroups(groups) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.groupsFile, JSON.stringify(groups, null, 2), 'utf8');
  }

  async createGroup(name, projectId = null) {
    const clean = String(name ?? '').trim().slice(0, 80);
    if (!clean) throw new Error('group needs a name');
    const all = await this.readAllGroups();
    // Same name in the same project is the same group. Creating it twice (a
    // double click, or a second window) used to list "Test" twice in the menu
    // with no way to tell the two apart.
    const twin = all.find((g) => g && (g.projectId ?? null) === (projectId ?? null)
      && String(g.name || '').trim().toLowerCase() === clean.toLowerCase());
    if (twin) return twin;
    const group = { id: groupId(), name: clean, projectId: projectId ?? null, createdAt: Date.now() };
    all.push(group);
    await this.writeAllGroups(all);
    return group;
  }

  async renameGroup(id, name) {
    const clean = String(name ?? '').trim().slice(0, 80);
    if (!clean) throw new Error('group needs a name');
    const all = await this.readAllGroups();
    const hit = all.find((g) => g.id === id);
    if (!hit) throw new Error('unknown group');
    hit.name = clean;
    await this.writeAllGroups(all);
    return hit;
  }

  async deleteGroup(id) {
    const all = await this.readAllGroups();
    if (!all.some((g) => g.id === id)) throw new Error('unknown group');
    await this.writeAllGroups(all.filter((g) => g.id !== id));
    // Sessions in the deleted group become ungrouped rather than orphaned.
    if (existsSync(this.dir)) {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json') && f !== 'groups.json');
      for (const file of files) {
        try {
          const s = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
          if (s && s.groupId === id) {
            s.groupId = null;
            await this.save(s);
          }
        } catch {
          /* leave half-written files alone */
        }
      }
    }
    return id;
  }
}
