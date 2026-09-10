import { describe, it, expect, vi } from 'vitest';
import { checkMirror, checkMirrors } from '../src/mirror-check.js';

// A fetch stand-in. Real mirrors answered 200 while serving a takedown notice,
// which is exactly why the body matters and the status does not.
function fakeFetch(body, { status = 200 } = {}) {
  return vi.fn(async () => ({ status, ok: status < 400, text: async () => body }));
}

describe('checkMirror', () => {
  it('passes a mirror serving ordinary content', async () => {
    const r = await checkMirror('good.test', { fetchImpl: fakeFetch('<html><meta property="og:image"></html>') });
    expect(r).toEqual({ domain: 'good.test', ok: true, reason: 'ok' });
  });

  it.each([
    ['legal takedown', 'Due to a legal request, this service is no longer available.'],
    ['platform block', 'Reddit blocked the request. Reddit is actively preventing this service'],
    ['suspension', 'This account has been suspended'],
    ['parked domain', 'This domain is for sale'],
  ])('flags a 200 that is really %s', async (_label, body) => {
    const r = await checkMirror('bad.test', { fetchImpl: fakeFetch(body) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/takedown|blocked|suspended|parked/i);
  });

  it('flags a server error even with an innocuous body', async () => {
    const r = await checkMirror('bad.test', { fetchImpl: fakeFetch('oops', { status: 503 }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('503');
  });

  it('flags an empty response', async () => {
    const r = await checkMirror('bad.test', { fetchImpl: fakeFetch('') });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });

  it('flags a domain that cannot be reached at all', async () => {
    const r = await checkMirror('gone.test', {
      fetchImpl: vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND gone.test'); }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unreachable/i);
  });

  it('never throws, whatever fetch does', async () => {
    const r = await checkMirror('x.test', { fetchImpl: () => { throw new Error('boom'); } });
    expect(r.ok).toBe(false);
  });

  it('identifies itself as Discord so mirrors serve what Discord would see', async () => {
    const f = fakeFetch('<html></html>');
    await checkMirror('good.test', { fetchImpl: f });
    const headers = f.mock.calls[0][1].headers;
    expect(String(headers['user-agent'] ?? headers['User-Agent'])).toMatch(/Discordbot/);
  });
});

describe('checkMirrors', () => {
  const platforms = {
    twitter: { enabled: true, domain: 'good.test' },
    tiktok: { enabled: true, domain: 'bad.test' },
    reddit: { enabled: false, domain: 'disabled.test' },
  };

  it('checks every enabled platform and skips disabled ones', async () => {
    const fetchImpl = vi.fn(async (url) => ({
      status: 200, ok: true,
      text: async () => (String(url).includes('bad') ? 'Due to a legal request' : '<html></html>'),
    }));
    const results = await checkMirrors(platforms, { fetchImpl });

    expect(results.map((r) => r.platform)).toEqual(['twitter', 'tiktok']);
    expect(results.find((r) => r.platform === 'twitter').ok).toBe(true);
    expect(results.find((r) => r.platform === 'tiktok').ok).toBe(false);
  });

  it('returns results rather than throwing when one check fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const results = await checkMirrors(platforms, { fetchImpl });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });
});

describe('canary paths', () => {
  // Some mirrors serve a healthy root and fail only on a real post -- rxddit
  // answered its root normally while returning Reddit's block page for every
  // actual link. Checking the root alone cannot see that.
  it('fetches the root when no canary is configured', async () => {
    const f = vi.fn(async () => ({ status: 200, ok: true, text: async () => '<html></html>' }));
    await checkMirror('good.test', { fetchImpl: f });
    expect(f.mock.calls[0][0]).toBe('https://good.test/');
  });

  it('fetches the canary path when one is configured', async () => {
    const f = vi.fn(async () => ({ status: 200, ok: true, text: async () => '<html></html>' }));
    await checkMirror('good.test', { fetchImpl: f, path: '/r/london/comments/abc/title/' });
    expect(f.mock.calls[0][0]).toBe('https://good.test/r/london/comments/abc/title/');
  });

  it('catches a mirror whose root is fine but whose posts are blocked', async () => {
    const f = vi.fn(async (url) => ({
      status: 200,
      ok: true,
      text: async () => (String(url).endsWith('/') && !String(url).includes('comments')
        ? '<html>welcome</html>'
        : 'Reddit blocked the request. Reddit is actively preventing this service'),
    }));

    expect((await checkMirror('half.test', { fetchImpl: f })).ok).toBe(true);
    const deep = await checkMirror('half.test', { fetchImpl: f, path: '/r/x/comments/abc/t/' });
    expect(deep.ok).toBe(false);
    expect(deep.reason).toMatch(/blocked/i);
  });

  it('passes each platform its own canary', async () => {
    const seen = [];
    const f = vi.fn(async (url) => { seen.push(String(url)); return { status: 200, ok: true, text: async () => '<html></html>' }; });
    await checkMirrors({
      reddit: { enabled: true, domain: 'r.test', canary: '/r/x/comments/abc/t/' },
      twitter: { enabled: true, domain: 't.test' },
    }, { fetchImpl: f });

    expect(seen).toContain('https://r.test/r/x/comments/abc/t/');
    expect(seen).toContain('https://t.test/');
  });
});

describe('false positives', () => {
  // A healthy mirror shipped its own UI strings in the page, including
  // "rateLimited":"Too many requests." -- the checker flagged a working service
  // because it found the TEXT of an error rather than an actual error.
  const healthy = `<html><head><title>OGInstagram</title>
    <meta property="og:image" content="https://cdn.example/x.jpg">
    <script>window.i18n={"rateLimited":"Too many requests. Try again in a minute.",
    "videoUnavailable":"Video not available","serviceDown":"no longer available"}</script>
    </head><body>fine</body></html>`;

  it('does not flag a page that merely contains error strings but works', async () => {
    const r = await checkMirror('good.test', {
      fetchImpl: async () => ({ status: 200, ok: true, text: async () => healthy }),
    });
    expect(r).toEqual({ domain: 'good.test', ok: true, reason: 'ok' });
  });

  it('still flags a genuine takedown page, which has no og tags', async () => {
    const r = await checkMirror('bad.test', {
      fetchImpl: async () => ({
        status: 200, ok: true,
        text: async () => '<html><body>Due to a legal request, this service is no longer available.</body></html>',
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/takedown/i);
  });

  it('still flags a genuine block page', async () => {
    const r = await checkMirror('bad.test', {
      fetchImpl: async () => ({
        status: 200, ok: true,
        text: async () => '<html><body>Reddit blocked the request. Reddit is actively preventing this service from working.</body></html>',
      }),
    });
    expect(r.ok).toBe(false);
  });
});
