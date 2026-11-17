# Security model

This is district-social's assurance case: who can attack it, where the trust boundaries are,
the secure design principles the code applies, and the common weaknesses it counters, each
with the code or test that holds it. The per-mechanism detail, and what is in and out of
scope for a report, is in [SECURITY.md](SECURITY.md). The design itself is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## What you can and cannot expect

district-social is a library that an application embeds. You can expect it to refuse,
rather than work around, the failures below; to hold no credential it was not given; and to
leave the decisions that need a person (who may approve, who may set what) to the
application. You cannot expect it to authenticate your users, to store anything safely (the
stores are yours, behind its ports), or to defend a deployment whose application passes it
untrusted input without the checks this file says are the application's.

## Threat model

| actor | what they can do | what the library does about it |
| --- | --- | --- |
| A social network or aggregator API, or anyone in its path | Return a hostile, oversized, slow or malformed response; point an upload at an address of its choosing | TLS with certificate verification; time and byte bounds on reads; the upload destination Reddit names is checked and pinned (`src/ssrf.ts`); a response that is not the JSON expected is an error |
| The model | Answer off-schema, refuse, stop early, or write copy that breaks a network's rules or the brand's | Structured output with a requested schema; a refusal or a truncated reply throws (`src/claude.ts`); every render passes deterministic QA in code, not only the model's own review (`src/qa.ts`) |
| A person with access to the application, but not approval rights | Try to publish something nobody approved, or something other than what was approved | Nothing in the library grants an approval; the `ApprovalGate` port is single-use and bound to a hash of the exact renders (`src/ports.ts`). Enforcing it is the application's job (below) |
| Whoever controls a draft's content or settings in the application | Set media, links and text that the library will fetch or send | Length, media and link rules per network in code; the guards below. Which users may set what is the application's job |
| A compromised dependency or release pipeline | Ship code that is not this repository's | Exact pins, a 7-day age rule and a licence allowlist on dependencies (CONTRIBUTING.md); releases with npm provenance, verifiable from SECURITY.md |

## Trust boundaries

1. **Application to library.** Everything the application passes in (ports, resolvers,
   drafts, settings) is trusted to be what the application meant. The library checks what
   it needs to stay correct, not who the caller is.
2. **Library to network APIs.** Every response from a social network, an aggregator or an
   upload host is untrusted input.
3. **Library to the model.** A model reply is untrusted input, held to the requested schema
   and to QA.
4. **Library to credential sources.** Tokens and the Claude key enter only through the
   resolvers, the `CredentialStore` port and `setSecretGetter`, at the moment a call needs
   them. Ambient cloud identity enters through `google-auth-library` and the workload
   identity settings in `src/anthropic-wif.ts`.
5. **Approval.** The line between "drafted" and "published" is a person's approval, held by
   the application's `ApprovalGate`, not by the library.
6. **Repository to package.** The npm package is built by `.github/workflows/release.yml`
   from a tag, and carries provenance that ties it to that workflow and commit.

## Secure design principles applied

- **Least privilege.** The library ships and stores no credential; each network client asks
  its own resolver for its own token when it calls, and sees no other network's. The CLI
  holds no vendor credential at all: it can do only what the API behind it allows
  (`scripts/social/README.md`). Every workflow starts from `permissions: {}` and each job
  asks for what it needs (`.github/workflows/ci.yml`).
- **Fail closed.** `src/read-capped.ts` refuses an over-cap body instead of truncating it.
  `src/ssrf.ts` refuses a destination when any resolved address is private or reserved, and
  refuses redirects. A model refusal or a reply cut short throws and is never retried as if
  it were an answer (`src/claude.ts`). A selected media asset with no public URL refuses the
  leg before anything is sent (`src/media-fetch.ts`). A stored Bluesky session for another
  identifier is dropped, not resumed (`src/bluesky.ts`). A create whose outcome is unknown
  (a timeout or a 5xx) is reported as unknown, never re-sent (`src/http/retry.ts`).
- **Complete mediation.** The SSRF check runs on every resolved address of every guarded
  request, and the request goes to the address that was checked (the pinned dispatcher), so
  a second DNS answer cannot bypass it. Every Bluesky response goes through the byte cap,
  because the cap is in the fetch the Bluesky agent is built on (`src/bluesky.ts`).
- **Economy of mechanism.** One module each for the retry rule (`src/http/retry.ts`), the
  SSRF guard (`src/ssrf.ts`) and the byte cap (`src/read-capped.ts`), shared by every client
  rather than re-implemented per network. Four runtime dependencies (`package.json`).
- **Open design.** The whole library, its tests and its release pipeline are public; nothing
  depends on the code being secret.

## Common weaknesses countered

Mapped to the CWE Top 25 and the OWASP Top 10 where they apply to a library like this one.

| weakness | how it is countered | where it is tested |
| --- | --- | --- |
| Server-side request forgery (CWE-918, OWASP A10) | `src/ssrf.ts`: HTTPS only, no localhost, metadata or private and reserved ranges on the literal host and every resolved address, pinned dispatcher, no redirects. Where the library applies it is in SECURITY.md's threat model | `src/__tests__/ssrf.test.ts`, `src/__tests__/reddit-upload-pinned.test.ts` |
| Uncontrolled resource consumption (CWE-400, CWE-770) | Byte caps that refuse (`src/read-capped.ts`), time bounds on vendor calls (`src/http/vendor-fetch.ts`) and media fetches (`src/media-fetch.ts`) | `src/__tests__/read-capped.test.ts`, `src/__tests__/media-fetch.test.ts` |
| Improper certificate validation (CWE-295) | Node's TLS with certificate verification at its defaults; no code disables it (no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`) | Source: none of either appears in the tree |
| Hard-coded or leaked credentials (CWE-798, CWE-532) | No credential in the repository; tokens come from resolvers at call time; gitleaks scans the whole history on every push to main, every pull request and weekly (`.github/workflows/gitleaks.yml`); the Bluesky login identifier is stored only as a SHA-256 | `src/__tests__/bluesky.test.ts` |
| Code injection (CWE-94) | No `eval` and no `Function` constructor in the code; typescript-eslint's `no-implied-eval` runs in CI | `npm run lint` |
| OS command injection (CWE-78) | The library starts no processes (no `child_process`) | Source |
| Deserialization of untrusted data (CWE-502) | Untrusted data is parsed only with `JSON.parse`, which builds plain data and runs no code; a body that is not JSON is an error, not a guess | The client tests per network, for example `src/__tests__/reddit-client.test.ts` |
| Missing authorization (CWE-862) | Publishing needs an approval the library cannot grant, single-use and bound to the exact renders (`src/ports.ts`); the application must consume it before `publishDraft` | `src/__tests__/ports.test.ts` |
| Duplicate side effects on retry | A create is retried only after a rejection (such as a 429), never after an unknown outcome | `src/http/__tests__/retry.test.ts` |

What the library leaves to the application, and does not counter itself:

- **Who may do what.** Authentication, authorization and the approval surface.
- **Input from the application's own users.** Response bodies from network APIs are parsed
  as JSON and read as typed values, not validated against a schema field by field, and a
  media asset's local `path` is read as given. An application that lets untrusted users set
  drafts, media paths or media URLs validates them before they reach the engine (see
  SECURITY.md's threat model).
