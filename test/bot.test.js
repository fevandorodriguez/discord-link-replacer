import { describe, it, expect, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { ignoreReason, handleMessage } from '../src/bot.js';

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

const PLATFORMS_ON = {
  twitter: { enabled: true, domain: 'fxtwitter.com' },
  instagram: { enabled: true, domain: 'oginstagram.com' },
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
});
