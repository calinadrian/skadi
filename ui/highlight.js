// A small syntax highlighter for the file viewer, diffs and chat code blocks.
//
// No dependencies and no build step, like the rest of the harness: one pass
// over the text emitting [class, text] pairs, driven by a per-language table.
// It is a *reader's* highlighter, not a parser — it knows comments, strings,
// numbers, keywords and the shape of a call or a type, which is what makes
// code skimmable. It never tries to be right about semantics it cannot see.
//
// Colours follow Visual Studio's dark theme, because that is the palette the
// muscle memory is trained on: comments green, strings salmon, control flow
// purple, declarations blue, types teal, calls yellow, numbers pale green.

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

// Keyword groups shared by the C family. `ctl` is control flow (purple in VS),
// `kw` is everything else that is reserved (blue), `typ` is built-in types.
const C_CTL = 'if else for while do switch case default break continue return goto try catch finally throw';
const C_KW = 'const static inline extern register volatile sizeof typedef struct union enum auto restrict';
const C_TYPES = 'void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t FILE';

const CPP_CTL = `${C_CTL} co_return co_await co_yield`;
const CPP_KW = `${C_KW} class public private protected virtual override final friend namespace using template typename this new delete operator explicit constexpr consteval constinit mutable noexcept static_assert decltype nullptr_t concept requires export import module thread_local alignas alignof dynamic_cast static_cast const_cast reinterpret_cast`;

const CS_CTL = `${C_CTL} foreach in yield await lock checked unchecked when`;
const CS_KW = 'using namespace class struct interface enum record public private protected internal static readonly const abstract sealed virtual override partial async new this base is as ref out in params event delegate operator implicit explicit get set init value where var fixed stackalloc unsafe nameof typeof default global';
const CS_TYPES = 'void bool byte sbyte char decimal double float int uint long ulong short ushort object string dynamic Task List Dictionary IEnumerable IList Span Nullable Action Func Exception';

const JAVA_CTL = `${C_CTL} instanceof yield synchronized assert`;
const JAVA_KW = 'class interface enum record public private protected static final abstract native transient volatile strictfp package import extends implements new this super throws var sealed permits';
const JAVA_TYPES = 'void boolean byte char short int long float double String Object Integer Long Double Float Boolean Character List Map Set ArrayList HashMap Optional Stream Exception';

const JS_CTL = `${C_CTL} await yield of in`;
const JS_KW = 'const let var function class extends new delete typeof instanceof void this super static get set async export import from as with debugger';
const JS_TYPES = 'Object Array String Number Boolean Symbol BigInt Promise Map Set WeakMap WeakSet Date RegExp Error JSON Math console window document globalThis';

const PY_CTL = 'if elif else for while break continue return try except finally raise with yield await match case assert pass';
const PY_KW = 'def class lambda import from as global nonlocal del async is in not and or';
const PY_TYPES = 'int float str bool bytes list dict set tuple object type range enumerate zip len print open self cls super Exception';

// Strings: `o` opens, `c` closes, `esc` honours backslash escapes, `multi`
// allows the literal to span lines (a template literal, a docstring).
const DQ = { o: '"', c: '"', esc: true };
const SQ = { o: "'", c: "'", esc: true };
const TICK = { o: '`', c: '`', esc: true, multi: true };

const TEXT = { line: [], block: [], strings: [], kw: new Set(), ctl: new Set(), typ: new Set(), lit: new Set() };

const cFamily = (over) => ({
  line: ['//'],
  block: [['/*', '*/']],
  strings: [DQ, SQ],
  lit: words('true false null'),
  typed: true,
  ...over,
});

