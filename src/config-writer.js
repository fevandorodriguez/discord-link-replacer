import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chmodSync } from 'node:fs';

// Mutates one config file in place, atomically. Two stores write to this file
// now — the delivery mode and the restart announcement — and duplicating this
// sequence would duplicate a logic block that took two review rounds to get
// right: the root guard and the permission copy were both real defects.
//
// `rejectCode` tags the root-type refusal so each caller keeps its own error
// vocabulary; mode-store's rejections are already documented as MODE_REJECTED.
export function updateConfig(file, mutate, { rejectCode }) {
  // Parse and I/O errors propagate untagged: they are genuine faults, not the
  // caller's deliberate refusals, and the admin API maps the two differently.
  const raw = JSON.parse(readFileSync(file, 'utf8'));

  // A non-object root silently swallows property assignment — set() would
  // report success and write nothing, which is the exact failure the stores
  // exist to prevent.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const rootType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    const error = new Error(`Config root in ${file} must be a JSON object, got ${rootType}.`);
    error.code = rejectCode;
    throw error;
  }

  mutate(raw);

  // Write to a temp file beside the target, then rename: a PROCESS crash
  // mid-write leaves the half-written bytes in the temp file, so the config
  // the bot boots from is either the old one or the new one, never a
  // truncated one. The temp file has to sit in the same directory, because
  // rename is only atomic within a filesystem and the config directory is
  // bind-mounted.
  //
  // That is the whole guarantee. There is no fsync on the temp file or on the
  // directory, so a host power loss or kernel panic can land the rename
  // before the data and leave an empty or short config behind. Deliberate:
  // this is a small file on a single box, the same pattern the mode store has
  // always used, and the operator can retype a quip. Do not read the rename
  // as durability.
  const tempFile = `${file}.tmp`;
  try {
    writeFileSync(tempFile, `${JSON.stringify(raw, null, 2)}\n`);
    try {
      // rename installs the temp file's inode, so without this an operator's
      // tightened permissions are silently reset to the default umask.
      const stat = statSync(file);
      chmodSync(tempFile, stat.mode);
    } catch (e) {
      // A first-ever write has no target to inherit from. Anything else —
      // a permissions error mid-stat, say — is a real failure.
      if (e.code !== 'ENOENT') throw e;
    }
    renameSync(tempFile, file);
  } catch (e) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Nothing to clean up.
    }
    throw e;
  }
}
