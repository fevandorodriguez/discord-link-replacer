import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateConfig } from '../src/config-writer.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfgwrite-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mode: 'repost', keep: { a: 1 } }, null, 2));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('updateConfig', () => {
  it('applies the mutation to the file', () => {
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(JSON.parse(readFileSync(file, 'utf8')).mode).toBe('suppress');
  });

  it('leaves every other key untouched', () => {
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(JSON.parse(readFileSync(file, 'utf8')).keep).toEqual({ a: 1 });
  });

  it('leaves no temp file behind', () => {
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('preserves the file mode', () => {
    chmodSync(file, 0o600);
    updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '7'],
    ['a string', '"hello"'],
  ])('refuses to write when the root is %s', (_label, contents) => {
    writeFileSync(file, contents);
    expect(() => updateConfig(file, (raw) => { raw.mode = 'suppress'; }, { rejectCode: 'X' })).toThrow(/must be a JSON object/);
    expect(readFileSync(file, 'utf8')).toBe(contents);
  });

  it('tags a rejected root with the caller’s code', () => {
    writeFileSync(file, '[]');
    try {
      updateConfig(file, () => {}, { rejectCode: 'MODE_REJECTED' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('MODE_REJECTED');
    }
  });

  it('lets a parse error propagate untagged', () => {
    writeFileSync(file, '{not json');
    try {
      updateConfig(file, () => {}, { rejectCode: 'MODE_REJECTED' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).not.toBe('MODE_REJECTED');
    }
  });
});
