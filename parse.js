// A fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// parse(markdown) returns exactly the HTML that marked 18.1.3 emits with
// its default options (GFM on, breaks off). It imports nothing and keeps
// no state between calls, so each call renders its input on its own.
//
// Layout of the implementation:
//  * the block layer splits the input into lines, lexes blocks (headings,
//    fences, lists, blockquotes, tables, HTML blocks, paragraphs) into
//    small token objects, then renders them;
//  * the inline layer walks one paragraph left to right. Emphasis is the
//    tricky part: before scanning for `*`/`_` delimiters it builds a
//    "masked" copy of the text where code spans, links and raw HTML are
//    blanked out, so emphasis can never peek inside them;
//  * link reference definitions are gathered while lexing blocks and are
//    consulted when inline links are rendered.

'use strict';

// ---------- character classification ----------

// ASCII punctuation (Unicode general categories P and S, below 0x80).
const PUNCT_ASCII = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1,
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0,
]);

function isAsciiPunct(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 && PUNCT_ASCII[code] === 1;
}

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return PUNCT_ASCII[code] === 1;
  return UNICODE_PUNCT.test(ch);
}

// ---------- escaping and entities ----------

// Escape < > " ' and & (but leave & alone when it starts a valid entity).
const ESCAPE_KEEP_ENTITY = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_ALL = /[&<>"']/g;
function escKeepEntity(str) {
  if (!str.includes('&') && !str.includes('<') && !str.includes('>') && !str.includes('"') && !str.includes("'")) return str;
  return str.replace(ESCAPE_KEEP_ENTITY, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}
function escAll(str) {
  if (!str.includes('&') && !str.includes('<') && !str.includes('>') && !str.includes('"') && !str.includes("'")) return str;
  return str.replace(ESCAPE_ALL, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

// Decode numeric character references the way marked does: only runs when a
// numeric reference is present; a bare & in the same pass becomes &amp;.
// Out-of-range values (0, > 0x10FFFF, surrogates) become U+FFFD; 38 is &amp;.
const HAS_NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_OR_BARE_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(str) {
  if (!HAS_NUMERIC_REF.test(str)) return str;
  return str.replace(NUMERIC_OR_BARE_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// Sanitize a link destination the way marked's cleanUrl does: encodeURI,
// then turn %25 back into %. Only null when encodeURI throws. (marked does
// not block javascript: / data: / vbscript: URLs.)
function cleanUrl(href) {
  if (href == null) return null;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// A link reference label normalises to lowercase with collapsed whitespace.
const LABEL_WS = /\s+/g;
function normalizeLabel(label) {
  return label.trim().replace(LABEL_WS, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------- code points and whitespace ----------

// The full code point starting at i ('' past the end); handles surrogates.
function cpAt(str, i) {
  if (i >= str.length) return '';
  const c = str.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
    const d = str.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return str.slice(i, i + 2);
  }
  return str[i];
}

// The full code point ending at end (exclusive).
function prevCp(str, end) {
  if (end <= 0) return '';
  const lo = str.charCodeAt(end - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
    const hi = str.charCodeAt(end - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return str.slice(end - 2, end);
  }
  return str[end - 1];
}

function isSpaceCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c
    || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028
    || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// Punctuation or symbol in the GFM sense: '~' does NOT count (it is a word
// character for emphasis purposes).
function isPunctGfm(ch) {
  if (!ch || ch === '~') return false;
  return isPunct(ch);
}

// Whitespace or punctuation/symbol, except '*' and '_' (marked's
// `punctuation` character class, which re-adds those two separately).
function isPunctOrSpace(ch) {
  if (!ch || ch === '*' || ch === '_') return false;
  return isSpaceCh(ch) || isPunct(ch);
}

function isEmailCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
    || c === '.' || c === '!' || c === '#' || c === '$' || c === '%' || c === '&'
    || c === "'" || c === '*' || c === '+' || c === '/' || c === '=' || c === '?'
    || c === '`' || c === '{' || c === '|' || c === '}' || c === '~' || c === '-' || c === '_';
}
function isAlnumCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

// ---------- shared patterns ----------

// GFM extended-autolink backpedal: trims trailing punctuation off a URL.
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Link label (nested brackets, escapes, code spans), reference label, title
// and destination patterns, as marked builds them.
const LABEL_INNER = '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF_INNER = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
// Sticky (y) so they match exactly at the position we are scanning.
const INLINE_LINK_RE = new RegExp('!?\\[(' + LABEL_INNER + ')\\]\\([ \\t\\n]*(' + LINK_HREF + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + LINK_TITLE + '))?[ \\t\\n]*\\)', 'y');
const REFLINK_RE = new RegExp('!?\\[(' + LABEL_INNER + ')\\]\\[(' + REF_INNER + ')\\]', 'y');
const NOLINK_RE = new RegExp('!?\\[(' + REF_INNER + ')\\](?:\\[\\])?', 'y');
// marked's reflink search (for masking): a full [label][ref] or a [ref]
// nolink anywhere in the text.
const _LE = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const _LT = '(?:[^\\[\\]`]*(?:\\[(?:' + _LE + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]`]*?';
const _BE = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const REFLINK_SEARCH_RE = new RegExp('!?\\[' + _LT + '\\]\\[' + _BE + '\\]|!?\\[' + _BE + '\\](?:\\[\\])?(?!\\()', 'g');

// Inline code span (sticky).
const INLINE_CODE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;

const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;

// ---------- masked source ----------

// marked's blockSkip (links, code spans, html), with named groups so the
// backtick-run backreference is correct.
const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
// An inline link at the current position (anchored: the match must start
// exactly here — an unanchored pattern would silently match a later link
// and mask the wrong span).
const MASK_LINK_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/y;
const MASK_HTML_RE = /<(?! )[^<>]*?>/y;
const MASK_SCAN_RE = /[\\`[!<]/g;

// Does the text contain a link that resolves (used while masking reflinks)?
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  BLOCK_SKIP_RE.lastIndex = 0;
  for (const m of text.matchAll(BLOCK_SKIP_RE)) {
    // INLINE_LINK_RE is sticky: reset lastIndex before .test, or a
    // leftover lastIndex from tryLink makes the test fail spuriously
    // (which fully masked dropped reflinks and hid their emphasis).
    INLINE_LINK_RE.lastIndex = 0;
    if (INLINE_LINK_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH_RE.lastIndex = 0;
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (s.charAt(0) === '!') continue;
    if (!Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) continue;
    if (r > 1 && linkInText(s.slice(1, r - 1), links)) continue;
    return true;
  }
  return false;
}

function maskReflink(match0, links) {
  const refStart = match0.lastIndexOf('[');
  if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
  if (refStart > 1 && match0.charAt(0) !== '!') {
    const text = match0.slice(1, refStart - 1);
    if (linkInText(text, links)) {
      return '[' + text.replace(REFLINK_SEARCH_RE, (m) => maskReflink(m, links))
        + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match0.length - 2) + ']';
}

// Replace one masked span [start, end) by 'a's, keeping its first and last
// characters (a bracket or a backtick run's head) so indices stay aligned.
function fillSpan(chars, start, end) {
  for (let i = start + 1; i < end - 1; i++) chars[i] = 'a';
}

// Build the masked source for one inline run: same length as src, with the
// spans emphasis must not see inside replaced by 'a's (brackets kept).
function maskSrc(src, links) {
  if (!src.includes('*') && !src.includes('_') && !src.includes('~')) return src;
  // Nothing to mask (no code span, link, tag or escape can hide a
  // delimiter): skip the scan entirely.
  if (!src.includes('`') && !src.includes('[') && !src.includes('<') && !src.includes('\\')) return src;
  const n = src.length;
  let masked = src;
  // Reflinks first (only the ones that resolve).
  if (links && src.includes('[')) {
    REFLINK_SEARCH_RE.lastIndex = 0;
    let out = '';
    let last = 0;
    let changed = false;
    for (const m of src.matchAll(REFLINK_SEARCH_RE)) {
      const rep = maskReflink(m[0], links);
      if (rep !== m[0]) {
        out += src.slice(last, m.index) + rep;
        last = m.index + m[0].length;
        changed = true;
      }
    }
    if (changed) masked = out + src.slice(last);
  }
  const chars = masked.split('');
  // Jump straight to the next char that can start a maskable construct
  // (escape, code span, link, html) instead of walking every character:
  // long runs are mostly plain text.
  MASK_SCAN_RE.lastIndex = 0;
  let mj;
  while ((mj = MASK_SCAN_RE.exec(masked)) !== null) {
    const j = mj.index;
    const c = masked[j];
    if (c === '\\' && j + 1 < n && isPunct(masked[j + 1])) {
      chars[j] = '+';
      chars[j + 1] = '+';
      MASK_SCAN_RE.lastIndex = j + 2;
      continue;
    }
    if (c === '`') {
      INLINE_CODE_RE.lastIndex = j;
      const m = INLINE_CODE_RE.exec(masked);
      if (m) {
        const end = j + m[0].length;
        const run = m[1].length;
        // Keep the opening backtick run, mask the rest as [aaa].
        chars[j + run] = '[';
        chars[end - 1] = ']';
        fillSpan(chars, j + run, end);
        MASK_SCAN_RE.lastIndex = end;
        continue;
      }
      // A backtick run that opens no code span is literal in full: skip
      // the whole run (never retry inside it, or a later backtick would
      // wrongly pair with a backtick inside the run).
      let k = j + 1;
      while (k < n && masked[k] === '`') k++;
      MASK_SCAN_RE.lastIndex = k;
      continue;
    }
    if (c === '[' || (c === '!' && masked[j + 1] === '[')) {
      const at = c === '!' ? j + 1 : j;
      MASK_LINK_RE.lastIndex = at;
      const m = MASK_LINK_RE.exec(masked);
      if (m) {
        const end = at + m[0].length;
        chars[at] = '[';
        chars[end - 1] = ']';
        fillSpan(chars, at, end);
        MASK_SCAN_RE.lastIndex = end;
        continue;
      }
      continue;
    }
    if (c === '<') {
      MASK_HTML_RE.lastIndex = j;
      const m = MASK_HTML_RE.exec(masked);
      if (m) {
        const end = j + m[0].length;
        chars[j] = '[';
        chars[end - 1] = ']';
        fillSpan(chars, j, end);
        MASK_SCAN_RE.lastIndex = end;
        continue;
      }
      continue;
    }
  }
  return chars.join('');
}

// ---------- inline scanner ----------

// Scan a text run starting at i. Returns the index where the run stops
// (a special char, a br trigger, a url/email/www trigger, or the end).
// runStart is the index where this text run began (url triggers are only
// checked after it, since the main loop already tried url at runStart).
// One native regex scan for the next text-run stop (special char or a
// url/email/www/br trigger) instead of a per-character loop: the long
// generated docs are mostly plain text, so jumping straight to the next
// stop is far cheaper than testing every character.
const TEXT_STOP_RE = /[\\<`*!_~\[]|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:|@| {2,}\n/g;
function textRunEnd(src, i, n, runStart) {
  TEXT_STOP_RE.lastIndex = i;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index;
    if (p >= n) return n;
    const t = m[0];
    // Email '@' is a single char but needs the run-scan below, not a
    // plain stop.
    if (t === '@') {
      let s = p - 1;
      while (s >= i && isEmailCh(src[s])) s--;
      s++;
      if (s > i) return s;
      continue;
    }
    // Single special char: stop here.
    if (t.length === 1) return p;
    // URL: only after the run start (the main loop tried it at runStart).
    const c0 = t.charCodeAt(0);
    if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70) { // h H f F
      if (p > runStart) return p;
      continue;
    }
    // www.: only after the run start and a trigger char before it.
    if (t === 'www.') {
      if (p > runStart) {
        const pv = src[p - 1];
        if (pv === ' ' || pv === '\t' || pv === '\n' || pv === '\r' || pv === '*' || pv === '_' || pv === '~' || pv === '(') return p;
      }
      continue;
    }
    // mailto:/xmpp:: only after the run start and a non-alnum before it;
    // the run ends AFTER the trigger's first char.
    if (t === 'mailto:' || t === 'xmpp:') {
      if (p > runStart && !isAlnumCh(src[p - 1])) return p + 1;
      continue;
    }
    // Br: 2+ spaces then newline — the run ends before the spaces.
    return p;
  }
  return n;
}

// fe(): the last possible closer index for a delimiter in the masked source.
// A run counts when the char before it is not whitespace; the last such run wins.
function findCloser(masked, delim, from) {
  let last = -1;
  const n = masked.length;
  let s = from || 0;
  while (s < n) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') { s++; continue; }
    if (r !== delim) {
      let i = s + 1;
      while (i < n && masked[i] === r) i++;
      s = i;
      continue;
    }
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') last = s;
    s = i;
  }
  return last;
}

// Classify a delimiter run's neighbours (marked's RDelim groups).
// P = char before the run, N = char after it ('' at string ends).
// Returns 0 = no match (skip), 1..6 = the RDelim group.
function rdelimGroup(P, N) {
  const pPunct = isPunctGfm(P);
  const pSpace = isSpaceCh(P);
  const pWord = !!P && !pPunct && !pSpace;
  const nPunct = isPunctGfm(N);
  const nSpace = isSpaceCh(N);
  const nWord = !!N && !nPunct && !nSpace;
  const nEnd = !N;
  if (!P) return 0;
  if (pPunct && (nSpace || nEnd)) return 1;
  if (pWord && (nPunct || nSpace || nEnd)) return 2;
  if ((pPunct || pSpace) && nWord) return 3;
  if (pSpace && nPunct) return 4;
  if (pPunct && nPunct) return 5;
  if (pWord && nWord) return 6;
  return 0;
}

// marked's RDelim regexes skip a delimiter that sits inside the opposite
// strong span at the start of the scanned text: a `*` inside `__...__`
// (and a `_` inside `**...**`) is not a delimiter for this attempt.
const SKIP_AST_IN_UND = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/;
const SKIP_UND_IN_AST = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;

// Emphasis / strong. Returns {end, html} or null.
// src = the whole inline run, i = index of the delimiter, masked = masked src,
// prevChar = char before i ('' at start), st = state.
function tryEmStrong(src, i, masked, st, prevChar) {
  const r = src[i];
  const n = src.length;
  // LDelim: the run, then one following char.
  let j = i;
  while (j < n && src[j] === r) j++;
  const runLen = j - i;
  const after = j < n ? cpAt(src, j) : '';
  let d = '';
  let ldelimOk = false;
  if (after) {
    if (isPunctGfm(after) && after !== r && after !== '~') {
      d = after;
      ldelimOk = true;
    } else if (!isSpaceCh(after) && after !== r) {
      ldelimOk = true;
    }
  }
  if (!ldelimOk) return null;
  // Back up over the run in the masked source (orphan prefix).
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const extLen = j - l;
  const p = l > 0 ? prevCp(masked, l) : '';
  const h = p === '*' || p === '_' || isPunctOrSpace(p);
  let nch = prevChar;
  if (l < i) nch = p;
  const u = l < i ? h : isPunctOrSpace(nch);
  // '_' cannot open emphasis in the middle of a word: followed by a word
  // char and preceded by a Unicode letter/number.
  if (r === '_') {
    const s4 = after && !isSpaceCh(after) && after !== '_' && !isPunctGfm(after);
    if (s4 && nch && UNICODE_ALNUM_RE.test(nch)) return null;
  }
  // Left-flanking gate.
  if (!(!d || !nch || u)) return null;
  const k = runLen;
  let m = k;
  let f = 0;
  const y = extLen;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  const o = prevChar === r;
  const v = findCloser(masked, r, i);
  const Q = i + k;
  if (v < Q) return null;
  // Skip a delimiter hidden inside the opposite strong span at the start
  // of the scanned text (marked's RDelim `^...` alternative).
  let s = Q;
  const skipRe = r === '*' ? SKIP_AST_IN_UND : SKIP_UND_IN_AST;
  const skip = skipRe.exec(masked.slice(Q));
  if (skip) s = Q + skip[0].length;
  // Scan delimiter runs of r in the masked source, from s to v.
  while (s <= v) {
    // Find the next run of r at or after s.
    while (s <= v && masked[s] !== r) s++;
    if (s > v) break;
    let e = s;
    while (e < n && masked[e] === r) e++;
    const runStart = s;
    const runEnd = e;
    const b0 = runEnd - runStart;
    const P = runStart > 0 ? prevCp(masked, runStart) : '';
    const N = runEnd < n ? cpAt(masked, runEnd) : '';
    const g = rdelimGroup(P, N);
    s = runEnd;
    if (!g) continue;
    // For '_' there is no group 6 (intraword _ is not a closer at all);
    // skip it entirely.
    if (r === '_' && g === 6) continue;
    if (g === 3 || g === 4) { m += b0; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null;
      if (y % 3 && !((y + b0) % 3)) { f += b0; continue; }
    }
    m -= b0;
    if (m > 0) continue;
    const b = Math.min(b0, b0 + m + f);
    // The raw match in the original src: from i to (runStart + b) in
    // masked coordinates — the masked source aligns with src by index.
    const rawEnd = runStart + b;
    const raw = src.slice(i, rawEnd);
    // Suppressed: emphasis spanning a double-backtick code span with an
    // inner backtick, inside a [...] (...) link attempt.
    if (suppressEmInLink(src, i, rawEnd, raw.slice(1, -1))) return null;
    if (Math.min(k, b) % 2) {
      const inner = raw.slice(1, -1);
      const innerHtml = inlineRun(inner, st);
      return { end: rawEnd, html: st.textMode ? innerHtml : '<em>' + innerHtml + '</em>' };
    }
    const inner = raw.slice(2, -2);
    const innerHtml = inlineRun(inner, st);
    return { end: rawEnd, html: st.textMode ? innerHtml : '<strong>' + innerHtml + '</strong>' };
  }
  return null;
}

// A double-backtick code span whose content itself contains a backtick
// (`` a ` b ``). Emphasis spanning one of these inside a [...] (...)
// inline-link attempt is NOT formed by marked (the link regex cannot
// match the label, the link is dropped, and the emphasis is not
// re-parsed); in a plain paragraph or a bare [...] it IS formed.
const DBL_TICK_CODE_RE = /``[^`]*`[^`]*``/;
function inInlineLinkAttempt(src, openIdx, closeIdx) {
  const ob = src.lastIndexOf('[', openIdx);
  if (ob < 0) return false;
  // The '[' must still be open at the emphasis opener (no ']' between).
  const cb = src.indexOf(']', ob);
  if (cb >= 0 && cb < openIdx) return false;
  // The bracket must close after the emphasis and be followed by '('.
  const end = src.indexOf(']', closeIdx);
  if (end < 0) return false;
  return src[end + 1] === '(';
}
function suppressEmInLink(src, openIdx, closeIdx, inner) {
  return DBL_TICK_CODE_RE.test(inner) && inInlineLinkAttempt(src, openIdx, closeIdx);
}

// Strikethrough. Delimiter-stack matching (like marked): an opener pairs
// with the nearest following closer of the SAME length ('~' with '~',
// '~~' with '~~'), resolving inner pairs first, so '~~a ~~b~~ c~~'
// nests as <del>a <del>b</del> c</del>. masked = masked source (code
// spans / links hidden) for the scan; indices align with src.
function tryDel(src, i, masked, st) {
  const n = src.length;
  const L = src[i + 1] === '~' ? 2 : 1;
  // The opener must be followed by a non-space, non-'~' char.
  const oN = i + L < n ? masked[i + L] : '';
  if (oN === '' || isSpaceCh(oN) || oN === '~') return null;
  const stack = [[i, L]];
  let p = i + L;
  while (p < n) {
    if (masked[p] !== '~') { p++; continue; }
    let q = p;
    while (q < n && masked[q] === '~') q++;
    let d = p;
    while (d < q) {
      const Ld = (q - d >= 2) ? 2 : 1;
      const P = d > 0 ? masked[d - 1] : '';
      const N = d + Ld < n ? masked[d + Ld] : '';
      const canClose = P !== '' && !isSpaceCh(P) && P !== '~' && N !== '~';
      const canOpen = N !== '' && !isSpaceCh(N) && N !== '~';
      if (canClose) {
        let idx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s][1] === Ld) { idx = s; break; }
        }
        if (idx >= 0) {
          const opener = stack[idx];
          stack.splice(idx, 1);
          if (opener[0] === i) {
            const inner = src.slice(i + L, d);
            // Suppressed: del spanning a double-backtick code span with
            // an inner backtick, inside a [...] (...) link attempt.
            if (suppressEmInLink(src, i, d + Ld, inner)) return null;
            const innerHtml = inlineRun(inner, st);
            return { end: d + Ld, html: st.textMode ? innerHtml : '<del>' + innerHtml + '</del>' };
          }
          d += Ld;
          continue;
        }
      }
      if (canOpen) stack.push([d, Ld]);
      d += Ld;
    }
    p = q;
  }
  return null;
}

// Codespan: ^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)
function tryCodespan(src, i, st) {
  INLINE_CODE_RE.lastIndex = i;
  const m = INLINE_CODE_RE.exec(src);
  if (!m) return null;
  let text = m[2].replace(/\n/g, ' ');
  if (text.length > 2 && text[0] === ' ' && text[text.length - 1] === ' ' && !/^\s+$/.test(text)) {
    text = text.slice(1, -1);
  }
  if (st.textMode) return { end: i + m[0].length, html: text };
  return { end: i + m[0].length, html: '<code>' + escAll(text) + '</code>' };
}

// Hard break: ^( {2,}|\\)\n(?!\s*$)[ \t]*
const BR_RE = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
function tryBr(src, i, st) {
  BR_RE.lastIndex = i;
  const m = BR_RE.exec(src);
  if (!m) return null;
  return { end: i + m[0].length, html: st.textMode ? '' : '<br>' };
}

function tryEscape(src, i) {
  if (i + 1 < src.length && isAsciiPunct(src[i + 1])) {
    return { end: i + 2, html: escKeepEntity(src[i + 1]) };
  }
  return null;
}

// Inline HTML tag. Returns {end, html} and updates st.inRawBlock.
// marked's exact inline tag regex: comment | close tag | open tag (with
// strict attribute grammar) | processing instruction | declaration | CDATA.
// The attribute value may contain < > inside quotes.
const TAG_RE = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const TAG_NAME_RE = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;
function tryTag(src, i, st) {
  TAG_RE.lastIndex = i;
  const m = TAG_RE.exec(src);
  if (!m) return null;
  const nm = TAG_NAME_RE.exec(m[0]);
  if (nm) {
    const tag = nm[1].toLowerCase();
    const isClose = m[0][1] === '/';
    if (!isClose && (tag === 'pre' || tag === 'script' || tag === 'style' || tag === 'textarea')) st.inRawBlock = true;
    else if (isClose && (tag === 'pre' || tag === 'script' || tag === 'style' || tag === 'textarea')) st.inRawBlock = false;
    // An opening <a> (not self-closing) puts the lexer inside a link
    // until </a>; bare URLs/emails are not linkified while inLink is set.
    // marked's self-close test is quirky: <a/> and <a\thref="x"/> count
    // as self-closing, but <a /> and <a href="x"/> (with a space) count
    // as opening. So: self-closing iff it ends with '/>' and holds no
    // space character (0x20).
    if (!isClose && tag === 'a' && !(/\/>$/.test(m[0]) && !m[0].includes(' '))) st.inLink = true;
    else if (isClose && tag === 'a') st.inLink = false;
  }
  return { end: i + m[0].length, html: m[0] };
}

// Autolink <scheme:...> or <email>.
const AUTOLINK_SCHEME_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/y;
const AUTOLINK_EMAIL_RE = /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
function tryAutolink(src, i, st) {
  AUTOLINK_SCHEME_RE.lastIndex = i;
  let m = AUTOLINK_SCHEME_RE.exec(src);
  if (m) {
    const href = cleanUrl(m[1]);
    if (st.textMode) return { end: i + m[0].length, html: m[1] };
    const h = href == null ? escAll(m[1]) : escAll(href);
    const t = escAll(m[1]);
    return { end: i + m[0].length, html: '<a href="' + h + '">' + t + '</a>' };
  }
  AUTOLINK_EMAIL_RE.lastIndex = i;
  m = AUTOLINK_EMAIL_RE.exec(src);
  if (m) {
    const text = escAll(m[1]);
    if (st.textMode) return { end: i + m[0].length, html: m[1] };
    return { end: i + m[0].length, html: '<a href="mailto:' + text + '">' + text + '</a>' };
  }
  return null;
}

// GFM extended autolink (www. / protocol / email) with backpedal.
// Sticky (no slice): group 1 = protocol/www prefix, group 2 = '@' for a
// bare email. mailto:/xmpp: carry no group. Backpedal applies to every
// alternative except the bare email.
const EMAIL_PAT = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_PAT_CAP = '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = new RegExp(
  '(?:mailto:' + EMAIL_PAT + '|xmpp:' + EMAIL_PAT + '(?:\\/[A-Za-z0-9@.]+)?)'
  + '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*'
  + '|' + EMAIL_PAT_CAP,
  'y'
);
function tryUrl(src, i, st) {
  URL_RE.lastIndex = i;
  const m = URL_RE.exec(src);
  if (!m) return null;
  let text;
  if (m[2] === '@') {
    // Bare email: no backpedal.
    text = m[0];
    if (st.textMode) return { end: i + text.length, html: text };
    const esc = escAll(text);
    return { end: i + text.length, html: '<a href="mailto:' + esc + '">' + esc + '</a>' };
  }
  text = m[0];
  let prev;
  do {
    prev = text;
    const b = BACKPEDAL.exec(text);
    text = b ? b[0] : '';
  } while (prev !== text);
  if (!text) return null;
  if (st.textMode) return { end: i + text.length, html: text };
  const esc = escAll(text);
  const href = cleanUrl(m[1] === 'www.' ? 'http://' + text : text);
  const h = href == null ? esc : escAll(href);
  return { end: i + text.length, html: '<a href="' + h + '">' + esc + '</a>' };
}

// Strip trailing backslashes (marked's helper for link destinations).
function stripTrailingBackslashes(s) {
  let i = s.length;
  while (i > 0 && s[i - 1] === '\\') i--;
  return s.slice(0, i);
}

// Inline tag / autolink (for the Be check on link labels).
const INLINE_TAG_RE = /^(?:<!--(?!>)[\s\S]*?-->|<\/?[A-Za-z][^<>]*\/?>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)/;
const INLINE_AUTOLINK_RE = /^(?:<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*>|<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>)/;

// Does the link label contain an unclosed '<' (a tag/autolink that runs
// past the end of the label)? If so the link is invalid.
function labelHasUnclosedTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      INLINE_CODE_RE.lastIndex = s;
      const cs = INLINE_CODE_RE.exec(label);
      if (cs) { s += cs[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const tag = INLINE_TAG_RE.exec(rest) || INLINE_AUTOLINK_RE.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

function parenBalance(str) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Inline link / reflink / nolink. Returns {end, html} or null.
// An unresolved reflink/nolink emits only its first char as text
// (firstChar: true). A link whose text contains a nested link is dropped
// (renderLink returns null) — the caller then treats '[' as text.
function tryLink(src, i, st) {
  const isImage = src[i] === '!';
  const at = isImage ? i + 1 : i;
  if (src[at] !== '[') return null;
  // Inline link.
  INLINE_LINK_RE.lastIndex = at;
  let m = INLINE_LINK_RE.exec(src);
  if (m) {
    if (labelHasUnclosedTag(src, m[1], at + 1)) return null;
    let raw = m[0];
    let href = m[2];
    let title = m[3] == null ? '' : m[3];
    const s = href.trim();
    if (s.startsWith('<')) {
      if (!s.endsWith('>')) return null;
      const l = stripTrailingBackslashes(s.slice(0, -1));
      if ((s.length - l.length) % 2 === 0) return null;
    } else {
      const l = parenBalance(href);
      if (l === -2) return null;
      if (l > -1) {
        const h = 4 + m[1].length + l;
        href = href.substring(0, l);
        raw = raw.substring(0, h).trim();
        title = '';
      }
    }
    const r = stripTrailingBackslashes(raw.slice(0, -1));
    if ((raw.length - r.length) % 2 === 0) return null;
    href = href.trim();
    if (href.startsWith('<')) href = href.replace(/^<(.*)>$/, '$1');
    href = unescapePunct(href);
    title = title ? unescapePunct(title.slice(1, -1)) : '';
    const out = renderLink(m[1], href, title, isImage, st);
    if (out != null) return { end: at + raw.length, html: out };
    return null;
  }
  // Reflink: [text][ref].
  REFLINK_RE.lastIndex = at;
  m = REFLINK_RE.exec(src);
  if (m) {
    if (labelHasUnclosedTag(src, m[1], at + 1)) return null;
    const link = st.links[normalizeLabel(m[2])];
    if (link) {
      const out = renderLink(m[1], link.href, link.title || '', isImage, st);
      if (out != null) return { end: at + m[0].length, html: out };
      return null;
    }
    return { end: i + 1, html: null, firstChar: true };
  }
  // Nolink: [text] or [text][].
  NOLINK_RE.lastIndex = at;
  m = NOLINK_RE.exec(src);
  if (m) {
    if (labelHasUnclosedTag(src, m[1], at + 1)) return null;
    const link = st.links[normalizeLabel(m[1])];
    if (link) {
      const out = renderLink(m[1], link.href, link.title || '', isImage, st);
      if (out != null) return { end: at + m[0].length, html: out };
      return null;
    }
    return { end: i + 1, html: null, firstChar: true };
  }
  return null;
}

// Render one link/image. The link text has \[ and \] unescaped first.
// Returns the HTML string, or null if this link must be dropped (its text
// contained a nested link).
function renderLink(label, dest, title, isImage, st) {
  const text = label.replace(/\\([\[\]])/g, '$1');
  const href = cleanUrl(dest);
  const titleAttr = title ? ' title="' + escKeepEntity(title) + '"' : '';
  if (isImage) {
    const alt = inlineText(text, st);
    if (st.textMode) return alt;
    if (href == null) return escKeepEntity(alt);
    return '<img src="' + escKeepEntity(href) + '" alt="' + escKeepEntity(alt) + '"' + titleAttr + '>';
  }
  // Link: tokenize the text; if a nested link is emitted, drop this link.
  const prevInLink = st.inLink;
  const prevEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineRun(text, st);
  const nested = st.linkEmitted;
  st.inLink = prevInLink;
  st.linkEmitted = prevEmitted;
  if (nested) return null;
  st.linkEmitted = true;
  if (st.textMode) return inner;
  if (href == null) return inner;
  return '<a href="' + escKeepEntity(href) + '"' + titleAttr + '>' + inner + '</a>';
}

// Render inline content as plain text (for image alt text): the text
// renderer — tags kept as-is, formatting stripped, no escaping (the caller
// escapes once).
function inlineText(src, st) {
  const sub = { links: st.links, inLink: st.inLink, inRawBlock: false, linkEmitted: false, textMode: true };
  return inlineRun(src, sub);
}

// Flush the accumulated text buffer into out (decode + escape, or just
// decode in text mode).
function flushText(out, txt, st) {
  if (!txt) return;
  let t = txt;
  if (!st.inRawBlock) t = decodeNumericRefs(t);
  out.push(st.textMode ? t : escKeepEntity(t));
}

// The main inline loop. Returns the HTML for one inline run.
function inlineRun(src, st) {
  const n = src.length;
  if (n === 0) return '';
  const out = [];
  let txt = '';
  let txtStartPrev = '';
  let prevChar = '';
  let keepPrev = false;
  let masked = null;
  const needMasked = () => {
    if (masked === null) {
      masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src, st.links) : src;
    }
    return masked;
  };
  let i = 0;
  while (i < n) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    const c = src[i];
    // Escape.
    if (c === '\\') {
      if (i + 1 < n && isAsciiPunct(src[i + 1])) {
        flushText(out, txt, st); txt = '';
        out.push(st.textMode ? src[i + 1] : escKeepEntity(src[i + 1]));
        i += 2;
        continue;
      }
      // Backslash before newline is a br candidate (handled below).
    }
    // Tag.
    if (c === '<') {
      const tg = tryTag(src, i, st);
      if (tg) {
        flushText(out, txt, st); txt = '';
        out.push(tg.html);
        i = tg.end;
        continue;
      }
      const al = tryAutolink(src, i, st);
      if (al) {
        flushText(out, txt, st); txt = '';
        out.push(al.html);
        i = al.end;
        continue;
      }
    }
    // Link / reflink / nolink.
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const lk = tryLink(src, i, st);
      if (lk) {
        if (lk.firstChar) {
          // Unresolved reflink: its first char is text.
          txtStartPrev = prevChar;
          txt += src[i];
          prevChar = src[i];
          keepPrev = true;
          i = lk.end;
          continue;
        }
        flushText(out, txt, st); txt = '';
        out.push(lk.html);
        i = lk.end;
        continue;
      }
    }
    // Emphasis / strong.
    if (c === '*' || c === '_') {
      const em = tryEmStrong(src, i, needMasked(), st, prevChar);
      if (em) {
        flushText(out, txt, st); txt = '';
        out.push(em.html);
        i = em.end;
        continue;
      }
    }
    // Codespan.
    if (c === '`') {
      const cs = tryCodespan(src, i, st);
      if (cs) {
        flushText(out, txt, st); txt = '';
        out.push(cs.html);
        i = cs.end;
        continue;
      }
      // A backtick run that opens no code span is literal text in full:
      // marked never retries inside the run (```foo`` stays literal).
      let e = i + 1;
      while (e < n && src[e] === '`') e++;
      txtStartPrev = prevChar;
      txt += src.slice(i, e);
      i = e;
      prevChar = '`';
      keepPrev = true;
      continue;
    }
    // Hard break (two spaces + newline, or backslash + newline).
    if (c === ' ' || c === '\\') {
      const br = tryBr(src, i, st);
      if (br) {
        flushText(out, txt, st); txt = '';
        out.push(br.html);
        i = br.end;
        continue;
      }
    }
    // Strikethrough.
    if (c === '~') {
      const dl = tryDel(src, i, needMasked(), st);
      if (dl) {
        flushText(out, txt, st); txt = '';
        out.push(dl.html);
        i = dl.end;
        continue;
      }
    }
    // Extended autolink (www. / protocol / email). Never inside a link
    // label (marked disables bare-URL tokenizing while inLink is set).
    if (!st.inLink && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'x' || isEmailCh(c))) {
      const u = tryUrl(src, i, st);
      if (u) {
        flushText(out, txt, st); txt = '';
        out.push(u.html);
        i = u.end;
        continue;
      }
    }
    // Text run.
    txtStartPrev = prevChar;
    const end = textRunEnd(src, i, n, i);
    if (end === i) {
      // A lone special char that no tokenizer took: consume one char.
      txt += src[i];
      i++;
    } else {
      txt += src.slice(i, end);
      i = end;
    }
    // prevChar for the next token: last char of this text chunk, unless
    // it ends with '_' (then the previous prevChar is kept).
    if (txt && txt[txt.length - 1] !== '_') prevChar = txt[txt.length - 1];
    else prevChar = txtStartPrev;
    keepPrev = true;
  }
  flushText(out, txt, st);
  return out.join('');
}

// ---------- block helpers ----------

// Indentation width of a line, expanding tabs to the next multiple of 4
// from the given column. Returns -1 for a blank line (so callers can
// distinguish a blank line from a zero-indent line).
function indentOf(line, startCol) {
  let col = startCol;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else return col;
  }
  return -1;
}

function isBlankLine(line) {
  return !/[^\t ]/.test(line);
}

// Strip up to n spaces/tabs of indentation (tab expands to spaces) from a
// line, as CommonMark does when it removes block indentation: the leading
// whitespace is expanded to spaces first, so a tab straddling the boundary
// leaves the right number of spaces behind.
function stripIndent(line, n) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const expanded = expandTabs(line.slice(0, i), 0);
  const rest = line.slice(i);
  if (expanded.length <= n) return rest;
  return expanded.slice(n) + rest;
}

// Expand tabs to spaces from the given column (marked's J()).
function expandTabs(str, col) {
  if (!str.includes('\t')) return str;
  let out = '';
  let c = col;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Backslash-unescape punctuation (and & into a numeric reference so it is
// not re-decoded as an entity). Used for link destinations and titles.
function unescapePunct(str) {
  return str.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]^_`{|}~])/g, (m, c) => {
    if (c === '&') return '&#38;';
    return c;
  });
}

// ---------- link reference definitions ----------

// marked's definition pattern: [label]: <dest> "title" — the title may be
// on the next line; a single-quoted title may not contain a blank line.
const DEF_RE = new RegExp(
  '^\\s*\\[((?:\\\\[\\s\\S]|[^\\]])+)\\]:[ \\t]*\\n?[ \\t]*'
  + '(?:<(?:\\\\.|[^\\n<>\\\\])*>|[^ \\t\\n\\x00-\\x1f<][^ \\t\\n\\x00-\\x1f]*)'
  + '(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)'
  + '("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)))?'
  + '[ \\t]*(?=\\n|$)',
  'y'
);

// Try to read a link reference definition starting at lines[i].
// Returns {end, label, href, title} (end = index past the last line used),
// or null.
function tryLinkDef(lines, i) {
  // No single-line pre-check: the label may span lines ('[\nfoo\n]: /url').
  // The definition may span up to 6 lines (a multi-line title, ex. 196).
  const seg = lines.slice(i, i + 6).join('\n');
  DEF_RE.lastIndex = 0;
  const d = DEF_RE.exec(seg);
  if (!d) return null;
  const label = d[1];
  if (!label || !label.trim()) return null;
  // Labels normalize (leading/trailing whitespace and newlines collapse
  // away: '[foo ]:', '[ foo]:' and '[\nfoo\n]:' are all valid defs).
  // A label with an unescaped '[' inside is invalid.
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '\\') { k++; continue; }
    if (label[k] === '[') return null;
  }
  const rawLines = seg.slice(0, d[0].length).split('\n');
  const end = i + rawLines.length;
  // Extract the destination: everything between ']:' and the title.
  const after = d[0].slice(d[0].indexOf(']:') + 2);
  const rest = after.trimStart();
  let href;
  if (rest[0] === '<') {
    const close = rest.indexOf('>');
    href = rest.slice(1, close);
  } else {
    const endIdx = rest.search(/[ \t\n]/);
    href = endIdx === -1 ? rest : rest.slice(0, endIdx);
  }
  href = unescapePunct(href);
  const title = d[2] ? unescapePunct(d[2].slice(1, -1)) : '';
  return { end, label: normalizeLabel(label), href, title };
}

// ---------- ATX / setext / hr / fence ----------

// ATX heading: ^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$).
// A closing sequence of #'s is stripped only when the text before it is
// empty or ends with a space/tab (or the whole text is #'s).
function tryATX(line) {
  const m = /^( {0,3})(#{1,6})(?:[ \t]+|[ \t]*$)(.*)$/.exec(line);
  if (!m) return null;
  const level = m[2].length;
  let text = m[3];
  if (/#[ \t]*$/.test(text)) {
    const s = text.replace(/#+[ \t]*$/, '');
    if (!s || /[ \t]$/.test(s)) text = s.trim();
  }
  return { level, text: text.trim() };
}

// Setext underline: ^ {0,3}(=+|-+)[ \t]*$ — level 1 for =, 2 for -.
// A '-' line that could be a list item is not a setext underline.
function setextLevel(line, prevText) {
  const m = /^( {0,3})(=+|-+)[ \t]*$/.exec(line);
  if (!m) return 0;
  if (m[2][0] === '-' && /^( {0,3})(?:[*+-]|1[.)])[ \t]/.test(prevText)) return 0;
  return m[2][0] === '=' ? 1 : 2;
}

// Horizontal rule: 3+ of -, _, or * (each optionally followed by spaces/tabs).
function isHR(line) {
  return /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:[ \t]*)$/.test(line);
}

// Fence opening: ^ {0,3}(`{3,}|~{3,})(.*)$ — an info string for backtick
// fences may not contain a backtick.
function fenceOpen(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const ch = m[2][0];
  const info = m[3];
  if (ch === '`' && info.includes('`')) return null;
  return { indent: m[1].length, ch, len: m[2].length, info: info.trim() };
}

function fenceClose(line, ch, len) {
  const m = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!m || m[2][0] !== ch || m[2].length < len) return false;
  return true;
}

// ---------- HTML blocks ----------

// The block-tag list (CommonMark kinds 6-7), plus pre/script/style/textarea.
const BLOCK_TAG_NAMES = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;

// An HTML tag with marked's strict attribute grammar (used for kinds 7/8).
const STRICT_TAG = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/;

// Which HTML-block kind (1-7) starts at this line, or 0.
// Kind 1: pre/script/style/textarea open. Kind 2: comment. Kind 3: ?.
// Kind 4: declaration. Kind 5: CDATA. Kind 6: a block tag (open or close).
// Kind 7: a complete open tag (any tag) alone on the line.
function htmlBlockKind(line) {
  const s = line.replace(/^ {0,3}/, '');
  if (/^<(pre|script|style|textarea)(\s|>|\/>|$)/i.test(s)) return 1;
  if (/^<!--/.test(s)) return 2;
  if (/^<\?/.test(s)) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (/^<!\[CDATA\[/.test(s)) return 5;
  const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|\/?>|$)/.exec(s);
  if (tm) {
    if (BLOCK_TAG_NAMES.test(tm[1])) return 6;
    // Kind 7: the whole line is one complete tag — open OR close
    // ('</ins>' alone is an HTML block; a lone close tag counts).
    const tag = STRICT_TAG.exec(s);
    if (tag && tag[0].length === s.trimEnd().length) return 7;
    if (/^<\/[A-Za-z][A-Za-z0-9-]*\s*>$/.test(s.trimEnd())) return 7;
  }
  return 0;
}

// When does an HTML block of the given kind end? Returns true if this
// line ends the block (the line is included).
function htmlBlockEnds(line, kind) {
  if (kind === 1) return /<\/(pre|script|style|textarea)>/i.test(line);
  if (kind === 2) return /-->/.test(line);
  if (kind === 3) return /\?>/.test(line);
  if (kind === 4) return />/.test(line);
  if (kind === 5) return /\]\]>/.test(line);
  if (kind === 6 || kind === 7) return isBlankLine(line);
  return false;
}

// ---------- block readers ----------

// Fenced code. Returns {end, raw, text, lang} — end is the index past the
// closing fence (or the last content line). The text is the content lines
// joined with '\n', plus a trailing '\n' only when there is at least one
// line and the last line is non-blank.
function readFenced(lines, i, f) {
  const content = [];
  let j = i + 1;
  let closed = false;
  while (j < lines.length) {
    const line = lines[j];
    if (fenceClose(line, f.ch, f.len)) { closed = true; j++; break; }
    // marked's fence indent compensation: strip at most f.indent leading
    // whitespace CHARACTERS (not columns) per line; with indent 0 the
    // content is untouched, so tabs survive verbatim. Backtick fences
    // only: marked does NOT dedent tilde-fence content by the fence
    // indent (a `~~~` fence at 3 spaces keeps the 3 spaces in content).
    const wm = f.ch === '`' ? /^[ \t]+/.exec(line) : null;
    const strip = wm ? Math.min(wm[0].length, f.indent) : 0;
    content.push(strip ? line.slice(strip) : line);
    j++;
  }
  // Trailing blank lines are dropped only when the fence is unterminated
  // (runs to EOF): marked strips them there, but a closed fence keeps
  // all but one trailing newline (codeTrail3: two blanks before the
  // close stay as two trailing \n in the text).
  if (!closed) {
    while (content.length > 0 && isBlankLine(content[content.length - 1])) content.pop();
  }
  let text = content.join('\n');
  if (content.length > 0 && content[content.length - 1] !== '') text += '\n';
  return { end: j, text, closed, lang: f.info };
}

// Indented code: lines indented 4+ (or a tab), including blank lines in
// between. Each line loses 1-4 spaces (or <=3 spaces + a tab). A blank
// line keeps its indentation minus 4 (so 6 spaces stay 2 spaces).
// Trailing blank lines are dropped.
function readIndentedCode(lines, i) {
  const rawLines = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // A blank line belongs to the code block only if a code line follows.
      let k = j + 1;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      if (k >= lines.length) break;
      const ind = indentOf(lines[k], 0);
      if (ind < 4) break;
      rawLines.push(line);
      j++;
      continue;
    }
    const ind = indentOf(line, 0);
    if (ind < 4) break;
    rawLines.push(line);
    j++;
  }
  // Drop trailing blank lines.
  while (rawLines.length > 0 && isBlankLine(rawLines[rawLines.length - 1])) rawLines.pop();
  // marked's codeRemoveIndent: strip ONE tab (with 0-3 spaces) or 1-4
  // spaces; a second tab survives as a literal tab (expand-then-strip
  // would wrongly turn it into spaces).
  const textLines = rawLines.map((line) => line.replace(/^(?: {0,3}\t| {1,4})/, ''));
  return { end: j, text: textLines.join('\n') + '\n' };
}

// HTML block: from lines[i], kind already known. Returns {end, text}.
function readHtmlBlock(lines, i, kind) {
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (kind === 6 || kind === 7) {
      // Blank line ends it (not included).
      if (j > i && isBlankLine(line)) break;
      j++;
      continue;
    }
    // Kinds 1-5 end on the first line containing the end marker,
    // start line included (e.g. a one-line <!-- ... --> comment).
    j++;
    if (htmlBlockEnds(line, kind)) break;
  }
  return { end: j, text: lines.slice(i, j).join('\n') };
}

