import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proofArtifacts } from "./helpers/proof-artifacts.js";

/**
 * The sweeper is the safety net under every live proof, so it needs its own
 * evidence. Its failure mode is not "a test goes red": it is a real post left
 * live on a real account, discovered by a human scrolling the feed.
 */
describe("proofArtifacts", () => {
  // Typed to the Deleter signature rather than a bare `ReturnType<typeof
  // vi.fn>`: untyped, it infers as `Procedure | Constructable`, which is not
  // assignable to `{ deletePost(ref: string): Promise<void> }` at any call site.
  let deletePost: ReturnType<typeof vi.fn<(ref: string) => Promise<void>>>;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    deletePost = vi.fn(async () => {});
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * The whole point: an assertion throwing between publish and delete must not
   * leave the post up.
   */
  it("deletes a tracked ref that was never untracked", async () => {
    const a = proofArtifacts("bluesky", { deletePost });
    a.track("at://did:plc:x/post/1", "https://bsky.app/p/1");

    await a.sweep();

    expect(deletePost).toHaveBeenCalledWith("at://did:plc:x/post/1");
  });

  it("does not re-delete a ref the test already cleaned up", async () => {
    const a = proofArtifacts("bluesky", { deletePost });
    a.track("ref-1");
    a.untrack("ref-1");

    await a.sweep();

    expect(deletePost).not.toHaveBeenCalled();
  });

  /**
   * ⛔ An error escaping afterAll REPLACES the real assertion failure in
   * vitest's output, hiding the reason the stray happened at all.
   */
  it("never rejects when the vendor delete fails", async () => {
    deletePost.mockRejectedValue(new Error("403 Forbidden"));
    const a = proofArtifacts("instagram", { deletePost });
    a.track("17900000000000000", "https://instagram.com/p/abc");

    await expect(a.sweep()).resolves.toBeUndefined();
  });

  it("shouts, with the URL, when a stray could not be swept", async () => {
    deletePost.mockRejectedValue(new Error("403 Forbidden"));
    const a = proofArtifacts("instagram", { deletePost });
    a.track("17900000000000000", "https://instagram.com/p/abc");

    await a.sweep();

    expect(errors.join("\n")).toContain("STRAY instagram");
    // The URL is what makes the message actionable: a human has to open it.
    expect(errors.join("\n")).toContain("https://instagram.com/p/abc");
    expect(errors.join("\n")).toContain("DELETE BY HAND");
  });

  /**
   * A hard process kill runs no hooks, so the sweep cannot help. The line
   * printed at creation time is then the only recovery path, which is why it
   * must happen before any assertion rather than at cleanup.
   */
  it("logs the ref synchronously at track() time, not at sweep() time", () => {
    const a = proofArtifacts("threads", { deletePost });
    a.track("ref-9", "https://threads.net/p/9");

    expect(logs.join("\n")).toContain("[proof] created threads ref-9");
    expect(logs.join("\n")).toContain("https://threads.net/p/9");
  });

  it("names a non-Error sweep failure by value rather than printing undefined", async () => {
    deletePost.mockRejectedValue("rate limited");
    const a = proofArtifacts("x", { deletePost });
    a.track("ref-x");

    await a.sweep();

    expect(errors.join("\n")).toContain("STRAY x ref-x");
    expect(errors.join("\n")).toContain("(sweep failed: rate limited)");
  });

  it("keeps sweeping after one ref fails", async () => {
    deletePost.mockRejectedValueOnce(new Error("boom"));
    const a = proofArtifacts("facebook", { deletePost });
    a.track("ref-a");
    a.track("ref-b");

    await a.sweep();

    expect(deletePost).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when nothing was tracked", async () => {
    const a = proofArtifacts("bluesky", { deletePost });
    await a.sweep();
    expect(deletePost).not.toHaveBeenCalled();
  });

  /** Sweeping twice must not double-delete: afterAll can run once per file. */
  it("clears what it swept", async () => {
    const a = proofArtifacts("bluesky", { deletePost });
    a.track("ref-1");

    await a.sweep();
    await a.sweep();

    expect(deletePost).toHaveBeenCalledTimes(1);
  });
});
