import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Thirty lines of HMAC rather than a dependency: the algorithm is a counter, a hash and a
 * truncation, and it has not changed since 2011. Everything here matches what Google
 * Authenticator, 1Password and Authy already do — SHA-1, six digits, a thirty-second step.
 * Those parameters are not a security choice we get to make; they are what the apps
 * on the user's phone implement.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * How many steps either side of now to accept.
 *
 * One step, so a code stays usable for up to ninety seconds. Phone clocks drift and people
 * type slowly; refusing a code that was correct four seconds ago teaches them to distrust
 * the whole mechanism. Widening this further would start to matter — each extra step
 * doubles the window an intercepted code stays good for.
 */
const DRIFT_STEPS = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 without padding — the encoding every authenticator app expects. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, the size RFC 4226 recommends for SHA-1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one particular time step. */
function codeForCounter(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(counter));

  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  // Dynamic truncation: the low nibble of the last byte picks where to read from.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code right now. Exported so tests and the enrolment check can agree on it. */
export function currentCode(secret: string, at = Date.now()): string {
  return codeForCounter(secret, Math.floor(at / 1000 / STEP_SECONDS));
}

/**
 * Is this the right code?
 *
 * Compared with `timingSafeEqual` across every accepted step — a plain `===` on a
 * six-digit string leaks, through response time, how many leading digits were right.
 */
export function verifyCode(secret: string, submitted: string, at = Date.now()): boolean {
  const clean = submitted.replace(/\D/g, '');
  if (clean.length !== DIGITS) return false;

  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  const given = Buffer.from(clean);

  let matched = false;
  for (let step = -DRIFT_STEPS; step <= DRIFT_STEPS; step += 1) {
    const expected = Buffer.from(codeForCounter(secret, counter + step));
    // Deliberately no early exit: every candidate is compared, so the time taken says
    // nothing about which step matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched;
}

/**
 * The URI an authenticator app reads from a QR code.
 *
 * The label carries the account so a phone with several entries shows which is which,
 * and the issuer is what the app groups them under.
 */
export function otpauthUri(secret: string, account: string, issuer = 'Zeus'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes, in the format people actually retype: groups of four, no ambiguous
 * characters. Nobody reading one off a printout should have to decide between 0 and O.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(10);
    let body = '';
    for (const byte of bytes) body += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    codes.push(`${body.slice(0, 5)}-${body.slice(5)}`);
  }
  return codes;
}

/** Normalised for comparison: case and dashes are how people mistype, not how they differ. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
