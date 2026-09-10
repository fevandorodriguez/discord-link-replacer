# Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a password-gated page at `discord.fev.space` that toggles the delivery mode and shows recent activity, from inside the bot process.

**Architecture:** The bot process runs a small `node:http` server alongside the Discord client. A mode holder makes the live mode mutable and persists changes to `config.json` through the existing validation. A ring buffer captures log lines and outcomes in memory. Auth uses Node's own crypto — no framework, no bcrypt, no new dependencies.

**Tech Stack:** Node 20 built-ins (`node:http`, `node:crypto`, `node:fs`), discord.js v14, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-admin-panel-design.md`

## Global Constraints

- Node 20+, ESM only. No TypeScript, no build step. vitest.
- **No new runtime dependencies.** `node:http`, `crypto.scryptSync`, `crypto.timingSafeEqual`, `crypto.createHmac` only.
- Valid modes, exactly: `'repost'` and `'suppress'`.
- `ADMIN_PASSWORD_HASH` absent or malformed ⇒ the HTTP server does not start, and the Discord side still runs.
- Session cookie flags, exactly: `HttpOnly; Secure; SameSite=Strict; Path=/`.
- Rate limit: 5 failed logins per IP per 15 minutes, then refuse for 15 minutes regardless of correctness. Client IP comes from the socket, never a client-supplied header.
- **No message content and no rewritten URLs may reach the log buffer or any response.**
- `docker logs` output must be unchanged: the buffer is additive.
- The port is not published to the host.
- Commit after every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/logbuffer.js` | Ring buffer + logger pass-through wrapper | 1 |
| `src/admin/auth.js` | Password hash/verify, session sign/verify, rate limiter | 2 |
| `scripts/hash-password.js` | One-off helper to generate `ADMIN_PASSWORD_HASH` | 2 |
| `src/admin/mode-store.js` | Live mode holder, persists to `config.json` | 3 |
| `src/admin/server.js` | Route handling and the HTTP server | 4 |
| `src/admin/page.js` | The dashboard and login HTML | 5 |
| `src/index.js`, `compose.yml`, `README.md` | Wiring, networking, docs | 5 |

---

### Task 1: Log ring buffer

**Files:**
- Create: `src/logbuffer.js`
- Test: `test/logbuffer.test.js`

**Interfaces:**
- Produces: `createLogBuffer(size = 200)` returning `{ entries(), record(level, text), attach(base) }`.
  - `entries()` returns oldest-first `{ at, level, text }` objects, `at` an ISO string.
  - `record(level, text)` appends to the buffer only — nothing is written to stdout.
  - `attach(base)` returns `{ info, warn, error }` that calls the matching method on `base` **and** records.

- [ ] **Step 1: Write the failing test**

`test/logbuffer.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createLogBuffer } from '../src/logbuffer.js';

describe('createLogBuffer', () => {
  it('starts empty', () => {
    expect(createLogBuffer().entries()).toEqual([]);
  });

  it('records entries oldest first with a level and a timestamp', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'first');
    buffer.record('error', 'second');
    const entries = buffer.entries();
    expect(entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(entries[1].level).toBe('error');
    expect(() => new Date(entries[0].at).toISOString()).not.toThrow();
  });

  it('evicts the oldest once full', () => {
    const buffer = createLogBuffer(3);
    for (const text of ['a', 'b', 'c', 'd']) buffer.record('info', text);
    expect(buffer.entries().map((e) => e.text)).toEqual(['b', 'c', 'd']);
  });

  it('passes attached log calls through to the base logger', () => {
    const base = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const buffer = createLogBuffer();
    const logger = buffer.attach(base);

    logger.info('up');
    logger.warn('odd');
    logger.error('bad');

    expect(base.info).toHaveBeenCalledWith('up');
    expect(base.warn).toHaveBeenCalledWith('odd');
    expect(base.error).toHaveBeenCalledWith('bad');
  });

  it('records what it passes through, at the right levels', () => {
    const base = { info: () => {}, warn: () => {}, error: () => {} };
    const buffer = createLogBuffer();
    const logger = buffer.attach(base);

    logger.info('up');
    logger.error('bad');

    expect(buffer.entries()).toEqual([
      expect.objectContaining({ level: 'info', text: 'up' }),
      expect.objectContaining({ level: 'error', text: 'bad' }),
    ]);
  });

  it('exposes only at, level and text — no field could carry message content', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'replaced in #general');
    expect(Object.keys(buffer.entries()[0]).sort()).toEqual(['at', 'level', 'text']);
  });

  it('returns a copy, so a caller cannot mutate the buffer', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'one');
    buffer.entries().push({ at: 'x', level: 'info', text: 'injected' });
    expect(buffer.entries()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/logbuffer.test.js`
