import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

let dir;
let file;

const VALID = {
  twitter: { enabled: true, domain: 'fxtwitter.com' },
  instagram: { enabled: true, domain: 'oginstagram.com' },
  tiktok: { enabled: true, domain: 'tnktok.com' },
  reddit: { enabled: true, domain: 'vxreddit.com' },
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
      env: { DISCORD_TOKEN: 'abc', LINKFIX_INSTAGRAM_DOMAIN: 'toinstagram.com' },
    });
    expect(config.platforms.instagram.domain).toBe('toinstagram.com');
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

  it('throws on a malformed domain, naming the config file', () => {
    write({ ...VALID, twitter: { enabled: true, domain: 'https://fxtwitter.com/' } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/domain/i);
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(file);
  });

  it('lets an env var enable a platform disabled in the file', () => {
    write({ ...VALID, tiktok: { enabled: false, domain: 'tnktok.com' } });
    const config = loadConfig({
      file,
      env: { DISCORD_TOKEN: 'abc', LINKFIX_TIKTOK_ENABLED: 'TRUE' },
    });
    expect(config.platforms.tiktok.enabled).toBe(true);
  });
});

describe('loadConfig — enabled must be a real boolean', () => {
  it.each([
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['a number', 0],
    ['null', null],
  ])('throws when enabled is %s rather than a boolean', (_label, value) => {
    // "enabled": "false" is a truthy string: silently leaving the platform on
    // is the exact opposite of what the operator asked for.
    write({ ...VALID, tiktok: { enabled: value, domain: 'tnktok.com' } });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }))
      .toThrow(/enabled.*tiktok/i);
  });

  it.each(['yes', '1', 'on', 'off', ''])(
    'throws on LINKFIX_TIKTOK_ENABLED=%j rather than guessing',
    (value) => {
      write(VALID);
      expect(() => loadConfig({
        file,
        env: { DISCORD_TOKEN: 'abc', LINKFIX_TIKTOK_ENABLED: value },
      })).toThrow(/LINKFIX_TIKTOK_ENABLED/);
    },
  );

  it.each([
    ['TRUE', true],
    ['False', false],
    [' true ', true],
  ])('accepts %j case-insensitively', (value, expected) => {
    write(VALID);
    const config = loadConfig({
      file,
      env: { DISCORD_TOKEN: 'abc', LINKFIX_TIKTOK_ENABLED: value },
    });
    expect(config.platforms.tiktok.enabled).toBe(expected);
  });
});

describe('loadConfig — the file must contain a JSON object', () => {
  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"twitter"'],
    ['a number', '7'],
  ])('throws when the config is %s, naming the file', (_label, contents) => {
    writeFileSync(file, contents);
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(file);
  });
});

describe('loadConfig — mode', () => {
  it('defaults to repost when unset', () => {
    write(VALID);
    expect(loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }).mode).toBe('repost');
  });

  it('reads the mode from the config file', () => {
    write({ ...VALID, mode: 'suppress' });
    expect(loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } }).mode).toBe('suppress');
  });

  it('lets an env var override the mode, case-insensitively', () => {
    write({ ...VALID, mode: 'repost' });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc', LINKFIX_MODE: 'SUPPRESS' } });
    expect(config.mode).toBe('suppress');
  });

  it.each(['edit', '', 'repost ', 'true'])('throws on the invalid mode %s', (value) => {
    write({ ...VALID, mode: value });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/mode/i);
  });

  it('names the valid modes in the error', () => {
    write({ ...VALID, mode: 'edit' });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).toThrow(/repost.*suppress|suppress.*repost/);
  });

  it('does not mistake mode for an unknown platform', () => {
    write({ ...VALID, mode: 'suppress' });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } })).not.toThrow();
  });

  it('throws on invalid LINKFIX_MODE, naming the env var not the config file', () => {
    write({ ...VALID, mode: 'repost' });
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc', LINKFIX_MODE: 'banana' } }))
      .toThrow(/LINKFIX_MODE/);
    expect(() => loadConfig({ file, env: { DISCORD_TOKEN: 'abc', LINKFIX_MODE: 'banana' } }))
      .not.toThrow(new RegExp(file));
  });

  it('lets a valid LINKFIX_MODE override a valid file value', () => {
    write({ ...VALID, mode: 'repost' });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc', LINKFIX_MODE: 'suppress' } });
    expect(config.mode).toBe('suppress');
  });
});

describe('loadConfig — modeSource', () => {
  // LINKFIX_MODE silently overrides mode in config.json, so an operator
  // troubleshooting a stuck mode needs the ready log to name which of the two
  // actually won. modeSource is how loadConfig reports that.

  it('reports "LINKFIX_MODE" when the env var set the mode', () => {
    write({ ...VALID, mode: 'repost' });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc', LINKFIX_MODE: 'suppress' } });
    expect(config.mode).toBe('suppress');
    expect(config.modeSource).toBe('LINKFIX_MODE');
  });

  it('reports "config.json" when the file set the mode', () => {
    write({ ...VALID, mode: 'suppress' });
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.mode).toBe('suppress');
    expect(config.modeSource).toBe('config.json');
  });

  it('reports "default" when neither the env var nor the file set the mode', () => {
    write(VALID);
    const config = loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
    expect(config.mode).toBe('repost');
    expect(config.modeSource).toBe('default');
  });
});
