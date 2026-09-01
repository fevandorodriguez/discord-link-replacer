import { describe, it, expect, beforeEach, vi } from 'vitest';
import net from 'node:net';
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
    // Real http.IncomingMessage has this; every response path that returns
    // without consuming the body must call it (fix round 1, Critical).
    destroy: vi.fn(),
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

// Fix round 1, Critical: any response path that returns without reading the
// request body left the request stream unconsumed and listener-less. If a
// real client declares a Content-Length bigger than what it actually sends
// and then resets the connection, that surfaces as an unhandled 'error' on
// the raw socket -- a synchronous throw, not a promise rejection -- which
// crashes the whole process (the Discord client included), not just the one
// request. Every early-return branch must call req.destroy() to remove
// itself as a source of that error. The fake req here cannot reproduce the
// crash itself (see 'survives a client that lies about Content-Length and
// resets the connection' below for that, over a real socket) but it can and
// must prove the mechanism the fix relies on: destroy() is actually called
// on every path that skips readBody(), and NOT called on paths that read it.
describe('request stream hygiene', () => {
  it('destroys the request when serving the login page unauthenticated', async () => {
    const req = fakeReq();
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request when serving the dashboard authenticated', async () => {
    const req = fakeReq({ cookie: validCookie() });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request on the unauthenticated 401 gate', async () => {
    const req = fakeReq({ url: '/api/state' });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request on a signed-in GET /api/state', async () => {
    const req = fakeReq({ url: '/api/state', cookie: validCookie() });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request on a locked-mode 409', async () => {
    modeStore.locked = () => true;
    modeStore.source = () => 'LINKFIX_MODE';
    const req = fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request on logout', async () => {
    const req = fakeReq({ method: 'POST', url: '/logout', cookie: validCookie() });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request on an unknown path', async () => {
    const req = fakeReq({ url: '/secrets', cookie: validCookie() });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('destroys the request when the login rate limiter has already tripped', async () => {
    for (let i = 0; i < 5; i++) {
      await handleRequest(fakeReq({ method: 'POST', url: '/login', body: 'password=nope' }), fakeRes(), deps);
    }
    const req = fakeReq({ method: 'POST', url: '/login', body: `password=${encodeURIComponent(PASSWORD)}` });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('does not destroy the request on paths that read the body themselves', async () => {
    const req = fakeReq({ method: 'POST', url: '/api/mode', cookie: validCookie(), body: '{"mode":"suppress"}' });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it('does not destroy the request on a successful login (the body was already read)', async () => {
    const req = fakeReq({ method: 'POST', url: '/login', body: `password=${encodeURIComponent(PASSWORD)}` });
    await handleRequest(req, fakeRes(), deps);
    expect(req.destroy).not.toHaveBeenCalled();
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

  // Fix round 1, Critical (the most serious finding on this branch): a client
  // that declares more Content-Length than it actually sends, then resets
  // the connection, hits a socket with no consumer and no error listener on
  // any early-return path -- an unhandled socket 'error' is a synchronous
  // throw that takes down the whole process, Discord client included, not
  // just this one request. This is the one property the fake single-chunk
  // req/res harness used everywhere else in this file structurally cannot
  // exercise: it never touches a real socket, so it cannot reproduce this
  // failure mode. This test does, over a real net.Socket against a real
  // http.Server from createAdminServer.
  //
  // A process-level crash can't be asserted as a normal thrown exception --
  // by definition, nothing in this file's call stack is on the stack when it
  // happens. Instead: install our own uncaughtException listener for the
  // duration of the attack (this itself suppresses Node's fatal default
  // behavior, which is what would otherwise take down the whole vitest
  // worker), capture whether it fires, then assert it didn't -- and confirm
  // the server is still alive and answering by sending it a normal request
  // afterward.
  it('survives a client that lies about Content-Length and resets the connection', async () => {
    const server = createAdminServer(deps);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    let capturedError = null;
    const onUncaught = (err) => { capturedError = err; };
    process.on('uncaughtException', onUncaught);

    try {
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.setNoDelay(true);
          // Every one of the routes named in the fix ('/', the unauthenticated
          // gate, the locked-mode 409) is reachable with zero setup -- this
          // targets '/', the simplest of the three.
          socket.write(
            'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5000000\r\nConnection: keep-alive\r\n\r\n',
          );
          socket.write('x'.repeat(1000)); // far short of the declared 5,000,000 bytes
          setTimeout(() => {
            if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
            else socket.destroy();
            resolve();
          }, 20);
        });
        socket.on('error', () => {}); // the client side resetting its own socket is expected
      });

      // Give the reset time to actually reach the server and be processed.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(capturedError).toBeNull();

      // The server must still be answering ordinary requests afterward.
      const status = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
    } finally {
      process.off('uncaughtException', onUncaught);
      server.close();
    }
  });
});
