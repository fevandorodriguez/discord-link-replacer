import { createServer } from 'node:http';
import { MAX_QUIPS, MAX_QUIP_LENGTH } from '../config.js';
import { verifyPassword, signSession, verifySession, createRateLimiter } from './auth.js';
import { renderLogin, renderDashboard } from './page.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE_FLAGS = 'HttpOnly; Secure; SameSite=Strict; Path=/';
const BODY_LIMIT = 4096;
// POST /api/announce is the one body that is legitimately large: it carries
// the WHOLE quip list on every Save, and the caps say that list may hold
// MAX_QUIPS entries of MAX_QUIP_LENGTH characters. Derived from those two
// constants rather than hardcoded, so raising a cap cannot leave the limit
// behind and turn legal input back into an unexplained failure.
//
//   MAX_QUIP_LENGTH counts UTF-16 code units, and JSON.stringify expands the
//   worst of them (a control character, a lone surrogate) to a 6-byte \uXXXX
//   escape, so one quip is at most 6 * MAX_QUIP_LENGTH bytes, plus 3 for its
//   two quotes and the comma after it:
//     50 * (6 * 2000 + 3)  = 600,150 bytes of quips
//   plus BODY_LIMIT again as headroom for the envelope -- the key names, the
//   brackets, a ~20-digit channel id, and any whitespace a hand-written
//   client might indent with:
//     600,150 + 4,096      = 604,246 bytes
const ANNOUNCE_BODY_LIMIT = MAX_QUIPS * (6 * MAX_QUIP_LENGTH + 3) + BODY_LIMIT;
// A short or empty secret is brute-forceable (or, for '', publicly known --
// see createAdminServer below), which would let a forged cookie sail past
// verifySession. 32 chars gives at least 128 bits from a hex secret, more
// from anything richer.
const MIN_SESSION_SECRET_LENGTH = 32;
// One test post per this window. The panel has one legitimate user, so this
// is not about them: it bounds what a leaked password can do, since the test
// endpoint turns "arbitrary text on the next restart" into "arbitrary text in
// any visible channel, now, repeatedly".
const TEST_ANNOUNCE_COOLDOWN_MS = 30000;
// A fixed key, because this limit is per-endpoint rather than per-caller.
const TEST_ANNOUNCE_KEY = 'announce-test';

// Reads at most `limit` bytes from the request body. Returns the decoded body
// alongside `tooLarge`, so the caller can answer with a status code of its own
// choosing rather than this function deciding for it.
//
// Buffers are concatenated and decoded once at the end (rather than the more
// obvious `body += chunk`, which coerces each Buffer to a string as it
// arrives via implicit toString('utf8') and can split a multi-byte UTF-8
// character across a chunk boundary, corrupting it).
//
// Nothing here destroys the request, and that is the whole point. This used
// to call req.destroy() on the over-limit chunk, which resets the socket and
// the client sees a connection failure INSTEAD OF a response -- the same
// class of bug as the reverted req.destroy() calls that swallowed 401/409/429
// for clients mid-upload. `for await` cannot be used either: breaking out of
// it calls the async iterator's return(), which destroys the stream and takes
// the socket with it, so the bug would simply come back wearing a `break`.
//
// Instead the over-limit case resolves IMMEDIATELY (a second resolve from
// 'end' is a no-op), so the caller's response is written while the client is
// very likely still uploading -- which is exactly when it needs to arrive.
// The 'data' listener stays attached so the rest of the body is read and
// discarded, never buffered, letting the request end cleanly.
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          resolve({ body: '', tooLarge: true });
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', reject);
  });
}

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function authenticated(req, secret) {
  return verifySession(cookieValue(req.headers.cookie, 'session'), secret);
}

