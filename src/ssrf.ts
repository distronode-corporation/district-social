/**
 * SSRF guard for server-side fetches to caller/workspace-configured URLs.
 *
 * Unlike `safe-fetch.ts` (a strict host *allow-list* for fixed provider APIs),
 * this validates arbitrary user-configured destinations (e.g. an ops webhook or
 * a user-supplied image URL): it requires HTTPS and blocks requests that target
 * localhost, cloud metadata, or private/reserved IP ranges — checked on the
 * URL's literal host and on every address the hostname resolves to.
 *
 * IMPORTANT — TOCTOU / DNS-rebinding & redirects:
 *   `assertPublicHttpsUrl` only *validates*; it does NOT stop a hostname from
 *   re-resolving to a private address when `fetch` looks it up again at connect
 *   time, nor does it stop a public host from issuing a 3xx redirect into the
 *   private network. Use it only as a pre-flight / storage-time check.
 *   For the actual outbound request use `preparePinnedHttpsFetch`, which
 *   resolves + validates once and returns an undici dispatcher **pinned** to the
 *   validated IP(s) so `fetch` cannot re-resolve to a different address, plus a
 *   `redirect: "error"` policy the caller must apply so redirects are not
 *   auto-followed to an unvalidated target. Together those close the rebinding
 *   and redirect-follow bypasses that the string check alone leaves open.
 *
 * DNS resolution is skipped under NODE_ENV==="test" to avoid network flakiness;
 * the synchronous literal-IP and hostname checks always run.
 *
 * Lives in the Social HQ engine, which imports nothing outside its own folder;
 * the app may re-export it, so every app caller keeps its import and there is
 * one implementation, not two copies.
 */

import type { LookupFunction } from "node:net";
import type { Agent as UndiciAgent } from "undici";

interface ResolvedAddress {
  address: string;
  family: number;
}

function ipv4ToParts(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts;
}

// Exported for its own unit test (the fail-closed branch below); not a public API.
export function isPrivateOrReservedIpv4(host: string): boolean {
  const parts = ipv4ToParts(host);
  // ⛔ FAIL CLOSED, matching isPrivateOrReservedIpv6 below: an unparseable
  // address is treated as private, never as public.
  //
  // It is unreachable today and left that way deliberately rather than
  // tested.
  // All four call sites already guarantee a parseable quad: the URL path is
  // guarded by isIpLiteral, the two DNS loops only see addresses dns.lookup
  // returned, and embeddedV4 builds its string from two 16-bit ints. Failing
  // closed therefore costs nothing today; its value is that the NEXT call
  // site added does not have to know all of that to be safe.
  if (!parts) return true;
  const [a, b, c] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IANA special-purpose
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1 (documentation)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/**
 * Expands an IPv6 literal to its 8 canonical 16-bit groups. Handles `::`
 * compression, a trailing dotted-quad (`::ffff:169.254.169.254`), and strips
 * any zone id. Returns null on anything malformed.
 */
function expandIpv6(addr: string): number[] | null {
  let a = addr;
  const zoneIdx = a.indexOf("%");
  if (zoneIdx !== -1) a = a.slice(0, zoneIdx);

  if (a.includes(".")) {
    const lastColon = a.lastIndexOf(":");
    if (lastColon === -1) return null;
    const v4 = ipv4ToParts(a.slice(lastColon + 1));
    if (!v4) return null;
    a =
      a.slice(0, lastColon + 1) +
      (((v4[0] << 8) | v4[1]).toString(16)) +
      ":" +
      (((v4[2] << 8) | v4[3]).toString(16));
  }

  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groupsStr = [
    ...head,
    ...(halves.length === 2 ? Array(missing).fill("0") : []),
    ...tail,
  ];
  const groups: number[] = [];
  for (const g of groupsStr) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

function isPrivateOrReservedIpv6(addr: string): boolean {
  // Canonical expansion first: WHATWG URL and DNS both emit *compressed hex*
  // forms (e.g. `::ffff:a9fe:a9fe` for ::ffff:169.254.169.254), so any check
  // against the dotted/text spelling alone is bypassable. A literal that
  // doesn't expand is malformed — fail closed.
  const groups = expandIpv6(addr.toLowerCase());
  if (!groups) return true;
  const [g0, g1, g2, , g4, g5, g6, g7] = groups;
  const zeroThrough = (end: number) => groups.slice(0, end).every((g) => g === 0);
  const embeddedV4 = (hi: number, lo: number) =>
    isPrivateOrReservedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);

  if (zeroThrough(7) && g7 <= 1) return true; // :: unspecified, ::1 loopback
  // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96 — the
  // embedded IPv4 address decides (this is the metadata-IP bypass fix).
  if (zeroThrough(5) && (g5 === 0xffff || g5 === 0)) return embeddedV4(g6, g7);
  // IPv4-translated ::ffff:0:0:0/96 (RFC 2765, SIIT): the same embedded IPv4
  // decides, so `::ffff:0:7f00:1` is 127.0.0.1 and not a public address.
  if (zeroThrough(4) && g4 === 0xffff && g5 === 0) return embeddedV4(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && groups.slice(2, 6).every((g) => g === 0))
    return embeddedV4(g6, g7); // NAT64 64:ff9b::/96
  // Local-use NAT64 64:ff9b:1::/48 (RFC 8215): the operator's own translator,
  // with no fixed place for the embedded IPv4, so the whole prefix is refused.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  if (g0 === 0x2002) return embeddedV4(g1, g2); // 6to4 2002::/16 embeds v4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo 2001::/32 tunneling
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation 2001:db8::/32
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g0 === 0x100 && groups.slice(1, 4).every((g) => g === 0)) return true; // discard-only 100::/64
  return false;
}

