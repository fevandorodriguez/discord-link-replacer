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
