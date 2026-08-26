/**
 * SSRF egress guard for the URL harvest adapter.
 *
 * The harvest URL adapter fetches attacker-influenceable URLs (a user or an
 * MCP client naming a URL to ingest). Without this guard an ingest of
 * `http://169.254.169.254/latest/meta-data/` or an RFC1918 host reaches
 * internal services in a hosted deployment and can exfiltrate
 * instance-metadata IAM credentials.
 *
 * This module is self-contained so @hive-mind/core does not depend on an
 * application runtime. DNS validation and socket selection intentionally live
 * together: separating them would re-open a DNS-rebinding window.
 *
 * Obfuscated IP literals (octal / decimal / hex) are normalized by the OS
 * resolver: `net.isIP` rejects them as literals, so they fall through to
 * `dns.lookup`, which returns the canonical dotted form we classify.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unique-local'
  | 'multicast'
  | 'reserved'
  | 'unspecified'
  | 'invalid';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressGuardOptions {
  /** Permit loopback targets (default false). Only loopback is unlocked. */
  allowLocal?: boolean;
  /** Injectable resolver (tests). Defaults to node:dns/promises lookup(all). */
  lookup?: LookupFn;
}

export class EgressBlockedError extends Error {
  public readonly url: string;
  public readonly addressClass?: AddressClass;
  constructor(message: string, url: string, addressClass?: AddressClass) {
    super(message);
    this.name = 'EgressBlockedError';
    this.url = url;
    this.addressClass = addressClass;
  }
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function classifyIpv4(ip: string): AddressClass {
  const octets = parseIpv4Octets(ip);
  if (!octets) return 'invalid';
  const [a, b, c] = octets;
  if (a === 0) return 'unspecified'; // 0.0.0.0/8
  if (a === 127) return 'loopback'; // 127.0.0.0/8
  if (a === 10) return 'private'; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return 'link-local'; // 169.254.0.0/16 (metadata)
  if (a >= 224 && a <= 239) return 'multicast'; // 224.0.0.0/4
  if (a >= 240) return 'reserved'; // 240.0.0.0/4 + 255.255.255.255
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved'; // Deprecated 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // TEST-NET-3
  return 'public';
}

function parseIpv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zoneAt = s.indexOf('%');
  if (zoneAt !== -1) s = s.slice(0, zoneAt);

  const dotMatch = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotMatch) {
    const v4 = parseIpv4Octets(dotMatch[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, dotMatch.index) + hi + ':' + lo;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const hextets: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    hextets.push(parseInt(g, 16));
  }
  return hextets;
}