// Strip one blockquote marker ('>' plus up to 3 leading spaces) from a
// line. The whitespace after '>' is expanded to spaces (columns from the
// marker's end, as marked does with J()) and one column is dropped for
// the optional space after '>'. Returns the content line, or null if the
// line has no marker.
function stripBqMarker(line) {
  const m = /^ {0,3}>/.exec(line);
  if (!m) return null;
  const markerCol = m[0].length;
  const rest = line.slice(markerCol);
  let i = 0;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  const spaces = expandTabs(rest.slice(0, i), markerCol);
  const after = spaces.length > 0 ? spaces.slice(1) : '';
  return after + rest.slice(i);
}

// Strip one level of blockquote markers from lines[i..j), returning
// {content, lazy} — content lines and the set of indices (into content)
// that were taken without a marker (lazy continuation lines).
// A line whose first non-space char is '>' loses the marker; a line that
// is not a quote line is taken as-is (lazy) unless it is blank (which is
// also lazy but keeps its blankness).
function blockquoteStrip(lines, i, j, outerLazy) {
  const content = [];
  const lazy = new Set();
  for (let k = i; k < j; k++) {
    const line = lines[k];
    const stripped = stripBqMarker(line);
    if (stripped !== null) {
      content.push(stripped);
    } else if (outerLazy && outerLazy.has(k)) {
      content.push(line);
      lazy.add(content.length - 1);
    } else if (isBlankLine(line)) {
      content.push('');
      lazy.add(content.length - 1);
    } else {
      content.push(line);
      lazy.add(content.length - 1);
    }
  }
  return { content, lazy };
}

