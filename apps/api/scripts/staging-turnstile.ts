import { prisma } from '../src/db.js';
import { saveTurnstile } from '../src/portal/requests.js';
import { setSetting, invalidateSettings } from '../src/lib/settings.js';

/**
 * Staging only. Cloudflare publishes dummy keys that always pass or always fail, so the
 * whole loop — widget, token, siteverify — can be exercised against their real service
 * without minting production keys.
 *   pass: 1x00000000000000000000AA / 1x0000000000000000000000000000000AA
 *   fail: 2x00000000000000000000AB / 2x0000000000000000000000000000000AA
 */
const mode = process.argv[2] ?? 'pass';
const keys = {
  pass: ['1x00000000000000000000AA', '1x0000000000000000000000000000000AA'],
  fail: ['2x00000000000000000000AB', '2x0000000000000000000000000000000AA'],
  off: null,
}[mode];

if (!keys) {
  await setSetting('auth.turnstileOnLogin', false, 'auth');
  await prisma.integration.deleteMany({ where: { provider: 'turnstile' } });
  console.log('turnstile cleared, login gate off');
} else {
  await saveTurnstile(keys[0], keys[1]);
  await setSetting('auth.turnstileOnLogin', true, 'auth');
  console.log(`turnstile ${mode} keys installed, login gate on`);
}
invalidateSettings();
await prisma.$disconnect();