Expected: FAIL — cannot resolve `../src/logbuffer.js`.

- [ ] **Step 3: Implement**

`src/logbuffer.js`:

```js
// Recent activity for the admin panel. Deliberately holds only a timestamp, a
// level and a line of text: the panel sits behind one shared password, so a
// buffer that could carry message content would be a far larger thing to leak
// than the mode toggle it exists to serve.
export function createLogBuffer(size = 200) {
  const entries = [];

  function record(level, text) {
    entries.push({ at: new Date().toISOString(), level, text });
    if (entries.length > size) entries.shift();
  }

  return {
    record,
    // A copy: the panel reads this on every poll and must not be able to
    // mutate the buffer by accident.
    entries: () => entries.slice(),
    // Wraps the real logger so stdout keeps exactly the output it has today
    // and the buffer is purely additive.
    attach(base) {
      return {
        info: (text) => { base.info(text); record('info', text); },
        warn: (text) => { base.warn(text); record('warn', text); },
        error: (text) => { base.error(text); record('error', text); },
      };
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logbuffer.js test/logbuffer.test.js
git commit -m "feat: add an in-memory ring buffer for recent activity"
```

---

### Task 2: Auth primitives

**Files:**
- Create: `src/admin/auth.js`, `scripts/hash-password.js`, `test/admin/auth.test.js`
- Modify: `package.json` (one script entry)

**Interfaces:**
- Produces, all from `src/admin/auth.js`:
  - `hashPassword(plain)` → `"<saltHex>:<hashHex>"`
  - `verifyPassword(plain, stored)` → boolean, constant-time, `false` on malformed input rather than throwing
  - `signSession(expiresAt, secret)` → `"<expiresAt>.<hmacHex>"`
  - `verifySession(cookieValue, secret, now = Date.now())` → boolean
  - `createRateLimiter({ max = 5, windowMs = 900000 })` → `{ allowed(ip), fail(ip), reset(ip) }`

- [ ] **Step 1: Write the failing test**

`test/admin/auth.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, signSession, verifySession, createRateLimiter,
} from '../../src/admin/auth.js';

describe('password hashing', () => {
  it('accepts the right password', () => {
    const stored = hashPassword('correct horse');
    expect(verifyPassword('correct horse', stored)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('correct horse');
    expect(verifyPassword('wrong horse', stored)).toBe(false);
  });

  it('never stores the plaintext', () => {
    expect(hashPassword('hunter2')).not.toContain('hunter2');
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it.each(['', 'nosalt', 'a:b:c', 'zz:zz'])('returns false for malformed stored value %s', (stored) => {
    expect(verifyPassword('anything', stored)).toBe(false);
  });
});

describe('session cookies', () => {
  const secret = 'test-secret';

  it('verifies a cookie it just signed', () => {
    const cookie = signSession(Date.now() + 60000, secret);
    expect(verifySession(cookie, secret)).toBe(true);
  });

  it('rejects an expired cookie', () => {
    const cookie = signSession(Date.now() - 1, secret);
    expect(verifySession(cookie, secret)).toBe(false);
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSession(Date.now() + 60000, 'other-secret');
    expect(verifySession(cookie, secret)).toBe(false);
  });

  it('rejects a cookie whose expiry was edited to extend it', () => {
    const cookie = signSession(Date.now() - 1, secret);
    const [, signature] = cookie.split('.');
    expect(verifySession(`${Date.now() + 60000}.${signature}`, secret)).toBe(false);
  });

  it.each(['', 'garbage', 'no-dot', '123.', '.abc'])('rejects malformed cookie %s', (cookie) => {
    expect(verifySession(cookie, secret)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('allows attempts below the limit', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(true);
  });

  it('refuses once the limit is reached', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(false);
  });

  it('refuses a correct password too, once locked out', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(false);
  });

  it('tracks each address separately', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('2.2.2.2')).toBe(true);
  });

  it('forgets failures once the window passes', () => {
    let now = 1000;
    const limiter = createRateLimiter({ max: 1, windowMs: 500, clock: () => now });
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(false);
    now = 1600;
    expect(limiter.allowed('1.1.1.1')).toBe(true);
  });

  it('clears an address on a successful login', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    limiter.reset('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/auth.test.js`
