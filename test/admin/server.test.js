import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleRequest, createAdminServer } from '../../src/admin/server.js';
import { hashPassword, signSession, createRateLimiter } from '../../src/admin/auth.js';
import { createLogBuffer } from '../../src/logbuffer.js';
import { createModeStore } from '../../src/admin/mode-store.js';

// >= 32 chars: createAdminServer refuses anything shorter (C1). A real
// secret would be random; this one is fixed so tests can sign matching
// cookies with signSession directly.
const SECRET = 'test-secret-that-is-long-enough-to-pass-the-32-char-floor';
const PASSWORD = 'let me in';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(code, headers = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
      return this;
    },
    end(body = '') { this.body = body; this.ended = true; return this; },
  };
}

// A real Readable, not a hand-rolled async iterator: readBody consumes the
// request with stream events (it must not break out of a for-await, which
// would destroy the socket and lose the response), and a fake that only
// implements Symbol.asyncIterator would test a code path production never
// takes.
function fakeReq({ method = 'GET', url = '/', cookie, body = '' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = cookie ? { cookie } : {};
  req.socket = { remoteAddress: '1.2.3.4' };
  return req;
}

let deps;
let modeStore;

beforeEach(() => {
  let mode = 'repost';
  modeStore = {
    current: () => mode,
    source: () => 'config.json',
    locked: () => false,
    set: vi.fn((next) => { mode = next; }),
  };
  deps = {
    modeStore,
    logBuffer: createLogBuffer(),
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: SECRET,
    limiter: createRateLimiter({ max: 5, windowMs: 900000 }),
  };
});

const validCookie = () => `session=${signSession(Date.now() + 60000, SECRET)}`;

describe('unauthenticated requests', () => {
  it('serves the login page at the root', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq(), res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form');
  });

  // I3: a password manager stores the URL a login form was submitted to
  // (/login), not the page it happened to be linked from (/), and opens a
  // saved entry by navigating straight there. Before this fix that GET hit
  // the generic "not signed in" JSON 401 with no form to fill in.
  it('serves the login page at /login too, not a JSON 401', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/login' }), res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form');
  });

  it('refuses the state API', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state' }), res, deps);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a mode change', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', body: '{"mode":"suppress"}' }), res, deps);
    expect(res.statusCode).toBe(401);
    expect(modeStore.set).not.toHaveBeenCalled();
  });

  it('refuses a request whose cookie was signed with another secret', async () => {
    const cookie = `session=${signSession(Date.now() + 60000, 'wrong-secret')}`;
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state', cookie }), res, deps);
    expect(res.statusCode).toBe(401);
  });
});

