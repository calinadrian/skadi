// Mission Control: named agents, rooms they work in, and the tickets they file.
//
// An agent is a saved persona bound to a provider/model. Dropping it into a
// room with a project starts an ordinary chat turn with a room-specific brief,
// so everything a chat can do (tools, approvals, transcript, Stop) still
// applies. Research and Quality end their report with a JSON ticket block;
// those tickets wait here for the user to approve or reject. Development
// works through the project's approved tickets.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ROOMS = [
  { id: 'break', name: 'Break Room', blurb: 'Idle. Agents here do nothing until assigned.', color: '#8fbf6a', works: false },
  { id: 'research', name: 'Research Lab', blurb: 'Browses the web for ideas to improve the project and files improvement tickets.', color: '#6f9fe0', works: true, tickets: 'idea' },
  { id: 'quality', name: 'Quality', blurb: 'Hunts bugs in the project and files bug tickets with repro and fix.', color: '#e0707a', works: true, tickets: 'bug' },
  { id: 'development', name: 'Development', blurb: 'Implements the approved tickets for the project.', color: '#f08a4b', works: true },
  { id: 'review', name: 'Code Review', blurb: 'Reviews recent changes (git diff/log) and files tickets for risky code.', color: '#4fbfa8', works: true, tickets: 'review' },
  { id: 'docs', name: 'Docs Studio', blurb: 'Keeps README and docs in line with the code.', color: '#b394e8', works: true },
];

const TICKET_FORMAT = `When you are done, end your final message with the tickets as a fenced JSON block exactly like:
\`\`\`tickets
[{"title":"short imperative title","plain":"one sentence in everyday words for someone who has not read the code: what goes wrong or gets better, and who notices","summary":"one or two sentences: what and why","details":"specifics: files, steps, sources/links, suggested fix","priority":"high|medium|low"}]
\`\`\`
File only tickets worth a human's time. Do NOT change any files.`;

export function roomBrief(roomId, { agent, project, approved = [], minutes = 0, target = 0 }) {
  const budget = [
    minutes ? `You have about ${minutes} minute(s). Pace yourself and finish with your report before time runs out.` : '',
    target && roomId !== 'development' && roomId !== 'docs' ? `Aim for about ${target} ticket(s).` : '',
    target && roomId === 'development' ? `Implement at most ${target} ticket(s) this session.` : '',
  ].filter(Boolean).join(' ');
  const who = `You are "${agent.name}", an agent in Skadi Mission Control.${agent.description ? ` Your role: ${agent.description}` : ''}${budget ? `
Budget: ${budget}` : ''}`;
  const where = `Project: ${project.name} (${project.path}).`;
  switch (roomId) {
    case 'research':
      return `${who}\n${where}\n\nYou are in the RESEARCH LAB. Inspect the project to understand what it is, then search the web for ideas, techniques, comparable projects and user expectations that would make it better (features, UX, performance, polish). Cite sources.\n\n${TICKET_FORMAT}`;
    case 'quality':
      return `${who}\n${where}\n\nYou are in QUALITY. Read the code carefully and find real bugs: crashes, logic errors, edge cases, broken states, security issues. Run existing tests or the project if that is safe. For each bug give a reproduction and a proposed fix.\n\n${TICKET_FORMAT}`;
    case 'review':
      return `${who}\n${where}\n\nYou are in CODE REVIEW. Look at recent changes (git status, git log -5, git diff) and review them for correctness, risk and maintainability.\n\n${TICKET_FORMAT}`;
    case 'docs':
      return `${who}\n${where}\n\nYou are in the DOCS STUDIO. Compare the README and docs with what the code actually does, then update the docs so they are accurate and useful. Do not change program code.`;
    case 'development': {
      if (!approved.length) return `${who}\n${where}\n\nYou are in DEVELOPMENT but there are no approved tickets for this project. Say so briefly and stop.`;
      const list = approved.map((t, i) => `${i + 1}. [${t.id}] ${t.title} (${t.priority})\n   ${t.summary}\n   ${t.details || ''}`).join('\n');
      return `${who}\n${where}\n\nYou are in DEVELOPMENT. Implement these approved tickets, most important first. Keep changes focused and verify each one (build/test/run).\n\nAs soon as you finish with a ticket, call report_ticket with its id: fixed=true only once you have verified the fix, with a note on what you changed and how you checked it; fixed=false if you could not fix it, with a note on why and what is blocking it. The user reviews every result, so be honest. End with a short report.\n\n${list}`;
    }
    default:
      return null;
  }
}