Expected: FAIL — cannot resolve `../../src/admin/auth.js`.

- [ ] **Step 3: Implement**

`src/admin/auth.js`:

```js
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const KEY_LENGTH = 32;

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Returns false rather than throwing on anything malformed: this runs on
// untrusted input from a login form, and a thrown error is a 500 that tells an
// attacker their input was interesting.
export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;

  const [saltHex, hashHex] = parts;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  const actual = scryptSync(plain, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

export function signSession(expiresAt, secret) {
  return `${expiresAt}.${sign(expiresAt, secret)}`;
}

export function verifySession(cookieValue, secret, now = Date.now()) {
  if (typeof cookieValue !== 'string') return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;

  const [expiresAt, signature] = parts;
  if (!/^\d+$/.test(expiresAt) || signature.length === 0) return false;

  const expected = Buffer.from(sign(expiresAt, secret), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (expected.length !== provided.length) return false;
  if (!timingSafeEqual(expected, provided)) return false;

  return Number(expiresAt) > now;
}

export function createRateLimiter({ max = 5, windowMs = 900000, clock = Date.now } = {}) {
  // address -> array of failure timestamps inside the window
  const failures = new Map();

  function recent(ip) {
    const cutoff = clock() - windowMs;
    const kept = (failures.get(ip) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) failures.delete(ip);
    else failures.set(ip, kept);
    return kept;
  }

  return {
    allowed: (ip) => recent(ip).length < max,
    fail(ip) {
      const kept = recent(ip);
      kept.push(clock());
      failures.set(ip, kept);
    },
    reset: (ip) => { failures.delete(ip); },
  };
}
```

- [ ] **Step 4: Add the setup helper**

`scripts/hash-password.js`:

```js
// Generates the value for ADMIN_PASSWORD_HASH. Takes the password as an
// argument so it never has to be pasted into a running shell's history twice.
import { hashPassword } from '../src/admin/auth.js';

const plain = process.argv[2];
if (!plain) {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}
console.log(hashPassword(plain));
```

Add to `package.json` scripts, beside the existing entries:

```json
    "hash-password": "node scripts/hash-password.js",
```

- [ ] **Step 5: Run tests and the helper**

Run: `npx vitest run`
Expected: PASS.

Run: `npm run hash-password -- "test password"`
Expected: a single `<hex>:<hex>` line, containing neither the word `test` nor `password`.

- [ ] **Step 6: Commit**

```bash
git add src/admin/auth.js scripts/hash-password.js package.json test/admin/auth.test.js
git commit -m "feat: add password, session and rate-limit primitives"
```

---

### Task 3: Mode store

**Files:**
- Create: `src/admin/mode-store.js`, `test/admin/mode-store.test.js`

**Interfaces:**
- Consumes: `MODES` from `src/config.js` (exported array `['repost', 'suppress']`).
- Produces: `createModeStore({ mode, modeSource, file })` returning `{ current(), source(), locked(), set(next) }`.
  - `locked()` is `true` exactly when `modeSource === 'LINKFIX_MODE'`.
  - `set(next)` throws `Error` when locked or when `next` is not in `MODES`; otherwise writes `mode` into the JSON at `file`, preserving every other key, and updates `current()`.

