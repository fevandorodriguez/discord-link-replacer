import { describe, it, expect, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { ignoreReason, buildPayload, handleMessage } from '../src/bot.js';

const BOT_ID = 'bot-1';

// A message that should pass every guard.
function fakeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    content: 'https://x.com/jack/status/20',
    author: { id: 'user-1', bot: false },
    webhookId: null,
    guild: { id: 'guild-1' },
    system: false,
    attachments: { size: 0 },
    stickers: { size: 0 },
    reference: null,
    poll: null,
    channel: {
      id: 'chan-1',
      permissionsFor: () => ({ has: () => true }),
    },
    ...overrides,
  };
}

describe('ignoreReason', () => {
  it('allows an ordinary user message with a link', () => {
    expect(ignoreReason(fakeMessage(), BOT_ID)).toBeNull();
  });

  it('ignores messages from bots', () => {
    expect(ignoreReason(fakeMessage({ author: { id: 'x', bot: true } }), BOT_ID)).toBe('bot');
  });

  it('ignores messages sent by a webhook', () => {
    expect(ignoreReason(fakeMessage({ webhookId: 'hook-1' }), BOT_ID)).toBe('webhook');
  });

  it('ignores direct messages', () => {
    expect(ignoreReason(fakeMessage({ guild: null }), BOT_ID)).toBe('not-a-guild');
  });

  it('ignores system messages', () => {
    expect(ignoreReason(fakeMessage({ system: true }), BOT_ID)).toBe('system');
  });

  it('ignores messages with attachments, which a webhook cannot reproduce', () => {
    expect(ignoreReason(fakeMessage({ attachments: { size: 1 } }), BOT_ID)).toBe('has-attachments');
  });

  it('ignores messages with stickers', () => {
    expect(ignoreReason(fakeMessage({ stickers: { size: 1 } }), BOT_ID)).toBe('has-stickers');
  });

  it('ignores messages carrying a poll', () => {
    expect(ignoreReason(fakeMessage({ poll: { question: { text: 'which' } } }), BOT_ID)).toBe('has-poll');
  });

  it('ignores forwarded messages', () => {
    expect(ignoreReason(fakeMessage({ reference: { type: 1 } }), BOT_ID)).toBe('forwarded');
  });

  it('allows a plain reply, which is not a forward', () => {
    expect(ignoreReason(fakeMessage({ reference: { type: 0, messageId: 'msg-0' } }), BOT_ID)).toBeNull();
  });

  it('ignores channels where the bot lacks permissions', () => {
    const channel = { id: 'chan-1', permissionsFor: () => ({ has: () => false }) };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID)).toBe('missing-permissions');
  });

  it('ignores a channel it cannot resolve permissions for', () => {
    const channel = { id: 'chan-1', permissionsFor: () => null };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID)).toBe('missing-permissions');
  });

  it('ignores a message whose author is denied Embed Links in the channel', () => {
    // Webhook messages bypass the posting member's permissions, so reposting
    // here would embed a link the server has explicitly denied this user.
    const member = { id: 'member-1' };
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => ({
        has: (flag) => (who === member ? flag !== PermissionFlagsBits.EmbedLinks : true),
      }),
    };
    expect(ignoreReason(fakeMessage({ channel, member }), BOT_ID)).toBe('author-cannot-embed');
  });

  it('allows a message whose author has Embed Links', () => {
    const member = { id: 'member-1' };
    const channel = { id: 'chan-1', permissionsFor: () => ({ has: () => true }) };
    expect(ignoreReason(fakeMessage({ channel, member }), BOT_ID)).toBeNull();
  });

  it('falls back to the author when there is no member, and fails closed if unresolvable', () => {
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => (who === BOT_ID ? { has: () => true } : null),
    };
    expect(ignoreReason(fakeMessage({ channel, member: null }), BOT_ID)).toBe('author-cannot-embed');
  });

  it('ignores a channel missing just one of the required permissions', () => {
    // Two of three required flags true, one false: only distinguishes
    // REQUIRED_PERMISSIONS.every(...) from .some(...) if every() is used —
    // a regression to .some() would let this slip through as allowed.
    const channel = {
      id: 'chan-1',
      permissionsFor: () => ({
        has: (flag) => flag !== PermissionFlagsBits.SendMessages,
      }),
    };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID)).toBe('missing-permissions');
  });
});