// Does this line start a block that interrupts a paragraph?
// (heading, fence, hr, html block, list, table delimiter line, blockquote)
function interruptsParagraph(line, prevText, inList) {
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return true;
  if (setextLevel(line, prevText)) return true;
  if (fenceOpen(line)) return true;
  if (isHR(line)) return true;
  const hk = htmlBlockKind(line);
  if (hk && hk !== 7) return true;
  if (/^ {0,3}>/.test(line)) return true;
  // A list marker interrupts a paragraph only when its item is not empty
  // (an empty item cannot interrupt: 'foo\n*\n' stays one paragraph) and,
  // for ordered lists, the start number is 1.
  const mi = markerInfo(line);
  if (mi && !mi.empty && (mi.type === 'bullet' || mi.start === 1 || inList)) return true;
  return false;
}

// Does a line (after stripping blockquote and list markers recursively)
// end in paragraph text? Used to decide whether a lazy line continues a
// paragraph (and so whether the outer blockquote/list continues).
function endsInParagraph(line) {
  let s = line;
  for (;;) {
    const bq = /^ {0,3}> ?/.exec(s);
    if (bq) { s = s.slice(bq[0].length); continue; }
    const li = /^( {0,3})(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|[ \t]*$)/.exec(s);
    if (li) {
      const after = s.slice(li[0].length);
      if (after === '' || isBlankLine(after)) return false;
      s = after;
      continue;
    }
    break;
  }
  if (isBlankLine(s)) return false;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(s)) return false;
  if (fenceOpen(s)) return false;
  if (isHR(s)) return false;
  const hk = htmlBlockKind(s);
  if (hk && hk !== 7) return false;
  if (/^ {0,3}(?:[*+-]|1[.)])(?:[ \t]|$)/.test(s)) return false;
  if (/^ {0,3}[-:][ \t]*\|/.test(s)) return false;
  return true;
}