export const LANGS = {
  text: TEXT,
  c: cFamily({ ctl: words(C_CTL), kw: words(C_KW), typ: words(C_TYPES), lit: words('true false NULL'), preproc: true }),
  cpp: cFamily({ ctl: words(CPP_CTL), kw: words(CPP_KW), typ: words(`${C_TYPES} string vector map unordered_map set array shared_ptr unique_ptr weak_ptr nullptr`), lit: words('true false nullptr NULL'), preproc: true }),
  cs: cFamily({ ctl: words(CS_CTL), kw: words(CS_KW), typ: words(CS_TYPES), lit: words('true false null') }),
  java: cFamily({ ctl: words(JAVA_CTL), kw: words(JAVA_KW), typ: words(JAVA_TYPES), lit: words('true false null'), annotations: true }),
  js: cFamily({ ctl: words(JS_CTL), kw: words(JS_KW), typ: words(JS_TYPES), lit: words('true false null undefined NaN Infinity'), strings: [DQ, SQ, TICK] }),
  ts: cFamily({
    ctl: words(JS_CTL),
    kw: words(`${JS_KW} interface type enum namespace declare implements readonly private public protected abstract satisfies keyof infer is`),
    typ: words(`${JS_TYPES} string number boolean any unknown never void object Record Partial Readonly Pick Omit`),
    lit: words('true false null undefined'),
    strings: [DQ, SQ, TICK],
  }),
  py: { line: ['#'], block: [], strings: [{ o: '"""', c: '"""', esc: true, multi: true }, { o: "'''", c: "'''", esc: true, multi: true }, DQ, SQ], ctl: words(PY_CTL), kw: words(PY_KW), typ: words(PY_TYPES), lit: words('True False None'), typed: false },
  rs: cFamily({ ctl: words(`${C_CTL} loop match where`), kw: words('fn let mut const static struct enum impl trait pub use mod crate self super as move ref dyn unsafe async await box type'), typ: words('i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 usize isize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap'), lit: words('true false None Some Ok Err') }),
  go: cFamily({ ctl: words(`${C_CTL} range select defer fallthrough`), kw: words('func var const type struct interface map chan package import go'), typ: words('int int8 int16 int32 int64 uint uintptr byte rune float32 float64 complex64 string bool error any'), lit: words('true false nil iota') }),
  php: cFamily({ line: ['//', '#'], ctl: words(`${C_CTL} foreach as endif endwhile match`), kw: words('function class interface trait extends implements public private protected static abstract final const var global new clone echo print require require_once include include_once namespace use fn'), typ: words('int float string bool array object callable iterable mixed void self parent'), lit: words('true false null TRUE FALSE NULL') }),
  rb: { line: ['#'], block: [], strings: [DQ, SQ], ctl: words('if elsif else unless while until for break next redo retry return yield case when begin rescue ensure raise'), kw: words('def class module end do require require_relative attr_accessor attr_reader attr_writer include extend self lambda proc puts'), typ: words('String Integer Float Array Hash Symbol Struct'), lit: words('true false nil') },
  lua: { line: ['--'], block: [['--[[', ']]']], strings: [DQ, SQ], ctl: words('if elseif else then for while repeat until do break return goto'), kw: words('local function end nil and or not in'), typ: words('table string math io os pairs ipairs type tostring tonumber print require'), lit: words('true false nil') },
  sql: { line: ['--'], block: [['/*', '*/']], strings: [SQ, DQ], ctl: words('select from where group by having order limit offset union join inner left right outer on case when then else end'), kw: words('insert into values update set delete create table alter drop index view as distinct and or not exists in between like is primary key foreign references default null constraint with returning'), typ: words('int integer bigint smallint serial text varchar char boolean date timestamp numeric decimal real double json jsonb uuid'), lit: words('true false null'), fold: true },
  sh: { line: ['#'], block: [], strings: [DQ, SQ], ctl: words('if then elif else fi for while until do done case esac break continue return'), kw: words('function local export readonly source alias set unset trap exit echo cd'), typ: new Set(), lit: words('true false') },
  ps1: { line: ['#'], block: [['<#', '#>']], strings: [DQ, SQ], ctl: words('if elseif else switch foreach for while do until break continue return try catch finally throw'), kw: words('function param begin process end filter class enum using module New-Item Get-ChildItem Set-Content Write-Host'), typ: words('string int bool array hashtable pscustomobject void'), lit: words('true false null'), fold: true },
  json: { line: [], block: [], strings: [DQ], ctl: new Set(), kw: new Set(), typ: new Set(), lit: words('true false null'), json: true },
  css: { line: [], block: [['/*', '*/']], strings: [DQ, SQ], ctl: new Set(), kw: words('important media supports keyframes import charset font-face root'), typ: new Set(), lit: new Set(), css: true },
  html: { html: true, line: [], block: [['<!--', '-->']], strings: [DQ, SQ], ctl: new Set(), kw: new Set(), typ: new Set(), lit: new Set() },
  yaml: { line: ['#'], block: [], strings: [DQ, SQ], ctl: new Set(), kw: new Set(), typ: new Set(), lit: words('true false null yes no on off'), yaml: true },
  ini: { line: ['#', ';'], block: [], strings: [DQ, SQ], ctl: new Set(), kw: new Set(), typ: new Set(), lit: words('true false') },
};

