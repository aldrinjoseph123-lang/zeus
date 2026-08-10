import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import {
  generateRecoveryCodes, generateSecret, normalizeRecoveryCode, otpauthUri, verifyCode,
} from '../lib/totp.js';

/**
 * Two-factor sign-in.
 *
 * The failure mode that matters here is not an attacker getting in — it is the owner
 * getting locked out of their own CRM because a phone was replaced. So recovery codes are
 * not optional and are shown once, at enrolment, before the second factor is armed.
 *
 * Enrolment is deliberately two steps. The secret is stored but *not* enforced until the
 * user has proved they can generate a code from it; anything else lets someone lock
 * themselves out by scanning a QR badly and navigating away.
 */

/** How long a half-finished sign-in stays valid, in milliseconds. */
const CHALLENGE_TTL = 5 * 60 * 1000;

/**
 * Sign-ins waiting on a second factor.
 *
 * In memory on purpose: a challenge is worthless after five minutes and after a restart,
 * and putting it in the database would mean a table of half-authenticated sessions to
 * expire and audit. A restart mid-sign-in costs one retry.
 *
 * ponytail: single-process map. Zeus runs one API process; behind two, move this to the
 * database or a shared cache, or a challenge issued by one will be unknown to the other.
 */
const challenges = new Map<string, { userId: string; expiresAt: number }>();

function sweepChallenges(): void {
  const now = Date.now();
  for (const [id, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(id);
}

export function openChallenge(userId: string): string {
  sweepChallenges();
  const id = randomUUID();
  challenges.set(id, { userId, expiresAt: Date.now() + CHALLENGE_TTL });
  return id;
}

export function readChallenge(id: string): string | null {
  sweepChallenges();
  return challenges.get(id)?.userId ?? null;
}

export function closeChallenge(id: string): void {
  challenges.delete(id);
}

/** The stored secret, decrypted. Null when the user has not enrolled. */
async function secretFor(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecret: true } });
  const stored = decryptJson<{ secret: string }>(user?.totpSecret);
  return stored?.secret ?? null;
}

export interface Enrolment {
  secret: string;
  otpauth: string;
  recoveryCodes: string[];
}

/**
 * Begin enrolment: mint a secret and a set of recovery codes, and hand both back once.
 *
 * Nothing is enforced yet. `totpEnabledAt` stays null until `confirmEnrolment` sees a
 * working code, so abandoning this halfway leaves the account exactly as it was.
 */
export async function beginEnrolment(userId: string, email: string): Promise<Enrolment> {
  const secret = generateSecret();
  const recoveryCodes = generateRecoveryCodes();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encryptJson({ secret }), totpEnabledAt: null },
    }),
    // Any codes from an abandoned attempt are void — two live sets would mean the older,
    // possibly written-down one still opens the account.
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: recoveryCodes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    }),
  ]);

  return { secret, otpauth: otpauthUri(secret, email), recoveryCodes };
}

/** Arm it, once the user has proved the authenticator works. */
export async function confirmEnrolment(userId: string, code: string): Promise<boolean> {
  const secret = await secretFor(userId);
  if (!secret || !verifyCode(secret, code)) return false;
  await prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } });
  return true;
}

/** Turn it off, and take the recovery codes with it. */
export async function disable(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null } }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
  ]);
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export type SecondFactor = 'totp' | 'recovery' | null;

/**
 * Check a second factor, from either source.
 *
 * A recovery code is spent the moment it works. Comparison is constant-time and every
 * stored code is checked, so neither the response time nor an early exit says which one
 * matched — or how many are left.
 */
export async function verifySecondFactor(userId: string, submitted: string): Promise<SecondFactor> {
  const secret = await secretFor(userId);
  if (secret && verifyCode(secret, submitted)) return 'totp';

  const wanted = Buffer.from(hashRecoveryCode(submitted));
  const codes = await prisma.recoveryCode.findMany({ where: { userId, usedAt: null } });

  let hit: string | null = null;
  for (const stored of codes) {
    const candidate = Buffer.from(stored.codeHash);
    if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) hit = stored.id;
  }
  if (!hit) return null;

  await prisma.recoveryCode.update({ where: { id: hit }, data: { usedAt: new Date() } });
  return 'recovery';
}

export async function status(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const [user, recoveryCodesLeft] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } }),
    prisma.recoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  return { enabled: Boolean(user?.totpEnabledAt), recoveryCodesLeft };
}
