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

  // A thread has no webhooks of its own; it posts through its parent's.
  function targetOf(channel) {
    return channel.isThread() ? channel.parent : channel;
  }

  return {
    get(channel) {
      const target = targetOf(channel);
      if (!target) {
        return Promise.reject(
          new Error(`thread ${channel.id} has no resolvable parent channel`)
        );
      }
      if (!cache.has(target.id)) {
        const pending = resolve(target).catch((error) => {
          cache.delete(target.id); // don't cache a failure
          throw error;
        });
        cache.set(target.id, pending);
      }
      return cache.get(target.id);
    },
    // Drops a cached webhook a moderator deleted from channel settings. The
    // cache is otherwise only invalidated when resolution fails, so a webhook
    // that dies after being cached wedges the channel until the process
    // restarts: the cached promise keeps resolving to the dead object.
    invalidate(channel) {
      const target = targetOf(channel);
      if (target) cache.delete(target.id);
    },
    size: () => cache.size,
  };
}
