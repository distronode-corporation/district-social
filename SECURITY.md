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

Nothing has been released yet. Once releases begin, only the latest release is supported,
and fixes go into a new release rather than being backported.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

## Scope

In scope: anything in this repository's source, and the release pipeline (a published npm
package that does not match this repository's source, or whose provenance does not verify).

Out of scope:

- Vulnerabilities in third-party dependencies with no demonstrated effect on
  district-social; report those upstream (Dependabot tracks them here).
- The social networks' own APIs and services; report those to the network concerned.
- Denial of service against a service you do not operate, and volumetric attacks in
  general.