// Aliases: file extensions and the words people write after ``` .
const ALIASES = {
  mjs: 'js', cjs: 'js', jsx: 'js', javascript: 'js', node: 'js',
  tsx: 'ts', typescript: 'ts',
  h: 'c', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', cplusplus: 'cpp',
  csharp: 'cs', 'c#': 'cs', cshtml: 'cs',
  python: 'py', py3: 'py', pyw: 'py',
  rust: 'rs', golang: 'go',
  ruby: 'rb', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh',
  powershell: 'ps1', psm1: 'ps1',
  scss: 'css', sass: 'css', less: 'css',
  htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  yml: 'yaml', toml: 'ini', conf: 'ini', cfg: 'ini', properties: 'ini',
  kt: 'java', kts: 'java', kotlin: 'java', swift: 'java', scala: 'java', groovy: 'java', dart: 'java',
  md: 'text', markdown: 'text', txt: 'text', plain: 'text', log: 'text', diff: 'text',
};

/** Resolve a language id from a file path, an extension, or a fence label. */
export function languageFor(hint) {
  if (!hint) return 'text';
  let key = String(hint).trim().toLowerCase();
  if (key.includes('.') || key.includes('/') || key.includes('\\')) {
    const base = key.split(/[\\/]/).pop();
    if (base === 'makefile' || base === 'dockerfile') return 'sh';
    key = base.includes('.') ? base.split('.').pop() : base;
  }
  key = ALIASES[key] || key;
  return LANGS[key] ? key : 'text';
}

const isWordChar = (ch) => ch >= '0' && ch <= '9' || ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch === '_' || ch === '$';
const isDigit = (ch) => ch >= '0' && ch <= '9';
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

// Words that introduce a type name, so the identifier after them is one.
const DECLARES = new Set(['class', 'struct', 'interface', 'enum', 'record', 'trait', 'impl', 'namespace', 'extends', 'implements', 'new', 'typedef', 'union', 'type']);

/**
 * Split source into [cls, text] pairs. `cls` is one of com, str, esc, num,
 * kw, ctl, typ, fn, prop, pre, tag, attr, op, or '' for plain text.
 */
