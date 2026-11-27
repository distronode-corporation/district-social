// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Required configuration for a live proof.
 *
 * Every account-identifying value a proof uses (the credential, the target
 * id, the account it expects to write to) comes from the environment with NO
 * default. A default would be some particular operator's account, and a proof
 * that silently falls back to one writes to an account the person running it
 * may not own.
 *
 * Call it from `beforeAll` inside the gated `describe`, so it only ever runs
 * when the proof is enabled. A missing variable fails the whole file with one
 * line naming every variable still to set, instead of as an opaque vendor 401
 * three tests later.
 */
export function requireEnv<const N extends string>(names: readonly N[]): Record<N, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(
      `live proof: set ${missing.join(", ")} (export them from your own secret store)`,
    );
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n] as string])) as Record<N, string>;
}
