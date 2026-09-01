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
    expect(ignoreReason(fakeMessage(), BOT_ID, 'repost')).toBeNull();
  });

  it('ignores messages from bots', () => {
    expect(ignoreReason(fakeMessage({ author: { id: 'x', bot: true } }), BOT_ID, 'repost')).toBe('bot');
  });

  it('ignores messages sent by a webhook', () => {
    expect(ignoreReason(fakeMessage({ webhookId: 'hook-1' }), BOT_ID, 'repost')).toBe('webhook');
  });

  it('ignores direct messages', () => {
    expect(ignoreReason(fakeMessage({ guild: null }), BOT_ID, 'repost')).toBe('not-a-guild');
  });

  it('ignores system messages', () => {
    expect(ignoreReason(fakeMessage({ system: true }), BOT_ID, 'repost')).toBe('system');
  });

  it('ignores messages with attachments, which a webhook cannot reproduce', () => {
    expect(ignoreReason(fakeMessage({ attachments: { size: 1 } }), BOT_ID, 'repost')).toBe('has-attachments');
  });

  it('ignores messages with stickers', () => {
    expect(ignoreReason(fakeMessage({ stickers: { size: 1 } }), BOT_ID, 'repost')).toBe('has-stickers');
  });

  it('ignores messages carrying a poll', () => {
    expect(ignoreReason(fakeMessage({ poll: { question: { text: 'which' } } }), BOT_ID, 'repost')).toBe('has-poll');
  });

  it('ignores forwarded messages', () => {
    expect(ignoreReason(fakeMessage({ reference: { type: 1 } }), BOT_ID, 'repost')).toBe('forwarded');
  });

  it('allows a plain reply, which is not a forward', () => {
    expect(ignoreReason(fakeMessage({ reference: { type: 0, messageId: 'msg-0' } }), BOT_ID, 'repost')).toBeNull();
  });

  it('ignores channels where the bot lacks permissions', () => {
    const channel = { id: 'chan-1', permissionsFor: () => ({ has: () => false }) };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'repost')).toBe('missing-permissions');
  });

  it('ignores a channel it cannot resolve permissions for', () => {
    const channel = { id: 'chan-1', permissionsFor: () => null };
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'repost')).toBe('missing-permissions');
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
    expect(ignoreReason(fakeMessage({ channel, member }), BOT_ID, 'repost')).toBe('author-cannot-embed');
  });

  it('allows a message whose author has Embed Links', () => {
    const member = { id: 'member-1' };
    const channel = { id: 'chan-1', permissionsFor: () => ({ has: () => true }) };
    expect(ignoreReason(fakeMessage({ channel, member }), BOT_ID, 'repost')).toBeNull();
  });

  it('falls back to the author when there is no member, and fails closed if unresolvable', () => {
    const channel = {
      id: 'chan-1',
      permissionsFor: (who) => (who === BOT_ID ? { has: () => true } : null),
    };
    expect(ignoreReason(fakeMessage({ channel, member: null }), BOT_ID, 'repost')).toBe('author-cannot-embed');
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
    expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'repost')).toBe('missing-permissions');
  });

  describe('ignoreReason — mode-dependent guards', () => {
    it.each([
      ['attachments', { attachments: { size: 1 } }, 'has-attachments'],
      ['stickers', { stickers: { size: 1 } }, 'has-stickers'],
      ['a poll', { poll: { question: { text: 'which' } } }, 'has-poll'],
      ['a forward', { reference: { type: 1 } }, 'forwarded'],
    ])('still skips %s in repost mode', (_label, override, expected) => {
      expect(ignoreReason(fakeMessage(override), BOT_ID, 'repost')).toBe(expected);
    });

    it.each([
      ['attachments', { attachments: { size: 1 } }],
      ['stickers', { stickers: { size: 1 } }],
      ['a poll', { poll: { question: { text: 'which' } } }],
      ['a forward', { reference: { type: 1 } }],
    ])('handles %s in suppress mode, which destroys nothing', (_label, override) => {
      expect(ignoreReason(fakeMessage(override), BOT_ID, 'suppress')).toBeNull();
    });

    it('requires Manage Webhooks in repost mode', () => {
      const channel = {
        id: 'chan-1',
        permissionsFor: (who) => ({
          has: (flag) => !(who === BOT_ID && flag === PermissionFlagsBits.ManageWebhooks),
        }),
      };
      expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'repost')).toBe('missing-permissions');
    });

    it('does not require Manage Webhooks in suppress mode', () => {
      const channel = {
        id: 'chan-1',
        permissionsFor: (who) => ({
          has: (flag) => !(who === BOT_ID && flag === PermissionFlagsBits.ManageWebhooks),
        }),
      };
      expect(ignoreReason(fakeMessage({ channel }), BOT_ID, 'suppress')).toBeNull();
    });

    it.each(['repost', 'suppress'])('still skips a bot author in %s mode', (mode) => {
      expect(ignoreReason(fakeMessage({ author: { id: 'x', bot: true } }), BOT_ID, mode)).toBe('bot');
    });

    it.each(['repost', 'suppress'])('still skips an author denied Embed Links in %s mode', (mode) => {
      const channel = {
        id: 'chan-1',
        permissionsFor: (who) => (who === BOT_ID
          ? { has: () => true }
          : { has: (flag) => flag !== PermissionFlagsBits.EmbedLinks }),
      };
      expect(ignoreReason(fakeMessage({ channel, member: { id: 'user-1' } }), BOT_ID, mode))
        .toBe('author-cannot-embed');
    });

    it('defaults an unrecognised mode to the guarded path', () => {
      // An unknown mode value should fail safe toward repost's stricter guards,
      // not toward suppress's permissive behavior.
      expect(ignoreReason(fakeMessage({ attachments: { size: 1 } }), BOT_ID, 'nonsense')).toBe('has-attachments');
    });
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