function json(res, code, payload, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function html(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export async function handleRequest(req, res, deps) {
  const { modeStore, logBuffer, passwordHash, sessionSecret, limiter, logger = console,
          announceStore, listChannels, announceNow, testLimiter } = deps;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const signedIn = authenticated(req, sessionSecret);

  if (req.method === 'POST' && path === '/login') {
    // req.socket.remoteAddress, never a client-supplied header (e.g.
    // X-Forwarded-For), which an attacker could set to anything. But this
    // container sits behind Caddy, so remoteAddress is Caddy's own address,
    // not the visitor's — every request lands in the SAME bucket. That is
    // deliberate, not an oversight: an attacker cannot influence the value
    // at all (no bypass), and the panel has exactly one legitimate user, so
    // a single global lockout after 5 failures is an acceptable brute-force
    // defence. It also means the one legitimate user can lock *themselves*
    // out for the lockout window by mistyping the password 5 times.
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.allowed(ip)) {
      return html(res, 429, renderLogin('Too many attempts. Try again later.'));
    }

    const { body, tooLarge } = await readBody(req);
    // Not a password guess, so it does not spend an attempt against the
    // limiter -- but it is still an answer rather than a reset socket. The
    // login page, not JSON: this route is reached by a browser form post.
    if (tooLarge) return html(res, 413, renderLogin('That sign-in request was too large to read.'));

    const params = new URLSearchParams(body);
    if (!verifyPassword(params.get('password') ?? '', passwordHash)) {
      limiter.fail(ip);
      return html(res, 401, renderLogin('Incorrect password.'));
    }

    limiter.reset(ip);
    res.writeHead(303, {
      location: '/',
      'set-cookie': `session=${signSession(Date.now() + SESSION_MS, sessionSecret)}; ${COOKIE_FLAGS}`,
    });
    return res.end();
  }

  if (req.method === 'POST' && path === '/logout') {
    res.writeHead(303, { location: '/', 'set-cookie': `session=; Max-Age=0; ${COOKIE_FLAGS}` });
    return res.end();
  }

  // /login handled here too, not just POST above: a password manager stores
  // the submission URL and offers a saved entry by navigating straight to
  // it, so a GET there must land on the same login form as `/` rather than
  // the JSON 401 every other unauthenticated route gets.
  if (path === '/' || path === '/login') {
    return signedIn
      ? html(res, 200, renderDashboard(), { 'cache-control': 'no-store' })
      : html(res, 200, renderLogin());
  }

  if (!signedIn) return json(res, 401, { error: 'Not signed in.' });

  if (req.method === 'GET' && path === '/api/state') {
    return json(res, 200, {
      mode: modeStore.current(),
      source: modeStore.source(),
      locked: modeStore.locked(),
      entries: logBuffer.entries(),
    }, { 'cache-control': 'no-store' });
  }

  if (req.method === 'POST' && path === '/api/mode') {
    if (modeStore.locked()) {
      return json(res, 409, {
        error: 'Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.',
      });
    }

    const { body, tooLarge } = await readBody(req);
    // BODY_LIMIT stays tight here on purpose: this body is one key and one
    // short string. Over it is not a real client -- but it still gets told so.
    if (tooLarge) return json(res, 413, { error: 'That request was too large.' });

    let requested;
    try {
      requested = JSON.parse(body).mode;
    } catch {
      return json(res, 400, { error: 'Malformed request.' });
    }

    try {
      modeStore.set(requested);
    } catch (error) {
      // MODE_REJECTED marks the store's own deliberate refusals — an invalid
      // mode name, a locked store, a malformed config root — which are
      // client errors. Anything else (a SyntaxError from a hand-corrupted
      // config.json, an fs error because the file is missing or unreadable)
      // is a server fault: reporting it as a 400 would tell the operator
      // their *request* was wrong on the one page they're using to fix the
      // actual problem, which is on disk.
      return json(res, error.code === 'MODE_REJECTED' ? 400 : 500, { error: error.message });
    }
    return json(res, 200, { mode: modeStore.current() });
  }

  if (req.method === 'GET' && path === '/api/announce') {
    let channels;
    try {
      // A function, not a list: the panel starts before the bot logs in, and
      // before then there are no channels to offer. It may also throw
      // outright at that point (correction 4) rather than just returning an
      // empty list, and a throw here must not take down the whole GET -- the
      // quip editor is exactly what the operator needs while diagnosing why
      // the bot isn't up.
      channels = listChannels();
    } catch {
      channels = [];
    }
    return json(res, 200, { ...announceStore.current(), channels }, { 'cache-control': 'no-store' });
  }

  if (req.method === 'POST' && path === '/api/announce') {
    const { body, tooLarge } = await readBody(req, ANNOUNCE_BODY_LIMIT);
    // A 413 with the same { error } shape as every other refusal, because the
    // panel prints it verbatim. Name the caps: an operator who hits this has
    // no other way to discover a size limit exists.
    if (tooLarge) {
      return json(res, 413, {
        error: `That quip list is too large to save. Keep it to at most ${MAX_QUIPS} quips of ${MAX_QUIP_LENGTH} characters each, then save again.`,
      });
    }

    let requested;
    try {
      requested = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'Malformed request.' });
    }
    // Correction 1: valid JSON that isn't a plain object (null, an array)
    // must not fall through to a TypeError on requested.channelId, which
    // would otherwise surface as a 500 for what is really a client mistake.
    if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) {
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
    // No fallback here: createAdminServer always supplies a persistent
    // testLimiter, and a caller that omits it (test or otherwise) must fail
    // loudly rather than silently get a fresh, always-empty limiter that
    // never blocks anything -- a limiter is a Map in a closure, so "fresh
    // every call" is indistinguishable from "no rate limit at all".
    const limiterForTest = testLimiter;
    if (!limiterForTest.allowed(TEST_ANNOUNCE_KEY)) {
      return json(res, 429, { error: 'Wait a moment before testing again.' });
    }
    // fail() is named for the login path it was written for; here it simply
    // records that the one call this window allows has been spent -- before
    // announceNow() is even called, so a throwing wrapper does not become a
    // free retry loop (correction 3).
    limiterForTest.fail(TEST_ANNOUNCE_KEY);
    try {
      return json(res, 200, { result: await announceNow() });
    } catch (error) {
      logger.error(`announce test post failed: ${error.message}`);
      return json(res, 500, { error: 'Could not post.' });
    }
  }

  return json(res, 404, { error: 'Not found.' });
}

