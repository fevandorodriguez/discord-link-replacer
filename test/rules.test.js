import { describe, it, expect } from 'vitest';
import { PLATFORMS, DEFAULT_DOMAINS, matchRule } from '../src/rules.js';

describe('rule table', () => {
  it('exposes the five platform keys', () => {
    expect(PLATFORMS).toEqual(['twitter', 'instagram', 'tiktok', 'reddit', 'bluesky']);
  });

  it('exposes a default domain for every platform', () => {
    expect(DEFAULT_DOMAINS).toEqual({
      twitter: 'fxtwitter.com',
      instagram: 'instagirlcock.com',
      tiktok: 'vxtiktok.com',
      reddit: 'rxddit.com',
      bluesky: 'fxbsky.app',
    });
  });
});

describe('matchRule', () => {
  it.each([
    ['x.com', '/jack/status/20', 'twitter'],
    ['twitter.com', '/jack/status/20', 'twitter'],
    ['mobile.twitter.com', '/jack/status/20', 'twitter'],
    ['instagram.com', '/reel/Cabc123/', 'instagram'],
    ['instagram.com', '/p/Cabc123/', 'instagram'],
    ['tiktok.com', '/@someone/video/7123456789', 'tiktok'],
    ['vm.tiktok.com', '/ZMabc123/', 'tiktok'],
    ['reddit.com', '/r/videos/comments/abc123/title/', 'reddit'],
    ['reddit.com', '/r/videos/s/AbCd1234', 'reddit'],
    ['bsky.app', '/profile/someone.bsky.social/post/3kabc', 'bluesky'],
  ])('matches %s%s as %s', (host, pathname, platform) => {
    expect(matchRule(host, pathname)?.platform).toBe(platform);
  });

  it('ignores a leading www and host casing', () => {
    expect(matchRule('WWW.X.com', '/jack/status/20')?.platform).toBe('twitter');
  });

  it.each([
    ['x.com', '/jack'],
    ['instagram.com', '/someone'],
    ['tiktok.com', '/@someone'],
    ['tiktok.com', '/discover'],
    ['reddit.com', '/r/videos'],
    ['bsky.app', '/profile/someone.bsky.social'],
    ['example.com', '/jack/status/20'],
  ])('does not match %s%s', (host, pathname) => {
    expect(matchRule(host, pathname)).toBeNull();
  });

  it('only accepts bare short codes on the tiktok short hosts', () => {
    expect(matchRule('vt.tiktok.com', '/ZMabc123')?.platform).toBe('tiktok');
    expect(matchRule('tiktok.com', '/ZMabc123')).toBeNull();
  });
});
