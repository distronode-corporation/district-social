# social (CLI)

A command-line client for a **Social HQ agent API** (`/api/internal/social/*`):
draft a post, QA it, check it before approval, publish it on a person's
approval, and read the evidence of what went out. Every command is an HTTPS
call to the API; the drafts live behind it, formatted, checked and published by
the same engine (`src/lib/social-hq/engine/`) as Social HQ's composer. It is
built to be driven by an AI agent and by a person in a terminal.

The CLI holds no vendor credential and reads no database. It cannot publish
anything the API would refuse.

## The 10 publish targets

instagram · facebook · threads · twitter (X) · linkedin · youtube · reddit ·
bluesky · pinterest · tiktok

The list is `ALL_PLATFORMS` in `engine/types.ts`; that is the source of truth,
and this heading is the count of it. A platform publishes only when the API's
host has its transport routed and its credential resolves; `accounts` reads
exactly that state.

## Running it

The CLI runs through `tsx` in a host package that resolves the `@/` import
alias (`@/lib/social-hq/engine`) from its `tsconfig.json`, and uses that host's
`node_modules` (`tsx`, `commander`, `google-auth-library`). There is no separate
install.

```
bin/social <command> [options]
```

`bin/social` runs a host's private entry (`../social-hq-cli.ts`) when one sits
beside this package, and the generic `cli.ts` otherwise.

### Entry points and injection

`cli.ts` exports `createProgram(deps)`, and names no deployment. A host injects
its own facts:

```ts
import { createProgram, runCli } from "./social/cli";

runCli(
  createProgram({
    baseUrl: "https://social.example.com",               // the agent API origin
    audience: "https://social.example.com/api/internal/social", // the ID token audience
    profiles: { summary: () => "...", checklist: () => "..." }, // optional brand pack
    wireSecrets: () => {},                               // optional: the engine's secret reader
  }),
);
```

| field | what it is |
|---|---|
| `baseUrl` | The agent API origin. Every request goes there and only there. |
| `audience` | The `aud` of the Google ID token the API verifies. |
| `profiles` | Optional. A brand pack's public profiles; without one, `profiles` is not a command. |
| `wireSecrets` | Optional. Runs before every command, for a host whose engine needs its secret reader in process. |

### Configuration and its precedence

The configured origin and audience are, first found wins:

1. the injected `baseUrl` / `audience`;
2. `config.json`'s `api` block, `{ "baseUrl": ..., "audience": ... }` (copy
   `config.example.json` to `config.json`; it is machine-local and never
   committed);
3. the env, `SOCIAL_API_BASE_URL` / `SOCIAL_API_AUDIENCE`.

With neither an origin nor an audience configured, the client stops with a
one-line error naming where to set it. `config.json` is optional when the
entry injects both or the env sets them.

## Auth: keyless

