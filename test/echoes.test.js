import { describe, it, expect } from 'vitest';
import { createEchoStore } from '../src/echoes.js';

const AUTHOR = 'user-1';
const SOMEONE_ELSE = 'user-2';

describe('createEchoStore', () => {
  it('reports an id it has never seen as unknown', () => {
    expect(createEchoStore().claim('nope', AUTHOR).verdict).toBe('unknown');
  });

  it('lets the original author claim their own echo', () => {
    const store = createEchoStore();
    store.record('echo-1', { authorId: AUTHOR });
    expect(store.claim('echo-1', AUTHOR).verdict).toBe('ok');
  });

  it('refuses anyone who is not the original author', () => {
    const store = createEchoStore();
    store.record('echo-1', { authorId: AUTHOR });
    expect(store.claim('echo-1', SOMEONE_ELSE).verdict).toBe('not-author');
  });

  // The distinction matters: a refused claim is a stray reaction to remove,
  // an unknown id is a message the bot should not touch at all.
  it('does not consume the entry when someone else is refused', () => {
    const store = createEchoStore();
    store.record('echo-1', { authorId: AUTHOR });
    store.claim('echo-1', SOMEONE_ELSE);
    expect(store.claim('echo-1', AUTHOR).verdict).toBe('ok');
  });

  it('consumes the entry once claimed, so a double reaction cannot double-delete', () => {
    const store = createEchoStore();
    store.record('echo-1', { authorId: AUTHOR });
    store.claim('echo-1', AUTHOR);
    expect(store.claim('echo-1', AUTHOR).verdict).toBe('unknown');
  });

  it('forgets an echo once its window has passed', () => {
    let now = 1000;
    const store = createEchoStore({ ttlMs: 500, clock: () => now });
    store.record('echo-1', { authorId: AUTHOR });
    now = 1600;
    expect(store.claim('echo-1', AUTHOR).verdict).toBe('unknown');
  });

  it('still allows a claim just inside the window', () => {
    let now = 1000;
    const store = createEchoStore({ ttlMs: 500, clock: () => now });
    store.record('echo-1', { authorId: AUTHOR });
    now = 1400;
    expect(store.claim('echo-1', AUTHOR).verdict).toBe('ok');
  });

  // Suppress mode needs the original back to un-suppress its embed; repost
  // mode has no original left, so there is nothing to return.
  it('returns the original message id when one was recorded', () => {
    const store = createEchoStore();
    store.record('echo-1', { authorId: AUTHOR, originalId: 'orig-1' });
    expect(store.claim('echo-1', AUTHOR)).toEqual({ verdict: 'ok', originalId: 'orig-1' });
  });

  it('returns no original id when none was recorded', () => {
    const store = createEchoStore();
    store.record('echo-1', { authorId: AUTHOR });
    expect(store.claim('echo-1', AUTHOR).originalId).toBeUndefined();
  });

  it('drops the oldest entry once it is full', () => {
    const store = createEchoStore({ max: 2 });
    store.record('a', { authorId: AUTHOR });
    store.record('b', { authorId: AUTHOR });
    store.record('c', { authorId: AUTHOR });

    expect(store.claim('a', AUTHOR).verdict).toBe('unknown');
    expect(store.claim('b', AUTHOR).verdict).toBe('ok');
    expect(store.claim('c', AUTHOR).verdict).toBe('ok');
  });

  it('reports how many echoes it is holding', () => {
    const store = createEchoStore();
    expect(store.size()).toBe(0);
    store.record('echo-1', { authorId: AUTHOR });
    expect(store.size()).toBe(1);
  });

  it.each([
    ['a missing id', undefined, { authorId: AUTHOR }],
    ['a non-string id', 42, { authorId: AUTHOR }],
    ['a missing author', 'echo-1', {}],
    ['a non-string author', 'echo-1', { authorId: 99 }],
  ])('refuses to record %s', (_label, echoId, entry) => {
    const store = createEchoStore();
    expect(store.record(echoId, entry)).toBe(false);
    expect(store.size()).toBe(0);
  });
});
