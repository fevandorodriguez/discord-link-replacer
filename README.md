# Discord Link Replacer

A Discord bot that rewrites links to X/Twitter, Instagram, TikTok, Reddit
and Bluesky into mirror-domain equivalents (`fxtwitter.com`,
`instagirlcock.com`, `vxtiktok.com`, `rxddit.com`, `fxbsky.app`) that produce
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

- **Manage Messages** — to delete the original message after reposting it.
- **Manage Webhooks** — to create and reuse the per-channel webhook it
  posts through.
- **Send Messages** — to post the replacement, and for the plain-reply
  fallback used when a channel has run out of webhook slots.

If the bot is missing these in a given channel, it skips that channel
and logs a warning once (not once per message).

## Configuration

Per-platform settings live in `config.json`:

| Platform | Enabled | Default domain |
|---|---|---|
| twitter | true | `fxtwitter.com` |
| instagram | true | `instagirlcock.com` |
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
| `instagirlcock.com` | In use. Sets `og:url` to the original post, so the embed title links back to Instagram. Full attribution and caption. |
| `toinstagram.com` | Redirects people to instagram.com correctly, but served a *relative* `og:video` on a photo post, which embeds badly. |
| `instagram7.com` | Absolute `og:image` and attribution, but no `og:url`, and rendered poorly in practice. |
| `kkinstagram.com` | Serves no OpenGraph tags at all and sends people to `kkclip.com`. Was the default until this commit. |
| `ddinstagram.com`, `fxinstagram.com` | Dead — no DNS record and a parked IP respectively. |
| `instagramez.com` | **Avoid.** Redirects through an advertising network. |

No mirror restores likes or view counts on the original post; engagement
needs an authenticated action on Instagram's own clients, so any embed
fixer is a dead end for that by construction.

Under Docker Compose, `config.json` is bind-mounted read-only from the
project directory, so editing it and running `docker compose restart`
picks the change up — no rebuild. (The file is also baked into the image
by the `Dockerfile`, so a container run without that mount uses the
copy from build time.)

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
configuration change needs only `docker compose restart`; a code change
needs `docker compose up -d --build`.

## Behaviour and limits

- Messages with **attachments, stickers, a poll, or a forwarded-message
  reference are left alone** — a webhook repost can't faithfully
  reproduce them, and deleting the original would destroy content that
  can't be recreated.
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