// Classify a blockquote content line for paragraph tracking: does the
// content end in an open paragraph after this line? (A list item line
// counts: the item's paragraph is open. A fence/heading/hr/html/code
// line does not. A setext underline is a heading only after plain
// paragraph text; after a list item it is plain text.)
function bqLineEndsPara(s, prevPlain) {
  let t = s;
  for (;;) {
    const m = /^ {0,3}> ?/.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  if (isBlankLine(t)) return { endsPara: false, plain: false };
  if (indentOf(t, 0) >= 4) return { endsPara: false, plain: false };
  if (fenceOpen(t)) return { endsPara: false, plain: false };
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(t)) return { endsPara: false, plain: false };
  if (isHR(t)) return { endsPara: false, plain: false };
  if (/^ {0,3}(=+|-+)[ \t]*$/.test(t)) {
    return prevPlain ? { endsPara: false, plain: false } : { endsPara: true, plain: true };
  }
  if (isTableDelim(t)) return { endsPara: false, plain: false };
  if (htmlBlockKind(t)) return { endsPara: false, plain: false };
  const li = /^( {0,3})(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|[ \t]*$)/.exec(t);
  if (li) {
    const after = t.slice(li[0].length);
    if (after === '' || isBlankLine(after)) return { endsPara: false, plain: false };
    const inner = bqLineEndsPara(after, false);
    return { endsPara: inner.endsPara, plain: false };
  }
  return { endsPara: true, plain: true };
}

