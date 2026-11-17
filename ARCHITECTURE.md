# Architecture

This file is the high-level design of district-social: what the parts are, how a post moves
through them, and where state lives. The security side of the same design (actors, trust
boundaries, the weaknesses it counters) is [SECURITY-MODEL.md](SECURITY-MODEL.md).

## Two deliverables

- **The engine** (`src/`), published to npm as `district-social`. It is a library: it has no
  server, no database and no process of its own. An application embeds it and supplies the
  ports below.
- **The CLI** (`scripts/social/`), which runs from a clone and is not in the package. It is a
  client for an agent API that a host application builds on the engine; it calls that API
  over HTTPS and imports the engine only for its types, network specs and length helpers, to
  render what the API returns. See
  [scripts/social/README.md](scripts/social/README.md).

## The engine

### Engine and ports

`createEngine` (`src/engine.ts`) binds a brand pack (the brief every model call reads, plus
optional QA gates) to the ports the application provides (`EnginePorts` in `src/ports.ts`):

| port | what it is | in-memory implementation |
| --- | --- | --- |
| `Clock` | the time | `systemClock`, `manualClock` |
| `LlmClient` | a model that answers with JSON of a requested schema | `claudeLlm` (the default), `scriptedLlm` |
| `DraftStore` | where drafts are kept | `inMemoryDraftStore` |
| `CredentialStore` | where network tokens are kept | `inMemoryCredentialStore` |
| `MediaStore` | where media assets are kept and served from | `inMemoryMediaStore` |
| `Lock` | mutual exclusion between workers | `inMemoryLock` |
| `ApprovalGate` | single-use approval of one draft's exact renders | `inMemoryApprovalGate` |

The engine instance holds its brand pack and its ports, and two engines never share them.

### The pipeline

One source post (`SourcePost` in `src/types.ts`) becomes one render per target network
(`PlatformRender`), and each step is a separate call the application makes:

1. **Format** (`src/format.ts`): the model writes a render per network from the source and
   the brand brief. Per-network playbooks (`src/playbook.ts`, `src/link-placement.ts`,
   `src/trim.ts`) then trim hashtags and move or drop body links in code, so those rules do
   not depend on the model following its prompt.
2. **QA** (`src/qa.ts`): deterministic checks against each network's limits and media rules
   (`SPECS` in `src/specs.ts`, plus the limits each connected transport declares), the brand
   pack's compliance gates, and an optional model review. The result is one pass or fail
   report.
3. **Revise** (`src/revise.ts`): mechanical fixes that need no model, then the smallest model
   edit that clears the issues still open.
4. **Approve**: the application's own human surface grants an approval for the draft and a
   hash of its exact renders, and consumes it through the `ApprovalGate` port before it
   publishes. The engine does not grant approvals.
5. **Publish** (`src/publish.ts`): `publishDraft` sends each render through the transport
   routed for its network, fits media to that destination at publish time
   (`src/media-fit.ts`, through a fitter the application injects with `setMediaFitter`), and
   returns each leg's outcome as a provider post id list (`PublishResult`) for the
   application to store with the draft; the engine itself writes no database.

### Transports and network clients

`src/transport.ts` separates "which network" from "how it is reached". A network is
published through a `DirectTransport` registered for it (`registerTransport`), or routed to
an aggregator instead (Zernio, `src/zernio-aggregator.ts`), by an override the application
resolves. The same file holds the codec for the provider post ids each leg produces.

Each network has a client (`src/x.ts`, `src/reddit.ts`, `src/bluesky.ts`, ...) that speaks
its API, and a transport (`src/x-transport.ts`, ...) that adapts the client to the
`DirectTransport` contract. Clients share the HTTP helpers in `src/http/`: `vendorFetch` and
`vendorText` (timeouts and error wrapping), `withRetry` (bounded retry with backoff, where a
create is retried only after a rejection such as a 429 and never after a timeout or a 5xx,
so a lost answer does not become a duplicate post), and the Meta
Graph helpers shared by Facebook, Instagram and Threads. `src/ssrf.ts` and
`src/read-capped.ts` are the guards described in SECURITY-MODEL.md.

### Models

`src/claude.ts` is the default `LlmClient`: Claude with structured output, the API key read
through the application's `setSecretGetter`, or Anthropic workload identity federation
(`src/anthropic-wif.ts`). `src/veo.ts` starts and polls Vertex AI Veo video generation in
the application's own Google Cloud project.

## Where state lives

- **Application state** (drafts, credentials, media, locks, approvals) lives behind the
  ports, so it is wherever the application keeps it. The in-memory implementations keep it
  in the process and lose it on exit.
- **Process-wide registrations** live in module scope and are set by the application at
  startup: the registered transports and the override resolver (`src/transport.ts`), each
  network's credential resolver, the secret getter (`setSecretGetter`), the media fitter and
  uploader (`setMediaFitter`, `setMediaUploader`), and the deployment settings
  (`setEngineDeployment`).
- **Short-lived caches** live in module scope too: the connected-accounts sweep
  (`src/publish.ts`), logged-in sessions and clients per network (for example the Bluesky
  agent), and the aggregator's account list. None is the record of anything: the record is
  the draft the application stores.

## Build and release

TypeScript compiled by `tsc` (`tsconfig.build.json`) to ES modules in `dist/`, one
dependency graph in `package-lock.json`, no native code. `.github/workflows/release.yml`
publishes from a `vX.Y.Z` tag; CONTRIBUTING.md has the details.
