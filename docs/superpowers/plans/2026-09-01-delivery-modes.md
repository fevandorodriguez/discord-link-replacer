# Delivery Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second delivery strategy — reply then suppress the original's embed — selectable by config alongside the existing delete-and-repost, so reverting is an environment variable rather than a redeploy.

**Architecture:** The two strategies move out of `src/bot.js` into `src/delivery/repost.js` and `src/delivery/suppress.js`, each exporting the same `deliver(message, content, deps)`. `bot.js` keeps the guards and picks a strategy by mode. `src/webhooks.js` is untouched and used only by repost.

**Tech Stack:** Node 20, discord.js v14, plain ESM JavaScript, vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-09-01-delivery-modes-design.md`

## Global Constraints

- Node 20+, ESM only. No TypeScript, no build step. discord.js v14. vitest.
- Valid modes, exactly: `"repost"` and `"suppress"`. Default when unset: `"repost"`.
- `LINKFIX_MODE` overrides `config.json`, case-insensitively. Any other value is a startup error naming the value and listing the valid ones.
- `loadConfig` returns `{ token, mode, platforms }`.
- Both strategies export `deliver(message, content, deps) -> Promise<string>`.
- **Reply before suppress, always** — the same rule as send-before-delete. A failed reply must never suppress.
- Suppress mode must never delete a message or alter its text.
- Repost mode's behaviour must be byte-for-byte what it is today.
- Commit after every task.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/config.js` | Adds `mode` loading + validation | 1 |
| `config.json`, `.env.example` | Ship the new key | 1 |
| `src/delivery/repost.js` | Today's webhook repost + delete, moved | 2 |
| `src/delivery/suppress.js` | Reply then suppress | 3 |
| `src/bot.js` | Mode-aware guards, mode dispatch | 4, 5 |
| `src/index.js`, `README.md` | Wiring and docs | 5 |

---

### Task 1: Mode configuration

**Files:**
- Modify: `src/config.js`, `config.json`, `.env.example`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `MODES: string[]` (`['repost', 'suppress']`) exported from `src/config.js`; `loadConfig({file, env})` now returns `{ token, mode, platforms }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.js`:

```js
describe('loadConfig — mode', () => {
  it('defaults to repost when unset', () => {
    write(VALID);
    expect(loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }).mode).toBe('repost');
  });

  it('reads the mode from the config file', () => {
    write({ ...VALID, mode: 'suppress' });
    expect(loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }).mode).toBe('suppress');
  });

  it('lets an env var override the mode, case-insensitively', () => {
    write({ ...VALID, mode: 'repost' });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc', LINKFIX_MODE: 'SUPPRESS' } });
    expect(config.mode).toBe('suppress');
  });

  it.each(['edit', '', 'repost ', 'true'])('throws on the invalid mode %s', (value) => {
    write({ ...VALID, mode: value });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/mode/i);
  });

  it('names the valid modes in the error', () => {
    write({ ...VALID, mode: 'edit' });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/repost.*suppress|suppress.*repost/);
  });

  it('does not mistake mode for an unknown platform', () => {
    write({ ...VALID, mode: 'suppress' });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `mode` is undefined, and the unknown-platform check rejects the `mode` key.

- [ ] **Step 3: Implement**

In `src/config.js`, add near the top:

```js
export const MODES = ['repost', 'suppress'];
const DEFAULT_MODE = 'repost';
```

The existing unknown-key loop must skip `mode`, which is a sibling of the platform entries, not a platform:

```js
  for (const key of Object.keys(raw)) {
    if (key === 'mode') continue;
    if (!PLATFORMS.includes(key)) {
      throw new Error(`Unknown platform "${key}" in ${file}. Known platforms: ${PLATFORMS.join(', ')}.`);
    }
  }

  const mode = resolveMode(raw.mode, env, file);
