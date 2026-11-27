// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The guard that keeps every other live proof safe.
 *
 * ⛔ `*.live.proof.test.ts` files PUBLISH TO REAL ACCOUNTS. They are safe
 * only because each is wrapped in `describe.runIf(process.env.RUN_<X> === "1")`,
 * so a normal `vitest run` collects them and executes nothing.
 *
 * That safety is one deleted line away from failing, and it fails SILENTLY in
 * the worst possible direction: nobody notices a proof that started running,
 * they notice a test post on a real account. Worse, the existing failure mode
 * is already invisible: a gated proof reports as **skipped and green**, which
 * is indistinguishable from having run, so a green CI can carry zero live
 * coverage for as long as nobody looks.
 *
 * So this test asserts the gate itself, in the ordinary suite, where it costs
 * nothing:
 *   1. every proof file is gated, and
 *   2. no gate variable is set in the environment running this suite.
 *
 * (2) is what stops CI or a stray `.env` from turning a green pipeline into a
 * publish. It is deliberately an assertion rather than a lint rule so that it
 * runs in the same process, against the same env, as the proofs it protects.
 */

const PROOF_DIR = join(__dirname);
const PROOF_SUFFIX = ".live.proof.test.ts";

function proofFiles(): string[] {
  return readdirSync(PROOF_DIR).filter((f) => f.endsWith(PROOF_SUFFIX));
}

describe("live proof gating", () => {
  it("finds the proof files (a zero-length sweep would pass vacuously)", () => {
    // Without this, deleting or renaming every proof would make the checks
    // below succeed against an empty list and report all-clear.
    expect(proofFiles().length).toBeGreaterThan(0);
  });

  /**
   * `runIf(enabled)` and `skipIf(!enabled)` are equivalent, so accept either,
   * but nothing else, because the point is that the decision is made by an
   * explicit vitest gate rather than an early `return` or a commented-out
   * block, which read as gated and are not.
   */
  it("gates every live proof behind describe.runIf or describe.skipIf", () => {
    const ungated = proofFiles().filter((f) => {
      const src = readFileSync(join(PROOF_DIR, f), "utf8");
      return !/describe\.(runIf|skipIf)\s*\(/.test(src);
    });
    expect(ungated, `these publish to real accounts with no gate: ${ungated.join(", ")}`).toEqual(
      [],
    );
  });

  it("gates every live proof on an explicit RUN_* environment variable", () => {
    const missing = proofFiles().filter((f) => {
      const src = readFileSync(join(PROOF_DIR, f), "utf8");
      return !/process\.env\.RUN_[A-Z0-9_]+/.test(src);
    });
    expect(missing, `no RUN_* gate found in: ${missing.join(", ")}`).toEqual([]);
  });

  /**
   * The one that actually protects CI. If a `RUN_*_PROOF` variable is ever set
   * in an automated environment, the proofs stop being inert and start posting.
   */
  it("has no proof gate enabled in the current environment", () => {
    const enabled = Object.keys(process.env).filter(
      (k) => /^RUN_[A-Z0-9_]*PROOF$/.test(k) && process.env[k] === "1",
    );
    expect(
      enabled,
      `live-proof gates are ON in this environment: ${enabled.join(", ")}. ` +
        `If this is CI, that is a publish waiting to happen.`,
    ).toEqual([]);
  });
});
