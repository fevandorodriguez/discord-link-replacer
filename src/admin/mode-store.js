import { updateConfig } from '../config-writer.js';
import { MODES } from '../config.js';

// Describes a rejected `next` value for the error message below without
// itself being able to throw. next is attacker-controlled (the request
// body's JSON-decoded "mode" field), so a plain template literal
// (`${next}`) is not safe here -- it coerces via ToString, which for an
// object runs valueOf/toString and can throw (e.g. {"mode":{"toString":1}}
// throws "Cannot convert object to primitive value" from inside the
// template literal itself, well before MODES.includes ever gets a look).
// JSON.stringify never invokes those hooks, and a value that came from
// JSON.parse can't contain anything (BigInt, a cycle) that would make
// JSON.stringify itself throw -- but the try/catch is kept anyway so this
// helper stays safe even if a future caller passes something JSON.parse
// never would.
function describeMode(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return `a ${typeof value}`;
  }
}

// Holds the live delivery mode. The bot reads current() per message, so a change
// applies to the next one without a restart.
export function createModeStore({ mode, modeSource, file }) {
  let current = mode;
  let source = modeSource;

  return {
    current: () => current,
    source: () => source,
    // LINKFIX_MODE beats config.json, so when the env var supplied the mode a
    // write to the file would be accepted and then ignored. Refuse instead:
    // a control that appears to work and does nothing is worse than one that
    // says why it cannot.
    locked: () => modeSource === 'LINKFIX_MODE',

    set(next) {
      if (modeSource === 'LINKFIX_MODE') {
        const error = new Error(
          'Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.',
        );
        error.code = 'MODE_REJECTED';
        throw error;
      }
      // typeof-guard first: `next` is attacker-controlled JSON, and
      // MODES.includes(next) alone is a safe check, but the message built
      // right below it is not -- see describeMode above. Checking typeof
      // here means the string case (the overwhelming majority of real
      // requests: a typo'd mode name) never touches describeMode at all.
      if (typeof next !== 'string' || !MODES.includes(next)) {
        const error = new Error(`Invalid mode ${describeMode(next)}; expected one of ${MODES.join(', ')}.`);
        error.code = 'MODE_REJECTED';
        throw error;
      }

      updateConfig(file, (raw) => { raw.mode = next; }, { rejectCode: 'MODE_REJECTED' });

      current = next;
      // The file write just succeeded, so the mode this store now holds
      // really did come from config.json -- reporting the boot-time source
      // forever would tell the panel "default" or "LINKFIX_MODE" even after
      // a write the panel itself just made.
      source = 'config.json';
    },
  };
}
