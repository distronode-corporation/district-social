import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { assertPublicHttpsUrl, isPrivateOrReservedAddress } from "../ssrf.js";

/**
 * Property tests for ssrf.ts, the guard on user-configured URLs (webhooks, image URLs).
 * Its input is untrusted by design, so these check what must hold for any input, not
 * just the cases ssrf.test.ts lists. NODE_ENV is "test" under vitest, so no DNS lookup
 * ever runs: only the literal and shape checks are exercised.
 */

const hex4 = (n: number) => n.toString(16);

describe("ssrf property tests", () => {
  it("assertPublicHttpsUrl rejects any input only with an `SSRF guard:` Error", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.webUrl(), fc.string({ unit: "binary" })), async (raw) => {
        try {
          await assertPublicHttpsUrl(raw);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/^SSRF guard: /);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("an IPv4 host is refused by the URL guard exactly when the classifier calls it private, in every IPv6 spelling that embeds it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.ipV4(), async (v4) => {
        const isPrivate = isPrivateOrReservedAddress(v4);
        const [a, b, c, d] = v4.split(".").map(Number);
        const hi = hex4((a << 8) | b);
        const lo = hex4((c << 8) | d);
        // IPv4-mapped (dotted and hex), IPv4-translated, NAT64 and 6to4: the embedded
        // address decides, so none of them is a way around the IPv4 verdict.
        for (const v6 of [`::ffff:${v4}`, `::ffff:${hi}:${lo}`, `::ffff:0:${hi}:${lo}`, `64:ff9b::${hi}:${lo}`, `2002:${hi}:${lo}::1`]) {
          expect(isPrivateOrReservedAddress(v6), v6).toBe(isPrivate);
          expect(isPrivateOrReservedAddress(`[${v6.toUpperCase()}]`), v6).toBe(isPrivate);
        }
        for (const host of [v4, `[::ffff:${v4}]`]) {
          const verdict = assertPublicHttpsUrl(`https://${host}/hook`);
          if (isPrivate) await expect(verdict).rejects.toThrow(/^SSRF guard: blocked private\/reserved IP/);
          else await expect(verdict).resolves.toBeUndefined();
        }
      }),
      { numRuns: 300 },
    );
  });

  it("isPrivateOrReservedAddress fails closed: anything that is not an IP literal is private", () => {
    const dottedQuad = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes(":") && !dottedQuad.test(s.replace(/^\[/, "").replace(/]$/, ""))),
        (s) => {
          expect(isPrivateOrReservedAddress(s)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
    // Strings with a colon that do not expand to eight 16-bit groups.
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.includes(":") && /[^0-9a-fA-F:.%[\]]/.test(s.split("%")[0])),
        (s) => {
          expect(isPrivateOrReservedAddress(s)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
