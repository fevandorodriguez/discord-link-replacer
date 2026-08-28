import { describe, it, expect } from 'vitest';
import { rewrite } from '../src/rewrite.js';
import { PLATFORMS, DEFAULT_DOMAINS } from '../src/rules.js';

// Every platform enabled, on its default domain.
const ALL_ON = Object.fromEntries(
  PLATFORMS.map((p) => [p, { enabled: true, domain: DEFAULT_DOMAINS[p] }]),
);

describe('rewrite — single link', () => {
  it('swaps an x.com status host for the twitter target', () => {
    expect(rewrite('https://x.com/jack/status/20', ALL_ON)).toEqual({
      changed: true,
      content: 'https://fxtwitter.com/jack/status/20',
    });
  });

  it('preserves surrounding text', () => {
    expect(rewrite('look at this https://x.com/jack/status/20 lol', ALL_ON).content)
      .toBe('look at this https://fxtwitter.com/jack/status/20 lol');
  });

  it('upgrades http to https', () => {
    expect(rewrite('http://x.com/jack/status/20', ALL_ON).content)
      .toBe('https://fxtwitter.com/jack/status/20');
  });

  it('reports no change when nothing matches', () => {
    expect(rewrite('https://example.com/hello', ALL_ON)).toEqual({
      changed: false,
      content: 'https://example.com/hello',
    });
  });

  it('reports no change for a message with no links at all', () => {
    expect(rewrite('good afternoon', ALL_ON)).toEqual({
      changed: false,
      content: 'good afternoon',
    });
  });

  it('leaves a link alone when its platform is disabled', () => {
    const off = { ...ALL_ON, twitter: { enabled: false, domain: 'fxtwitter.com' } };
    expect(rewrite('https://x.com/jack/status/20', off).changed).toBe(false);
  });

  it('leaves a link that is already on the target domain', () => {
    expect(rewrite('https://fxtwitter.com/jack/status/20', ALL_ON).changed).toBe(false);
  });

  it('does not throw on a malformed URL', () => {
    expect(rewrite('https://', ALL_ON).changed).toBe(false);
  });
});

describe('rewrite — every platform', () => {
  it.each([
    ['https://x.com/jack/status/20', 'https://fxtwitter.com/jack/status/20'],
    ['https://twitter.com/jack/status/20', 'https://fxtwitter.com/jack/status/20'],
    ['https://www.instagram.com/reel/Cabc123/', 'https://kkinstagram.com/reel/Cabc123/'],
    ['https://www.tiktok.com/@someone/video/7123456789', 'https://vxtiktok.com/@someone/video/7123456789'],
    ['https://vm.tiktok.com/ZMabc123/', 'https://vxtiktok.com/ZMabc123/'],
    ['https://www.reddit.com/r/videos/comments/abc123/title/', 'https://rxddit.com/r/videos/comments/abc123/title/'],
    ['https://bsky.app/profile/someone.bsky.social/post/3kabc', 'https://fxbsky.app/profile/someone.bsky.social/post/3kabc'],
  ])('rewrites %s', (input, expected) => {
    expect(rewrite(input, ALL_ON).content).toBe(expected);
  });

  it('rewrites several links in one message', () => {
    const input = 'https://x.com/a/status/1 and https://vm.tiktok.com/ZMabc123/ both';
    expect(rewrite(input, ALL_ON).content)
      .toBe('https://fxtwitter.com/a/status/1 and https://vxtiktok.com/ZMabc123/ both');
  });

  it('rewrites only the enabled platforms in a mixed message', () => {
    const mixed = { ...ALL_ON, tiktok: { enabled: false, domain: 'vxtiktok.com' } };
    const input = 'https://x.com/a/status/1 and https://vm.tiktok.com/ZMabc123/';
    expect(rewrite(input, mixed).content)
      .toBe('https://fxtwitter.com/a/status/1 and https://vm.tiktok.com/ZMabc123/');
  });

  it('honours a non-default target domain from config', () => {
    const custom = { ...ALL_ON, twitter: { enabled: true, domain: 'fixupx.com' } };
    expect(rewrite('https://x.com/jack/status/20', custom).content)
      .toBe('https://fixupx.com/jack/status/20');
  });
});

describe('rewrite — skip conditions', () => {
  it('skips a link inside a fenced code block', () => {
    const input = '```\nhttps://x.com/jack/status/20\n```';
    expect(rewrite(input, ALL_ON).changed).toBe(false);
  });

  it('skips a link inside inline backticks', () => {
    expect(rewrite('use `https://x.com/jack/status/20` here', ALL_ON).changed).toBe(false);
  });

  it('skips a link inside a spoiler', () => {
    expect(rewrite('||https://x.com/jack/status/20||', ALL_ON).changed).toBe(false);
  });

  it('skips an author-suppressed link in angle brackets', () => {
    expect(rewrite('<https://x.com/jack/status/20>', ALL_ON).changed).toBe(false);
  });

  it('still rewrites a link outside the masked region', () => {
    const input = '`https://x.com/a/status/1` but https://x.com/b/status/2';
    expect(rewrite(input, ALL_ON).content)
      .toBe('`https://x.com/a/status/1` but https://fxtwitter.com/b/status/2');
  });

  it('skips a link on a disabled platform target domain', () => {
    const off = { ...ALL_ON, instagram: { enabled: false, domain: 'kkinstagram.com' } };
    expect(rewrite('https://kkinstagram.com/reel/Cabc123/', off).changed).toBe(false);
  });
});
