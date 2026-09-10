import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
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

function fakeReq({ method = 'GET', url = '/', cookie, body = '' } = {}) {
  const req = {
    method,
    url,
    headers: cookie ? { cookie } : {},
    socket: { remoteAddress: '1.2.3.4' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
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