describe('login', () => {
  it('sets a hardened session cookie on the right password', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: `password=${encodeURIComponent(PASSWORD)}` }), res, deps);
    expect(res.statusCode).toBe(303);
    const cookie = res.headers['set-cookie'];
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });

  it('sets no cookie on the wrong password', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=nope' }), res, deps);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never echoes the submitted password back', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=hunter2' }), res, deps);
    expect(res.body).not.toContain('hunter2');
  });

  it('locks out after repeated failures, even with the right password', async () => {
    for (let i = 0; i < 5; i++) {
      await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=nope' }), fakeRes(), deps);
    }
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/login', body: `password=${encodeURIComponent(PASSWORD)}` }), res, deps);
    expect(res.statusCode).toBe(429);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('authenticated requests', () => {
  it('reports mode, source and entries', async () => {
    deps.logBuffer.record('error', 'webhook send failed in #art');
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state', cookie: validCookie() }), res, deps);

    expect(res.statusCode).toBe(200);
    const state = JSON.parse(res.body);
    expect(state.mode).toBe('repost');
    expect(state.source).toBe('config.json');
    expect(state.locked).toBe(false);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].text).toBe('webhook send failed in #art');
  });

  it('changes the mode and reflects it in the next state read', async () => {
    const post = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' }), post, deps);
    expect(post.statusCode).toBe(200);
    expect(modeStore.set).toHaveBeenCalledWith('suppress');

    const get = fakeRes();
    await handleRequest(fakeReq({ url: '/api/state', cookie: validCookie() }), get, deps);
    expect(JSON.parse(get.body).mode).toBe('suppress');
  });

  it('rejects an invalid mode with 400', async () => {
    modeStore.set = vi.fn(() => {
      const error = new Error('Invalid mode "edit"; expected one of repost, suppress.');
      error.code = 'MODE_REJECTED';
      throw error;
    });
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"edit"}' }), res, deps);
    expect(res.statusCode).toBe(400);
  });

  it('reports a 500, not a 400, when set() fails for a reason other than validation', async () => {
    modeStore.set = vi.fn(() => { throw new Error('ENOENT: no such file or directory'); });
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' }), res, deps);
    expect(res.statusCode).toBe(500);
  });

  // I2: the *real* mode-store.js (not the vi.fn() stub the rest of this
  // file uses) built its "invalid mode" message with a template literal,
  // which coerces `next` via ToPrimitive. For an object whose own toString
  // isn't callable (both cases below), that coercion itself throws --
  // *before* the error even gets its MODE_REJECTED tag -- so the bug lived
  // entirely inside mode-store.js and only shows up end-to-end through the
  // real store, which is why this test builds one instead of using the
  // stub.
  it.each([
    { toString: 1 },
    { valueOf: null, toString: null },
  ])('rejects a hostile mode value with 400, not 500 (case %#)', async (hostileMode) => {
    const dir = mkdtempSync(join(tmpdir(), 'server-modestore-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ mode: 'repost' }));
    try {
      const realModeStoreDeps = {
        ...deps,
        modeStore: createModeStore({ mode: 'repost', modeSource: 'config.json', file }),
      };
      const res = fakeRes();
      await handleRequest(
        fakeReq({
          method: 'POST',
          url: '/api/mode',
          cookie: validCookie(),
          body: JSON.stringify({ mode: hostileMode }),
        }),
        res,
        realModeStoreDeps,
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('repost'); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses with 409 and an explanation when the env var owns the mode', async () => {
    modeStore.locked = () => true;
    modeStore.source = () => 'LINKFIX_MODE';
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' }), res, deps);

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('LINKFIX_MODE');
    expect(modeStore.set).not.toHaveBeenCalled();
  });

  it('serves the dashboard at the root', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ cookie: validCookie() }), res, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<html');
  });

  it('clears the cookie on logout', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/logout', cookie: validCookie() }), res, deps);
    expect(res.headers['set-cookie']).toMatch(/session=;/);
  });

  it('404s an unknown path', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/secrets', cookie: validCookie() }), res, deps);
    expect(res.statusCode).toBe(404);
  });
});

