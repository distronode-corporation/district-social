import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LinkedInError,
  LINKEDIN_VERSION,
  setLinkedInTokenResolver,
  setLinkedInOrganizationId,
  getOrganizationUrn,
  createPost,
  deletePost,
  getPostsBatch,
  getPostShareStatistics,
  getShareStatistics,
  initializeImageUpload,
  LINKEDIN_POST_STAT_FIELDS,
  linkedInPostStatsFilter,
  uploadImageBytes,
} from "../linkedin.js";
import {
  FIXTURE_LINKEDIN_ORG,
  FIXTURE_LINKEDIN_ORG_URN,
  FIXTURE_LINKEDIN_POST_ID,
  FIXTURE_LINKEDIN_POST_ID_2,
  FIXTURE_LINKEDIN_SHARE_URN,
  FIXTURE_LINKEDIN_UGC_URN,
} from "./helpers/fixtures.js";

/** Builds a fetch-mock-shaped Response for a JSON body. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers(headers),
  } as unknown as Response;
}

/** Builds a fetch-mock-shaped Response with no body (204/201-empty). */
function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    headers: new Headers(headers),
  } as unknown as Response;
}

const TOKEN = "test-access-token";
const ORG_ACL_BODY = {
  elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:100000001" }],
};

describe("linkedin client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    setLinkedInTokenResolver(async () => TOKEN);
    // ⚠️ `_pinnedOrgId` is module state and `setLinkedInTokenResolver` does NOT
    // clear it (it clears the resolved URN and the in-flight lookup only). A pin
    // left behind by one test short-circuits fetchOrganizationUrn in every later
    // one, so the organizationAcls tests below would assert against a lookup that
    // never ran and pass for the wrong reason.
    setLinkedInOrganizationId(null);
  });

  afterEach(() => {
    setLinkedInTokenResolver(null);
    setLinkedInOrganizationId(null);
    vi.unstubAllGlobals();
  });

  describe("auth", () => {
    it("throws a clear LinkedInError when no resolver is registered", async () => {
      setLinkedInTokenResolver(null);
      await expect(getOrganizationUrn()).rejects.toThrow(/no LinkedIn token resolver/);
    });

    it("throws when the resolver returns an empty token", async () => {
      setLinkedInTokenResolver(async () => "");
      await expect(getOrganizationUrn()).rejects.toThrow(/empty token/);
    });

    it("sends the bearer token, LinkedIn-Version, and Restli protocol headers on every call", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, ORG_ACL_BODY));
      await getOrganizationUrn();
      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["LinkedIn-Version"]).toBe(LINKEDIN_VERSION);
      expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    });
  });

  describe("getOrganizationUrn", () => {
    it("resolves the org urn from the roleAssignee finder and caches it (one fetch across multiple calls)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, ORG_ACL_BODY));
      const first = await getOrganizationUrn();
      const second = await getOrganizationUrn();
      expect(first).toBe("urn:li:organization:100000001");
      expect(second).toBe("urn:li:organization:100000001");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("falls back to organizationTarget when organization is absent (docs are inconsistent on the field name)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, {
          elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organizationTarget: "urn:li:organization:999" }],
        }),
      );
      const urn = await getOrganizationUrn();
      expect(urn).toBe("urn:li:organization:999");
    });

    it("throws when no admin org role is found", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, { elements: [] }));
      await expect(getOrganizationUrn()).rejects.toThrow(/no APPROVED ADMINISTRATOR organization role/);
    });

    it("says the same thing when the response carries no elements key at all", async () => {
      // A token whose scopes do not include organization ACLs answers with the
      // envelope and no `elements`. Without the `?? []` that is `.map` of
      // undefined, i.e. a TypeError escaping the client as something the
      // transport cannot classify, in place of the one message that tells an
      // operator what to actually do.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, {}));
      await expect(getOrganizationUrn()).rejects.toThrow(/connect a company-page admin account/);
    });

    /**
     * ⛔ THE GUARD THAT KEEPS A BRAND'S MARKETING OFF SOMEBODY ELSE'S PAGE.
     *
     * `fetchOrganizationUrn` used to take `elements[0]`, which is correct for an
     * account administering exactly one page and silently wrong for anyone else.
     * The live token has administered three at once, and LinkedIn does not return
     * them in any documented order. The connection reports itself healthy either
     * way, because the credential IS valid; only the audience is wrong, and a
     * post seen by the wrong audience is not recoverable by deleting it.
     *
     * ⚠️ So the assertion is not merely "it throws". The message has to name the
     * pages it found and name the env var that resolves it, because refusing
     * without saying which pages were in contention leaves an operator guessing
     * at an id they cannot see.
     */
    it("refuses to guess, and names the pages, when the token administers more than one", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, {
          elements: [
            { role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:100000001" },
            { role: "ADMINISTRATOR", state: "APPROVED", organizationTarget: "urn:li:organization:99887766" },
          ],
        }),
      );

      const err = await getOrganizationUrn().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LinkedInError);
      const message = (err as LinkedInError).message;
      expect(message).toContain("administers 2 company pages");
      expect(message).toContain("urn:li:organization:100000001");
      expect(message).toContain("urn:li:organization:99887766");
      expect(message).toContain("LINKEDIN_ORG_ID");
    });

    it("posts as the pinned company page without asking LinkedIn which pages exist", async () => {
      setLinkedInOrganizationId("100000001");
      expect(await getOrganizationUrn()).toBe("urn:li:organization:100000001");
      expect(fetch).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ AN OPERATOR READS THE URN OUT OF THE API AND PASTES THE WHOLE THING.
     * That is the natural thing to do, and double-prefixing it produces
     * `urn:li:organization:urn:li:organization:100000001`, an author URN LinkedIn
     * rejects on every write, so publishing stops dead with a vendor error that
     * says nothing about the env var that caused it.
     */
    it("accepts a full organization urn as the pin and does not prefix it twice", async () => {
      setLinkedInOrganizationId("urn:li:organization:100000001");
      expect(await getOrganizationUrn()).toBe("urn:li:organization:100000001");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("treats a blank pin as no pin, so a whitespace-only env var still resolves a page", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, ORG_ACL_BODY));
      setLinkedInOrganizationId("   ");
      expect(await getOrganizationUrn()).toBe("urn:li:organization:100000001");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    /**
     * Single-flight. Publish, analytics and the connect check all resolve the org
     * URN, and on a cold pod they run at once: without the in-flight promise each
     * one issues its own `GET /organizationAcls` against an endpoint that is rate
     * limited per application, not per caller. The cached-URN test above cannot
     * catch a regression here, because it only calls again AFTER the first
     * lookup has finished.
     */
    it("shares one organizationAcls lookup between callers that start together", async () => {
      let release!: (res: Response) => void;
      const inFlight = new Promise<Response>((resolve) => {
        release = resolve;
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValue(inFlight);

      const first = getOrganizationUrn();
      const second = getOrganizationUrn();
      release(jsonResponse(200, ORG_ACL_BODY));

      expect(await first).toBe("urn:li:organization:100000001");
      expect(await second).toBe("urn:li:organization:100000001");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("re-resolves after the token resolver is replaced (cache invalidated)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(200, ORG_ACL_BODY));
      await getOrganizationUrn();
      expect(fetch).toHaveBeenCalledTimes(1);
      setLinkedInTokenResolver(async () => TOKEN); // rotation: clears the cached org urn
      await getOrganizationUrn();
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    /**
     * ⛔ INVALIDATION MUST BEAT A LOOKUP THAT IS ALREADY RUNNING. The two tests
     * above both invalidate AFTER the lookup settles, so neither can see the
     * case that matters: the single-flight body assigns `_orgUrn` once its
     * fetch resolves, and it used to do that unconditionally, writing the OLD
     * org back over a cache the setter had just cleared. The blast radius is
     * the one this file's own ⛔ describes as unrecoverable, publishing as a
     * company page nobody chose, with the connection reporting healthy
     * throughout because the credential is valid and only the audience is
     * wrong.
     */
    it("does not let a lookup in flight repopulate the cache a rotation just cleared", async () => {
      let release!: (res: Response) => void;
      const inFlight = new Promise<Response>((resolve) => {
        release = resolve;
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(inFlight);

      const started = getOrganizationUrn();
      setLinkedInTokenResolver(async () => TOKEN); // rotation lands mid-lookup
      release(jsonResponse(200, ORG_ACL_BODY));
      await started;

      // The next caller must go back to the wire rather than be served the
      // pre-rotation org out of a cache that was supposed to be empty.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, ORG_ACL_BODY),
      );
      await getOrganizationUrn();
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("honours a pin set while a list lookup is still in flight", async () => {
      let release!: (res: Response) => void;
      const inFlight = new Promise<Response>((resolve) => {
        release = resolve;
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(inFlight);

      const started = getOrganizationUrn();
      // ⚠️ setLinkedInOrganizationId cleared only `_orgUrn`, so the in-flight
      // promise was still handed to the next caller AND written back. The pin
      // was silently discarded in favour of LinkedIn's list order, which is the
      // precise outcome the pin exists to prevent.
      setLinkedInOrganizationId("9999999");
      release(jsonResponse(200, ORG_ACL_BODY));
      await started;

      expect(await getOrganizationUrn()).toBe("urn:li:organization:9999999");
    });
  });

  describe("createPost", () => {
    it("reads the created post's id from the x-restli-id response header", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY)) // org lookup
        .mockResolvedValueOnce(emptyResponse(201, { "x-restli-id": "urn:li:share:0000000000000000000" }));

      const result = await createPost({ commentary: "hello from Acme" });
      expect(result.ref).toBe("urn:li:share:0000000000000000000");

      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(url).toBe("https://api.linkedin.com/rest/posts");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        author: "urn:li:organization:100000001",
        commentary: "hello from Acme",
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      });
    });

    it("attaches content.media with altText when an image is given", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(emptyResponse(201, { "x-restli-id": "urn:li:share:1" }));

      await createPost({ commentary: "with an image", media: { id: "urn:li:image:abc", altText: "a screenshot" } });

      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({ media: { id: "urn:li:image:abc", altText: "a screenshot" } });
    });

    it("still attaches the image when no alt text was written, rather than dropping it", async () => {
      // ⚠️ Missing alt text is an accessibility shortfall, not a reason to
      // publish a text-only post. The conditional spread is one keystroke away
      // from guarding the whole `content` block instead of just the `altText`
      // key, and the resulting post looks fine until somebody compares it with
      // the draft.
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(emptyResponse(201, { "x-restli-id": "urn:li:share:2" }));

      await createPost({ commentary: "no alt text", media: { id: "urn:li:image:def" } });

      const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({ media: { id: "urn:li:image:def" } });
      expect("altText" in body.content.media).toBe(false);
    });

    it("falls back to a body `id` field when the header is missing", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(jsonResponse(201, { id: "urn:li:share:from-body" }));

      const result = await createPost({ commentary: "no header this time" });
      expect(result.ref).toBe("urn:li:share:from-body");
    });

    it("throws when neither the header nor the body carries an id", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(emptyResponse(201));

      await expect(createPost({ commentary: "orphaned" })).rejects.toThrow(/no id was returned/);
    });

    it("wraps a vendor rejection in a LinkedInError", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(jsonResponse(422, { message: "UNPROCESSABLE_ENTITY" }));

      await expect(createPost({ commentary: "x".repeat(4000) })).rejects.toBeInstanceOf(LinkedInError);
    });
  });

  describe("deletePost", () => {
    it("resolves on a normal successful delete (204)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(emptyResponse(204));
      await expect(deletePost("urn:li:share:123")).resolves.toBeUndefined();
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(`https://api.linkedin.com/rest/posts/${encodeURIComponent("urn:li:share:123")}`);
      expect(init.method).toBe("DELETE");
      expect((init.headers as Record<string, string>)["X-RestLi-Method"]).toBe("DELETE");
    });

    it("passes a genuine 404 through as a LinkedInError (idempotency is the transport's job)", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(404, { message: "NOT_FOUND" }));
      await expect(deletePost("urn:li:share:gone")).rejects.toThrow(LinkedInError);
    });
  });

  describe("getPostsBatch", () => {
    it("returns {results:{}} for an empty ref list without calling the vendor", async () => {
      const result = await getPostsBatch([]);
      expect(result).toEqual({ results: {} });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("builds a List(...) ids param, encodes each urn, and sets the BATCH_GET header", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(200, { results: { "urn:li:share:1": {} }, statuses: {}, errors: {} }),
      );

      await getPostsBatch(["urn:li:share:1", "urn:li:share:2"]);

      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe(
        `https://api.linkedin.com/rest/posts?ids=List(${encodeURIComponent("urn:li:share:1")},${encodeURIComponent("urn:li:share:2")})`,
      );
      expect((init.headers as Record<string, string>)["X-RestLi-Method"]).toBe("BATCH_GET");
    });

    /**
     * ⛔ AN EMPTY BODY MUST READ AS "NO FACTS", NEVER AS "NO POSTS".
     *
     * `request` answers `data: undefined` for a body-less 200 (a proxy, a
     * gateway, LinkedIn answering 204). Without the `?? {results:{}}` the caller
     * dereferences undefined and the whole reconcile batch throws.
     *
     * The shape it degrades to is the load-bearing part: `{results:{}}` carries
     * no `statuses`, so linkedin-transport's postFacts falls to its final branch
     * and answers QUEUE with `absent` UNSET. That is the safe direction. Adding a
     * `statuses` default here that marked the ids 404 would make an unreadable
     * response indistinguishable from a deleted post, and publish-due's overdue
     * sweep would then give up on live posts.
     */
    it("answers an empty result set when the vendor returns no body, rather than throwing", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(emptyResponse(200));
      const result = await getPostsBatch(["urn:li:share:1"]);
      expect(result).toEqual({ results: {} });
      expect(result.statuses).toBeUndefined();
    });
  });

  describe("initializeImageUpload", () => {
    it("returns the uploadUrl and image urn", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            value: { uploadUrl: "https://www.linkedin.com/dms-uploads/abc", image: "urn:li:image:abc" },
          }),
        );

      const result = await initializeImageUpload();
      expect(result).toEqual({ uploadUrl: "https://www.linkedin.com/dms-uploads/abc", image: "urn:li:image:abc" });
    });

    it("throws when the response is missing uploadUrl or image", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, ORG_ACL_BODY))
        .mockResolvedValueOnce(jsonResponse(200, { value: {} }));

      await expect(initializeImageUpload()).rejects.toThrow(/missing uploadUrl\/image/);
    });
  });

  describe("uploadImageBytes", () => {
    it("PUTs the bytes with a bearer token and the given content type", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, text: async () => "", headers: new Headers() });
      const bytes = new Uint8Array([1, 2, 3]);
      await uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", bytes, "image/png");

      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://www.linkedin.com/dms-uploads/abc");
      expect(init.method).toBe("PUT");
      // Sent as a Blob (see linkedin.ts's uploadImageBytes comment: a bare
      // Uint8Array is not accepted by TS's BodyInit typing), so assert on its
      // shape/content rather than reference identity to the original bytes.
      expect(init.body).toBeInstanceOf(Blob);
      expect((init.body as Blob).size).toBe(bytes.byteLength);
      expect((init.body as Blob).type).toBe("image/png");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/png");
    });

    it("throws a LinkedInError on a failed upload", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "upstream error",
        headers: new Headers(),
      });
      await expect(uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", new Uint8Array([1]), "image/png")).rejects.toThrow(
        LinkedInError,
      );
    });

    /**
     * The upload host is not api.linkedin.com and does not go through `request`,
     * so every failure mode has to be re-handled here. These three are the ones
     * that would otherwise escape as a raw fetch rejection: publish.ts catches
     * `LinkedInError` to attribute the failure to LinkedIn, and an AbortError or
     * a bare TypeError arrives as an unattributed crash mid-publish, after the
     * image has already been initialised but before any post exists.
     */
    it("names the 120s budget when the upload never answers", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutErr);

      const err = await uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", new Uint8Array([1]), "image/png").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LinkedInError);
      // The budget, not a generic "timed out": 120s is the upload allowance and
      // is deliberately eight times the plain API one, so an operator reading
      // this line can tell which of the two limits was hit.
      expect((err as LinkedInError).message).toContain("image upload: no response after 120s");
      // The shared wording (vendor-fetch.ts): an upload that timed out may still land.
      expect((err as LinkedInError).message).toContain("check before retrying a publish");
    });

    it("keeps the underlying reason when the connection to the upload host fails", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("fetch failed"));

      const err = await uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", new Uint8Array([1]), "image/png").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).message).toContain("fetch failed");
      expect((err as LinkedInError).status).toBe(0);
    });

    it("survives a rejection that is not an Error at all", async () => {
      // Defensive, and cheap: the cost of getting it wrong is that the one line
      // saying why an upload failed reads "[object Object]" or throws again
      // while building the message.
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue("socket hang up");

      const err = await uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", new Uint8Array([1]), "image/png").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).message).toContain("socket hang up");
    });

    /**
     * ⛔ THE STATUS IS THE PART THAT MATTERS, AND IT IS THE PART A FAILED BODY
     * READ WOULD TAKE WITH IT. Everything downstream classifies by
     * `LinkedInError.status`: retry.ts reads it to decide whether a call may be
     * repeated, and linkedin-transport's `isNotFoundError` reads it to decide
     * whether a delete counts as already-done. If `res.text()` rejecting were
     * allowed to propagate, the throw would be a TypeError with no status and a
     * 502 upload would be indistinguishable from a bug in this client.
     */
    it("still reports the HTTP status when the failure body cannot be read", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => {
          throw new TypeError("terminated");
        },
        headers: new Headers(),
      });

      const err = await uploadImageBytes("https://www.linkedin.com/dms-uploads/abc", new Uint8Array([1]), "image/png").catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).status).toBe(502);
      expect((err as LinkedInError).body).toBe("");
    });
  });

  describe("request error handling", () => {
    it("wraps a fetch-level timeout in a LinkedInError", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutErr);
      await expect(getOrganizationUrn()).rejects.toThrow(/no response after/);
    });

    /**
     * ⚠️ EVERY FETCH-LEVEL FAILURE HAS TO LEAVE THIS FILE AS A `LinkedInError`
     * CARRYING `status: 0`, and the status is the whole point rather than the
     * class. `linkedin-transport`'s `isNotFoundError` asks `err.status === 404`
     * to decide whether a delete may be treated as already-done; an unwrapped
     * `TypeError` has no status, so the question is answered by accident. Status
     * 0 is this engine's shared marker for "no HTTP response was ever received",
     * used identically by reddit.ts, x.ts, pinterest.ts and meta-graph.ts.
     */
    it("wraps a network-level failure as a status-0 LinkedInError, not a bare TypeError", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("fetch failed"));

      const err = await getOrganizationUrn().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).status).toBe(0);
      // The vendor's own words survive: this is the only description of the
      // failure anyone gets, since no HTTP response exists to quote.
      expect((err as LinkedInError).message).toContain("fetch failed");
      expect((err as LinkedInError).message).toContain("/organizationAcls");
    });

    it("describes a rejection that is not an Error rather than losing it", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue("socket hang up");
      await expect(getOrganizationUrn()).rejects.toThrow(/socket hang up/);
    });

    it("throws a LinkedInError when a 200 response is not valid JSON", async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "<html>not json</html>",
        headers: new Headers(),
      });
      await expect(getOrganizationUrn()).rejects.toThrow(/expected JSON/);
    });
  });

  describe("getShareStatistics", () => {
    /**
     * ⚠️ A PAGE WITH NOTHING PUBLISHED YET IS NOT AN ERROR, AND IT IS NOT A ZERO
     * EITHER. LinkedIn answers a share-statistics query for a page with no shares
     * by returning no `elements`. Reporting `{}` says "no figures", which the
     * analytics job records as absent; fabricating `{shareCount: 0}` would put a
     * real-looking zero in a chart next to real-looking numbers.
     */
    it("reports no figures for a page with no shares, and the vendor's own on one that has them", async () => {
      setLinkedInOrganizationId("100000001");
      (fetch as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(jsonResponse(200, {}))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            elements: [
              {
                totalShareStatistics: {
                  shareCount: 4,
                  // ⚠️ engagement is a RATIO and is passed through unscaled. A
                  // test that rounded it would hide the client silently turning
                  // 0.0125 into 1.
                  engagement: 0.0125,
                  // Not a number, so it must not reach the caller at all.
                  clickCount: null,
                },
              },
            ],
          }),
        );

      expect(await getShareStatistics()).toEqual({});
      expect(await getShareStatistics()).toEqual({ shareCount: 4, engagement: 0.0125 });
    });
  });

  describe("linkedInPostStatsFilter", () => {
    it("maps share and ugcPost URNs to their filter and refuses everything else", () => {
      expect(linkedInPostStatsFilter(FIXTURE_LINKEDIN_SHARE_URN)).toBe("shares");
      expect(linkedInPostStatsFilter(FIXTURE_LINKEDIN_UGC_URN)).toBe("ugcPosts");
      for (const bad of [
        "",
        FIXTURE_LINKEDIN_POST_ID,
        "urn:li:share:",
        "urn:li:share:12x",
        "urn:li:ugcpost:1",
        "urn:li:activity:1",
        "urn:li:comment:(urn:li:activity:1,2)",
        " urn:li:share:1",
      ]) {
        expect(linkedInPostStatsFilter(bad), bad).toBeNull();
      }
    });
  });

  describe("getPostShareStatistics", () => {
    const SHARE = FIXTURE_LINKEDIN_SHARE_URN;
    const UGC = FIXTURE_LINKEDIN_UGC_URN;
    const ORG = FIXTURE_LINKEDIN_ORG_URN;
    const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

    beforeEach(() => setLinkedInOrganizationId(FIXTURE_LINKEDIN_ORG));

    /**
     * The exact request, character for character: the org URN encoded as in
     * getShareStatistics, the post URN encoded INSIDE an unencoded List(...),
     * which is the docs' own example and the rule getPostsBatch follows.
     */
    it("asks for one share with shares=List(encoded urn) under the pinned version headers", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, {
          elements: [{ organizationalEntity: ORG, share: SHARE, totalShareStatistics: { impressionCount: 5287 } }],
        }),
      );

      expect(await getPostShareStatistics(SHARE)).toEqual({ impressionCount: 5287 });

      const [url, init] = fetchMock().mock.calls[0];
      expect(url).toBe(
        "https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity" +
          `&organizationalEntity=urn%3Ali%3Aorganization%3A${FIXTURE_LINKEDIN_ORG}` +
          `&shares=List(urn%3Ali%3Ashare%3A${FIXTURE_LINKEDIN_POST_ID})`,
      );
      expect(init.method).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers["LinkedIn-Version"]).toBe(LINKEDIN_VERSION);
      expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(url).not.toContain("timeIntervals");
    });

    it("asks for a ugcPost with ugcPosts=List(...) and matches the element by its ugcPost field", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, {
          elements: [{ organizationalEntity: ORG, ugcPost: UGC, totalShareStatistics: { clickCount: 7 } }],
        }),
      );

      expect(await getPostShareStatistics(UGC)).toEqual({ clickCount: 7 });
      expect(fetchMock().mock.calls[0][0]).toMatch(new RegExp(`&ugcPosts=List\\(urn%3Ali%3AugcPost%3A${FIXTURE_LINKEDIN_POST_ID_2}\\)$`));
    });

    /**
     * Every documented field passes through unrenamed. engagement is a ratio and
     * stays the vendor's float; a negative likeCount is documented (a sponsored
     * like later unliked) and is a real datum; a zero is kept; a non-number is
     * dropped rather than becoming 0.
     */
    it("passes LinkedIn's own fields through, keeping zeros and negatives and dropping non-numbers", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, {
          elements: [
            {
              organizationalEntity: ORG,
              share: SHARE,
              totalShareStatistics: {
                clickCount: 78,
                commentCount: 24,
                engagement: 0.022886324947985624,
                impressionCount: 5287,
                uniqueImpressionsCount: 4100,
                likeCount: -1,
                shareCount: 0,
                bogus: "12",
                missing: null,
              },
            },
          ],
        }),
      );

      expect(await getPostShareStatistics(SHARE)).toEqual({
        clickCount: 78,
        commentCount: 24,
        engagement: 0.022886324947985624,
        impressionCount: 5287,
        uniqueImpressionsCount: 4100,
        likeCount: -1,
        shareCount: 0,
      });
    });

    const ZEROS = {
      clickCount: 0,
      commentCount: 0,
      engagement: 0,
      impressionCount: 0,
      likeCount: 0,
      shareCount: 0,
      uniqueImpressionsCount: 0,
    };

    /**
     * Pinned: the seven fields of the docs' "Share Statistics Data Schema"
     * table. Adding or dropping one changes what an omitted post reports.
     */
    it("pins the zero-filled fields to the documented totalShareStatistics schema", () => {
      expect([...LINKEDIN_POST_STAT_FIELDS]).toEqual(Object.keys(ZEROS));
    });

    /**
     * ⛔ The page aggregate (no `share` or `ugcPost` field) is what an ignored
     * filter would return. It is never attributed to the post, and it is not
     * "post omitted" either, so it throws rather than becoming zeros.
     */
    it("throws, rather than attributing or zero-filling, when LinkedIn answers the page aggregate", async () => {
      fetchMock().mockResolvedValue(
        jsonResponse(200, { elements: [{ organizationalEntity: ORG, totalShareStatistics: { impressionCount: 14490816 } }] }),
      );
      const err = await getPostShareStatistics(SHARE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).message).toMatch(/page aggregate; the filter was not applied/);
    });

    /**
     * The docs say an omitted post "can be assumed
     * to have counts of 0 for all statistics", so a successful answer with no
     * element for THIS post reports zeros. Another post's element is not a
     * match, and a ugcPost query reads the `ugcPost` field, not `share`.
     */
    it("reports zeros when LinkedIn answers without an element for this post", async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse(200, { elements: [] }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            elements: [{ organizationalEntity: ORG, share: "urn:li:share:1", totalShareStatistics: { impressionCount: 9 } }],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            elements: [{ organizationalEntity: ORG, share: UGC, totalShareStatistics: { impressionCount: 9 } }],
          }),
        );

      expect(await getPostShareStatistics(SHARE)).toEqual(ZEROS);
      expect(await getPostShareStatistics(SHARE)).toEqual(ZEROS);
      expect(await getPostShareStatistics(UGC)).toEqual(ZEROS);
    });

    /**
     * Zeros only for the documented answer, an `elements` array. A body with
     * no `elements` (an empty 200 from a proxy) or a matched element with no
     * totals is not that answer and stays "no figures".
     */
    it("answers no figures for a body without elements or a matched element without totals", async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse(200, { elements: [{ organizationalEntity: ORG, share: SHARE }] }))
        .mockResolvedValueOnce(emptyResponse(200))
        .mockResolvedValueOnce(jsonResponse(200, {}));

      expect(await getPostShareStatistics(SHARE)).toEqual({});
      expect(await getPostShareStatistics(SHARE)).toEqual({});
      expect(await getPostShareStatistics(SHARE)).toEqual({});
    });

    /** ⛔ A failed call is never an omitted post: errors throw, never zeros. */
    it("never turns a vendor error or a network failure into zeros", async () => {
      fetchMock()
        .mockResolvedValueOnce(jsonResponse(500, { message: "Internal Server Error" }))
        .mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(getPostShareStatistics(SHARE)).rejects.toMatchObject({ status: 500 });
      await expect(getPostShareStatistics(SHARE)).rejects.toThrow(/fetch failed/);
    });

    it("surfaces a vendor refusal as a LinkedInError carrying the status", async () => {
      fetchMock().mockResolvedValue(jsonResponse(403, { message: "Not enough permissions to access" }));
      const err = await getPostShareStatistics(SHARE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).status).toBe(403);
      expect((err as LinkedInError).message).toContain("/organizationalEntityShareStatistics");
    });

    it("refuses a ref that is not a share or ugcPost URN without calling LinkedIn", async () => {
      const err = await getPostShareStatistics("urn:li:activity:1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LinkedInError);
      expect((err as LinkedInError).status).toBe(0);
      expect((err as LinkedInError).message).toMatch(/not a LinkedIn share or ugcPost URN: "urn:li:activity:1"/);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
