/**
 * Stray-post insurance for the live proofs.
 *
 * ⛔ THE PROBLEM THIS EXISTS FOR. Every live proof publishes a REAL post to a
 * REAL account and then deletes it, with assertions in between. Those
 * assertions are the whole point ("the call returned 200" is exactly what
 * these tests refuse to trust), but they sit between the create and the delete,
 * so ANY of them throwing leaves the post live and permanent:
 *
 *     const posted = await transport.publishNow(...)   // real post, now public
 *     expect(...)                                       // ← throws here
 *     await transport.deletePost(posted.ref)            // never runs
 *
 * and vitest reports that as an ordinary failed assertion. Nothing says "there
 * is now a test post on a real account". The same happens on a vendor
 * timeout, an unhandled-request error from the test harness, or a
 * `--testTimeout` kill.
 *
 * So: register the ref the instant it exists, sweep whatever is still
 * outstanding in `afterAll`.
 *
 * Three details that are load-bearing rather than stylistic:
 *
 *  1. `track()` LOGS SYNCHRONOUSLY, before any assertion runs. A hard process
 *     kill (Ctrl-C, an OOM, a vitest worker timeout) runs no hooks at all, so
 *     the sweep cannot help there: the printed line is the operator's only
 *     recovery path. Grep the run output for `[proof] created`.
 *  2. `sweep()` NEVER THROWS. An error escaping `afterAll` replaces the real
 *     assertion failure in vitest's output with a cleanup error, hiding the
 *     reason the stray happened in the first place.
 *  3. Deleting is safe to repeat. `DirectTransport.deletePost` is idempotent by
 *     contract on every platform ("an already-gone post is a success, not an
 *     error", transport.ts), which is what makes an unconditional sweep of
 *     already-deleted refs free rather than noisy.
 */

type Deleter = { deletePost(ref: string): Promise<void> };

export interface ProofArtifacts {
  /** Call on the line immediately after publish returns, before any assertion. */
  track(ref: string, url?: string): void;
  /** Call after a successful in-test delete, so the sweep stays a no-op. */
  untrack(ref: string): void;
  /** Register as `afterAll(artifacts.sweep)`. Never rejects. */
  sweep(): Promise<void>;
}

export function proofArtifacts(platform: string, transport: Deleter): ProofArtifacts {
  const outstanding = new Map<string, string | undefined>();

  return {
    track(ref, url) {
      outstanding.set(ref, url);
      console.log(`[proof] created ${platform} ${ref}${url ? ` -> ${url}` : ""}`);
    },

    untrack(ref) {
      outstanding.delete(ref);
    },

    async sweep() {
      if (outstanding.size === 0) return;

      for (const [ref, url] of outstanding) {
        try {
          await transport.deletePost(ref);
          console.warn(
            `[proof] swept a stray ${platform} post that a failed assertion left live: ${ref}`,
          );
        } catch (err) {
          // The one case a human must act on. Loud, and carries the URL,
          // because at this point the post is still up on a real account.
          console.error(
            `⛔ [proof] STRAY ${platform} ${url ?? ref}: DELETE BY HAND ` +
              `(sweep failed: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      outstanding.clear();
    },
  };
}
