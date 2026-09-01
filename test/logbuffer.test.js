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
});
