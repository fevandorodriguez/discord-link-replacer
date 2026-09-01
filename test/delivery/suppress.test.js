import { describe, it, expect, vi } from 'vitest';
import { deliver } from '../../src/delivery/suppress.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    channel: { id: 'chan-1' },
    reply: vi.fn(async () => {}),
    suppressEmbeds: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('suppress delivery', () => {
  it('replies with the fixed link, then suppresses the original embed', async () => {
    const order = [];
    const message = fakeMessage({
      reply: vi.fn(async () => { order.push('reply'); }),
      suppressEmbeds: vi.fn(async () => { order.push('suppress'); }),
    });

    expect(await deliver(message, 'https://fxtwitter.com/a/status/1', { logger: silentLogger }))
      .toBe('suppressed');
    expect(order).toEqual(['reply', 'suppress']);
    // suppress = true is discord.js's default, so a bare suppressEmbeds()
    // call would also pass — but a regression to suppressEmbeds(false), which
    // would *un-suppress* the original, must not pass silently.
    expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
  });

  it('does not re-ping anyone, including the author', async () => {
    const message = fakeMessage();
    await deliver(message, 'https://fxtwitter.com/a/status/1', { logger: silentLogger });
    expect(message.reply).toHaveBeenCalledWith({
      content: 'https://fxtwitter.com/a/status/1',
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it('never suppresses when the reply fails, and logs the failure', async () => {
    const message = fakeMessage({ reply: vi.fn(async () => { throw new Error('boom'); }) });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await deliver(message, 'x', { logger })).toBe('send-failed');
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/boom/);
  });

  it('still reports success when only the suppression fails, and logs a warning', async () => {
    const message = fakeMessage({
      suppressEmbeds: vi.fn(async () => { throw new Error('no permission'); }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await deliver(message, 'x', { logger })).toBe('suppressed');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/no permission/);
  });

  it('never deletes the original', async () => {
    const message = fakeMessage({ delete: vi.fn() });
    await deliver(message, 'x', { logger: silentLogger });
    expect(message.delete).not.toHaveBeenCalled();
  });
});
