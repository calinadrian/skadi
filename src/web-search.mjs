// Free, keyless web search for the agent. DuckDuckGo works out of the box;
// SearXNG is available for people who run their own instance.
import { ToolError } from './tools.mjs';
import { localSearxngUrl } from './searxng.mjs';

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 6;

function decodeHtml(value = '') {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

const cleanText = (value) => decodeHtml(String(value ?? '').replace(/<[^>]*>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim();

function duckUrl(value) {
  const url = decodeHtml(value);
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    return parsed.searchParams.get('uddg') || parsed.href;
  } catch {
    return url;
  }
}

export function parseDuckDuckGo(html) {
  const blocks = String(html).split(/<div[^>]+class="[^"]*result(?:\s|__)[^"]*"[^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    results.push({ title: cleanText(link[2]), url: duckUrl(link[1]), snippet: cleanText(snippet?.[1]) });
  }
  return results;
}

export function parseSearxng(data) {
  return (Array.isArray(data?.results) ? data.results : []).map((item) => ({
    title: cleanText(item.title),
    url: String(item.url ?? '').trim(),
    snippet: cleanText(item.content),
  })).filter((item) => item.title && item.url);
}

function formatResults(query, provider, results) {
  if (!results.length) return `No web results found for: ${query}`;
  const lines = [`Web results for "${query}" (${provider}):`];
  results.forEach((item, index) => {
    lines.push(`\n${index + 1}. ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ''}`);
  });
  return lines.join('\n');
}

async function requestDuckDuckGo(query, fetcher, signal) {
  const body = new URLSearchParams({ q: query, kl: 'wt-wt' });
  const response = await fetcher('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; Skadi/0.1; local coding assistant)',
    },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  return parseDuckDuckGo(await response.text());
}

async function requestSearxng(query, baseUrl, fetcher, signal) {
  let url;
  try {
    url = new URL('/search', `${baseUrl.replace(/\/+$/, '')}/`);
  } catch {
    throw new ToolError('SearXNG URL is invalid. Set a full URL such as http://localhost:8080.');
  }
  url.search = new URLSearchParams({ q: query, format: 'json' });
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Skadi/0.1' },
    signal,
  });
  if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
  return parseSearxng(await response.json());
}

export function buildWebSearchTools(ctx, fetcher = fetch) {
  return {
    web_search: {
      schema: {
        description: 'Search the public web for current information. Returns concise titles, URLs and snippets. Use sources from the results when answering.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'A focused web search query.' },
            max_results: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'Number of results (default 6, maximum 10).' },
          },
          required: ['query'],
        },
      },
      async run({ query, max_results }) {
        const term = String(query ?? '').trim();
        if (!term) throw new ToolError('query is required');
        const limit = Math.min(MAX_RESULTS, Math.max(1, Number(max_results) || Number(ctx.settings.webSearchResults) || DEFAULT_RESULTS));
        const provider = ctx.settings.searxngAutoStart || ctx.settings.webSearchProvider === 'searxng'
          ? 'searxng'
          : 'duckduckgo';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const results = provider === 'searxng'
            ? await requestSearxng(term, ctx.settings.searxngAutoStart
              ? localSearxngUrl(ctx.settings)
              : String(ctx.settings.searxngUrl || ''), fetcher, controller.signal)
            : await requestDuckDuckGo(term, fetcher, controller.signal);
          return formatResults(term, provider === 'searxng' ? 'SearXNG' : 'DuckDuckGo', results.slice(0, limit));
        } catch (error) {
          if (error instanceof ToolError) throw error;
          const reason = error?.name === 'AbortError' ? 'timed out after 15 seconds' : error?.message;
          throw new ToolError(`web search failed: ${reason || 'unknown error'}`);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  };
}
