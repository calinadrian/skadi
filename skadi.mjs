#!/usr/bin/env node
// Entry point. Starts the local UI server and opens a browser at it.
//
//   node skadi.mjs              start on the configured port
//   node skadi.mjs --port 7788  override the port
//   node skadi.mjs --no-open    do not launch a browser
import { spawn } from 'node:child_process';
import { Skadi } from './src/server.mjs';
import { loadSettings } from './src/config.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const settings = loadSettings();
const port = Number(value('--port', settings.uiPort || 7777));

const skadi = new Skadi();
skadi.listen(port);

const url = `http://127.0.0.1:${port}`;
console.log(`skadi  ->  ${url}`);
console.log(`workspace ->  ${settings.workspace}`);
console.log('Ctrl+C to stop (this also stops llama-server if the skadi started it).');

if (!flag('--no-open')) {
  spawn('cmd.exe', ['/c', 'start', '""', url], { windowsHide: true, detached: true }).unref();
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nshutting down...');
  await skadi.shutdown();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
