/**
 * The three old helper paths (vendor-fetch, retry, meta-graph) are shims over
 * engine/http/. Each must hand out the SAME bindings
 * as its http/ module, not a copy: `instanceof MetaGraphError` and the
 * `setMetaCredentialsResolver` singleton only work when both paths resolve to
 * one module instance.
 */
import { describe, expect, it } from "vitest";

import * as metaGraphShim from "../meta-graph.js";
import * as retryShim from "../retry.js";
import * as vendorFetchShim from "../vendor-fetch.js";
import * as metaGraph from "../http/meta-graph.js";
import * as retry from "../http/retry.js";
import * as vendorFetch from "../http/vendor-fetch.js";

describe("engine http shims", () => {
  it.each([
    ["meta-graph", metaGraphShim, metaGraph],
    ["retry", retryShim, retry],
    ["vendor-fetch", vendorFetchShim, vendorFetch],
  ] as const)("%s re-exports every binding of http/%s by identity", (_name, shim, real) => {
    const names = Object.keys(real).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(shim).sort()).toEqual(names);
    for (const name of names) {
      expect((shim as Record<string, unknown>)[name]).toBe((real as Record<string, unknown>)[name]);
    }
  });
});
