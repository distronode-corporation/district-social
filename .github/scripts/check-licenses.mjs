#!/usr/bin/env node

// SPDX-FileCopyrightText: Distronode Corporation
//
// SPDX-License-Identifier: Apache-2.0

// Every package in package-lock.json must carry a licence from the allowlist below. The
// lockfile records each package's `license` field, so this needs no install and no network.
//
// Permissive licences are allowed everywhere. MPL-2.0 (file-level copyleft) is allowed only
// for development dependencies, which are never shipped in the published package: today that
// is lightningcss, pulled in by vitest's vite. A missing licence fails, and so does anything
// not listed. An SPDX expression is parsed with SPDX precedence (AND binds tighter than OR,
// parentheses group) and passes when an OR has one allowed side and an AND has every side
// allowed. Anything the parser does not understand fails, `WITH` exceptions included.
//
//   node .github/scripts/check-licenses.mjs [path/to/package-lock.json]
//   node .github/scripts/check-licenses.mjs --self-test
import { readFileSync } from "node:fs";

const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
]);
const DEV_ONLY = new Set(["MPL-2.0"]);

/**
 * True when the SPDX expression is acceptable under `allowed`; false when it is not, or
 * when it is not an expression this parser understands.
 *   or   := and ("OR" and)*
 *   and  := atom ("AND" atom)*
 *   atom := "(" or ")" | licence-id
 */
function accepts(expr, allowed) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const fail = () => {
    throw new Error(`cannot parse licence expression: ${expr}`);
  };
  const atom = () => {
    const t = tokens[i++];
    if (t === "(") {
      const v = or();
      if (tokens[i++] !== ")") fail();
      return v;
    }
    if (t === undefined || t === ")" || /^(AND|OR|WITH)$/i.test(t)) fail();
    return allowed.has(t);
  };
  const and = () => {
    let v = atom();
    while (tokens[i] === "AND") {
      i++;
      v = atom() && v; // evaluate the right side first, so a parse error is never skipped
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

if (process.argv[2] === "--self-test") {
  const a = new Set(["MIT", "ISC"]);
  const cases = [
    ["MIT", true],
    ["GPL-3.0-only", false],
    ["(MIT OR ISC)", true],
    ["MIT OR GPL-3.0-only", true],
    ["MIT AND GPL-3.0-only", false],
    ["MIT OR GPL-3.0-only AND GPL-2.0-only", true], // AND binds tighter
    ["(MIT OR GPL-3.0-only) AND (GPL-3.0-only)", false],
    ["(MIT OR GPL-3.0-only) AND ISC", true],
    ["((MIT))", true],
    ["(MIT", false],
    ["MIT)", false],
    ["MIT OR", false],
    ["AND MIT", false],
    ["MIT ISC", false],
    ["MIT WITH LLVM-exception", false],
    ["", false],
  ];
  const wrong = cases.filter(([e, want]) => accepts(e, a) !== want);
  for (const [e, want] of wrong) console.error(`::error::self-test: "${e}" should be ${want}`);
  if (wrong.length > 0) process.exit(1);
  console.log(`self-test: ${cases.length} expressions as expected`);
  process.exit(0);
}

const lockPath = process.argv[2] ?? "package-lock.json";
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object") {
  console.error(`::error::${lockPath} is not a lockfileVersion 3 lockfile`);
  process.exit(1);
}

const devAllowed = new Set([...PERMISSIVE, ...DEV_ONLY]);
const bad = [];
let checked = 0;
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (path === "") continue; // the root project itself
  checked++;
  const license = typeof pkg.license === "string" ? pkg.license : "";
  const allowed = pkg.dev === true ? devAllowed : PERMISSIVE;
  if (!license || !accepts(license, allowed)) {
    bad.push(`${path} ${pkg.version ?? "?"}: ${license || "(no licence)"}${pkg.dev ? " (dev)" : ""}`);
  }
}

if (bad.length > 0) {
  for (const line of bad) console.error(`::error::licence not on the allowlist: ${line}`);
  process.exit(1);
}
console.log(`${checked} packages checked, every licence is on the allowlist`);
