# Discord Link Replacer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Discord bot that rewrites social media links to embed-friendly mirror domains and reposts the message as its original author via a channel webhook.

**Architecture:** A pure rewriting core (`rules.js` + `rewrite.js`) with no Discord imports and no I/O, wrapped in a thin Discord shell (`webhooks.js` + `bot.js` + `index.js`). Every edge case in the rewriter is a unit test against a string; the shell is tested with hand-rolled fakes. No database — configuration is a validated static file with environment overrides.

**Tech Stack:** Node 20, discord.js v14, plain ESM JavaScript, vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-08-28-discord-link-replacer-design.md`

## Global Constraints

- Node 20+, ESM only (`"type": "module"` in package.json). No TypeScript, no build step.
- discord.js v14. vitest for all tests.
- No database, no ORM, no persistence of any kind.
- No network calls outside the Discord gateway/REST — in particular, never resolve short-link redirects over HTTP.
- The rewriting core (`src/rules.js`, `src/rewrite.js`) must not import from `discord.js` or perform I/O.
- Default target domains, exactly: twitter → `fxtwitter.com`, instagram → `kkinstagram.com`, tiktok → `vxtiktok.com`, reddit → `rxddit.com`, bluesky → `fxbsky.app`.
- Platform keys, exactly: `twitter`, `instagram`, `tiktok`, `reddit`, `bluesky`.
- Tracking parameters stripped on rewrite: `s`, `t`, `si`, `igsh`, `igshid`, `fbclid`, `ref_src`, `ref_url`, and any parameter starting `utm_`.
- Rewritten URLs always use the `https:` protocol.
- The bot sends the replacement **before** deleting the original, always.
- Commit after every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `package.json` | ESM manifest, deps, `test` script | 1 |
| `src/rules.js` | Static platform rule table + host/path matching | 1 |
| `src/rewrite.js` | Pure `rewrite(content, platforms)` | 2–5 |
| `src/config.js` | Load/validate `config.json`, env overrides | 6 |
| `config.json` | Default per-platform enabled + domain | 6 |
| `src/webhooks.js` | Get-or-create channel webhook, cached | 7 |
| `src/bot.js` | Ignore guards + repost/delete orchestration | 8–9 |
| `src/index.js` | Client construction, login, shutdown | 10 |
| `Dockerfile`, `compose.yml`, `README.md`, `.gitignore`, `.env.example` | Deployment + docs | 10 |

---

### Task 1: Project scaffold and the rule table

**Files:**
- Create: `package.json`, `.gitignore`, `src/rules.js`
- Test: `test/rules.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PLATFORMS: string[]` — the five platform keys in order.
  - `DEFAULT_DOMAINS: Record<string, string>` — platform key → default target domain.
  - `matchRule(host: string, pathname: string): Rule | null` where `Rule` is `{ platform: string, hosts: string[], path: RegExp, shortHosts?: string[], shortPath?: RegExp }`. `host` is matched case-insensitively with a leading `www.` stripped.

- [ ] **Step 1: Create the package manifest and gitignore**

`package.json`:

```json
{
  "name": "discord-link-replacer",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "discord.js": "^14.16.3"
  },
  "devDependencies": {
    "vitest": "^2.1.8"
  }
}
```

`.gitignore`:

```
node_modules/
.env
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 3: Write the failing test**

`test/rules.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { PLATFORMS, DEFAULT_DOMAINS, matchRule } from '../src/rules.js';

describe('rule table', () => {
  it('exposes the five platform keys', () => {
    expect(PLATFORMS).toEqual(['twitter', 'instagram', 'tiktok', 'reddit', 'bluesky']);
  });

  it('exposes a default domain for every platform', () => {
    expect(DEFAULT_DOMAINS).toEqual({
      twitter: 'fxtwitter.com',
      instagram: 'kkinstagram.com',
      tiktok: 'vxtiktok.com',
      reddit: 'rxddit.com',
      bluesky: 'fxbsky.app',
    });
  });
});

describe('matchRule', () => {
  it.each([
    ['x.com', '/jack/status/20', 'twitter'],
    ['twitter.com', '/jack/status/20', 'twitter'],
    ['mobile.twitter.com', '/jack/status/20', 'twitter'],
    ['instagram.com', '/reel/Cabc123/', 'instagram'],
    ['instagram.com', '/p/Cabc123/', 'instagram'],
    ['tiktok.com', '/@someone/video/7123456789', 'tiktok'],
    ['vm.tiktok.com', '/ZMabc123/', 'tiktok'],
    ['reddit.com', '/r/videos/comments/abc123/title/', 'reddit'],
    ['reddit.com', '/r/videos/s/AbCd1234', 'reddit'],
    ['bsky.app', '/profile/someone.bsky.social/post/3kabc', 'bluesky'],
  ])('matches %s%s as %s', (host, pathname, platform) => {
    expect(matchRule(host, pathname)?.platform).toBe(platform);
  });

  it('ignores a leading www and host casing', () => {
    expect(matchRule('WWW.X.com', '/jack/status/20')?.platform).toBe('twitter');
  });

  it.each([
    ['x.com', '/jack'],
    ['instagram.com', '/someone'],
    ['tiktok.com', '/@someone'],
    ['tiktok.com', '/discover'],
    ['reddit.com', '/r/videos'],
    ['bsky.app', '/profile/someone.bsky.social'],
    ['example.com', '/jack/status/20'],
  ])('does not match %s%s', (host, pathname) => {
    expect(matchRule(host, pathname)).toBeNull();
  });

  it('only accepts bare short codes on the tiktok short hosts', () => {
    expect(matchRule('vt.tiktok.com', '/ZMabc123')?.platform).toBe('tiktok');
    expect(matchRule('tiktok.com', '/ZMabc123')).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/rules.test.js`
