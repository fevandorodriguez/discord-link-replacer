// Generates the value for ADMIN_PASSWORD_HASH. The password is a command
// argument for convenience, not for secrecy: most shells (bash, zsh) record
// it in the history file, and it's visible to anything reading `ps` while
// this process runs. Clear it from history afterward (or use `npm run
// hash-password --` from a shell configured to skip history on a leading
// space) if that matters for your setup.
import { hashPassword } from '../src/admin/auth.js';

const plain = process.argv[2];
if (!plain) {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}
console.log(hashPassword(plain));