// Read a blockquote starting at lines[i]. Returns {end, content, lazy}.
// The blockquote continues while lines are quote lines or lazy lines that
// continue the inner content; it stops at a fence/html boundary inside.
function readBlockquote(lines, i, outerLazy) {
  const content = [];
  const lazy = new Set();
  let j = i;
  let fence = null;
  let htmlKind = 0;
  let blankSince = false; // last content line was blank (a '>'-only line)
  let endsPara = false; // content ends in an open paragraph (recursively)
  let prevPlain = false; // previous content line was plain paragraph text
  while (j < lines.length) {
    const line = lines[j];
    const stripped = stripBqMarker(line);
    if (stripped !== null) {
      let rest = stripped;
      content.push(rest);
      blankSince = isBlankLine(rest);
      // Track fence / html state on the stripped line.
      if (fence) {
        if (fenceClose(rest, fence.ch, fence.len)) fence = null;
      } else if (htmlKind) {
        if (htmlBlockEnds(rest, htmlKind)) htmlKind = 0;
      } else {
        const fo = fenceOpen(rest);
        if (fo) fence = fo;
        else {
          const hk = htmlBlockKind(rest);
          if (hk) htmlKind = hk;
        }
      }
      if (blankSince || fence || htmlKind) {
        endsPara = false;
        prevPlain = false;
      } else {
        const c = bqLineEndsPara(rest, prevPlain);
        endsPara = c.endsPara;
        prevPlain = c.plain;
      }
      j++;
      continue;
    }
    // Not a quote line: lazy continuation?
    const isOuterLazy = outerLazy && outerLazy.has(j);
    if (isBlankLine(line)) {
      // A truly blank line (no '>' marker) always ends the blockquote,
      // even mid-fence: '> foo\n\n> bar' is TWO blockquotes. A line
      // with just '>' is handled by the marker branch above.
      break;
    }
    if (fence || htmlKind) break; // inside a fence/html block: stop
    // A lazy line continues the quote only if the content ends in an open
    // paragraph (after code/heading the quote is over: '>     foo\nbar'
    // puts bar outside). A lazy list-marker line never continues it —
    // it starts a new list outside ('> - foo\n- bar', '> foo\n  - bar').
    // A lazy line loses 4 indent columns only when it has 4 or more;
    // 1-3 leading spaces are kept ('> foo\n bar' stays ' bar').
    if (!blankSince && endsPara && (isOuterLazy || endsInParagraph(line))) {
      if (!isOuterLazy && /^ {0,3}(?:[*+-]|1[.)])(?:[ \t]|$)/.test(line)) break;
      content.push(indentOf(line, 0) >= 4 ? stripIndent(line, 4) : line);
      lazy.add(content.length - 1);
      blankSince = false;
      prevPlain = true;
      j++;
      continue;
    }
    break;
  }
  // marked's blockquoteSetextReplace: a setext-looking line inside the
  // quote gets 4 spaces prepended so it stays paragraph text, never a
  // heading ('> foo\nbar\n===' renders '    ===' inside the <p>).
  const fixed = content.join('\n').replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1').split('\n');
  return { end: j, content: fixed, lazy };
}