Expected: FAIL — cannot resolve `../src/rules.js`.

- [ ] **Step 5: Write the implementation**

`src/rules.js`:

```js
export const PLATFORMS = ['twitter', 'instagram', 'tiktok', 'reddit', 'bluesky'];

export const DEFAULT_DOMAINS = {
  twitter: 'fxtwitter.com',
  instagram: 'kkinstagram.com',
  tiktok: 'vxtiktok.com',
  reddit: 'rxddit.com',
  bluesky: 'fxbsky.app',
};

// A bare profile link already embeds acceptably, so every path pattern is
// deliberately narrow: only the URL shapes whose native embed is broken.
export const RULES = [
  {
    platform: 'twitter',
    hosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 'vxtwitter.com', 'fixupx.com'],
    path: /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/,
  },
  {
    platform: 'instagram',
    hosts: ['instagram.com', 'ddinstagram.com'],
    path: /^\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/,
  },
  {
    platform: 'tiktok',
    hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    path: /^\/(@[\w.]+\/video\/\d+|t\/[A-Za-z0-9]+)/,
    shortHosts: ['vm.tiktok.com', 'vt.tiktok.com'],
    shortPath: /^\/[A-Za-z0-9]+\/?$/,
  },
  {
    platform: 'reddit',
    hosts: ['reddit.com', 'old.reddit.com'],
    path: /^\/r\/[A-Za-z0-9_]+\/(comments|s)\//,
  },
  {
    platform: 'bluesky',
    hosts: ['bsky.app'],
    path: /^\/profile\/[^/]+\/post\/[A-Za-z0-9]+/,
  },
];

export function normaliseHost(host) {
  return host.toLowerCase().replace(/^www\./, '');
}

export function matchRule(host, pathname) {
  const h = normaliseHost(host);
  for (const rule of RULES) {
    if (!rule.hosts.includes(h)) continue;
    if (rule.path.test(pathname)) return rule;
    if (rule.shortHosts?.includes(h) && rule.shortPath.test(pathname)) return rule;
  }
  return null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/rules.test.js`
Expected: PASS, all cases green.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/rules.js test/rules.test.js
git commit -m "feat: add platform rule table with host and path matching"
```

---

### Task 2: Rewrite core — swap the host on a single link

**Files:**
- Create: `src/rewrite.js`
- Test: `test/rewrite.test.js`

**Interfaces:**
- Consumes: `matchRule`, `normaliseHost`, `DEFAULT_DOMAINS`, `PLATFORMS` from `src/rules.js`.
- Produces: `rewrite(content: string, platforms: Record<string, {enabled: boolean, domain: string}>): { changed: boolean, content: string }`. The `platforms` argument is the per-platform settings map; it must contain an entry for every key in `PLATFORMS`.

- [ ] **Step 1: Write the failing test**

`test/rewrite.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { rewrite } from '../src/rewrite.js';
import { PLATFORMS, DEFAULT_DOMAINS } from '../src/rules.js';

// Every platform enabled, on its default domain.
const ALL_ON = Object.fromEntries(
  PLATFORMS.map((p) => [p, { enabled: true, domain: DEFAULT_DOMAINS[p] }]),
);

