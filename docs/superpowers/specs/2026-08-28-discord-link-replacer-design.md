# Discord Link Replacer — Design

**Date:** 2026-08-28
**Status:** Approved

## Purpose

Discord's native embeds for several social platforms are broken or degraded:
X/Twitter shows no video and frequently no image, Instagram Reels show
nothing useful, TikTok shows a bare link. Community-run mirror domains
(`fxtwitter.com` and friends) serve the same content with working
OpenGraph metadata, so Discord renders a real embed with inline video.

This bot watches guild messages, rewrites links to those platforms to
their mirror equivalents, and reposts the message as the original author
via a channel webhook — so the channel ends up with exactly one message,
attributed to the person who wrote it, with a working embed.

## Success criteria

1. A message containing a single X status link is replaced, within a
   second, by a visually identical message with a working video embed.
2. The bot never destroys content it cannot faithfully reproduce.
3. The bot never loops on its own output or another bot's output.
4. A single malformed message never takes the process down.
5. Swapping a dead mirror domain requires a config edit and a restart,
   not a code change.

## Non-goals

- No database, no per-guild settings, no slash commands. Configuration is
  a static file. (Revisit only if the bot is shared with servers we do
  not run.)
- No resolving of short-link redirects over HTTP. The mirror domains
  handle their own short codes.
- No message editing after repost. The reposted message belongs to the
  webhook, not the user.

## Architecture

A pure rewriting core with a thin Discord shell around it. The core has
no Discord imports and no I/O, so every interesting edge case is a unit
test against a string.

| File | Responsibility |
|---|---|
| `src/rules.js` | Static rule table: host + path patterns per platform |
| `src/rewrite.js` | Pure `rewrite(content, config)` → `{ changed, content }` |
| `src/config.js` | Load and validate `config.json`, apply env overrides |
| `src/webhooks.js` | Get-or-create a channel webhook, cached by channel ID |
| `src/bot.js` | `messageCreate` handler, guard rails, orchestration |
| `src/index.js` | Entrypoint: client construction, login, graceful shutdown |

**Stack:** Node 20, discord.js v14, plain ESM JavaScript, vitest. No
TypeScript — the only structured data is a static rule table, and
avoiding a build step keeps the container trivial.

## Rewrite rules

Each rule matches a set of hosts and a path shape. Path shapes are
deliberately narrow: a bare profile link already embeds acceptably, so
rewriting it would add churn without benefit.

| Platform | Source hosts | Path shape | Default target |
|---|---|---|---|
| twitter | `x.com`, `twitter.com`, `mobile.twitter.com`, `vxtwitter.com`, `fixupx.com` (with or without `www.`) | `/<user>/status/<id>` | `fxtwitter.com` |
| instagram | `instagram.com`, `ddinstagram.com` | `/p/`, `/reel/`, `/reels/`, `/tv/` | `kkinstagram.com` |
| tiktok | `tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com` | `/@<user>/video/<id>`, `/t/<code>`, or a bare short code on the `vm`/`vt` hosts | `vxtiktok.com` |
| reddit | `reddit.com`, `old.reddit.com` | `/r/<sub>/comments/...`, `/r/<sub>/s/<code>` | `rxddit.com` |
| bluesky | `bsky.app` | `/profile/<handle>/post/<id>` | `fxbsky.app` |

Rewriting replaces the host only. Path is preserved verbatim; the
fragment is preserved; known tracking parameters are stripped
(`s`, `t`, `si`, `igsh`, `igshid`, `fbclid`, `ref_src`, `ref_url`, and
anything matching `utm_*`). Remaining query parameters are preserved.

`kkinstagram.com` is the default Instagram target because `fxinstagram.com`
currently redirects there. These mirrors are volunteer-run and go down
periodically; the target domain is configuration for exactly this reason.

## Skip conditions

The rewriter must leave a URL alone when it appears:

- inside a fenced code block or inline backticks;
- inside a `||spoiler||`;
- wrapped in angle brackets (`<https://x.com/...>`) — the author
  explicitly suppressed that embed, and we respect it;
