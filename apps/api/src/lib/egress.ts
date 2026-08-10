import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Where Zeus is allowed to send an outbound request to a user-supplied address.
 *
 * A webhook URL is typed by a person and then fetched by the server, which makes it a
 * request forgery primitive unless something says no. The address that matters is not the
 * one in the box — it is whatever the hostname resolves to. `http://internal.example.com`
 * looks fine and can point at 10.0.0.5; so can a public hostname whose owner changes the
 * record after it has been saved.
 *
 * So the check runs at delivery, every time, on the resolved addresses. Checking only at
 * save time protects against a typo, not against anyone trying.
 */

/** Ranges nothing outbound should ever reach. */
function isBlockedV4(address: string): string | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 'not a valid address';
  const [a, b] = parts;

  if (a === 0) return 'the unspecified network';
  if (a === 10) return 'a private network';
  if (a === 127) return 'this machine';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT';
  if (a === 169 && b === 254) return 'link-local, which is where cloud metadata services live';
  if (a === 172 && b >= 16 && b <= 31) return 'a private network';
  if (a === 192 && b === 168) return 'a private network';
  if (a === 192 && b === 0) return 'a reserved network';
  if (a >= 224) return 'multicast or reserved space';
  return null;
}

function isBlockedV6(address: string): string | null {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return 'this machine';

  // An IPv4-mapped address is an IPv4 address wearing a hat; judge it as one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedV4(mapped[1]);

  const head = parseInt(lower.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return 'a unique-local network';
  if ((head & 0xffc0) === 0xfe80) return 'link-local';
  if ((head & 0xff00) === 0xff00) return 'multicast';
  return null;
}

function reasonFor(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return isBlockedV4(address);
  if (version === 6) return isBlockedV6(address);
  return 'not a valid address';
}

export interface EgressCheck {
  ok: boolean;
  /** Plain sentence for the person who typed the URL. */
  reason?: string;
  /** The addresses it resolved to, so a delivery log can say where it actually went. */
  addresses?: string[];
}

/**
 * May Zeus send to this URL right now?
 *
 * `allowPrivate` exists for the test suite, which necessarily points a webhook at a local
 * stub server. Nothing in the application passes it.
 */
export async function checkEgress(rawUrl: string, allowPrivate = false): Promise<EgressCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `Zeus can only call http or https addresses, not ${url.protocol.replace(':', '')}.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Put credentials in a header on the receiving end, not in the URL.' };
  }
  if (allowPrivate) return { ok: true, addresses: [] };

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Use https. A webhook carries your data across the internet in the clear otherwise.' };
  }

  // URL keeps the brackets on a literal IPv6 host, and no resolver accepts those.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  /**
   * A literal address is judged directly. Going through DNS for it would work by accident
   * — the lookup fails and the refusal reads "cannot resolve", which is true but hides
   * why it was really refused, and would quietly let it through on any resolver that did
   * answer.
   */
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    // Every address the name resolves to, not just the first: a hostname with one public
    // and one private record would otherwise get through on a coin flip.
    try {
      const resolved = await lookup(host, { all: true });
      addresses = resolved.map((r) => r.address);
    } catch {
      return { ok: false, reason: `Zeus cannot resolve ${host}.` };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} resolves to nothing.` };

  for (const address of addresses) {
    const reason = reasonFor(address);
    if (reason) {
      return {
        ok: false,
        reason: host === address
          ? `${address} is ${reason}. Zeus will not send there.`
          : `${host} resolves to ${address}, which is ${reason}. Zeus will not send there.`,
        addresses,
      };
    }
  }

  return { ok: true, addresses };
}
