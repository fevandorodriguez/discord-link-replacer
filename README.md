# Discord Link Replacer

A Discord bot that rewrites links to X/Twitter, Instagram, TikTok, Reddit
and Bluesky into mirror-domain equivalents (`fxtwitter.com`,
`oginstagram.com`, `tnktok.com`, `vxreddit.com`, `fxbsky.app`) that produce
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
| tiktok | true | `tnktok.com` |
| reddit | true | `vxreddit.com` |
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

### Mirrors in use

Every one of these was verified by fetching a real post and reading the
response body, not by checking the status code — two mirrors died while
still answering HTTP 200 with an error page, which is exactly what a status
check misses.

| Platform | Mirror | Why this one |
|---|---|---|
| twitter | `fxtwitter.com` | Stable throughout; the reference implementation of the pattern. |
| instagram | `oginstagram.com` | Sets `og:url` back to the original post, so the embed title links to Instagram. Serves 403 to datacenter IPs, so it cannot be probed with `curl` from a VPS — irrelevant to the bot, which never fetches a mirror. |
| tiktok | `tnktok.com` | fxTikTok. Handles `/video/` and `/photo/` slideshows, and serves `og:image` from its own CDN. |
| reddit | `vxreddit.com` | Serves `og:image` straight from `i.redd.it` rather than proxying through a third party. |
| bluesky | `fxbsky.app` | Stable throughout. |

### Tested alternates

Working, but second choice — each proxies media through a third-party
rewrite host rather than the platform's own CDN:

| Platform | Alternate | Note |
|---|---|---|
| instagram | `toinstagram.com`, `uuinstagram.com` | InstaFix family. Set `og:url` correctly; serve a *relative* `og:video`, which embeds less reliably. |
| instagram | `instagram7.com` | Absolute `og:image` and attribution, but no `og:url`, and rendered poorly in practice. |
| tiktok | `fixtiktok.com` | Works; routes through a `workers.dev` subdomain. |
| reddit | `redditez.com` | Works; proxies through `embedez.com`. |

### Known dead

Kept here so nobody re-tries them:

| Mirror | State |
|---|---|
| `vxtiktok.com` | Taken down by a legal request. Serves the notice at **HTTP 200**. |
| `rxddit.com` | Reddit is actively blocking it via API changes. Front page looks healthy; every real post returns a block notice. |
| `ddinstagram.com` | No DNS record. |
| `fxinstagram.com` | Resolves to a parked IP; connections time out. |
| `kkinstagram.com` | Serves no OpenGraph tags and redirects people to `kkclip.com`. |
| `instagramez.com` | **Avoid.** Redirects through an advertising network. |

### Swapping one

A dead mirror is a config change, not a code change — `LINKFIX_<PLATFORM>_DOMAIN`
in `.env` (then `docker compose up -d`), or the `domain` field in
`data/config.json` (then `docker compose restart`).

The bot checks every configured mirror on boot and once a day, and warns
in the log and the admin panel when one looks broken. A platform may also
set a `canary` path — a real post — because a mirror blocked at the API
serves a perfectly healthy front page; `rxddit` did exactly that.

Two caveats worth knowing. `/share/` links have never been verified against
any Instagram mirror: a made-up share code returns 404 everywhere, so
testing needs a real one, and that is the first thing to check if share
links stop embedding after a swap. And no mirror restores likes or view
counts on the original post — engagement needs an authenticated action on
the platform's own clients, so any embed fixer is a dead end for that by
construction.

Under Docker Compose, the whole `data/` directory (not `config.json`
itself — see Running below for why) is bind-mounted read-write from the
project directory, so editing `data/config.json` and running
`docker compose restart` picks the change up — no rebuild. (A default
`config.json` is also baked into the image by the `Dockerfile`, so a
container run without that mount uses the copy from build time.)

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

Compose mounts `./data` (not `./config.json` directly) into the container
at `/app/data`, read-write, and the container is pointed at
`/app/data/config.json` via `LINKFIX_CONFIG_FILE` (set in the
`Dockerfile`). Edit `data/config.json` on the host — that's the live file
now, the same one the admin panel's mode toggle writes to — and
`docker compose restart` picks up a hand edit (mirror domains,
per-platform enable/disable, `mode` when it's not overridden by
`LINKFIX_MODE`) with no rebuild, exactly as before.

This is a directory mount rather than a single-file mount so the admin
panel can write to it: bind-mounting one file makes that path its own
mount point, and on Linux `rename()` onto a mount point fails with EBUSY,
which broke the panel's atomic write-then-rename on every mode change
under the old single-file layout. **`data/config.json` must exist in the
project directory before the first `docker compose up`** — the repo ships
one, so a normal `git clone`/`git pull` already has it, but if you ever
delete it, recreate it (e.g. `cp config.json data/config.json`) before
starting the container, or the bind mount hides the image's own default
and `loadConfig` fails with a readable "file not found" error rather than
starting broken.

