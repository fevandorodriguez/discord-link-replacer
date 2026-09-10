import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUndoReaction, UNDO_EMOJI } from '../src/undo.js';
import { createEchoStore } from '../src/echoes.js';

const AUTHOR = 'user-1';
const SOMEONE_ELSE = 'user-2';
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeOriginal(order) {
  return {
    id: 'orig-1',
    suppressEmbeds: vi.fn(async () => { order?.push('restore'); }),
  };
}

function fakeReaction({ emoji = UNDO_EMOJI, messageId = 'echo-1', original, order } = {}) {
  return {
    emoji: { name: emoji },
    users: { remove: vi.fn(async () => {}) },
    message: {
      id: messageId,
      delete: vi.fn(async () => { order?.push('delete'); }),
      channel: { id: 'chan-1', messages: { fetch: vi.fn(async () => original) } },
    },
  };
}

const human = { id: AUTHOR, bot: false };
let echoes;

beforeEach(() => { echoes = createEchoStore(); });

describe('reactions the bot should not act on', () => {
  it('ignores its own reactions', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction();
    expect(await handleUndoReaction(reaction, { id: 'bot-1', bot: true }, { echoes, logger: silentLogger }))
      .toBe('ignored');
    expect(reaction.message.delete).not.toHaveBeenCalled();
  });

  it('ignores any other emoji', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction({ emoji: '⭐' });
    expect(await handleUndoReaction(reaction, human, { echoes, logger: silentLogger })).toBe('ignored');
    expect(reaction.message.delete).not.toHaveBeenCalled();
  });

  // The bot must never police this emoji on messages that are not its own echoes.
  it('ignores a message it has no record of, without touching the reaction', async () => {
    const reaction = fakeReaction({ messageId: 'not-an-echo' });
    expect(await handleUndoReaction(reaction, human, { echoes, logger: silentLogger })).toBe('ignored');
    expect(reaction.users.remove).not.toHaveBeenCalled();
    expect(reaction.message.delete).not.toHaveBeenCalled();
  });
});

describe('someone who is not the original author', () => {
  it('has their reaction removed and deletes nothing', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction();

    expect(await handleUndoReaction(reaction, { id: SOMEONE_ELSE, bot: false }, { echoes, logger: silentLogger }))
      .toBe('refused');
    expect(reaction.users.remove).toHaveBeenCalledWith(SOMEONE_ELSE);
    expect(reaction.message.delete).not.toHaveBeenCalled();
  });

  it('leaves the author still able to undo afterwards', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    await handleUndoReaction(fakeReaction(), { id: SOMEONE_ELSE, bot: false }, { echoes, logger: silentLogger });

    const second = fakeReaction();
    expect(await handleUndoReaction(second, human, { echoes, logger: silentLogger })).toBe('undone');
    expect(second.message.delete).toHaveBeenCalled();
  });
});

describe('the original author', () => {
  it('deletes the echo', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction();
    expect(await handleUndoReaction(reaction, human, { echoes, logger: silentLogger })).toBe('undone');
    expect(reaction.message.delete).toHaveBeenCalled();
  });

  it('does not try to restore anything when there was no original', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction();
    await handleUndoReaction(reaction, human, { echoes, logger: silentLogger });
    expect(reaction.message.channel.messages.fetch).not.toHaveBeenCalled();
  });

  // Restore first, delete second: the reverse order would strip the author's
  // embed and then fail to give the fixed link back.
  it('restores the original embed before deleting the reply', async () => {
    const order = [];
    echoes.record('echo-1', { authorId: AUTHOR, originalId: 'orig-1' });
    const original = fakeOriginal(order);
    const reaction = fakeReaction({ original, order });

    await handleUndoReaction(reaction, human, { echoes, logger: silentLogger });

    expect(original.suppressEmbeds).toHaveBeenCalledWith(false);
    expect(order).toEqual(['restore', 'delete']);
  });

  it('still deletes the reply when restoring the embed fails', async () => {
    echoes.record('echo-1', { authorId: AUTHOR, originalId: 'orig-1' });
    const original = { id: 'orig-1', suppressEmbeds: vi.fn(async () => { throw new Error('gone'); }) };
    const reaction = fakeReaction({ original });

    expect(await handleUndoReaction(reaction, human, { echoes, logger: silentLogger })).toBe('undone');
    expect(reaction.message.delete).toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('reports rather than throws when the delete fails', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction();
    reaction.message.delete = vi.fn(async () => { throw new Error('already gone'); });

    expect(await handleUndoReaction(reaction, human, { echoes, logger: silentLogger })).toBe('delete-failed');
  });

  it('reports rather than throws when removing a stray reaction fails', async () => {
    echoes.record('echo-1', { authorId: AUTHOR });
    const reaction = fakeReaction();
    reaction.users.remove = vi.fn(async () => { throw new Error('no permission'); });

    expect(await handleUndoReaction(reaction, { id: SOMEONE_ELSE, bot: false }, { echoes, logger: silentLogger }))
      .toBe('refused');
  });
});
