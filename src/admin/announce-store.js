import { updateConfig } from '../config-writer.js';
import { validateAnnounce } from '../config.js';

function reject(message) {
  const error = new Error(message);
  error.code = 'ANNOUNCE_REJECTED';
  return error;
}

// Holds the restart channel and quips, and writes changes back to config.json
// so they survive the restart they exist to announce.
//
// Validation is delegated to validateAnnounce -- the same rules loadConfig
// enforces at boot -- so a save accepted here can never write a config that
// the next restart's loader would refuse to read.
export function createAnnounceStore({ channelId, quips, file }) {
  // Copied on the way in, same as current() copies on the way out: without
  // this a caller that mutates its own array after construction or set()
  // would silently change the store's live state.
  let current = { channelId, quips: [...quips] };

  return {
    current: () => ({ channelId: current.channelId, quips: [...current.quips] }),

    set(input) {
      // Guard before destructuring: `set(null)` (or no argument at all, i.e.
      // `set(undefined)`) would otherwise throw a raw TypeError out of the
      // parameter destructuring itself, before validateAnnounce -- or even
      // this function's own body -- gets a look. That breaks the store's
      // stated contract ("throws with error.code = 'ANNOUNCE_REJECTED' on
      // any invalid input"): unreachable from today's only caller, but a
      // contract that is nearly true is one a future caller will trust and
      // be wrong about.
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw reject(`Invalid announce settings: expected an object with channelId and quips, got ${JSON.stringify(input)}.`);
      }
      const { channelId: nextChannel, quips: nextQuips } = input;

      // Validated before the file is touched -- a rejected request must
      // never leave a half-written config behind.
      const problem = validateAnnounce({ channelId: nextChannel, quips: nextQuips });
      if (problem) throw reject(problem);

      updateConfig(file, (raw) => {
        raw.announce = { channelId: nextChannel, quips: [...nextQuips] };
      }, { rejectCode: 'ANNOUNCE_REJECTED' });

      current = { channelId: nextChannel, quips: [...nextQuips] };
    },
  };
}
