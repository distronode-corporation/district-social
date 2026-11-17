# district-social

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16830/badge)](https://www.bestpractices.dev/projects/16830)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/distronode-corporation/district-social/badge)](https://scorecard.dev/viewer/?uri=github.com/distronode-corporation/district-social)
[![npm version](https://img.shields.io/npm/v/district-social)](https://www.npmjs.com/package/district-social)
[![Latest release](https://img.shields.io/github/v/release/distronode-corporation/district-social?label=release)](https://github.com/distronode-corporation/district-social/releases)
[![CI](https://github.com/distronode-corporation/district-social/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/distronode-corporation/district-social/actions/workflows/ci.yml?query=branch%3Amain)

District Social is an engine and a command-line client for drafting, checking and publishing
social posts. The engine turns one source post into a render per network, runs QA over the
renders (mechanical limits, compliance gates and an optional model review), applies fixes, and
publishes through each network's own API. It is built for publishing only what a person has
approved, exactly as it will be sent, with the approval enforced by the application (see
Using the engine).

## Networks

The engine covers 10 networks, each with a direct API transport:

Instagram, Facebook, Threads, X (Twitter), LinkedIn, YouTube, Reddit, Bluesky, Pinterest and
TikTok.

The platform ids are `ALL_PLATFORMS` in `src/types.ts`, and the per-network limits and
conventions are `SPECS` in `src/specs.ts`. A network publishes only when its transport is
registered and its credentials resolve.

## Quick start

With Node.js 22 or later, install the engine and measure a post against two networks' limits,
with no model and no credentials:

```
npm install district-social
node --input-type=module -e '
import { SPECS, vendorLength } from "district-social";
const text = "We shipped dark mode.";
for (const p of ["bluesky", "twitter"]) console.log(p, vendorLength(p, text), "of", SPECS[p].maxChars);
'
```

That prints each network's count of the text, measured the way that network counts, against
its limit (`bluesky 21 of 300`, `twitter 21 of 280`).

Using the engine, below, goes on to formatting, QA and publishing.

## Install

With Node.js 22 or later:

```
npm install district-social
```

The package is the engine: ES modules with TypeScript declarations. The CLI is not in it; it
runs from a clone of this repository, which also builds the package from source:

```
git clone https://github.com/distronode-corporation/district-social.git
cd district-social
npm ci
npm run build    # emits dist/, the package entry point
```

To check that the package you installed is the one this repository's release workflow
built, see Verifying a release in [SECURITY.md](https://github.com/distronode-corporation/district-social/blob/main/SECURITY.md#verifying-a-release).

## Uninstall

The package installs nothing outside `node_modules` and writes no files of its own:

```
npm uninstall district-social
```

For a clone, delete the directory. The CLI's `scripts/social/config.json`, if you created one,
is inside it. Anything the engine stored through your ports (drafts, credentials, media) is in
your application's stores, and is removed there.

## Using the engine

`createEngine` binds a brand pack (the brief every model call reads, plus optional QA gates)
and the ports the application provides: a clock, a model, and optionally stores for drafts,
credentials and media, a lock and an approval gate. The in-memory implementations in
`src/ports.ts` run a single process with no infrastructure.

```ts
import { createEngine, type Draft, type GenJsonOptions, type LlmClient } from "district-social";

// Any model that answers with JSON of the requested schema. Leave `llm` out to use Claude.
const llm: LlmClient = {
  generateJson: async <T>(prompt: string, opts: GenJsonOptions) => (await callYourModel(prompt, opts.schema)) as T,
};

const engine = createEngine({ brand: { name: "example", brief: "Plain, friendly voice. No hype." }, llm });

const source = { text: "We shipped dark mode.", hashtags: [], media: [] };
const renders = await engine.formatPost(source, ["bluesky", "linkedin"]);

const now = new Date().toISOString();
const draft: Draft = { id: "d1", createdAt: now, updatedAt: now, status: "draft", source, targets: ["bluesky", "linkedin"], renders };
const report = await engine.runQa(draft);
console.log(report.issues);
```

`callYourModel` stands for your own model call. The full public surface is `src/index.ts`
(`dist/index.d.ts` in the package).

Approval is the application's to enforce. The engine defines the `ApprovalGate` port: a
single-use approval for one draft and a hash of its exact renders. The port has no call that
grants one; grants come from the application's own human surface (`grant` on
`inMemoryApprovalGate()`, in a single process). `publishDraft` does not consult the gate
itself, so the application calls `consume` on it before it calls `publishDraft`.

## The CLI

`scripts/social/` is a command-line client for an agent API built on this engine: draft, QA,
check before approval, publish on approval, and read back what went out. It is not in the
npm package; it runs from a clone. See [scripts/social/README.md](https://github.com/distronode-corporation/district-social/blob/main/scripts/social/README.md).

## Bring your own credentials and model

No credentials ship with this repository. Each self-hoster registers their own developer
apps with each network, completes that network's review where it requires one, and supplies
the tokens through the engine's credential resolvers or a `CredentialStore`. App approvals
granted to anyone else, including the project's maintainers, do not transfer to your
deployment.

The model is yours too. The default `LlmClient` calls Claude with your own Anthropic
credentials (an API key read through `setSecretGetter`, or workload identity federation); pass any other client with the same contract (the reply has the requested schema,
and a refusal or truncated reply throws) as `llm`.

## Project

- [ARCHITECTURE.md](https://github.com/distronode-corporation/district-social/blob/main/ARCHITECTURE.md): the parts of the engine, how a post moves through them, and where state lives.
- [SECURITY-MODEL.md](https://github.com/distronode-corporation/district-social/blob/main/SECURITY-MODEL.md): the threat model, trust boundaries and the weaknesses the code counters.
- [CONTRIBUTING.md](https://github.com/distronode-corporation/district-social/blob/main/CONTRIBUTING.md): how to run the local gate, and the rules for changes.
- [SECURITY.md](https://github.com/distronode-corporation/district-social/blob/main/SECURITY.md): how to report a vulnerability privately.
- [SUPPORT.md](https://github.com/distronode-corporation/district-social/blob/main/SUPPORT.md): where to ask a question or report a bug.
- [GOVERNANCE.md](https://github.com/distronode-corporation/.github/blob/main/GOVERNANCE.md): who maintains the project and how a change is accepted.
- [CHANGELOG.md](https://github.com/distronode-corporation/district-social/blob/main/CHANGELOG.md): what changed, release by release.

Licensed under the [Apache License, Version 2.0](https://github.com/distronode-corporation/district-social/blob/main/LICENSE). Copyright 2026 Distronode
Corporation; see [NOTICE](https://github.com/distronode-corporation/district-social/blob/main/NOTICE).
