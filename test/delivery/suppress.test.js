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
  });

  it('does not re-ping anyone, including the author', async () => {
    const message = fakeMessage();
    await deliver(message, 'https://fxtwitter.com/a/status/1', { logger: silentLogger });
    expect(message.reply).toHaveBeenCalledWith({
      content: 'https://fxtwitter.com/a/status/1',
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it('never suppresses when the reply fails', async () => {
    const message = fakeMessage({ reply: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await deliver(message, 'x', { logger: silentLogger })).toBe('send-failed');
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  it('still reports success when only the suppression fails', async () => {
    const message = fakeMessage({
      suppressEmbeds: vi.fn(async () => { throw new Error('no permission'); }),
    });
    expect(await deliver(message, 'x', { logger: silentLogger })).toBe('suppressed');
  });

  it('never deletes the original', async () => {
    const message = fakeMessage({ delete: vi.fn() });
    await deliver(message, 'x', { logger: silentLogger });
    expect(message.delete).not.toHaveBeenCalled();
  });
});