- already pointing at a configured target domain, or at a target domain
  for a disabled platform (no ping-pong between mirrors);
- on a platform disabled in config.

If no URL in the message changes, `rewrite()` reports `changed: false`
and the bot does nothing at all.

## Message handling

The bot ignores a message entirely when any of the following holds:

- the author is a bot, or the message came from a webhook;
- it is not a guild message (webhooks and message deletion are
  unavailable in DMs);
- it is a system message;
- it carries attachments, stickers, a poll, or a forwarded-message
  reference — these cannot be reproduced through a webhook, and deleting
  the original would destroy them;
- the bot lacks Manage Messages or Manage Webhooks in that channel;
- `rewrite()` reports no change.

Otherwise:

1. Resolve the channel webhook (create on first use, then cached).
2. Send the rewritten content through it, with:
   - `username` = the member's display name (nickname-aware),
   - `avatarURL` = the member's display avatar,
   - `threadId` when the message is in a thread,
   - `allowedMentions: { parse: [] }` — mentions still render as chips
     but do not re-notify anyone the original message already pinged,
   - a `-# ↪ replying to <@id>` subtext line prepended when the original
     was a reply, since webhooks cannot carry a reply reference.
3. Delete the original.

**Send before delete, always.** A failed send aborts the delete, so a
message is never destroyed without its replacement already existing. A
failed delete leaves a duplicate and logs a warning — noisy, but not
destructive.

## Error handling

- The `messageCreate` handler is wrapped in try/catch. A single bad
  message logs with channel and message ID and is otherwise dropped.
- Discord error 30007 (maximum webhooks reached, 15 per channel) falls
  back to a plain reply carrying the fixed link, and skips the delete.
- Missing-permission errors are logged once per channel, not per message.
- Unhandled rejections and `SIGTERM`/`SIGINT` trigger a clean client
  destroy so the container stops promptly.

## Configuration

`config.json` holds per-platform `enabled` and `domain`. `DISCORD_TOKEN`
comes from the environment and is required — the process exits with a
clear message if it is absent. Environment variables
`LINKFIX_<PLATFORM>_DOMAIN` and `LINKFIX_<PLATFORM>_ENABLED` override the
file, so a dead mirror can be swapped from compose without editing a
mounted file. Config is validated at startup: unknown platform keys and
malformed domains are fatal, not silently ignored.

## Testing

TDD throughout; the pure core is where the coverage lives.

- **`rewrite()`** — table-driven cases per platform (canonical URL, `www.`
  variant, short link, tracking params, trailing punctuation, multiple
  links in one message, mixed enabled/disabled platforms), plus one case
  per skip condition, plus the no-op path.
- **`config`** — valid load, env override, missing token, malformed domain.
- **`webhooks`** — cache hit does not re-fetch; creation is attempted once.
- **Orchestration** — with a hand-rolled fake message and channel:
  asserts send-then-delete ordering, that a rejected send leaves the
  original intact, that each ignore condition short-circuits before any
  API call, and that the reply subtext line is added only for replies.

No integration test against the live Discord gateway.

## Deployment

A `Dockerfile` (`node:20-alpine`, `npm ci --omit=dev`, non-root user) and
a `compose.yml` with `restart: unless-stopped` and an `env_file`, matching
the existing one-app-per-directory layout on the Hetzner box. Writing
these files is in scope; deploying them to that box is not, and is a
separate conversation.

## Known limits

- **Message Content is a privileged intent.** It must be enabled in the
  Discord Developer Portal or the bot receives empty message content.
  Free below 100 guilds; beyond that it requires Discord verification.
- **Webhook reposts are lossy by nature.** The reply reference becomes a
  text line. The message is no longer editable by its author. Pins and
  existing reply chains pointing at the original message break when it is
  deleted.
- **The audit log attributes the deletions to the bot.** Expected, but
  moderators should be told before it is deployed.
- **Mirror domains are third-party infrastructure.** They can go down or
  change hands. Config-driven domains are the mitigation; there is no
  health check or automatic failover.
