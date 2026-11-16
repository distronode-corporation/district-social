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

- Repository scaffolding: licence and policy files, CI (lint, type-check, tests at 100 percent
  coverage), CodeQL, OpenSSF Scorecard, dependency review, zizmor, gitleaks, a licence
  allowlist check, Dependabot, and an npm trusted-publishing release workflow.
- The District Social engine (formatting, QA, revision and approval-gated publishing for 10
  networks, with in-memory ports) and the `scripts/social` CLI (#2).

### Fixed

- Trailing-character trims that CodeQL flagged as polynomial ReDoS (URL punctuation in QA
  and link placement, slashes in subreddit names and media base URLs, line-end whitespace in
  the Threads topic-tag lift) now run in linear time with the same output.
- Bluesky session ownership check no longer drops a valid email-configured session.

[Unreleased]: https://github.com/distronode-corporation/district-social/commits/main