// Coarse check: any host containing ":" is treated as an IPv6 literal (a
// hostname can never legally contain ":"), and IPv4 literals are already
// confirmed via ipv4ToParts. Determines whether DNS resolution can be
// skipped and literal-IP validation applied directly.
function isIpLiteral(host: string): boolean {
  return ipv4ToParts(host) !== null || host.includes(":");
}

function isPrivateOrReserved(host: string): boolean {
  return host.includes(":") ? isPrivateOrReservedIpv6(host) : isPrivateOrReservedIpv4(host);
}

/**
 * The same private/reserved classification the guards below apply, for a caller
 * that resolves and fetches on its own terms (the setup wizard's website read,
 * which must allow plain http and follow a bounded number of redirects, each one
 * re-validated). `addr` is an IP literal, v4 or v6, brackets allowed; anything
 * that parses as neither is treated as private (fail closed).
 */
export function isPrivateOrReservedAddress(addr: string): boolean {
  return isPrivateOrReserved(addr.toLowerCase().replace(/^\[/, "").replace(/]$/, ""));
}

/** Suffixes that only ever name a machine inside a private network. */
const INTERNAL_NAME_SUFFIX = /\.(localhost|local|internal|home\.arpa)$/;

/**
 * Whether a URL hostname names a machine inside the deployment's own network:
 * the one internal-name rule for every guard that fetches a user-supplied URL
 * (this module's shape check, and any caller that does its own resolution and
 * redirects).
 *
 * ⛔ THE TRAILING DOT IS STRIPPED BEFORE MATCHING. `https://localhost./` is the
 * root-anchored spelling of localhost and URL keeps the dot, so a suffix check
 * on the raw hostname let it through to DNS. Any run of dots goes, since URL
 * keeps `localhost..` too.
 *
 * ⛔ A DOTLESS NAME IS INTERNAL. It is resolved through the resolver's search
 * domains, i.e. inside the deployment's own network (`metadata`, `intranet`, a cluster
 * service name). This also covers bare `localhost` and an empty host.
 *
 * An IPv6 literal (brackets allowed) is an address, not a name, and answers
 * false here: the private/reserved range check is what classifies it.
 */
export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/]$/, "").replace(/\.+$/, "");
  if (host.includes(":")) return false;
  if (!host.includes(".")) return true;
  return INTERNAL_NAME_SUFFIX.test(host);
}

/**
 * Validates the *shape* of a destination URL (protocol, internal hostnames, and
 * literal private/reserved IPs) without touching the network. Throws with the
 * stable `SSRF guard: ...` messages on any violation. Returns the parsed URL,
 * the normalized (bracket-stripped) host, and whether that host is an IP literal.
 */
function parseAndValidateHttpsShape(raw: string): { url: URL; host: string; isLiteral: boolean } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("SSRF guard: invalid URL");
  }

  if (u.protocol !== "https:") {
    throw new Error(`SSRF guard: only HTTPS is allowed (got ${u.protocol})`);
  }

  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/]$/, "");

  if (isInternalHostname(host)) {
    throw new Error(`SSRF guard: blocked internal host "${host}"`);
  }

  const literal = isIpLiteral(host);
  if (literal && isPrivateOrReserved(host)) {
    throw new Error(`SSRF guard: blocked private/reserved IP "${host}"`);
  }

  return { url: u, host, isLiteral: literal };
}

