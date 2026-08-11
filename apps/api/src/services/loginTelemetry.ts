import { prisma } from '../db.js';
import { logSystem } from './systemLog.js';

/**
 * On every successful sign-in, record where it came from: public IP, and — via an
 * external IP-intelligence lookup — the ISP and rough location. Written to the system
 * log (source 'auth'), so it lands in the log viewer and forwards to the SIEM.
 *
 * Deliberate limits stated once: a browser cannot reveal a MAC address or a reliable
 * private IP, so neither is collected. Only public IPs are looked up; private/loopback
 * addresses are skipped (nothing to learn, and no third party is told about them).
 * Note: IP + ISP + location per login is personal data — it inherits the log's 30-day
 * retention. ponytail: provider hard-wired to ipinfo.io; make it configurable if the
 * team standardises on another.
 */

function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  return !/^(10\.|127\.|192\.168\.|169\.254\.|::1$|fe80:|fc|fd|localhost$|172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
}

async function lookupIsp(ip: string): Promise<{ isp?: string; city?: string; country?: string } | null> {
  if (!isPublicIp(ip)) return null;
  try {
    const token = process.env.IPINFO_TOKEN;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json${token ? `?token=${token}` : ''}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = (await res.json()) as { org?: string; city?: string; region?: string; country?: string };
    return { isp: j.org, city: [j.city, j.region].filter(Boolean).join(', ') || undefined, country: j.country };
  } catch {
    return null; // offline, rate-limited, or blocked — degrade to IP only
  }
}

/** Best-effort device label from a User-Agent — "Chrome on macOS", "Safari on iPhone". */
export function deviceFromUA(ua?: string): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? 'Android'
          : /Windows/.test(ua) ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
              : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

export function recordLogin(user: { id: string; name: string }, ip: string, userAgent?: string): void {
  const device = deviceFromUA(userAgent);
  void (async () => {
    // Stamp the user's last-login IP/device for the Users tab (best-effort).
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginIp: ip, lastLoginDevice: device } }).catch(() => undefined);
    const geo = await lookupIsp(ip);
    const where = [ip, geo?.isp, geo?.city && geo?.country ? `${geo.city} ${geo.country}` : geo?.country].filter(Boolean).join(' · ');
    logSystem('info', 'auth', `${user.name} signed in from ${where || 'an unknown address'} on ${device}`, {
      userId: user.id, ip, device, isp: geo?.isp ?? null, city: geo?.city ?? null, country: geo?.country ?? null,
    });
  })().catch(() => undefined);
}