- [ ] **Step 1: Write the failing test**

`test/admin/mode-store.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModeStore } from '../../src/admin/mode-store.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'modestore-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    mode: 'repost',
    twitter: { enabled: true, domain: 'fxtwitter.com' },
  }, null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createModeStore', () => {
  it('reports the mode and source it was built with', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(store.current()).toBe('repost');
    expect(store.source()).toBe('config.json');
    expect(store.locked()).toBe(false);
  });

  it('is locked when the env var supplied the mode', () => {
    const store = createModeStore({ mode: 'suppress', modeSource: 'LINKFIX_MODE', file });
    expect(store.locked()).toBe(true);
  });

  it('changes the live mode', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');
    expect(store.current()).toBe('suppress');
  });

  it('persists the change to the config file', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
  });

  it('preserves every other key in the file', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).twitter)
      .toEqual({ enabled: true, domain: 'fxtwitter.com' });
  });

  it('refuses to change a locked mode, and leaves the file alone', () => {
    const store = createModeStore({ mode: 'suppress', modeSource: 'LINKFIX_MODE', file });
    expect(() => store.set('repost')).toThrow(/LINKFIX_MODE/);
    expect(store.current()).toBe('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('repost');
  });

  it.each(['edit', '', 'REPOST ', null])('rejects the invalid mode %s', (bad) => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(() => store.set(bad)).toThrow(/mode/i);
    expect(store.current()).toBe('repost');
  });

  it('defaults to the source being the file when built from a default', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'default', file });
    expect(store.locked()).toBe(false);
    store.set('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/mode-store.test.js`
Expected: FAIL — cannot resolve `../../src/admin/mode-store.js`.

- [ ] **Step 3: Implement**

`src/admin/mode-store.js`:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { MODES } from '../config.js';

// Holds the live delivery mode. The bot reads current() per message, so a change
// applies to the next one without a restart.
export function createModeStore({ mode, modeSource, file }) {
  let current = mode;

  return {
    current: () => current,
    source: () => modeSource,
    // LINKFIX_MODE beats config.json, so when the env var supplied the mode a
    // write to the file would be accepted and then ignored. Refuse instead:
    // a control that appears to work and does nothing is worse than one that
    // says why it cannot.
    locked: () => modeSource === 'LINKFIX_MODE',

    set(next) {
      if (modeSource === 'LINKFIX_MODE') {
        throw new Error(
          'Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.',
        );
      }
      if (!MODES.includes(next)) {
        throw new Error(`Invalid mode "${next}"; expected one of ${MODES.join(', ')}.`);
      }

      const raw = JSON.parse(readFileSync(file, 'utf8'));
      raw.mode = next;
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      current = next;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/mode-store.js test/admin/mode-store.test.js
git commit -m "feat: add a live mode store that persists to config.json"
```

---

### Task 4: Request handling

**Files:**
- Create: `src/admin/server.js`, `test/admin/server.test.js`

**Interfaces:**
- Consumes: `verifyPassword`, `signSession`, `verifySession`, `createRateLimiter` from `src/admin/auth.js`; a mode store from Task 3; a log buffer from Task 1; `renderLogin(error)` and `renderDashboard()` from `src/admin/page.js` (Task 5 writes the real page — for this task, import them and let Task 5 supply the markup).
- Produces:
  - `handleRequest(req, res, deps)` — `deps` is `{ modeStore, logBuffer, passwordHash, sessionSecret, limiter }`.
  - `createAdminServer(deps)` → an `http.Server`, or `null` when `passwordHash` is absent or malformed.

**Note for the implementer:** create `src/admin/page.js` in this task with two placeholder-free stub exports so the imports resolve — `renderLogin(error)` returning a minimal valid HTML string with a form posting to `/login`, and `renderDashboard()` returning a minimal valid HTML string. Task 5 replaces both bodies with the real page. The stubs must be real working HTML, not empty strings, so this task's tests exercise genuine responses.

- [ ] **Step 1: Write the failing test**

`test/admin/server.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleRequest, createAdminServer } from '../../src/admin/server.js';
import { hashPassword, signSession, createRateLimiter } from '../../src/admin/auth.js';
import { createLogBuffer } from '../../src/logbuffer.js';

const SECRET = 'test-secret';
const PASSWORD = 'let me in';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(code, headers = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      return this;
    },
    end(body = '') { this.body = body; this.ended = true; return this; },
  };
}

