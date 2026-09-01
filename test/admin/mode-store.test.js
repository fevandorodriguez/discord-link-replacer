import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModeStore } from '../../src/admin/mode-store.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'modestore-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    mode: 'repost',
    twitter: { enabled: true, domain: 'fxtwitter.com' },
  }, null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createModeStore', () => {
  it('reports the mode and source it was built with', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(store.current()).toBe('repost');
    expect(store.source()).toBe('config.json');
    expect(store.locked()).toBe(false);
  });

  it('is locked when the env var supplied the mode', () => {
    const store = createModeStore({ mode: 'suppress', modeSource: 'LINKFIX_MODE', file });
    expect(store.locked()).toBe(true);
  });

  it('changes the live mode', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');
    expect(store.current()).toBe('suppress');
  });

  it('persists the change to the config file', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
  });

  it('preserves every other key in the file', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).twitter)
      .toEqual({ enabled: true, domain: 'fxtwitter.com' });
  });

  it('refuses to change a locked mode, and leaves the file alone', () => {
    const store = createModeStore({ mode: 'suppress', modeSource: 'LINKFIX_MODE', file });
    expect(() => store.set('repost')).toThrow(/LINKFIX_MODE/);
    expect(store.current()).toBe('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('repost');
  });

  it.each(['edit', '', 'REPOST ', null])('rejects the invalid mode %s', (bad) => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(() => store.set(bad)).toThrow(/mode/i);
    expect(store.current()).toBe('repost');
  });

  it('defaults to the source being the file when built from a default', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'default', file });
    expect(store.locked()).toBe(false);
    store.set('suppress');
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
  });

  it('rejects an array root and leaves the file alone', () => {
    writeFileSync(file, JSON.stringify(['repost']));
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(() => store.set('suppress')).toThrow(/must be a JSON object/);
    expect(store.current()).toBe('repost');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['repost']);
  });

  it('rejects a null root and leaves the file alone', () => {
    writeFileSync(file, 'null');
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(() => store.set('suppress')).toThrow(/must be a JSON object/);
    expect(store.current()).toBe('repost');
    expect(readFileSync(file, 'utf8')).toBe('null');
  });

  it('rejects a primitive root and leaves the file alone', () => {
    writeFileSync(file, '42');
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    expect(() => store.set('suppress')).toThrow(/must be a JSON object/);
    expect(store.current()).toBe('repost');
    expect(readFileSync(file, 'utf8')).toBe('42');
  });

  it('tags validation rejections with error.code = "MODE_REJECTED"', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });

    try {
      store.set('invalid');
    } catch (e) {
      expect(e.code).toBe('MODE_REJECTED');
    }
  });

  it('does not tag I/O errors with MODE_REJECTED', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file: '/nonexistent/path/config.json' });

    try {
      store.set('suppress');
    } catch (e) {
      expect(e.code).not.toBe('MODE_REJECTED');
    }
  });

  it('cleans up temp file on successful write and leaves no stray files', () => {
    const store = createModeStore({ mode: 'repost', modeSource: 'config.json', file });
    store.set('suppress');

    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
    const tempFile = `${file}.tmp`;
    expect(existsSync(tempFile)).toBe(false);
  });
});
