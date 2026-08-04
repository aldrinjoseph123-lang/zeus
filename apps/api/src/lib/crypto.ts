import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

// AES-256-GCM at rest for integration secrets. Key derived once from APP_SECRET.
const key = scryptSync(env.APP_SECRET, 'zeus-integration-secrets', 32);

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