/** Tickets from the fenced ```tickets block (or the last JSON array) of a report. */
export function parseTickets(text) {
  const src = String(text || '');
  const fenced = [...src.matchAll(/```(?:tickets|json)?\s*(\[[\s\S]*?\])\s*```/g)].pop()?.[1];
  const raw = fenced ?? src.match(/\[\s*\{[\s\S]*\}\s*\]/)?.[0];
  if (!raw) return [];
  let rows;
  try { rows = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  return rows
    .filter((r) => r && typeof r === 'object' && clip(r.title, 200))
    .slice(0, 12)
    .map((r) => ({
      title: clip(r.title, 200),
      plain: clip(r.plain, 400),
      summary: clip(r.summary, 1000),
      details: clip(r.details, 4000),
      priority: ['high', 'medium', 'low'].includes(String(r.priority).toLowerCase()) ? String(r.priority).toLowerCase() : 'medium',
    }));
}

// Tunic colours for new agents; the UI offers the same swatches.
const COLORS = ['#d9534f', '#e8883a', '#e8b23a', '#5cb85c', '#2fb3a3', '#4a90d9', '#9b6bd6', '#e07aa8'];
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class MissionStore {
  constructor(file) {
    this.file = file;
    this.data = { agents: [], tickets: [] };
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.data.agents = Array.isArray(saved.agents) ? saved.agents : [];
      this.data.tickets = Array.isArray(saved.tickets) ? saved.tickets : [];
    } catch { /* first run */ }
    // A run cannot survive a restart; say so instead of showing it working.
    for (const a of this.data.agents) {
      if (a.status === 'working') a.note = 'Interrupted by restart';
      // Nobody is working after a start: everyone waits in the break room.
      if (a.room !== 'break') { a.lastRoom = a.room; a.room = 'break'; }
      if (a.status === 'working') a.status = 'idle';
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  view() { return { rooms: ROOMS, ...this.data }; }
  agent(id) { return this.data.agents.find((a) => a.id === id) || null; }

  upsertAgent(input) {
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) throw new Error('agent name is required');
    let a = input.id ? this.agent(input.id) : null;
    if (!a) {
      a = { id: uid('agent'), room: 'break', status: 'idle', color: COLORS[this.data.agents.length % COLORS.length], createdAt: Date.now() };
      this.data.agents.push(a);
    }
    Object.assign(a, {
      name,
      description: String(input.description || '').trim().slice(0, 500),
      provider: input.provider || null,
      model: input.model || null,
      ...(input.color ? { color: String(input.color).slice(0, 20) } : {}),
      ...(input.beard !== undefined ? { beard: input.beard ? String(input.beard).slice(0, 20) : null } : {}),
    });
    this.save();
    return a;
  }

  removeAgent(id) {
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    this.save();
  }

  patchAgent(id, patch) {
    const a = this.agent(id);
    if (!a) throw new Error('unknown agent');
    Object.assign(a, patch);
    this.save();
    return a;
  }

  addTickets(rows, { agent, projectId, room, sessionId }) {
    const kind = ROOMS.find((r) => r.id === room)?.tickets || 'idea';
    const made = rows.map((r) => ({ id: uid('T'), ...r, kind, room, projectId, agentId: agent.id, agentName: agent.name, sessionId, status: 'pending', createdAt: Date.now() }));
    this.data.tickets.push(...made);
    this.save();
    return made;
  }

  /**
   * Record how a Development run went on one ticket. A claimed fix (or an
   * unclear result) waits in "check" for the user to confirm; anything else
   * leaves the ticket approved, with the reason on record. A second report
   * from the same run replaces the first.
   */
  recordAttempt(id, { outcome, note, agent, sessionId }) {
    const t = this.data.tickets.find((x) => x.id === id);
    if (!t) return null;
    const row = { at: Date.now(), outcome, note: String(note || '').trim().slice(0, 1500), agentId: agent?.id, agentName: agent?.name, sessionId };
    const attempts = t.attempts || [];
    if (sessionId && attempts.at(-1)?.sessionId === sessionId) attempts.pop();
    t.attempts = [...attempts, row];
    if (['approved', 'check'].includes(t.status)) t.status = ['fixed', 'unclear'].includes(outcome) ? 'check' : 'approved';
    t.updatedAt = Date.now();
    this.save();
    return t;
  }

  setTicket(id, status) {
    const t = this.data.tickets.find((x) => x.id === id);
    if (!t) throw new Error('unknown ticket');
    if (status === 'delete') this.data.tickets = this.data.tickets.filter((x) => x !== t);
    else if (['pending', 'approved', 'check', 'rejected', 'done'].includes(status)) {
      // Leaving "check" is the user's verdict on the last attempt.
      const last = t.attempts?.at(-1);
      if (t.status === 'check' && last) last.verdict = status === 'done' ? 'accepted' : 'rejected';
      t.status = status;
    } else throw new Error('bad ticket status');
    t.updatedAt = Date.now();
    this.save();
    return t;
  }

  approvedFor(projectId) {
    return this.data.tickets.filter((t) => t.projectId === projectId && t.status === 'approved');
  }
}
