// Chat titles: the topic of the first message, not the first sixty characters of it.
//
// `topicTitle` is instant and needs no model, so a new chat is named the moment
// it exists. `modelTitle` asks the model that answered for a better one once the
// first turn is over; if that fails or is slow the instant title simply stays.
import { streamCompletion } from './providers.mjs';
import { redactCredentials } from './sessions.mjs';

// Openers that say how the user is asking rather than what about.
const OPENERS = /^(?:(?:hey|hi|hello|yo|ok|okay|so|and|also|now|then|well|btw|please|pls|kindly|just)[\s,.:!-]+)+/i;
const REQUESTS = new RegExp(
  '^(?:'
  + '(?:can|could|would|will) you(?: please)?(?: help me(?: to)?)?'
  + '|i(?:\'d| would)? (?:want|like|need|wish)(?: you)? to'
  + '|i(?:\'m| am) (?:trying|looking|going) to'
  + '|i (?:want|need)'
  + '|let(?:\'|’)?s|lets'
  + '|help me(?: to)?'
  + '|how (?:do|can|should|would) (?:i|we|you)(?: to)?'
  + '|what(?:\'s| is| are) (?:the )?'
  + '|we (?:need|should|have) to'
  + '|you (?:should|need to|must)'
  + ')[\\s,.:]+',
  'i',
);

const MAX_WORDS = 6;
// Words a title should not end on when it was cut short.
const DANGLING = new Set(('a an the of to so that which where when and or but in on at for with by from is are was be '
  + 'there should would could it its this these those my our your as if than then into onto about').split(' '));
const MAX_CHARS = 52;

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** A short topic-style title for a first message. Never empty for non-empty input. */
export function topicTitle(text) {
  const raw = redactCredentials(String(text ?? ''))
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return 'New session';

  // The first sentence carries the topic; the rest is detail.
  let s = raw.split(/(?<=[.!?])\s+|\n/)[0];
  let stripped = s;
  for (let i = 0; i < 3; i++) {
    const next = stripped.replace(OPENERS, '').replace(REQUESTS, '').trim();
    if (next === stripped) break;
    stripped = next;
  }
  // Keep the original when stripping would leave nothing useful.
  if (stripped.split(' ').length >= 2 || stripped.length >= 8) s = stripped;

  const words = s.split(' ');
  let out = '';
  for (const w of words.slice(0, MAX_WORDS)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > MAX_CHARS && out) break;
    out = next;
  }
  const truncated = out.split(' ').length < words.length;
  if (truncated) {
    const kept = out.split(' ');
    while (kept.length > 2 && DANGLING.has(kept.at(-1).toLowerCase().replace(/[^a-z]/g, ''))) kept.pop();
    out = kept.join(' ');
  }
  out = out.replace(/[\s,;:–—-]+$/g, '');
  if (!truncated) out = out.replace(/[.!]+$/g, '');
  else out = out.replace(/[.!?]+$/g, '');
  return capitalise(out.slice(0, MAX_CHARS) || raw.slice(0, MAX_CHARS));
}

const TITLE_PROMPT = 'Name the topic of this chat in 2 to 5 words, as a short title. '
  + 'Reply with the title only: no quotes, no full stop, no preamble.\n\nThe first message:\n';

/** Clean whatever the model said down to one plain title, or null if unusable. */
export function cleanModelTitle(text) {
  let t = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(?:title|topic)\s*[:\-–]\s*/i, '').replace(/^["'“‘`*#\s]+|["'”’`*\s.]+$/g, '').trim();
  t = redactCredentials(t);
  if (!t || t.length > 80 || t.split(' ').length > 10) return null;
  return t;
}

/** Ask the model for a title. Resolves null on any failure; never throws. */
export async function modelTitle(provider, model, firstMessage, { timeoutMs = 25_000 } = {}) {
  const text = String(firstMessage ?? '').trim().slice(0, 800);
  if (!text) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await streamCompletion(
      provider,
      {
        model,
        messages: [{ role: 'user', content: TITLE_PROMPT + text }],
        tools: [],
        retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0 },
        sampling: {
          max_tokens: 32,
          temperature: 0.2,
          // A thinking model would spend the whole budget on a trace.
          ...(provider.managed ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        },
      },
      {},
      controller.signal,
    );
    const content = result.message?.content;
    return cleanModelTitle(typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((b) => b.text || '').join('') : '');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