function fakeMember() {
  return { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/avatar.png' };
}

describe('buildPayload', () => {
  it('posts as the member, without re-pinging anyone', () => {
    const message = fakeMessage({ member: fakeMember() });
    const payload = buildPayload(message, 'https://fxtwitter.com/jack/status/20');
    expect(payload).toEqual({
      content: 'https://fxtwitter.com/jack/status/20',
      username: 'Mike',
      avatarURL: 'https://cdn/avatar.png',
      allowedMentions: { parse: [] },
    });
  });

  it('adds a subtext line when the original was a reply', () => {
    const message = fakeMessage({
      member: fakeMember(),
      reference: { type: 0, messageId: 'msg-0' },
      mentions: { repliedUser: { id: 'user-9' } },
    });
    const payload = buildPayload(message, 'https://fxtwitter.com/jack/status/20');
    expect(payload.content).toBe('-# ↪ replying to <@user-9>\nhttps://fxtwitter.com/jack/status/20');
  });

  it('drops the subtext line but still rewrites when repliedUser is unresolved', () => {
    // The replied-to user left, or the message is uncached: repliedUser is
    // absent even though this is a reply. buildPayload silently omits the
    // subtext line rather than abandoning the rewrite.
    const message = fakeMessage({
      member: fakeMember(),
      reference: { type: 0, messageId: 'msg-0' },
    });
    const payload = buildPayload(message, 'https://fxtwitter.com/jack/status/20');
    expect(payload.content).toBe('https://fxtwitter.com/jack/status/20');
  });

  it('passes the thread ID when the message is in a thread', () => {
    const channel = {
      id: 'thread-1',
      isThread: () => true,
      permissionsFor: () => ({ has: () => true }),
    };
    const payload = buildPayload(fakeMessage({ member: fakeMember(), channel }), 'x');
    expect(payload.threadId).toBe('thread-1');
  });

  it('falls back to the author username when there is no member', () => {
    const message = fakeMessage({
      member: null,
      author: { id: 'user-1', bot: false, username: 'mike', displayAvatarURL: () => 'https://cdn/u.png' },
    });
    expect(buildPayload(message, 'x').username).toBe('mike');
  });
});

const PLATFORMS_ON = {
  twitter: { enabled: true, domain: 'fxtwitter.com' },
  instagram: { enabled: true, domain: 'instagirlcock.com' },
  tiktok: { enabled: true, domain: 'vxtiktok.com' },
  reddit: { enabled: true, domain: 'rxddit.com' },
  bluesky: { enabled: true, domain: 'fxbsky.app' },
};

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function deps(overrides = {}) {
  return {
    platforms: PLATFORMS_ON,
    webhooks: {
      get: vi.fn(async () => ({ send: vi.fn(async () => ({ id: 'new-1' })) })),
      invalidate: vi.fn(),
    },
    logger: silentLogger,
    ...overrides,
  };
}

describe('handleMessage', () => {
  it('sends the rewritten message then deletes the original', async () => {
    const order = [];
    const send = vi.fn(async () => { order.push('send'); });
    const message = fakeMessage({
      member: fakeMember(),
      delete: vi.fn(async () => { order.push('delete'); }),
    });
    const d = deps({ webhooks: { get: vi.fn(async () => ({ send })), invalidate: vi.fn() } });

    expect(await handleMessage(message, d)).toBe('replaced');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'https://fxtwitter.com/jack/status/20' }),
    );
    expect(order).toEqual(['send', 'delete']);
  });

  it('does not send or delete when the author cannot embed links', async () => {
    const member = { id: 'member-1', displayName: 'Mike', displayAvatarURL: () => 'https://cdn/a.png' };
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => ({
        has: (flag) => (who === member ? flag !== PermissionFlagsBits.EmbedLinks : true),
      }),
    };
    const message = fakeMessage({ channel, member, delete: vi.fn() });
    const d = deps();
    expect(await handleMessage(message, d)).toBe('author-cannot-embed');
    expect(d.webhooks.get).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('does nothing when no link changes', async () => {
    const message = fakeMessage({ content: 'just talking', member: fakeMember(), delete: vi.fn() });
    const d = deps();
    expect(await handleMessage(message, d)).toBe('unchanged');
    expect(d.webhooks.get).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('returns the ignore reason without calling the API', async () => {
    const message = fakeMessage({ author: { id: 'x', bot: true }, delete: vi.fn() });
    const d = deps();
    expect(await handleMessage(message, d)).toBe('bot');
    expect(d.webhooks.get).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('never deletes the original when the send fails', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const message = fakeMessage({ member: fakeMember(), delete: vi.fn() });
    const d = deps({ webhooks: { get: vi.fn(async () => ({ send })), invalidate: vi.fn() } });

    expect(await handleMessage(message, d)).toBe('send-failed');
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('falls back to a plain reply when the channel is out of webhooks', async () => {
    const error = Object.assign(new Error('max webhooks'), { code: 30007 });
    const reply = vi.fn(async () => {});
    const message = fakeMessage({ member: fakeMember(), reply, delete: vi.fn() });
    const d = deps({ webhooks: { get: vi.fn(async () => { throw error; }), invalidate: vi.fn() } });

    expect(await handleMessage(message, d)).toBe('fallback-reply');
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'https://fxtwitter.com/jack/status/20' }),
    );
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('resolves to send-failed, rather than rejecting, when the fallback reply itself fails', async () => {
    const error = Object.assign(new Error('max webhooks'), { code: 30007 });
    const reply = vi.fn(async () => { throw new Error('reply blocked'); });
    const message = fakeMessage({ member: fakeMember(), reply, delete: vi.fn() });
    const d = deps({ webhooks: { get: vi.fn(async () => { throw error; }), invalidate: vi.fn() } });

    await expect(handleMessage(message, d)).resolves.toBe('send-failed');
    expect(message.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['Unknown Webhook (10015)', 10015],
    ['Invalid Webhook Token (50027)', 50027],
  ])('invalidates and retries once on %s, then sends and deletes', async (_label, code) => {
    // A moderator deleted the webhook from channel settings. The cached
    // promise still resolves to the dead object, so without invalidation the
    // channel is broken for every subsequent message until a restart.
    const dead = { send: vi.fn(async () => { throw Object.assign(new Error('gone'), { code }); }) };
    const order = [];
    const fresh = { send: vi.fn(async () => { order.push('send'); }) };
    const get = vi.fn(async () => (get.mock.calls.length === 1 ? dead : fresh));
    const invalidate = vi.fn();
    const message = fakeMessage({
      member: fakeMember(),
      delete: vi.fn(async () => { order.push('delete'); }),
    });

    expect(await handleMessage(message, deps({ webhooks: { get, invalidate } }))).toBe('replaced');
    expect(invalidate).toHaveBeenCalledWith(message.channel);
    expect(fresh.send).toHaveBeenCalledOnce();
    expect(order).toEqual(['send', 'delete']);
  });

  it('never deletes the original when the retry after invalidation also fails', async () => {
    const stale = () => Object.assign(new Error('gone'), { code: 10015 });
    const send = vi.fn(async () => { throw stale(); });
    const get = vi.fn(async () => ({ send }));
    const invalidate = vi.fn();
    const message = fakeMessage({ member: fakeMember(), delete: vi.fn() });

    expect(await handleMessage(message, deps({ webhooks: { get, invalidate } }))).toBe('send-failed');
    expect(invalidate).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2); // the original attempt and one retry
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('does not retry a send failure that is not a stale webhook', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('rate limited'), { code: 429 }); });
    const get = vi.fn(async () => ({ send }));
    const invalidate = vi.fn();
    const message = fakeMessage({ member: fakeMember(), delete: vi.fn() });

    expect(await handleMessage(message, deps({ webhooks: { get, invalidate } }))).toBe('send-failed');
    expect(invalidate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('reports a replacement even when the delete fails', async () => {
    const message = fakeMessage({
      member: fakeMember(),
      delete: vi.fn(async () => { throw new Error('already gone'); }),
    });
    expect(await handleMessage(message, deps())).toBe('replaced');
  });
});