function classifyIpv6(ip: string): AddressClass {
  const h = parseIpv6Hextets(ip);
  if (!h) return 'invalid';

  const firstFive = h[0] | h[1] | h[2] | h[3] | h[4];
  if (firstFive === 0 && (h[5] === 0xffff || h[5] === 0)) {
    const embedded = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
    const v4Class = classifyIpv4(embedded);
    if (h[5] === 0 && h[6] === 0 && h[7] === 0) return 'unspecified';
    if (h[5] === 0 && h[6] === 0 && h[7] === 1) return 'loopback'; // ::1
    return v4Class;
  }

  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return 'reserved'; // fec0::/10 deprecated site-local
  if ((h[0] & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7 (ULA)
  if ((h[0] & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'reserved'; // 2001:db8::/32 docs
  if (
    h[0] === 0x0064 && h[1] === 0xff9b
    && ((h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) || h[2] === 1)
  ) return 'reserved'; // 64:ff9b::/96 and 64:ff9b:1::/48 translation prefixes
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return 'reserved'; // 100::/64 discard
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 1) return 'reserved'; // 100:0:0:1::/64 dummy
  if (h[0] === 0x2001 && h[1] === 2 && h[2] === 0) return 'reserved'; // 2001:2::/48 benchmark
  if (h[0] === 0x2002) return 'reserved'; // 2002::/16 deprecated 6to4
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return 'reserved'; // 3fff::/20 docs
  if (h[0] === 0x5f00) return 'reserved'; // 5f00::/16 SRv6 SIDs
  return 'public';
}

/** Classify a single IP-literal address. Fail-closed: unknown -> 'invalid'. */
export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip);
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  return 'invalid';
}

function isAllowed(cls: AddressClass, allowLocal: boolean): boolean {
  if (cls === 'public') return true;
  if (cls === 'loopback' && allowLocal) return true;
  return false;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
}

async function resolveHostname(
  hostname: string,
  rawUrl: string,
  lookupFn: LookupFn,
): Promise<ResolvedAddress[]> {
  try {
    const addresses = await lookupFn(hostname);
    if (!addresses || addresses.length === 0) {
      throw new EgressBlockedError(
        `DNS resolution returned no addresses for "${hostname}"`,
        rawUrl,
      );
    }
    return addresses;
  } catch (err) {
    if (err instanceof EgressBlockedError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new EgressBlockedError(
      `DNS resolution failed for "${hostname}": ${detail}`,
      rawUrl,
    );
  }
}

function validateResolvedAddresses(
  addresses: ResolvedAddress[],
  hostname: string,
  rawUrl: string,
  allowLocal: boolean,
): void {
  for (const { address } of addresses) {
    const cls = classifyAddress(address);
    if (!isAllowed(cls, allowLocal)) {
      throw new EgressBlockedError(
        `Blocked egress to ${cls} address ${address} (host "${hostname}")`,
        rawUrl,
        cls,
      );
    }
  }
}

function createGuardedLookup(
  allowLocal: boolean,
  lookupFn: LookupFn,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolveHostname(hostname, hostname, lookupFn)
      .then((addresses) => {
        validateResolvedAddresses(addresses, hostname, hostname, allowLocal);

        const requestedFamily = options.family === 4 || options.family === 'IPv4'
          ? 4
          : options.family === 6 || options.family === 'IPv6'
            ? 6
            : 0;
        const candidates = requestedFamily === 0
          ? addresses
          : addresses.filter(({ family }) => family === requestedFamily);
        if (candidates.length === 0) {
          throw new EgressBlockedError(
            `DNS resolution returned no IPv${requestedFamily} addresses for "${hostname}"`,
            hostname,
          );
        }

        if (options.all) {
          callback(null, candidates);
        } else {
          const selected = candidates[0];
          callback(null, selected.address, selected.family);
        }
      })
      .catch((err: unknown) => {
        callback(err as NodeJS.ErrnoException, '');
      });
  };
}

function createGuardedAgent(allowLocal: boolean, lookupFn: LookupFn): Agent {
  return new Agent({
    autoSelectFamily: true,
    connect: { lookup: createGuardedLookup(allowLocal, lookupFn) },
  });
}

const defaultGuardedAgents = new Map<boolean, Agent>();

function getDefaultGuardedAgent(allowLocal: boolean): Agent {
  const existing = defaultGuardedAgents.get(allowLocal);
  if (existing) return existing;
  const agent = createGuardedAgent(allowLocal, defaultLookup);
  defaultGuardedAgents.set(allowLocal, agent);
  return agent;
}

function findEgressBlockedError(
  error: unknown,
  seen = new Set<unknown>(),
): EgressBlockedError | null {
  if (error instanceof EgressBlockedError) return error;
  if (typeof error !== 'object' || error === null || seen.has(error)) return null;
  seen.add(error);

  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const blocked = findEgressBlockedError(nested, seen);
      if (blocked) return blocked;
    }
  }

  return findEgressBlockedError((error as { cause?: unknown }).cause, seen);
}

/**
 * Validate that `rawUrl` is an http(s) URL whose host resolves only to public
 * addresses. Throws {@link EgressBlockedError} otherwise. Returns parsed URL.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  options: EgressGuardOptions = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError('Invalid URL', rawUrl);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlockedError(
      `Blocked non-http(s) scheme "${parsed.protocol}"`,
      rawUrl,
    );
  }

  if (parsed.username || parsed.password) {
    throw new EgressBlockedError('Blocked URL credentials', rawUrl);
  }

  // url.hostname keeps the surrounding brackets on an IPv6 literal ("[::1]"),
  // which isIP() does not recognize — strip them so the literal is classified
  // directly (loopback/private/link-local/…) instead of falling through to a DNS
  // lookup that fails ENOTFOUND on Linux (and only accidentally resolves on
  // Windows). Without this, bracketed-IPv6 URLs bypass classification entirely.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);

  let addresses: ResolvedAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    const lookupFn = options.lookup ?? defaultLookup;
    addresses = await resolveHostname(hostname, rawUrl, lookupFn);
  }

  const allowLocal = options.allowLocal ?? false;
  validateResolvedAddresses(addresses, hostname, rawUrl, allowLocal);

  return parsed;
}

export interface SafeFetchOptions extends EgressGuardOptions {
  /** Maximum redirect hops to follow (default 5). */
  maxRedirects?: number;
}

