import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

// AES-256-GCM at rest for integration secrets. Key derived once from APP_SECRET.
const key = scryptSync(env.APP_SECRET, 'zeus-integration-secrets', 32);
// A separate salt for backup files — same root secret, a different derived key, so
// the two purposes stay independent even though both trace back to one APP_SECRET.
const backupKey = scryptSync(env.APP_SECRET, 'zeus-backups', 32);

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptJson<T = Record<string, string>>(blob: string | null | undefined): T | null {
  if (!blob) return null;
  const [ivB64, tagB64, bodyB64] = blob.split('.');
  if (!ivB64 || !tagB64 || !bodyB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]);
    return JSON.parse(out.toString('utf8')) as T;
  } catch {
    // Wrong APP_SECRET or tampered blob — treat as "not configured" rather than crashing.
    return null;
  }
}

/**
 * The same AES-256-GCM, but for a backup file's raw bytes rather than a JSON blob —
 * base64 would inflate a multi-MB dump by a third for no reason. Layout on disk is
 * simply iv(12) + tag(16) + ciphertext, one buffer, no text encoding.
 */
export function encryptBuffer(data: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', backupKey, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const body = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', backupKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