function fakeReq({ method = 'GET', url = '/', cookie, body = '' } = {}) {
  const req = {
    method,
    url,
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: '1.2.3.4' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
  return req;
}

let deps;
let modeStore;

beforeEach(() => {
  let mode = 'repost';
  modeStore = {
    current: () => mode,
    source: () => 'config.json',
    locked: () => false,
    set: vi.fn((next) => { mode = next; }),
  };
  deps = {
    modeStore,
    logBuffer: createLogBuffer(),
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: SECRET,
    limiter: createRateLimiter({ max: 5, windowMs: 900000 }),
  };
});

const validCookie = () => `session=${signSession(Date.now() + 60000, SECRET)}`;

describe('unauthenticated requests', () => {
  it('serves the login page at the root', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq(), res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form');
  });

  it('refuses the state API', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state' }), res, deps);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a mode change', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', body: '{"mode":"suppress"}' }), res, deps);
    expect(res.statusCode).toBe(401);
    expect(modeStore.set).not.toHaveBeenCalled();
  });

  it('refuses a request whose cookie was signed with another secret', async () => {
    const cookie = `session=${signSession(Date.now() + 60000, 'wrong-secret')}`;
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state', cookie }), res, deps);
    expect(res.statusCode).toBe(401);
  });
});

describe('login', () => {
  it('sets a hardened session cookie on the right password', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: `password=${encodeURIComponent(PASSWORD)}` }), res, deps);
    expect(res.statusCode).toBe(303);
    const cookie = res.headers['set-cookie'];
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('sets no cookie on the wrong password', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=nope' }), res, deps);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never echoes the submitted password back', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=hunter2' }), res, deps);
    expect(res.body).not.toContain('hunter2');
  });

  it('locks out after repeated failures, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=nope' }), fakeRes(), deps);
    }
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: `password=${encodeURIComponent(PASSWORD)}` }), res, deps);
    expect(res.statusCode).toBe(429);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('authenticated requests', () => {
  it('reports mode, source and entries', async () => {
    deps.logBuffer.record('error', 'webhook send failed in #art');
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state', cookie: validCookie() }), res, deps);

    expect(res.statusCode).toBe(200);
    const state = JSON.parse(res.body);
    expect(state.mode).toBe('repost');
    expect(state.source).toBe('config.json');
    expect(state.locked).toBe(false);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].text).toBe('webhook send failed in #art');
  });

  it('changes the mode and reflects it in the next state read', async () => {
    const post = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' }), post, deps);
    expect(post.statusCode).toBe(200);
    expect(modeStore.set).toHaveBeenCalledWith('suppress');

    const get = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state', cookie: validCookie() }), get, deps);
    expect(JSON.parse(get.body).mode).toBe('suppress');
  });

  it('rejects an invalid mode with 400', async () => {
    modeStore.set = vi.fn(() => { throw new Error('Invalid mode "edit"; expected one of repost, suppress.'); });
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"edit"}' }), res, deps);
    expect(res.statusCode).toBe(400);
  });

  it('refuses with 409 and an explanation when the env var owns the mode', async () => {
    modeStore.locked = () => true;
    modeStore.source = () => 'LINKFIX_MODE';
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' }), res, deps);

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('LINKFIX_MODE');
    expect(modeStore.set).not.toHaveBeenCalled();
  });

  it('serves the dashboard at the root', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ cookie: validCookie() }), res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<html');
  });

  it('clears the cookie on logout', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/logout', cookie: validCookie() }), res, deps);
    expect(res.headers['set-cookie']).toMatch(/session=;/);
  });

  it('404s an unknown path', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/secrets', cookie: validCookie() }), res, deps);
    expect(res.statusCode).toBe(404);
  });
});

