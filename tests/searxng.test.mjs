import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSearxng, SEARXNG_CONTAINER, localSearxngUrl, searxngDockerArgs } from '../src/searxng.mjs';

test('local SearXNG binds only to loopback on the configured port', () => {
  assert.equal(localSearxngUrl({ searxngPort: 9999 }), 'http://127.0.0.1:9999');
  assert.deepEqual(searxngDockerArgs({ searxngPort: 9999 }, 'D:\\Skadi\\settings.yml'), [
    'run', '--detach', '--rm', '--name', SEARXNG_CONTAINER,
    '--publish', '127.0.0.1:9999:8080', '--env', 'BASE_URL=http://localhost/',
    '--volume', 'D:/Skadi/settings.yml:/etc/searxng/settings.yml:ro',
    'searxng/searxng:latest',
  ]);
});

test('the companion stops only the container it started', async () => {
  const calls = [];
  const service = new LocalSearxng({
    run: async (...args) => calls.push(args),
    fetcher: async () => ({ ok: true }),
    settingsFile: async () => 'D:\\Skadi\\settings.yml',
  });
  await service.reconcile({ searxngAutoStart: true, searxngPort: 8888 });
  assert.equal(service.state.state, 'ready');
  await service.reconcile({ searxngAutoStart: false });
  assert.deepEqual(calls.at(-1).slice(0, 2), ['docker', ['stop', SEARXNG_CONTAINER]]);
  await service.stop();
  assert.equal(calls.length, 2);
});
