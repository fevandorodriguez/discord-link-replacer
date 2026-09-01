# Discord Link Replacer

A Discord bot that rewrites links to X/Twitter, Instagram, TikTok, Reddit
and Bluesky into mirror-domain equivalents (`fxtwitter.com`,
`oginstagram.com`, `vxtiktok.com`, `rxddit.com`, `fxbsky.app`) that produce
working Discord embeds — inline video, real thumbnails — where the native
links show nothing useful. When it sees a rewritable link it reposts the
fixed message through a channel webhook wearing the original author's name
and avatar, then deletes the original, so the channel ends up with exactly
one message, carrying the original author's name and avatar, with a
working embed.

## Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add a Bot user to it.
3. Under **Bot**, **enable the Message Content Intent**. This is a
   privileged intent — without it, every message the bot receives has
   empty content and nothing will ever be rewritten. This is the single
   most common setup mistake.
4. Copy the bot token and put it in `.env` as `DISCORD_TOKEN`:

   ```
   DISCORD_TOKEN=your-token-here
   ```

## Invite

The bot needs these permissions when you invite it to a server:

- **Manage Messages** — to delete the original message after reposting it
  (repost mode), or to suppress its embed (suppress mode).
- **Manage Webhooks** — to create and reuse the per-channel webhook it
  posts through. Required only for **repost mode**; suppress mode never
  touches a webhook.
- **Send Messages** — to post the replacement, and for the plain-reply
  fallback used when a channel has run out of webhook slots.

If the bot is missing these in a given channel, it skips that channel
and logs a warning once (not once per message).

## Configuration

Per-platform settings live in `config.json`:

| Platform | Enabled | Default domain |
|---|---|---|
| twitter | true | `fxtwitter.com` |
| instagram | true | `oginstagram.com` |
| tiktok | true | `vxtiktok.com` |
| reddit | true | `rxddit.com` |
| bluesky | true | `fxbsky.app` |

Each platform can be overridden from the environment without editing the
file, using `LINKFIX_<PLATFORM>_DOMAIN` and `LINKFIX_<PLATFORM>_ENABLED`
(platform name upper-cased), for example:

```
LINKFIX_INSTAGRAM_DOMAIN=toinstagram.com
LINKFIX_TIKTOK_ENABLED=false
```

`enabled` must be a real JSON boolean (`true` / `false`, not `"true"`),
and the env override accepts only `true` or `false` (any case). Anything
else is a startup error rather than a silent guess.

These mirror domains are volunteer-run, third-party infrastructure — they
go down or change hands periodically. When one does, swap it with an
env override (or edit `config.json`) and restart; no code change needed.

Instagram mirrors tested 2026-09-01, so a swap is a choice rather than a
guess:

| Mirror | Behaviour |
|---|---|
| `oginstagram.com` | In use. Verified working in Discord. Note it serves 403 to datacenter IPs, so it cannot be probed with `curl` from a VPS — that does not affect the bot, which never fetches the mirror itself. |
| `uuinstagram.com` | Works, including reels, though reels can be slow to appear. Sets `og:url` to the original post; album index via path. Serves a relative `og:video` URL. |
| `toinstagram.com` | Same InstaFix family as `uuinstagram`, with the same relative `og:video`. The natural fallback. |
| `instagirlcock.com` | Also sets `og:url`, with an absolute `og:image`, full attribution and the caption. Functionally the strongest tested; the domain name is the problem. |
| `instagram7.com` | Absolute `og:image` and attribution, but no `og:url`, and rendered poorly in practice. |
| `kkinstagram.com` | Serves no OpenGraph tags at all and sends people to `kkclip.com`. |
| `ddinstagram.com`, `fxinstagram.com` | Dead — no DNS record and a parked IP respectively. |
| `instagramez.com` | **Avoid.** Redirects through an advertising network. |

`/share/` links could not be verified against any mirror: a made-up share
code returns 404 everywhere, so testing needs a real one. If share links
stop embedding after a mirror swap, that is the first thing to check.

No mirror restores likes or view counts on the original post; engagement
needs an authenticated action on Instagram's own clients, so any embed
fixer is a dead end for that by construction.

Under Docker Compose, `config.json` is bind-mounted read-only from the
project directory, so editing it and running `docker compose restart`
picks the change up — no rebuild. (The file is also baked into the image
by the `Dockerfile`, so a container run without that mount uses the
copy from build time.)

## Delivery modes

How a rewritten link reaches the channel is controlled by `LINKFIX_MODE`
(or `mode` in `config.json`; the env var wins):

```
LINKFIX_MODE=repost   # default
LINKFIX_MODE=suppress
```

`LINKFIX_MODE` always wins over `config.json`: if it is set at all, `mode`
in `config.json` is not consulted, full stop. So if you enabled suppress
mode via the env var, you must revert it via the env var too — editing
`mode` in `config.json` and restarting will do nothing, silently. The
ready-log line on startup (`Logged in as ... in <mode> mode (from ...)`)
names which of the two actually won, so it's the first thing to check if
a mode change doesn't seem to have taken effect.