describe('rewrite — single link', () => {
  it('swaps an x.com status host for the twitter target', () => {
    expect(rewrite('https://x.com/jack/status/20', ALL_ON)).toEqual({
      changed: true,
      content: 'https://fxtwitter.com/jack/status/20',
    });
  });

  it('preserves surrounding text', () => {
    expect(rewrite('look at this https://x.com/jack/status/20 lol', ALL_ON).content)
      .toBe('look at this https://fxtwitter.com/jack/status/20 lol');
  });

  it('upgrades http to https', () => {
    expect(rewrite('http://x.com/jack/status/20', ALL_ON).content)
      .toBe('https://fxtwitter.com/jack/status/20');
  });

  it('reports no change when nothing matches', () => {
    expect(rewrite('https://example.com/hello', ALL_ON)).toEqual({
      changed: false,
      content: 'https://example.com/hello',
    });
  });

  it('reports no change for a message with no links at all', () => {
    expect(rewrite('good afternoon', ALL_ON)).toEqual({
      changed: false,
      content: 'good afternoon',
    });
  });

  it('leaves a link alone when its platform is disabled', () => {
    const off = { ...ALL_ON, twitter: { enabled: false, domain: 'fxtwitter.com' } };
    expect(rewrite('https://x.com/jack/status/20', off).changed).toBe(false);
  });

  it('leaves a link that is already on the target domain', () => {
    expect(rewrite('https://fxtwitter.com/jack/status/20', ALL_ON).changed).toBe(false);
  });

  it('does not throw on a malformed URL', () => {
    expect(rewrite('https://', ALL_ON).changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rewrite.test.js`
Expected: FAIL — cannot resolve `../src/rewrite.js`.

- [ ] **Step 3: Write the minimal implementation**

`src/rewrite.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rewrite.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rewrite.js test/rewrite.test.js
git commit -m "feat: rewrite matching links to their target domain"
```

---

### Task 3: Rewrite core — every platform, and multiple links per message

**Files:**
- Modify: `test/rewrite.test.js` (append a describe block)
- Modify: `src/rewrite.js` only if a test fails

**Interfaces:**
- Consumes: `rewrite` from Task 2.
- Produces: no new exports. This task proves the Task 2 implementation generalises.

- [ ] **Step 1: Write the failing test**

Append to `test/rewrite.test.js`:

```js
describe('rewrite — every platform', () => {
  it.each([
    ['https://x.com/jack/status/20', 'https://fxtwitter.com/jack/status/20'],
    ['https://twitter.com/jack/status/20', 'https://fxtwitter.com/jack/status/20'],
    ['https://www.instagram.com/reel/Cabc123/', 'https://kkinstagram.com/reel/Cabc123/'],
    ['https://www.tiktok.com/@someone/video/7123456789', 'https://vxtiktok.com/@someone/video/7123456789'],
    ['https://vm.tiktok.com/ZMabc123/', 'https://vxtiktok.com/ZMabc123/'],
    ['https://www.reddit.com/r/videos/comments/abc123/title/', 'https://rxddit.com/r/videos/comments/abc123/title/'],
    ['https://bsky.app/profile/someone.bsky.social/post/3kabc', 'https://fxbsky.app/profile/someone.bsky.social/post/3kabc'],
  ])('rewrites %s', (input, expected) => {
    expect(rewrite(input, ALL_ON).content).toBe(expected);
  });

  it('rewrites several links in one message', () => {
    const input = 'https://x.com/a/status/1 and https://vm.tiktok.com/ZMabc123/ both';
    expect(rewrite(input, ALL_ON).content)
      .toBe('https://fxtwitter.com/a/status/1 and https://vxtiktok.com/ZMabc123/ both');
  });

  it('rewrites only the enabled platforms in a mixed message', () => {
    const mixed = { ...ALL_ON, tiktok: { enabled: false, domain: 'vxtiktok.com' } };
    const input = 'https://x.com/a/status/1 and https://vm.tiktok.com/ZMabc123/';
    expect(rewrite(input, mixed).content)
      .toBe('https://fxtwitter.com/a/status/1 and https://vm.tiktok.com/ZMabc123/');
  });

  it('honours a non-default target domain from config', () => {
    const custom = { ...ALL_ON, twitter: { enabled: true, domain: 'fixupx.com' } };
    expect(rewrite('https://x.com/jack/status/20', custom).content)
      .toBe('https://fixupx.com/jack/status/20');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rewrite.test.js`
Expected: FAIL on at least the multiple-links case if the splice order is wrong; the per-platform cases should already pass from Task 2.

- [ ] **Step 3: Fix any failures in `src/rewrite.js`**

No new code is expected. If the multiple-links case fails, the splice loop in `rewrite()` is applying replacements front-to-back; confirm `replacements.reverse()` is present so later offsets are spliced first.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/rewrite.test.js src/rewrite.js
git commit -m "test: cover every platform and multi-link messages"
```

---

### Task 4: Rewrite core — skip conditions

**Files:**
- Modify: `src/rewrite.js`
- Modify: `test/rewrite.test.js` (append a describe block)

**Interfaces:**
- Consumes: `rewrite` from Task 2.
- Produces: no new exports; `rewrite` gains masked-region awareness.

- [ ] **Step 1: Write the failing test**

Append to `test/rewrite.test.js`:

```js
describe('rewrite — skip conditions', () => {
  it('skips a link inside a fenced code block', () => {
    const input = '```\nhttps://x.com/jack/status/20\n```';
    expect(rewrite(input, ALL_ON).changed).toBe(false);
  });

  it('skips a link inside inline backticks', () => {
    expect(rewrite('use `https://x.com/jack/status/20` here', ALL_ON).changed).toBe(false);
  });

  it('skips a link inside a spoiler', () => {
    expect(rewrite('||https://x.com/jack/status/20||', ALL_ON).changed).toBe(false);
  });

  it('skips an author-suppressed link in angle brackets', () => {
    expect(rewrite('<https://x.com/jack/status/20>', ALL_ON).changed).toBe(false);
  });

  it('still rewrites a link outside the masked region', () => {
    const input = '`https://x.com/a/status/1` but https://x.com/b/status/2';
    expect(rewrite(input, ALL_ON).content)
      .toBe('`https://x.com/a/status/1` but https://fxtwitter.com/b/status/2');
  });

  it('skips a link on a disabled platform target domain', () => {
    const off = { ...ALL_ON, instagram: { enabled: false, domain: 'kkinstagram.com' } };
    expect(rewrite('https://kkinstagram.com/reel/Cabc123/', off).changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rewrite.test.js`
Expected: FAIL — code block, inline code, spoiler and angle-bracket cases all report `changed: true`.

- [ ] **Step 3: Add masking to `src/rewrite.js`**

Add above `rewrite`:

```js
// Regions whose contents Discord renders literally, or that the author has
// explicitly opted out of embedding. Fenced blocks are matched first so a
// stray backtick inside one cannot open an inline-code region.
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
```

Then, inside `rewrite`, compute the ranges once and consult them per match:

```js
export function rewrite(content, platforms) {
  const ranges = maskedRanges(content);
  const replacements = [];

  for (const match of content.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    if (isMasked(ranges, start)) continue;
    // An author-suppressed <https://...> link: leave the embed suppressed.
    if (content[start - 1] === '<' && content[start + raw.length] === '>') continue;

    const replaced = rewriteUrl(raw, platforms);
    if (replaced === null) continue;
    replacements.push({ start, end: start + raw.length, text: replaced });
  }

  if (replacements.length === 0) return { changed: false, content };

  let out = content;
  for (const r of replacements.reverse()) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return { changed: true, content: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rewrite.js test/rewrite.test.js
git commit -m "feat: skip links in code blocks, spoilers and angle brackets"
```

---

### Task 5: Rewrite core — tracking parameters and trailing punctuation

**Files:**
- Modify: `src/rewrite.js`
- Modify: `test/rewrite.test.js` (append a describe block)

**Interfaces:**
- Consumes: `rewrite` from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `test/rewrite.test.js`:

```js
describe('rewrite — parameters and punctuation', () => {
  it('strips X share tracking parameters', () => {
    expect(rewrite('https://x.com/jack/status/20?s=20&t=AbCd', ALL_ON).content)
      .toBe('https://fxtwitter.com/jack/status/20');
  });

  it('strips instagram and utm tracking parameters', () => {
    expect(rewrite('https://www.instagram.com/reel/Cabc123/?igsh=xyz&utm_source=ig', ALL_ON).content)
      .toBe('https://kkinstagram.com/reel/Cabc123/');
  });

  it('keeps parameters that are not tracking', () => {
    expect(rewrite('https://x.com/jack/status/20?lang=en', ALL_ON).content)
      .toBe('https://fxtwitter.com/jack/status/20?lang=en');
  });

  it('preserves the fragment', () => {
    expect(rewrite('https://x.com/jack/status/20#m', ALL_ON).content)
      .toBe('https://fxtwitter.com/jack/status/20#m');
  });

  it('leaves trailing sentence punctuation outside the link', () => {
    expect(rewrite('see https://x.com/jack/status/20.', ALL_ON).content)
      .toBe('see https://fxtwitter.com/jack/status/20.');
  });

  it('leaves a trailing bracket outside the link', () => {
    expect(rewrite('(https://x.com/jack/status/20)', ALL_ON).content)
      .toBe('(https://fxtwitter.com/jack/status/20)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rewrite.test.js`
Expected: FAIL — tracking parameters survive, and trailing `.` / `)` are swallowed into the URL.

- [ ] **Step 3: Add parameter stripping and punctuation trimming to `src/rewrite.js`**

Add near the top:

```js
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
```

In the `rewrite` loop, trim before rewriting and keep the trimmed length as the replacement span:

```js
    const trimmed = trimTrailing(raw);
    if (trimmed.length === 0) continue;
    const replaced = rewriteUrl(trimmed, platforms);
    if (replaced === null) continue;
    replacements.push({ start, end: start + trimmed.length, text: replaced });
```

Note the angle-bracket check still uses `raw.length`, since a suppressed link is never trimmed — keep that line as it is.

In `rewriteUrl`, strip tracking after swapping the host:

```js
  url.protocol = 'https:';
  url.hostname = target;
  url.port = '';
  stripTracking(url);
  return url.toString();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rewrite.js test/rewrite.test.js
git commit -m "feat: strip tracking parameters and trailing punctuation"
```

---

### Task 6: Configuration loading and validation

**Files:**
- Create: `src/config.js`, `config.json`, `.env.example`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: `PLATFORMS`, `DEFAULT_DOMAINS` from `src/rules.js`.
- Produces: `loadConfig({ file?: string, env?: object }): { token: string, platforms: Record<string, {enabled: boolean, domain: string}> }`. Throws `Error` with a human-readable message on any validation failure. `platforms` is exactly the shape `rewrite()` expects.

- [ ] **Step 1: Write the failing test**

`test/config.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

let dir;
let file;

const VALID = {
  twitter: { enabled: true, domain: 'fxtwitter.com' },
  instagram: { enabled: true, domain: 'kkinstagram.com' },
  tiktok: { enabled: true, domain: 'vxtiktok.com' },
  reddit: { enabled: true, domain: 'rxddit.com' },
  bluesky: { enabled: true, domain: 'fxbsky.app' },
};

function write(contents) {
  writeFileSync(file, JSON.stringify(contents));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkfix-'));
  file = join(dir, 'config.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('loads a valid config', () => {
    write(VALID);
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.token).toBe('abc');
    expect(config.platforms.twitter).toEqual({ enabled: true, domain: 'fxtwitter.com' });
  });

  it('fills in a default domain when one is omitted', () => {
    write({ ...VALID, twitter: { enabled: true } });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.platforms.twitter.domain).toBe('fxtwitter.com');
  });

  it('defaults a missing platform to enabled on its default domain', () => {
    write({ twitter: { enabled: true, domain: 'fxtwitter.com' } });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.platforms.bluesky).toEqual({ enabled: true, domain: 'fxbsky.app' });
  });

  it('lets an env var override the domain', () => {
    write(VALID);
    const config = loadConfig({
      file,
      env: { DISCORD_TOKEN: 'abc', LINKFIX_INSTAGRAM_DOMAIN: 'ddinstagram.com' },
    });
    expect(config.platforms.instagram.domain).toBe('ddinstagram.com');
  });

  it('lets an env var disable a platform', () => {
    write(VALID);
    const config = loadConfig({
      file,
      env: { DISCORD_TOKEN: 'abc', LINKFIX_TIKTOK_ENABLED: 'false' },
    });
    expect(config.platforms.tiktok.enabled).toBe(false);
  });

  it('throws when the token is missing', () => {
    write(VALID);
    expect(() => loadConfig({ file, env: {} })).toThrow(/DISCORD_TOKEN/);
  });

  it('throws on an unknown platform key', () => {
    write({ ...VALID, myspace: { enabled: true, domain: 'myspace.com' } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/myspace/);
  });

  it('throws on a malformed domain', () => {
    write({ ...VALID, twitter: { enabled: true, domain: 'https://fxtwitter.com/' } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/domain/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

`src/config.js`:

```js
import { readFileSync } from 'node:fs';
import { PLATFORMS, DEFAULT_DOMAINS } from './rules.js';

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function loadConfig({ file = 'config.json', env = process.env } = {}) {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set; the bot cannot log in.');

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read config from ${file}: ${error.message}`);
  }

  for (const key of Object.keys(raw)) {
    if (!PLATFORMS.includes(key)) {
      throw new Error(`Unknown platform "${key}" in ${file}. Known platforms: ${PLATFORMS.join(', ')}.`);
    }
  }

  const platforms = {};
  for (const platform of PLATFORMS) {
    const entry = raw[platform] ?? {};
    const domain = envDomain(env, platform) ?? entry.domain ?? DEFAULT_DOMAINS[platform];
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(`Invalid domain "${domain}" for ${platform}; expected a bare hostname such as ${DEFAULT_DOMAINS[platform]}.`);
    }
    const enabled = envEnabled(env, platform) ?? entry.enabled ?? true;
    platforms[platform] = { enabled, domain };
  }

  return { token, platforms };
}

function envDomain(env, platform) {
  return env[`LINKFIX_${platform.toUpperCase()}_DOMAIN`] || undefined;
}

function envEnabled(env, platform) {
  const value = env[`LINKFIX_${platform.toUpperCase()}_ENABLED`];
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}
```

`config.json`:

```json
{
  "twitter":   { "enabled": true, "domain": "fxtwitter.com" },
  "instagram": { "enabled": true, "domain": "kkinstagram.com" },
  "tiktok":    { "enabled": true, "domain": "vxtiktok.com" },
  "reddit":    { "enabled": true, "domain": "rxddit.com" },
  "bluesky":   { "enabled": true, "domain": "fxbsky.app" }
}
```

`.env.example`:

```
DISCORD_TOKEN=
# Override a dead mirror without editing config.json:
# LINKFIX_INSTAGRAM_DOMAIN=ddinstagram.com
# LINKFIX_TIKTOK_ENABLED=false
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js config.json .env.example test/config.test.js
git commit -m "feat: load and validate config with env overrides"
```

---

### Task 7: Channel webhook cache

**Files:**
- Create: `src/webhooks.js`
- Test: `test/webhooks.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createWebhookCache(botUserId: string): { get(channel): Promise<Webhook>, size(): number }`. `channel` is any object exposing `id`, `isThread()`, `parent`, `fetchWebhooks()` and `createWebhook({ name })` — the discord.js `TextChannel`/`ThreadChannel` surface. For a thread, the webhook is resolved on the parent channel and cached under the parent's ID. Rejects with whatever `createWebhook` rejects with (the caller handles error 30007).

- [ ] **Step 1: Write the failing test**

`test/webhooks.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createWebhookCache } from '../src/webhooks.js';

const BOT_ID = 'bot-1';

function fakeChannel({ id = 'chan-1', existing = [], isThread = false, parent = null } = {}) {
  return {
    id,
    isThread: () => isThread,
    parent,
    fetchWebhooks: vi.fn(async () => ({ find: (fn) => existing.find(fn) ?? null })),
    createWebhook: vi.fn(async ({ name }) => ({ id: 'hook-new', name, owner: { id: BOT_ID }, token: 'tok' })),
  };
}

describe('createWebhookCache', () => {
  it('creates a webhook when the channel has none', async () => {
    const channel = fakeChannel();
    const cache = createWebhookCache(BOT_ID);
    const hook = await cache.get(channel);
    expect(hook.id).toBe('hook-new');
    expect(channel.createWebhook).toHaveBeenCalledOnce();
  });

  it('reuses an existing webhook owned by the bot', async () => {
    const mine = { id: 'hook-old', owner: { id: BOT_ID }, token: 'tok' };
    const channel = fakeChannel({ existing: [mine] });
    const cache = createWebhookCache(BOT_ID);
    expect((await cache.get(channel)).id).toBe('hook-old');
    expect(channel.createWebhook).not.toHaveBeenCalled();
  });

  it('ignores a webhook owned by someone else', async () => {
    const theirs = { id: 'hook-theirs', owner: { id: 'other' }, token: 'tok' };
    const channel = fakeChannel({ existing: [theirs] });
    const cache = createWebhookCache(BOT_ID);
    expect((await cache.get(channel)).id).toBe('hook-new');
  });

  it('does not re-fetch on a cache hit', async () => {
    const channel = fakeChannel();
    const cache = createWebhookCache(BOT_ID);
    await cache.get(channel);
    await cache.get(channel);
    expect(channel.fetchWebhooks).toHaveBeenCalledOnce();
    expect(cache.size()).toBe(1);
  });

  it('resolves a thread against its parent channel', async () => {
    const parent = fakeChannel({ id: 'parent-1' });
    const thread = fakeChannel({ id: 'thread-1', isThread: true, parent });
    const cache = createWebhookCache(BOT_ID);
    await cache.get(thread);
    expect(parent.createWebhook).toHaveBeenCalledOnce();
    expect(thread.createWebhook).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webhooks.test.js`
Expected: FAIL — cannot resolve `../src/webhooks.js`.

- [ ] **Step 3: Write the implementation**

`src/webhooks.js`:

```js
export const WEBHOOK_NAME = 'Link Replacer';

export function createWebhookCache(botUserId) {
  // channel ID -> Promise<Webhook>. Storing the promise, not the resolved
  // value, means two messages arriving at once share one creation call.
  const cache = new Map();

  async function resolve(channel) {
    const hooks = await channel.fetchWebhooks();
    const mine = hooks.find((hook) => hook.owner?.id === botUserId && hook.token);
    if (mine) return mine;
    return channel.createWebhook({ name: WEBHOOK_NAME });
  }

  return {
    get(channel) {
      // A thread has no webhooks of its own; it posts through its parent's.
      const target = channel.isThread() ? channel.parent : channel;
      if (!cache.has(target.id)) {
        const pending = resolve(target).catch((error) => {
          cache.delete(target.id); // don't cache a failure
          throw error;
        });
        cache.set(target.id, pending);
      }
      return cache.get(target.id);
    },
    size: () => cache.size,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webhooks.js test/webhooks.test.js
git commit -m "feat: cache a get-or-create webhook per channel"
```

---

### Task 8: Ignore guards

**Files:**
- Create: `src/bot.js`
- Test: `test/bot.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ignoreReason(message, botUserId): string | null` — returns a short reason string when the message must be left alone, or `null` when it is a candidate for rewriting. Reason strings, exactly: `'bot'`, `'webhook'`, `'not-a-guild'`, `'system'`, `'has-attachments'`, `'has-stickers'`, `'has-poll'`, `'forwarded'`, `'missing-permissions'`.

- [ ] **Step 1: Write the failing test**

`test/bot.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { ignoreReason } from '../src/bot.js';

const BOT_ID = 'bot-1';

// A message that should pass every guard.
function fakeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    content: 'https://x.com/jack/status/20',
    author: { id: 'user-1', bot: false },
    webhookId: null,
    guild: { id: 'guild-1' },
    system: false,
    attachments: { size: 0 },
    stickers: { size: 0 },
    reference: null,
    poll: null,
    channel: {
      id: 'chan-1',
      permissionsFor: () => ({ has: () => true }),
    },
    ...overrides,
  };
}

describe('ignoreReason', () => {
  it('allows an ordinary user message with a link', () => {
    expect(ignoreReason(fakeMessage(), BOT_ID)).toBeNull();
  });

  it('ignores messages from bots', () => {
    expect(ignoreReason(fakeMessage({ author: { id: 'x', bot: true } }), BOT_ID)).toBe('bot');
  });

  it('ignores messages sent by a webhook', () => {
    expect(ignoreReason(fakeMessage({ webhookId: 'hook-1' }), BOT_ID)).toBe('webhook');
  });

  it('ignores direct messages', () => {
    expect(ignoreReason(fakeMessage({ guild: null }), BOT_ID)).toBe('not-a-guild');
  });

  it('ignores system messages', () => {
    expect(ignoreReason(fakeMessage({ system: true }), BOT_ID)).toBe('system');
  });

  it('ignores messages with attachments, which a webhook cannot reproduce', () => {
    expect(ignoreReason(fakeMessage({ attachments: { size: 1 } }), BOT_ID)).toBe('has-attachments');
  });

  it('ignores messages with stickers', () => {
    expect(ignoreReason(fakeMessage({ stickers: { size: 1 } }), BOT_ID)).toBe('has-stickers');
  });

  it('ignores messages carrying a poll', () => {
    expect(ignoreReason(fakeMessage({ poll: { question: { text: 'which' } } }), BOT_ID)).toBe('has-poll');
  });

  it('ignores forwarded messages', () => {
    expect(ignoreReason(fakeMessage({ reference: { type: 1 } }), BOT_ID)).toBe('forwarded');
  });

  it('allows a plain reply, which is not a forward', () => {
    expect(ignoreReason(fakeMessage({ reference: { type: 0, messageId: 'msg-0' } }), BOT_ID)).toBeNull();
  });

  it('ignores channels where the bot lacks permissions', () => {
    const channel = { id: 'chan-1', permissionsFor: () => ({ has: () => false }) };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID)).toBe('missing-permissions');
  });

  it('ignores a channel it cannot resolve permissions for', () => {
    const channel = { id: 'chan-1', permissionsFor: () => null };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID)).toBe('missing-permissions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bot.test.js`
Expected: FAIL — cannot resolve `../src/bot.js`.

- [ ] **Step 3: Write the implementation**

`src/bot.js`:

```js
import { PermissionFlagsBits } from 'discord.js';

const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.SendMessages,
];

// MessageReferenceType.Forward === 1. A forwarded message carries content we
// cannot reproduce through a webhook, so it is left alone.
const REFERENCE_TYPE_FORWARD = 1;

export function ignoreReason(message, botUserId) {
  if (message.author?.bot) return 'bot';
  if (message.webhookId) return 'webhook';
  if (!message.guild) return 'not-a-guild';
  if (message.system) return 'system';
  if (message.attachments?.size > 0) return 'has-attachments';
  if (message.stickers?.size > 0) return 'has-stickers';
  if (message.poll) return 'has-poll';
  if (message.reference?.type === REFERENCE_TYPE_FORWARD) return 'forwarded';

  const permissions = message.channel.permissionsFor(botUserId);
  if (!permissions || !REQUIRED_PERMISSIONS.every((flag) => permissions.has(flag))) {
    return 'missing-permissions';
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot.js test/bot.test.js
git commit -m "feat: add ignore guards for messages the bot must not touch"
```

---

### Task 9: Repost and delete orchestration

**Files:**
- Modify: `src/bot.js`
- Modify: `test/bot.test.js` (append describe blocks)

**Interfaces:**
- Consumes: `ignoreReason` (Task 8), `rewrite` (Task 2–5), `createWebhookCache` (Task 7).
- Produces:
  - `buildPayload(message, content): object` — the webhook payload: `{ content, username, avatarURL, allowedMentions: { parse: [] }, threadId? }`. When the message is a reply, `content` is prefixed with a `-# ↪ replying to <@id>` line.
  - `handleMessage(message, { platforms, webhooks, logger }): Promise<string>` — returns a short outcome string: an ignore reason, `'unchanged'`, `'replaced'`, `'fallback-reply'`, or `'send-failed'`.

- [ ] **Step 1: Write the failing test for the payload**

Append to `test/bot.test.js`:

```js
import { buildPayload, handleMessage } from '../src/bot.js';

function fakeMember() {
  return { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/avatar.png' };
}

describe('buildPayload', () => {
  it('posts as the member, without re-pinging anyone', () => {
    const message = fakeMessage({ member: fakeMember() });
    const payload = buildPayload(message, 'https://fxtwitter.com/jack/status/20');
    expect(payload).toEqual({
      content: 'https://fxtwitter.com/jack/status/20',
      username: 'Mike',
      avatarURL: 'https://cdn/avatar.png',
      allowedMentions: { parse: [] },
    });
  });

  it('adds a subtext line when the original was a reply', () => {
    const message = fakeMessage({
      member: fakeMember(),
      reference: { type: 0, messageId: 'msg-0' },
      mentions: { repliedUser: { id: 'user-9' } },
    });
    const payload = buildPayload(message, 'https://fxtwitter.com/jack/status/20');
    expect(payload.content).toBe('-# ↪ replying to <@user-9>\nhttps://fxtwitter.com/jack/status/20');
  });

  it('passes the thread ID when the message is in a thread', () => {
    const channel = {
      id: 'thread-1',
      isThread: () => true,
      permissionsFor: () => ({ has: () => true }),
    };
    const payload = buildPayload(fakeMessage({ member: fakeMember(), channel }), 'x');
    expect(payload.threadId).toBe('thread-1');
  });

  it('falls back to the author username when there is no member', () => {
    const message = fakeMessage({
      member: null,
      author: { id: 'user-1', bot: false, username: 'mike', displayAvatarURL: () => 'https://cdn/u.png' },
    });
    expect(buildPayload(message, 'x').username).toBe('mike');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bot.test.js`
Expected: FAIL — `buildPayload` is not exported.

- [ ] **Step 3: Implement `buildPayload` in `src/bot.js`**

Add to `src/bot.js`:

```js
export function buildPayload(message, content) {
  const isReply = message.reference?.type !== REFERENCE_TYPE_FORWARD && message.reference?.messageId;
  const repliedTo = message.mentions?.repliedUser?.id;
  // A webhook cannot carry a reply reference, so the link becomes a subtext line.
  const body = isReply && repliedTo ? `-# ↪ replying to <@${repliedTo}>\n${content}` : content;

  const payload = {
    content: body,
    username: message.member?.displayName ?? message.author.username,
    avatarURL: message.member?.displayAvatarURL() ?? message.author.displayAvatarURL(),
    // Mentions still render, but nobody the original already pinged gets a
    // second notification.
    allowedMentions: { parse: [] },
  };
  if (message.channel.isThread?.()) payload.threadId = message.channel.id;
  return payload;
}
```

Note: `fakeMessage` in the test has no `isThread` on its channel, which is why the call is written `message.channel.isThread?.()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bot.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the orchestration**

Append to `test/bot.test.js`:

```js
const PLATFORMS_ON = {
  twitter: { enabled: true, domain: 'fxtwitter.com' },
  instagram: { enabled: true, domain: 'kkinstagram.com' },
  tiktok: { enabled: true, domain: 'vxtiktok.com' },
  reddit: { enabled: true, domain: 'rxddit.com' },
  bluesky: { enabled: true, domain: 'fxbsky.app' },
};

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function deps(overrides = {}) {
  return {
    platforms: PLATFORMS_ON,
    webhooks: { get: vi.fn(async () => ({ send: vi.fn(async () => ({ id: 'new-1' })) })) },
    logger: silentLogger,
    ...overrides,
  };
}

describe('handleMessage', () => {
  it('sends the rewritten message then deletes the original', async () => {
    const order = [];
    const send = vi.fn(async () => { order.push('send'); });
    const message = fakeMessage({
      member: fakeMember(),
      delete: vi.fn(async () => { order.push('delete'); }),
    });
    const d = deps({ webhooks: { get: vi.fn(async () => ({ send })) } });

    expect(await handleMessage(message, d)).toBe('replaced');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'https://fxtwitter.com/jack/status/20' }),
    );
    expect(order).toEqual(['send', 'delete']);
  });

  it('does nothing when no link changes', async () => {
    const message = fakeMessage({ content: 'just talking', member: fakeMember(), delete: vi.fn() });
    const d = deps();
    expect(await handleMessage(message, d)).toBe('unchanged');
    expect(d.webhooks.get).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('returns the ignore reason without calling the API', async () => {
    const message = fakeMessage({ author: { id: 'x', bot: true }, delete: vi.fn() });
    const d = deps();
    expect(await handleMessage(message, d)).toBe('bot');
    expect(d.webhooks.get).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('never deletes the original when the send fails', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const message = fakeMessage({ member: fakeMember(), delete: vi.fn() });
    const d = deps({ webhooks: { get: vi.fn(async () => ({ send })) } });

    expect(await handleMessage(message, d)).toBe('send-failed');
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('falls back to a plain reply when the channel is out of webhooks', async () => {
    const error = Object.assign(new Error('max webhooks'), { code: 30007 });
    const reply = vi.fn(async () => {});
    const message = fakeMessage({ member: fakeMember(), reply, delete: vi.fn() });
    const d = deps({ webhooks: { get: vi.fn(async () => { throw error; }) } });

    expect(await handleMessage(message, d)).toBe('fallback-reply');
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'https://fxtwitter.com/jack/status/20' }),
    );
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('reports a replacement even when the delete fails', async () => {
    const message = fakeMessage({
      member: fakeMember(),
      delete: vi.fn(async () => { throw new Error('already gone'); }),
    });
    expect(await handleMessage(message, deps())).toBe('replaced');
  });
});
```

Add `vi` to the vitest import at the top of the file if it is not already there.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/bot.test.js`
Expected: FAIL — `handleMessage` is not exported.

- [ ] **Step 7: Implement `handleMessage` in `src/bot.js`**

Add the `rewrite` import at the top of `src/bot.js`:

```js
import { rewrite } from './rewrite.js';
```

and append:

```js
// Discord API error: the channel already has the maximum 15 webhooks.
const ERROR_MAX_WEBHOOKS = 30007;

export async function handleMessage(message, { platforms, webhooks, logger }) {
  const reason = ignoreReason(message, message.client?.user?.id);
  if (reason) return reason;

  const { changed, content } = rewrite(message.content, platforms);
  if (!changed) return 'unchanged';

  const payload = buildPayload(message, content);

  let webhook;
  try {
    webhook = await webhooks.get(message.channel);
  } catch (error) {
    if (error.code === ERROR_MAX_WEBHOOKS) {
      // Channel is out of webhook slots: post the fixed link plainly and
      // leave the original in place rather than destroying it.
      await message.reply({ content, allowedMentions: { parse: [] } });
      return 'fallback-reply';
    }
    logger.error(`webhook lookup failed in ${message.channel.id}: ${error.message}`);
    return 'send-failed';
  }

  try {
    await webhook.send(payload);
  } catch (error) {
    logger.error(`webhook send failed in ${message.channel.id}: ${error.message}`);
    return 'send-failed';
  }

  try {
    await message.delete();
  } catch (error) {
    // The replacement is already posted; a failed delete leaves a duplicate,
    // which is noisy but not destructive.
    logger.warn(`could not delete ${message.id}: ${error.message}`);
  }
  return 'replaced';
}
```

Note: `ignoreReason` is called with `message.client?.user?.id`, which is `undefined` in the fakes; `permissionsFor(undefined)` on the fake returns a permissive object, so the guards still exercise correctly.

- [ ] **Step 8: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/bot.js test/bot.test.js
git commit -m "feat: repost rewritten messages as the author, then delete"
```

---

### Task 10: Entrypoint, container and documentation

**Files:**
- Create: `src/index.js`, `Dockerfile`, `.dockerignore`, `compose.yml`, `README.md`

**Interfaces:**
- Consumes: `loadConfig` (Task 6), `createWebhookCache` (Task 7), `handleMessage` (Task 9).
- Produces: a runnable process. No exports consumed by other tasks.

- [ ] **Step 1: Write the entrypoint**

`src/index.js`:

```js
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { createWebhookCache } from './webhooks.js';
import { handleMessage } from './bot.js';

const logger = console;

let config;
try {
  config = loadConfig();
} catch (error) {
  logger.error(error.message);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged: enable "Message Content Intent" in the Developer Portal or
    // every message arrives with empty content.
    GatewayIntentBits.MessageContent,
  ],
});

// The cache needs the bot's own user ID, which is known only after login.
let webhooks = null;
// Channels we have already complained about, so a misconfigured channel
// warns once rather than once per message.
const warnedChannels = new Set();

client.once(Events.ClientReady, (ready) => {
  webhooks = createWebhookCache(ready.user.id);
  const enabled = Object.entries(config.platforms)
    .filter(([, s]) => s.enabled)
    .map(([name, s]) => `${name}→${s.domain}`)
    .join(', ');
  logger.info(`Logged in as ${ready.user.tag}. Rewriting: ${enabled || 'nothing'}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (!webhooks) return; // not logged in yet
  try {
    const outcome = await handleMessage(message, { platforms: config.platforms, webhooks, logger });
    if (outcome === 'missing-permissions' && !warnedChannels.has(message.channel.id)) {
      warnedChannels.add(message.channel.id);
      logger.warn(`Missing Manage Messages / Manage Webhooks in #${message.channel.name ?? message.channel.id}; skipping this channel.`);
    }
  } catch (error) {
    // One bad message must never take the process down.
    logger.error(`unhandled error on message ${message.id}: ${error.stack}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down.`);
    client.destroy();
    process.exit(0);
  });
}

process.on('unhandledRejection', (error) => {
  logger.error(`unhandled rejection: ${error?.stack ?? error}`);
});

client.login(config.token);
```

- [ ] **Step 2: Verify the entrypoint fails cleanly without a token**

Run: `DISCORD_TOKEN= node src/index.js; echo "exit=$?"`
Expected: prints `DISCORD_TOKEN is not set; the bot cannot log in.` and `exit=1`. No stack trace.

- [ ] **Step 3: Write the container files**

`Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config.json ./
USER node
CMD ["node", "src/index.js"]
```

`.dockerignore`:

```
node_modules
test
docs
.git
.env
```

`compose.yml`:

```yaml
services:
  link-replacer:
    build: .
    container_name: link-replacer
    restart: unless-stopped
    env_file: .env
```

- [ ] **Step 4: Verify the image builds**

Run: `docker build -t discord-link-replacer .`
Expected: build succeeds. (Skip this step if Docker is not available locally and note it as unverified.)

- [ ] **Step 5: Write the README**

`README.md` must contain, in this order:

1. One-paragraph description of what the bot does.
2. **Setup:** create an application in the Discord Developer Portal; under Bot, **enable the Message Content Intent** (the bot receives empty message content without it); copy the token into `.env` as `DISCORD_TOKEN`.
3. **Invite:** required permissions are Manage Messages, Manage Webhooks and Send Messages.
4. **Configuration:** the `config.json` table of platforms and domains, and the `LINKFIX_<PLATFORM>_DOMAIN` / `LINKFIX_<PLATFORM>_ENABLED` overrides, noting that mirror domains are volunteer-run and occasionally need swapping.
5. **Running:** `npm install && npm start` locally, or `docker compose up -d`.
6. **Behaviour and limits**, copied from the spec's "Known limits": messages with attachments or stickers are left alone; the reply reference becomes a text line; deletions appear in the audit log as the bot's.

- [ ] **Step 6: Run the full suite one last time**

Run: `npx vitest run`
Expected: PASS, every test file green.

- [ ] **Step 7: Commit**

```bash
git add src/index.js Dockerfile .dockerignore compose.yml README.md
git commit -m "feat: add entrypoint, container and documentation"
```

---

## Verification

After Task 10, before declaring the work done:

- [ ] `npx vitest run` — all tests pass, output pasted into the summary.
- [ ] `DISCORD_TOKEN= node src/index.js` exits 1 with a readable message.
- [ ] A manual smoke test in a real guild with a real token, if one is available: post `https://x.com/jack/status/20` and confirm a single message remains, attributed to you, with a working embed.
