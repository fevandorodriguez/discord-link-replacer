export const PLATFORMS = ['twitter', 'instagram', 'tiktok', 'reddit', 'bluesky'];

export const DEFAULT_DOMAINS = {
  twitter: 'fxtwitter.com',
  instagram: 'instagirlcock.com',
  tiktok: 'vxtiktok.com',
  reddit: 'rxddit.com',
  bluesky: 'fxbsky.app',
};

// A bare profile link already embeds acceptably, so every path pattern is
// deliberately narrow: only the URL shapes whose native embed is broken.
export const RULES = [
  {
    platform: 'twitter',
    hosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 'vxtwitter.com', 'fixupx.com'],
    path: /^\/[A-Za-z0-9_]{1,15}\/status\/\d+/,
  },
  {
    platform: 'instagram',
    hosts: ['instagram.com', 'ddinstagram.com'],
    // Four shapes, all plain host swaps: a post or reel; a /share/ link, which
    // is what the app's "Copy link" now produces; a story; and the
    // username-prefixed form of a post or reel. A bare profile is not included
    // — it embeds fine on its own.
    path: /^\/(?:(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+|share\/[A-Za-z0-9_-]+|stories\/[A-Za-z0-9._]+\/\d+|[A-Za-z0-9._]+\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+)/,
    // Instagram carries an album's position as a query parameter; the mirrors
    // take it as a trailing path segment instead. Only albums have one, in
    // either the bare or the username-prefixed form.
    albumIndex: { param: 'img_index', appliesTo: /^\/(?:[A-Za-z0-9._]+\/)?p\// },
  },
  {
    platform: 'tiktok',
    hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    path: /^\/(@[\w.]+\/video\/\d+|t\/[A-Za-z0-9]+)/,
    shortHosts: ['vm.tiktok.com', 'vt.tiktok.com'],
    shortPath: /^\/[A-Za-z0-9]+\/?$/,
  },
  {
    platform: 'reddit',
    hosts: ['reddit.com', 'old.reddit.com'],
    path: /^\/r\/[A-Za-z0-9_]+\/(comments|s)\//,
  },
  {
    platform: 'bluesky',
    hosts: ['bsky.app'],
    path: /^\/profile\/[^/]+\/post\/[A-Za-z0-9]+/,
  },
];

export function normaliseHost(host) {
  return host.toLowerCase().replace(/^www\./, '');
}

export function matchRule(host, pathname) {
  const h = normaliseHost(host);
  for (const rule of RULES) {
    if (!rule.hosts.includes(h)) continue;
    if (rule.path.test(pathname)) return rule;
    if (rule.shortHosts?.includes(h) && rule.shortPath.test(pathname)) return rule;
  }
  return null;
}
