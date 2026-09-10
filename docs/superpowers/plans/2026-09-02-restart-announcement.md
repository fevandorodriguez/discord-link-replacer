# Restart Announcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every successful login the bot posts one quip at random into a channel chosen from the admin panel, with a test button that exercises the same path on demand.

**Architecture:** The atomic config write already in `mode-store.js` is extracted so a second store can share it rather than duplicate it. A pure `announce()` reports an outcome instead of throwing, so one code path serves both `ClientReady` and the test endpoint. The panel gains a channel dropdown, a quip editor and a rate-limited test button.

**Tech Stack:** Node 20, discord.js v14, plain ESM JavaScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-restart-announcement-design.md`

## Global Constraints

- Node 20+, ESM only. No TypeScript, no build step. vitest.
- **No new runtime dependencies.**
- `channelId` is digits only, or empty. Empty means announcements are off — the default.
- `quips`: array of non-empty strings, each **at most 2000 characters**, **at most 50** of them.
- The announcement must post with `allowedMentions: { parse: [] }`.
- `announce()` never throws; it returns one of exactly: `'sent'`, `'no-channel'`, `'no-quips'`, `'channel-missing'`, `'not-postable'`, `'failed'`.
- `/api/announce/test` is rate limited to **one call per 30 seconds**, server side.
- **Every existing `test/admin/mode-store.test.js` test must pass unmodified.**
- Commit after every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/config-writer.js` | Atomic, permission-preserving config mutation | 1 |
| `src/admin/mode-store.js` | Rewired onto the shared writer | 1 |
| `src/config.js` | Accept and validate `announce` | 2 |
| `src/announce.js` | Pick a quip, post it, report an outcome | 3 |
| `src/admin/announce-store.js` | Panel-writable announce settings | 4 |
| `src/admin/server.js` | `/api/announce` GET/POST and `/api/announce/test` | 5 |
| `src/admin/page.js`, `src/index.js`, `README.md` | UI, wiring, docs | 6 |

---

### Task 1: Extract the atomic config writer

**Files:**
- Create: `src/config-writer.js`, `test/config-writer.test.js`
- Modify: `src/admin/mode-store.js`

**Interfaces:**
- Produces: `updateConfig(file, mutate, { rejectCode })` — reads and parses `file`, throws when the root is not a plain object (tagging the error `rejectCode`), calls `mutate(raw)` to change it in place, then writes atomically preserving the target's file mode.

**This is a behaviour-preserving extraction.** `mode-store.js` has been through two review rounds; its root guard and permission preservation were both defects found by probing. Its existing tests are the contract — if any needs editing, the extraction is wrong.

- [ ] **Step 1: Write the failing test**

`test/config-writer.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateConfig } from '../src/config-writer.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfgwrite-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mode: 'repost', keep: { a: 1 } }, null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('updateConfig', () => {
  it('applies the mutation to the file', () => {
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
  });

  it('leaves every other key untouched', () => {
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(JSON.parse(readFileSync(file, 'utf8')).keep).toEqual({ a: 1 });
  });

  it('leaves no temp file behind', () => {
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('preserves the file mode', () => {
    chmodSync(file, 0o600);
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '7'],
    ['a string', '"hello"'],
  ])('refuses to write when the root is %s', (_label, contents) => {
    writeFileSync(file, contents);
    expect(() => updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' })).toThrow(/must be a JSON object/);
    expect(readFileSync(file, 'utf8')).toBe(contents);
  });

  it('tags a rejected root with the caller’s code', () => {
    writeFileSync(file, '[]');
    try {
      updateConfig(file, () => {}, { rejectCode: 'MODE_REJECTED' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MODE_REJECTED');
    }
  });

  it('lets a parse error propagate untagged', () => {
    writeFileSync(file, '{not json');
    try {
      updateConfig(file, () => {}, { rejectCode: 'MODE_REJECTED' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).not.toBe('MODE_REJECTED');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-writer.test.js`
Expected: FAIL — cannot resolve `../src/config-writer.js`.

- [ ] **Step 3: Write the implementation**

`src/config-writer.js` — this is the sequence lifted verbatim from `mode-store.js`, which is the point:

