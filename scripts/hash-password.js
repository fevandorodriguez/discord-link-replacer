// Generates the value for ADMIN_PASSWORD_HASH. Takes the password as an
// argument so it never has to be pasted into a running shell's history twice.
import { hashPassword } from '../src/admin/auth.js';

const plain = process.argv[2];
if (!plain) {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}
console.log(hashPassword(plain));
