# Admin Panel — Design

**Date:** 2026-09-01
**Status:** Approved
**Extends** `2026-09-01-delivery-modes-design.md`; every rule there still holds.

## Purpose

Switching delivery mode currently means an SSH session, editing `.env` or
`config.json`, and `docker compose up -d`. Seeing what the bot is doing means
`docker logs`. Both are fine at a desk and useless from a phone.

A small password-gated page at `discord.fev.space` exposes the one lever worth
reaching for in a hurry — the delivery mode — and a view of recent outcomes and
errors.

## Success criteria

1. The mode can be changed from a browser and takes effect on the next message,
   with no restart and no redeploy.
2. When `LINKFIX_MODE` is set, the panel shows the toggle as locked and says
   why, rather than accepting a change that silently does nothing.
3. With `ADMIN_PASSWORD_HASH` unset, the HTTP server does not start.
4. No message content ever reaches the panel or its log buffer.
5. `docker logs` output is unchanged.

## Non-goals

- Editing platform toggles or mirror domains. Those stay SSH-only.
- Persisting log history across restarts.
- Multiple users, roles, or an audit trail. One shared password.
- Any new runtime dependency.

## Where it runs

**In the bot process.** The alternative — a separate admin container able to
change the bot's behaviour — needs either the Docker socket (root-equivalent on
a host running ten unrelated live apps, reachable from the internet) or a shared
state file plus a restart mechanism. Serving from the bot makes a mode change an
in-memory assignment. That difference is the whole reason for this choice.

## Zero new dependencies

Node 20 provides all of it: `node:http` for the server, `crypto.scrypt` for
password hashing, `crypto.timingSafeEqual` for comparison, `crypto.createHmac`
for cookie signing. No web framework, no bcrypt native module. On an
internet-facing admin surface, each dependency is supply-chain surface that
~150 lines of built-ins avoid.

## Authentication

`ADMIN_PASSWORD_HASH` holds a scrypt hash in `salt:hash` hex form. The plaintext
is never stored, logged, or echoed. **If the variable is absent or malformed the
HTTP server does not start** — a misconfigured deploy yields no panel rather than
an unprotected one. The bot's Discord side runs regardless; the panel is
optional, its absence is not fatal to link rewriting.

Login is a real HTML form, not `WWW-Authenticate`. The fields carry
`autocomplete="username"` and `autocomplete="current-password"` so a password
manager offers to save and fill them; browsers treat basic-auth prompts
inconsistently, which is the reason for this choice.

On success the response sets a session cookie holding `expiry` and an HMAC over
it, keyed by `SESSION_SECRET`. Flags: `HttpOnly`, `Secure`, `SameSite=Strict`,
`Path=/`. Verification is constant-time via `timingSafeEqual`. An expired or
unverifiable cookie is treated as absent.

`SESSION_SECRET` is read from the environment; when unset, a random secret is
generated at startup, which invalidates sessions on restart. That is an
acceptable default and is documented rather than silently surprising.

Failed logins are rate-limited per client IP: after 5 failures within 15
minutes, further attempts are refused for 15 minutes regardless of correctness.
The counter is in memory. The client IP comes from the socket, not from a
client-supplied header — the origin is reachable only through Caddy, so the
socket address is the trustworthy value.

## Mode changes

Mode already resolves as `LINKFIX_MODE` → `config.json` → default, and
`loadConfig` reports which source won as `modeSource`.

The panel writes to `config.json`, which is already bind-mounted and already the
documented file lever. It re-reads and re-validates through the existing
`loadConfig` path, so a value written by the panel is subject to exactly the same
validation as one written by hand.

**When `modeSource` is `LINKFIX_MODE`, the toggle renders disabled**, with text
naming the variable and saying it must be unset for the panel to take control.
The API refuses such a change with a 409 and the same explanation. This is
deliberate: the alternative is a control that appears to work and does nothing,
which is the failure this project has already shipped once.

The running mode is held in a mutable holder that `messageCreate` reads per
message, so a change applies to the next message. Messages already being handled
finish under the mode they started with.

## Log buffer

A ring buffer of the last 200 entries. The logger becomes a thin wrapper that
writes to stdout as now **and** appends to the buffer, so `docker logs` is
unchanged and the buffer is purely additive.

Each entry holds a timestamp, a level, the outcome or error text, and the channel
name where one is known. **Message content is never recorded**, and neither are
the rewritten URLs. A panel behind one shared password that displayed what people
were posting would be a far larger thing to leak than a mode toggle.

## HTTP surface

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/` | GET | session or redirect | Dashboard, or the login form |
| `/login` | POST | none, rate-limited | Verify password, set cookie |
| `/logout` | POST | session | Clear the cookie |
| `/api/state` | GET | session | JSON: mode, modeSource, entries |
| `/api/mode` | POST | session | Set mode; 409 if env-overridden |

Anything else returns 404. All state-changing routes are POST, and the
`SameSite=Strict` cookie is what defends them from cross-site submission.

The dashboard is one self-contained HTML page with inline CSS and a small script
polling `/api/state` every few seconds. No build step, no external assets, no CDN.

## Networking

The container joins the existing external `monkey` Docker network so Caddy can
reach it by service name. **The port is not published to the host** — it is
reachable only from inside Docker and through Caddy, which sits behind Cloudflare
with the origin already firewalled to Cloudflare ranges.

One Caddyfile block, matching the existing `text.fev.space` pattern:

```
discord.fev.space {
	reverse_proxy link-replacer:3000
}
```

**Adding it requires reloading Caddy, which fronts roughly ten unrelated live
apps.** The reload is graceful and adds a block rather than altering existing
ones, but it is shared production infrastructure and needs explicit approval at
deploy time.

## Testing

TDD throughout. The auth primitives (hash verification, cookie signing and
verification, expiry, the rate limiter), the ring buffer including eviction and
the absence of content fields, and the route handlers against hand-rolled
request and response fakes: correct password sets a cookie, wrong password does
not, an unauthenticated request to `/api/state` is refused, `/api/mode` refuses
with 409 when the env var wins, and a successful mode change is visible in the
next `/api/state`.

No live HTTP listener in tests.

## Known limits

- Log history is memory-only; a restart clears the panel's view. `docker logs`
  retains the full record.
- A leaked password permits flipping the mode and reading channel names. The
  content-free log buffer bounds that.
- The rate limiter is per-process and in-memory, so a restart clears it.
- One shared password means no attribution: the panel cannot say who changed the
  mode.
- The panel cannot edit platform toggles or mirror domains by design; those
  remain a one-line SSH change.
