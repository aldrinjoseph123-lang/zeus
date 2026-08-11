import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { migrateTestDatabase, prisma, resetDatabase } from './harness.js';
import { forwardToSyslog } from '../services/syslog.js';
import { setSetting, invalidateSettings } from '../lib/settings.js';

/**
 * The forwarder should emit a well-formed RFC5424 datagram when enabled, and stay
 * silent when not — verified against a real local UDP listener, no external server.
 */

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); invalidateSettings(); });

function listener(): Promise<{ port: number; next: () => Promise<string>; close: () => void }> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let resolveMsg: ((s: string) => void) | null = null;
    sock.on('message', (buf) => resolveMsg?.(buf.toString('utf8')));
    sock.bind(0, '127.0.0.1', () => resolve({
      port: (sock.address() as { port: number }).port,
      next: () => new Promise<string>((r) => { resolveMsg = r; }),
      close: () => sock.close(),
    }));
  });
}

describe('syslog forwarding', () => {
  it('sends an RFC5424 datagram when enabled', async () => {
    const l = await listener();
    try {
      await setSetting('syslog.enabled', true);
      await setSetting('syslog.host', '127.0.0.1');
      await setSetting('syslog.port', l.port);
      await setSetting('syslog.protocol', 'udp');
      invalidateSettings();

      const got = l.next();
      await forwardToSyslog('error', 'backup', 'restore failed');
      const msg = await Promise.race([got, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('no datagram')), 2000))]);
      // <134>=facility16*8+severity6? error→sev3 → 16*8+3=131. Structure: <PRI>1 TS host zeus-crm pid MSGID - MSG
      assert.match(msg, /^<131>1 \S+ \S+ zeus-crm \d+ backup - restore failed$/);
    } finally {
      l.close();
    }
  });

  it('stays silent when disabled', async () => {
    const l = await listener();
    try {
      // default: syslog.enabled is false
      let received = false;
      void l.next().then(() => { received = true; });
      await forwardToSyslog('error', 'backup', 'should not send');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(received, false);
    } finally {
      l.close();
    }
  });
});
