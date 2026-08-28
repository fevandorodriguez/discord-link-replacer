import { matchRule, normaliseHost } from './rules.js';

// Restricted to the RFC 3986 URI character set (unreserved + reserved + "%").
// That set is exactly what survives `new URL(x).toString()` unchanged, so a
// match is guaranteed to round-trip: nothing the author typed can be silently
// percent-encoded or substituted. A broader pattern swallows adjacent text —
// emoji, CJK, smart quotes, `{`, `}`, `"`, `\` — into the URL, re-serialises it,
// and (because handleMessage then deletes the original) destroys it. Truncating
// at the first out-of-set character is strictly safer: the tail stays verbatim
// via the span arithmetic below and the truncated prefix still rewrites.
//
// It also keeps the properties the earlier delimiter-specific pattern had:
// < and > are excluded, so an author-suppressed <https://...> link is
// detectable from the characters either side of the match; backtick and pipe
// are excluded, so no match can begin outside a masked region and end inside
// one, which is what makes the start-only check in isMasked sufficient.
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

const TRACKING_PARAMS = new Set(['s', 't', 'si', 'igsh', 'igshid', 'fbclid', 'ref_src', 'ref_url']);
// Punctuation that ends a sentence rather than a URL.
const TRAILING_PUNCTUATION = /[.,;:!?'"\]}]+$/;

function trimTrailing(raw) {
  let url = raw.replace(TRAILING_PUNCTUATION, '');
  // Only treat a closing paren as punctuation when the URL has no opening one.
  while (url.endsWith(')') && !url.includes('(')) {
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }
  return url;
}

function stripTracking(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) url.searchParams.delete(key);
  }
}

// Regions whose contents Discord renders literally, or that the author has
// explicitly opted out of embedding. Fenced blocks are matched first so a
// stray backtick inside one cannot open an inline-code region. These patterns
// are heuristic over unbalanced-delimiter input (e.g. a stray backtick can
// over-match across code fences), but fail safely by over-masking (skipping
// rewrites rather than corrupting content).
const MASK_PATTERNS = [
  /```[\s\S]*?```/g,   // fenced code block
  /`[^`\n]*`/g,        // inline code
  /\|\|[\s\S]*?\|\|/g, // spoiler
];

function maskedRanges(content) {
  const ranges = [];
  for (const pattern of MASK_PATTERNS) {
    for (const m of content.matchAll(pattern)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

function isMasked(ranges, start) {
  return ranges.some(([from, to]) => start >= from && start < to);
}

export function rewrite(content, platforms) {
  const ranges = maskedRanges(content);
  const replacements = [];

  for (const match of content.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    if (isMasked(ranges, start)) continue;
    // An author-suppressed <https://...> link: leave the embed suppressed.
    if (content[start - 1] === '<' && content[start + raw.length] === '>') continue;

    const trimmed = trimTrailing(raw);
    if (trimmed.length === 0) continue;
    const replaced = rewriteUrl(trimmed, platforms);
    if (replaced === null) continue;
    replacements.push({ start, end: start + trimmed.length, text: replaced });
  }

  if (replacements.length === 0) return { changed: false, content };

  let out = content;
  for (const r of replacements.reverse()) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return { changed: true, content: out };
}

// Returns the rewritten URL, or null if this URL should be left alone.
function rewriteUrl(raw, platforms) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const rule = matchRule(url.hostname, url.pathname);
  if (!rule) return null;

  const settings = platforms[rule.platform];
  if (!settings?.enabled) return null;

  const target = normaliseHost(settings.domain);
  if (normaliseHost(url.hostname) === target) return null;

  url.protocol = 'https:';
  url.hostname = target;
  url.port = '';
  stripTracking(url);
  return url.toString();
}
