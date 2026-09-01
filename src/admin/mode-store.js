import { readFileSync, writeFileSync } from 'node:fs';
import { MODES } from '../config.js';

// Holds the live delivery mode. The bot reads current() per message, so a change
// applies to the next one without a restart.
export function createModeStore({ mode, modeSource, file }) {
  let current = mode;

  return {
    current: () => current,
    source: () => modeSource,
    // LINKFIX_MODE beats config.json, so when the env var supplied the mode a
    // write to the file would be accepted and then ignored. Refuse instead:
    // a control that appears to work and does nothing is worse than one that
    // says why it cannot.
    locked: () => modeSource === 'LINKFIX_MODE',

    set(next) {
      if (modeSource === 'LINKFIX_MODE') {
        throw new Error(
          'Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.',
        );
      }
      if (!MODES.includes(next)) {
        throw new Error(`Invalid mode "${next}"; expected one of ${MODES.join(', ')}.`);
      }

      const raw = JSON.parse(readFileSync(file, 'utf8'));
      raw.mode = next;
      writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
      current = next;
    },
  };
}