```js
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chmodSync } from 'node:fs';

// Mutates one config file in place, atomically. Two stores write to this file
// now — the delivery mode and the restart announcement — and duplicating this
// sequence would duplicate a logic block that took two review rounds to get
// right: the root guard and the permission copy were both real defects.
//
// `rejectCode` tags the root-type refusal so each caller keeps its own error
// vocabulary; mode-store's rejections are already documented as MODE_REJECTED.
export function updateConfig(file, mutate, { rejectCode }) {
  // Parse and I/O errors propagate untagged: they are genuine faults, not the
  // caller's deliberate refusals, and the admin API maps the two differently.
  const raw = JSON.parse(readFileSync(file, 'utf8'));

  // A non-object root silently swallows property assignment — set() would
  // report success and write nothing, which is the exact failure the stores
  // exist to prevent.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const rootType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    const error = new Error(`Config root in ${file} must be a JSON object, got ${rootType}.`);
    error.code = rejectCode;
    throw error;
  }

  mutate(raw);

  // Write to a temp file beside the target, then rename: a crash mid-write
  // must never leave a truncated config the bot cannot boot from. The temp
  // file has to sit in the same directory, because rename is only atomic
  // within a filesystem and the config directory is bind-mounted.
  const tempFile = `${file}.tmp`;
  try {
    writeFileSync(tempFile, `${JSON.stringify(raw, null, 2)}\n`);
    try {
      // rename installs the temp file's inode, so without this an operator's
      // tightened permissions are silently reset to the default umask.
      const stat = statSync(file);
      chmodSync(tempFile, stat.mode);
    } catch (e) {
      // A first-ever write has no target to inherit from. Anything else —
      // a permissions error mid-stat, say — is a real failure.
      if (e.code !== 'ENOENT') throw e;
    }
    renameSync(tempFile, file);
  } catch (e) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Nothing to clean up.
    }
    throw e;
  }
}
```

- [ ] **Step 4: Rewire the mode store**

In `src/admin/mode-store.js`, replace the `import` of `node:fs` with:

```js
import { updateConfig } from '../config-writer.js';
```

Keep the `MODES` import. Inside `set(next)`, keep both existing guards (the `LINKFIX_MODE` lock and the `typeof next !== 'string' || !MODES.includes(next)` check) exactly as they are, then replace everything from `let raw;` down to the end of the atomic-write `try/catch` with:

```js
      updateConfig(file, (raw) => { raw.mode = next; }, { rejectCode: 'MODE_REJECTED' });
```

Leave the two trailing assignments (`current = next;` and `source = 'config.json';`) untouched.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. **`test/admin/mode-store.test.js` must be unmodified** — if a test there fails, the extraction changed behaviour and the fix is in the writer, never in that test file.

- [ ] **Step 6: Commit**

```bash
git add src/config-writer.js src/admin/mode-store.js test/config-writer.test.js
git commit -m "refactor: extract the atomic config write both stores need"
```

---

