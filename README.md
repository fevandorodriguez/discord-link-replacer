# Discord Link Replacer

A Discord bot that rewrites links to X/Twitter, Instagram, TikTok, Reddit
and Bluesky into mirror-domain equivalents (`fxtwitter.com`,
`kkinstagram.com`, `vxtiktok.com`, `rxddit.com`, `fxbsky.app`) that produce
working Discord embeds — inline video, real thumbnails — where the native
links show nothing useful. When it sees a rewritable link it reposts the
fixed message through a channel webhook wearing the original author's name
and avatar, then deletes the original, so the channel ends up with exactly
one message, attributed to the person who wrote it, with a working embed.

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
- **Send Messages**

If the bot is missing these in a given channel, it skips that channel
and logs a warning once (not once per message).

## Configuration

Per-platform settings live in `config.json`:

| Platform | Enabled | Default domain |
|---|---|---|
| twitter | true | `fxtwitter.com` |
| instagram | true | `kkinstagram.com` |
| tiktok | true | `vxtiktok.com` |
| reddit | true | `rxddit.com` |
| bluesky | true | `fxbsky.app` |

Each platform can be overridden from the environment without editing the
file, using `LINKFIX_<PLATFORM>_DOMAIN` and `LINKFIX_<PLATFORM>_ENABLED`
(platform name upper-cased), for example:

```
LINKFIX_INSTAGRAM_DOMAIN=ddinstagram.com
LINKFIX_TIKTOK_ENABLED=false
```

These mirror domains are volunteer-run, third-party infrastructure — they
go down or change hands periodically. When one does, swap it with an
env override (or edit `config.json`) and restart; no code change needed.

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
token makes the process print a readable error and exit 1 rather than
starting up broken.

## Behaviour and limits

- Messages with **attachments, stickers, a poll, or a forwarded-message
  reference are left alone** — a webhook repost can't faithfully
  reproduce them, and deleting the original would destroy content that
  can't be recreated.
- A webhook can't carry a reply reference, so **when the original message
  was a reply, that relationship is reduced to a text line**
  (`-# ↪ replying to <@user>`) prepended to the repost — the reposted
  message is not a "real" Discord reply.
- The reposted message belongs to the webhook, not the original author:
  it is not editable by them, and it is a new message ID, so existing
  pins or reply chains pointing at the original break when it is deleted.
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
