import { createServer } from 'node:http';
import { verifyPassword, signSession, verifySession, createRateLimiter } from './auth.js';
import { renderLogin, renderDashboard } from './page.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE_FLAGS = 'HttpOnly; Secure; SameSite=Strict; Path=/';
const BODY_LIMIT = 4096;

// Reads at most BODY_LIMIT bytes from the request body, then stops pulling
// further data from the socket. A login form and a two-key JSON object are
// tiny; anything larger is not a real client and is not worth buffering.
//
// Buffers are concatenated and decoded once at the end (rather than the more
// obvious `body += chunk`, which coerces each Buffer to a string as it
// arrives via implicit toString('utf8') and can split a multi-byte UTF-8
// character across a chunk boundary, corrupting it). Bytes over the limit
// are never appended to `chunks`, so the accumulated buffer itself cannot
// exceed BODY_LIMIT; `req.destroy()` stops the socket from being read
// further once that happens.
async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      req.destroy();
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function html(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

export async function handleRequest(req, res, deps) {
  const { modeStore, logBuffer, passwordHash, sessionSecret, limiter } = deps;
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
      html(res, 429, renderLogin('Too many attempts. Try again later.'));
      // We're responding without ever reading the body. If the client
      // declared a Content-Length bigger than what it actually sends and
      // then resets the connection, the socket has no consumer and no error
      // listener anywhere in this module -- an unhandled 'error' on a raw
      // net.Socket is a synchronous throw, not a promise rejection, so it
      // takes down the whole process (the Discord client included) rather
      // than landing in this handler's own catch. Destroying the request
      // stream (after the response is already queued) removes it as a
      // listener-less source of that error. See the identical comment on
      // every other early-return branch below for the general rule: any
      // response path that does not call readBody() must destroy req.
      req.destroy();
      return;
    }

    const params = new URLSearchParams(await readBody(req));
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
    res.end();
    req.destroy(); // never reads the body -- see the /login 429 branch above
    return;
  }

  if (path === '/') {
    html(res, 200, signedIn ? renderDashboard() : renderLogin());
    req.destroy(); // matches every method (GET and POST both land here); never reads the body
    return;
  }

  if (!signedIn) {
    json(res, 401, { error: 'Not signed in.' });
    req.destroy(); // never reads the body
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    json(res, 200, {
      mode: modeStore.current(),
      source: modeStore.source(),
      locked: modeStore.locked(),
      entries: logBuffer.entries(),
    });
    req.destroy(); // GET is not expected to carry a body, but nothing reads it if it does
    return;
  }

  if (req.method === 'POST' && path === '/api/mode') {
    if (modeStore.locked()) {
      json(res, 409, {
        error: 'Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.',
      });
      req.destroy(); // returns before ever calling readBody()
      return;
    }

    let requested;
    try {
      requested = JSON.parse(await readBody(req)).mode;
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

  json(res, 404, { error: 'Not found.' });
  req.destroy(); // catch-all; never reads the body
}

// Returns null when there is no usable password. Fail closed: a
// misconfigured deploy gets no panel rather than an unprotected one.
export function createAdminServer(deps) {
  const { passwordHash, logger = console } = deps;
  if (typeof passwordHash !== 'string' || !/^[0-9a-f]+:[0-9a-f]+$/.test(passwordHash)) {
    logger.warn('ADMIN_PASSWORD_HASH is missing or malformed; the admin panel will not start.');
    return null;
  }

  // deps.limiter ?? createRateLimiter(), not `{ limiter: createRateLimiter(), ...deps }`:
  // the latter lets an explicit `limiter: undefined` in deps silently win over the
  // default (object spread always applies every own key from the source, including
  // ones whose value is undefined), crashing the first /login POST.
  const withLimiter = { ...deps, limiter: deps.limiter ?? createRateLimiter() };
  const server = createServer((req, res) => {
    handleRequest(req, res, withLimiter).catch((error) => {
      logger.error(`admin request failed: ${error.message}`);
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"Internal error."}');
      }
      req.destroy();
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