```

Add the resolver:

```js
function resolveMode(fromFile, env, file) {
  const raw = env.LINKFIX_MODE ?? fromFile ?? DEFAULT_MODE;
  const mode = String(raw).toLowerCase();
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid mode "${raw}" in ${file}; expected one of ${MODES.join(', ')}.`);
  }
  return mode;
}
```

Return it: `return { token, mode, platforms };`

Add `"mode": "repost",` as the first key of `config.json`, and to `.env.example`:

```
# Delivery mode: repost (delete and repost as the author) or suppress
# (leave the message, strip its embed, reply with the fixed link):
# LINKFIX_MODE=suppress
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js config.json .env.example test/config.test.js
git commit -m "feat: add a delivery mode setting with strict validation"
```

---

### Task 2: Extract the repost strategy

**Files:**
- Create: `src/delivery/repost.js`, `test/delivery/repost.test.js`
- Modify: `src/bot.js`, `test/bot.test.js`

**Interfaces:**
- Consumes: `createWebhookCache(botUserId)` from `src/webhooks.js` (unchanged).
- Produces: `deliver(message, content, { webhooks, logger }) -> Promise<string>` and `buildPayload(message, content)`, both from `src/delivery/repost.js`.

This task is a **behaviour-preserving move**. No logic changes. If you find yourself improving something, stop — that is a separate task.

- [ ] **Step 1: Move the code**

Create `src/delivery/repost.js` containing, moved verbatim from `src/bot.js`: `buildPayload`, the `handleMessage` body from `const payload = buildPayload(...)` onward, plus the `ERROR_MAX_WEBHOOKS`, `STALE_WEBHOOK_ERRORS` and `REFERENCE_TYPE_FORWARD` constants it uses. Rename the moved function to `deliver` with this signature:

```js
export async function deliver(message, content, { webhooks, logger }) {
  const payload = buildPayload(message, content);
  // ... the rest verbatim, ending with `return 'replaced';`
}
```

`src/bot.js` keeps `ignoreReason` and its own copy of `REFERENCE_TYPE_FORWARD` (the forward guard still lives there).

- [ ] **Step 2: Move the tests**

Move the `buildPayload` and `handleMessage` describe blocks from `test/bot.test.js` into a new `test/delivery/repost.test.js`, along with the `fakeMessage`, `fakeMember` and `deps` helpers they need. Change `handleMessage(message, d)` calls to `deliver(message, '<the rewritten content>', d)` — the delivery layer receives already-rewritten content, so tests that relied on `rewrite()` running inside now pass the expected output directly. Import from `../../src/delivery/repost.js`.

Keep the `ignoreReason` describe block in `test/bot.test.js`.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS, same total count as before the move (the tests moved, none were added or removed).

- [ ] **Step 4: Verify the invariant survived the move**

Run: `grep -rn "message.delete()" src/`
Expected: exactly one call site, in `src/delivery/repost.js`, still preceded by a resolved `webhook.send()`.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/repost.js src/bot.js test/delivery/repost.test.js test/bot.test.js
git commit -m "refactor: extract the repost strategy into its own module"
```

---

### Task 3: The suppress strategy

**Files:**
- Create: `src/delivery/suppress.js`, `test/delivery/suppress.test.js`

**Interfaces:**
- Produces: `deliver(message, content, { logger }) -> Promise<string>` from `src/delivery/suppress.js`, returning `'suppressed'` or `'send-failed'`.

- [ ] **Step 1: Write the failing tests**

`test/delivery/suppress.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { deliver } from '../../src/delivery/suppress.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    channel: { id: 'chan-1' },
    reply: vi.fn(async () => {}),
    suppressEmbeds: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('suppress delivery', () => {
  it('replies with the fixed link, then suppresses the original embed', async () => {
    const order = [];
    const message = fakeMessage({
      reply: vi.fn(async () => { order.push('reply'); }),
      suppressEmbeds: vi.fn(async () => { order.push('suppress'); }),
    });

    expect(await deliver(message, 'https://fxtwitter.com/a/status/1', { logger: silentLogger }))
      .toBe('suppressed');
    expect(order).toEqual(['reply', 'suppress']);
  });

  it('does not re-ping anyone, including the author', async () => {
    const message = fakeMessage();
    await deliver(message, 'https://fxtwitter.com/a/status/1', { logger: silentLogger });
    expect(message.reply).toHaveBeenCalledWith({
      content: 'https://fxtwitter.com/a/status/1',
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it('never suppresses when the reply fails', async () => {
    const message = fakeMessage({ reply: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await deliver(message, 'x', { logger: silentLogger })).toBe('send-failed');
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  it('still reports success when only the suppression fails', async () => {
    const message = fakeMessage({
      suppressEmbeds: vi.fn(async () => { throw new Error('no permission'); }),
    });
    expect(await deliver(message, 'x', { logger: silentLogger })).toBe('suppressed');
  });

  it('never deletes the original', async () => {
    const message = fakeMessage({ delete: vi.fn() });
    await deliver(message, 'x', { logger: silentLogger });
    expect(message.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/delivery/suppress.test.js`
Expected: FAIL — cannot resolve `../../src/delivery/suppress.js`.

- [ ] **Step 3: Implement**

`src/delivery/suppress.js`:

```js
// Discord does not let a bot edit another user's message — authorship is
// immutable. But with Manage Messages it can strip the message's embed, which
// is enough: the author's text stays exactly as written and the working embed
// arrives in a reply.
export async function deliver(message, content, { logger }) {
  try {
    // parse: [] keeps mentions rendering without re-notifying anyone the
    // original already pinged; repliedUser: false stops the reply pinging
    // the author about their own link.
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  } catch (error) {
    logger.error(`reply failed in ${message.channel.id}: ${error.message}`);
    return 'send-failed';
  }

  // Reply first, suppress second. Suppressing before a confirmed reply could
  // strip the author's embed and then give nothing back.
  try {
    await message.suppressEmbeds(true);
  } catch (error) {
    // The fixed link is already posted; a failed suppression leaves the broken
    // embed alongside it, which is untidy but not harmful.
    logger.warn(`could not suppress embeds on ${message.id}: ${error.message}`);
  }
  return 'suppressed';
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delivery/suppress.js test/delivery/suppress.test.js
git commit -m "feat: add the suppress-and-reply delivery strategy"
```

---

### Task 4: Mode-aware guards

**Files:**
- Modify: `src/bot.js`, `test/bot.test.js`

**Interfaces:**
- Produces: `ignoreReason(message, botUserId, mode)` — the third parameter is `'repost'` or `'suppress'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/bot.test.js`. `fakeMessage` already exists in this file and passes every guard by default.

```js
describe('ignoreReason — mode-dependent guards', () => {
  it.each([
    ['attachments', { attachments: { size: 1 } }, 'has-attachments'],
    ['stickers', { stickers: { size: 1 } }, 'has-stickers'],
    ['a poll', { poll: { question: { text: 'which' } } }, 'has-poll'],
    ['a forward', { reference: { type: 1 } }, 'forwarded'],
  ])('still skips %s in repost mode', (_label, override, expected) => {
    expect(ignoreReason(fakeMessage(override), BOT_ID, 'repost')).toBe(expected);
  });

  it.each([
    ['attachments', { attachments: { size: 1 } }],
    ['stickers', { stickers: { size: 1 } }],
    ['a poll', { poll: { question: { text: 'which' } } }],
    ['a forward', { reference: { type: 1 } }],
  ])('handles %s in suppress mode, which destroys nothing', (_label, override) => {
    expect(ignoreReason(fakeMessage(override), BOT_ID, 'suppress')).toBeNull();
  });

  it('requires Manage Webhooks in repost mode', () => {
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => ({
        has: (flag) => !(who === BOT_ID && flag === PermissionFlagsBits.ManageWebhooks),
      }),
    };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'repost')).toBe('missing-permissions');
  });

  it('does not require Manage Webhooks in suppress mode', () => {
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => ({
        has: (flag) => !(who === BOT_ID && flag === PermissionFlagsBits.ManageWebhooks),
      }),
    };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'suppress')).toBeNull();
  });

  it.each(['repost', 'suppress'])('still skips a bot author in %s mode', (mode) => {
    expect(ignoreReason(fakeMessage({ author: { id: 'x', bot: true } }), BOT_ID, mode)).toBe('bot');
  });

  it.each(['repost', 'suppress'])('still skips an author denied Embed Links in %s mode', (mode) => {
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => (who === BOT_ID
        ? { has: () => true }
        : { has: (flag) => flag !== PermissionFlagsBits.EmbedLinks }),
    };
    expect(ignoreReason(fakeMessage({ channel, member: { id: 'user-1' } }), BOT_ID, mode))
      .toBe('author-cannot-embed');
  });
});
```

Add `PermissionFlagsBits` to the imports at the top of `test/bot.test.js`:

```js
import { PermissionFlagsBits } from 'discord.js';
```

Update the existing `ignoreReason` tests in this file to pass `'repost'` as the third argument, preserving their current expectations.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bot.test.js`
Expected: FAIL — the suppress-mode cases return `'has-attachments'` and friends because the guards do not yet consult the mode.

- [ ] **Step 3: Implement**

In `src/bot.js`, replace the single permission list with two:

```js
const BASE_PERMISSIONS = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.SendMessages,
];
// Only repost posts through a webhook.
const REPOST_PERMISSIONS = [...BASE_PERMISSIONS, PermissionFlagsBits.ManageWebhooks];
```

and make the guards consult the mode:

```js
export function ignoreReason(message, botUserId, mode) {
  if (message.author?.bot) return 'bot';
  if (message.webhookId) return 'webhook';
  if (!message.guild) return 'not-a-guild';
  if (message.system) return 'system';

  // These four exist only to stop repost destroying content a webhook cannot
  // reproduce. Suppress mode deletes nothing, so it handles them normally.
  if (mode === 'repost') {
    if (message.attachments?.size > 0) return 'has-attachments';
    if (message.stickers?.size > 0) return 'has-stickers';
    if (message.poll) return 'has-poll';
    if (message.reference?.type === REFERENCE_TYPE_FORWARD) return 'forwarded';
  }

  const required = mode === 'repost' ? REPOST_PERMISSIONS : BASE_PERMISSIONS;
  const permissions = message.channel.permissionsFor(botUserId);
  if (!permissions || !required.every((flag) => permissions.has(flag))) {
    return 'missing-permissions';
  }

  const authorPermissions = message.channel.permissionsFor(message.member ?? message.author);
  if (!authorPermissions || !authorPermissions.has(PermissionFlagsBits.EmbedLinks)) {
    return 'author-cannot-embed';
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot.js test/bot.test.js
git commit -m "feat: apply the content-destroying guards only in repost mode"
```

---

### Task 5: Dispatch, wiring and docs

**Files:**
- Modify: `src/bot.js`, `src/index.js`, `README.md`, `test/bot.test.js`

**Interfaces:**
- Consumes: `deliver` from both `src/delivery/repost.js` and `src/delivery/suppress.js`; `ignoreReason(message, botUserId, mode)`; `loadConfig` returning `{ token, mode, platforms }`.
- Produces: `handleMessage(message, { mode, platforms, webhooks, logger }) -> Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/bot.test.js`:

```js
describe('handleMessage — mode dispatch', () => {
  const PLATFORMS_ON = {
    twitter: { enabled: true, domain: 'fxtwitter.com' },
    instagram: { enabled: true, domain: 'oginstagram.com' },
    tiktok: { enabled: true, domain: 'vxtiktok.com' },
    reddit: { enabled: true, domain: 'rxddit.com' },
    bluesky: { enabled: true, domain: 'fxbsky.app' },
  };
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

  it('suppresses and replies in suppress mode, deleting nothing', async () => {
    const message = fakeMessage({
      member: { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/a.png' },
      reply: vi.fn(async () => {}),
      suppressEmbeds: vi.fn(async () => {}),
      delete: vi.fn(),
    });
    const webhooks = { get: vi.fn() };

    expect(await handleMessage(message, {
      mode: 'suppress', platforms: PLATFORMS_ON, webhooks, logger: silentLogger,
    })).toBe('suppressed');
    expect(message.suppressEmbeds).toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
    expect(webhooks.get).not.toHaveBeenCalled();
  });

  it('reposts through a webhook in repost mode, suppressing nothing', async () => {
    const send = vi.fn(async () => {});
    const message = fakeMessage({
      member: { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/a.png' },
      suppressEmbeds: vi.fn(),
      delete: vi.fn(async () => {}),
    });

    expect(await handleMessage(message, {
      mode: 'repost',
      platforms: PLATFORMS_ON,
      webhooks: { get: vi.fn(async () => ({ send })) },
      logger: silentLogger,
    })).toBe('replaced');
    expect(message.delete).toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  it('returns unchanged in either mode when no link matches', async () => {
    const message = fakeMessage({ content: 'just talking', reply: vi.fn(), delete: vi.fn() });
    expect(await handleMessage(message, {
      mode: 'suppress', platforms: PLATFORMS_ON, webhooks: { get: vi.fn() }, logger: silentLogger,
    })).toBe('unchanged');
    expect(message.reply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bot.test.js`
Expected: FAIL — `handleMessage` ignores `mode` and always reposts.

- [ ] **Step 3: Implement the dispatch**

At the top of `src/bot.js`:

```js
import { deliver as repostDeliver } from './delivery/repost.js';
import { deliver as suppressDeliver } from './delivery/suppress.js';
```

and replace `handleMessage` with:

```js
export async function handleMessage(message, { mode, platforms, webhooks, logger }) {
  const reason = ignoreReason(message, message.client?.user?.id, mode);
  if (reason) return reason;

  const { changed, content } = rewrite(message.content, platforms);
  if (!changed) return 'unchanged';

  const deliver = mode === 'suppress' ? suppressDeliver : repostDeliver;
  return deliver(message, content, { webhooks, logger });
}
```

- [ ] **Step 4: Wire the entrypoint**

In `src/index.js`, pass the mode through:

```js
    const outcome = await handleMessage(message, {
      mode: config.mode, platforms: config.platforms, webhooks, logger,
    });
```

and include it in the ready log so the running mode is visible:

```js
  logger.info(`Logged in as ${ready.user.tag} in ${config.mode} mode. Rewriting: ${enabled || 'nothing'}`);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Update the README**

Add a **Delivery modes** section after Configuration covering: the two values and what each does; that `repost` is the default and today's behaviour; that `LINKFIX_MODE=repost` reverts in seconds without a rebuild; that suppress mode needs only Manage Messages and Send Messages, not Manage Webhooks; and the three limits from the spec — two messages per link, suppression hiding *all* embeds on the message including unrelated ones, and the reply being attributed to the bot rather than the author.

Also update the Invite section to say Manage Webhooks is required only for repost mode.

- [ ] **Step 7: Commit**

```bash
git add src/bot.js src/index.js README.md test/bot.test.js
git commit -m "feat: dispatch delivery by mode and document both"
```

---

## Verification

- [ ] `npx vitest run` — all green, output pristine.
- [ ] `grep -rn "message.delete()" src/` — exactly one call site, in `src/delivery/repost.js`.
- [ ] `grep -rn "suppressEmbeds" src/` — exactly one call site, in `src/delivery/suppress.js`, after a resolved reply.
- [ ] `LINKFIX_MODE=nonsense DISCORD_TOKEN=x node src/index.js` — exits 1 naming the valid modes, no stack trace.
- [ ] Manual smoke test in a real guild, in suppress mode: a plain link, a link on a message **with an image attached** (must now be fixed rather than skipped), and a reply. Then `LINKFIX_MODE=repost` and confirm today's behaviour returns.
