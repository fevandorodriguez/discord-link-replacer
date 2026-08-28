import { describe, it, expect, vi } from 'vitest';
import { createWebhookCache } from '../src/webhooks.js';

const BOT_ID = 'bot-1';

function fakeChannel({ id = 'chan-1', existing = [], isThread = false, parent = null } = {}) {
  return {
    id,
    isThread: () => isThread,
    parent,
    fetchWebhooks: vi.fn(async () => ({ find: (fn) => existing.find(fn) ?? null })),
    createWebhook: vi.fn(async ({ name }) => ({ id: 'hook-new', name, owner: { id: BOT_ID }, token: 'tok' })),
  };
}

describe('createWebhookCache', () => {
  it('creates a webhook when the channel has none', async () => {
    const channel = fakeChannel();
    const cache = createWebhookCache(BOT_ID);
    const hook = await cache.get(channel);
    expect(hook.id).toBe('hook-new');
    expect(channel.createWebhook).toHaveBeenCalledOnce();
  });

  it('reuses an existing webhook owned by the bot', async () => {
    const mine = { id: 'hook-old', owner: { id: BOT_ID }, token: 'tok' };
    const channel = fakeChannel({ existing: [mine] });
    const cache = createWebhookCache(BOT_ID);
    expect((await cache.get(channel)).id).toBe('hook-old');
    expect(channel.createWebhook).not.toHaveBeenCalled();
  });

  it('ignores a webhook owned by someone else', async () => {
    const theirs = { id: 'hook-theirs', owner: { id: 'other' }, token: 'tok' };
    const channel = fakeChannel({ existing: [theirs] });
    const cache = createWebhookCache(BOT_ID);
    expect((await cache.get(channel)).id).toBe('hook-new');
  });

  it('does not re-fetch on a cache hit', async () => {
    const channel = fakeChannel();
    const cache = createWebhookCache(BOT_ID);
    await cache.get(channel);
    await cache.get(channel);
    expect(channel.fetchWebhooks).toHaveBeenCalledOnce();
    expect(cache.size()).toBe(1);
  });

  it('resolves a thread against its parent channel', async () => {
    const parent = fakeChannel({ id: 'parent-1' });
    const thread = fakeChannel({ id: 'thread-1', isThread: true, parent });
    const cache = createWebhookCache(BOT_ID);
    await cache.get(thread);
    expect(parent.createWebhook).toHaveBeenCalledOnce();
    expect(thread.createWebhook).not.toHaveBeenCalled();
  });
});