type FetchWithDispatcher = (
  input: string | URL | Request,
  init: Omit<RequestInit, 'dispatcher'> & { dispatcher: Agent },
) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_SECRET_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'x-api-key',
  'api-key',
] as const;
const REQUEST_BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
] as const;

function isNonReplayableBody(body: NonNullable<RequestInit['body']>): boolean {
  const candidate = body as unknown as {
    getReader?: unknown;
    pipe?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };
  return typeof candidate.getReader === 'function'
    || typeof candidate.pipe === 'function'
    || typeof candidate[Symbol.asyncIterator] === 'function';
}

function redirectRequestInit(
  init: RequestInit,
  status: number,
  fromUrl: URL,
  toUrl: URL,
): RequestInit {
  const next = { ...init };
  const method = (next.method ?? 'GET').toUpperCase();
  const rewriteToGet = ((status === 301 || status === 302) && method === 'POST')
    || (status === 303 && method !== 'GET' && method !== 'HEAD');
  const headersToDelete = new Set<string>(['host']);

  if (rewriteToGet) {
    next.method = 'GET';
    delete next.body;
    for (const name of REQUEST_BODY_HEADERS) headersToDelete.add(name);
  } else if (next.body !== undefined && next.body !== null && isNonReplayableBody(next.body)) {
    throw new TypeError('Cannot replay a streamed request body across a redirect');
  }

  if (fromUrl.origin !== toUrl.origin) {
    for (const name of CROSS_ORIGIN_SECRET_HEADERS) headersToDelete.add(name);
  }

  const headers = new Headers(next.headers);
  for (const name of headersToDelete) headers.delete(name);
  next.headers = headers;
  return next;
}

/**
 * SSRF-safe fetch. Validates before the request and re-validates every redirect
 * hop (`redirect: 'manual'`). Native fetch is mandatory; proxy transports need
 * an equivalent pinned connector rather than a global dispatcher override.
 * Caller-supplied `redirect` in `init` is ignored.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  if ('fetchImpl' in options) {
    throw new TypeError('safeFetch fetchImpl injection is not supported; socket pinning requires native fetch');
  }
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = rawUrl;
  let currentInit = { ...init };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrlAllowed(currentUrl, options);
    const allowLocal = options.allowLocal ?? false;
    const temporaryAgent = options.lookup !== undefined;
    const dispatcher = temporaryAgent
      ? createGuardedAgent(allowLocal, options.lookup!)
      : getDefaultGuardedAgent(allowLocal);

    let response: Response;
    try {
      const fetchInit = {
        ...currentInit,
        redirect: 'manual',
        dispatcher,
      } as Omit<RequestInit, 'dispatcher'> & { dispatcher: Agent };
      response = await (globalThis.fetch as unknown as FetchWithDispatcher)(currentUrl, fetchInit);
    } catch (err) {
      if (temporaryAgent) {
        await dispatcher.close().catch(() => undefined);
      }
      const blocked = findEgressBlockedError(err);
      if (blocked) {
        throw new EgressBlockedError(blocked.message, currentUrl, blocked.addressClass);
      }
      throw err;
    }

    if (temporaryAgent) {
      void dispatcher.close().catch(() => undefined);
    }

    const isRedirect = REDIRECT_STATUSES.has(response.status);
    const location = isRedirect ? response.headers.get('location') : null;
    if (!location) {
      return response;
    }

    try {
      await response.body?.cancel();
    } catch {
      /* best-effort; ignore */
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new EgressBlockedError(
        `Invalid redirect target "${location}"`,
        currentUrl,
      );
    }
    currentInit = redirectRequestInit(
      currentInit,
      response.status,
      new URL(currentUrl),
      nextUrl,
    );
    currentUrl = nextUrl.toString();
  }

  throw new EgressBlockedError(
    `Exceeded maximum redirects (${maxRedirects})`,
    rawUrl,
  );
}

/** True when local (loopback) fetches are opted in via env. */
export function allowLocalFromEnv(): boolean {
  const v = process.env.HIVE_MIND_ALLOW_LOCAL_FETCH;
  return v === '1' || v === 'true';
}