**The host directory must be writable by the container's user, and the
Dockerfile cannot do this for you.** The image runs as `node`, uid 1000,
and the `Dockerfile` does `chown` `/app/data` — but a bind mount replaces
that directory at runtime, and permission checks then use the *host*
inode's ownership, so the image-time `chown` has no effect. On a host
where the project sits under a root-owned path (`/opt/<app>`, say),
`./data` is `root:root` and uid 1000 cannot write to it: the panel's mode
toggle fails with `EACCES` before it ever reaches the rename, and the API
reports it as a 500. Set it once, on the host:

```bash
chown -R 1000:1000 ./data
```

Match the numeric uid, not a name — the container's `node` is uid 1000
regardless of what user 1000 is called on the host.

**Upgrading from the old single-file layout?** If you previously ran with
`./config.json:/app/config.json:ro` in `compose.yml`, copy your live,
hand-edited file across before the first `docker compose up -d` on the new
layout:

```bash
cp config.json data/config.json
chown -R 1000:1000 data
```

Without this, `data/config.json` starts at the repo's committed defaults
while your customised root `config.json` sits unread beside it — mirror
domains you swapped and a hand-set `mode` revert silently, with no error.

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

## Admin panel

A small password-gated page, served from inside the bot process at
`discord.fev.space`, that shows recent delivery activity and lets you
switch between `repost` and `suppress` without touching the server. It
never shows a message or a rewritten link — but it is not limited to a
channel name and a level either: an entry can include the channel ID, the
message ID, the bot's own Discord tag, the platform config, Discord API
error text, and a full stack trace when something failed. Size what a
leaked panel password costs you accordingly; see Limits below.

### Enabling it

The panel does not start unless `ADMIN_PASSWORD_HASH` is set. Generate
one with:

```bash
npm run hash-password -- "your password"
```

and put the result in `.env` as `ADMIN_PASSWORD_HASH`. **This is
deliberate fail-closed behaviour**: an unset or malformed hash means no
panel, logged as a warning, rather than a panel with a guessable or
absent password. The bot itself is unaffected either way.

`SESSION_SECRET` is optional. If it's unset — or set but empty, which
`.env.example` deliberately avoids by shipping the line commented out
rather than as `SESSION_SECRET=` — a random secret is generated at process
start, which means every session (i.e. every signed-in browser) is
invalidated on restart and you'll need to sign in again. Set
`SESSION_SECRET` to a fixed value of **at least 32 characters** in `.env`
if you'd rather sessions survive a restart. Unlike unset, an explicit
value that's too short is **not** filled in for you: the panel logs a
warning and refuses to start at all, the same fail-closed handling as a
missing `ADMIN_PASSWORD_HASH` — a short secret is brute-forceable, and a
forged session cookie is a full bypass of the password gate, so this
never falls back to "start anyway."

Because these are `.env` values, changing either of them needs
`docker compose up -d` (not `restart`) to take effect — see the env vs.
config.json vs. code distinction under Running above; it applies here
too. `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` and `ADMIN_PORT` are all
`.env` values.

### Caddy

Point a subdomain at the container over the internal `monkey` network
(see `compose.yml` — the container joins it but publishes no port to the
host, so the panel is reachable only through Caddy):

```
discord.fev.space {
	reverse_proxy link-replacer:3000
}
```

**Adding this block requires reloading Caddy**, and this Caddy instance
fronts around ten other, unrelated live apps on the same box — a reload
affects all of them, not just this one. Treat it accordingly.

The `3000` above must match `ADMIN_PORT` (default 3000 if unset) — if you
set `ADMIN_PORT` in `.env`, update this block to the same port and reload
Caddy, or the proxy silently points at the wrong port and the panel
becomes unreachable through Caddy even though the container itself is
fine.

### Limits

- **The login rate limiter is global, not per visitor.** The container
  sits behind Caddy, so every request's socket address is Caddy's own,
  not the actual visitor's — the limiter cannot tell requests apart by
  origin, so it counts failures for everyone in one shared bucket. Five
  failed logins from *anyone* (including you, mistyping your own
  password) locks the panel for fifteen minutes for *everyone*, and
  because the limiter's state lives only in memory, the one way to clear
  it early is to restart the container. This is a deliberate trade-off,
  not an oversight: there is exactly one legitimate user, and an
  attacker has no way to influence which bucket their attempts land in.
- **Mode is locked when `LINKFIX_MODE` is set in the environment.** The
  env var always wins over `config.json` (see Delivery modes above), so
  when it's set the panel's toggle is disabled and shows which variable
  to unset to hand control back to the panel. It never silently accepts
  a change that `LINKFIX_MODE` would then override.
- **History is memory-only and capped.** Recent activity resets on every
  restart and only keeps the most recent entries; it is not a
  persistent audit log.
- **No attribution.** An entry names the channel and what happened, not
  which member's message triggered it.

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
