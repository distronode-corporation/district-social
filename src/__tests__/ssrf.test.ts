// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertPublicHttpsUrl,
  isInternalHostname,
  isPrivateOrReservedAddress,
  isPrivateOrReservedIpv4,
  preparePinnedHttpsFetch,
} from "../ssrf.js";

/**
 * ssrf.ts tests.
 *
 * Two layers are exercised:
 *  1. Synchronous "shape" validation (protocol, internal hostnames, literal
 *     private/reserved IPs) — runs in every environment, tested directly.
 *  2. DNS-resolution + pinned-dispatcher behavior — skipped by the module when
 *     NODE_ENV==="test", so those tests stub NODE_ENV to "production" and mock
 *     `dns/promises` and `undici` (no real network I/O ever happens).
 */

const ssrfMocks = vi.hoisted(() => {
  const lookupMock = vi.fn();
  const agentCtor = vi.fn();
  class FakeAgent {
    constructor(opts: unknown) {
      agentCtor(opts);
    }
  }
  return { lookupMock, agentCtor, FakeAgent };
});

vi.mock("dns/promises", () => ({ lookup: ssrfMocks.lookupMock }));
vi.mock("undici", () => ({ Agent: ssrfMocks.FakeAgent }));

const { lookupMock, agentCtor, FakeAgent } = ssrfMocks;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isPrivateOrReservedIpv4 — fails closed", () => {
  it.each(["999.1.1.1", "1.2.3", "a.b.c.d", "", "1.2.3.4.5", "256.0.0.1"])(
    "treats the unparseable quad %j as private rather than public",
    (host) => {
      // No caller reaches this with an unparseable quad today; the guard is so
      // the next call site does not have to know that to stay safe.
      expect(isPrivateOrReservedIpv4(host)).toBe(true);
    },
  );

  it("still answers public for a parseable public address", () => {
    expect(isPrivateOrReservedIpv4("93.184.216.34")).toBe(false);
  });
});

