import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

let dir;
let file;

const VALID = {
  twitter: { enabled: true, domain: 'fxtwitter.com' },
  instagram: { enabled: true, domain: 'kkinstagram.com' },
  tiktok: { enabled: true, domain: 'vxtiktok.com' },
  reddit: { enabled: true, domain: 'rxddit.com' },
  bluesky: { enabled: true, domain: 'fxbsky.app' },
};

function write(contents) {
  writeFileSync(file, JSON.stringify(contents));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linkfix-'));
  file = join(dir, 'config.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('loads a valid config', () => {
    write(VALID);
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.token).toBe('abc');
    expect(config.platforms.twitter).toEqual({ enabled: true, domain: 'fxtwitter.com' });
  });

  it('fills in a default domain when one is omitted', () => {
    write({ ...VALID, twitter: { enabled: true } });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.platforms.twitter.domain).toBe('fxtwitter.com');
  });

  it('defaults a missing platform to enabled on its default domain', () => {
    write({ twitter: { enabled: true, domain: 'fxtwitter.com' } });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.platforms.bluesky).toEqual({ enabled: true, domain: 'fxbsky.app' });
  });

  it('lets an env var override the domain', () => {
    write(VALID);
    const config = loadConfig({
      file,
      env: { DISCORD_TOKEN: 'abc', LINKFIX_INSTAGRAM_DOMAIN: 'ddinstagram.com' },
    });
    expect(config.platforms.instagram.domain).toBe('ddinstagram.com');
  });

  it('lets an env var disable a platform', () => {
    write(VALID);
    const config = loadConfig({
      file,
      env: { DISCORD_TOKEN: 'abc', LINKFIX_TIKTOK_ENABLED: 'false' },
    });
    expect(config.platforms.tiktok.enabled).toBe(false);
  });

  it('throws when the token is missing', () => {
    write(VALID);
    expect(() => loadConfig({ file, env: {} })).toThrow(/DISCORD_TOKEN/);
  });

  it('throws on an unknown platform key', () => {
    write({ ...VALID, myspace: { enabled: true, domain: 'myspace.com' } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/myspace/);
  });

  it('throws on a malformed domain', () => {
    write({ ...VALID, twitter: { enabled: true, domain: 'https://fxtwitter.com/' } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/domain/i);
  });
});
