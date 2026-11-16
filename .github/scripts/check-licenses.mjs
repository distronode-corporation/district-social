#!/usr/bin/env node
// Every package in package-lock.json must carry a licence from the allowlist below. The
// lockfile records each package's `license` field, so this needs no install and no network.
//
// Permissive licences are allowed everywhere. MPL-2.0 (file-level copyleft) is allowed only
// for development dependencies, which are never shipped in the published package: today that
// is lightningcss, pulled in by vitest's vite. A missing licence fails, and so does anything
// not listed. An SPDX expression passes when an OR has one allowed side and an AND has every
// side allowed.
//
//   node .github/scripts/check-licenses.mjs [path/to/package-lock.json]
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

/** True when the SPDX expression is acceptable under `allowed`. */
function accepts(expr, allowed) {
  const e = expr.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/\sOR\s/.test(e)) return e.split(/\sOR\s/).some((part) => accepts(part, allowed));
  if (/\sAND\s/.test(e)) return e.split(/\sAND\s/).every((part) => accepts(part, allowed));
  return allowed.has(e);
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
