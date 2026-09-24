import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { rateLimitKey } from '../auth/rateLimitKey.js';
import { SESSION_COOKIE, signSessionToken } from '../auth/session.js';
import { PORTAL_COOKIE, signPortalToken } from '../portal/session.js';

/** The limiter is off under the test runner, so what is pinned here is the key it would count against. */
const req = (cookies: Record<string, string>, ip = '203.0.113.7') => ({ cookies, ip }) as unknown as FastifyRequest;

describe('what the rate limit counts against', () => {
  it('is the session for a signed-in person, so an office does not share one budget', async () => {
    const a = await signSessionToken('user-a', 12, 'sid-a');
    const b = await signSessionToken('user-b', 12, 'sid-b');
    assert.equal(await rateLimitKey(req({ [SESSION_COOKIE]: a })), 'session:sid-a');
    assert.equal(await rateLimitKey(req({ [SESSION_COOKIE]: b })), 'session:sid-b', 'a colleague on the same address is another key');
  });

  it('is the portal session for a portal visitor', async () => {
    const token = await signPortalToken('portal-user-1', 60, undefined, 'psid-1');
    assert.equal(await rateLimitKey(req({ [PORTAL_COOKIE]: token })), 'portal:psid-1');
  });

  it('is the address for anyone else — no cookie, or a cookie that does not verify', async () => {
    assert.equal(await rateLimitKey(req({})), 'ip:203.0.113.7');
    // A character well inside the signature, not its last one — that only carries padding bits.
    const real = await signSessionToken('user-a', 12, 'sid-a');
    const forged = real.slice(0, -6) + (real.slice(-6, -5) === 'A' ? 'B' : 'A') + real.slice(-5);
    assert.equal(await rateLimitKey(req({ [SESSION_COOKIE]: forged })), 'ip:203.0.113.7', 'an invented cookie does not buy a budget of its own');
    assert.equal(await rateLimitKey(req({ [SESSION_COOKIE]: 'not-a-token' }, '198.51.100.9')), 'ip:198.51.100.9');
  });
});
