# Delivery Modes — Design

**Date:** 2026-09-01
**Status:** Approved
**Supersedes nothing.** Extends `2026-08-28-discord-link-replacer-design.md`; every
rule in that document still holds unless contradicted here.

## Purpose

The bot currently deletes the author's message and reposts a rewritten copy
through a channel webhook. That produces one clean message, but it destroys
content: any message carrying an attachment, sticker, poll or forward is
skipped entirely, because a webhook cannot reproduce it. It also breaks reply
chains and pins pointing at the original, and prevents the author editing
their own message afterwards.

Discord offers no way for a bot to edit another user's message — authorship is
immutable and no permission unlocks it. But with Manage Messages a bot *can*
set the `SUPPRESS_EMBEDS` flag on someone else's message. That allows a second
delivery strategy: leave the author's message intact, strip only its broken
embed, and reply with the fixed link.

Both strategies ship. A config switch chooses between them, so reverting to the
known-good behaviour is an environment variable and a restart rather than a
code change.

## Success criteria

1. `LINKFIX_MODE=repost` reproduces today's behaviour exactly.
2. In suppress mode, a message with an attachment gets its link fixed instead
   of being ignored.
3. In suppress mode nothing is ever deleted, and the author's message text is
   never altered.
4. An invalid mode is a startup error, not a silent default.
5. Switching modes requires no rebuild.

## Non-goals

- Per-platform or per-guild modes. One global setting.
- Editing another user's message text. Impossible; not revisited.
- Removing repost mode. It stays supported and tested.

## Configuration

`config.json` gains a top-level `"mode"`, sibling to the platform map:

```json
{
  "mode": "suppress",
  "twitter": { "enabled": true, "domain": "fxtwitter.com" }
}
```

Valid values are exactly `"repost"` and `"suppress"`. `LINKFIX_MODE` overrides
the file, case-insensitively. Anything else throws at startup, naming the
offending value and listing the valid ones. The default when unset is
`"repost"`, so an existing deployment upgrades without behaviour change.

`loadConfig` returns `{ token, mode, platforms }`.

## Structure

The two strategies move out of `src/bot.js`, which currently carries both the
guards and the orchestration:

| File | Responsibility |
|---|---|
| `src/delivery/repost.js` | Webhook repost then delete — today's logic, moved |
| `src/delivery/suppress.js` | Reply then suppress the original's embed |
| `src/bot.js` | Guards, mode dispatch |
| `src/webhooks.js` | Unchanged; used only by repost |

Both strategies export the same shape:

```
deliver(message, content, { webhooks, logger }) -> Promise<string>
```

returning an outcome string. `bot.js` selects one by mode and calls it; it does
not know how either works.

## Suppress delivery

1. Reply to the original with the rewritten content, using
   `allowedMentions: { parse: [], repliedUser: false }` — mentions still render
   but nobody the original already pinged is notified again, and the author is
   not pinged by the reply itself.
2. Set `SUPPRESS_EMBEDS` on the original (`message.suppressEmbeds(true)`).

**Reply before suppress, always.** This is the same rule as send-before-delete
and for the same reason. A failed suppression leaves two embeds — untidy. A
failed reply *after* suppressing would leave the author stripped of their embed
with nothing given back, which is worse than the bot not existing. A failed
suppression after a successful reply logs a warning and still reports success.

No reply-reference subtext line is needed: a real Discord reply carries the
relationship natively.

## Guards by mode

`ignoreReason(message, botUserId, mode)`. Applying to both modes: author is a
bot, message came from a webhook, not a guild, system message, missing Manage
Messages or Send Messages, and the author lacking Embed Links — the bot would
still be embedding on behalf of someone denied that ability.

Applying to **repost mode only**, because they exist to prevent destroying
content a webhook cannot reproduce:

- attachments, stickers, polls, forwarded messages
- Manage Webhooks

In suppress mode all four are handled normally. This is the change's main
practical benefit.

## Outcomes

Repost keeps `'replaced'`, `'fallback-reply'`, `'send-failed'`. Suppress adds
`'suppressed'`, and reuses `'send-failed'` when the reply fails. Ignore reasons
and `'unchanged'` are unchanged.

## Testing

TDD throughout. Mode dispatch selects the right strategy; suppress replies
before suppressing; a failed reply never suppresses; a failed suppression after
a successful reply still reports success; guards differ correctly by mode;
`mode` validation accepts both values in any case and rejects everything else.
Repost's existing coverage is preserved by the move, not rewritten.

## Known limits

- **Two messages per link** in suppress mode. That is the visible cost.
- **Suppression is all-or-nothing.** It hides every embed on the message, so a
  message containing a rewritable link *and* an unrelated link loses both; only
  the rewritten one comes back in the reply. There is no per-embed control in
  the API. This is a genuine regression against repost mode.
- The reply is attributed to the bot, not the author. Repost's illusion that
  the author posted it correctly is lost.
- Suppress mode still cannot fix a link the author wrapped in `<>`; that
  remains an explicit opt-out and is respected.
