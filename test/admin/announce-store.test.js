import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnnounceStore } from '../../src/admin/announce-store.js';

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
});
