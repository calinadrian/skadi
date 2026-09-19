import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebSearchTools, parseDuckDuckGo, parseSearxng } from '../src/web-search.mjs';

test('parses DuckDuckGo HTML results and unwraps redirect URLs', () => {
  const html = `<div class="result results_links">
    <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;x=1">Example &amp; docs</a></h2>
    <a class="result__snippet">A <b>useful</b> result.</a>
  </div>`;
  assert.deepEqual(parseDuckDuckGo(html), [{
    title: 'Example & docs', url: 'https://example.com/docs', snippet: 'A useful result.',
  }]);
});

test('normalizes SearXNG JSON results', () => {
  assert.deepEqual(parseSearxng({ results: [{
    title: 'One &amp; Two', url: 'https://example.test', content: '<b>Fresh</b> information',
  }] }), [{ title: 'One & Two', url: 'https://example.test', snippet: 'Fresh information' }]);
});

test('web_search uses configured SearXNG and enforces result limit', async () => {
  let requested;
  const fetcher = async (url) => {
    requested = String(url);
    return { ok: true, json: async () => ({ results: [
      { title: 'First', url: 'https://one.test', content: 'One' },
      { title: 'Second', url: 'https://two.test', content: 'Two' },
    ] }) };
  };
  const tool = buildWebSearchTools({ settings: {
    webSearchProvider: 'searxng', searxngUrl: 'http://localhost:8888', webSearchResults: 6,
  } }, fetcher).web_search;
  const output = await tool.run({ query: 'current facts', max_results: 1 });
  assert.match(requested, /^http:\/\/localhost:8888\/search\?/);
  assert.match(requested, /q=current\+facts/);
  assert.match(output, /1\. First/);
  assert.doesNotMatch(output, /Second/);
});

test('auto-started SearXNG is selected without a second provider setting', async () => {
  let requested;
  const fetcher = async (url) => {
    requested = String(url);
    return { ok: true, json: async () => ({ results: [] }) };
  };
  const tool = buildWebSearchTools({ settings: {
    webSearchProvider: 'duckduckgo', searxngAutoStart: true, searxngPort: 9999,
  } }, fetcher).web_search;
  await tool.run({ query: 'one switch' });
  assert.match(requested, /^http:\/\/127\.0\.0\.1:9999\/search\?/);
});
