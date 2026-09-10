import { describe, it, expect, vi } from 'vitest';
import { createLogBuffer } from '../src/logbuffer.js';

describe('createLogBuffer', () => {
  it('starts empty', () => {
    expect(createLogBuffer().entries()).toEqual([]);
  });

  it('records entries oldest first with a level and a timestamp', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'first');
    buffer.record('error', 'second');
    const entries = buffer.entries();
    expect(entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(entries[1].level).toBe('error');
    expect(() => new Date(entries[0].at).toISOString()).not.toThrow();
  });

  it('evicts the oldest once full', () => {
    const buffer = createLogBuffer(3);
    for (const text of ['a', 'b', 'c', 'd']) buffer.record('info', text);
    expect(buffer.entries().map((e) => e.text)).toEqual(['b', 'c', 'd']);
  });

  it('passes attached log calls through to the base logger', () => {
    const base = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const buffer = createLogBuffer();
    const logger = buffer.attach(base);

    logger.info('up');
    logger.warn('odd');
    logger.error('bad');

    expect(base.info).toHaveBeenCalledWith('up');
    expect(base.warn).toHaveBeenCalledWith('odd');
    expect(base.error).toHaveBeenCalledWith('bad');
  });

  it('records what it passes through, at the right levels', () => {
    const base = { info: () => {}, warn: () => {}, error: () => {} };
    const buffer = createLogBuffer();
    const logger = buffer.attach(base);

    logger.info('up');
    logger.error('bad');

    expect(buffer.entries()).toEqual([
      expect.objectContaining({ level: 'info', text: 'up' }),
      expect.objectContaining({ level: 'error', text: 'bad' }),
    ]);
  });

  it('exposes only at, level and text — no field could carry message content', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'replaced in #general');
    expect(Object.keys(buffer.entries()[0]).sort()).toEqual(['at', 'level', 'text']);
  });

  it('returns a copy, so a caller cannot mutate the buffer', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'one');
    buffer.entries().push({ at: 'x', level: 'info', text: 'injected' });
    expect(buffer.entries()).toHaveLength(1);
  });

  it('coerces non-string text to string to prevent content leaks', () => {
    const buffer = createLogBuffer();
    buffer.record('info', { originalContent: 'secret', channelId: 'C1' });
    const entries = buffer.entries();
    expect(entries[0].text).not.toContain('secret');
    expect(entries[0].text).toBe('[non-string log value]');
  });

  it('returns deep copies so mutating an entry does not corrupt the buffer', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 'one');
    const first = buffer.entries()[0];
    first.text = 'TAMPERED';
    expect(buffer.entries()[0].text).toBe('one');
  });

  it('passes all arguments to the base logger, recording only the first', () => {
    const base = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const buffer = createLogBuffer();
    const logger = buffer.attach(base);

    logger.info('message', new Error('stack trace'), { metadata: 'extra' });

    expect(base.info).toHaveBeenCalledWith('message', new Error('stack trace'), { metadata: 'extra' });
    expect(base.info).toHaveBeenCalledTimes(1);
    // Only 'message' is recorded, not the stack trace or metadata
    expect(buffer.entries()[0].text).toBe('message');
  });

  it('enforces positive integer size, falling back to default for nonsense values', () => {
    // NaN should use default size (200) and evict properly
    const bufferNaN = createLogBuffer(NaN);
    for (let i = 0; i < 250; i++) bufferNaN.record('info', `item${i}`);
    expect(bufferNaN.entries()).toHaveLength(200);
    expect(bufferNaN.entries()[0].text).toBe('item50');

    // 0 should use default size (200) and evict properly
    const bufferZero = createLogBuffer(0);
    for (let i = 0; i < 250; i++) bufferZero.record('info', `item${i}`);
    expect(bufferZero.entries()).toHaveLength(200);

    // Negative should use default size (200) and evict properly
    const bufferNegative = createLogBuffer(-5);
    for (let i = 0; i < 250; i++) bufferNegative.record('info', `item${i}`);
    expect(bufferNegative.entries()).toHaveLength(200);

    // Non-integer should use default size (200) and evict properly
    const bufferString = createLogBuffer('abc');
    for (let i = 0; i < 250; i++) bufferString.record('info', `item${i}`);
    expect(bufferString.entries()).toHaveLength(200);
  });

  it('blocks arrays from leaking content via Array.toString', () => {
    const buffer = createLogBuffer();
    buffer.record('info', ['secret message here', 'https://evil']);
    const text = buffer.entries()[0].text;
    expect(text).not.toContain('secret message here');
    expect(text).not.toContain('https://evil');
    expect(text).toBe('[non-string log value]');
  });

  it('blocks objects with custom toString from leaking content', () => {
    const buffer = createLogBuffer();
    const malicious = {
      toString() {
        return 'secret via toString https://evil';
      },
    };
    buffer.record('info', malicious);
    const text = buffer.entries()[0].text;
    expect(text).not.toContain('secret');
    expect(text).not.toContain('https://evil');
    expect(text).toBe('[non-string log value]');
  });

  it('still blocks plain objects even though they collapse to [object Object]', () => {
    const buffer = createLogBuffer();
    buffer.record('info', { originalContent: 'secret', channelId: 'C1' });
    const text = buffer.entries()[0].text;
    expect(text).not.toContain('secret');
    expect(text).toBe('[non-string log value]');
  });

  it('allows numbers and booleans through, as they cannot carry message content', () => {
    const buffer = createLogBuffer();
    buffer.record('info', 42);
    buffer.record('info', true);
    buffer.record('info', false);
    const entries = buffer.entries();
    expect(entries[0].text).toBe('42');
    expect(entries[1].text).toBe('true');
    expect(entries[2].text).toBe('false');
  });

  it('replaces null and undefined with the placeholder, not string mangling', () => {
    const buffer = createLogBuffer();
    buffer.record('info', null);
    buffer.record('info', undefined);
    const entries = buffer.entries();
    expect(entries[0].text).toBe('[non-string log value]');
    expect(entries[0].text).not.toBe('null');
    expect(entries[1].text).toBe('[non-string log value]');
    expect(entries[1].text).not.toBe('undefined');
  });
});
