import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, signSession, verifySession, createRateLimiter,
} from '../../src/admin/auth.js';

describe('password hashing', () => {
  it('accepts the right password', () => {
    const stored = hashPassword('correct horse');
    expect(verifyPassword('correct horse', stored)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('correct horse');
    expect(verifyPassword('wrong horse', stored)).toBe(false);
  });

  it('never stores the plaintext', () => {
    expect(hashPassword('hunter2')).not.toContain('hunter2');
  });

  it('salts, so the same password hashes differently each time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it.each(['', 'nosalt', 'a:b:c', 'zz:zz'])('returns false for malformed stored value %s', (stored) => {
    expect(verifyPassword('anything', stored)).toBe(false);
  });

  it.each([undefined, null, 123, {}, [], true])('returns false rather than throwing when the password argument is not a string (%s)', (plain) => {
    const stored = hashPassword('correct horse');
    expect(() => verifyPassword(plain, stored)).not.toThrow();
    expect(verifyPassword(plain, stored)).toBe(false);
  });
});

describe('session cookies', () => {
  const secret = 'test-secret';

  it('verifies a cookie it just signed', () => {
    const cookie = signSession(Date.now() + 60000, secret);
    expect(verifySession(cookie, secret)).toBe(true);
  });

  it('rejects an expired cookie', () => {
    const cookie = signSession(Date.now() - 1, secret);
    expect(verifySession(cookie, secret)).toBe(false);
  });

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signSession(Date.now() + 60000, 'other-secret');
    expect(verifySession(cookie, secret)).toBe(false);
  });

  it('rejects a cookie whose expiry was edited to extend it', () => {
    const cookie = signSession(Date.now() - 1, secret);
    const [, signature] = cookie.split('.');
    expect(verifySession(`${Date.now() + 60000}.${signature}`, secret)).toBe(false);
  });

  it.each(['', 'garbage', 'no-dot', '123.', '.abc'])('rejects malformed cookie %s', (cookie) => {
    expect(verifySession(cookie, secret)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('allows attempts below the limit', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(true);
  });

  it('refuses once the limit is reached', () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(false);
  });

  it('refuses a correct password too, once locked out', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(false);
  });

  it('tracks each address separately', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('2.2.2.2')).toBe(true);
  });

  it('forgets failures once the window passes', () => {
    let now = 1000;
    const limiter = createRateLimiter({ max: 1, windowMs: 500, clock: () => now });
    limiter.fail('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(false);
    now = 1600;
    expect(limiter.allowed('1.1.1.1')).toBe(true);
  });

  it('clears an address on a successful login', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    limiter.fail('1.1.1.1');
    limiter.reset('1.1.1.1');
    expect(limiter.allowed('1.1.1.1')).toBe(true);
  });
});