// Split a table row line into cells (a leading/trailing pipe is optional;
// a cell may contain an escaped pipe or a pipe inside a code span).
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      continue;
    }
    if (c === '`') {
      // Code span: pipes inside do not split.
      const m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(s.slice(i));
      if (m) { cur += m[0]; i += m[0].length - 1; continue; }
      cur += c;
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableDelim(line) {
  if (!line.includes('|') && !/[-:]/.test(line)) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

// Try to read a table starting at lines[i]. Returns {end, header, aligns,
// rows} or null.
function tryTable(lines, i) {
  if (!lines[i].includes('|')) return null;
  if (i + 1 >= lines.length) return null;
  const header = splitTableRow(lines[i]);
  const delim = splitTableRow(lines[i + 1]);
  if (delim.length !== header.length) return null;
  if (!delim.every((c) => /^:?-+:?$/.test(c))) return null;
  const aligns = delim.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    // A row ends the table only on an empty or spaces-only line. A line
    // holding only a tab is a row of empty cells (marked's table regex
    // excludes ` *\n` lines but a tab line matches as a row).
    if (/^ *$/.test(line)) break;
    if (isHR(line)) break;
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) break;
    if (/^ {0,3}>/.test(line)) break;
    if (indentOf(line, 0) >= 4) break;
    if (fenceOpen(line)) break;
    if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) break;
    if (htmlBlockKind(line)) break;
    rows.push(splitTableRow(line));
    j++;
  }
  return { end: j, header, aligns, rows };
}

