import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { handleRequest, createAdminServer } from '../../src/admin/server.js';
import { hashPassword, signSession, createRateLimiter } from '../../src/admin/auth.js';
import { createLogBuffer } from '../../src/logbuffer.js';

const SECRET = 'test-secret';
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
});
