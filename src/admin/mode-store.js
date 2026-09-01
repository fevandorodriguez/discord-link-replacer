import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chmodSync } from 'node:fs';
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
        const error = new Error(
          'Mode is fixed by LINKFIX_MODE in the environment; unset it to control the mode from here.',
        );
        error.code = 'MODE_REJECTED';
        throw error;
      }
      if (!MODES.includes(next)) {
        const error = new Error(`Invalid mode "${next}"; expected one of ${MODES.join(', ')}.`);
        error.code = 'MODE_REJECTED';
        throw error;
      }

      let raw;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        // Let I/O and parse errors propagate untagged
        throw e;
      }

      // Config root must be a plain object, not array, null, or primitive.
      // Setting a property on a non-object makes set() silently diverge from
      // the file, reproducing the exact failure this module exists to prevent.
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        const rootType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
        const error = new Error(
          `Config root in ${file} must be a JSON object, got ${rootType}.`,
        );
        error.code = 'MODE_REJECTED';
        throw error;
      }

      raw.mode = next;

      // Atomic write: write to temp file, then rename. Protects against
      // corruption if the process crashes mid-write.
      // Preserve the target's file mode if it exists; a first-ever write
      // lands under the default umask, which is the intended behavior.
      const tempFile = `${file}.tmp`;
      try {
        writeFileSync(tempFile, `${JSON.stringify(raw, null, 2)}\n`);
        // Stat the target to preserve its mode. If the target doesn't exist,
        // stat throws and we skip the chmod (first-ever write uses default umask).
        try {
          const stat = statSync(file);
          chmodSync(tempFile, stat.mode);
        } catch {
          // Target doesn't exist yet; temp file uses default umask
        }
        renameSync(tempFile, file);
      } catch (e) {
        // Clean up temp file if anything failed
        try {
          unlinkSync(tempFile);
        } catch {
          // Ignore cleanup errors
        }
        throw e;
      }

      current = next;
    },
  };
}
