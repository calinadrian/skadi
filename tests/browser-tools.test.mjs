// The parts of the browser tools that do not need a running Chromium: how a
// small model's loosely written URLs, keys and targets are understood, and
// what it reads back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseUrl, keyName, formatSnapshot, browserTools } from '../src/browser.mjs';

test('URLs, bare hosts and local paths all open', () => {
  assert.equal(normaliseUrl('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(normaliseUrl('localhost:3000/app'), 'http://localhost:3000/app');
  assert.equal(normaliseUrl('example.com'), 'https://example.com');
  assert.equal(normaliseUrl('C:\\My Site\\index.html'), 'file:///C:/My%20Site/index.html');
  assert.equal(normaliseUrl('"/srv/www/index.html"'), 'file:///srv/www/index.html');
  assert.throws(() => normaliseUrl('index.html'), /full file path/);
});

test('keys are understood however they are written', () => {
  assert.equal(keyName('enter'), 'Enter');
  assert.equal(keyName('esc'), 'Escape');
  assert.equal(keyName('down'), 'ArrowDown');
  assert.equal(keyName('arrowup'), 'ArrowUp');
  assert.equal(keyName('PageDown'), 'PageDown');
});

test('a snapshot reads as a short numbered list', () => {
  const text = formatSnapshot({
    title: 'Login', url: 'http://x/', dialog: '', more: false, text: 'Login Sign in',
    elements: ['[1] textbox "Email"', '[2] button "Sign in"'], scroll: { y: 0, max: 0 },
  }, { note: 'Clicked button "Go".' });
  assert.match(text, /^Clicked button "Go"\./);
  assert.match(text, /\[2\] button "Sign in"/);
  assert.doesNotMatch(text, /Scroll:/);
});

test('coordinate clicks are offered only to models that can see', () => {
  assert.equal('browser_click_at' in browserTools(async () => null), false);
  assert.equal('browser_click_at' in browserTools(async () => null, { vision: () => true }), true);
});
