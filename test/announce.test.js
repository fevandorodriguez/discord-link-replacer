import { describe, it, expect, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { announce } from '../src/announce.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const QUIPS = ['first', 'second', 'third'];

function fakeClient({ channel, fetchThrows = false } = {}) {
  return {
    user: { id: 'bot-1' },
    channels: {
      fetch: vi.fn(async () => {
        if (fetchThrows) throw new Error('Unknown Channel');
        return channel;
      }),
    },
  };
}

function fakeChannel({ canSend = true, sendThrows = false } = {}) {
  return {
    id: 'chan-1',
    isTextBased: () => true,
    permissionsFor: () => ({ has: (flag) => (flag === PermissionFlagsBits.SendMessages ? canSend : true) }),
    send: vi.fn(async () => {
      if (sendThrows) throw new Error('rejected');
      return { id: 'msg-1' };
    }),
  };
}

describe('announce', () => {
  it('says nothing when no channel is configured', async () => {
    const client = fakeClient();
    expect(await announce('', QUIPS, { client, logger: silentLogger })).toBe('no-channel');
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it('says nothing when there are no quips', async () => {
    const client = fakeClient({ channel: fakeChannel() });
    expect(await announce('chan-1', [], { client, logger: silentLogger })).toBe('no-quips');
  });

  it('posts a quip', async () => {
    const channel = fakeChannel();
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger, pick: () => 1 }))
      .toBe('sent');
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'second' }));
  });

  // Quips are free text set through a password-gated web page. Without this a
  // quip containing @everyone would ping the whole server on every restart.
  it('posts with mentions suppressed', async () => {
    const channel = fakeChannel();
    await announce('chan-1', ['@everyone hello'], { client: fakeClient({ channel }), logger: silentLogger });
    expect(channel.send).toHaveBeenCalledWith({
      content: '@everyone hello',
      allowedMentions: { parse: [] },
    });
  });

  it('only ever picks a quip from the list', async () => {
    const channel = fakeChannel();
    for (let i = 0; i < 50; i++) {
      await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger });
    }
    for (const call of channel.send.mock.calls) {
      expect(QUIPS).toContain(call[0].content);
    }
  });

  it('reports a channel it cannot find', async () => {
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ fetchThrows: true }), logger: silentLogger }))
      .toBe('channel-missing');
  });

  it('reports a channel that resolves to nothing', async () => {
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel: null }), logger: silentLogger }))
      .toBe('channel-missing');
  });

  it('reports a channel it cannot post in', async () => {
    const channel = fakeChannel({ canSend: false });
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger }))
      .toBe('not-postable');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('reports a rejected send', async () => {
    const channel = fakeChannel({ sendThrows: true });
    expect(await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger }))
      .toBe('failed');
  });

  it('never throws, whatever the client does', async () => {
    const client = { user: { id: 'bot-1' }, channels: { fetch: () => { throw new Error('boom'); } } };
    await expect(announce('chan-1', QUIPS, { client, logger: silentLogger })).resolves.toBe('channel-missing');
  });

  it('clamps a negative pick index to first quip', async () => {
    const channel = fakeChannel();
    await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger, pick: () => -5 });
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'first' }));
  });

  it('clamps a past-the-end pick index to last quip', async () => {
    const channel = fakeChannel();
    await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger, pick: () => 10 });
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'third' }));
  });

  it('floors a fractional pick index then clamps', async () => {
    const channel = fakeChannel();
    await announce('chan-1', QUIPS, { client: fakeClient({ channel }), logger: silentLogger, pick: () => 1.9 });
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'second' }));
  });
});
