# Roadmap

The near-term plan for district-social, and what it will not do. It is taken from the
repository's open issues and from what its own documents say is not finished yet. It covers
the next twelve months, to November 2027. Items have no dates of their own: an item is done
when the change that does it is merged and released, and it then leaves this list for [CHANGELOG.md](CHANGELOG.md). Anything here can change; open an
[issue](https://github.com/distronode-corporation/district-social/issues) to discuss an item or
to propose a new one.

## Near term

- **The next release.** What is merged under "Unreleased" in the CHANGELOG goes out in the
  next version.
- **Drop the zod override** ([#6](https://github.com/distronode-corporation/district-social/issues/6)).
  `overrides.zod` lifts the zod that `@atproto/api` pulls in to 4.6.6, the fix for
  GHSA-mrhx-c7xc-m3w5, outside the `^3` range the @atproto packages declare. It covers this
  repository's installs only: npm does not pass overrides to consumers of the published
  package, who keep zod 3 and the 5 MiB response cap. It goes once `@atproto/api` admits a
  fixed zod.
- **Lint and type-check settings back at the scaffold's**
  ([#3](https://github.com/distronode-corporation/district-social/issues/3)). The seed code
  was written against looser settings, so some TypeScript options and typescript-eslint rules
  are relaxed today. The issue lists each one with its count of findings; each is turned back
  on in its own pull request, with coverage still at 100 percent per file.

## Not planned

- **No hosted service and no shared credentials.** Each self-hoster registers their own
  developer apps with each network, completes that network's review, and brings their own
  model credentials (README, "Bring your own credentials and model"). The project provides no
  credentials, developer apps or network approvals (SUPPORT.md).
- **No approval UI in the engine.** Approval is the application's to enforce: the engine
  defines the `ApprovalGate` port, and grants come from the application's own human surface
  (README, "Using the engine").
- **The CLI stays out of the npm package.** The package is the engine; the CLI runs from a
  clone (CONTRIBUTING.md, "Status").

A change to any of these would be proposed as an issue first.
