// Servers the agent starts on a taken port move to a free one.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { commandPorts, movePortsIfTaken, portInUse, freePort, movedPortsNote } from '../src/ports.mjs';

test('finds the port a server command listens on', () => {
  assert.deepEqual(commandPorts('python -m http.server 8731 --bind 127.0.0.1'), [8731]);
  assert.deepEqual(commandPorts('npx vite --port 5173'), [5173]);
  assert.deepEqual(commandPorts('npm run dev -- -p 3001'), [3001]);
  assert.deepEqual(commandPorts('$env:PORT=4000; npm start'), [4000]);
  assert.deepEqual(commandPorts('php -S localhost:8080'), [8080]);
  assert.deepEqual(commandPorts('python manage.py runserver 8001'), [8001]);
  assert.deepEqual(commandPorts('npm run dev'), []);
});

test('a taken port is moved everywhere it stands as a port, and nowhere else', async () => {
  const taken = new Set([8731]);
  const { command, moved } = await movePortsIfTaken(
    'python -m http.server 8731 --directory C:\\proj8731; Start-Process http://127.0.0.1:8731/',
    { inUse: async (p) => taken.has(p), pick: async () => 8732 },
  );
  assert.equal(command, 'python -m http.server 8732 --directory C:\\proj8731; Start-Process http://127.0.0.1:8732/');
  assert.deepEqual(moved, [[8731, 8732]]);
  assert.match(movedPortsNote(moved), /Port 8731 was already in use.*port 8732/);
});

test('a free port is left alone', async () => {
  const { command, moved } = await movePortsIfTaken('npx vite --port 5173', { inUse: async () => false });
  assert.equal(command, 'npx vite --port 5173');
  assert.deepEqual(moved, []);
});

test('portInUse and freePort agree with a real listener', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await portInUse(port), true);
    const next = await freePort(port);
    assert.ok(next && next !== port);
    assert.equal(await portInUse(next), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