// Read a paragraph starting at lines[i] (i is not blank).
// lazy: indices (into lines) that are lazy continuation lines — they never
// break the paragraph, except that a lazy line starting a table or (inside
// a blockquote) a kind-7 HTML block is a new block. bqLazy is true when
// these lines are a blockquote's content. Returns {end, text, raw}.
function readParagraph(lines, i, lazy, bqLazy, inList) {
  const parts = [lines[i]];
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // A whitespace-only line at the very end (no newline follows it in
      // the source) is paragraph text, not a break: '> foo\n>  \n'
      // renders '<p>foo\n </p>'. A blank line anywhere else breaks.
      if (line !== '' && j === lines.length - 1) {
        parts.push(line);
        j++;
      }
      break;
    }
    // A table header starts a new block, even on a lazy line.
    if (tryTable(lines, j)) break;
    const isLazy = lazy && lazy.has(j);
    if (!isLazy) {
      if (interruptsParagraph(line, parts[parts.length - 1], inList)) break;
      // A def line is paragraph text (and does not register a link).
    } else if (bqLazy && htmlBlockKind(line) === 7) {
      // In a blockquote, a lazy kind-7 HTML line is a new HTML block.
      break;
    }
    parts.push(line);
    j++;
  }
  const raw = parts.join('\n');
  return { end: j, text: raw, raw };
}

// ---------- lists ----------

// Parse a list marker at the start of a line (up to 3 leading spaces).
// Returns {type, marker, contentIndent, content, empty, start} or null.
// The marker must be followed by a space, a tab, or end of line. The
// content is the first line's text after the marker, with the leading
// whitespace expanded to spaces (columns from the marker's end) and the
// content indent removed — exactly as marked does with J(): the indent is
// the expanded leading-space count, capped so that 5+ spaces consume only
// 1. contentIndent is that count plus the marker column.
function markerInfo(line) {
  const m = /^( {0,3})([*+-]|\d{1,9}[.)])(.*)$/.exec(line);
  if (!m) return null;
  const lead = m[1].length;
  const marker = m[2];
  const rest = m[3];
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  const markerCol = lead + marker.length;
  let col = markerCol;
  let i = 0;
  let spaces = '';
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) {
    if (rest[i] === ' ') { spaces += ' '; col++; i++; }
    else { const w = 4 - (col % 4); spaces += ' '.repeat(w); col += w; i++; }
  }
  const expanded = spaces + rest.slice(i);
  const type = /^[*+-]$/.test(marker) ? 'bullet' : 'ordered';
  const start = type === 'ordered' ? parseInt(marker.slice(0, -1), 10) : null;
  if (expanded.trim() === '') {
    return { type, marker, contentIndent: markerCol + 1, content: '', empty: true, start };
  }
  let r = 0;
  while (r < expanded.length && expanded[r] === ' ') r++;
  if (r > 4) r = 1;
  return { type, marker, contentIndent: r + markerCol, content: expanded.slice(r), empty: false, start };
}

// Does the item's content (so far) end in a paragraph? Only a paragraph
// can take a lazy continuation line.
// Does a block end in an open paragraph (recursively, through a
// blockquote or a list's last item)? A lazy line can only continue the
// paragraph when the innermost open block is one.
function blockEndsInPara(b) {
  if (!b) return false;
  if (b.type === 'para') return true;
  if (b.type === 'blockquote' && b.blocks.length > 0) return blockEndsInPara(b.blocks[b.blocks.length - 1]);
  if (b.type === 'list' && b.items.length > 0) {
    const last = b.items[b.items.length - 1];
    if (last.blocks.length > 0) return blockEndsInPara(last.blocks[last.blocks.length - 1]);
  }
  return false;
}

function itemEndsInPara(item, st) {
  if (item.content.length === 0) return false;
  const blocks = lexBlocks(item.content, item.lazy, st, false, true);
  if (blocks.length === 0) return false;
  return blockEndsInPara(blocks[blocks.length - 1]);
}

// Is this line a lazy paragraph continuation — paragraph text that does not
// start a block? A setext underline counts as lazy text (it never becomes
// a heading on a lazy line); a kind-7 HTML line counts as lazy text too
// (inside a list it stays in the paragraph).
function isLazyContinuation(line) {
  if (isBlankLine(line)) return false;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return false;
  if (fenceOpen(line)) return false;
  if (isHR(line)) return false;
  const hk = htmlBlockKind(line);
  if (hk && hk !== 7) return false;
  if (/^ {0,3}(?:[*+-]|1[.)])(?:[ \t]|$)/.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  return true;
}

// Read a list starting at lines[i]. Returns {end, ordered, start, items,
// loose}. Each item is {blocks, task, checked}.
function readList(lines, i, lazy, st) {
  const first = markerInfo(lines[i]);
  const ordered = first.type === 'ordered';
  const start = first.start;
  const markerCh = ordered ? first.marker.slice(-1) : first.marker;
  const items = [];
  let loose = false;
  let j = i;
  let cur = null;
  let pendingBlanks = 0;
  // Fence state inside the current item: an open fence consumes following
  // lines (even unindented) as code, until its closing fence — but only
  // while no blank line intervened AND the fence has already consumed at
  // least one indented content line. If the first line after the opener
  // is unindented, it does not belong to the item, so the fence stays
  // empty and the list ends ('1. foo\n\n   ```toml\nbar' -> empty fence,
  // 'bar' a top-level paragraph). Once a fence has content, later
  // unindented lines ARE swallowed ('   ~~~python\n   image\nmust...'
  // keeps 'must...' inside the fence).
  let fence = null;
  let fenceContent = false;
  const trackFence = (text) => {
    if (fence) {
      if (fenceClose(text, fence.ch, fence.len)) fence = null;
    } else {
      const fo = fenceOpen(text);
      if (fo) fence = fo;
    }
  };

  const startItem = (mi, lineIdx) => {
    if (cur) {
      if (pendingBlanks > 0) loose = true;
      items.push(cur);
    }
    pendingBlanks = 0;
    fence = null;
    fenceContent = false;
    const line = lines[lineIdx];
    const content = [];
    const lazySet = new Set();
    let task = false;
    let checked = false;
    let hasContent = false;
    if (!mi.empty) {
      let firstContent = mi.content;
      const tm = /^\[[ xX]\][ \t]+\S/.exec(firstContent);
      if (tm) {
        task = true;
        checked = firstContent[1] !== ' ';
        firstContent = firstContent.replace(/^\[[ xX]\][ \t]+/, '');
      }
      content.push(firstContent);
      trackFence(firstContent);
      hasContent = true;
    }
    cur = { content, lazy: lazySet, contentIndent: mi.contentIndent, task, checked, hasContent };
  };

  const addBlanks = () => {
    for (let k = 0; k < pendingBlanks; k++) cur.content.push('');
    pendingBlanks = 0;
  };

  startItem(first, i);
  j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (isBlankLine(line)) {
      pendingBlanks++;
      j++;
      continue;
    }
    const ind = indentOf(line, 0);
    const mi = markerInfo(line);
    // An open fence that already has content swallows the line as code
    // (lazy), no blank between. Without content yet, an unindented line
    // ends the item instead (see the fence-state comment above).
    if (fence && fenceContent && pendingBlanks === 0) {
      const pushed = ind >= cur.contentIndent ? stripIndent(line, cur.contentIndent) : line;
      cur.content.push(pushed);
      trackFence(pushed);
      cur.hasContent = true;
      j++;
      continue;
    }
    // A new item of the same list: same type, same marker char (bullets)
    // or delimiter (ordered), indent below the current content indent.
    // A thematic break ends the list instead of starting an item.
    if (mi && ind < cur.contentIndent) {
      if (isHR(line)) break;
      const sameType = mi.type === (ordered ? 'ordered' : 'bullet');
      const sameMark = ordered ? mi.marker.slice(-1) === markerCh : mi.marker === markerCh;
      if (sameType && sameMark) {
        startItem(mi, j);
        j++;
        continue;
      }
      break; // a different list: this list ends
    }
    // An empty item cannot take content after a blank line.
    if (pendingBlanks > 0 && !cur.hasContent) break;
    if (ind >= cur.contentIndent) {
      // Indented continuation: strip the content indent.
      // (Loose is NOT set here: a blank before this line may belong to
      // a nested sub-block; looseness is computed from the lexed item
      // blocks below, via blocks.blankBetween.)
      addBlanks();
      const pushed = stripIndent(line, cur.contentIndent);
      cur.content.push(pushed);
      // A line pushed while a fence is open is fence content, which
      // arms the unindented-swallow above for later lines.
      if (fence) fenceContent = true;
      trackFence(pushed);
      cur.hasContent = true;
      j++;
      continue;
    }
    // Unindented line: a lazy paragraph continuation — only if no blank
    // line intervened ('- foo\n\nbar' puts bar OUTSIDE the list, and a
    // link def after a blank line ends the list so it still registers).
    const isOuterLazy = lazy && lazy.has(j);
    if (pendingBlanks === 0 && (isOuterLazy || isLazyContinuation(line))) {
      if (!itemEndsInPara(cur, st)) break;
      addBlanks();
      cur.lazy.add(cur.content.length);
      // A lazy line is dedented by 4 columns when it has at least 4
      // columns of indent (marked strips a code-block indent); with less
      // indent the leading whitespace is kept verbatim: '17. X\n   Naïve'
      // keeps its 3 spaces, while '  1.  A paragraph\n    with two
      // lines.' loses 4. The line stays marked lazy so it remains
      // paragraph text even when it looks like a list marker.
      const li = indentOf(line, 0);
      cur.content.push(li >= 4 ? stripIndent(line, 4) : line);
      trackFence(line);
      cur.hasContent = true;
      j++;
      continue;
    }
    break;
  }
  if (cur) items.push(cur);
  const outItems = items.map((it) => ({
    blocks: lexBlocks(it.content, it.lazy, st, false, true),
    task: it.task,
    checked: it.checked,
  }));
  // Loose iff a blank line separates two items (startItem, above) or two
  // top-level blocks inside an item (blankBetween from its lexed blocks).
  if (outItems.some((it) => it.blocks.blankBetween > 0)) loose = true;
  // A list that ends while blank lines are pending must not swallow
  // them: they belong to the outer level (a blank between a nested list
  // and the next line makes the enclosing item loose). Rewind the end
  // to the first trailing blank so the outer lexer sees it.
  const end = j - pendingBlanks;
  return { end, ordered, start, items: outItems, loose };
}

