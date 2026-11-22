# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release workflow note: `.github/workflows/release.yml` publishes to npm from a `vX.Y.Z` tag
whose version equals `package.json`, and only while the `NPM_PUBLISH` repository variable is
`true`; otherwise a tag runs the checks and packs the tarball without publishing. Move the Unreleased section to `## [X.Y.Z] - YYYY-MM-DD`
in the version bump, before the tag.

## [Unreleased]

### Added

- Release assets. A tag's release workflow now attaches the npm tarball, `SHA256SUMS` and the
  provenance npm recorded for it (`.sigstore.json` and `.intoto.jsonl`) to the GitHub
  release, and SECURITY.md says how to verify them.
- Community health files: issue forms, a pull request template and SUPPORT.md, plus a threat
  model in SECURITY.md and badges in the README.
- ARCHITECTURE.md (the parts of the engine, the pipeline and where state lives) and
  SECURITY-MODEL.md (threat model, trust boundaries, secure design principles and the
  weaknesses the code counters). The README gains a quick start and uninstall steps, and
  CONTRIBUTING.md states the style and test rules a change is held to.
- CI checks that the build is repeatable: a second build from the same commit packs to the
  same bytes.

### Changed

- Lint fails on any warning, and a use of a deprecated API is a lint error.
- Media asset fetches go through the SSRF guard (`src/ssrf.ts`): an asset URL must be
  public HTTPS, the connection is pinned to the address that was checked, and a redirect is
  refused rather than followed.
- Bluesky runs on the engine's own AT Protocol client (`src/bluesky-xrpc.ts`) instead of
  `@atproto/api`: direct XRPC calls for the session, posts, replies, deletes, image uploads
  and reads. Stored sessions resume as before, and the exported types keep their shape.
  - Every Bluesky response is checked field by field against a schema
    (`src/bluesky-schemas.ts`). An answer that does not fit is a `ResponseShapeError` naming
    the field, and on a create it counts as an unknown outcome, so the post is never sent
    twice.
  - The client follows the account's PDS only over https to a public address, and follows
    no redirect.
  - An expired access token is refreshed and the request sent once more, only after the
    refresh succeeded; a 5xx or a request with no answer is never repeated.
  - Facet detection is a port of the library's (`src/bluesky-richtext.ts`), checked against
    its own output. A mention whose handle does not resolve is left as plain text instead of
    a facet with an empty DID.
  - A post over 300 graphemes or 3000 UTF-8 bytes, or with more than four images, is refused
    before anything is sent.
  - New runtime dependencies: `zod` 4.6.6 (the schemas) and `tlds` 1.261.0 (the domain list
    facet detection checks against). NOTICE credits the AT Protocol code the client derives
    from.

### Fixed

- zod advisory GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating a large array): with
  `@atproto/api` gone, the package depends on zod 4.6.6 directly, so an install of it no
  longer resolves zod 3, and the `overrides.zod` this repository carried is dropped. The
  dependency review no longer allows the advisory. The 5 MiB cap on Bluesky responses stays
  (#6).
- A Bluesky session still opening when the credentials resolver or the session store is
  replaced is no longer cached or returned, and no longer writes to the store.
- Linear time on long input: the trailing delimiter trim when a link leaves a long line, the
  fabricated-testimonial check, and the YouTube description's byte truncation.

## [0.1.0] - 2026-11-16

The first release. The npm package is the engine: ES modules with TypeScript declarations,
for Node.js 22 or later. The CLI is in the repository and runs from a clone.

### Added

- The engine (#2). `createEngine` binds a brand pack (the brief every model call reads, plus
  optional QA gates) and the ports an application provides: a clock, a model, and optionally
  stores for drafts, credentials and media, a lock and an approval gate. Every port has an
  in-memory implementation, so a single process runs with no infrastructure.
- Formatting (#2). `formatPost` turns one source post into a render per network from a
  model's structured output, and the engine writes image alt text. Per-network playbooks
  then trim hashtags and move or drop body links in code, so those rules do not depend on
  the model following its prompt.
- QA (#2). `runQa` checks each render against its network's limits and media rules, the
  limits each connected transport declares, the brand pack's compliance gates and an
  optional model review, and returns one pass or fail report (`qaScore` gives it a weighted
  score).
- Revision (#2). `applyMechanicalFixes` clears the issues that are text or media-count edits
  without a model call; `reviseRenders` asks the model for the smallest edit that clears the
  issues still open on the current copy.
- Publishing (#2). `publishDraft` sends each render through its network's own API:
  Instagram, Facebook, Threads, X, LinkedIn, YouTube, Reddit, Bluesky, Pinterest and TikTok.
  A transport override can route a network through an aggregator instead (Zernio is the one
  included). Images are fitted to each destination's limits at publish time, through a
  fitter the application injects.
- Approvals (#2). The `ApprovalGate` port is a single-use approval for one draft and a hash
  of its exact renders, with an in-memory gate. The port has no call that grants an
  approval. `publishDraft` does not consult the gate in this release: the application
  consumes the approval before it publishes.
- Models (#2). The default model client is Claude, with your own Anthropic API key (read
  through `setSecretGetter`) or Anthropic workload identity federation, and any `LlmClient`
  with the same contract can replace it. Video generation is Vertex AI Veo
  (`startVideoGeneration`, `pollVideoOperation`) in your own Google Cloud project.
- Bluesky sessions are bound to the account they were created for (#4). A stored session
  carries a hash of the configured identifier and is resumed only when that matches; a
  session for another identifier, or one stored without the hash, is dropped and the
  configured account logs in once.
- Trims that run in linear time (#4). The trailing-character trims CodeQL flagged as
  polynomial-time regular expressions (URL punctuation in QA and link placement, slashes in
  subreddit names and media base URLs, line-end whitespace in the Threads topic-tag lift)
  give the same output without slowing down on long runs of those characters.
- The CLI, `scripts/social/` (#2). A client of an agent API built on this engine, with
  `new`, `list`, `show`, `qa`, `preflight`, `publish`, `unschedule`, `accounts`, `evidence`
  and `profiles`. It authenticates with a Google ID token from Application Default
  Credentials, sends requests only to the configured https origin, and publishes only by
  citing the id of an approval a person created for that draft.
- The project. CI runs lint, type-check, build and tests at 100 percent coverage per file,
  plus CodeQL, OpenSSF Scorecard, dependency review, zizmor, gitleaks and a licence
  allowlist, with Dependabot for updates. A review-threads check keeps a pull request red
  while any review thread on it is unresolved (#4). The release workflow publishes from a
  version tag with npm trusted publishing and a provenance attestation.

[Unreleased]: https://github.com/distronode-corporation/district-social/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/distronode-corporation/district-social/releases/tag/v0.1.0
