import { matchRule, normaliseHost } from './rules.js';

// Excludes < and > so an author-suppressed <https://...> link is detectable
// by looking at the characters either side of the match.
const URL_PATTERN = /https?:\/\/[^\s<>]+/g;

export function rewrite(content, platforms) {
  const replacements = [];

  for (const match of content.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const replaced = rewriteUrl(raw, platforms);
    if (replaced === null) continue;
    replacements.push({ start, end: start + raw.length, text: replaced });
  }

  if (replacements.length === 0) return { changed: false, content };

  let out = content;
  // Splice from the end so earlier offsets stay valid.
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
  return url.toString();
}