/**
 * Resolve a hostname to all of its addresses. Tolerates DNS-resolution failures
 * (an unresolvable host cannot be a successful SSRF target — the fetch will
 * simply fail) by returning an empty list. Callers decide how to treat empty.
 */
async function resolveHostAddresses(host: string): Promise<ResolvedAddress[]> {
  try {
    const { lookup } = await import("dns/promises");
    return await lookup(host, { all: true });
  } catch {
    return [];
  }
}

/**
 * Build an undici dispatcher whose DNS lookup is pinned to the pre-validated
 * address(es), so `fetch` connects to exactly the IP we checked and cannot
 * re-resolve to a private one (the DNS-rebinding / TOCTOU defense). SNI and the
 * Host header still use the original hostname, so TLS cert validation is intact.
 */
export async function buildPinnedDispatcher(pinned: ResolvedAddress[]): Promise<UndiciAgent> {
  const { Agent } = await import("undici");
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options && options.all) {
      callback(
        null,
        pinned.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      callback(null, pinned[0].address, pinned[0].family);
    }
  };
  return new Agent({ connect: { lookup } });
}

/**
 * Throws if `raw` is not a safe public HTTPS destination.
 *
 * Validation-only: use this for pre-flight / storage-time checks. It is NOT
 * sufficient on its own for the outbound request (see the module docstring and
 * `preparePinnedHttpsFetch`), because `fetch` re-resolves and follows redirects
 * independently of this check.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<void> {
  const { host, isLiteral } = parseAndValidateHttpsShape(raw);
  if (isLiteral) return; // literal IPs are fully validated by the shape check above

  // Skipped in tests to avoid real network calls; literal checks above still apply.
  if (process.env.NODE_ENV === "test") return;

  const addresses = await resolveHostAddresses(host);
  for (const r of addresses) {
    if (isPrivateOrReserved(r.address)) {
      throw new Error(`SSRF guard: "${host}" resolves to private/reserved address ${r.address}`);
    }
  }
}

export interface PinnedHttpsFetchOptions {
  /**
   * undici dispatcher pinned to the validated IP(s). `undefined` only under
   * NODE_ENV==="test" (DNS resolution is skipped there); callers then fall back
   * to the global dispatcher.
   */
  dispatcher: UndiciAgent | undefined;
  /**
   * Redirect policy the caller MUST pass to `fetch`. `"error"` in production so
   * any 3xx is a hard failure (blocking redirect-follow SSRF); `undefined` under
   * NODE_ENV==="test" so unit tests keep the legacy fetch-init shape.
   */
  redirect: RequestInit["redirect"];
}

/**
 * Validate + resolve a user-configured HTTPS destination ONCE and return the
 * undici dispatcher (pinned to the validated address) and redirect policy the
 * caller must apply to `fetch`. This closes the two bypasses that
 * `assertPublicHttpsUrl` alone leaves open:
 *   1. DNS-rebinding / TOCTOU — the returned dispatcher pins the connection to
 *      the exact IP we validated, so `fetch` cannot re-resolve to a private one.
 *   2. Redirect-follow — the caller applies `redirect: "error"`, so a public
 *      host cannot 3xx-bounce the request into the private network.
 * Throws the stable `SSRF guard: ...` errors on any violation.
 */
export async function preparePinnedHttpsFetch(raw: string): Promise<PinnedHttpsFetchOptions> {
  const { host, isLiteral } = parseAndValidateHttpsShape(raw);

  // Skip real DNS + dispatcher construction under test to keep unit tests
  // network-free and deterministic; the shape checks above still ran.
  if (process.env.NODE_ENV === "test") {
    return { dispatcher: undefined, redirect: undefined };
  }

  if (isLiteral) {
    const family = host.includes(":") ? 6 : 4;
    return {
      dispatcher: await buildPinnedDispatcher([{ address: host, family }]),
      redirect: "error",
    };
  }

  const addresses = await resolveHostAddresses(host);
  if (addresses.length === 0) {
    throw new Error(`SSRF guard: "${host}" did not resolve to any address`);
  }
  for (const a of addresses) {
    if (isPrivateOrReserved(a.address)) {
      throw new Error(`SSRF guard: "${host}" resolves to private/reserved address ${a.address}`);
    }
  }

  return { dispatcher: await buildPinnedDispatcher(addresses), redirect: "error" };
}