// Returns null when there is no usable password or session secret. Fail
// closed: a misconfigured deploy gets no panel rather than an unprotected
// one (an empty or missing SESSION_SECRET, in particular, would let anyone
// compute the HMAC key and forge a session cookie -- see the same-length
// check below).
export function createAdminServer(deps) {
  const { passwordHash, sessionSecret, logger = console } = deps;
  if (typeof passwordHash !== 'string' || !/^[0-9a-f]+:[0-9a-f]+$/.test(passwordHash)) {
    logger.warn('ADMIN_PASSWORD_HASH is missing or malformed; the admin panel will not start.');
    return null;
  }
  if (typeof sessionSecret !== 'string' || sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    logger.warn(`SESSION_SECRET is missing or shorter than ${MIN_SESSION_SECRET_LENGTH} characters; the admin panel will not start.`);
    return null;
  }

  // deps.limiter ?? createRateLimiter(), not `{ limiter: createRateLimiter(), ...deps }`:
  // the latter lets an explicit `limiter: undefined` in deps silently win over the
  // default (object spread always applies every own key from the source, including
  // ones whose value is undefined), crashing the first /login POST.
  const withLimiter = {
    ...deps,
    limiter: deps.limiter ?? createRateLimiter(),
    testLimiter: deps.testLimiter ?? createRateLimiter({ max: 1, windowMs: TEST_ANNOUNCE_COOLDOWN_MS }),
  };
  const server = createServer((req, res) => {
    handleRequest(req, res, withLimiter).catch((error) => {
      // Deliberately the base console, not the buffer-attached `logger`:
      // this runs for every request that errors, including anonymous ones
      // with no session, and writing it into the ring buffer would let an
      // unauthenticated visitor evict the real delivery history for free by
      // generating aborted requests (I1).
      console.error(`admin request failed: ${error.message}`);
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Internal error."}');
      }
    });
  });

  // Defence in depth: a request that fails at the HTTP parser level (before
  // handleRequest even runs -- a malformed request line, invalid headers)
  // fires here instead. Destroying the socket ourselves, rather than relying
  // on Node's default response-then-close behavior, avoids writing to a
  // socket the client may have already reset.
  server.on('clientError', (error, socket) => socket.destroy());

  return server;
}
