// Ports for the servers the agent starts. A server started on a port that is
// already taken either dies with "address already in use" or, worse, seems to
// work while the browser keeps showing whatever held the port first -- often
// a server left over from an earlier run. So before a command that starts a
// server runs, each port it names is checked, and a taken one is moved to a
// free one. The agent is told the port it actually got.
import net from 'node:net';

// Something answers there.
function accepts(port, host, ms = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(ms, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Nothing holds it, and Windows has not reserved it (Hyper-V and WSL exclude
// whole port ranges, and binding one fails with EACCES).
function bindable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** Whether something on this machine already holds `port`. */
export async function portInUse(port) {
  if (await accepts(port, '127.0.0.1')) return true;
  return !(await bindable(port));
}

/** The first free port after `from`, skipping `avoid`; else one the OS picks. */
export async function freePort(from, avoid = new Set()) {
  for (let port = from + 1; port <= Math.min(from + 200, 65535); port++) {
    if (!avoid.has(port) && !(await portInUse(port))) return port;
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Where a server command names the port it listens on.
const PORT_SPOTS = [
  /(?:--port|--listen|-p)(?:=|\s+)(\d{2,5})(?!\d)/gi,
  /\bhttp\.server\s+(\d{2,5})(?!\d)/gi,
  /\brunserver\s+(\d{2,5})(?!\d)/gi,
  /\bPORT\s*=\s*['"]?(\d{2,5})(?!\d)/gi,
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})(?!\d)/gi,
];

/** The ports a command names for its server to listen on. */
export function commandPorts(command) {
  const ports = new Set();
  for (const spot of PORT_SPOTS) {
    for (const m of String(command).matchAll(spot)) {
      const port = Number(m[1]);
      if (port >= 1 && port <= 65535) ports.add(port);
    }
  }
  return [...ports];
}

/**
 * Move each port the command names that is already taken to a free one.
 * Every mention of a moved port changes with it, so a command that starts a
 * server and then opens its URL still opens the right page.
 * Returns { command, moved: [[from, to], ...] }.
 */
export async function movePortsIfTaken(command, { inUse = portInUse, pick = freePort } = {}) {
  const moved = [];
  const avoid = new Set(commandPorts(command));
  let out = String(command);
  for (const port of avoid) {
    if (!(await inUse(port))) continue;
    const to = await pick(port, avoid);
    if (!to) continue;
    avoid.add(to);
    // Only where it stands as a port (after a space, quote, "=", "," or ":"),
    // never inside a path or a longer word.
    out = out.replace(new RegExp(`(?<=[\\s'"=,:])${port}(?!\\w)`, 'g'), String(to));
    moved.push([port, to]);
  }
  return { command: out, moved };
}

/** What to tell the agent about ports that were moved. */
export function movedPortsNote(moved) {
  return moved.map(([from, to]) =>
    `Port ${from} was already in use, so this server was started on port ${to} instead (http://127.0.0.1:${to}/). Use port ${to} from now on.`,
  ).join('\n');
}