export function tokenize(src, langId = 'text') {
  const L = LANGS[langId] || TEXT;
  const out = [];
  const push = (cls, text) => { if (text) out.push([cls, text]); };
  const s = String(src ?? '');
  const n = s.length;
  if (langId === 'text') return [['', s]];

  let i = 0;
  let prev = '';      // last significant token's text, for context
  let inTag = false;  // html: inside < ... >

  const atLineStart = (pos) => {
    for (let k = pos - 1; k >= 0; k--) {
      if (s[k] === '\n') return true;
      if (!isSpace(s[k])) return false;
    }
    return true;
  };
  const nextNonSpace = (pos) => {
    let k = pos;
    while (k < n && isSpace(s[k])) k++;
    return s[k] || '';
  };

  while (i < n) {
    const ch = s[i];

    if (isSpace(ch)) {
      const start = i;
      while (i < n && isSpace(s[i])) i++;
      push('', s.slice(start, i));
      continue;
    }

    // ---- comments ---------------------------------------------------------
    const line = L.line?.find((p) => s.startsWith(p, i));
    if (line) {
      const nl = s.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push('com', s.slice(i, end));
      i = end;
      continue;
    }
    const block = L.block?.find((p) => s.startsWith(p[0], i));
    if (block) {
      const close = s.indexOf(block[1], i + block[0].length);
      const end = close === -1 ? n : close + block[1].length;
      push('com', s.slice(i, end));
      i = end;
      continue;
    }

    // ---- C/C++ preprocessor ----------------------------------------------
    if (L.preproc && ch === '#' && atLineStart(i)) {
      let k = i + 1;
      while (k < n && isWordChar(s[k])) k++;
      push('pre', s.slice(i, k));
      i = k;
      // `#include <stdio.h>` — the angle form is a string, not an operator.
      const rest = s.slice(i, s.indexOf('\n', i) === -1 ? n : s.indexOf('\n', i));
      const inc = /^(\s*)(<[^>\n]*>)/.exec(rest);
      if (inc) {
        push('', inc[1]);
        push('str', inc[2]);
        i += inc[0].length;
      }
      continue;
    }

    // ---- html tags --------------------------------------------------------
    if (L.html) {
      if (ch === '<') {
        const m = /^<\/?[A-Za-z][\w:.-]*/.exec(s.slice(i));
        if (m) { push('tag', m[0]); i += m[0].length; inTag = true; continue; }
      }
      if (ch === '>' || (ch === '/' && s[i + 1] === '>')) {
        const tok = ch === '>' ? '>' : '/>';
        push('tag', tok);
        i += tok.length;
        inTag = false;
        continue;
      }
      if (inTag && /[A-Za-z_:]/.test(ch)) {
        const m = /^[\w:.-]+/.exec(s.slice(i));
        push('attr', m[0]);
        i += m[0].length;
        continue;
      }
    }

    // ---- strings ----------------------------------------------------------
    const str = L.strings?.find((q) => s.startsWith(q.o, i));
    if (str) {
      const start = i;
      i += str.o.length;
      let chunk = start;
      while (i < n) {
        if (str.esc && s[i] === '\\' && i + 1 < n) {
          push('str', s.slice(chunk, i));
          push('esc', s.slice(i, i + 2));
          i += 2;
          chunk = i;
          continue;
        }
        if (s.startsWith(str.c, i)) { i += str.c.length; break; }
        // An unterminated quote should not swallow the rest of the file.
        if (!str.multi && s[i] === '\n') break;
        i++;
      }
      push('str', s.slice(chunk, i));
      prev = 'str';
      continue;
    }

    // ---- numbers ----------------------------------------------------------
    if (isDigit(ch) || (ch === '.' && isDigit(s[i + 1] || ''))) {
      const m = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)[a-zA-Z_]*/.exec(s.slice(i));
      const tok = m ? m[0] : ch;
      push('num', tok);
      i += tok.length;
      prev = 'num';
      continue;
    }

    // ---- annotations and attributes --------------------------------------
    if (L.annotations && ch === '@') {
      const m = /^@[\w.]+/.exec(s.slice(i));
      if (m) { push('typ', m[0]); i += m[0].length; continue; }
    }
    if (ch === '$' && (langId === 'sh' || langId === 'ps1' || langId === 'php')) {
      const m = /^\$[\w{}]+/.exec(s.slice(i));
      if (m) { push('prop', m[0]); i += m[0].length; continue; }
    }

    // ---- identifiers ------------------------------------------------------
    if (isWordChar(ch) && !isDigit(ch)) {
      const start = i;
      while (i < n && isWordChar(s[i])) i++;
      const w = s.slice(start, i);
      const key = L.fold ? w.toLowerCase() : w;
      const after = nextNonSpace(i);
      let cls = '';
      if (L.ctl.has(key)) cls = 'ctl';
      else if (L.kw.has(key)) cls = 'kw';
      else if (L.lit.has(key)) cls = 'kw';
      else if (L.typ.has(key)) cls = 'typ';
      else if (DECLARES.has(prev)) cls = 'typ';
      else if (after === '(') cls = 'fn';
      else if (prev === '.') cls = 'prop';
      else if (L.css && after === ':') cls = 'prop';
      else if (L.typed && /^[A-Z]/.test(w) && /^[A-Za-z0-9_]*$/.test(w)) cls = 'typ';
      push(cls, w);
      prev = w;
      continue;
    }

    // ---- json / yaml keys --------------------------------------------------
    if ((L.json || L.yaml) && ch === ':') {
      // Re-colour the key that just closed: in JSON a string before ':' is a
      // property name, not a value.
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k][0] === '' && !out[k][1].trim()) continue;
        if (out[k][0] === 'str' || out[k][0] === '') out[k][0] = 'prop';
        break;
      }
    }

    // ---- punctuation ------------------------------------------------------
    push('op', ch);
    prev = ch;
    i++;
  }
  return out;
}

/**
 * Tokens as DOM nodes, one array entry per source line so a caller can put
 * each line in its own row (with a gutter, a diff marker, whatever it needs).
 */
export function highlightLines(src, langId) {
  const lines = [[]];
  for (const [cls, text] of tokenize(src, langId)) {
    const parts = text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part) lines[lines.length - 1].push([cls, part]);
    });
  }
  return lines;
}

/** Append one line's tokens to `target` as spans. */
export function paintLine(target, tokens) {
  for (const [cls, text] of tokens) {
    if (!cls) { target.append(document.createTextNode(text)); continue; }
    const span = document.createElement('span');
    span.className = `cd-${cls}`;
    span.textContent = text;
    target.append(span);
  }
  return target;
}