// ---------- block lexer ----------

// Lex lines into blocks. lazy is a set of indices (into lines) that are
// lazy continuation lines; bqLazy is true when these lines are a
// blockquote's content (a lazy kind-7 HTML line is a new block there).
// st carries the link reference definitions.
function lexBlocks(lines, lazy, st, bqLazy, inList) {
  const blocks = [];
  blocks.blankBetween = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      // A blank run between two blocks at THIS level (counted once per
      // run). Blanks inside a nested list/fence never reach this loop,
      // so they don't count here — that is what makes a list tight
      // when the blank lives inside a sub-block (marked's rule).
      if (blocks.length > 0) {
        let k = i + 1;
        while (k < n && isBlankLine(lines[k])) k++;
        if (k < n) blocks.blankBetween++;
      }
      i++;
      continue;
    }
    const ind = indentOf(line, 0);
    if (ind >= 4) {
      const r = readIndentedCode(lines, i);
      blocks.push({ type: 'code', text: r.text, lang: '' });
      i = r.end;
      continue;
    }
    const f = fenceOpen(line);
    if (f) {
      const r = readFenced(lines, i, f);
      const lang = f.info ? f.info.split(/\s+/)[0] : '';
      blocks.push({ type: 'code', text: r.text, lang });
      i = r.end;
      continue;
    }
    const atx = tryATX(line);
    if (atx) {
      blocks.push({ type: 'heading', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const r = readBlockquote(lines, i, lazy);
      const inner = lexBlocks(r.content, r.lazy, st, true, false);
      blocks.push({ type: 'blockquote', blocks: inner });
      i = r.end;
      continue;
    }
    const mi = markerInfo(line);
    if (mi) {
      const r = readList(lines, i, lazy, st);
      blocks.push({ type: 'list', ordered: r.ordered, start: r.start, items: r.items, loose: r.loose });
      i = r.end;
      continue;
    }
    const hk = htmlBlockKind(line);
    if (hk) {
      const r = readHtmlBlock(lines, i, hk);
      // marked: trailing \n kept iff next line is non-blank, or the block
      // is last and the source ended with \n (final empty line element).
      // For kinds 6/7 the block ends at a blank line, and a
      // whitespace-only next line (tab/space) counts as blank, so no \n.
      // For kinds 1-5 the block ends at an end marker, where a tab-only
      // next line does NOT suppress the \n (comment/pre cases).
      const nextIsBlank = (hk === 6 || hk === 7) ? isBlankLine(lines[r.end]) : lines[r.end] === '';
      blocks.push({ type: 'html', text: r.text, nl: r.end < lines.length && (!nextIsBlank || r.end === lines.length - 1) });
      i = r.end;
      continue;
    }
    const def = tryLinkDef(lines, i);
    if (def) {
      // First definition wins (CommonMark): a later redefinition is ignored.
      if (!(def.label in st.links)) st.links[def.label] = { href: def.href, title: def.title };
      i = def.end;
      continue;
    }
    const tb = tryTable(lines, i);
    if (tb) {
      blocks.push({ type: 'table', header: tb.header, aligns: tb.aligns, rows: tb.rows });
      i = tb.end;
      continue;
    }
    const p = readParagraph(lines, i, lazy, bqLazy, inList);
    let end = p.end;
    let level = 0;
    if (end < n) {
      const lastLine = p.text.split('\n').pop();
      level = setextLevel(lines[end], lastLine);
    }
    if (level) {
      blocks.push({ type: 'heading', level, text: p.text.trim() });
      i = end + 1;
    } else {
      blocks.push({ type: 'para', text: p.text });
      i = end;
    }
  }
  return blocks;
}

// ---------- block rendering ----------

function inlineHtml(text, st) {
  const sub = { links: st.links, textMode: false, inLink: st.inLink, linkEmitted: false, inRawBlock: st.inRawBlock };
  const html = inlineRun(text, sub);
  // An <a> opened (and not closed) inside this inline run stays open for
  // later blocks: marked's lexer keeps inLink across blocks, so bare
  // URLs/emails after an unclosed <a> are not linkified.
  st.inLink = sub.inLink;
  st.inRawBlock = sub.inRawBlock;
  return html;
}

function renderBlocks(blocks, st, tight) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, st, tight);
  return out;
}

function renderList(b, st) {
  const tag = b.ordered ? 'ol' : 'ul';
  const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
  let out = '<' + tag + startAttr + '>\n';
  for (const item of b.items) {
    out += '<li>';
    const checkbox = item.task
      ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
      : '';
    if (item.blocks.length === 0) {
      out += checkbox + '</li>\n';
      continue;
    }
    if (!b.loose) {
      // Tight list: the checkbox goes before the first block and
      // paragraphs render bare (no <p>).
      if (checkbox) out += checkbox;
      out += renderBlocks(item.blocks, st, true);
    } else if (checkbox && item.blocks[0].type === 'para') {
      // Loose list: the checkbox goes inside the first paragraph.
      out += '<p>' + checkbox + inlineHtml(item.blocks[0].text, st) + '</p>\n';
      out += renderBlocks(item.blocks.slice(1), st, false);
    } else if (checkbox) {
      // Loose list, first block is not a paragraph: the checkbox gets
      // its own paragraph.
      out += '<p>' + checkbox + '</p>\n';
      out += renderBlocks(item.blocks, st, false);
    } else {
      out += renderBlocks(item.blocks, st, false);
    }
    out += '</li>\n';
  }
  out += '</' + tag + '>\n';
  return out;
}

function renderBlock(b, st, tight) {
  switch (b.type) {
    case 'para': {
      const html = inlineHtml(b.text, st);
      return tight ? html : '<p>' + html + '</p>\n';
    }
    case 'heading':
      return '<h' + b.level + '>' + inlineHtml(b.text, st) + '</h' + b.level + '>\n';
    case 'code': {
      const cls = b.lang ? ' class="language-' + escKeepEntity(unescapePunct(b.lang)) + '"' : '';
      return '<pre><code' + cls + '>' + escAll(b.text) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'html':
      return b.text + (b.nl ? '\n' : '');
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(b.blocks, st, false) + '</blockquote>\n';
    case 'list':
      return renderList(b, st);
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.header.length; c++) {
        const a = b.aligns[c];
        out += a ? '<th align="' + a + '">' : '<th>';
        out += inlineHtml(b.header[c], st) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let c = 0; c < b.header.length; c++) {
            const a = b.aligns[c];
            const cell = c < row.length ? row[c] : '';
            out += a ? '<td align="' + a + '">' : '<td>';
            out += inlineHtml(cell, st) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}

// ---------- entry point ----------

// Render markdown to exactly the HTML marked 18.1.3 produces with its
// default options (GFM on, breaks off). Each call renders its input alone.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const st = { links: {}, textMode: false, inLink: false, linkEmitted: false, inRawBlock: false };
  const blocks = lexBlocks(lines, null, st, false, false);
  return renderBlocks(blocks, st, false);
}