describe('createAdminServer', () => {
  it('returns null without a password hash, so the panel cannot start unprotected', () => {
    expect(createAdminServer({ ...deps, passwordHash: undefined })).toBeNull();
  });

  it.each(['', 'not-a-hash'])('returns null for the malformed hash %s', (bad) => {
    expect(createAdminServer({ ...deps, passwordHash: bad })).toBeNull();
  });

  it('returns a server when the hash is well formed', () => {
    const server = createAdminServer(deps);
    expect(server).not.toBeNull();
    expect(typeof server.listen).toBe('function');
    server.close();
  });

  // C1: an empty SESSION_SECRET is a publicly-known HMAC key -- anyone can
  // sign their own cookie against it -- and docker compose's env_file
  // turns the .env.example line `SESSION_SECRET=` into exactly that empty
  // string, not "unset". src/index.js now falls back on empty (`||`, not
  // `??`), but createAdminServer must refuse it too as an independent,
  // fail-closed layer: any future caller that constructs deps directly
  // (as tests already do) gets the same protection without relying on
  // index.js's fallback ever running.
  it.each([
    [undefined, 'missing'],
    ['', 'empty'],
    [1234567890123456789012345678901234, 'non-string'],
    ['too-short', 'shorter than 32 characters'],
  ])('returns null when sessionSecret is %s (%s)', (bad) => {
    expect(createAdminServer({ ...deps, sessionSecret: bad })).toBeNull();
  });

  // Fix round 1, Minor: `{ limiter: createRateLimiter(), ...deps }` lets an
  // explicit `limiter: undefined` in deps win over the default, because
  // object spread copies every own key from the source -- including ones
  // whose value is undefined -- clobbering the earlier property. A future
  // caller passing `limiter: undefined` (rather than omitting the key) would
  // 500 on the very first /login POST. Exercised over a real server and a
  // real HTTP request, not the fake harness, since the bug lives in
  // createAdminServer's own merge, not in handleRequest.
  it('falls back to a default limiter when deps explicitly sets limiter to undefined', async () => {
    const server = createAdminServer({ ...deps, limiter: undefined });
    expect(server).not.toBeNull();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const status = await new Promise((resolve, reject) => {
        const body = `password=${encodeURIComponent(PASSWORD)}`;
        const req = http.request(
          { host: '127.0.0.1', port, method: 'POST', path: '/login', headers: { 'content-length': Buffer.byteLength(body) } },
          (res) => { res.resume(); resolve(res.statusCode); },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(status).toBe(303); // not 500 -- the fallback limiter was constructed and used
    } finally {
      server.close();
    }
  });

  // Fix round 2: round 1 added `req.destroy()` after responding on every
  // early-return path, on the theory that an unconsumed request body left a
  // process-crashing hole (it didn't -- that Critical was retracted; see the
  // round-2 fix report). That `req.destroy()` was a real regression in its
  // own right: it tears down the shared socket immediately after `res.end()`
  // queues the response, while a client with a genuinely large body (a
  // health check, a scanner, anything sending more than a trivial payload)
  // may still be mid-write. Destroying the socket at that moment can RST the
  // connection before the OS has flushed the already-queued response, so the
  // client never observes the status code at all -- an opaque connection
  // failure instead of a diagnosable 401/409/429. This test pins the
  // opposite property directly: a client uploading a multi-megabyte body to
  // the unauthenticated /api/mode gate (401, no readBody() call) must still
  // see its status code, over a real http.Server and a real request body
  // large enough that fetch/undici is still writing it when the response
  // comes back. (A smaller, artificially-paced body was tried first and
  // didn't discriminate -- undici had already finished writing each chunk
  // and gone idle between chunks by the time either the fix or the bug would
  // have mattered, in either direction. A single large, unpaced body is what
  // actually keeps the client mid-write when the server responds.)
  it('delivers an early-return status code to a client still mid-upload of a large body', async () => {
    const server = createAdminServer(deps);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const body = new Uint8Array(5 * 1024 * 1024).fill(0x78); // 5MB
      const response = await fetch(`http://127.0.0.1:${port}/api/mode`, { method: 'POST', body });

      // The status must actually reach the client -- not merely "the server
      // called res.end()", which a torn-down socket can still do while the
      // client observes nothing but a connection failure (fetch throwing
      // with an EPIPE cause, in the case this test would have caught).
      expect(response.status).toBe(401);
    } finally {
      server.close();
    }
  });

  // C1, proven cross-process (this session's forged cookie is signed with
  // signSession/'' straight from auth.js, entirely independent of the real
  // server built below, which only ever sees the finished cookie string --
  // the same shape an attacker in a separate process would send): a
  // properly-configured server (a real 32+ char secret) must reject a
  // session cookie signed with the empty string, the key an operator ends
  // up with if SESSION_SECRET is set but empty. Before this fix, an empty
  // secret wasn't merely accepted by verifySession (it always was, and
  // still is, if the *server's own* secret happens to be '') -- the actual
  // bug was that createAdminServer never checked its secret was non-empty
  // in the first place, so a server misconfigured that way would start up
  // fine and accept exactly this cookie. This test pins the server-level
  // guarantee: given a *correct* secret, a cookie forged against a
  // *different, empty* one never authenticates.
  it('rejects a cookie forged with the empty string, given a server built with a proper secret', async () => {
    const server = createAdminServer(deps); // deps.sessionSecret === SECRET, a real 32+ char value
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const forgedCookie = `session=${signSession(Date.now() + 60000, '')}`;
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { cookie: forgedCookie },
      });
      expect(response.status).toBe(401);
    } finally {
      server.close();
    }
  });

  // Fix round 1: handleRequest used to fall back to a brand-new
  // createRateLimiter() whenever deps.testLimiter was missing. Because a
  // limiter's failure list lives in a per-instance closure, "fresh every
  // call" is indistinguishable from "no rate limit at all" -- and no test
  // drove the announce routes through createAdminServer itself, so deleting
  // its one line of production wiring for this control (`testLimiter:
  // deps.testLimiter ?? createRateLimiter(...)`) left the whole suite green.
  // This test builds deps with no testLimiter at all, so it can only pass if
  // createAdminServer's own default actually constructs a limiter and
  // reuses that same instance across requests, the way it does in
  // production.
  it('enforces the test-announce cooldown for real, through createAdminServer', async () => {
    const server = createAdminServer({
      ...deps,
      announceStore: { current: () => ({ channelId: '123', quips: ['back'] }), set: vi.fn() },
      listChannels: () => [{ id: '123', name: 'bots' }],
      announceNow: vi.fn(async () => 'sent'),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const cookie = `session=${signSession(Date.now() + 60000, SECRET)}`;

    try {
      const first = await fetch(`http://127.0.0.1:${port}/api/announce/test`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(first.status).toBe(200);

      const second = await fetch(`http://127.0.0.1:${port}/api/announce/test`, {
        method: 'POST',
        headers: { cookie },
      });
      expect(second.status).toBe(429);
    } finally {
      server.close();
    }
  });
});

describe('I1: request-path errors do not reach the log buffer', () => {
  // The catch in createAdminServer's request handler runs for every
  // request that errors, including anonymous ones with no session --
  // before this fix it logged through the buffer-attached `logger`, so
  // any visitor who could make a request fail (no credentials needed) got
  // a free, repeatable way to evict real delivery history from the
  // 200-slot ring buffer. This drives a real failure through a real
  // server (a modeStore.current() that throws, hit via an authenticated
  // GET /api/state) rather than the fakeReq/fakeRes harness, because the
  // bug lives in createAdminServer's own wrapping catch, which the fake
  // harness bypasses entirely.
  it('does not grow the buffer, and logs via console instead', async () => {
    const throwingModeStore = {
      current: () => { throw new Error('boom'); },
      source: () => 'config.json',
      locked: () => false,
      set: vi.fn(),
    };
    const localDeps = {
      modeStore: throwingModeStore,
      logBuffer: createLogBuffer(),
      passwordHash: hashPassword(PASSWORD),
      sessionSecret: SECRET,
      limiter: createRateLimiter({ max: 5, windowMs: 900000 }),
    };
    const server = createAdminServer(localDeps);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const before = localDeps.logBuffer.entries().length;
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { cookie: `session=${signSession(Date.now() + 60000, SECRET)}` },
      });
      expect(response.status).toBe(500);
      expect(localDeps.logBuffer.entries().length).toBe(before); // unchanged
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    } finally {
      consoleSpy.mockRestore();
      server.close();
    }
  });
});

