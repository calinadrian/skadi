// Mission Control: a dwarven hall where named agents ("dwarves") are sent to
// rooms. A working room starts an ordinary chat on the chosen project;
// Research, Quality and Code Review file tickets for the user to approve,
// and Development implements the approved ones.

const $ = (id) => document.getElementById(id);
const bridge = () => window.skadiBridge || {};
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const api = async (path, body) => {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const say = (msg) => (bridge().toast ? bridge().toast(msg) : alert(msg));
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* private window */ } return null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const m = {
  data: null,
  project: store('mission.project') || '',
  ticketFilter: 'pending',
  ticketProject: '',
  pos: new Map(), // agent id -> where it stands in its room
  open: new Set(), // ticket ids whose details are expanded
  dragging: false,
  stale: false, // an update arrived mid-drag; render when it ends
};

// ------------------------------------------------------------- the rooms

// How each room looks and reads. Names and behaviour come from the server;
// this is only the dwarven dressing and the plain-words explanation.
const HALLS = {
  break: { hall: 'the Tavern', short: 'Resting. Nothing runs here.', verb: 'Resting', tool: 'mug' },
  research: {
    hall: 'the Library', short: 'Reads the web for ideas and files them as tickets.', verb: 'Researching', tool: 'book', target: 'Ideas to find',
    explain: (n) => `${n} studies the project, searches the web for ideas and files each one as a ticket for you to approve. No files are changed.`,
  },
  quality: {
    hall: 'the Mines', short: 'Digs through the code for bugs and files them as tickets.', verb: 'Hunting bugs', tool: 'pick', target: 'Bugs to find',
    explain: (n) => `${n} digs through the code for real bugs and files each one with a repro and a fix. No files are changed.`,
  },
  development: {
    hall: 'the Forge', short: 'Builds the tickets you approved.', verb: 'Building', tool: 'hammer', target: 'Tickets to build',
    explain: (n, k) => `${n} implements ${k} approved ticket${k === 1 ? '' : 's'}, verifies the work and marks finished ones done. This changes files.`,
  },
  review: {
    hall: 'the Assay Bench', short: 'Checks recent changes and files tickets for risky code.', verb: 'Reviewing', tool: 'lens', target: 'Findings to file',
    explain: (n) => `${n} inspects recent changes (git status, log and diff) and files tickets for anything risky. No files are changed.`,
  },
  docs: {
    hall: 'the Scriptorium', short: 'Brings the README and docs in line with the code.', verb: 'Writing docs', tool: 'quill',
    explain: (n) => `${n} compares the docs with the code and rewrites what is out of date. This changes documentation files.`,
  },
};

const QUIPS = {
  break: ['Another round!', 'My beard has a beard', 'Who took my mug?', 'Is it Friday yet?', 'Resting my eyes…', 'I am not short, I am compact', 'Stone soup again?', 'One more song!', 'Zzz…', 'Ale counts as bread', 'Mind my beard', 'Best. Break. Ever.'],
  research: ['Hmm, an old tome…', 'Page 404 not found', 'Citation needed', 'Big if true', 'This scroll is 90% ads', 'Aha!', 'Taking notes', 'Ooh, shiny idea'],
  quality: ['Something glitters…', 'Dig, dig, dig', 'A bug in the rock!', 'Off by one, again', 'Who carved this?', 'It works on my anvil', 'That is not a feature', 'Reproducing…'],
  development: ['Clang! Clang!', 'Hot off the anvil', 'Just one more fix', 'Tests pass!', 'Forged it!', 'Mind the sparks', 'Who needs gloves?', 'Measure twice…'],
  review: ['A crack here…', 'Needs a test', 'Nit: naming', 'Weighing the diff', 'LGTM… mostly', 'Hmm. Hmmm.', 'Why a global?', 'Solid work'],
  docs: ['Carving runes', 'Fixing a typo', 'Adding an example', 'Neat handwriting', 'Runes never lie', 'TODO: fewer TODOs'],
  error: ['Help!', 'Something broke…', 'My pick is stuck!', 'Could use a hand'],
  idle: ['Ready for work!', 'Point me at a bug', 'Hammer at the ready', 'Where to next?'],
};
// Two dwarves resting together sometimes have a little exchange.
const DUETS = [
  ['Cheers!', 'Cheers!'],
  ['Heard the one about the bug?', '…it crawled away'],
  ['Nice beard', 'I braid it daily'],
  ['Back to work?', 'After this mug'],
  ['Who fixed the build?', 'Not me!'],
  ['Tabs or spaces?', 'Do not start…'],
];
// Places a resting dwarf likes to wander to (percent: x, feet y).
const SPOTS = { break: [[20, 74], [36, 72], [48, 76], [62, 74], [80, 74], [72, 84]] };

// Where a working dwarf stands (percent of the art: x, feet y, face left).
const STATIONS = {
  development: [[42, 72], [70, 78, 1], [22, 84]],
  quality: [[44, 78], [24, 84], [66, 86, 1]],
  research: [[50, 72], [30, 82], [72, 82, 1]],
  review: [[68, 72], [48, 82], [86, 84, 1]],
  docs: [[54, 72], [34, 82], [76, 84, 1]],
};

