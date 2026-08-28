export const PLATFORMS = ['twitter', 'instagram', 'tiktok', 'reddit', 'bluesky'];

export const DEFAULT_DOMAINS = {
  twitter: 'fxtwitter.com',
  instagram: 'kkinstagram.com',
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
    path: /^\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/,
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