- **`repost`** (default) — today's behaviour, described above: delete the
  original message and repost the fixed link through a channel webhook
  wearing the author's name and avatar. The channel ends up with exactly
  one message.
- **`suppress`** — leave the original message exactly as the author wrote
  it, reply to it with the fixed link, then strip the embed from the
  original. Nothing is deleted. Because nothing is deleted or reposted
  through a webhook, this is also the only mode that handles messages
  with attachments, stickers, a poll, or a forwarded-message reference —
  repost mode skips those entirely (see Behaviour and limits below). That
  is the main reason to choose suppress over repost.

Repost is the default because it's the behaviour this bot has always had.
Suppress mode exists as a lower-privilege, non-destructive alternative for
servers where deleting and reimpersonating members isn't acceptable, and
as an emergency rollback path: if suppress mode misbehaves in production,
setting `LINKFIX_MODE=repost` and restarting returns to the known-good
repost behaviour in seconds, with no rebuild — a plain process restart
locally, or `docker compose up -d` under Compose (not `restart`, which
doesn't re-read `.env`).

Suppress mode also needs less from the server: **Manage Messages** and
**Send Messages** are enough — it never requires **Manage Webhooks**,
since it never posts through a webhook. See Invite above.

Suppress mode's limits:

- **Two messages per link, not one.** The original stays, and the fixed
  link arrives as a separate reply — repost mode's single-message result
  doesn't apply here.
- **Suppressing embeds is all-or-nothing per message.** Discord's
  `suppressEmbeds` hides every embed on the message, not just the one
  for the rewritten link. If the original message contained an unrelated
  link too, that embed disappears as well, and only the rewritten link's
  embed comes back, in the reply.
- **The reply is posted by the bot, not the author.** Unlike a repost
  (which wears the author's name and avatar via the webhook), the
  suppress-mode reply is visibly the bot's own message.

## Running

Locally:

```bash
npm install
npm start
```

With Docker Compose:

```bash
docker compose up -d
```

Both read `DISCORD_TOKEN` from `.env` (see `.env.example`). A missing
token — or an invalid one, or Message Content left disabled in the
Developer Portal — makes the process print a readable error and exit 1
rather than starting up broken or crash-looping silently.

Compose mounts `./config.json` into the container read-only, so a
`config.json` change (mirror domains, per-platform enable/disable, `mode`
when it's not overridden by `LINKFIX_MODE`) needs only
`docker compose restart` — that rereads the file, no rebuild.

An `.env` change — **including `LINKFIX_MODE`** — is different: `restart`
stops and starts the *existing* container, and environment loaded via
`env_file` is baked in at container-create time, so `restart` will not
pick it up. Use `docker compose up -d` instead, which recreates the
container with the new environment. This is the command the Delivery
modes rollback path above depends on.

A code change needs `docker compose up -d --build`, to also rebuild the
image.

If `docker compose up -d` ever reports the container as already up to
date and you're not seeing the change, add `--force-recreate` to force
it: `docker compose up -d --force-recreate`.

## Behaviour and limits

- **In repost mode**, messages with **attachments, stickers, a poll, or a
  forwarded-message reference are left alone** — a webhook repost can't
  faithfully reproduce them, and deleting the original would destroy
  content that can't be recreated. **Suppress mode has none of this
  limitation**: since it deletes nothing and never posts through a
  webhook, it handles all four kinds of message normally. See Delivery
  modes above.
- **If the author is denied Embed Links in that channel, the message is
  left alone.** Webhook messages aren't subject to the posting member's
  permissions, so reposting would embed a link the server has explicitly
  denied that user — a common anti-scam setting. The bot fails closed
  rather than working around the server's own moderation.
- A webhook can't carry a reply reference, so **when the original message
  was a reply, that relationship is reduced to a text line**
  (`-# ↪ replying to <@user>`) prepended to the repost — the reposted
  message is not a "real" Discord reply.
- The reposted message belongs to the webhook, not the original author:
  it is not editable by them, and it is a new message ID, so existing
  pins or reply chains pointing at the original break when it is deleted.
  **Discord also renders an "APP" badge beside the name on webhook
  messages**, so the repost is not indistinguishable from a message the
  author sent themselves.
- **Deletions of the original message appear in the server audit log as
  performed by the bot**, not the original author. This is expected
  behaviour, but moderators should know about it before the bot is
  deployed.
- **Mirror domains are volunteer-run third-party infrastructure** and can
  go down or change ownership without notice. The bot has no health
  check or automatic failover for this — the configured domain
  (`config.json` or a `LINKFIX_<PLATFORM>_DOMAIN` override) is the
  mitigation: swap it and restart when a mirror stops working.
- Message Content is a privileged intent — free to enable below 100
  guilds, but requires Discord app verification beyond that.
