# Security Policy

district-social is a social publishing tool: it will hold credentials for social accounts and
post on their behalf. A flaw here can mean a post nobody approved, or a leaked account token, so
reports are very welcome.

## Reporting a vulnerability

Please report privately, not in a public issue, discussion or pull request.

- **Preferred:** GitHub's private vulnerability reporting. Open the repository's
  **Security** tab and choose **Report a vulnerability**, or go straight to
  <https://github.com/distronode-corporation/district-social/security/advisories/new>.
- **Fallback:** email **opensource@distronode.com** if you cannot use GitHub.

Include what you did, what happened, and what you expected. A proof of concept is welcome
but not required. Never include a real access token, API key or password; if one is part of
the problem, say where it appeared, not what it was.

Expect an acknowledgement within a few working days. This is a small project with no paid
bug bounty; what you get is credit in the changelog entry for the fix, if you want it.

## Supported versions

Only the latest release on npm is supported. Fixes go into a new release rather than being
backported.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

## Verifying a release

Each release is published to npm from `.github/workflows/release.yml` with npm provenance.
From the version after 0.1.0, the same workflow attaches the tarball, `SHA256SUMS` and the
provenance to the GitHub release: `district-social-X.Y.Z.sigstore.json` is the SLSA
provenance as a Sigstore bundle, and `district-social-X.Y.Z.intoto.jsonl` holds every
attestation npm recorded for the version, one bundle per line. To check a downloaded
tarball:

```
sha256sum -c SHA256SUMS
gh attestation verify district-social-X.Y.Z.tgz --digest-alg sha512 \
  --bundle district-social-X.Y.Z.sigstore.json --repo distronode-corporation/district-social
```

For an installed copy, npm checks the registry signature and the provenance attestation of
every package in the tree:

```
npm install district-social
npm audit signatures
```

It reports the packages with a verified registry signature and those with a verified
attestation, and fails on an invalid one. The registry's public keys are at
<https://registry.npmjs.org/-/npm/v1/keys>. The provenance is signed with a short-lived
Sigstore certificate issued to `.github/workflows/release.yml` for the tag's commit, so there
is no long-lived signing key to publish or to leak.

## Threat model

What the library defends against, and what it leaves to the application that embeds it.
Each point names the code that holds it.

- **Server-side request forgery.** `src/ssrf.ts` validates a destination URL (HTTPS only;
  no localhost, cloud metadata or private and reserved IPv4 and IPv6 ranges, checked on the
  literal host and on every resolved address) and returns an undici dispatcher pinned to
  the validated address, with redirects refused, so the request cannot be rebound or
  redirected into a private network. Inside the library it guards the Reddit media upload
  to the endpoint Reddit's upload lease names (`src/reddit.ts`); it is exported for the
  application's own fetches. Media asset URLs on a render are fetched by
  `src/media-fetch.ts` without this guard, bounded in time and bytes only, so an
  application that lets untrusted users set media URLs should validate them first.
- **Unbounded responses.** `src/read-capped.ts` reads an untrusted response body up to a
  byte cap and refuses, never truncates, a larger one: a declared `Content-Length` over the
  cap is refused before a byte is read, and a missing or lying one is caught while
  streaming. Every Bluesky response goes through it with a 5 MiB cap (`RESPONSE_CAP_BYTES`
in `src/bluesky.ts`, the fetch the Bluesky session and agent are built on),
  and every fetched media asset with a 512 MiB cap (`src/media-fetch.ts`).
- **Credentials.** The library stores no credentials and ships none. Network tokens reach
  it only through what the application registers: the `CredentialStore` port
  (`src/ports.ts`) and the per-network resolvers (for example `setBlueskyCredentialsResolver`
  in `src/bluesky.ts`). The Claude API key is read through the application's
  `setSecretGetter` (`src/claude.ts`). The exceptions are ambient cloud identity, not
  secrets: Claude workload identity federation reads its settings and identity token source
  from the environment (`src/anthropic-wif.ts`), and the Google calls there and in
  `src/veo.ts` use Application Default Credentials through `google-auth-library`.
- **Approval.** Publishing only what a person approved is the application's job, not the
  library's. The `ApprovalGate` port (`src/ports.ts`) has `consume` and no call that grants
  an approval, and `publishDraft` does not consult the gate, so the application calls
  `consume` itself before it publishes. Grants come from the application's own human
  surface (`grant` on `inMemoryApprovalGate()` in a single process).
- **No cryptography of its own.** The library's own code uses `node:crypto` for exactly two
  things: an HMAC-SHA256 `appsecret_proof` for Meta Graph calls (`src/http/meta-graph.ts`)
  and a SHA-256 of the Bluesky login identifier, stored with the session in place of the
login itself (`src/bluesky.ts`). Transport
  security is Node's TLS, with certificate verification left at its defaults; the pinned
  dispatcher replaces only the DNS lookup. Token signing for Google identity happens inside
  `google-auth-library`.

## Scope

In scope: anything in this repository's source, and the release pipeline (a published npm
package that does not match this repository's source, or whose provenance does not verify).

Out of scope:

- Vulnerabilities in third-party dependencies with no demonstrated effect on
  district-social; report those upstream (Dependabot tracks them here).
- The social networks' own APIs and services; report those to the network concerned.
- Denial of service against a service you do not operate, and volumetric attacks in
  general.
