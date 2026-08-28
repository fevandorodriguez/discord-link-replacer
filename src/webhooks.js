export const WEBHOOK_NAME = 'Link Replacer';

export function createWebhookCache(botUserId) {
  // channel ID -> Promise<Webhook>. Storing the promise, not the resolved
  // value, means two messages arriving at once share one creation call.
  const cache = new Map();

  async function resolve(channel) {
    const hooks = await channel.fetchWebhooks();
    const mine = hooks.find((hook) => hook.owner?.id === botUserId && hook.token);
    if (mine) return mine;
    return channel.createWebhook({ name: WEBHOOK_NAME });
  }

  return {
    get(channel) {
      // A thread has no webhooks of its own; it posts through its parent's.
      const target = channel.isThread() ? channel.parent : channel;
      if (!cache.has(target.id)) {
        const pending = resolve(target).catch((error) => {
          cache.delete(target.id); // don't cache a failure
          throw error;
        });
        cache.set(target.id, pending);
      }
      return cache.get(target.id);
    },
    size: () => cache.size,
  };
}
