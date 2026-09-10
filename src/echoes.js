const HOUR_MS = 60 * 60 * 1000;

// Remembers which echo the bot posted on whose behalf, so the original author —
// and only they — can take it back with a reaction.
//
// In memory, like everything else here: a restart forgets every pending undo,
// which is why the window is an hour rather than forever. Nothing about a
// message's content is kept, only two ids and a timestamp.
export function createEchoStore({ ttlMs = HOUR_MS, max = 500, clock = Date.now } = {}) {
  // Insertion-ordered, so the first key is always the oldest entry — that is
  // what makes eviction a single delete rather than a scan.
  const echoes = new Map();

  return {
    record(echoId, { authorId, originalId } = {}) {
      // Both ids come from Discord and are always strings, but this store is
      // what decides who may delete a message, so it verifies rather than
      // assumes. A malformed record is dropped, never stored half-formed.
      if (typeof echoId !== 'string' || echoId.length === 0) return false;
      if (typeof authorId !== 'string' || authorId.length === 0) return false;

      echoes.set(echoId, { authorId, originalId, at: clock() });
      if (echoes.size > max) echoes.delete(echoes.keys().next().value);
      return true;
    },

    // Three outcomes rather than a boolean, because "you are not the author"
    // and "this is not an echo" need different handling: the first is a stray
    // reaction worth removing, the second is a message the bot must not touch.
    claim(echoId, userId) {
      const entry = echoes.get(echoId);
      if (!entry) return { verdict: 'unknown' };

      if (clock() - entry.at > ttlMs) {
        echoes.delete(echoId);
        return { verdict: 'unknown' };
      }

      // Refusing must not consume the entry, or anyone could burn the author's
      // chance to undo simply by reacting first.
      if (entry.authorId !== userId) return { verdict: 'not-author' };

      // Consumed on success, so a double reaction cannot delete twice.
      echoes.delete(echoId);
      return { verdict: 'ok', originalId: entry.originalId };
    },

    size: () => echoes.size,
  };
}