describe('announce routes', () => {
  function announceDeps(overrides = {}) {
    let settings = { channelId: '123', quips: ['back'] };
    return {
      ...deps,
      announceStore: {
        current: () => settings,
        set: vi.fn((next) => { settings = next; }),
      },
      listChannels: vi.fn(() => [{ id: '123', name: 'bots' }]),
      announceNow: vi.fn(async () => 'sent'),
      // A real limiter, not a fallback in production code: handleRequest
      // requires testLimiter (no default -- see server.js), so any deps
      // helper that calls it directly must supply one itself, same as
      // createAdminServer does for real traffic.
      testLimiter: createRateLimiter({ max: 1, windowMs: 30000 }),
      ...overrides,
    };
  }

  it('refuses an unauthenticated read', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/announce' }), res, announceDeps());
    expect(res.statusCode).toBe(401);
  });

  it('refuses an unauthenticated test', async () => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test' }), res, d);
    expect(res.statusCode).toBe(401);
    expect(d.announceNow).not.toHaveBeenCalled();
  });

  it('reports the settings and the channels it can post in', async () => {
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/announce', cookie: validCookie() }), res, announceDeps());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      channelId: '123',
      quips: ['back'],
      channels: [{ id: '123', name: 'bots' }],
    });
  });

  it('saves a change', async () => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: '{"channelId":"999","quips":["hi"]}' }),
      res, d,
    );

    expect(res.statusCode).toBe(200);
    expect(d.announceStore.set).toHaveBeenCalledWith({ channelId: '999', quips: ['hi'] });
  });

  it('rejects a refused change as a client error', async () => {
    const d = announceDeps();
    d.announceStore.set = vi.fn(() => {
      throw Object.assign(new Error('Channel must be a channel id of digits, or empty for no announcements.'), { code: 'ANNOUNCE_REJECTED' });
    });
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: '{"channelId":"nope","quips":[]}' }),
      res, d,
    );
    expect(res.statusCode).toBe(400);
  });

  // An untagged error is an I/O fault, not the operator's mistake, and saying
  // otherwise sends them looking in the wrong place.
  it('reports an untagged failure as a server error', async () => {
    const d = announceDeps();
    d.announceStore.set = vi.fn(() => { throw new Error('ENOENT'); });
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: '{"channelId":"","quips":[]}' }),
      res, d,
    );
    expect(res.statusCode).toBe(500);
  });

  it('rejects a malformed body', async () => {
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body: 'not json' }),
      res, announceDeps(),
    );
    expect(res.statusCode).toBe(400);
  });

  // Correction 1: a body that parses as valid JSON but isn't a plain object
  // (null, an array) must not fall through to a TypeError on
  // requested.channelId, which would surface as a 500 for what is really a
  // client mistake.
  it.each([
    ['null', 'null'],
    ['an array', '[]'],
  ])('rejects a malformed body that is %s', async (_label, body) => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(
      fakeReq({ method: 'POST', url: '/api/announce', cookie: validCookie(), body }),
      res, d,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Malformed request.' });
    expect(d.announceStore.set).not.toHaveBeenCalled();
  });

  it('posts a quip on demand and returns the outcome', async () => {
    const d = announceDeps();
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: 'sent' });
    expect(d.announceNow).toHaveBeenCalled();
  });

  // Without the button a leaked password buys arbitrary bot text on the next
  // restart; with it, that text can be fired into any visible channel on
  // demand. The cooldown is what bounds that, and it has to be server side.
  it('refuses a second test within the cooldown', async () => {
    const d = { ...announceDeps(), testLimiter: createRateLimiter({ max: 1, windowMs: 30000 }) };
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), fakeRes(), d);

    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(429);
    expect(d.announceNow).toHaveBeenCalledTimes(1);
  });

  it('allows another test once the cooldown has passed', async () => {
    let now = 1000;
    const d = {
      ...announceDeps(),
      testLimiter: createRateLimiter({ max: 1, windowMs: 30000, clock: () => now }),
    };
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), fakeRes(), d);

    now = 1000 + 30001;
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(200);
    expect(d.announceNow).toHaveBeenCalledTimes(2);
  });

  // Correction 3: announceNow() is a later task's wrapper and is not covered
  // by announce()'s "never throws" contract. A throw there must become a
  // 500, not an unhandled rejection that takes down the request.
  it('reports a server error when announceNow throws, without granting a free retry', async () => {
    const d = announceDeps({
      announceNow: vi.fn(async () => { throw new Error('discord unreachable'); }),
      testLimiter: createRateLimiter({ max: 1, windowMs: 30000 }),
    });
    const res = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res, d);
    expect(res.statusCode).toBe(500);

    // The cooldown was already spent before announceNow was called, so a
    // second attempt inside the window is still refused -- a throwing
    // wrapper must not become a free retry loop.
    const res2 = fakeRes();
    await handleRequest(fakeReq({ method: 'POST', url: '/api/announce/test', cookie: validCookie() }), res2, d);
    expect(res2.statusCode).toBe(429);
  });

  // Correction 4: the panel starts before the bot logs in, so listChannels()
  // may throw rather than merely returning []. That must not take down the
  // whole GET -- the quip editor is exactly what the operator needs while
  // diagnosing why the bot isn't up.
  it('falls back to no channels when listChannels throws', async () => {
    const d = announceDeps({ listChannels: vi.fn(() => { throw new Error('client not ready'); }) });
    const res = fakeRes();
    await handleRequest(fakeReq({ url: '/api/announce', cookie: validCookie() }), res, d);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ channelId: '123', quips: ['back'], channels: [] });
  });
});

