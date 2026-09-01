import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const KEY_LENGTH = 32;

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Returns false rather than throwing on anything malformed: this runs on
// untrusted input from a login form, and a thrown error is a 500 that tells an
// attacker their input was interesting.
export function verifyPassword(plain, stored) {
  // scryptSync throws a TypeError for any non-string/non-buffer password
  // (undefined, null, number, object, array, boolean all throw). A JSON body
  // can hand this function any of those, so it must be screened out here
  // rather than left to reach scryptSync.
  if (typeof plain !== 'string') return false;
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;

  const [saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  // Buffer.from(x, 'hex') never throws on invalid hex; it silently truncates
  // at the first bad byte pair instead. A malformed saltHex/hashHex therefore
  // surfaces here as an unexpected length, not an exception.
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  const actual = scryptSync(plain, salt, KEY_LENGTH);
  // actual and expected are both fixed at KEY_LENGTH here, so this compare is
  // constant-time with no length branch in front of it to leak anything.
  return timingSafeEqual(actual, expected);
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

export function signSession(expiresAt, secret) {
  return `${expiresAt}.${sign(expiresAt, secret)}`;
}

export function verifySession(cookieValue, secret, now = Date.now()) {
  if (typeof cookieValue !== 'string') return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;

  const [expiresAt, signature] = parts;
  if (!/^\d+$/.test(expiresAt) || signature.length === 0) return false;

  const expected = Buffer.from(sign(expiresAt, secret), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  // expected is always a 64-char hex digest (fixed by HMAC-SHA256), so this
  // length check leaks nothing about the secret -- only whether the supplied
  // signature happens to be 64 chars long. It must run before
  // timingSafeEqual, which throws on a length mismatch.
  if (expected.length !== provided.length) return false;
  if (!timingSafeEqual(expected, provided)) return false;

  // The signature covers expiresAt itself, so an attacker who edits the
  // expiry to extend it invalidates the signature and never reaches this
  // check with a live-looking cookie.
  return Number(expiresAt) > now;
}

export function createRateLimiter({ max = 5, windowMs = 900000, clock = Date.now } = {}) {
  // address -> array of failure timestamps inside the window
  const failures = new Map();

  function recent(ip) {
    const cutoff = clock() - windowMs;
    const kept = (failures.get(ip) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) failures.delete(ip);
    else failures.set(ip, kept);
    return kept;
  }

  return {
    // allowed() only counts failures -- it has no notion of "the password
    // they're about to try is correct", so a locked-out IP stays locked out
    // regardless of what password arrives next.
    allowed: (ip) => recent(ip).length < max,
    fail(ip) {
      const kept = recent(ip);
      kept.push(clock());
      failures.set(ip, kept);
    },
    reset: (ip) => { failures.delete(ip); },
  };
}
