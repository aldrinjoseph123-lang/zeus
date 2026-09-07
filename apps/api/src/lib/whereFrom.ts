import type { FastifyRequest } from 'fastify';

/**
 * Where a request came from: the visitor's own address, and roughly where that is.
 *
 * Behind Cloudflare the answer arrives on the request itself and costs nothing —
 * `CF-Connecting-IP` is the visitor rather than the tunnel, and the visitor-location
 * headers carry city, region and country. Everything else (LAN access straight to the
 * server, a request Cloudflare did not tag) falls back to the external lookup that
 * has always been there, which only ever sees public addresses.
 *
 * Honest about its limits: this is IP-level. A home connection often resolves to the
 * ISP's hub city rather than the person's own, and a VPN shows the exit node. Country
 * and network are the reliable parts; city is a hint.
 */

export interface WhereFrom {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  isp: string | null;
}

const header = (request: FastifyRequest, name: string): string | null => {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  // Cloudflare sends XX for an address it cannot place, and T1 for Tor.
  return trimmed && trimmed !== 'XX' && trimmed !== 'T1' ? trimmed : null;
};

/**
 * The visitor's address. Cloudflare's own header first — it is the one hop we trust
 * to have written it — then the forwarded chain Caddy sets, then the socket.
 */
export function visitorIp(request: FastifyRequest): string {
  const cf = header(request, 'cf-connecting-ip');
  if (cf) return cf;
  const fwd = request.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return request.ip;
}

/** Nothing useful to learn from a private address, and no third party needs to hear about it. */
export function isPublicIp(ip: string): boolean {
  if (!ip) return false;
  return !/^(10\.|127\.|192\.168\.|169\.254\.|::1$|::ffff:127\.|fe80:|fc|fd|localhost$|172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
}

/** What Cloudflare already told us, if anything. Free, local, no request of our own. */
export function geoFromHeaders(request: FastifyRequest): Omit<WhereFrom, 'ip'> | null {
  const country = header(request, 'cf-ipcountry');
  const city = header(request, 'cf-ipcity');
  const region = header(request, 'cf-region');
  if (!country && !city) return null;
  // Cloudflare does not name the network, so the ISP stays for the lookup to fill.
  return { city, region, country, isp: null };
}

type Fetch = typeof fetch;

/** The fallback: one external call, short timeout, silent on failure. */
export async function geoFromLookup(ip: string, fetchImpl: Fetch = fetch): Promise<Omit<WhereFrom, 'ip'> | null> {
  if (!isPublicIp(ip)) return null;
  try {
    const token = process.env.IPINFO_TOKEN;
    const res = await fetchImpl(`https://ipinfo.io/${encodeURIComponent(ip)}/json${token ? `?token=${token}` : ''}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { org?: string; city?: string; region?: string; country?: string };
    return { city: j.city ?? null, region: j.region ?? null, country: j.country ?? null, isp: j.org ?? null };
  } catch {
    return null; // offline, rate-limited, or blocked — the IP alone is still worth having
  }
}

/**
 * Everything known about where this request came from. Headers answer instantly when
 * Cloudflare is in front; the lookup fills what they leave out — always the network
 * name, and the location too when the headers are not there at all.
 */
export async function whereFrom(request: FastifyRequest, fetchImpl: Fetch = fetch): Promise<WhereFrom> {
  const ip = visitorIp(request);
  const fromHeaders = geoFromHeaders(request);
  const looked = await geoFromLookup(ip, fetchImpl);
  return {
    ip,
    city: fromHeaders?.city ?? looked?.city ?? null,
    region: fromHeaders?.region ?? looked?.region ?? null,
    country: fromHeaders?.country ?? looked?.country ?? null,
    isp: looked?.isp ?? null,
  };
}

/** "Dubai, Dubai · Etisalat" — what the screen shows next to a session. */
export function describeWhere(w: { city?: string | null; region?: string | null; country?: string | null; isp?: string | null; ip?: string | null }): string {
  const place = [w.city, w.city && w.region && w.region !== w.city ? w.region : null, w.country].filter(Boolean).join(', ');
  return [place || w.ip || 'Unknown', w.isp].filter(Boolean).join(' · ');
}
