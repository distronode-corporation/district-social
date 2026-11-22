# Contributing to district-social

Thanks for helping. This file says how to run what CI runs, and the few rules that are not
negotiable.

## Status

The engine (`src/`) and the CLI (`scripts/social/`) are here and pass the gate below. The npm
package, released from a version tag (see Releasing), is the engine alone; the CLI runs from
a clone.

## Setup

You need Node.js 24 (`.nvmrc`, what CI uses) and npm 11. The package supports Node.js 22
and later (`engines`), and CI also runs the tests on Node 22.

```
npm ci             # install exactly what package-lock.json says
npm run check      # lint, type-check, build and the tests with coverage, in that order
```

`npx vitest run <file>` runs one test file. Tests need no network: anything that talks to a
social network's API is tested against an in-process fake.

## The whole local gate

This is every job in `.github/workflows/ci.yml`. All of it must be green on a pull request.

```
npm ci
npm run lint        # eslint, typescript-eslint's recommended type-checked rules
npm run typecheck   # tsc --noEmit, strict, sources, tests and configs included
npm run build       # tsc -p tsconfig.build.json, the dist/ that release.yml publishes
npm test            # vitest run --coverage, thresholds at 100 percent
```

The build is repeatable. The `typecheck` job packs the package, deletes `dist/`, builds and
packs it again, and fails unless the two tarballs have the same sha256. npm pack fixes every
file's timestamp in the tarball, so a change that makes the output depend on the time breaks
it. Both builds run on the same runner, so the check does not prove that a build on another
machine gives the same tarball.

The other workflows run checks that need no setup on your side: CodeQL, OpenSSF Scorecard,
dependency review, zizmor on the workflows, gitleaks on the history, and a licence allowlist
over `package-lock.json` (`node .github/scripts/check-licenses.mjs --self-test`, then
without the flag, runs it locally).

## Style

Code follows typescript-eslint's recommended type-checked rules on top of ESLint's
recommended rules, configured in `eslint.config.js`, and TypeScript's `strict` mode
(`tsconfig.json`). CI runs both (`npm run lint`, `npm run typecheck`), lint fails on any
warning (`--max-warnings 0`), and a use of a deprecated API is an error
(`@typescript-eslint/no-deprecated`). A pull request that fails either does not merge.
`.editorconfig` sets the whitespace.

## Tests

A pull request that adds or changes functionality adds tests for it to the automated suite
(`npm test`), and a bug fix adds a test that fails without the fix. CI runs the suite on
every pull request and every push to main, and it is a required check.

## Coverage is 100 percent

Every source file under `src/` (test files aside) is held at 100 percent line, branch, function and statement coverage,
per file, by the thresholds in `vitest.config.ts`. The rules that go with it:

- A reachable branch gets a test. Guards and parsers get hostile input, not just the
  happy path.
- An unreachable branch is dead code: delete it, with a one-line comment if the reason is
  not obvious. Do not add it to a coverage exclude.
- No `v8 ignore`, `istanbul ignore` or `c8 ignore` comments.
- Do not mock a dependency into a state it cannot produce. A test that passes only against
  an impossible mock proves nothing.
- If coverage is reached only on some runs (timers, socket races, test order), make the
  test deterministic rather than re-running until it passes.

## Dependencies

- **Pinned exactly.** `"1.2.3"`, never `^1.2.3` or `~1.2.3`. `package-lock.json` is
  committed and CI installs with `npm ci`.
- **At least 7 days old.** A new dependency, or a new version of an existing one, must have
  been published at least seven days before the pull request adds it. A compromised
  release is usually caught and pulled within days; the wait keeps it out of this tree.
  Dependabot applies the same 7-day cooldown to its routine version updates. A security
  update is the exception: Dependabot opens it as soon as the advisory lands, and a person
  reviews it like any other change.
- **Overrides are for advisories.** `overrides.minimatch` lifts eslint's and
  typescript-eslint's `minimatch` 10.x to a release with the fix for GHSA-g3hv-75wg-m249
  (patched in 11.0.1). Drop it once both depend on a patched range.
- **TypeScript follows typescript-eslint.** TypeScript is 6.0, the newest line in
  typescript-eslint's peer range; TypeScript 7 has no JavaScript API for it to load yet.
- **Few, and permissive.** Prefer the standard library and the existing dependencies. Say in
  the pull request why a new dependency is worth its weight. Its licence must be on the
  allowlist in `.github/scripts/check-licenses.mjs`.

## Releasing

A release is a `vX.Y.Z` tag on main, and `.github/workflows/release.yml` publishes the package
to npm from it, with trusted publishing (no stored token) and a provenance attestation. The
publish job runs only while the `NPM_PUBLISH` repository variable is `true`; otherwise a tag
runs the checks and packs the tarball, and nothing is published, so a green tag run is not
proof of a release. After the publish, the same workflow attaches the tarball, `SHA256SUMS`
and npm's provenance for it to the GitHub release for the tag, creating the release from the
CHANGELOG section when there is none. The
version bump is a pull request first: it sets `version` in `package.json` and
`package-lock.json`, and moves the CHANGELOG's Unreleased section to `[X.Y.Z]`. A release is
never re-tagged: a bad one gets a new patch version.

## Commits and pull requests

Conventional Commits are not required. What is required is that the message says **why**,
not just what. The diff already says what.

There is no Developer Certificate of Origin sign-off requirement. By opening a pull
request you agree that your contribution is licensed under the Apache License, Version
2.0, as section 5 of that licence describes.

Keep pull requests focused: one change, with its tests and docs. Documentation moves with
the code: a change in behaviour updates README.md, ARCHITECTURE.md, SECURITY-MODEL.md or
SECURITY.md in the same pull request when it changes what they say. How changes are
reviewed and accepted is in the organization's
[GOVERNANCE.md](https://github.com/distronode-corporation/.github/blob/main/GOVERNANCE.md).

## Reporting bugs

Open an issue with the bug report form: what you ran, what happened and what you expected,
plus the package and Node versions. Never paste an access token, API key or password.

For anything security-relevant, do not open an issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
