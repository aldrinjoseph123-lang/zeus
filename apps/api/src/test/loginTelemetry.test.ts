import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestDatabase, prisma, resetDatabase } from './harness.js';
import { recordLogin, deviceFromUA } from '../services/loginTelemetry.js';

/**
 * Login telemetry writes an auth entry with the IP. A private/loopback address is
 * never sent to the external lookup — nothing to learn, and no third party is told.
 */

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); });

async function waitFor<T>(fn: () => Promise<T | null>, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((s) => setTimeout(s, 50));
  }
  return null;
}

describe('login telemetry', () => {
  it('parses a device label from the User-Agent', () => {
    assert.equal(deviceFromUA('Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit Chrome/120 Safari/537'), 'Chrome on Windows');
    assert.equal(deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Safari/604'), 'Safari on iPhone');
    assert.equal(deviceFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/121'), 'Firefox on macOS');
    assert.equal(deviceFromUA(undefined), 'Unknown device');
  });

  it('records the login IP + device and skips lookup for a private address', async () => {
    recordLogin({ id: 'u1', name: 'Tester' }, '192.168.1.50', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537');
    const row = await waitFor(() => prisma.systemLog.findFirst({ where: { source: 'auth', message: { contains: 'Tester signed in' } } }));
    assert.ok(row, 'an auth login entry should be written');
    assert.match(row!.message, /192\.168\.1\.50/);
    assert.match(row!.message, /Chrome on Windows/);
    const ctx = row!.context as { isp: unknown; device: unknown } | null;
    assert.equal(ctx?.isp, null, 'no ISP looked up for a private IP');
    assert.equal(ctx?.device, 'Chrome on Windows');
  });
});