### Task 2: Accept `announce` in config

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `loadConfig(...)` returns an additional `announce` key, shaped `{ channelId: string, quips: string[] }`. Absent config yields `{ channelId: '', quips: [] }`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.js`:

```js
describe('loadConfig — announce', () => {
  it('defaults to no channel and no quips', () => {
    write(VALID);
    expect(loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }).announce)
      .toEqual({ channelId: '', quips: [] });
  });

  it('reads a channel and quips from the file', () => {
    write({ ...VALID, announce: { channelId: '123456789', quips: ['back'] } });
    expect(loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }).announce)
      .toEqual({ channelId: '123456789', quips: ['back'] });
  });

  // loadConfig rejects any top-level key that is not a known platform. It
  // already carries an exception for `mode`; without one for `announce` the
  // bot refuses to start. This exact trap was hit when `mode` was added.
  it('does not mistake announce for an unknown platform', () => {
    write({ ...VALID, announce: { channelId: '', quips: [] } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).not.toThrow();
  });

  it.each([42, 'nope', [], null])('rejects a non-object announce (%s)', (bad) => {
    write({ ...VALID, announce: bad });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/announce/i);
  });

  it.each(['abc', '12a', ' 123', 42, {}])('rejects the invalid channelId %s', (bad) => {
    write({ ...VALID, announce: { channelId: bad } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/channelId/i);
  });

  it.each([['not an array', 'nope'], ['a non-string entry', [42]], ['an empty entry', ['']]])(
    'rejects quips that are %s',
    (_label, bad) => {
      write({ ...VALID, announce: { quips: bad } });
      expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/quips/i);
    },
  );

  it('rejects a quip longer than Discord will accept', () => {
    write({ ...VALID, announce: { quips: ['x'.repeat(2001)] } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/2000/);
  });

  it('rejects more than fifty quips', () => {
    write({ ...VALID, announce: { quips: Array.from({ length: 51 }, (_, i) => `q${i}`) } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/50/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `announce` is undefined, and the unknown-platform loop rejects the key.

- [ ] **Step 3: Implement**

In `src/config.js`, add near the other constants:

```js
export const MAX_QUIP_LENGTH = 2000;
export const MAX_QUIPS = 50;
```

Add `announce` to the key-skipping loop, beside `mode`:

```js
  for (const key of Object.keys(raw)) {
    if (key === 'mode' || key === 'announce') continue;
    if (!PLATFORMS.includes(key)) {
      throw new Error(`Unknown platform "${key}" in ${file}. Known platforms: ${PLATFORMS.join(', ')}.`);
    }
  }
```

Add the resolver:

```js
// The restart quips and the channel they go to. Free text set through a
// password-gated web page, so every rule here is enforced at startup rather
// than trusted: a malformed value is fatal, exactly like a bad domain.
function resolveAnnounce(raw, file) {
  if (raw === undefined) return { channelId: '', quips: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid "announce" in ${file}: expected an object.`);
  }

  const channelId = raw.channelId ?? '';
  // Digits only: the panel always supplies a real id from its dropdown, so
  // there is no channel name to resolve and nothing to guess at.
  if (typeof channelId !== 'string' || (channelId !== '' && !/^\d+$/.test(channelId))) {
    throw new Error(`Invalid "announce.channelId" in ${file}: expected a channel id of digits, or "" for none.`);
  }

  const quips = raw.quips ?? [];
  if (!Array.isArray(quips)) {
    throw new Error(`Invalid "announce.quips" in ${file}: expected an array of strings.`);
  }
  if (quips.length > MAX_QUIPS) {
    throw new Error(`Too many entries in "announce.quips" in ${file}: at most ${MAX_QUIPS}.`);
  }
  for (const quip of quips) {
    if (typeof quip !== 'string' || quip.trim().length === 0) {
      throw new Error(`Invalid entry in "announce.quips" in ${file}: expected a non-empty string.`);
    }
    if (quip.length > MAX_QUIP_LENGTH) {
      throw new Error(`An entry in "announce.quips" in ${file} is longer than ${MAX_QUIP_LENGTH} characters, which Discord will not accept.`);
    }
  }

  return { channelId, quips };
}
```

Call it beside the mode resolution and add it to the return:

```js
  const announce = resolveAnnounce(raw.announce, file);
```

```js
  return { token, mode, modeSource, platforms, announce };
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: accept and validate restart announcement settings"
```

---

### Task 3: The announcement itself

**Files:**
- Create: `src/announce.js`, `test/announce.test.js`

**Interfaces:**
- Produces: `announce(channelId, quips, { client, logger, pick })` returning a Promise of exactly one of `'sent'`, `'no-channel'`, `'no-quips'`, `'channel-missing'`, `'not-postable'`, `'failed'`. `pick` is an optional chooser defaulting to a random index, injected so tests are deterministic.

- [ ] **Step 1: Write the failing test**

`test/announce.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { announce } from '../src/announce.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const QUIPS = ['first', 'second', 'third'];

function fakeClient({ channel, fetchThrows = false } = {}) {
  return {
    user: { id: 'bot-1' },
    channels: {
      fetch: vi.fn(async () => {
        if (fetchThrows) throw new Error('Unknown Channel');
        return channel;
      }),
    },
  };
}

function fakeChannel({ canSend = true, sendThrows = false } = {}) {
  return {
    id: 'chan-1',
    isTextBased: () => true,
    permissionsFor: () => ({ has: (flag) => (flag === PermissionFlagsBits.SendMessages ? canSend : true) }),
    send: vi.fn(async () => {
      if (sendThrows) throw new Error('rejected');
      return { id: 'msg-1' };
    }),
  };
}

describe('announce', () => {
  it('says nothing when no channel is configured', async () => {
    const client = fakeClient();
    expect(await announce('', QUIPS, { client, logger: silentLogger })).toBe('no-channel');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('says nothing when there are no quips', async () => {
    const client = fakeClient({ channel: fakeChannel() });
    expect(await announce('chan-1', [], { client, logger: silentLogger })).toBe('no-quips');
  });

  it('posts a quip', async () => {
    const channel = fakeChannel();
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger, pick: () => 1 }))
      .toBe('sent');
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'second' }));
  });

  // Quips are free text set through a password-gated web page. Without this a
  // quip containing @everyone would ping the whole server on every restart.
  it('posts with mentions suppressed', async () => {
    const channel = fakeChannel();
    await announce('chan-1', ['@everyone hello'], { client: fakeClient({ channel }), logger: silentLogger });
    expect(channel.send).toHaveBeenCalledWith({
      content: '@everyone hello',
      allowedMentions: { parse: [] },
    });
  });

  it('only ever picks a quip from the list', async () => {
    const channel = fakeChannel();
    for (let i = 0; i < 50; i++) {
      await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger });
    }
    for (const call of channel.send.mock.calls) {
      expect(QUIPS).toContain(call[0].content);
    }
  });

  it('reports a channel it cannot find', async () => {
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ fetchThrows: true }), logger: silentLogger }))
      .toBe('channel-missing');
  });

  it('reports a channel that resolves to nothing', async () => {
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel: null }), logger: silentLogger }))
      .toBe('channel-missing');
  });

  it('reports a channel it cannot post in', async () => {
    const channel = fakeChannel({ canSend: false });
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger }))
      .toBe('not-postable');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('reports a rejected send', async () => {
    const channel = fakeChannel({ sendThrows: true });
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger }))
      .toBe('failed');
  });

  it('never throws, whatever the client does', async () => {
    const client = { user: { id: 'bot-1' }, channels: { fetch: () => { throw new Error('boom'); } } };
    await expect(announce('chan-1', QUIPS, { client, logger: silentLogger })).resolves.toBe('channel-missing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/announce.test.js`
Expected: FAIL — cannot resolve `../src/announce.js`.

- [ ] **Step 3: Implement**

`src/announce.js`:

```js
import { PermissionFlagsBits } from 'discord.js';

// Says something in the configured channel. Returns an outcome rather than
// throwing: the test button needs to report the reason, and a bot that cannot
// make a joke must still start up.
export async function announce(channelId, quips, { client, logger, pick } = {}) {
  if (!channelId) return 'no-channel';
  if (!Array.isArray(quips) || quips.length === 0) return 'no-quips';

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    logger.warn(`announce: could not find channel ${channelId}: ${error.message}`);
    return 'channel-missing';
  }
  if (!channel || !channel.isTextBased?.()) {
    logger.warn(`announce: ${channelId} is not a channel this bot can post in.`);
    return 'channel-missing';
  }

  // A channel the bot can see but not speak in fails silently at send time,
  // which is exactly the confusion the test button exists to remove.
  if (!channel.permissionsFor?.(client.user)?.has(PermissionFlagsBits.SendMessages)) {
    logger.warn(`announce: missing Send Messages in ${channelId}.`);
    return 'not-postable';
  }

  const choose = pick ?? (() => Math.floor(Math.random() * quips.length));
  const content = quips[choose()];

  try {
    // parse: [] is not cosmetic. Quips are free text set through a
    // password-gated web page; without it, one containing @everyone would
    // ping the whole server on every restart.
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.error(`announce: send failed in ${channelId}: ${error.message}`);
    return 'failed';
  }
  return 'sent';
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/announce.js test/announce.test.js
git commit -m "feat: post a restart quip and report the outcome"
```

---

### Task 4: The announce store

**Files:**
- Create: `src/admin/announce-store.js`, `test/admin/announce-store.test.js`

**Interfaces:**
- Consumes: `updateConfig(file, mutate, { rejectCode })` from Task 1; `MAX_QUIPS` and `MAX_QUIP_LENGTH` from `src/config.js` (Task 2).
- Produces: `createAnnounceStore({ channelId, quips, file })` returning `{ current(), set({ channelId, quips }) }`. `current()` returns `{ channelId, quips }`. `set` throws with `error.code = 'ANNOUNCE_REJECTED'` on any invalid input, before touching the file.

- [ ] **Step 1: Write the failing test**

`test/admin/announce-store.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnnounceStore } from '../../src/admin/announce-store.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'announce-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mode: 'repost', twitter: { enabled: true, domain: 'fxtwitter.com' } }, null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => createAnnounceStore({ channelId: '', quips: [], file });

describe('createAnnounceStore', () => {
  it('reports what it was built with', () => {
    const s = createAnnounceStore({ channelId: '99', quips: ['hi'], file });
    expect(s.current()).toEqual({ channelId: '99', quips: ['hi'] });
  });

  it('changes the live settings', () => {
    const s = store();
    s.set({ channelId: '123', quips: ['back'] });
    expect(s.current()).toEqual({ channelId: '123', quips: ['back'] });
  });

  it('persists to the config file', () => {
    store().set({ channelId: '123', quips: ['back'] });
    expect(JSON.parse(readFileSync(file, 'utf8')).announce)
      .toEqual({ channelId: '123', quips: ['back'] });
  });

  it('leaves every other key in the file alone', () => {
    store().set({ channelId: '123', quips: [] });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.mode).toBe('repost');
    expect(raw.twitter).toEqual({ enabled: true, domain: 'fxtwitter.com' });
  });

  it('accepts an empty channel, meaning announcements are off', () => {
    const s = createAnnounceStore({ channelId: '123', quips: [], file });
    s.set({ channelId: '', quips: [] });
    expect(s.current().channelId).toBe('');
  });

  it.each(['abc', '12a', ' 1', 42, null, {}])('rejects the invalid channelId %s', (bad) => {
    const s = store();
    expect(() => s.set({ channelId: bad, quips: [] })).toThrow(/channel/i);
    expect(s.current().channelId).toBe('');
  });

  it.each([['not an array', 'nope'], ['a non-string entry', [42]], ['a blank entry', ['  ']]])(
    'rejects quips that are %s',
    (_label, bad) => {
      const s = store();
      expect(() => s.set({ channelId: '', quips: bad })).toThrow(/quip/i);
    },
  );

  it('rejects a quip longer than Discord accepts', () => {
    expect(() => store().set({ channelId: '', quips: ['x'.repeat(2001)] })).toThrow(/2000/);
  });

  it('rejects more than fifty quips', () => {
    const many = Array.from({ length: 51 }, (_, i) => `q${i}`);
    expect(() => store().set({ channelId: '', quips: many })).toThrow(/50/);
  });

  it('tags its own refusals so the API can tell them from an I/O fault', () => {
    try {
      store().set({ channelId: 'nope', quips: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ANNOUNCE_REJECTED');
    }
  });

  it('writes nothing when the input is rejected', () => {
    const before = readFileSync(file, 'utf8');
    try { store().set({ channelId: 'nope', quips: [] }); } catch { /* expected */ }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/announce-store.test.js`
Expected: FAIL — cannot resolve `../../src/admin/announce-store.js`.

- [ ] **Step 3: Implement**

`src/admin/announce-store.js`:

```js
import { updateConfig } from '../config-writer.js';
import { MAX_QUIPS, MAX_QUIP_LENGTH } from '../config.js';

function reject(message) {
  const error = new Error(message);
  error.code = 'ANNOUNCE_REJECTED';
  return error;
}

// Holds the restart channel and quips, and writes changes back to config.json
// so they survive the restart they exist to announce.
export function createAnnounceStore({ channelId, quips, file }) {
  let current = { channelId, quips };

  return {
    current: () => ({ channelId: current.channelId, quips: [...current.quips] }),

    set({ channelId: nextChannel, quips: nextQuips }) {
      // Everything is validated before the file is opened, so a rejected
      // request cannot leave a half-written config behind.
      if (typeof nextChannel !== 'string' || (nextChannel !== '' && !/^\d+$/.test(nextChannel))) {
        throw reject('Channel must be a channel id of digits, or empty for no announcements.');
      }
      if (!Array.isArray(nextQuips)) {
        throw reject('Quips must be a list.');
      }
      if (nextQuips.length > MAX_QUIPS) {
        throw reject(`Too many quips: at most ${MAX_QUIPS}.`);
      }
      for (const quip of nextQuips) {
        if (typeof quip !== 'string' || quip.trim().length === 0) {
          throw reject('Every quip must be text.');
        }
        if (quip.length > MAX_QUIP_LENGTH) {
          throw reject(`A quip is longer than ${MAX_QUIP_LENGTH} characters, which Discord will not accept.`);
        }
      }

      updateConfig(file, (raw) => {
        raw.announce = { channelId: nextChannel, quips: nextQuips };
      }, { rejectCode: 'ANNOUNCE_REJECTED' });

      current = { channelId: nextChannel, quips: nextQuips };
    },
  };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/announce-store.js test/admin/announce-store.test.js
git commit -m "feat: add a panel-writable store for the restart announcement"
```

---

### Task 5: Admin routes

**Files:**
- Modify: `src/admin/server.js`
- Test: `test/admin/server.test.js`

**Interfaces:**
- Consumes: an `announceStore` (Task 4), an `announce` function (Task 3), and a `listChannels()` returning `[{ id, name }]`, all through `deps`.
- Produces: `GET /api/announce` → `{ channelId, quips, channels }`; `POST /api/announce` → `{ channelId, quips }`; `POST /api/announce/test` → `{ result }`.

- [ ] **Step 1: Write the failing test**

Append to `test/admin/server.test.js`:

```js
describe('announce routes', () => {
  function announceDeps(overrides = {}) {
    let settings = { channelId: '123', quips: ['back'] };
    return {
      ...deps,
      announceStore: {
        current: () => settings,
        set: vi.fn((next) => { settings = next; }),
      },
      listChannels: vi.fn(() => [{ id: '123', name: 'bots' }]),
      announceNow: vi.fn(async () => 'sent'),
      ...overrides,
    };
  }

  it('refuses an unauthenticated read', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/announce' }), res, announceDeps());
    expect(res.statusCode).toBe(401);
  });

  it('refuses an unauthenticated test', async () => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test' }), res, d);
    expect(res.statusCode).toBe(401);
    expect(d.announceNow).not.toHaveBeenCalled();
  });

  it('reports the settings and the channels it can post in', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/announce', cookie: validCookie() }), res, announceDeps());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      channelId: '123',
      quips: ['back'],
      channels: [{ id: '123', name: 'bots' }],
    });
  });

  it('saves a change', async () => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: '{"channelId":"999","quips":["hi"]}' }),
      res, d,
    );

    expect(res.statusCode).toBe(200);
    expect(d.announceStore.set).toHaveBeenCalledWith({ channelId: '999', quips: ['hi'] });
  });

  it('rejects a refused change as a client error', async () => {
    const d = announceDeps();
    d.announceStore.set = vi.fn(() => {
      throw Object.assign(new Error('Channel must be a channel id of digits, or empty for no announcements.'), { code: 'ANNOUNCE_REJECTED' });
    });
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: '{"channelId":"nope","quips":[]}' }),
      res, d,
    );
    expect(res.statusCode).toBe(400);
  });

  // An untagged error is an I/O fault, not the operator's mistake, and saying
  // otherwise sends them looking in the wrong place.
  it('reports an untagged failure as a server error', async () => {
    const d = announceDeps();
    d.announceStore.set = vi.fn(() => { throw new Error('ENOENT'); });
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: '{"channelId":"","quips":[]}' }),
      res, d,
    );
    expect(res.statusCode).toBe(500);
  });

  it('rejects a malformed body', async () => {
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: 'not json' }),
      res, announceDeps(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('posts a quip on demand and returns the outcome', async () => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: 'sent' });
    expect(d.announceNow).toHaveBeenCalled();
  });

  // Without the button a leaked password buys arbitrary bot text on the next
  // restart; with it, that text can be fired into any visible channel on
  // demand. The cooldown is what bounds that, and it has to be server side.
  it('refuses a second test within the cooldown', async () => {
    const d = { ...announceDeps(), testLimiter: createRateLimiter({ max: 1, windowMs: 30000 }) };
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), fakeRes(), d);

    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(429);
    expect(d.announceNow).toHaveBeenCalledTimes(1);
  });

  it('allows another test once the cooldown has passed', async () => {
    let now = 1000;
    const d = {
      ...announceDeps(),
      testLimiter: createRateLimiter({ max: 1, windowMs: 30000, clock: () => now }),
    };
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), fakeRes(), d);

    now = 1000 + 30001;
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(200);
    expect(d.announceNow).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/server.test.js`
Expected: FAIL — the announce routes fall through to the 404 handler.

- [ ] **Step 3: Implement**

In `src/admin/server.js`, add near the other constants:

```js
// One test post per this window. The panel has one legitimate user, so this
// is not about them: it bounds what a leaked password can do, since the test
// endpoint turns "arbitrary text on the next restart" into "arbitrary text in
// any visible channel, now, repeatedly".
const TEST_ANNOUNCE_COOLDOWN_MS = 30000;
// A fixed key, because this limit is per-endpoint rather than per-caller.
const TEST_ANNOUNCE_KEY = 'announce-test';
```

**The cooldown state must not be a module-level variable.** `handleRequest` is
exported and called directly by the tests, so a counter held in module scope
persists between them: one test would consume the window and the next would see
a refusal it never caused. Reuse `createRateLimiter` from `src/admin/auth.js`
instead — it already has the shape needed, an injectable clock, and its own
tests.

Add `announceStore`, `listChannels`, `announceNow` and `testLimiter` to the
destructured `deps` at the top of `handleRequest`:

```js
  const { modeStore, logBuffer, passwordHash, sessionSecret, limiter, logger,
          announceStore, listChannels, announceNow, testLimiter } = deps;
```

In `createAdminServer`, default it the same way the login limiter is defaulted:

```js
  testLimiter: deps.testLimiter ?? createRateLimiter({ max: 1, windowMs: TEST_ANNOUNCE_COOLDOWN_MS }),
```

Then add the three routes after the existing `/api/mode` block:

```js
  if (req.method === 'GET' && path === '/api/announce') {
    return json(res, 200, {
      ...announceStore.current(),
      // A function, not a list: the panel starts before the bot logs in, and
      // before then there are no channels to offer.
      channels: listChannels(),
    }, { 'cache-control': 'no-store' });
  }

  if (req.method === 'POST' && path === '/api/announce') {
    let requested;
    try {
      requested = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'Malformed request.' });
    }
    try {
      announceStore.set({ channelId: requested.channelId, quips: requested.quips });
    } catch (error) {
      // ANNOUNCE_REJECTED marks the store's own refusals — the operator's
      // input was wrong. Anything else is an I/O fault and is ours.
      if (error.code === 'ANNOUNCE_REJECTED') return json(res, 400, { error: error.message });
      logger.error(`announce settings write failed: ${error.message}`);
      return json(res, 500, { error: 'Could not save.' });
    }
    return json(res, 200, announceStore.current());
  }

  if (req.method === 'POST' && path === '/api/announce/test') {
    if (!testLimiter.allowed(TEST_ANNOUNCE_KEY)) {
      return json(res, 429, { error: 'Wait a moment before testing again.' });
    }
    // fail() is named for the login path it was written for; here it simply
    // records that the one call this window allows has been spent.
    testLimiter.fail(TEST_ANNOUNCE_KEY);
    return json(res, 200, { result: await announceNow() });
  }
```

`logger` is used by the POST handler above and is **not** currently destructured from `deps` in `handleRequest` — the line in Step 3 adds it. Confirm it is there before running the tests, or the settings-write failure path throws a ReferenceError instead of returning 500.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/server.js test/admin/server.test.js
git commit -m "feat: add announce settings and test routes to the panel"
```

---

### Task 6: Panel UI, wiring and docs

**Files:**
- Modify: `src/admin/page.js`, `src/index.js`, `README.md`
- Test: `test/admin/page.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a running feature. No exports other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `test/admin/page.test.js`:

```js
describe('dashboard — announcements', () => {
  it('has a channel picker and a quip editor', () => {
    const html = renderDashboard();
    expect(html).toContain('/api/announce');
    expect(html).toMatch(/<select[^>]*id="announce-channel"/);
    expect(html).toContain('announce-quips');
  });

  it('has a test button that calls the test endpoint', () => {
    expect(renderDashboard()).toContain('/api/announce/test');
  });

  it('is still one self-contained document with no external assets', () => {
    const html = renderDashboard();
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin/page.test.js`
Expected: FAIL — the dashboard has no announce section.

- [ ] **Step 3: Build the panel section**

In `src/admin/page.js`, add to `renderDashboard()`'s markup a section containing:

- `<select id="announce-channel">` populated from the `channels` array returned by `GET /api/announce`, with a first option of `value=""` labelled `No announcements`, and the current `channelId` selected.
- A list of the current quips, each with a remove control, plus a text input and an add control. Hold the working list in a script variable and `POST /api/announce` with the full `{ channelId, quips }` on save.
- A **Test** button that `POST`s to `/api/announce/test` and displays the returned `result`, mapping each outcome to a plain sentence: `sent` → posted, `no-channel` → pick a channel first, `no-quips` → add a quip first, `channel-missing` → the bot cannot see that channel, `not-postable` → the bot cannot post there, `failed` → Discord rejected it.

**Every quip must be HTML-escaped when rendered.** They are free text arriving from the config file and from the input box; the page already has an escaping helper used by `renderLogin` — use that same one.

Disable the Test button while a request is in flight. The server-side cooldown is the real guard; this only stops double-clicks.

- [ ] **Step 4: Wire the entrypoint**

In `src/index.js`, import the new pieces:

```js
import { announce } from './announce.js';
import { createAnnounceStore } from './admin/announce-store.js';
import { PermissionFlagsBits } from 'discord.js';
```

Construct the store beside the mode store:

```js
const announceStore = createAnnounceStore({
  channelId: config.announce.channelId,
  quips: config.announce.quips,
  file: configFile,
});
```

Add the channel lister and the on-demand announcement, both defined before `createAdminServer` is called:

```js
// A function rather than a list: the admin server starts before the bot logs
// in, and an empty list then is the honest answer.
function listChannels() {
  if (!client.isReady()) return [];
  return [...client.channels.cache.values()]
    .filter((c) => c.isTextBased?.() && !c.isDMBased?.()
      && c.permissionsFor?.(client.user)?.has(PermissionFlagsBits.SendMessages))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function announceNow() {
  const { channelId, quips } = announceStore.current();
  return announce(channelId, quips, { client, logger });
}
```

Pass them into `createAdminServer`'s deps alongside the existing ones:

```js
  announceStore,
  listChannels,
  announceNow,
```

In the `ClientReady` handler, after the existing login log line and beside `startMirrorChecks()`:

```js
  // Every restart speaks. A crash loop that gets past login will repeat this
  // until someone notices; a failed login exits before reaching here.
  announceNow().then((result) => {
    if (result !== 'sent' && result !== 'no-channel') {
      logger.warn(`Restart announcement not posted: ${result}.`);
    }
  });
```

Note `client` is declared before `ClientReady` but `listChannels` and `announceNow` reference it lazily, so declaration order is fine as long as both are function declarations rather than arrow constants.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, output pristine.

- [ ] **Step 6: Verify it still starts and fails cleanly**

Run: `DISCORD_TOKEN= node src/index.js; echo "exit=$?"`
Expected: prints `DISCORD_TOKEN is not set; the bot cannot log in.` and `exit=1`, with no stack trace — the announce wiring must not disturb the startup failure path.

- [ ] **Step 7: Seed a starter set of quips**

Add an `announce` block to both `config.json` and `data/config.json`, with `"channelId": ""` and a `quips` array of eight to ten short lines in the voice of the two the user gave — `Someone turned me off. Cheeky bastard.` and `What did I miss?!`. Cheeky, brief, British. Both files must stay valid JSON and identical in this block.

- [ ] **Step 8: Document it**

Add a **Restart announcements** section to `README.md` covering: what it does; that it is off until a channel is picked in the panel; that the channel dropdown only offers channels the bot can post in; that quips are edited in the panel and persisted to `config.json`; the test button and its 30-second cooldown; and the limits — every restart announces so a crash loop after login will repeat, mentions are suppressed so `@everyone` in a quip cannot ping, and anyone with the panel password can make the bot post arbitrary text in any channel it can see.

- [ ] **Step 9: Commit**

```bash
git add src/admin/page.js src/index.js config.json data/config.json README.md test/admin/page.test.js
git commit -m "feat: manage restart announcements from the admin panel"
```

---

## Verification

- [ ] `npx vitest run` — all green, output pristine.
- [ ] `git diff --stat` on `test/admin/mode-store.test.js` — **no changes**; the Task 1 extraction is behaviour preserving or it is wrong.
- [ ] `grep -rn "allowedMentions" src/announce.js` — present, `parse: []`.
- [ ] `DISCORD_TOKEN= node src/index.js` exits 1 with a readable message.
- [ ] Manual, after deployment: pick a channel in the panel, press Test, confirm the quip lands; add and remove a quip and confirm it survives a restart; set the channel to none and confirm a restart is silent.