// The body limit was sized for a login form and a two-key JSON object, then
// inherited by POST /api/announce, whose documented payload is 50 quips of
// 2000 characters. Every legal save above ~4KB died as a socket reset with no
// HTTP response at all, which the panel could only report as "Could not reach
// the server." These go over real HTTP because that is the only place the
// bug was visible: the handler "returned fine" in every unit test.
describe('request body limits', () => {
  const MAX_QUIPS = 50;
  const MAX_QUIP_LENGTH = 2000;

  function announceServer(overrides = {}) {
    return createAdminServer({
      ...deps,
      announceStore: {
        current: () => ({ channelId: '123', quips: [] }),
        set: vi.fn(),
      },
      listChannels: () => [],
      announceNow: vi.fn(async () => 'sent'),
      ...overrides,
    });
  }

  async function withServer(server, run) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      return await run(server.address().port);
    } finally {
      server.close();
    }
  }

  it('accepts a quip list at the documented maximum size', async () => {
    const set = vi.fn();
    const quips = Array.from({ length: MAX_QUIPS }, () => 'q'.repeat(MAX_QUIP_LENGTH));
    await withServer(announceServer({
      announceStore: { current: () => ({ channelId: '123', quips }), set },
    }), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/announce`, {
        method: 'POST',
        headers: { cookie: `session=${signSession(Date.now() + 60000, SECRET)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: '123', quips }),
      });
      expect(response.status).toBe(200);
      expect(set).toHaveBeenCalledWith({ channelId: '123', quips });
    });
  });

  // 3 quips of 2000 characters -- well inside the documented cap, and one of
  // the sizes that reproduced the reset.
  it('accepts a modest quip list that the old 4KB limit already killed', async () => {
    const quips = ['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)];
    await withServer(announceServer(), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/announce`, {
        method: 'POST',
        headers: { cookie: `session=${signSession(Date.now() + 60000, SECRET)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channelId: '123', quips }),
      });
      expect(response.status).toBe(200);
    });
  });

  // The point of the fix is not a bigger number, it is that the client gets
  // an answer. A body past the route's limit must come back as a real 413
  // with a JSON error the panel can print -- not a destroyed socket.
  it('answers an oversized quip list with a 413 the client can read', async () => {
    await withServer(announceServer(), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/announce`, {
        method: 'POST',
        headers: { cookie: `session=${signSession(Date.now() + 60000, SECRET)}`, 'content-type': 'application/json' },
        // Comfortably past any limit derived from 50 x 2000.
        body: JSON.stringify({ channelId: '123', quips: ['x'.repeat(2 * 1024 * 1024)] }),
      });
      expect(response.status).toBe(413);
      const body = await response.json();
      expect(typeof body.error).toBe('string');
      // Useful to an operator: it must name the actual caps.
      expect(body.error).toContain(String(MAX_QUIPS));
      expect(body.error).toContain(String(MAX_QUIP_LENGTH));
    });
  });

  // The other routes stay tight: /api/mode is a two-key object and has no
  // business accepting hundreds of kilobytes. It must still answer, though.
  it('keeps the small limit on /api/mode and answers 413 rather than resetting', async () => {
    await withServer(announceServer(), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/mode`, {
        method: 'POST',
        headers: { cookie: `session=${signSession(Date.now() + 60000, SECRET)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'repost', padding: 'p'.repeat(8192) }),
      });
      expect(response.status).toBe(413);
      expect(typeof (await response.json()).error).toBe('string');
    });
  });

  // /login is a form post, so its oversized answer is the login page rather
  // than JSON -- but it is still an answer.
  it('answers an oversized login post with the login page', async () => {
    await withServer(announceServer(), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/login`, {
        method: 'POST',
        body: `password=${'x'.repeat(8192)}`,
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toContain('type="password"');
    });
  });
});
