import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnnounceStore } from '../../src/admin/announce-store.js';
import { loadConfig, MAX_QUIPS, MAX_QUIP_LENGTH } from '../../src/config.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'announce-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mode: 'repost', twitter: { enabled: true, domain: 'fxtwitter.com' } }, null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => createAnnounceStore({ channelId: '', quips: [], file });

describe('createAnnounceStore', () => {
  it('reports what it was built with', () => {
    const s = createAnnounceStore({ channelId: '99', quips: ['hi'], file });
    expect(s.current()).toEqual({ channelId: '99', quips: ['hi'] });
  });

  it('changes the live settings', () => {
    const s = store();
    s.set({ channelId: '123', quips: ['back'] });
    expect(s.current()).toEqual({ channelId: '123', quips: ['back'] });
  });

  it('persists to the config file', () => {
    store().set({ channelId: '123', quips: ['back'] });
    expect(JSON.parse(readFileSync(file, 'utf8')).announce)
      .toEqual({ channelId: '123', quips: ['back'] });
  });

  it('leaves every other key in the file alone', () => {
    store().set({ channelId: '123', quips: [] });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.mode).toBe('repost');
    expect(raw.twitter).toEqual({ enabled: true, domain: 'fxtwitter.com' });
  });

  it('accepts an empty channel, meaning announcements are off', () => {
    const s = createAnnounceStore({ channelId: '123', quips: [], file });
    s.set({ channelId: '', quips: [] });
    expect(s.current().channelId).toBe('');
  });

  it.each(['abc', '12a', ' 1', 42, null, {}])('rejects the invalid channelId %s', (bad) => {
    const s = store();
    expect(() => s.set({ channelId: bad, quips: [] })).toThrow(/channel/i);
    expect(s.current().channelId).toBe('');
  });

  it.each([['not an array', 'nope'], ['a non-string entry', [42]], ['a blank entry', ['  ']]])(
    'rejects quips that are %s',
    (_label, bad) => {
      const s = store();
      expect(() => s.set({ channelId: '', quips: bad })).toThrow(/quip/i);
    },
  );

  it('rejects a quip longer than Discord accepts', () => {
    expect(() => store().set({ channelId: '', quips: ['x'.repeat(2001)] })).toThrow(/2000/);
  });

  it('rejects more than fifty quips', () => {
    const many = Array.from({ length: 51 }, (_, i) => `q${i}`);
    expect(() => store().set({ channelId: '', quips: many })).toThrow(/50/);
  });

  it('tags its own refusals so the API can tell them from an I/O fault', () => {
    try {
      store().set({ channelId: 'nope', quips: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ANNOUNCE_REJECTED');
    }
  });

  it('writes nothing when the input is rejected', () => {
    const before = readFileSync(file, 'utf8');
    try { store().set({ channelId: 'nope', quips: [] }); } catch { /* expected */ }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  // set() is deliberately stricter than loadConfig here: resolveAnnounce
  // defaults an absent channelId/quips because config.json predates the
  // announce feature -- most existing files simply won't have the key, and
  // that has to keep loading. The panel, though, is a form that always
  // submits both fields; an omitted one there is a bug in the caller, not
  // an instruction to leave the other value alone. Defaulting here would
  // let a broken request silently wipe out whichever field it forgot to
  // send. It's also the safe direction: a store that refuses more than the
  // loader can never produce a config the loader itself would refuse to
  // read back. Do not "fix" this into matching resolveAnnounce's defaulting.
  it('rejects a request that omits quips, rather than defaulting it', () => {
    try {
      store().set({ channelId: '123' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ANNOUNCE_REJECTED');
    }
  });

  it('rejects a request that omits channelId, rather than defaulting it', () => {
    try {
      store().set({ quips: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ANNOUNCE_REJECTED');
    }
  });

  // The store's contract is "throws with error.code = 'ANNOUNCE_REJECTED' on
  // any invalid input" -- including input that isn't an object at all.
  // Without a guard, `set(null)` (or `set()`, i.e. `set(undefined)`) throws
  // a raw TypeError out of the parameter destructuring, before
  // validateAnnounce -- or this function's own body -- ever runs. That path
  // is unreachable from today's only caller, but a contract that is nearly
  // true is one a future caller will trust and be wrong about.
  it.each([null, undefined, 'nope', 42, []])(
    'rejects a non-object argument (%s) as ANNOUNCE_REJECTED, not a raw TypeError',
    (bad) => {
      const s = store();
      try {
        s.set(bad);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e.code).toBe('ANNOUNCE_REJECTED');
      }
    },
  );
});

// Both callers -- resolveAnnounce (the boot-time loader) and
// createAnnounceStore.set (the panel's write path) -- delegate to the same
// validateAnnounce. Each suite above only proves its own call site behaves;
// neither would notice if a future edit re-inlined divergent rules into one
// side. This table drives both paths with the same inputs and asserts they
// reach the same accept/reject verdict, so drift between them fails a test
// rather than waiting to be noticed at boot.
//
// Undefined channelId/quips are deliberately excluded: the loader defaults
// them and the store does not (see the "omits" tests above) -- that's the
// one place the two paths are meant to disagree.
describe('validateAnnounce — the loader and the store agree', () => {
  const cases = [
    ['a valid pair', '123', ['hi'], true],
    ['a non-digit channelId', 'abc', [], false],
    ['an explicit null channelId', null, [], false],
    ['an explicit null quips', '', null, false],
    ['a non-array quips', '', 'nope', false],
    ['a non-string quip entry', '', [42], false],
    ['a blank-string quip entry', '', ['   '], false],
    [`exactly ${MAX_QUIPS} quips`, '', Array.from({ length: MAX_QUIPS }, (_, i) => `q${i}`), true],
    [`one more than ${MAX_QUIPS} quips`, '', Array.from({ length: MAX_QUIPS + 1 }, (_, i) => `q${i}`), false],
    [`a quip of exactly ${MAX_QUIP_LENGTH} characters`, '', ['x'.repeat(MAX_QUIP_LENGTH)], true],
    [`a quip longer than ${MAX_QUIP_LENGTH} characters`, '', ['x'.repeat(MAX_QUIP_LENGTH + 1)], false],
  ];

  it.each(cases)('%s: loader and store reach the same verdict', (_label, channelId, quips, shouldAccept) => {
    writeFileSync(file, JSON.stringify({ announce: { channelId, quips } }));
    let loaderAccepted;
    try {
      loadConfig({ file, env: { DISCORD_TOKEN: 'abc' } });
      loaderAccepted = true;
    } catch {
      loaderAccepted = false;
    }

    let storeAccepted;
    try {
      createAnnounceStore({ channelId: '', quips: [], file }).set({ channelId, quips });
      storeAccepted = true;
    } catch (e) {
      if (e.code !== 'ANNOUNCE_REJECTED') throw e;
      storeAccepted = false;
    }

    expect(loaderAccepted).toBe(shouldAccept);
    expect(storeAccepted).toBe(shouldAccept);
  });
});
