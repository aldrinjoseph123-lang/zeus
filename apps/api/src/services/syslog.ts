import dgram from 'node:dgram';
import net from 'node:net';
import { getSettings } from '../lib/settings.js';

/**
 * Forward system-log events to a syslog server / SIEM as RFC5424 messages, over UDP
 * or TCP. No dependency — dgram/net are enough. Best-effort: a forwarding failure must
 * never disturb the app, so every send swallows its own errors.
 *
 * RFC5424: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
 * PRI = facility*8 + severity. Facility 16 (local0); severity from the log level.
 */

const SEVERITY: Record<string, number> = { error: 3, warn: 4, info: 6 };

function rfc5424(level: string, source: string, message: string): string {
  const pri = 16 * 8 + (SEVERITY[level] ?? 6);
  const ts = new Date().toISOString();
  const host = process.env.HOSTNAME || 'zeus';
  // MSGID = the log source; structured-data omitted ("-"); message is single-line.
  return `<${pri}>1 ${ts} ${host} zeus-crm ${process.pid} ${source} - ${message.replace(/[\r\n]+/g, ' ')}`;
}

export async function forwardToSyslog(level: string, source: string, message: string): Promise<void> {
  const cfg = await getSettings('syslog.');
  if (!cfg['syslog.enabled']) return;
  const host = String(cfg['syslog.host'] ?? '').trim();
  if (!host) return;
  const port = Number(cfg['syslog.port'] ?? 514) || 514;
  const protocol = String(cfg['syslog.protocol'] ?? 'udp').toLowerCase();
  const payload = Buffer.from(rfc5424(level, source, message), 'utf8');

  try {
    if (protocol === 'tcp') {
      await new Promise<void>((resolve) => {
        const socket = net.connect({ host, port }, () => {
          socket.write(Buffer.concat([payload, Buffer.from('\n')]), () => socket.end());
        });
        socket.setTimeout(3000, () => socket.destroy());
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      });
    } else {
      await new Promise<void>((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.send(payload, port, host, () => { socket.close(); resolve(); });
        socket.on('error', () => { try { socket.close(); } catch { /* already closed */ } resolve(); });
      });
    }
  } catch {
    /* forwarding is best-effort — never let it surface */
  }
}
