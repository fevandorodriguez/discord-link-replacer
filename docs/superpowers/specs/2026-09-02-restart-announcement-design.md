# Restart Announcement — Design

**Date:** 2026-09-02
**Status:** Approved
**Extends** the admin panel and delivery-mode designs; every rule in those still
holds.

## Purpose

When the bot comes back up, it says something in a channel of your choosing, so
a restart is visible rather than silent. The quips and the channel are both
managed from the admin panel, and a test button proves the whole chain works
without waiting for a restart.

## Success criteria

1. With no channel configured the bot says nothing, and that is the default.
2. With a channel configured, every successful login posts one quip at random.
3. Quips can be added and removed from the panel, and survive a restart.
4. The channel is picked from a dropdown of channels the bot can actually post
   in — never a hand-typed ID.
5. The test button posts through exactly the same path a restart uses, and says
   plainly why it failed when it fails.
6. A quip containing `@everyone` cannot ping anyone.

## Non-goals

- No cooldown between restart announcements. Every restart speaks; that is a
  deliberate choice, with the consequence recorded under Known limits.
- No scheduling, no shutdown message, no per-guild configuration.
- No new runtime dependency.

## Configuration

`config.json` gains one top-level object, sibling to `mode` and the platforms:

```json
{
  "mode": "repost",
  "announce": {
    "channelId": "",
    "quips": ["Someone turned me off. Cheeky bastard.", "What did I miss?!"]
  },
  "twitter": { "enabled": true, "domain": "fxtwitter.com" }
}
```

**`loadConfig` walks every top-level key and rejects anything that is not a
known platform.** It already carries an exception for `mode`; `announce` needs
the same one or the bot refuses to start. This exact trap was hit once already
when `mode` was introduced, so it is called out here rather than left to be
rediscovered.

Validation, fatal at startup like every other config error:

- `channelId` — a string. Empty means announcements are off. Non-empty must be
  digits only: the panel always supplies a real id from its dropdown, so there
  is no name resolution and no ambiguity to guess at.
- `quips` — an array of non-empty strings, each at most 2000 characters
  (Discord's message limit), at most 50 of them.

Both keys are optional; an absent `announce` behaves as an empty one.

## Writing config from two places

`mode-store.js` already writes `mode` back to `config.json`: read, verify the
parsed root is a plain object, mutate one key, write to a temp file beside the
target, copy the original's permissions onto it, rename over. That sequence took
two review rounds to get right — the root guard and the permission preservation
were both defects found by probing.

The announce settings need exactly that sequence. Duplicating it would be
verbatim duplication of a logic block, which this project's own review rubric
treats as a defect, so it is extracted instead:

`src/config-writer.js` — `updateConfig(file, mutate)` where `mutate` receives the
parsed object and changes it in place. `mode-store.js` and the new announce store
both call it.

**`mode-store.js`'s existing tests must pass unchanged.** It is the panel's only
working control and has been through two fix rounds; the extraction is behaviour
preserving or it is wrong.

## The announcement

`src/announce.js` — `announce(channelId, quips, { client, logger })`.

Resolves the channel, picks one quip at random, and posts it with
`allowedMentions: { parse: [] }`. That last part is not cosmetic: quips are
free text set through a password-gated web page, and without it a quip
containing `@everyone` would ping the whole server on every restart.

Returns a result describing what happened rather than throwing — the test
button needs to report the reason, and a failed announcement must never take
the bot down:

| Result | When |
|---|---|
| `sent` | Posted |
| `no-channel` | No channel configured |
| `no-quips` | Channel set, list empty |
| `channel-missing` | The id resolves to nothing the bot can see |
| `not-postable` | The channel exists but the bot cannot send there |
| `failed` | The send itself was rejected |

Called from `ClientReady`, after the existing login log line, and from the test
endpoint. One code path, so a passing test button genuinely proves the restart
path.

## Admin panel

Three additions to the existing dashboard:

- **Channel picker.** A dropdown listing channels the bot can post in, plus a
  "none" option that switches announcements off. The admin server has no access
  to the Discord client today, so it takes an injected `listChannels()`. It must
  be a function rather than a list: the panel starts before login, and before
  the client is ready it returns nothing.
- **Quip list.** Add and remove, persisted to `config.json`.
- **Test button.** Posts a real quip through the real path and shows the result.
  A real quip rather than a synthetic one, because a test that exercises a
  different message is not testing the thing you care about.

New routes, all requiring a session, matching the existing table's shape:

| Route | Method | Purpose |
|---|---|---|
| `/api/announce` | GET | Current channel, quips, and the channel list |
| `/api/announce` | POST | Set the channel and/or replace the quip list |
| `/api/announce/test` | POST | Post one now, return the outcome |

**The test endpoint is rate limited to one call per 30 seconds**, server side.
Without the button, a leaked panel password buys arbitrary bot text on the next
restart; with it, that text can be fired into any visible channel on demand and
repeatedly. The cooldown caps that, and a disabled button in the UI does not,
because the button is not the attack surface — the endpoint is.

## Testing

TDD throughout.

- **Config:** `announce` accepted and not mistaken for a platform, each
  validation rule, absent key defaulting cleanly.
- **Config writer:** the extraction preserves the root guard, the permission
  copy, the atomic rename, and leaves no temp file behind. Every existing
  mode-store test passes unmodified.
- **Announce:** each of the six results, a random pick that stays inside the
  list, mentions suppressed, and no path that throws.
- **Quip store:** add, remove, the length and count caps, persistence.
- **Admin routes:** unauthenticated requests refused, the cooldown enforced on
  the second call, malformed bodies rejected as 400 rather than 500.
- **Page:** the quip list and channel dropdown render, and quips are escaped —
  they are free text going into HTML.

## Known limits

- **Every restart announces.** A crash loop that gets past a successful login
  will repeat the quip until someone notices. A failed login exits before it can
  speak, so the common failure is already silent. Chosen deliberately over a
  cooldown.
- Anyone with the panel password can make the bot post arbitrary text in any
  channel it can see, immediately via the test button. Inherent to the feature;
  the caps and the cooldown bound it rather than remove it.
- The channel list reflects what the bot can see when the panel is loaded. A
  channel created afterwards needs a page refresh.
- If the configured channel is later deleted or the bot loses access, the
  announcement fails silently on restart and is only visible in the log. The
  test button is the way to find out deliberately.