describe('createAdminServer', () => {
  it('returns null without a password hash, so the panel cannot start unprotected', () => {
    expect(createAdminServer({ ...deps, passwordHash: undefined })).toBeNull();
  });

  it.each(['', 'not-a-hash'])('returns null for the malformed hash %s', (bad) => {
    expect(createAdminServer({ ...deps, passwordHash: bad })).toBeNull();
  });

  it('returns a server when the hash is well formed', () => {
    const server = createAdminServer(deps);
    expect(server).not.toBeNull();
    expect(typeof server.listen).toBe('function');
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/server.test.js`
Expected: FAIL — cannot resolve `../../src/admin/server.js`.

- [ ] **Step 3: Implement**

`src/admin/server.js`:

```js
import { createServer } from 'node:http';
import { verifyPassword, signSession, verifySession, createRateLimiter } from './auth.js';
import { renderLogin, renderDashboard } from './page.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE_FLAGS = 'HttpOnly; Secure; SameSite=Strict; Path=/';

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    // A login form and a two-key JSON object are tiny; anything larger is not
    // a real client.
    if (body.length > 4096) break;
  }
  return body;
}

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function authenticated(req, secret) {
  return verifySession(cookieValue(req.headers.cookie, 'session'), secret);
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function html(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

export async function handleRequest(req, res, deps) {
  const { modeStore, logBuffer, passwordHash, sessionSecret, limiter } = deps;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const signedIn = authenticated(req, sessionSecret);

  if (req.method === 'POST' && path === '/login') {
    // The socket address, never a client-supplied header: the origin is only
    // reachable through Caddy, so the socket is the trustworthy value.
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.allowed(ip)) {
      return html(res, 429, renderLogin('Too many attempts. Try again later.'));
    }

    const params = new URLSearchParams(await readBody(req));
    if (!verifyPassword(params.get('password') ?? '', passwordHash)) {
      limiter.fail(ip);
      return html(res, 401, renderLogin('Incorrect password.'));
    }

    limiter.reset(ip);
    res.writeHead(303, {
      location: '/',
      'set-cookie': `session=${signSession(Date.now() + SESSION_MS, sessionSecret)}; ${COOKIE_FLAGS}`,
    });
    return res.end();
  }

  if (req.method === 'POST' && path === '/logout') {
    res.writeHead(303, { location: '/', 'set-cookie': `session=; Max-Age=0; ${COOKIE_FLAGS}` });
    return res.end();
  }

  if (path === '/') {
    return html(res, 200, signedIn ? renderDashboard() : renderLogin());
  }

  if (!signedIn) return json(res, 401, { error: 'Not signed in.' });

  if (req.method === 'GET' && path === '/api/state') {
    return json(res, 200, {
      mode: modeStore.current(),
      source: modeStore.source(),
      locked: modeStore.locked(),
      entries: logBuffer.entries(),
    });
  }

  if (req.method === 'POST' && path === '/api/mode') {
    if (modeStore.locked()) {
      return json(res, 409, {
        error: `Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.`,
      });
    }
    let requested;
    try {
      requested = JSON.parse(await readBody(req)).mode;
    } catch {
      return json(res, 400, { error: 'Malformed request.' });
    }
    try {
      modeStore.set(requested);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    return json(res, 200, { mode: modeStore.current() });
  }

  return json(res, 404, { error: 'Not found.' });
}

// Returns null when there is no usable password. Fail closed: a misconfigured
// deploy gets no panel rather than an unprotected one.
export function createAdminServer(deps) {
  const { passwordHash, logger = console } = deps;
  if (typeof passwordHash !== 'string' || !/^[0-9a-f]+:[0-9a-f]+$/.test(passwordHash)) {
    logger.warn('ADMIN_PASSWORD_HASH is missing or malformed; the admin panel will not start.');
    return null;
  }

  const withLimiter = { limiter: createRateLimiter(), ...deps };
  return createServer((req, res) => {
    handleRequest(req, res, withLimiter).catch((error) => {
      logger.error(`admin request failed: ${error.message}`);
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Internal error."}');
      }
    });
  });
}
```

- [ ] **Step 4: Create the page stubs**

`src/admin/page.js` — Task 5 replaces these bodies with the real page:

```js
export function renderLogin(error = '') {
  return `<!doctype html><html><body>${error}<form method="post" action="/login">` +
    `<input type="password" name="password"><button>Sign in</button></form></body></html>`;
}

export function renderDashboard() {
  return `<!doctype html><html><body><main id="app"></main></body></html>`;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin/server.js src/admin/page.js test/admin/server.test.js
git commit -m "feat: add admin request handling with session auth"
```

---

### Task 5: The page, wiring and deployment

**Files:**
- Modify: `src/admin/page.js`, `src/index.js`, `compose.yml`, `.env.example`, `README.md`
- Test: `test/admin/page.test.js`

**Interfaces:**
- Consumes: `createLogBuffer` (Task 1), `createAdminServer` (Task 4), `createModeStore` (Task 3), `loadConfig` returning `{ token, mode, modeSource, platforms }`.
- Produces: a running panel. No exports other tasks depend on.

- [ ] **Step 1: Write the failing test**

`test/admin/page.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { renderLogin, renderDashboard } from '../../src/admin/page.js';

describe('login page', () => {
  it('posts a password field to /login', () => {
    const html = renderLogin();
    expect(html).toContain('action="/login"');
    expect(html).toContain('method="post"');
    expect(html).toContain('type="password"');
  });

  it('carries the autocomplete hints a password manager needs', () => {
    const html = renderLogin();
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autocomplete="username"');
  });

  it('shows an error when given one', () => {
    expect(renderLogin('Incorrect password.')).toContain('Incorrect password.');
  });

  it('escapes the error rather than injecting it as markup', () => {
    expect(renderLogin('<script>alert(1)</script>')).not.toContain('<script>alert(1)</script>');
  });
});

describe('dashboard', () => {
  it('is a complete document with no external asset references', () => {
    const html = renderDashboard();
    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });

  it('polls the state API and offers both modes', () => {
    const html = renderDashboard();
    expect(html).toContain('/api/state');
    expect(html).toContain('repost');
    expect(html).toContain('suppress');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/page.test.js`
Expected: FAIL — the stubs lack the autocomplete hints, escaping and polling.

- [ ] **Step 3: Write the real page**

Replace `src/admin/page.js`. Requirements the tests pin, plus what the spec asks for:

- `renderLogin(error)` escapes `error` with a helper that replaces `&`, `<`, `>`, `"` and `'` with entities before interpolating.
- The form carries a `username` field with `autocomplete="username"` (value may be a fixed label such as `admin`) and the password field with `autocomplete="current-password"`, so a password manager recognises and saves the pair.
- `renderDashboard()` returns one self-contained document: inline `<style>`, inline `<script>`, no external URLs.
- The script polls `GET /api/state` every 5 seconds and renders: the current mode, both radio options, and the entries newest-first with their level and timestamp.
- When `locked` is true the radios are `disabled` and the page shows: mode is fixed by `LINKFIX_MODE` in the environment, unset it to control the mode from here.
- Choosing a mode `POST`s `{"mode":"..."}` as JSON to `/api/mode` and re-reads state; a non-200 response shows the returned `error` text.
- A logout button posting to `/logout`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Wire it into the entrypoint**

In `src/index.js`, above the client construction:

```js
import { createLogBuffer } from './logbuffer.js';
import { createModeStore } from './admin/mode-store.js';
import { createAdminServer } from './admin/server.js';
import { randomBytes } from 'node:crypto';

const logBuffer = createLogBuffer();
const logger = logBuffer.attach(console);
```

replacing the existing `const logger = console;`. Note the `loadConfig()` call sits above this today and uses `logger` in its catch — move the buffer construction above that block so the same `logger` is in scope, keeping the existing exit-1-on-bad-config behaviour untouched.

After `config` is loaded:

```js
const modeStore = createModeStore({
  mode: config.mode,
  modeSource: config.modeSource,
  file: process.env.LINKFIX_CONFIG_FILE ?? 'config.json',
});

// Unset SESSION_SECRET means sessions do not survive a restart. That is an
// acceptable default for a one-user panel; it is documented, not silent.
const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
const admin = createAdminServer({
  modeStore,
  logBuffer,
  passwordHash: process.env.ADMIN_PASSWORD_HASH,
  sessionSecret,
  logger,
});
if (admin) {
  const port = Number(process.env.ADMIN_PORT ?? 3000);
  admin.listen(port, () => logger.info(`Admin panel listening on ${port}`));
}
```

Change the `messageCreate` handler to read the live mode and record the outcome:

```js
    const outcome = await handleMessage(message, {
      mode: modeStore.current(), platforms: config.platforms, webhooks, logger,
    });
    if (outcome === 'replaced' || outcome === 'suppressed' || outcome === 'fallback-reply') {
      // Channel name only — never the message or the link.
      logBuffer.record('info', `${outcome} in #${message.channel.name ?? message.channel.id}`);
    }
```

Leave the existing `'missing-permissions'` warn-once block exactly as it is. Add `admin?.close();` to the `SIGINT`/`SIGTERM` handler beside `client.destroy()`.

- [ ] **Step 6: Verify the fail-closed path by running it**

Run: `ADMIN_PASSWORD_HASH= DISCORD_TOKEN=x node src/index.js`
Expected: a warning that the panel will not start, then the ordinary login failure and exit 1 — no listener opened.

- [ ] **Step 7: Join the Caddy network**

In `compose.yml`, add to the service and the file. Do **not** publish a port:

```yaml
    networks:
      - default
      - monkey

networks:
  monkey:
    external: true
    name: monkey_default
```

Add to `.env.example`:

```
# Admin panel at discord.fev.space. Generate with:
#   npm run hash-password -- "your password"
# Unset means the panel does not start; the bot still runs.
ADMIN_PASSWORD_HASH=
# Optional: keeps sessions valid across restarts.
SESSION_SECRET=
```

- [ ] **Step 8: Document it**

Add an **Admin panel** section to `README.md` covering: what it does (mode toggle, recent activity); generating the hash with `npm run hash-password`; that an unset `ADMIN_PASSWORD_HASH` means no panel and that this is deliberate; that `SESSION_SECRET` unset means sessions end at restart; the Caddyfile block below and that **adding it requires reloading Caddy, which fronts around ten unrelated live apps**; and the limits — memory-only history, no attribution, mode locked when `LINKFIX_MODE` is set.

```
discord.fev.space {
	reverse_proxy link-replacer:3000
}
```

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run`
Expected: PASS, output pristine.

- [ ] **Step 10: Commit**

```bash
git add src/admin/page.js src/index.js compose.yml .env.example README.md test/admin/page.test.js
git commit -m "feat: serve the admin panel and document its deployment"
```

---

## Verification

- [ ] `npx vitest run` — all green, output pristine.
- [ ] `grep -rn "message.content\|\.content" src/logbuffer.js src/admin/` — no hit that would place message text in the buffer or a response.
- [ ] `ADMIN_PASSWORD_HASH= DISCORD_TOKEN=x node src/index.js` — warns, opens no listener, exits 1 on the token.
- [ ] `grep -n "ports:" compose.yml` — no published port.
- [ ] Manual, after deployment: sign in at `discord.fev.space`, confirm the password manager offers to save it, toggle the mode, confirm the startup log reports the new mode on the next restart, and confirm the toggle shows as locked when `LINKFIX_MODE` is set.