const projectName = (id) => m.data?.projects.find((p) => p.id === id)?.name || '—';
const roomOf = (id) => m.data?.rooms.find((r) => r.id === id);
const hallOf = (id) => HALLS[id] || {};
const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const left = (t) => {
  const s = Math.max(0, Math.round((t - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const approvedFor = (projectId) => m.data.tickets.filter((t) => t.status === 'approved' && t.projectId === projectId);

/** One line on what a dwarf is up to. */
function activity(a) {
  if (a.status === 'working') return `${hallOf(a.room).verb || 'Working'} · ${projectName(a.projectId)}`;
  if (a.status === 'error') return `Ran into trouble in ${hallOf(a.lastRoom).hall || 'a room'}`;
  if (a.finishedAt) return `Back from ${hallOf(a.lastRoom).hall || 'work'} · ${ago(a.finishedAt)}`;
  return a.room === 'break' ? 'In the tavern, ready for work' : 'Waiting';
}

// ------------------------------------------------------------------ colour

const safeColor = (c, d = '#e8b23a') => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d);
const rgb = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => `#${rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
const hash = (s) => [...String(s)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);

const TUNICS = ['#d9534f', '#e8883a', '#e8b23a', '#5cb85c', '#2fb3a3', '#4a90d9', '#9b6bd6', '#e07aa8'];
const BEARDS = ['#c8642e', '#8a5a34', '#e3c07a', '#ebe6de', '#4a3a33', '#a8a39c'];
const beardOf = (a) => safeColor(a.beard, BEARDS[hash(a.name) % BEARDS.length]);

// ----------------------------------------------------------------- sprites

const SVGNS = 'http://www.w3.org/2000/svg';
const R = (x, y, w, hh, fill, cls) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${fill}"${cls ? ` class="${cls}"` : ''}/>`;
function svgEl(viewBox, cls, inner) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = inner;
  return s;
}
const ICONS = {
  edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
  chat: '<path d="M2.5 3h11v7.5h-6L4.5 13v-2.5h-2z"/>',
  trash: '<path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9"/>',
  desk: '<path d="M2 2.5h12v8.5H2zM6 14h4M8 11v3"/>',
};
function iconBtn(name, label, fn, cls = '') {
  const b = h('button', `mc-icon-btn ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  const svg = svgEl('0 0 16 16', 'mc-icon', ICONS[name]);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linejoin', 'round');
  b.append(svg);
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}

/** Pixel rows to rects, one rect per run of equal pixels. */
function paint(rows, pal, y0 = 0) {
  let s = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      let w = 1;
      while (row[x + w] === c) w++;
      if (pal[c]) s += R(x, y + y0, w, 1, pal[c]);
      x += w;
    }
  });
  return s;
}

// 16x16 dwarf: steel helmet with a band in their colour, big beard, tunic.
// E = eyes (drawn on their own so they can blink).
const DWARF = [
  '.....HHHHHH.....',
  '...HHhhHHHHHH...',
  '..HhhHHHHHHHHH..',
  '..MmMMMMMMMMmM..',
  '..SSSSSSSSSSSS..',
  '..SSESSSSSSESS..',
  '..SRESSNNSSERS..',
  '.BBSSSNNNNSSSBB.',
  '.BBBBBBBBBBBBBB.',
  'TBBBBBbOObBBBBBT',
  'TTBBBBBBBBBBBBTT',
  'TTTBBBBBBBBBBTTT',
  'KTTTBBBBBBBBTTTK',
  '.LLLLBBBBBBLLLL.',
  '.tTTTTBBBBTTTTt.',
  '.ttTTTTbbTTTTtt.',
];
// A dwarf girl: a flower on the helmet, braids (B) with ties in her colour
// (m), a smile, and a tunic that flares into a skirt.
const DWARF_GIRL = [
  '.....HHHHHH.....',
  '...HHhhHHHHFfF..',
  '..HhhHHHHHHHFH..',
  '..MmMMMMMMMMmM..',
  '.BBSSSSSSSSSSBB.',
  '.BSSESSSSSSESSB.',
  '.BSRESSNNSSERSB.',
  '.BSSSSSPPSSSSSB.',
  '.BBSSSSSSSSSSBB.',
  '.BBTTTTTTTTTTBB.',
  'TBbTTTTTTTTTTbBT',
  'TmTTTTTTTTTTTTmT',
  'KBTTTTTTTTTTTTBK',
  '.LLLLLLGGLLLLLL.',
  '.tTTTTTTTTTTTTt.',
  'ttTTTTTTTTTTTTtt',
];
const LEGS = {
  stand: ['..DDDD....DDDD..', '.DDDDD....DDDDD.'],
  a: ['..DDDD....DDDD..', '.DDDDD..........'],
  b: ['..DDDD....DDDD..', '..........DDDDD.'],
};
const SKIN = { S: '#f6caa4', R: '#f29a8c', N: '#e59b78', E: '#2b1d15', H: '#b9c3cc', h: '#eef3f6', K: '#f6caa4', D: '#4b3426', L: '#5e3d26', O: '#a8574a', G: '#f2c94c', P: '#e07b6e', F: '#ff8fb1', f: '#ffe27a' };

// What a dwarf holds, in the sprite's own units; the right hand is at 15,12.
const TOOLS = {
  hammer: `<g class="mc-tool mc-swing">${R(15, 5, 1, 8, '#8a5a36')}${R(12, 2, 7, 3, '#9aa3ad')}${R(12, 2, 7, 1, '#e3e8ec')}</g>`,
  pick: `<g class="mc-tool mc-swing slow">${R(15, 4, 1, 9, '#8a5a36')}${R(11, 3, 10, 2, '#9aa3ad')}${R(10, 4, 2, 1, '#9aa3ad')}${R(20, 4, 2, 1, '#9aa3ad')}${R(12, 3, 8, 1, '#e3e8ec')}</g>`,
  book: `<g class="mc-tool">${R(3, 10, 10, 4, '#7a3b2e')}${R(4, 10, 4, 3, '#f7eedb')}${R(8, 10, 4, 3, '#efe2c4')}${R(8, 10, 1, 3, '#b89a68')}${R(5, 11, 2, 1, '#b8a888')}<rect class="mc-page" x="9" y="11" width="2" height="1" fill="#b8a888"/></g>`,
  lens: `<g class="mc-tool mc-peer">${R(15, 11, 1, 3, '#6a4630')}${R(14, 6, 4, 1, '#d6a93f')}${R(13, 7, 1, 3, '#d6a93f')}${R(18, 7, 1, 3, '#d6a93f')}${R(14, 10, 4, 1, '#d6a93f')}${R(14, 7, 4, 3, '#bfe6f2')}${R(15, 7, 1, 1, '#ffffff')}</g>`,
  quill: `<g class="mc-tool mc-scribble">${R(15, 9, 1, 4, '#d9d2c4')}${R(16, 6, 1, 4, '#ffffff')}${R(17, 4, 1, 3, '#ffffff')}${R(15, 7, 1, 2, '#f0ebe0')}</g>`,
  mug: `<g class="mc-tool mc-sip">${R(14, 10, 4, 4, '#c98d4a')}${R(18, 11, 1, 2, '#c98d4a')}${R(14, 9, 4, 1, '#fff6de')}${R(15, 10, 1, 4, '#a8733a')}</g>`,
};

function dwarfPal(a) {
  const tunic = safeColor(a.color);
  const beard = beardOf(a);
  return { ...SKIN, M: tunic, m: mix(tunic, '#ffffff', 0.5), T: tunic, t: mix(tunic, '#000000', 0.3), B: beard, b: mix(beard, '#000000', 0.25) };
}

function sprite(a, { tool = null, portrait = false } = {}) {
  const pal = dwarfPal(a);
  const rows = a.look === 'girl' ? DWARF_GIRL : DWARF;
  const body = `<g class="mc-body">${paint(rows, { ...pal, E: pal.S })}<g class="mc-eyes">${paint(rows, { E: pal.E })}</g></g>`;
  const legs = portrait
    ? paint(LEGS.stand, pal, 16)
    : `<g class="mc-legs-stand">${paint(LEGS.stand, pal, 16)}</g><g class="mc-legs-a">${paint(LEGS.a, pal, 16)}</g><g class="mc-legs-b">${paint(LEGS.b, pal, 16)}</g>`;
  const shadow = portrait ? '' : `<ellipse cx="8" cy="18" rx="7" ry="1.4" fill="rgba(0,0,0,.35)"/>`;
  return svgEl(portrait ? '-1 -1 18 20' : '-5 -7 26 26', `mc-sprite${portrait ? ' portrait' : ''}`, shadow + legs + body + (TOOLS[tool] || ''));
}

// -------------------------------------------------------------- room art
// Each room is drawn on a 160x90 grid: stone wall above y=52, planks below.

const glow = (x, y, r, id, fire) => `<circle class="mc-glow" cx="${x}" cy="${y}" r="${r}" fill="url(#mc-${fire ? 'fire' : 'lamp'}-${id})"/>`;
const lantern = (x, y, id, chain = 6) => `${glow(x + 2.5, y + 4, 28, id)}${R(x + 2, y - chain, 1, chain, '#6f6873')}${R(x, y, 5, 1, '#2f272c')}${R(x, y + 1, 5, 6, '#3a3036')}${R(x + 1, y + 2, 3, 4, '#ffd98a', 'mc-flicker')}${R(x, y + 7, 5, 1, '#2f272c')}`;
const candle = (x, y, id) => `${glow(x + 1, y - 1, 20, id)}${R(x, y, 2, 5, '#f2eadb')}${R(x - 1, y + 5, 4, 1, '#c9a043')}<g class="mc-flicker">${R(x, y - 2, 2, 2, '#ffc94d')}${R(x, y - 3, 1, 1, '#fff1b8')}</g>`;
const fire = (x, y, w) => `<g class="mc-fire">${R(x, y + 4, w, 7, '#e0572a')}${R(x + 2, y + 1, w - 4, 4, '#f08a32')}${R(x + w / 2 - 2, y - 2, 4, 4, '#f08a32')}${R(x + 3, y + 5, w - 6, 6, '#ffcc5c')}${R(x + w / 2 - 1, y + 2, 2, 4, '#fff1b8')}</g>`;
const mug = (x, y) => `${R(x, y + 1, 4, 5, '#c98d4a')}${R(x + 4, y + 2, 1, 3, '#c98d4a')}${R(x, y, 4, 2, '#fff4d6')}`;
const barrel = (x, y) => `${R(x + 1, y, 14, 17, '#8a5a36')}${R(x, y + 2, 16, 13, '#8a5a36')}${R(x + 4, y, 1, 17, '#74492b')}${R(x + 10, y, 1, 17, '#74492b')}${R(x, y + 3, 16, 1, '#5d5550')}${R(x, y + 13, 16, 1, '#5d5550')}${R(x + 6, y + 7, 4, 3, '#3a2618')}${R(x + 7, y + 8, 2, 1, '#c9a36b')}`;
const gem = (x, y, c, delay) => `${R(x, y, 3, 3, c)}${R(x + 1, y - 1, 1, 5, c)}${R(x - 1, y + 1, 5, 1, c)}<rect class="mc-glint" x="${x + 1}" y="${y}" width="1" height="1" fill="#fff" style="animation-delay:${delay}s"/>`;

function shell(c, id, { rock = false } = {}) {
  const wall = mix('#4b4350', c, 0.1);
  const mortar = mix('#2c2630', c, 0.06);
  const hi = mix('#5f5765', c, 0.1);
  let wallArt = R(0, 0, 160, 52, `url(#mc-brick-${id})`);
  if (rock) {
    wallArt = R(0, 0, 160, 52, '#2e2927');
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(rnd() * 160) - 6, y = 3 + Math.floor(rnd() * 44), w = 8 + Math.floor(rnd() * 14), hh = 4 + Math.floor(rnd() * 6);
      wallArt += R(x, y, w, hh, i % 3 ? '#3b3532' : '#443d39') + R(x, y, w, 1, '#544b46');
    }
  }
  return `<defs>
    <pattern id="mc-brick-${id}" width="14" height="12" patternUnits="userSpaceOnUse">${R(0, 0, 14, 12, mortar)}${R(0, 0, 13, 5, wall)}${R(0, 0, 13, 1, hi)}${R(-7, 6, 13, 5, wall)}${R(7, 6, 13, 5, wall)}${R(-7, 6, 13, 1, hi)}${R(7, 6, 13, 1, hi)}</pattern>
    <pattern id="mc-plank-${id}" width="40" height="14" patternUnits="userSpaceOnUse">${R(0, 0, 40, 14, '#6b4a32')}${R(0, 7, 40, 7, '#634430')}${R(0, 6, 40, 1, '#4a3222')}${R(0, 13, 40, 1, '#4a3222')}${R(12, 0, 1, 6, '#4a3222')}${R(31, 7, 1, 6, '#4a3222')}</pattern>
    <radialGradient id="mc-lamp-${id}"><stop offset="0" stop-color="#ffd48a" stop-opacity=".45"/><stop offset="1" stop-color="#ffd48a" stop-opacity="0"/></radialGradient>
    <radialGradient id="mc-fire-${id}"><stop offset="0" stop-color="#ff9a4a" stop-opacity=".55"/><stop offset="1" stop-color="#ff9a4a" stop-opacity="0"/></radialGradient>
  </defs>${wallArt}${R(0, 52, 160, 38, `url(#mc-plank-${id})`)}${R(0, 53, 160, 2, 'rgba(0,0,0,.25)')}${R(0, 50, 160, 3, '#3e2a1c')}${R(0, 50, 160, 1, '#5a3d28')}${R(0, 0, 160, 4, '#5a3d28')}${R(0, 3, 160, 1, '#3a2618')}`;
}

const BOOKS = ['#b5483f', '#3f6fb5', '#4f9a5a', '#c9a043', '#7a4fa0', '#c77a3a', '#3a8f8f', '#a8a39c'];
function shelf(x, y, w, hh) {
  let s = R(x, y, w, hh, '#5a3a22') + R(x + 2, y + 2, w - 4, hh - 4, '#24170f');
  for (let sy = y + 2, k = 0; sy + 11 <= y + hh - 1; sy += 11, k++) {
    s += R(x + 2, sy + 9, w - 4, 2, '#6a4630');
    for (let bx = x + 3, i = k * 3; ; i++) {
      const bw = [2, 3, 2, 2, 3, 1, 2][i % 7], bh = [8, 7, 9, 6, 8, 7, 9][(i * 3) % 7];
      if (bx + bw > x + w - 3) break;
      if (i % 9 !== 5) s += R(bx, sy + 9 - Math.min(bh, 9), bw, Math.min(bh, 9), BOOKS[(i * 5 + k) % BOOKS.length]);
      bx += bw + (i % 4 === 3 ? 1 : 0);
    }
  }
  return s;
}

const ART = {
  break: (c, id) => shell(c, id) + glow(31, 42, 38, id, true)
    + R(54, 60, 60, 20, mix(c, '#1a120c', 0.55)) + R(56, 62, 56, 16, mix(c, '#1a120c', 0.25)) + R(56, 66, 56, 2, mix(c, '#fff4d6', 0.3)) + R(56, 72, 56, 2, mix(c, '#fff4d6', 0.3))
    + R(12, 19, 38, 33, '#6d6570') + R(12, 19, 38, 1, '#857d88') + R(18, 29, 26, 23, '#1b1210') + R(20, 27, 22, 2, '#1b1210') + fire(20, 40, 22) + R(19, 49, 24, 3, '#5a3a22')
    + R(8, 16, 46, 4, '#6a4630') + R(8, 19, 46, 1, '#3f2a1b') + mug(14, 10) + mug(43, 10) + R(26, 13, 10, 3, '#d9d2c4')
    + R(79, 12, 14, 15, c) + R(77, 14, 18, 10, c) + R(81, 27, 10, 2, c) + R(84, 11, 4, 19, mix(c, '#ffffff', 0.35)) + R(84, 17, 4, 4, '#e8d9a8')
    + lantern(106, 10, id) + barrel(116, 35) + barrel(134, 35) + barrel(125, 18)
    + R(60, 44, 3, 8, '#5a3a22') + R(56, 42, 11, 3, '#7a5232') + mug(58, 37),
  research: (c, id) => shell(c, id) + shelf(4, 8, 38, 44) + shelf(118, 8, 38, 44)
    + R(52, 9, 54, 30, '#6a4630') + R(54, 11, 50, 26, '#ecdcb4') + R(54, 11, 50, 1, '#fff4d6')
    + R(60, 28, 10, 4, '#9c8a66') + R(62, 26, 6, 2, '#9c8a66') + R(64, 25, 2, 1, '#9c8a66') + R(72, 30, 12, 3, '#9c8a66') + R(74, 28, 8, 2, '#9c8a66') + R(77, 27, 2, 1, '#9c8a66')
    + R(88, 15, 10, 5, '#8fb8d0') + R(90, 14, 6, 1, '#8fb8d0') + [[60, 34], [63, 33], [66, 32], [70, 24], [74, 22], [78, 21], [82, 22], [86, 24], [90, 26]].map(([x, y]) => R(x, y, 1, 1, '#b0413e')).join('')
    + R(93, 25, 1, 1, '#b0413e') + R(95, 25, 1, 1, '#b0413e') + R(94, 26, 1, 1, '#b0413e') + R(93, 27, 1, 1, '#b0413e') + R(95, 27, 1, 1, '#b0413e')
    + R(58, 44, 44, 3, '#7a5232') + R(58, 47, 44, 1, '#5a3a22') + R(61, 47, 3, 5, '#5a3a22') + R(96, 47, 3, 5, '#5a3a22')
    + R(66, 40, 20, 4, '#f5ead0') + R(75, 40, 2, 4, '#b89a68') + R(66, 43, 20, 1, '#7a3b2e') + R(68, 41, 5, 1, '#b8a888') + R(79, 41, 5, 1, '#b8a888')
    + candle(92, 37, id) + R(46, 30, 4, 6, c) + R(45, 36, 6, 1, '#6a4630'),
  quality: (c, id) => shell(c, id, { rock: true })
    + gem(16, 14, c, 0) + gem(34, 32, '#7fd1e0', -0.8) + gem(112, 12, '#f2c94c', -1.6) + gem(140, 30, c, -2.2) + gem(48, 42, '#b98ae0', -0.4) + gem(128, 44, '#7fd1e0', -1.2) + gem(10, 40, '#f2c94c', -2.6)
    + R(24, 22, 5, 4, '#d9463f') + R(26, 22, 1, 4, '#2a1a14') + R(22, 23, 2, 2, '#2a1a14') + R(25, 24, 1, 1, '#2a1a14') + R(27, 23, 1, 1, '#2a1a14') + R(28, 25, 1, 1, '#2a1a14')
    + R(66, 15, 30, 37, '#0d0908') + R(68, 13, 26, 2, '#0d0908') + R(70, 20, 22, 32, '#080505')
    + R(61, 12, 5, 40, '#6a4630') + R(96, 12, 5, 40, '#6a4630') + R(62, 12, 1, 40, '#7e573a') + R(97, 12, 1, 40, '#7e573a') + R(58, 9, 46, 5, '#7a5232') + R(58, 13, 46, 1, '#4a3020')
    + lantern(78, 18, id, 4)
    + Array.from({ length: 18 }, (_, i) => R(i * 9 + 2, 66, 3, 11, '#4a3222')).join('') + R(0, 67, 160, 1, '#a3a9b1') + R(0, 68, 160, 1, '#5c6068') + R(0, 74, 160, 1, '#a3a9b1') + R(0, 75, 160, 1, '#5c6068')
    + R(114, 58, 32, 2, '#7c828b') + R(116, 60, 28, 8, '#5b6169') + R(116, 63, 28, 1, '#4a4f56') + R(119, 68, 5, 4, '#23232a') + R(136, 68, 5, 4, '#23232a')
    + R(118, 54, 8, 4, '#6d625a') + R(125, 53, 8, 5, '#5e5550') + R(133, 54, 8, 4, '#6d625a') + R(121, 53, 2, 2, c) + R(129, 52, 2, 2, '#7fd1e0') + R(136, 53, 2, 2, '#f2c94c')
    + Array.from({ length: 9 }, (_, i) => R(142 + i, 44 - i * 2, 1, 2, '#8a5a36')).join('') + R(144, 25, 12, 2, '#9aa3ad') + R(143, 27, 2, 1, '#9aa3ad') + R(155, 27, 2, 1, '#9aa3ad'),
  development: (c, id) => shell(c, id) + glow(30, 42, 46, id, true)
    + R(6, 8, 46, 44, '#5f5762') + R(6, 8, 46, 1, '#7a727d') + R(6, 20, 46, 1, '#4f4852') + R(6, 34, 8, 1, '#4f4852') + R(44, 34, 8, 1, '#4f4852') + R(18, 0, 20, 8, '#4f4852')
    + R(15, 26, 28, 26, '#170c08') + R(17, 24, 24, 2, '#170c08') + R(19, 22, 20, 2, '#170c08') + fire(17, 40, 24) + fire(22, 33, 14) + R(15, 50, 28, 2, '#3a1a10')
    + R(72, 54, 28, 4, '#4d525b') + R(72, 54, 28, 1, '#8a909a') + R(66, 55, 6, 2, '#4d525b') + R(64, 56, 2, 1, '#4d525b') + R(80, 58, 12, 5, '#3c4048') + R(76, 63, 20, 4, '#3c4048') + R(76, 63, 20, 1, '#555a63')
    + R(82, 52, 10, 2, '#ff9a4a', 'mc-hot')
    + `<g class="mc-sparks">${R(86, 47, 1, 1, '#ffd166')}${R(90, 44, 1, 1, '#ffe39a')}${R(80, 45, 1, 1, '#ffd166')}${R(94, 49, 1, 1, '#ffb347')}${R(84, 42, 1, 1, '#fff1b8')}</g>`
    + R(106, 14, 48, 3, '#6a4630') + R(112, 17, 2, 14, '#8a5a36') + R(109, 28, 8, 4, '#8e959f') + R(124, 17, 1, 16, '#7a808a') + R(127, 17, 1, 16, '#7a808a') + R(125, 31, 2, 2, '#7a808a')
    + R(136, 17, 2, 12, '#8a5a36') + R(133, 26, 8, 3, '#8e959f') + R(147, 17, 2, 14, '#a0a6ae') + R(146, 17, 4, 2, '#6a4630')
    + R(126, 40, 22, 12, '#6a4630') + R(126, 43, 22, 1, '#4a3020') + R(126, 48, 22, 1, '#4a3020') + R(127, 40, 20, 2, '#5aa7d6') + R(56, 36, 10, 2, c) + R(58, 30, 6, 6, mix(c, '#ffffff', 0.3)),
  review: (c, id) => shell(c, id) + lantern(68, 10, id)
    + R(12, 10, 40, 32, '#6a4630') + R(14, 12, 36, 28, '#ecdcb4')
    + [0, 1, 2, 3].map((i) => R(17, 15 + i * 6, 4, 4, i === 2 ? '#d9534f' : '#4caf7a') + R(24, 16 + i * 6, [20, 16, 22, 12][i], 2, '#9c8a66')).join('')
    + R(98, 18, 56, 2, '#6a4630') + R(102, 14, 9, 4, '#f2c94c') + R(102, 14, 9, 1, '#fff0a8') + R(113, 14, 9, 4, '#c3cad2') + R(124, 14, 9, 4, '#d98a5a') + R(135, 14, 9, 4, c) + R(146, 14, 6, 4, '#7fd1e0')
    + R(88, 42, 66, 3, '#7a5232') + R(88, 45, 66, 1, '#5a3a22') + R(91, 45, 3, 7, '#5a3a22') + R(149, 45, 3, 7, '#5a3a22')
    + R(110, 27, 2, 15, '#c9a043') + R(100, 27, 22, 1, '#c9a043') + R(101, 28, 1, 4, '#8a6d2a') + R(120, 28, 1, 3, '#8a6d2a') + R(98, 32, 7, 2, '#c9a043') + R(117, 31, 7, 2, '#c9a043') + R(106, 40, 10, 2, '#c9a043') + R(100, 30, 3, 2, c)
    + R(132, 36, 5, 1, '#c9a043') + R(131, 37, 1, 3, '#c9a043') + R(137, 37, 1, 3, '#c9a043') + R(132, 40, 5, 1, '#c9a043') + R(132, 37, 5, 3, '#bfe6f2') + R(138, 40, 4, 1, '#6a4630')
    + R(141, 38, 10, 4, '#f5ead0') + R(142, 39, 7, 1, '#b8a888'),
  docs: (c, id) => shell(c, id)
    + R(12, 12, 30, 38, '#6d6570') + R(14, 10, 26, 2, '#6d6570') + R(12, 12, 30, 1, '#857d88')
    + `<g class="mc-rune">${[[17, 16], [27, 16], [17, 30], [27, 30]].map(([x, y], i) => R(x + 2, y, 1, 10, c) + R(x + 3, y + [1, 4, 2, 6][i], 3, 1, c) + R(x + (i % 2 ? 3 : 0), y + [5, 2, 7, 3][i], 2, 1, c)).join('')}</g>`
    + R(52, 4, 10, 22, c) + R(52, 26, 4, 2, c) + R(58, 26, 4, 2, c) + R(54, 10, 6, 6, mix(c, '#ffffff', 0.4))
    + R(112, 8, 42, 44, '#5a3a22') + R(114, 10, 38, 40, '#24170f')
    + Array.from({ length: 25 }, (_, i) => ((i * 7) % 11 === 3 ? '' : R(116 + (i % 5) * 7, 12 + Math.floor(i / 5) * 8, 6, 6, '#ecdcb4') + R(118 + (i % 5) * 7, 14 + Math.floor(i / 5) * 8, 2, 2, '#b89a68'))).join('')
    + R(64, 42, 40, 3, '#7a5232') + R(64, 45, 40, 1, '#5a3a22') + R(67, 45, 3, 7, '#5a3a22') + R(98, 45, 3, 7, '#5a3a22')
    + R(72, 38, 22, 4, '#f5ead0') + R(74, 39, 16, 1, '#b8a888') + R(74, 41, 11, 1, '#b8a888') + R(95, 39, 4, 3, '#2a2230') + R(97, 32, 1, 7, '#d9d2c4') + R(98, 30, 1, 4, '#ffffff')
    + candle(67, 37, id),
};

// ------------------------------------------------------------------- render

function render() {
  syncPets();
  const root = $('missionView');
  if (!root || root.hidden || !m.data) return;
  // Rebuilding mid-drag would drop the dwarf being carried.
  if (m.dragging) { m.stale = true; return; }
  const { projects } = m.data;
  if (!projects.some((p) => p.id === m.project)) m.project = projects[0]?.id || '';
  root.classList.add('mc-theme');
  const scroll = root.scrollTop;
  const hire = h('button', 'btn tiny', '+ Hire a dwarf');
  hire.onclick = () => editAgent(null);
  // Crew and tickets share a row on wide screens, so both are in view.
  const desk = h('div', 'mc-desk');
  desk.append(section('Crew', crew(), hire), ticketsPanel());
  root.replaceChildren(
    header(),
    section('Rooms', office(), h('span', 'mc-dim', 'Drag a dwarf onto a room, or use Give work on their card.')),
    desk,
  );
  root.scrollTop = scroll;
}

function section(title, content, aside) {
  const box = h('section', 'mc-section');
  const head = h('div', 'mc-section-head');
  head.append(h('h3', 'mc-section-title', title));
  if (aside) head.append(aside);
  box.append(head, content);
  return box;
}

function header() {
  const { agents, tickets, projects } = m.data;
  const head = h('header', 'mc-head');
  const brand = h('div', 'mc-brand');
  const logo = h('div', 'mc-logo');
  logo.append(sprite({ name: 'Skadi', color: '#e8b23a', beard: '#c8642e' }, { portrait: true }));
  const words = h('div');
  words.append(h('h2', 'mc-title', 'Mission Control'), h('p', 'mc-sub', 'Your dwarves research, hunt bugs, build and review — you approve what gets built.'));
  brand.append(logo, words);

  const controls = h('div', 'mc-controls');
  const sel = h('select', 'mc-input');
  sel.setAttribute('aria-label', 'Project');
  if (!projects.length) sel.append(new Option('No projects yet — add one in the chat', ''));
  for (const p of projects) sel.append(new Option(p.name, p.id, false, p.id === m.project));
  sel.onchange = () => { m.project = sel.value; store('mission.project', m.project); render(); };
  const label = h('label', 'mc-project');
  label.append(h('span', null, 'Project'), sel);
  const back = h('button', 'btn', 'Back to chat');
  back.onclick = hide;
  controls.append(label, back);

  const stats = h('div', 'mc-stats');
  const working = agents.filter((a) => a.status === 'working').length;
  const pending = tickets.filter((t) => t.status === 'pending').length;
  const approved = tickets.filter((t) => t.status === 'approved').length;
  const check = tickets.filter((t) => t.status === 'check').length;
  const chip = (text, cls, onclick) => {
    const c = h(onclick ? 'button' : 'span', `mc-stat ${cls || ''}`, text);
    if (onclick) { c.type = 'button'; c.onclick = onclick; }
    stats.append(c);
  };
  const toTickets = (f) => () => { m.ticketFilter = f; render(); $('mcTickets')?.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'start' }); };
  chip(plural(agents.length, 'dwarf', 'dwarves'));
  chip(`${working} at work`, working ? 'live' : '');
  chip(pending ? `${plural(pending, 'ticket')} waiting for you` : 'Nothing to review', pending ? 'alert' : '', pending ? toTickets('pending') : null);
  if (check) chip(`${check} ${check === 1 ? 'fix' : 'fixes'} to check`, 'alert', toTickets('check'));
  chip(`${approved} approved`, '', approved ? toTickets('approved') : null);

  const wrap = h('div', 'mc-top');
  head.append(brand, controls);
  wrap.append(head, stats);
  return wrap;
}

function office() {
  const grid = h('div', 'mc-office');
  for (const room of m.data.rooms) grid.append(roomCard(room));
  return grid;
}

function roomCard(room) {
  const { agents } = m.data;
  const look = hallOf(room.id);
  const here = agents.filter((a) => a.room === room.id);
  const working = here.filter((a) => a.status === 'working');
  const box = h('section', `mc-room mc-room-${room.id}`);
  box.style.setProperty('--room', safeColor(room.color));
  box.dataset.room = room.id;
  box.classList.toggle('busy', working.length > 0);
  box.classList.toggle('lit', working.length > 0 || room.id === 'break');

  const stage = h('div', 'mc-stage');
  stage.append(svgEl('0 0 160 90', 'mc-art', (ART[room.id] || shell)(safeColor(room.color), room.id)));
  stage.append(h('div', 'mc-drop', room.works ? `Drop to start ${(look.verb || 'work').toLowerCase()}` : 'Drop to rest'));
  here.forEach((a, i) => stage.append(dwarfNode(a, i, working.indexOf(a))));
  if (room.id === 'break' && !agents.length) {
    const b = h('button', 'btn primary mc-hire', '+ Hire your first dwarf');
    b.onclick = () => editAgent(null);
    stage.append(b);
  }

  const foot = h('div', 'mc-foot');
  const line = h('div', 'mc-foot-line');
  const title = h('div', 'mc-foot-title');
  title.append(h('span', 'mc-room-name', room.name), h('span', 'mc-room-hall', look.hall || ''));
  line.append(title);
  let badge = '';
  if (working.length) badge = `${working.length} at work`;
  else if (room.id === 'break' && here.length) badge = `${here.length} resting`;
  if (badge) line.append(h('span', `mc-badge${working.length ? ' live' : ''}`, badge));
  let blurb = look.short || room.blurb;
  if (room.id === 'development' && m.project) {
    const n = approvedFor(m.project).length;
    blurb = n ? `Builds approved tickets · ${n} ready in ${projectName(m.project)}.` : `Builds approved tickets · none approved in ${projectName(m.project)} yet.`;
  }
  foot.append(line, h('div', 'mc-room-blurb', blurb));
  box.title = room.blurb;
  box.append(stage, foot);

  box.ondragover = (e) => { if (!m.dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; box.classList.add('drop'); };
  box.ondragleave = (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop'); };
  box.ondrop = (e) => {
    e.preventDefault();
    box.classList.remove('drop');
    dropped(e.dataTransfer.getData('text/agent'), room);
  };
  return box;
}

function dwarfNode(a, i, wi) {
  const working = a.status === 'working';
  const look = hallOf(a.room);
  const tool = working ? look.tool : a.room === 'break' && i % 2 === 0 ? 'mug' : null;
  const node = h('div', `mc-dwarf${working ? ' working' : ''}${a.status === 'error' ? ' error' : ''}`);
  node.dataset.id = a.id;
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${a.name}: ${activity(a)}`);
  node.title = `${a.name} — ${activity(a)}\n${working ? 'Click for details' : 'Drag to a room, or click for options'}`;
  node.style.setProperty('--agent', safeColor(a.color));
  node.draggable = !working;
  node.ondragstart = (e) => {
    e.dataTransfer.setData('text/agent', a.id);
    e.dataTransfer.effectAllowed = 'move';
    m.dragging = true;
    node.closest('.mc-office')?.classList.add('dragging');
  };
  node.ondragend = endDrag;
  node.onclick = () => agentMenu(a);
  node.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); agentMenu(a); } };

  // The name tag carries the countdown, so the bubble is free for chatter.
  const tag = h('span', 'mc-tag', a.name);
  if (working && a.deadline) {
    const t = h('span', 'mc-clock', left(a.deadline));
    t.dataset.deadline = a.deadline;
    tag.append(t);
  }
  const bubble = h('div', 'mc-bubble');
  bubble.hidden = true;
  node.append(bubble, sprite(a, { tool }), tag);

  // Keep where it stood across re-renders; working dwarves go to a station,
  // new arrivals are spread out so nobody stands on anyone's beard.
  const st = STATIONS[a.room];
  let p = m.pos.get(a.id);
  if (working && st) {
    const [x, y, flip] = st[Math.max(0, wi) % st.length];
    p = { x, y, room: a.room, desk: true, flip: !!flip };
  } else if (!p || p.room !== a.room || p.desk) {
    p = { x: 18 + ((i * 29 + (hash(a.id) % 11)) % 64), y: 72 + ((i * 7) % 14), room: a.room, flip: i % 2 === 1, next: Date.now() + 800 + i * 900 };
  }
  m.pos.set(a.id, p);
  // Hold still under the pointer, so a dwarf is easy to click or grab.
  node.onmouseenter = () => { p.hold = true; };
  node.onmouseleave = () => { p.hold = false; };
  place(node, p);
  return node;
}

function place(node, p) {
  node.style.left = `${p.x}%`;
  node.style.top = `${p.y}%`;
  node.style.zIndex = String(10 + Math.round(p.y));
  node.classList.toggle('flip', !!p.flip);
}

function endDrag() {
  m.dragging = false;
  document.querySelectorAll('.mc-office.dragging').forEach((n) => n.classList.remove('dragging'));
  document.querySelectorAll('.mc-room.drop').forEach((n) => n.classList.remove('drop'));
  if (m.stale) { m.stale = false; render(); }
}

// ------------------------------------------------------------------- crew

function crew() {
  const grid = h('div', 'mc-crew');
  const { agents } = m.data;
  if (!agents.length) {
    const empty = h('div', 'mc-empty');
    empty.append(h('strong', null, 'No dwarves yet'), h('p', 'mc-dim', 'Hire one, give them a name and a role, then send them to a room to start work.'));
    const b = h('button', 'btn primary', '+ Hire a dwarf');
    b.onclick = () => editAgent(null);
    empty.append(b);
    grid.append(empty);
  }
  for (const a of agents) grid.append(crewCard(a));
  return grid;
}

function pill(a) {
  if (a.status === 'working') {
    const p = h('span', 'mc-pill working', 'At work');
    p.style.setProperty('--room', safeColor(roomOf(a.room)?.color));
    return p;
  }
  return a.status === 'error' ? h('span', 'mc-pill bad', 'Needs help') : h('span', 'mc-pill', 'Resting');
}

function activityLine(a) {
  const line = h('div', 'mc-activity', activity(a));
  if (a.status === 'working' && a.deadline) {
    const t = h('span', 'mc-clock', left(a.deadline));
    t.dataset.deadline = a.deadline;
    line.append(' · ', t, ' left');
  } else if (a.status === 'working' && a.target) {
    line.append(` · goal ${a.target}`);
  }
  return line;
}

function crewCard(a) {
  const working = a.status === 'working';
  const card = h('article', `mc-card st-${a.status}`);
  card.style.setProperty('--agent', safeColor(a.color));
  card.tabIndex = 0;
  card.onclick = () => agentMenu(a);
  card.onkeydown = (e) => { if (e.key === 'Enter' && e.target === card) agentMenu(a); };
  const pic = h('div', 'mc-portrait');
  pic.append(sprite(a, { portrait: true }));
  const body = h('div', 'mc-card-body');
  const top = h('div', 'mc-card-top');
  top.append(h('span', 'mc-card-name', a.name), pill(a));
  if (shellPets()) {
    const out = onDesktop(a.id);
    top.append(iconBtn('desk', out ? `Take ${a.name} off the desktop` : `Put ${a.name} on the desktop`, () => togglePet(a), `mc-card-desk${out ? ' on' : ''}`));
  }
  top.append(iconBtn('edit', `Edit ${a.name}`, () => editAgent(a), 'mc-card-edit'));
  body.append(top);
  if (a.description) body.append(h('div', 'mc-card-role', a.description));
  body.append(activityLine(a));
  if (a.note && a.note !== 'On break') body.append(h('div', `mc-card-note${a.status === 'error' ? ' bad' : ''}`, a.note));
  const acts = h('div', 'mc-card-actions');
  const btn = (text, cls, fn) => {
    const b = h('button', `btn tiny ${cls}`, text);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    acts.append(b);
  };
  if (working) {
    if (a.sessionId) btn('Open chat', 'primary', () => openChat(a.sessionId));
    btn('Stop', '', () => stop(a));
  } else {
    btn('Give work', 'primary', () => giveWork({ agent: a }));
    if (a.sessionId) btn('Last chat', '', () => openChat(a.sessionId));
  }
  body.append(acts);
  card.append(pic, body);
  return card;
}

// ------------------------------------------------------------- animation
// Room life ignores the OS "reduce motion" switch on purpose: it is slow,
// small sprite movement, and it is what makes this view readable at a glance.

/** Walk a resting dwarf to a new spot, then linger a while. */
function stroll(node, p, now) {
  // Favourite spots or anywhere on the floor, but never onto another dwarf.
  const others = [...m.pos.values()].filter((o) => o !== p && o.room === p.room);
  const free = ([x, y]) => others.every((o) => Math.abs(o.x - x) > 10 || Math.abs(o.y - y) > 8);
  const spots = (SPOTS[p.room] || []).map(([x, y]) => [x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 4]).filter(free);
  let target = spots.length && Math.random() < 0.5 ? pick(spots) : null;
  for (let k = 0; !target && k < 8; k++) {
    const t = [16 + Math.random() * 68, 72 + Math.random() * 14];
    if (free(t)) target = t;
  }
  if (!target) { p.next = now + 1500; return; }
  const [x, y] = target;
  const dist = Math.hypot((x - p.x) * 1.8, y - p.y); // the room is wider than tall
  if (dist < 5) { p.next = now + 1200; return; }
  const ms = Math.round(clamp(dist * 45, 900, 4200));
  p.flip = x < p.x;
  p.x = x;
  p.y = y;
  // Important: style.css cuts every transition to .01ms under the OS
  // "reduce motion" switch, which would make the walk a teleport.
  node.style.setProperty('transition-duration', `${ms}ms`, 'important');
  node.classList.add('walking');
  place(node, p);
  clearTimeout(node.walkTimer);
  node.walkTimer = setTimeout(() => {
    node.classList.remove('walking');
    if (Math.random() < 0.3) speak(node);
  }, ms);
  p.next = now + ms + 1800 + Math.random() * 5000;
}

/** Show a speech bubble over a dwarf; by default a quip for its situation. */
function speak(node, text, ms = 3600) {
  const bubble = node?.querySelector('.mc-bubble');
  if (!bubble || !bubble.hidden) return false;
  if (!text) {
    const a = m.data?.agents.find((x) => x.id === node.dataset.id);
    if (!a) return false;
    const key = a.status === 'working' ? a.room : a.status === 'error' ? 'error' : a.room === 'break' ? 'break' : 'idle';
    text = pick(QUIPS[key] || QUIPS.idle);
  }
  bubble.textContent = text;
  bubble.hidden = false;
  node.classList.add('talking');
  node.saidAt = Date.now();
  clearTimeout(node.sayTimer);
  node.sayTimer = setTimeout(() => { bubble.hidden = true; node.classList.remove('talking'); }, ms);
  return true;
}

setInterval(() => {
  const root = $('missionView');
  if (!root || root.hidden || !m.data || m.dragging) return;
  const now = Date.now();
  const nodes = [...root.querySelectorAll('.mc-dwarf')];
  for (const node of nodes) {
    const p = m.pos.get(node.dataset.id);
    if (!p || p.desk || p.hold) continue;
    p.next ??= now + Math.random() * 3000;
    if (now >= p.next) stroll(node, p, now);
  }
  // Chatter: at most two bubbles at once, and nobody hogs the conversation.
  const talking = nodes.filter((n) => n.classList.contains('talking')).length;
  if (talking >= 2 || Math.random() > 0.3) return;
  const resting = nodes.filter((n) => n.closest('.mc-room-break') && !n.classList.contains('talking'));
  if (!talking && resting.length >= 2 && Math.random() < 0.25) {
    const [x, y] = resting.sort(() => Math.random() - 0.5);
    const [line, reply] = pick(DUETS);
    speak(x, line, 3000);
    setTimeout(() => speak(y, reply, 3000), 1400);
    return;
  }
  const quiet = nodes.filter((n) => !n.classList.contains('talking') && now - (n.saidAt || 0) > 7000);
  if (quiet.length) speak(pick(quiet));
}, 700);

// Countdowns tick in place, without rebuilding the view.
setInterval(() => {
  for (const el of document.querySelectorAll('#missionView [data-deadline]')) el.textContent = `${left(Number(el.dataset.deadline))}${el.dataset.suffix || ''}`;
}, 1000);

// ------------------------------------------------------------------ dialogs

const stack = [];
function modal(title, body, actions, { art = null, onClose = null } = {}) {
  const back = h('div', 'mc-modal-back mc-theme');
  const card = h('div', 'mc-modal');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', title);
  const before = document.activeElement;
  const close = () => {
    back.remove();
    stack.splice(stack.indexOf(back), 1);
    document.removeEventListener('keydown', onKey, true);
    before?.focus?.();
    onClose?.();
  };
  let busy = false;
  const row = h('div', 'mc-modal-actions');
  const buttons = actions.filter(Boolean).map(([text, cls, fn]) => {
    const b = h('button', `btn ${cls || ''}`, text);
    b.type = 'button';
    b.onclick = async () => {
      if (busy) return;
      busy = true;
      try { if ((await fn?.()) !== false) close(); } finally { busy = false; }
    };
    row.append(b);
    return b;
  });
  const onKey = (e) => {
    if (stack.at(-1) !== back) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && !['TEXTAREA', 'BUTTON'].includes(e.target.tagName)) {
      const primary = buttons.find((b) => b.classList.contains('primary') && !b.disabled);
      if (primary) { e.preventDefault(); primary.click(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  const head = h('div', 'mc-modal-head');
  if (art) head.append(art);
  head.append(h('h3', null, title));
  card.append(head, body, row);
  back.append(card);
  back.onmousedown = (e) => { if (e.target === back) close(); };
  document.body.append(back);
  stack.push(back);
  (card.querySelector('input, select, textarea') || buttons.find((b) => b.classList.contains('primary')) || buttons[0])?.focus();
  return { close, buttons };
}

const field = (label, input, hint) => {
  const l = h('label', 'mc-field');
  l.append(h('span', 'mc-field-label', label), input);
  if (hint) l.append(h('span', 'mc-dim', hint));
  return l;
};

const confirmBox = (title, text, ok = 'Delete') => new Promise((resolve) => {
  let answer = false;
  modal(title, h('p', 'mc-dim', text), [
    ['Cancel'],
    [ok, 'primary danger', () => { answer = true; }],
  ], { onClose: () => resolve(answer) });
});

const openChat = (sid) => { hide(); bridge().openSession?.(sid); };
async function stop(a) {
  try { m.data = await api('mission/stop', { id: a.id }); render(); } catch (err) { say(err.message); }
}
async function assign(id, room, budget) {
  try { m.data = await api('mission/assign', { id, room, projectId: m.project, ...budget }); render(); } catch (err) { say(err.message); return false; }
}

function dropped(id, room) {
  const a = m.data?.agents.find((x) => x.id === id);
  if (!a) return;
  if (a.status === 'working') return say(`${a.name} is still working. Stop that job first.`);
  if (!room.works) return assign(id, room.id, {});
  giveWork({ agent: a, room: room.id });
}

const TIMES = [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [0, 'No limit']];

/**
 * The one place work is handed out: from a drop (dwarf + room), a card's
 * Give work (dwarf), or a ticket's Build/Repair/Fix now (ticket).
 */
function giveWork({ agent = null, room = null, ticket = null } = {}) {
  const { agents, rooms, projects } = m.data;
  if (!projects.length) return say('Add a project first — use the project picker in the chat composer.');
  if (agent?.status === 'working') return say(`${agent.name} is still working. Stop that job first.`);
  const free = agents.filter((a) => a.status !== 'working');
  if (!free.length) return say(agents.length ? 'Every dwarf is busy. Stop one or hire another.' : 'Hire a dwarf first.');
  const workRooms = rooms.filter((r) => r.works);
  const lastWorker = store('mission.worker');
  const lastRoom = store('mission.room');
  const s = {
    who: agent?.id || (free.some((a) => a.id === lastWorker) ? lastWorker : free[0].id),
    room: ticket ? 'development' : room || (workRooms.some((r) => r.id === lastRoom) ? lastRoom : workRooms[0]?.id),
    project: ticket?.projectId || m.project,
  };
  const dwarf = () => agents.find((a) => a.id === s.who);

  const body = h('div', 'mc-form');
  if (!agent) {
    const who = h('select', 'mc-input');
    for (const a of free) who.append(new Option(a.name, a.id, false, a.id === s.who));
    who.onchange = () => { s.who = who.value; update(); };
    body.append(field('Dwarf', who));
  }
  const tiles = new Map();
  if (ticket) {
    const box = h('div', 'mc-brief');
    box.append(h('strong', null, ticket.title), h('span', 'mc-dim', `${projectName(ticket.projectId)} · ${ticket.priority} priority`));
    body.append(box);
  } else {
    const grid = h('div', 'mc-tiles');
    for (const r of workRooms) {
      const look = hallOf(r.id);
      const b = h('button', 'mc-tile');
      b.type = 'button';
      b.style.setProperty('--room', safeColor(r.color));
      const name = h('span', 'mc-tile-name');
      name.append(h('span', 'mc-dot'), r.name);
      b.append(name, h('span', 'mc-tile-hall', look.hall || ''), h('span', 'mc-tile-count'));
      b.onclick = () => { s.room = r.id; update(); };
      tiles.set(r.id, b);
      grid.append(b);
    }
    const group = h('div', 'mc-field');
    group.append(h('span', 'mc-field-label', 'Room'), grid);
    body.append(group);
    const proj = h('select', 'mc-input');
    for (const p of projects) proj.append(new Option(p.name, p.id, false, p.id === s.project));
    proj.onchange = () => { s.project = proj.value; update(); };
    body.append(field('Project', proj));
  }
  const time = h('select', 'mc-input');
  const target = h('select', 'mc-input');
  const targetField = field('', target);
  const row = h('div', 'mc-row');
  row.append(field('Time limit', time), targetField);
  const note = h('p', 'mc-note');
  body.append(row, note);

  const { buttons } = modal(ticket ? fixOf(ticket)[1] : agent ? `Give ${agent.name} work` : 'Give work', body, [
    ['Cancel'],
    ['Start', 'primary', () => {
      const budget = { minutes: Number(time.value) || 0, target: ticket || s.room === 'docs' ? 0 : Number(target.value) || 0 };
      store(`mission.budget.${s.room}`, JSON.stringify(budget));
      store('mission.worker', s.who);
      if (!ticket) {
        store('mission.room', s.room);
        m.project = s.project;
        store('mission.project', s.project);
      }
      return assign(s.who, s.room, { ...budget, projectId: s.project, ...(ticket ? { ticketIds: [ticket.id] } : {}) });
    }],
  ], { art: sprite(agent || dwarf(), { portrait: true }) });
  const start = buttons[1];

  let shownRoom = null;
  function update() {
    const look = hallOf(s.room);
    const ready = approvedFor(s.project).length;
    for (const [id, b] of tiles) {
      b.classList.toggle('active', id === s.room);
      b.setAttribute('aria-pressed', String(id === s.room));
      b.querySelector('.mc-tile-count').textContent = id === 'development' ? `${ready} approved` : hallOf(id).short || '';
    }
    // Budget fields follow the room, remembering what was used there last.
    if (shownRoom !== s.room) {
      shownRoom = s.room;
      const saved = JSON.parse(store(`mission.budget.${s.room}`) || '{}');
      const minutes = saved.minutes ?? 15;
      time.replaceChildren(...TIMES.map(([v, l]) => new Option(l, v, false, v === minutes)));
      if (!TIMES.some(([v]) => v === minutes)) time.append(new Option(`${minutes} minutes`, minutes, false, true));
      target.dataset.saved = saved.target ?? 0;
    }
    const want = Number(target.value || target.dataset.saved || 0);
    targetField.hidden = !!ticket || s.room === 'docs';
    targetField.querySelector('.mc-field-label').textContent = look.target || 'Goal';
    const counts = s.room === 'development' ? [0, ...[1, 2, 3, 5, 8].filter((n) => n < ready)] : [0, 1, 2, 3, 5, 8, 12];
    target.replaceChildren(...counts.map((n) => new Option(n ? String(n) : s.room === 'development' ? `All approved (${ready})` : 'Let them decide', n, false, n === want)));

    const name = dwarf()?.name || 'The dwarf';
    const blocked = s.room === 'development' && !ticket && !ready;
    const k = ticket ? 1 : Number(target.value) || ready;
    note.textContent = blocked
      ? `No approved tickets in ${projectName(s.project)} yet. Send a dwarf to Research, Quality or Code Review, then approve what they find.`
      : look.explain?.(name, k) || '';
    note.classList.toggle('warn', blocked);
    start.disabled = blocked;
    start.textContent = `Send ${name} to ${look.hall || roomOf(s.room)?.name}`;
  }
  target.onchange = () => { target.dataset.saved = target.value; update(); };
  update();
}

function agentMenu(a) {
  const working = a.status === 'working';
  const body = h('div', 'mc-detail');
  if (a.description) body.append(h('p', 'mc-role', a.description));
  const rows = h('dl', 'mc-rows');
  const row = (k, v) => { if (v) rows.append(h('dt', null, k), h('dd', null, v)); };
  row('Now', activity(a));
  row('Note', a.note && a.note !== 'On break' ? a.note : '');
  row('Project', a.projectId ? projectName(a.projectId) : '');
  row('Model', a.provider ? `${a.provider}${a.model ? ` / ${a.model}` : ''}` : 'Chat default');
  body.append(rows);
  const actions = [
    ['Delete', 'danger mc-push', async () => {
      if (!(await confirmBox(`Delete ${a.name}?`, `${a.name} leaves the hall${working ? ' and the current job is stopped' : ''}. Their tickets stay.`))) return false;
      try { m.data = await api('mission/agent/delete', { id: a.id }); render(); } catch (err) { say(err.message); return false; }
    }],
    ['Edit', '', () => { setTimeout(() => editAgent(a)); }],
  ];
  if (shellPets()) actions.push([onDesktop(a.id) ? 'Take off desktop' : 'Put on desktop', '', () => togglePet(a)]);
  if (a.sessionId) actions.push([working ? 'Open chat' : 'Last chat', '', () => openChat(a.sessionId)]);
  if (working) actions.push(['Stop', 'primary', () => stop(a)]);
  else {
    if (a.room !== 'break') actions.push(['Send to the tavern', '', () => assign(a.id, 'break', {})]);
    actions.push(['Give work', 'primary', () => { setTimeout(() => giveWork({ agent: a })); }]);
  }
  modal(a.name, body, actions, { art: sprite(a, { portrait: true }) });
}

function swatches(list, value, onPick, label) {
  const row = h('div', 'mc-swatches');
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', label);
  const mark = (v) => row.querySelectorAll('.mc-swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v)));
  for (const c of list) {
    const b = h('button', 'mc-swatch');
    b.type = 'button';
    b.dataset.v = c;
    b.style.background = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.onclick = () => { mark(c); onPick(c); };
    row.append(b);
  }
  mark(value);
  return { row, mark };
}

function editAgent(a) {
  const draft = { name: a?.name || '', color: safeColor(a?.color, TUNICS[(m.data?.agents.length || 0) % TUNICS.length]), beard: a?.beard || '', look: a?.look === 'girl' ? 'girl' : 'boy' };
  const art = h('div', 'mc-preview');
  const redraw = () => art.replaceChildren(sprite({ ...draft, name: draft.name || 'new', beard: draft.beard || undefined }, { portrait: true }));

  const body = h('div', 'mc-form');
  const name = h('input', 'mc-input');
  name.value = draft.name;
  name.placeholder = draft.look === 'girl' ? 'e.g. Runa' : 'e.g. Brokk';
  name.maxLength = 40;
  name.oninput = () => { draft.name = name.value; if (!draft.beard) beard.mark(beardOf({ name: draft.name || 'new' })); redraw(); };
  const desc = h('textarea', 'mc-input');
  desc.value = a?.description || '';
  desc.rows = 2;
  desc.placeholder = 'e.g. Grumpy bug hunter who reads every line twice';

  const custom = h('input');
  custom.type = 'color';
  custom.value = draft.color;
  custom.title = 'Any colour';
  const tunic = swatches(TUNICS, draft.color, (c) => { draft.color = c; custom.value = c; redraw(); }, 'Tunic colour');
  custom.oninput = () => { draft.color = custom.value; tunic.mark(custom.value); redraw(); };
  tunic.row.append(custom);
  const beard = swatches(BEARDS, beardOf({ ...draft, name: draft.name || 'new' }), (c) => { draft.beard = c; redraw(); }, 'Beard colour');

  const prov = h('select', 'mc-input');
  prov.append(new Option('Chat default', ''));
  for (const p of bridge().providers?.() || []) prov.append(new Option(p.label || p.id, p.id, false, p.id === a?.provider));
  // A real <select>: a datalist popup is placed by the OS and lands far from
  // the field inside the app window.
  const model = h('select', 'mc-input');
  const fillModels = async () => {
    const want = model.value || a?.model || '';
    model.replaceChildren(new Option('Provider default', ''));
    model.disabled = !prov.value;
    if (!prov.value || !bridge().loadModelList) return;
    const { models = [] } = await bridge().loadModelList(prov.value).catch(() => ({}));
    const ids = models.slice(0, 400).map((x) => x.id);
    if (want && !ids.includes(want)) ids.unshift(want);
    for (const id of ids) model.append(new Option(id, id, false, id === want));
  };
  prov.onchange = () => { model.value = ''; fillModels(); };
  fillModels();

  const looks = h('div', 'mc-looks');
  const picks = h('div', 'mc-form');
  const hairField = field(draft.look === 'girl' ? 'Hair' : 'Beard', beard.row);
  const kind = h('div', 'mc-seg');
  kind.setAttribute('role', 'radiogroup');
  kind.setAttribute('aria-label', 'Dwarf');
  for (const [v, label] of [['boy', 'Boy'], ['girl', 'Girl']]) {
    const b = h('button', 'mc-seg-btn', label);
    b.type = 'button';
    b.dataset.v = v;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(draft.look === v));
    b.onclick = () => {
      draft.look = v;
      kind.querySelectorAll('.mc-seg-btn').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.v === v)));
      hairField.querySelector('.mc-field-label').textContent = v === 'girl' ? 'Hair' : 'Beard';
      name.placeholder = v === 'girl' ? 'e.g. Runa' : 'e.g. Brokk';
      redraw();
    };
    kind.append(b);
  }
  picks.append(field('Dwarf', kind), field('Tunic', tunic.row), hairField);
  looks.append(art, picks);
  const brains = h('div', 'mc-row');
  brains.append(field('Provider', prov), field('Model', model));
  body.append(field('Name', name), field('Role', desc, 'Shapes how they work — it is added to every job brief.'), looks, brains);
  redraw();

  modal(a ? `Edit ${a.name}` : 'Hire a dwarf', body, [
    ['Cancel'],
    [a ? 'Save' : 'Hire', 'primary', async () => {
      try {
        m.data = await api('mission/agent', { id: a?.id, name: name.value, description: desc.value, color: draft.color, beard: draft.beard || null, look: draft.look, provider: prov.value || null, model: model.value || null });
        render();
      } catch (err) { say(err.message); name.focus(); return false; }
    }],
  ]);
  name.focus();
}

// ------------------------------------------------------------------ tickets

const PRI = { high: 0, medium: 1, low: 2 };
const KINDS = { idea: ['Idea', 'research'], bug: ['Bug', 'quality'], review: ['Review', 'review'] };
// What "do it now" means for each kind of ticket, on the button and the dialog.
const FIX = { idea: ['Build now', 'Build this idea'], bug: ['Repair now', 'Repair this bug'], review: ['Fix now', 'Fix this issue'] };
const fixOf = (t) => FIX[t.kind] || FIX.idea;
const FILTERS = [['pending', 'To review'], ['approved', 'Approved'], ['check', 'To check'], ['done', 'Done'], ['rejected', 'Rejected'], ['all', 'All']];
const STATUS = Object.fromEntries(FILTERS);
const EMPTY = {
  pending: 'Nothing to review. Send a dwarf to Research, Quality or Code Review — what they find lands here for you to approve.',
  approved: 'No approved tickets. Approve some under To review, then send a dwarf to the Forge.',
  check: 'Nothing to check. When a dwarf reports a ticket as fixed, it waits here for you to confirm.',
};

function ticketsPanel() {
  const { tickets, projects } = m.data;
  const box = h('section', 'mc-section mc-tickets');
  box.id = 'mcTickets';
  const head = h('div', 'mc-section-head');
  head.append(h('h3', 'mc-section-title', 'Tickets'));
  if (m.ticketProject && !projects.some((p) => p.id === m.ticketProject)) m.ticketProject = '';
  const inScope = tickets.filter((t) => !m.ticketProject || t.projectId === m.ticketProject);
  const counts = {};
  for (const t of inScope) counts[t.status] = (counts[t.status] || 0) + 1;
  const tabs = h('div', 'mc-filters');
  tabs.setAttribute('role', 'tablist');
  for (const [f, label] of FILTERS) {
    const n = f === 'all' ? inScope.length : counts[f] || 0;
    const b = h('button', `mc-filter${m.ticketFilter === f ? ' active' : ''}${(f === 'pending' || f === 'check') && n ? ' alert' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(m.ticketFilter === f));
    b.append(label, h('span', 'mc-count', String(n)));
    b.onclick = () => { m.ticketFilter = f; render(); };
    tabs.append(b);
  }
  head.append(tabs);
  if (projects.length > 1) {
    const sel = h('select', 'mc-input mc-small');
    sel.setAttribute('aria-label', 'Show tickets for');
    sel.append(new Option('All projects', ''));
    for (const p of projects) sel.append(new Option(p.name, p.id, false, p.id === m.ticketProject));
    sel.onchange = () => { m.ticketProject = sel.value; render(); };
    head.append(sel);
  }
  const shown = inScope
    .filter((t) => m.ticketFilter === 'all' || t.status === m.ticketFilter)
    .sort((a, b) => (PRI[a.priority] - PRI[b.priority]) || b.createdAt - a.createdAt);
  if (m.ticketFilter === 'pending' && shown.length > 1) {
    const all = h('button', 'btn tiny mc-push', `Approve all ${shown.length}`);
    all.onclick = async () => {
      if (!(await confirmBox(`Approve ${shown.length} tickets?`, 'They move to Approved, ready for the Forge. You can still reject any of them later.', 'Approve all'))) return;
      for (const t of shown) {
        try { m.data = await api('mission/ticket', { id: t.id, status: 'approved' }); } catch (err) { say(err.message); break; }
      }
      render();
    };
    head.append(all);
  }
  box.append(head);
  const list = h('div', 'mc-ticket-list');
  if (!shown.length) list.append(h('p', 'mc-empty-line', EMPTY[m.ticketFilter] || 'Nothing here yet.'));
  for (const t of shown) list.append(ticketCard(t));
  box.append(list);
  return box;
}

// How a repair attempt ended, in the words shown on the ticket.
const OUTCOMES = {
  fixed: ['good', (a) => `${a.agentName || 'The dwarf'} says it is fixed`],
  unclear: ['warn', () => 'Result unclear — check the chat'],
  'not-fixed': ['bad', (a) => `Not completed — ${a.agentName || 'the dwarf'} could not fix it`],
  stopped: ['bad', () => 'Not completed — the run was stopped'],
  timeout: ['bad', () => 'Not completed — time ran out'],
  error: ['bad', () => 'Not completed — the run failed'],
};

function attemptBox(at, { full = false, leave = null } = {}) {
  const [tone, head] = OUTCOMES[at.outcome] || ['warn', () => at.outcome];
  const box = h('div', `mc-attempt ${tone}`);
  const top = h('div', 'mc-attempt-head');
  top.append(h('strong', null, head(at)));
  if (at.verdict) top.append(h('span', `mc-verdict ${at.verdict}`, at.verdict === 'accepted' ? 'You confirmed it' : 'You said not fixed'));
  top.append(h('span', 'mc-attempt-when', ago(at.at)));
  box.append(top);
  if (at.note) box.append(h('p', full ? 'mc-attempt-note' : 'mc-attempt-note mc-clamp', at.note));
  if (full && at.sessionId) {
    const b = h('button', 'btn tiny mc-ghost', 'Open this chat');
    b.onclick = () => { leave?.(); openChat(at.sessionId); };
    box.append(b);
  }
  return box;
}

/** The status moves a ticket can make, shared by its card and its dialog. */
function ticketActions(t) {
  const set = (status) => async () => {
    try { m.data = await api('mission/ticket', { id: t.id, status }); render(); } catch (err) { say(err.message); return false; }
  };
  const work = (label) => [label, 'primary', () => { setTimeout(() => giveWork({ ticket: t })); }];
  switch (t.status) {
    case 'pending': return [['Reject', '', set('rejected')], ['Approve', 'primary', set('approved')]];
    case 'approved': return [['Back to review', '', set('pending')], ['Mark done', '', set('done')], work(t.attempts?.length ? 'Try again' : fixOf(t)[0])];
    case 'check': return [['Not fixed', '', set('approved')], ['Mark done', 'primary', set('done')]];
    case 'rejected': return [['Restore', '', set('pending')]];
    case 'done': return [['Reopen', '', set('approved')]];
    default: return [];
  }
}

const removeTicket = async (t) => {
  if (!(await confirmBox('Delete this ticket?', `“${t.title}” is removed for good. Reject it instead to keep a record.`))) return false;
  try { m.data = await api('mission/ticket', { id: t.id, status: 'delete' }); render(); } catch (err) { say(err.message); return false; }
};

function ticketTags(t, withStatus) {
  const [kindLabel, kindRoom] = KINDS[t.kind] || [t.kind, 'research'];
  const tags = h('div', 'mc-ticket-tags');
  const kind = h('span', 'mc-kind', kindLabel);
  kind.style.setProperty('--room', safeColor(roomOf(kindRoom)?.color));
  tags.append(kind, h('span', 'mc-pri', `${t.priority} priority`));
  if (withStatus) tags.append(h('span', `mc-state st-${t.status}`, STATUS[t.status] || t.status));
  return tags;
}

function ticketCard(t) {
  const card = h('article', `mc-ticket pri-${t.priority} st-${t.status}`);
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${t.title} — open ticket`);
  // The whole card opens the ticket; its own buttons and details still work.
  card.onclick = (e) => { if (!e.target.closest('button, details')) openTicket(t); };
  card.onkeydown = (e) => { if (e.key === 'Enter' && e.target === card) openTicket(t); };
  const tags = ticketTags(t, m.ticketFilter === 'all');
  tags.append(h('span', 'mc-ticket-meta', `${projectName(t.projectId)} · ${t.agentName} · ${ago(t.createdAt)}`));
  card.append(tags, h('h4', 'mc-ticket-title', t.title));
  // Plain words first; the technical write-up is one click away.
  const lead = t.plain || t.summary;
  if (lead) card.append(h('p', 'mc-ticket-plain', lead));
  const last = t.attempts?.at(-1);
  if (last && ['approved', 'check', 'done'].includes(t.status)) card.append(attemptBox(last));
  if ((t.plain && t.summary) || t.details) {
    const more = h('details');
    more.open = m.open.has(t.id);
    more.ontoggle = () => (more.open ? m.open.add(t.id) : m.open.delete(t.id));
    more.append(h('summary', null, 'Technical details'));
    if (t.plain && t.summary) more.append(h('p', 'mc-ticket-tech', t.summary));
    if (t.details) more.append(h('pre', null, t.details));
    card.append(more);
  }
  const foot = h('div', 'mc-ticket-foot');
  const tools = h('div', 'mc-ticket-tools');
  const chat = last?.sessionId && t.status !== 'pending' ? last.sessionId : t.sessionId;
  if (chat) tools.append(iconBtn('chat', last?.sessionId === chat ? 'Open the repair chat' : 'Open the chat that found this', () => openChat(chat)));
  tools.append(iconBtn('trash', 'Delete ticket', () => removeTicket(t), 'danger'));
  const row = h('div', 'mc-ticket-actions');
  for (const [text, cls, fn] of ticketActions(t)) {
    const b = h('button', `btn tiny ${cls}`, text);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    row.append(b);
  }
  foot.append(tools, row);
  card.append(foot);
  return card;
}

/** Everything about one ticket, with the same actions as its card. */
function openTicket(t) {
  const body = h('div', `mc-ticket-view pri-${t.priority}`);
  body.append(ticketTags(t, true));
  if (t.plain) body.append(h('p', 'mc-ticket-lead', t.plain));
  if (t.summary) {
    const box = h('div', 'mc-block');
    box.append(h('span', 'mc-field-label', t.plain ? 'Technical summary' : 'Summary'), h('p', null, t.summary));
    body.append(box);
  }
  if (t.details) {
    const box = h('div', 'mc-block');
    box.append(h('span', 'mc-field-label', 'Details'), h('pre', null, t.details));
    body.append(box);
  }
  if (t.attempts?.length) {
    const box = h('div', 'mc-block');
    box.append(h('span', 'mc-field-label', t.attempts.length === 1 ? 'Repair attempt' : `Repair attempts (${t.attempts.length})`));
    for (const at of [...t.attempts].reverse()) box.append(attemptBox(at, { full: true, leave: () => close() }));
    body.append(box);
  }
  const meta = h('p', 'mc-dim', `Found by ${t.agentName} in ${projectName(t.projectId)} · ${new Date(t.createdAt).toLocaleString()}`);
  body.append(meta);
  const actions = [['Delete', 'danger mc-push', () => removeTicket(t)]];
  if (t.sessionId) actions.push(['Source chat', '', () => openChat(t.sessionId)]);
  actions.push(['Close'], ...ticketActions(t));
  const { close } = modal(t.title, body, actions);
}

// ------------------------------------------------------- desktop dwarves
// In the desktop app a dwarf can be put on the desktop: a small window of its
// own that stays on top of everything and shows what it is doing. The shell
// owns that window (a transparent, always-on-top one); this side draws the
// frames, since the art lives here, and keeps them current. Which dwarves are
// out, and where they stand, is remembered on this machine.

// Only a shell that says it can: an older Skadi.exe drops these messages
// without a word, and the button would do nothing.
const shellPets = () => Boolean(window.__SKADI_PETS__ && window.chrome?.webview);
const post = (msg) => window.chrome.webview.postMessage(msg);
const pets = {
  load() { try { return JSON.parse(store('mission.pets') || '{}') || {}; } catch { return {}; } },
  save(all) { store('mission.pets', JSON.stringify(all)); },
  sent: new Map(), // id -> what the shell was last told, so only changes go out
};
const onDesktop = (id) => Boolean(pets.load()[id]);
const petState = (a) => (a.status === 'working' ? 'work' : a.status === 'error' ? 'error' : 'idle');

function petStatus(a) {
  if (a.status === 'working') {
    const note = a.note && !/^(Starting|Working in)/.test(a.note) ? ` · ${a.note}` : '';
    return `${hallOf(a.room).verb || 'Working'}${note}`;
  }
  if (a.status === 'error') return 'Needs a hand';
  return a.note && a.note !== 'On break' ? a.note : 'Resting';
}

// The desktop dwarf keeps camp: resting, it lays two logs, strikes a flint,
// watches the fire catch, then sits on a log bench and reads by it -- turning
// pages, blinking, now and then a sip from its mug. At work it stands by the
// embers with its room's tool; in trouble, by a cold fire. One 44x30 stage
// for all of them, so the dwarf does not jump when its state changes.
const PET_W = 44;
const PET_H = 30;
const FEET = ['..DDDD....DDDD..'];
const CAMP = {
  seat: R(2, 24, 18, 3, '#8a5a36') + R(2, 24, 18, 1, '#a8744a') + R(2, 24, 1, 3, '#c9a36b') + R(19, 24, 1, 3, '#c9a36b'),
  stones: R(27, 26, 3, 2, '#6f6873') + R(31, 27, 6, 1, '#8a8390') + R(38, 26, 3, 2, '#6f6873'),
  log1: R(29, 25, 10, 2, '#8a5a36') + R(29, 25, 10, 1, '#a8744a'),
  log2: R(31, 23, 2, 4, '#74492b') + R(36, 23, 2, 4, '#74492b') + R(33, 24, 3, 1, '#5d3a22'),
  glow: '<ellipse cx="34.5" cy="27.5" rx="12" ry="2.2" fill="rgba(255,150,60,.22)"/>',
  embers: R(32, 24, 5, 1, '#e0572a') + R(34, 24, 1, 1, '#ffcc5c'),
  flame1: R(33, 23, 3, 2, '#f08a32') + R(34, 23, 1, 1, '#ffcc5c'),
  flame2: R(32, 21, 5, 4, '#f08a32') + R(33, 22, 3, 3, '#ffcc5c') + R(34, 20, 1, 1, '#f08a32'),
  // Three shapes of a full fire, cycled so it flickers.
  flame3: [
    R(30, 21, 9, 4, '#e0572a') + R(31, 18, 7, 4, '#f08a32') + R(32, 15, 2, 3, '#f08a32') + R(35, 16, 2, 2, '#f08a32') + R(33, 19, 3, 4, '#ffcc5c') + R(34, 21, 1, 2, '#fff1b8'),
    R(30, 21, 9, 4, '#e0572a') + R(31, 19, 7, 3, '#f08a32') + R(33, 15, 3, 4, '#f08a32') + R(36, 17, 1, 2, '#f08a32') + R(32, 20, 4, 3, '#ffcc5c') + R(34, 20, 1, 3, '#fff1b8'),
    R(30, 21, 9, 4, '#e0572a') + R(31, 18, 7, 4, '#f08a32') + R(32, 16, 1, 2, '#f08a32') + R(34, 14, 2, 4, '#f08a32') + R(33, 18, 3, 5, '#ffcc5c') + R(34, 21, 2, 2, '#fff1b8'),
  ],
  strike: R(30, 22, 1, 1, '#fff1b8') + R(32, 21, 1, 1, '#ffcc5c') + R(31, 20, 1, 1, '#ffd98a'),
};
// What the dwarf holds, in its own sprite units (like TOOLS).
const HELD = {
  // Lighter than any beard and longer than the dwarf is wide, so it reads as
  // a log in both hands rather than more beard.
  log: R(-2, 12, 20, 2, '#c08a52') + R(-2, 13, 20, 1, '#8a5a36') + R(-2, 12, 1, 2, '#ecd3a6') + R(17, 12, 1, 2, '#ecd3a6'),
  flint: R(14, 14, 2, 1, '#9aa3ad') + R(15, 13, 1, 1, '#e3e8ec'),
  book: R(3, 10, 10, 4, '#7a3b2e') + R(4, 10, 4, 3, '#f7eedb') + R(8, 10, 4, 3, '#efe2c4') + R(8, 10, 1, 3, '#b89a68') + R(5, 11, 2, 1, '#b8a888') + R(9, 11, 2, 1, '#b8a888'),
  flip: R(3, 10, 10, 4, '#7a3b2e') + R(4, 10, 4, 3, '#f7eedb') + R(8, 10, 4, 3, '#efe2c4') + R(8, 10, 1, 3, '#b89a68') + R(6, 8, 3, 3, '#fffaf0') + R(5, 11, 1, 1, '#b8a888'),
  mug: TOOLS.mug,
  sip: `<g transform="translate(-6 -4)">${TOOLS.mug}</g>`,
};

/** One moment at camp as SVG. */
function campSvg(a, o) {
  const { x = 3, pose = 'stand', legs = 'stand', hold = '', tool = null, raise = false, blink = false,
    logs = 0, fire = 0, flick = 0, smoke = -1, spark = -1, strike = false } = o;
  const pal = dwarfPal(a);
  const rows = a.look === 'girl' ? DWARF_GIRL : DWARF;
  let s = fire >= 2 ? CAMP.glow : '';
  s += CAMP.seat + CAMP.stones;
  if (fire === 3) s += CAMP.flame3[flick % 3];
  else if (fire === 2) s += CAMP.flame2;
  if (logs >= 1) s += CAMP.log1;
  if (logs >= 2) s += CAMP.log2;
  if (fire === 1) s += CAMP.flame1;
  if (fire === 0.5) s += CAMP.embers;
  const y0 = pose === 'sit' ? 8 : pose === 'crouch' ? 11 : 10;
  const feet = pose === 'sit' ? paint(FEET, pal, 19) : pose === 'crouch' ? paint(FEET, pal, 16) : paint(LEGS[legs], pal, 16);
  const held = HELD[hold] || (TOOLS[tool] ? `<g transform="translate(0 ${raise ? -1 : 0})">${TOOLS[tool]}</g>` : '');
  s += `<g transform="translate(${x} ${y0})">${feet}${paint(rows, { ...pal, E: pal.S })}${blink ? '' : paint(rows, { E: pal.E })}${held}</g>`;
  if (strike) s += CAMP.strike;
  if (smoke >= 0) s += R(35 + (smoke % 2), 12 - smoke * 2, smoke > 1 ? 2 : 1, 1, 'rgba(190,190,195,.55)');
  if (spark >= 0) s += R(32 + (spark % 3) * 2, 11 - (spark % 2), 1, 1, '#ffd98a');
  return s;
}

/** An SVG stage as PNG base64, one pixel per sprite unit. */
function petPng(inner) {
  const svg = `<svg xmlns="${SVGNS}" viewBox="0 0 ${PET_W} ${PET_H}" width="${PET_W}" height="${PET_H}" shape-rendering="crispEdges">${inner}</svg>`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = PET_W;
      c.height = PET_H;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, PET_W, PET_H);
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = () => reject(new Error('Could not draw the dwarf for the desktop.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

const beat = (o, ms) => ({ o, ms });

/** Resting: make camp once, then read by the fire for as long as it rests. */
function campScene() {
  const intro = [
    beat({ x: 14 }, 700),
    beat({ x: 14, hold: 'log' }, 550),
    beat({ x: 14, logs: 1 }, 400),
    beat({ x: 14, hold: 'log', logs: 1 }, 550),
    beat({ x: 14, logs: 2 }, 450),
    beat({ x: 14, pose: 'crouch', hold: 'flint', logs: 2 }, 400),
    beat({ x: 14, pose: 'crouch', hold: 'flint', logs: 2, strike: true }, 140),
    beat({ x: 14, pose: 'crouch', hold: 'flint', logs: 2 }, 220),
    beat({ x: 14, pose: 'crouch', hold: 'flint', logs: 2, strike: true }, 140),
    beat({ x: 14, pose: 'crouch', logs: 2, fire: 1 }, 380),
    beat({ x: 14, pose: 'crouch', logs: 2, fire: 2 }, 380),
    beat({ x: 14, logs: 2, fire: 3, flick: 0 }, 350),
    beat({ x: 11, legs: 'a', logs: 2, fire: 3, flick: 1 }, 200),
    beat({ x: 8, legs: 'b', logs: 2, fire: 3, flick: 2 }, 200),
    beat({ x: 5, legs: 'a', logs: 2, fire: 3, flick: 0 }, 200),
    beat({ x: 3, logs: 2, fire: 3, flick: 1 }, 250),
  ];
  const loop = [];
  let i = 0;
  const sit = (extra = {}, ms = 240) => {
    loop.push(beat({ x: 3, pose: 'sit', hold: 'book', logs: 2, fire: 3, flick: i % 3, smoke: i % 4, spark: i % 7 === 3 ? i : -1, ...extra }, ms));
    i++;
  };
  const read = (n) => { for (let k = 0; k < n; k++) sit({ blink: i % 11 === 5 }); };
  read(10);
  sit({ hold: 'flip' });
  sit({ hold: 'flip' });
  read(8);
  sit({ hold: 'mug' });
  sit({ hold: 'mug' });
  sit({ hold: 'sip' });
  sit({ hold: 'sip' });
  sit({ hold: 'sip', blink: true });
  sit({ hold: 'sip' });
  sit({ hold: 'mug' });
  read(6);
  return { beats: [...intro, ...loop], loop: intro.length };
}

/** Working: its room's tool by the embers. In trouble: by a cold fire. */
function busyScene(state, tool) {
  if (state === 'work') return { beats: [beat({ x: 6, logs: 2, fire: 0.5, tool }, 320), beat({ x: 6, logs: 2, fire: 0.5, tool, raise: true }, 320)], loop: 0 };
  return { beats: [beat({ x: 6, logs: 2 }, 2600), beat({ x: 6, logs: 2, blink: true }, 160)], loop: 0 };
}

/** A scene as the shell reads it: "png~ms,png~ms,...;loop". */
async function sceneSpec(a, scene) {
  const pngs = await Promise.all(scene.beats.map((b) => petPng(campSvg(a, b.o))));
  return `${pngs.map((png, i) => `${png}~${scene.beats[i].ms}`).join(',')};${scene.loop}`;
}

/** Bring the shell's desktop dwarves in line with the crew. */
async function syncPets() {
  if (!shellPets() || !m.data) return;
  const all = pets.load();
  for (const [id, where] of Object.entries(all)) {
    const a = m.data.agents.find((x) => x.id === id);
    if (!a) {
      // Deleted from the crew: it leaves the desktop too.
      delete all[id];
      pets.save(all);
      pets.sent.delete(id);
      post(`pet:hide|${id}`);
      continue;
    }
    const state = petState(a);
    const status = petStatus(a);
    const tool = state === 'work' ? hallOf(a.room).tool || '' : '';
    // Anything that changes the pictures; a status line alone is a light update.
    const look = [a.name, a.color, beardOf(a), a.look, tool, state === 'error'].join('/');
    const last = pets.sent.get(id);
    if (last && last.look === look && last.status === status && last.state === state) continue;
    pets.sent.set(id, { look, status, state });
    if (last?.look === look) {
      post(`pet:update|${id}|${encodeURIComponent(status)}|${state}`);
      continue;
    }
    try {
      const [rest, busy] = await Promise.all([
        sceneSpec(a, campScene()),
        state === 'idle' ? '' : sceneSpec(a, busyScene(state, tool)),
      ]);
      post(['pet:show', id, encodeURIComponent(a.name), encodeURIComponent(status), state,
        Number.isFinite(where.x) ? where.x : '', Number.isFinite(where.y) ? where.y : '',
        rest, busy].join('|'));
    } catch (err) {
      pets.sent.delete(id);
      say(err.message);
    }
  }
}

function togglePet(a) {
  const all = pets.load();
  if (all[a.id]) {
    delete all[a.id];
    pets.sent.delete(a.id);
    post(`pet:hide|${a.id}`);
  } else {
    all[a.id] = {};
  }
  pets.save(all);
  render();
}

if (shellPets()) {
  // What happens to a dwarf on the desktop comes back from the shell.
  window.chrome.webview.addEventListener('message', (e) => {
    const [cmd, id, x, y] = String(e.data || '').split('|');
    if (!cmd.startsWith('pet:')) return;
    const all = pets.load();
    if (cmd === 'pet:moved' && all[id]) {
      all[id] = { x: Number(x), y: Number(y) };
      pets.save(all);
    } else if (cmd === 'pet:closed') {
      delete all[id];
      pets.save(all);
      pets.sent.delete(id);
      render();
    } else if (cmd === 'pet:open') {
      const a = m.data?.agents.find((ag) => ag.id === id);
      if (a?.sessionId) openChat(a.sessionId);
      else show();
    } else if (cmd === 'pet:mission') {
      show();
    }
  });
  // Dwarves put out in an earlier run come back with the app.
  if (Object.keys(pets.load()).length) {
    api('mission').then((d) => { m.data ??= d; syncPets(); }).catch(() => {});
  }
}

// ------------------------------------------------------------- show / hide

async function show() {
  $('missionView').hidden = false;
  $('centre')?.classList.add('mission-open');
  $('btnMission')?.classList.add('active');
  try { m.data = await api('mission'); } catch (err) { say(err.message); }
  const waiting = (s) => m.data?.tickets.some((t) => t.status === s);
  if (m.ticketFilter === 'pending' && !waiting('pending') && waiting('check')) m.ticketFilter = 'check';
  render();
}
function hide() {
  const v = $('missionView');
  if (!v || v.hidden) return;
  v.hidden = true;
  $('centre')?.classList.remove('mission-open');
  $('btnMission')?.classList.remove('active');
}
// Updates ride the app's own event stream (app.js hands them to `update`): a
// second EventSource held one of the origin's six HTTP/1.1 connections for
// good, and chat switches queued behind it.
const update = (data) => { m.data = data; render(); };
window.skadiMission = { show, hide, update };
$('btnMission').onclick = () => ($('missionView').hidden ? show() : hide());
