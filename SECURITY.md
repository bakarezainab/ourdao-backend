# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (the "Report a vulnerability" button under the repo's
**Security** tab) instead.

Include:

- What you found
- How to reproduce it
- What an attacker could do with it

## Scope

This service is a read-only indexer and API over public Stellar/Soroban
on-chain events. It holds no custody: there is no private key, and no code
path that constructs, signs, or submits a transaction (see the README's
[Security notes](./README.md#security-notes) for the full architectural
boundary). Keep that in mind when assessing severity — a report here is
almost always about the indexer, the API, or the authenticated mutation
endpoints, not about fund custody or transaction signing, since this service
has no such path.

## See also

[CONTRIBUTING.md](./CONTRIBUTING.md#reporting-a-security-issue) links back
here for contributors.