The CLI sends `Authorization: Bearer <Google ID token>`, minted by this
machine's Application Default Credentials (`GoogleAuth().getIdTokenClient`) for
the configured audience. The API decides which identities it admits (for an
agent, typically a service account the agent's ADC impersonates). Nothing is
read from a file or a secret, and one token is minted per run. A person's own
ADC mints a token for that person, which an API that admits only agent
identities refuses with 401, as it should.

⛔ **The origin is pinned**, because every request carries the token. The
configured origin must be a bare `https` origin (no userinfo, path, query or
fragment). `--base-url` and `SOCIAL_API_BASE_URL` may only repeat it, exactly
as normalised (trailing slashes dropped); a local server on `localhost` or
`127.0.0.1` is admitted under `NODE_ENV=test` only. Anything else is refused
before a token is minted (`pinnedBaseUrl` and `configuredOrigin` in `api.ts`).

## Commands

`new`, `list`, `show`, `qa`, `preflight`, `publish`, `unschedule` and
`accounts` take `--json` to print the API's answer as is.

| command | API call | what it does |
|---|---|---|
| `new` | `POST /media` per file, then `POST /drafts` | Upload media, then create a draft: format per platform (or keep hand-written renders), tracked links, full QA. Prints the renders, the QA and `rendersHash` |
| `list [--status s] [--limit n]` | `GET /drafts` | Drafts, newest first, with QA state, targets and origin (`agent:<principal>` for an agent's) |
| `show <id>` | `GET /drafts/:id` | Every render, the QA report, the legs, `rendersHash`, and the approvals (id, outcome, now or the time, who, when; an `approved` one is unspent) |
| `qa <id>` | `POST /drafts/:id/qa` | Re-run the full QA (the LLM pass included) and store it |
| `preflight <id>` | `GET /drafts/:id/preflight` | Read-only, no vendor write: QA, digest, each target's route, LinkedIn's write scope, the Pinterest board, X's cost, duplicates, the next publish tick |
| `publish <id> --approval-id <uuid> [--session <id>]` | `POST /drafts/:id/publish` | Publish, citing the approval a person created for this draft (`show` lists them). Body exactly `{ approvalId, sessionId }`; `--session` defaults to `CLAUDE_CODE_SESSION_ID`, else refused. The CLI never invents an approval id |
| `unschedule <id> [--session <id>]` | `POST /drafts/:id/unschedule` | Take a scheduled post back while every leg is still `<platform>:pending`; its approval's outcome becomes `cancelled` |
| `accounts` | `GET /accounts` | Publish-readiness of all ten platforms, on the route each one uses |
| `evidence [id]` | `GET /drafts/:id/evidence`, or `GET /evidence` | One draft's approvals, evidence rows, LinkedIn calls and live legs; with no id, every evidence row (`--platform`, `--since <iso>`, `--limit 1-500`). Always JSON |
| `profiles [--checklist]` | none | What every public profile should say, from the injected brand pack; read-only. Present only when a brand pack is injected |

`new` options: `-t/--text` (required, here or in the spec), `--title`,
`-H/--hashtags`, `-l/--link`, `-n/--notes`, `-p/--platforms`, `--subreddit`,
`--board <id>` (Pinterest), `-m/--media <files...>`, `--asset <ids...>`,
`--renders <file>` and `--spec <file>`. `-p` takes the canonical ids, the
aliases `ig insta fb th x tw li yt rd bs bsky pin pi tt`, `all`, or `default`
(the API's defaults).

There is no edit command: to change a draft, create a new one.

### A release in one draft: `--spec` and `--renders`

```json
{
  "text": "the approved source text",
  "targets": ["linkedin", "bluesky"],
  "media": [{ "file": "card.png", "alt": "..." }, { "file": "square.png" }],
  "renders": {
    "li": { "content": "LinkedIn copy, as written", "mediaIndices": [0] },
    "bs": { "content": "Bluesky copy", "mediaIndices": [1], "langs": ["en"] }
  }
}
```

- The spec takes `text`, `title`, `link`, `hashtags`, `targets`, `notes`,
  `subreddit`, `pinterestBoard`, `media` (files relative to the spec),
  `assetIds` and `renders`; flags override it. ⛔ Any other key is refused
  before an upload or a call, as the API refuses it: the body is built from
  these fields, never a copy of the spec.
- The draft's media order is the spec's files, then `-m` files, then existing
  asset ids; `mediaIndices` index that list. Every asset must exist.
- A render is `content` plus `mediaIndices` (`[]` is text-only, which QA judges)
  and the per-platform fields the API accepts (`title`, `firstComment`,
  `threadItems`, `board`, `flair`, `subreddit`, `langs` and the platform
  switches). ⛔ A field the API does not accept is refused, never dropped.
  Render keys may be aliases; the CLI resolves them. A platform with a
  hand-written render is not re-formatted, and each render must be for one of
  the targets.
- Links in hand-written renders may become tracked links when the draft is
  created, before the digest: the `rendersHash` a person approves is of the
  text `show` prints, and the copy does not change after the approval.

## The approval model

⛔ A post publishes only on a person's approval of THIS draft, given in Social
HQ after seeing its final renders and QA result. There is no agent
self-approval, and an approval relayed by another session or agent never
counts.

1. **Draft.** `new` creates the draft; the API formats and QAs it.
2. **Renders.** `show` (and `preflight`) print exactly what would go out.
3. **rendersHash.** A sha256 over the targets, the renders and the media. It
   is what an approval binds.
4. **Approval.** A person approves the draft in Social HQ, now or at a time.
   That writes a single-use approval bound to the `rendersHash` they saw.
5. **Publish.** `publish` cites that approval's id. The API refuses a draft
   the agent API did not create, QA missing or failing (no force), a draft
   changed since the approval, and a draft already sent or an approval already
   spent: one approval, one send.
6. **Evidence.** Each send leaves one evidence row per platform leg (post id,
   URL, send time, and for LinkedIn each API call's status and request id).
   `evidence <id>` reads them.

- A post the API already holds (the same title, or the same media) is refused
  at compose and at publish.
- After a 5xx, do not publish again: read `evidence <id>` and the platform, and
  tell the approver.

## How formatting works (on the API's host)

- `engine/specs.ts` encodes per-platform hard limits and best practice
  (provenance in `platform-reference.md`).
- `engine/format.ts` sends the source post, the brand brief and the platform
  rules to Claude (structured output) and gets one tailored render per
  platform (content, title, first comment, thread items, subreddit, media
  selection). It also writes image alt text.
- `engine/qa.ts` runs deterministic validators (limits, media rules, hashtag
  caps, link penalties, the brand pack's own gates) plus an LLM review pass
  (factual drift, typos, tone, hooks), stored on the draft as a pass/fail
  report.
- `engine/publish.ts` hands each render to that platform's direct transport
  (`transport.ts`, then `*-transport.ts`), which uploads media through the
  platform's own API and creates the post there.

## Layout

```
bin/social              CLI shim (tsx)
cli.ts                  createProgram(deps): commands, each one API call (or a few, for uploads)
api.ts                  the API client: the origin pin, ADC ID token, JSON or multipart, ApiError
preflight.ts            `preflight` and its terminal view
unschedule.ts           `unschedule`
render.ts               terminal rendering of drafts and QA
config.ts               config.json loading (the api block, defaults), wireEngineEnv()
store.ts                a local draft store (drafts/, machine-local), for tools that run the engine in process
config.example.json     template, copy to config.json
platform-reference.md   researched platform facts and provenance
```

Engine, in `src/lib/social-hq/engine/`:

```
specs.ts                per-platform limits and guidance
format.ts               LLM formatter and alt text
qa.ts                   deterministic and LLM QA
publish.ts              per-platform publish, via the transport registry
transport.ts            the DirectTransport contract, registry and overrides
*-transport.ts          one transport per platform
bluesky.ts linkedin.ts pinterest.ts reddit.ts threads.ts x.ts youtube.ts zernio.ts
                        the raw vendor clients those transports call
http/                   vendor-fetch.ts, retry.ts, meta-graph.ts: the shared HTTP layer
claude.ts               Claude text helper (structured output)
anthropic-wif.ts        Claude by workload identity federation
media.ts                media analysis (ffprobe) and per-platform upload
```

⚠️ `bluesky.ts` loads `@atproto/api` lazily on purpose. Its dependency
`multiformats` exports `./cid` under an `import` condition only, and a CLI
that runs through tsx in a CommonJS package crashed every command at load with
`ERR_PACKAGE_PATH_NOT_EXPORTED` under a static import. Bundlers (Next, vitest)
never notice because they bundle ESM. Keep it lazy.

## Running the engine in process: `wireEngineEnv` and Claude auth

The CLI calls no model: the API's host does. A tool that runs the engine in
process (for local drafts, with `store.ts`) reads `config.json` through
`wireEngineEnv({ wireSecrets })`, which copies `vertex.project` and
`defaults.subreddit` into the variables the engine reads (`VERTEX_PROJECT_ID`,
`SOCIALMETA_DEFAULT_SUBREDDIT`) without overwriting any already set. There is
no default Vertex project: set `VERTEX_PROJECT_ID` (or `vertex.project`) for
video.

The text model runs on Claude. Without an `anthropicWif` block in
`config.json` it uses `ANTHROPIC_API_KEY` through the host's secret reader
(`wireSecrets`). With the block, it authenticates by Anthropic workload
identity federation and **never reads the key**:

```json
"anthropicWif": {
  "federationRuleId": "fdrl_...",
  "organizationId": "<organization uuid>",
  "serviceAccountId": "svac_...",
  "workspaceId": "wrkspc_...",
  "idTokenServiceAccount": "operator@example-project.iam.gserviceaccount.com"
}
```

Each run, your ADC calls IAM Credentials `generateIdToken` for
`idTokenServiceAccount` (audience `https://api.anthropic.com`, with its
email), and the engine exchanges that ID token at Anthropic for a short-lived
access token. Your ADC must hold `roles/iam.serviceAccountOpenIdTokenCreator`
on that service account; the service account itself needs no roles.

- All five fields or none: an incomplete block stops with the missing names.
  If your shell already sets any of the engine's WIF variables
  (`ANTHROPIC_FEDERATION_RULE_ID`, `_ORGANIZATION_ID`, `_SERVICE_ACCOUNT_ID`,
  `_WORKSPACE_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`,
  `SOCIAL_HQ_ID_TOKEN_SERVICE_ACCOUNT`), the shell's set is used whole and the
  block is ignored.
- ⛔ A failure is a failed Claude call, never a fallback to the key: QA then
  blocks with `llm-qa-unavailable`. `ID token for ... could not be minted
  (HTTP 403: ...)` is the missing grant; `Token exchange failed with status
  401` is the Anthropic federation rule (its deny reason is in the Console's
  authentication history).

## Known gaps

- No calendar view in the CLI; Social HQ's calendar covers it. `list` shows
  the drafts, newest first.
- The CLI cannot edit or delete a draft; Social HQ can.