describe("ssrf — URL shape validation", () => {
  it("allows public HTTPS URLs", async () => {
    await expect(assertPublicHttpsUrl("https://example.com")).resolves.toBeUndefined();
    await expect(assertPublicHttpsUrl("https://api.example.com/webhook?x=1#f")).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(assertPublicHttpsUrl("not-a-url")).rejects.toThrow("SSRF guard: invalid URL");
    await expect(assertPublicHttpsUrl("")).rejects.toThrow("SSRF guard: invalid URL");
    // WHATWG URL parsing rejects out-of-range IPv4 octets outright.
    await expect(assertPublicHttpsUrl("https://999.1.1.1")).rejects.toThrow("SSRF guard: invalid URL");
  });

  it("rejects every non-HTTPS scheme", async () => {
    await expect(assertPublicHttpsUrl("http://example.com")).rejects.toThrow("only HTTPS is allowed (got http:)");
    await expect(assertPublicHttpsUrl("ftp://example.com/file")).rejects.toThrow("only HTTPS is allowed");
    await expect(assertPublicHttpsUrl("ws://example.com")).rejects.toThrow("only HTTPS is allowed");
    await expect(assertPublicHttpsUrl("file:///etc/passwd")).rejects.toThrow("only HTTPS is allowed");
    await expect(assertPublicHttpsUrl("gopher://example.com")).rejects.toThrow("only HTTPS is allowed");
  });

  it("blocks internal hostnames (and case variants) but not lookalike public names", async () => {
    // Blocked
    await expect(assertPublicHttpsUrl("https://localhost")).rejects.toThrow('blocked internal host "localhost"');
    await expect(assertPublicHttpsUrl("https://foo.localhost")).rejects.toThrow("blocked internal host");
    await expect(assertPublicHttpsUrl("https://printer.local")).rejects.toThrow("blocked internal host");
    await expect(assertPublicHttpsUrl("https://svc.cluster.internal")).rejects.toThrow("blocked internal host");
    await expect(assertPublicHttpsUrl("https://metadata.google.internal")).rejects.toThrow("blocked internal host");
    // URL lowercases hostnames, so case games do not bypass the check.
    await expect(assertPublicHttpsUrl("https://METADATA.GOOGLE.INTERNAL")).rejects.toThrow("blocked internal host");
    await expect(assertPublicHttpsUrl("https://LOCALHOST")).rejects.toThrow("blocked internal host");
    // Allowed lookalikes — suffix matching must not overreach.
    await expect(assertPublicHttpsUrl("https://notlocalhost.com")).resolves.toBeUndefined();
    await expect(assertPublicHttpsUrl("https://internal.example.com")).resolves.toBeUndefined();
    await expect(assertPublicHttpsUrl("https://local.example.com")).resolves.toBeUndefined();
  });

  describe("isPrivateOrReservedAddress: the classification for a caller that resolves on its own", () => {
    it.each(["10.0.0.5", "169.254.169.254", "::1", "[::1]", "[FE80::1]", "::ffff:127.0.0.1"])("%s is private", (addr) => {
      expect(isPrivateOrReservedAddress(addr)).toBe(true);
    });

    it.each(["93.184.216.34", "8.8.8.8", "[2606:4700:4700::1111]"])("%s is public", (addr) => {
      expect(isPrivateOrReservedAddress(addr)).toBe(false);
    });

    it.each(["not-an-ip", "", "[]", "999.1.1.1"])("%j parses as neither family, so it fails closed", (addr) => {
      expect(isPrivateOrReservedAddress(addr)).toBe(true);
    });
  });

  describe("isInternalHostname: the one internal-name rule every URL guard shares", () => {
    it.each([
      "localhost",
      "LOCALHOST",
      "localhost.",
      "localhost..",
      "foo.localhost",
      "printer.local",
      "printer.local.",
      "svc.cluster.internal",
      "metadata.google.internal",
      "metadata.google.internal.",
      "router.home.arpa",
      "router.home.arpa.",
      "metadata",
      "metadata.",
      "intranet",
      ".",
      "",
    ])("treats %j as internal", (host) => {
      expect(isInternalHostname(host)).toBe(true);
    });

    it.each([
      "example.com",
      "example.com.",
      "notlocalhost.com",
      "internal.example.com",
      "local.example.com",
      "home.arpa.example.com",
      "metadata.example.com",
      // Addresses are the range check's job, not this one's.
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "[::1]",
      "[::ffff:a9fe:a9fe]",
    ])("does not treat %j as an internal name", (host) => {
      expect(isInternalHostname(host)).toBe(false);
    });
  });

  it("refuses a dotless name in the shape check, as website-read always did", async () => {
    await expect(assertPublicHttpsUrl("https://intranet/")).rejects.toThrow('blocked internal host "intranet"');
    await expect(assertPublicHttpsUrl("https://router.home.arpa/")).rejects.toThrow("blocked internal host");
  });

  describe("literal IPv4 blocklist — positive and negative per range", () => {
    const blocked: [string, string][] = [
      ["10.0.0.1", "10.0.0.0/8 private"],
      ["10.255.255.255", "10.0.0.0/8 upper edge"],
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback upper edge"],
      ["0.0.0.0", "this-host 0.0.0.0/8"],
      ["169.254.169.254", "cloud metadata (link-local)"],
      ["169.254.0.1", "link-local"],
      ["172.16.0.1", "172.16.0.0/12 lower edge"],
      ["172.31.255.255", "172.16.0.0/12 upper edge"],
      ["192.168.0.1", "192.168.0.0/16"],
      ["100.64.0.1", "CGNAT lower edge"],
      ["100.127.255.255", "CGNAT upper edge"],
      ["192.0.0.1", "IANA special-purpose 192.0.0.0/24"],
      ["192.0.2.55", "TEST-NET-1"],
      ["198.18.0.1", "benchmarking 198.18.0.0/15"],
      ["198.19.255.255", "benchmarking upper edge"],
      ["198.51.100.7", "TEST-NET-2"],
      ["203.0.113.9", "TEST-NET-3"],
      ["224.0.0.1", "multicast"],
      ["240.0.0.1", "reserved 240.0.0.0/4"],
      ["255.255.255.255", "broadcast"],
    ];
    it.each(blocked)("blocks https://%s (%s)", async (ip) => {
      await expect(assertPublicHttpsUrl(`https://${ip}`)).rejects.toThrow(
        `SSRF guard: blocked private/reserved IP "${ip}"`
      );
    });

    const allowed: [string, string][] = [
      ["11.0.0.1", "just above 10/8"],
      ["9.255.255.255", "just below 10/8"],
      ["126.0.0.1", "just below loopback"],
      ["128.0.0.1", "just above loopback"],
      ["169.253.0.1", "just below link-local"],
      ["172.15.0.1", "just below 172.16/12"],
      ["172.32.0.1", "just above 172.16/12"],
      ["192.167.0.1", "just below 192.168/16"],
      ["192.169.0.1", "just above 192.168/16"],
      ["100.63.255.255", "just below CGNAT"],
      ["100.128.0.1", "just above CGNAT"],
      ["192.0.1.1", "between special-purpose and TEST-NET-1"],
      ["192.0.3.1", "just above TEST-NET-1"],
      ["198.17.0.1", "just below benchmarking"],
      ["198.20.0.1", "just above benchmarking"],
      ["198.51.101.1", "just above TEST-NET-2"],
      ["203.0.114.1", "just above TEST-NET-3"],
      ["223.255.255.255", "just below multicast"],
      ["1.1.1.1", "public resolver"],
      ["8.8.8.8", "public resolver"],
    ];
    it.each(allowed)("allows https://%s (%s)", async (ip) => {
      await expect(assertPublicHttpsUrl(`https://${ip}`)).resolves.toBeUndefined();
    });
  });

  it("blocks decimal/hex/octal-encoded loopback (URL normalizes them to dotted quad)", async () => {
    // new URL() canonicalizes these to 127.0.0.1 before our checks run.
    await expect(assertPublicHttpsUrl("https://2130706433")).rejects.toThrow('blocked private/reserved IP "127.0.0.1"');
    await expect(assertPublicHttpsUrl("https://0x7f000001")).rejects.toThrow('blocked private/reserved IP "127.0.0.1"');
    await expect(assertPublicHttpsUrl("https://017700000001")).rejects.toThrow('blocked private/reserved IP "127.0.0.1"');
  });

  describe("literal IPv6 blocklist — positive and negative", () => {
    it("blocks loopback/unspecified (including expanded form, brackets stripped)", async () => {
      await expect(assertPublicHttpsUrl("https://[::1]")).rejects.toThrow('blocked private/reserved IP "::1"');
      await expect(assertPublicHttpsUrl("https://[::]")).rejects.toThrow("blocked private/reserved IP");
      // URL compresses the expanded form back to ::1.
      await expect(assertPublicHttpsUrl("https://[0:0:0:0:0:0:0:1]")).rejects.toThrow('blocked private/reserved IP "::1"');
    });

    it("blocks link-local, unique-local, and documentation ranges", async () => {
      await expect(assertPublicHttpsUrl("https://[fe80::1]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[fc00::1]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[fd12:3456::1]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[2001:db8::1]")).rejects.toThrow("blocked private/reserved IP");
    });

    it("allows public IPv6 literals", async () => {
      await expect(assertPublicHttpsUrl("https://[2606:4700::1111]")).resolves.toBeUndefined();
      await expect(assertPublicHttpsUrl("https://[2600::1]")).resolves.toBeUndefined();
    });

    it("blocks compressed-hex IPv4-mapped forms (metadata-IP bypass regression)", async () => {
      // WHATWG URL emits ::ffff:a9fe:a9fe for ::ffff:169.254.169.254 — the
      // dotted-quad-only regex never matched this spelling.
      await expect(assertPublicHttpsUrl("https://[::ffff:a9fe:a9fe]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[::ffff:169.254.169.254]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[::ffff:c0a8:101]")).rejects.toThrow("blocked private/reserved IP"); // 192.168.1.1
      await expect(assertPublicHttpsUrl("https://[::ffff:7f00:1]")).rejects.toThrow("blocked private/reserved IP"); // 127.0.0.1
      await expect(assertPublicHttpsUrl("https://[::a9fe:a9fe]")).rejects.toThrow("blocked private/reserved IP"); // IPv4-compatible ::/96
      // Mapped PUBLIC v4 stays allowed (embedded address decides).
      await expect(assertPublicHttpsUrl("https://[::ffff:808:808]")).resolves.toBeUndefined(); // 8.8.8.8
    });

    it("blocks multicast, NAT64/6to4 private embeds, Teredo, and discard-only ranges", async () => {
      await expect(assertPublicHttpsUrl("https://[ff02::1]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[ff05::2]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[64:ff9b::a9fe:a9fe]")).rejects.toThrow("blocked private/reserved IP"); // NAT64 → metadata
      await expect(assertPublicHttpsUrl("https://[2002:a9fe:a9fe::1]")).rejects.toThrow("blocked private/reserved IP"); // 6to4 → metadata
      await expect(assertPublicHttpsUrl("https://[2001::1]")).rejects.toThrow("blocked private/reserved IP"); // Teredo
      await expect(assertPublicHttpsUrl("https://[100::1]")).rejects.toThrow("blocked private/reserved IP"); // discard-only
      // NAT64/6to4 embedding a PUBLIC v4 stays allowed.
      await expect(assertPublicHttpsUrl("https://[64:ff9b::808:808]")).resolves.toBeUndefined();
      await expect(assertPublicHttpsUrl("https://[2002:808:808::1]")).resolves.toBeUndefined();
    });

    it("judges IPv4-translated ::ffff:0:0:0/96 (RFC 2765) by its embedded IPv4", async () => {
      await expect(assertPublicHttpsUrl("https://[::ffff:0:7f00:1]")).rejects.toThrow("blocked private/reserved IP"); // 127.0.0.1
      await expect(assertPublicHttpsUrl("https://[::ffff:0:a9fe:a9fe]")).rejects.toThrow("blocked private/reserved IP"); // metadata
      await expect(assertPublicHttpsUrl("https://[::ffff:0:a00:1]")).rejects.toThrow("blocked private/reserved IP"); // 10.0.0.1
      // A PUBLIC embed stays allowed, as for the mapped form.
      await expect(assertPublicHttpsUrl("https://[::ffff:0:808:808]")).resolves.toBeUndefined(); // 8.8.8.8
    });

    it("refuses all of local-use NAT64 64:ff9b:1::/48 (RFC 8215), and only that /48", async () => {
      await expect(assertPublicHttpsUrl("https://[64:ff9b:1::a00:1]")).rejects.toThrow("blocked private/reserved IP");
      // Refused even with a public embed: the prefix itself is local.
      await expect(assertPublicHttpsUrl("https://[64:ff9b:1::808:808]")).rejects.toThrow("blocked private/reserved IP");
      await expect(assertPublicHttpsUrl("https://[64:ff9b:1:ffff::1]")).rejects.toThrow("blocked private/reserved IP");
      // Neighbours: the next /48, and the well-known /96 with a public embed.
      await expect(assertPublicHttpsUrl("https://[64:ff9b:2::1]")).resolves.toBeUndefined();
      await expect(assertPublicHttpsUrl("https://[64:ff9b::808:808]")).resolves.toBeUndefined();
    });

    it("fails closed on malformed IPv6 literals reaching the range check", async () => {
      // new URL() rejects most malformed literals itself ("invalid URL"), but
      // anything that slips through to the range check must be treated as
      // blocked, not silently public.
      const mod = await import("../ssrf.js");
      // Reach the internal path via a resolved-address check: simulate a DNS
      // answer with a malformed address string.
      expect(mod).toBeDefined();
      await expect(assertPublicHttpsUrl("https://[1:2:3:4:5:6:7:8:9]")).rejects.toThrow();
      await expect(assertPublicHttpsUrl("https://[::ffff:999.1.1.1]")).rejects.toThrow();
    });
  });

  it("preparePinnedHttpsFetch applies the same shape checks", async () => {
    await expect(preparePinnedHttpsFetch("http://example.com")).rejects.toThrow("only HTTPS is allowed");
    await expect(preparePinnedHttpsFetch("https://localhost")).rejects.toThrow("blocked internal host");
    await expect(preparePinnedHttpsFetch("https://169.254.169.254")).rejects.toThrow("blocked private/reserved IP");
    await expect(preparePinnedHttpsFetch("garbage")).rejects.toThrow("invalid URL");
  });

  it("preparePinnedHttpsFetch under NODE_ENV=test returns no dispatcher and no redirect policy", async () => {
    const res = await preparePinnedHttpsFetch("https://example.com");
    expect(res).toEqual({ dispatcher: undefined, redirect: undefined });
    expect(agentCtor).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("ssrf — DNS resolution and pinning (NODE_ENV=production, mocked dns/undici)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    lookupMock.mockReset();
    agentCtor.mockClear();
  });

  describe("assertPublicHttpsUrl", () => {
    it("rejects hostnames that resolve to a private/reserved IPv4 address", async () => {
      lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
      await expect(assertPublicHttpsUrl("https://rebind.example.com")).rejects.toThrow(
        'SSRF guard: "rebind.example.com" resolves to private/reserved address 10.1.2.3'
      );
      expect(lookupMock).toHaveBeenCalledWith("rebind.example.com", { all: true });
    });

    it("rejects when ANY resolved address is private (multi-A-record rebinding)", async () => {
      lookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.0.10", family: 4 },
      ]);
      await expect(assertPublicHttpsUrl("https://mixed.example.com")).rejects.toThrow(
        "resolves to private/reserved address 192.168.0.10"
      );
    });

    it("rejects IPv4-mapped IPv6 resolution answers (::ffff:a.b.c.d form)", async () => {
      lookupMock.mockResolvedValue([{ address: "::ffff:10.0.0.1", family: 6 }]);
      await expect(assertPublicHttpsUrl("https://mapped.example.com")).rejects.toThrow(
        "resolves to private/reserved address ::ffff:10.0.0.1"
      );
    });

    it("rejects hostnames resolving to private IPv6", async () => {
      lookupMock.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
      await expect(assertPublicHttpsUrl("https://ula.example.com")).rejects.toThrow(
        "resolves to private/reserved address fd00::1"
      );
    });

    it("allows hostnames that resolve only to public addresses", async () => {
      lookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ]);
      await expect(assertPublicHttpsUrl("https://public.example.com")).resolves.toBeUndefined();
    });

    it("tolerates DNS failure (unresolvable host cannot be fetched anyway)", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
      await expect(assertPublicHttpsUrl("https://does-not-exist.example.com")).resolves.toBeUndefined();
    });

    it("skips DNS entirely for validated public IP literals", async () => {
      await expect(assertPublicHttpsUrl("https://8.8.8.8")).resolves.toBeUndefined();
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });

  describe("preparePinnedHttpsFetch", () => {
    it("pins a public IPv4 literal without DNS and enforces redirect: error", async () => {
      const res = await preparePinnedHttpsFetch("https://1.1.1.1/hook");
      expect(res.redirect).toBe("error");
      expect(res.dispatcher).toBeInstanceOf(FakeAgent);
      expect(lookupMock).not.toHaveBeenCalled();

      // The dispatcher's DNS lookup must be pinned to the literal we validated.
      const opts = agentCtor.mock.calls[0][0] as {
        connect: { lookup: (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void };
      };
      const cbAll = vi.fn();
      opts.connect.lookup("attacker-controlled-rebind.example", { all: true }, cbAll);
      expect(cbAll).toHaveBeenCalledWith(null, [{ address: "1.1.1.1", family: 4 }]);
      const cbOne = vi.fn();
      opts.connect.lookup("attacker-controlled-rebind.example", {}, cbOne);
      expect(cbOne).toHaveBeenCalledWith(null, "1.1.1.1", 4);
    });

    it("pins a public IPv6 literal with family 6", async () => {
      const res = await preparePinnedHttpsFetch("https://[2606:4700::1111]/x");
      expect(res.redirect).toBe("error");
      const opts = agentCtor.mock.calls[0][0] as {
        connect: { lookup: (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void };
      };
      const cb = vi.fn();
      opts.connect.lookup("whatever", {}, cb);
      expect(cb).toHaveBeenCalledWith(null, "2606:4700::1111", 6);
    });

    it("resolves a hostname once and pins the dispatcher to ALL validated addresses", async () => {
      lookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 },
      ]);
      const res = await preparePinnedHttpsFetch("https://ops.example.com/hook");
      expect(res.redirect).toBe("error");
      expect(res.dispatcher).toBeInstanceOf(FakeAgent);
      expect(lookupMock).toHaveBeenCalledTimes(1);
      expect(lookupMock).toHaveBeenCalledWith("ops.example.com", { all: true });

      const opts = agentCtor.mock.calls[0][0] as {
        connect: { lookup: (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void };
      };
      const cbAll = vi.fn();
      opts.connect.lookup("ops.example.com", { all: true }, cbAll);
      expect(cbAll).toHaveBeenCalledWith(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 },
      ]);
      const cbOne = vi.fn();
      opts.connect.lookup("ops.example.com", {}, cbOne);
      expect(cbOne).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    });

    it("throws when the hostname resolves to a private address", async () => {
      lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
      await expect(preparePinnedHttpsFetch("https://metadata-rebind.example.com")).rejects.toThrow(
        "resolves to private/reserved address 169.254.169.254"
      );
      expect(agentCtor).not.toHaveBeenCalled();
    });

    it("throws when the hostname resolves to a mix of public and private addresses", async () => {
      lookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]);
      await expect(preparePinnedHttpsFetch("https://half-evil.example.com")).rejects.toThrow(
        "resolves to private/reserved address 10.0.0.5"
      );
    });

    it("throws (unlike assertPublicHttpsUrl) when the hostname does not resolve", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
      await expect(preparePinnedHttpsFetch("https://ghost.example.com")).rejects.toThrow(
        'SSRF guard: "ghost.example.com" did not resolve to any address'
      );
      expect(agentCtor).not.toHaveBeenCalled();
    });

    it("throws when DNS returns an empty answer set", async () => {
      lookupMock.mockResolvedValue([]);
      await expect(preparePinnedHttpsFetch("https://empty.example.com")).rejects.toThrow(
        "did not resolve to any address"
      );
    });
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * What the address parser does with input it cannot understand.
 *
 * The IPv6 range check does not read the address text, it EXPANDS it to eight
 * 16-bit groups first and then range-checks the numbers. Everything below feeds
 * the expander input it must reject, and asserts the direction of that
 * rejection: an address the guard cannot parse is treated as PRIVATE, never as
 * public. Get that backwards and the failure a human meets is not a crash, it
 * is a webhook that quietly delivers to 169.254.169.254 because one odd
 * spelling fell through `expandIpv6` and out the "not private" end.
 *
 * These paths are reachable only through a resolver answer, because
 * `new URL()` refuses most malformed literals before the guard ever sees them
 * (verified: "https://[1:2:3:4:5:6:7]" and "https://[::ffff:999.1.1.1]" both
 * throw at parse). So they are exercised the way production would meet them,
 * through a mocked `dns/promises` answer under NODE_ENV=production.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe("ssrf — resolver answers the address parser cannot understand", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    lookupMock.mockReset();
    agentCtor.mockClear();
  });

  // ⛔ Every row must FAIL CLOSED. `expandIpv6` returning null means "I do not
  // understand this address", and `isPrivateOrReservedIpv6` answers that with
  // `true`. A refactor that made the expander return [] or throw instead would
  // turn each of these into an allowed destination, and nothing else in the
  // module would notice.
  const unparseable: [string, string][] = [
    ["::ffff:999.1.1.1", "IPv4-mapped, dotted quad out of range"],
    ["::ffff:not.an.ip", "IPv4-mapped, trailer is not a dotted quad"],
    ["fe80::1::2", "two :: compressions"],
    ["1:2:3:4:5:6:7", "seven groups, nothing compressed"],
    ["1:2:3:4:5:6:7:8:9", "nine groups, nothing compressed"],
    ["1:2:3:4:5:6:7::8", ":: that would expand to zero groups"],
    ["1:2:3:4:5:6:7:8::", "trailing :: after a full eight groups"],
    ["fe80::zz", "group that is not hex"],
    ["12345::1", "five-digit group"],
    // ⚠️ Contrived on purpose: the zone id is stripped BEFORE the address is
    // split, so a "%" early enough removes every colon and leaves the expander
    // holding a dotted quad it was never called for. No resolver emits this.
    // The row is here for the direction of the answer, not the plausibility of
    // the input.
    ["9.9.9.9%::1", "zone id that swallows every colon"],
  ];

  it.each(unparseable)(
    "treats a host resolving to %s (%s) as private rather than public",
    async (address) => {
      lookupMock.mockResolvedValue([{ address, family: 6 }]);
      await expect(assertPublicHttpsUrl("https://odd-answer.example.com")).rejects.toThrow(
        `resolves to private/reserved address ${address}`
      );
    }
  );

  it.each(unparseable)("refuses to pin an outbound dispatcher to %s (%s)", async (address) => {
    lookupMock.mockResolvedValue([{ address, family: 6 }]);
    // ⚠️ Assert the private/reserved message specifically. A bare "SSRF guard:"
    // would also be satisfied by "did not resolve to any address", so the test
    // would keep passing if the answer stopped reaching the range check at all.
    await expect(preparePinnedHttpsFetch("https://odd-answer.example.com")).rejects.toThrow(
      `resolves to private/reserved address ${address}`
    );
    // ⛔ No dispatcher may be built for an address the guard could not classify.
    expect(agentCtor).not.toHaveBeenCalled();
  });

  it("strips an IPv6 zone id before range-checking, so a scoped link-local answer is named as link-local", async () => {
    // Node hands back scoped addresses for link-local answers on some
    // platforms ("fe80::1%eth0"). Without the strip this would still be
    // blocked, but as "unparseable" rather than as fe80::/10.
    lookupMock.mockResolvedValue([{ address: "fe80::1%eth0", family: 6 }]);
    await expect(assertPublicHttpsUrl("https://scoped.example.com")).rejects.toThrow(
      "resolves to private/reserved address fe80::1%eth0"
    );
  });

  it("still allows a public answer that carries a zone id", async () => {
    // ⚠️ This is the assertion that proves the zone id is STRIPPED rather than
    // merely making the address unparseable: swap the strip for "reject
    // anything containing %" and every blocked case above still passes while
    // this one starts failing legitimate destinations.
    lookupMock.mockResolvedValue([{ address: "2606:4700::1111%eth0", family: 6 }]);
    await expect(assertPublicHttpsUrl("https://scoped-public.example.com")).resolves.toBeUndefined();
  });

  it("range-checks a fully expanded answer the same as its compressed spelling", async () => {
    // 0:0:0:0:0:ffff:0a00:0001 is ::ffff:10.0.0.1. DNS and WHATWG URL both emit
    // the compressed form, so the eight-group branch of the expander is only
    // ever reached by a resolver that spells it out.
    lookupMock.mockResolvedValue([{ address: "0000:0000:0000:0000:0000:ffff:0a00:0001", family: 6 }]);
    await expect(assertPublicHttpsUrl("https://expanded.example.com")).rejects.toThrow(
      "resolves to private/reserved address 0000:0000:0000:0000:0000:ffff:0a00:0001"
    );
  });

  it("allows a fully expanded public answer", async () => {
    lookupMock.mockResolvedValue([{ address: "2606:4700:0000:0000:0000:0000:0000:1111", family: 6 }]);
    await expect(assertPublicHttpsUrl("https://expanded-public.example.com")).resolves.toBeUndefined();
  });

  it("lowercases an answer before parsing it, so upper-case hex is not silently unparseable", async () => {
    // ⚠️ The group regex is /^[0-9a-f]{1,4}$/, lower case only. Drop the
    // toLowerCase() and "2A06:98C0::1" stops expanding, which fails CLOSED and
    // would therefore look like a blocklist working rather than a parser
    // breaking: a real customer destination refused for the wrong reason.
    lookupMock.mockResolvedValue([{ address: "2A06:98C0::1", family: 6 }]);
    await expect(assertPublicHttpsUrl("https://uppercase.example.com")).resolves.toBeUndefined();

    lookupMock.mockResolvedValue([{ address: "::FFFF:A9FE:A9FE", family: 6 }]);
    await expect(assertPublicHttpsUrl("https://uppercase-metadata.example.com")).rejects.toThrow(
      "resolves to private/reserved address ::FFFF:A9FE:A9FE"
    );
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Spellings that get past the literal-host blocklist, and the layer that stops
 * them anyway.
 *
 * `parseAndValidateHttpsShape` blocks internal NAMES by string comparison. That
 * comparison is exact, and WHATWG URL keeps a trailing dot on a name while
 * stripping it from an IPv4 literal, so "localhost." and
 * "metadata.google.internal." are not the strings the blocklist holds. They are
 * caught one layer down, by the resolved-address check.
 *
 * ⛔ That makes the DNS layer LOAD-BEARING, not defence in depth. Anyone
 * tempted to drop it as "the literal checks already cover this" reopens
 * https://metadata.google.internal. straight onto the metadata server.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe("ssrf — root-anchored and encoded spellings of blocked destinations", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    lookupMock.mockReset();
    agentCtor.mockClear();
  });

  it.each([
    ["https://metadata.google.internal.", "metadata.google.internal."],
    ["https://localhost.", "localhost."],
    ["https://localhost../", "localhost.."],
    ["https://metadata/", "metadata"],
    ["https://METADATA./", "metadata."],
  ])("blocks %s at the name layer, before any DNS lookup", async (raw, host) => {
    // The resolver would answer the metadata server or loopback; it must not
    // be asked. Until the shared isInternalHostname, the trailing-dot and bare
    // `metadata` spellings passed the name check and only DNS stopped them,
    // which also left the storage-time check passing them as "unresolvable".
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertPublicHttpsUrl(raw)).rejects.toThrow(`SSRF guard: blocked internal host "${host}"`);
    await expect(preparePinnedHttpsFetch(raw)).rejects.toThrow(`SSRF guard: blocked internal host "${host}"`);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks the IPv4-mapped spelling of loopback and metadata without needing DNS", async () => {
    await expect(assertPublicHttpsUrl("https://[::ffff:127.0.0.1]/")).rejects.toThrow(
      'blocked private/reserved IP "::ffff:7f00:1"'
    );
    await expect(assertPublicHttpsUrl("https://[::ffff:169.254.169.254]/")).rejects.toThrow(
      'blocked private/reserved IP "::ffff:a9fe:a9fe"'
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks the trailing-dot spelling of an IP literal without needing DNS", async () => {
    // Contrast with the two above: URL strips the dot from a literal, so
    // "127.0.0.1." arrives as "127.0.0.1" and never reaches the resolver.
    await expect(assertPublicHttpsUrl("https://127.0.0.1.")).rejects.toThrow(
      'blocked private/reserved IP "127.0.0.1"'
    );
    await expect(assertPublicHttpsUrl("https://169.254.169.254.")).rejects.toThrow(
      'blocked private/reserved IP "169.254.169.254"'
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("reads the host past userinfo, so a credential-shaped prefix cannot disguise the destination", async () => {
    // "https://example.com@169.254.169.254/" connects to 169.254.169.254; the
    // part before "@" is a username. A guard that string-matched the URL rather
    // than reading url.hostname would see "example.com" and wave it through.
    await expect(assertPublicHttpsUrl("https://example.com@169.254.169.254/latest/meta-data/")).rejects.toThrow(
      'blocked private/reserved IP "169.254.169.254"'
    );
    await expect(assertPublicHttpsUrl("https://user:pass@10.0.0.1/")).rejects.toThrow(
      'blocked private/reserved IP "10.0.0.1"'
    );
    await expect(assertPublicHttpsUrl("https://safe.example.com@[::1]/")).rejects.toThrow(
      'blocked private/reserved IP "::1"'
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("blocks percent-encoded and numerically encoded spellings of the metadata endpoint", async () => {
    // URL normalizes all of these before the guard runs. Pinned because each is
    // a standard SSRF filter bypass, and the reason they fail here is that the
    // guard checks the PARSED hostname rather than the raw string.
    await expect(assertPublicHttpsUrl("https://%6c%6fcalhost/")).rejects.toThrow(
      'blocked internal host "localhost"'
    );
    await expect(assertPublicHttpsUrl("https://2852039166/")).rejects.toThrow(
      'blocked private/reserved IP "169.254.169.254"'
    );
    await expect(assertPublicHttpsUrl("https://0xA9FEA9FE/")).rejects.toThrow(
      'blocked private/reserved IP "169.254.169.254"'
    );
    await expect(assertPublicHttpsUrl("https://127.1/")).rejects.toThrow(
      'blocked private/reserved IP "127.0.0.1"'
    );
  });
});

// The boundary with an app-level allow-list fetch (no allow-list escape
// hatch) is pinned by the host app's own tests: it needs the app's OAuth
// provider host list, which this folder may not import.
describe("ssrf: the dispatcher and the redirect policy travel together", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    lookupMock.mockReset();
    agentCtor.mockClear();
  });

  it("returns the dispatcher and the redirect policy together, never one without the other", async () => {
    // ⛔ Callers spread `...(redirect ? { redirect } : {})`, so a falsy redirect
    // is not a loud failure: fetch silently reverts to its default "follow" and
    // the redirect-into-the-private-network bypass reopens while the pinning
    // still looks correct.
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const resolved = await preparePinnedHttpsFetch("https://ops.example.com/hook");
    expect(resolved.dispatcher).toBeInstanceOf(FakeAgent);
    expect(resolved.redirect).toBe("error");

    const literal = await preparePinnedHttpsFetch("https://8.8.8.8/hook");
    expect(literal.dispatcher).toBeInstanceOf(FakeAgent);
    expect(literal.redirect).toBe("error");
  });
});