describe('handleMessage — mode dispatch', () => {
  const PLATFORMS_ON = {
    twitter: { enabled: true, domain: 'fxtwitter.com' },
    instagram: { enabled: true, domain: 'oginstagram.com' },
    tiktok: { enabled: true, domain: 'vxtiktok.com' },
    reddit: { enabled: true, domain: 'rxddit.com' },
    bluesky: { enabled: true, domain: 'fxbsky.app' },
  };
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

  it('suppresses and replies in suppress mode, deleting nothing', async () => {
    const message = fakeMessage({
      member: { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/a.png' },
      reply: vi.fn(async () => {}),
      suppressEmbeds: vi.fn(async () => {}),
      delete: vi.fn(),
    });
    const webhooks = { get: vi.fn() };

    expect(await handleMessage(message, {
      mode: 'suppress', platforms: PLATFORMS_ON, webhooks, logger: silentLogger,
    })).toBe('suppressed');
    expect(message.suppressEmbeds).toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
    expect(webhooks.get).not.toHaveBeenCalled();
  });

  it('reposts through a webhook in repost mode, suppressing nothing', async () => {
    const send = vi.fn(async () => {});
    const message = fakeMessage({
      member: { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/a.png' },
      suppressEmbeds: vi.fn(),
      delete: vi.fn(async () => {}),
    });

    expect(await handleMessage(message, {
      mode: 'repost',
      platforms: PLATFORMS_ON,
      webhooks: { get: vi.fn(async () => ({ send })) },
      logger: silentLogger,
    })).toBe('replaced');
    expect(message.delete).toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  it('returns unchanged in either mode when no link matches', async () => {
    const message = fakeMessage({ content: 'just talking', reply: vi.fn(), delete: vi.fn() });
    expect(await handleMessage(message, {
      mode: 'suppress', platforms: PLATFORMS_ON, webhooks: { get: vi.fn() }, logger: silentLogger,
    })).toBe('unchanged');
    expect(message.reply).not.toHaveBeenCalled();
  });

  // ignoreReason's guards and the deliver dispatch both branch on the mode
  // string independently. If they ever disagreed, an unrecognised mode could
  // pair suppress's permissive guards with repost's irreversible delete — the
  // one combination that can destroy a user's attachment. This pins that they
  // agree: an unrecognised mode gets repost's guards *and* repost's delivery.
  it('takes the repost path end to end for an unrecognised mode', async () => {
    const send = vi.fn(async () => {});
    const message = fakeMessage({
      member: { displayName: 'Mike', displayAvatarURL: () => 'https://cdn/a.png' },
      suppressEmbeds: vi.fn(),
      delete: vi.fn(async () => {}),
    });

    expect(await handleMessage(message, {
      mode: 'nonsense',
      platforms: PLATFORMS_ON,
      webhooks: { get: vi.fn(async () => ({ send })) },
      logger: silentLogger,
    })).toBe('replaced');
    expect(send).toHaveBeenCalled();
    expect(message.delete).toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });

  it('still guards an unrecognised mode against destroying an attachment', async () => {
    const webhooks = { get: vi.fn() };
    const message = fakeMessage({
      attachments: { size: 1 },
      suppressEmbeds: vi.fn(),
      delete: vi.fn(),
    });

    expect(await handleMessage(message, {
      mode: 'nonsense', platforms: PLATFORMS_ON, webhooks, logger: silentLogger,
    })).toBe('has-attachments');
    expect(webhooks.get).not.toHaveBeenCalled();
    expect(message.delete).not.toHaveBeenCalled();
    expect(message.suppressEmbeds).not.toHaveBeenCalled();
  });
});
