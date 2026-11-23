# Dependency License Policy

This document defines the license policy for npm dependencies in `ourdao-backend` and explains why each allowed license is acceptable for an MIT-licensed service.

## Policy

**All dependencies must use a license on the approved list below.** New dependencies with licenses not on this list require explicit review and approval before being merged.

CI (`npm run license:check`) fails on any dependency with a disallowed license or with no license information.

## Approved Licenses

### MIT License
**Why acceptable:** MIT is permissive, compatible with this project's MIT license, and allows commercial use, modification, and redistribution with no restrictions beyond preserving the copyright notice. This is the most common license in the npm ecosystem.

**Count in tree:** ~259 packages

### ISC License
**Why acceptable:** ISC is functionally equivalent to MIT with simpler wording. It is also a permissive license allowing commercial use, modification, and redistribution. Fully compatible with MIT.

**Count in tree:** ~31 packages

### Apache-2.0
**Why acceptable:** Apache 2.0 is permissive and compatible with MIT. It includes an explicit patent grant (which MIT does not), providing additional protection for users. Commercial use, modification, and redistribution are allowed. The only requirement beyond attribution is preserving NOTICE files if present.

**Count in tree:** ~19 packages

### BSD-3-Clause and BSD-2-Clause
**Why acceptable:** Both BSD variants are permissive and MIT-compatible. They allow commercial use, modification, and redistribution. BSD-3-Clause adds a clause prohibiting use of the author's name for endorsement without permission, which is not a restriction on use of the software itself.

**Count in tree:** ~12 (BSD-3-Clause), ~8 (BSD-2-Clause)

### BlueOak-1.0.0
**Why acceptable:** BlueOak is a modern permissive license explicitly designed to be compatible with and improve upon MIT/ISC. It is MIT-compatible, allows commercial use, and has no copyleft provisions.

**Count in tree:** ~5 packages

### MPL-2.0 (Mozilla Public License 2.0)
**Why acceptable:** MPL-2.0 is a weak copyleft license that is file-scoped, not project-scoped. Modified MPL files must remain MPL, but the project as a whole can be MIT. MPL code can be integrated into MIT-licensed projects as long as the MPL-licensed files themselves retain their license. This is compatible with commercial use and does not "infect" the rest of the codebase.

**Count in tree:** ~3 packages

### CC0-1.0 (Creative Commons Zero)
**Why acceptable:** CC0 is a public domain dedication. Code under CC0 has no restrictions whatsoever—it is effectively "no license," allowing any use. Fully compatible with MIT.

**Count in tree:** ~1 package

### CC-BY-3.0 (Creative Commons Attribution)
**Why acceptable:** CC-BY requires attribution but is otherwise permissive. It allows commercial use, modification, and redistribution. While CC licenses are typically for content rather than code, CC-BY is compatible with MIT for code dependencies that use it. The attribution requirement is satisfied by preserving the dependency's copyright notice in `node_modules` (which npm does automatically).

**Count in tree:** ~1 package

### (MIT AND CC-BY-3.0)
**Why acceptable:** This is a dual-license expression meaning the dependency is available under both MIT and CC-BY-3.0, and the user can choose. We choose MIT, which is on the approved list. Dual-licensing with one permissive option is acceptable as long as at least one license is approved.

**Count in tree:** ~1 package

## Disallowed Licenses

The following licenses are **not** approved and will cause CI to fail:

- **GPL-2.0, GPL-3.0** (strong copyleft): Requires derivative works to also be GPL. Incompatible with MIT for this project, as it would require releasing `ourdao-backend` under GPL, which conflicts with the MIT license already committed.
- **LGPL-2.0, LGPL-3.0** (lesser copyleft): Allows dynamic linking from MIT code but requires that modifications to the LGPL library itself remain LGPL. While technically compatible for npm dependencies (since they are separate packages, not statically linked), LGPL is avoided as a policy to keep the dependency tree simple and to prevent accidental static inclusion.
- **AGPL-3.0** (network copyleft): Even stronger than GPL—requires releasing source code for any network-accessible service using AGPL code. Fundamentally incompatible with a closed or MIT-licensed network service.
- **UNLICENSED**: No license information means no permission to use. Dependencies with `UNLICENSED` or missing license fields are rejected.

## UNLICENSED Dependency

One package in the current tree reports `UNLICENSED`: **this repository itself** (`ourdao-backend`). This is expected—our own `package.json` does not declare a license field (the `LICENSE` file at the repository root covers it). The license check script excludes this package by name to avoid a false positive.

## License Check

Run `npm run license:check` to validate all dependencies against this policy. This runs automatically in CI on every pull request and will fail if:
- A dependency uses a license not on the approved list above
- A dependency has no license information (`UNLICENSED` or missing `license` field in its `package.json`)
- A new direct dependency is added without review (see below)

## Direct Dependency Changes

Adding a new direct dependency (an entry in `dependencies` or `devDependencies` in `package.json`) requires explicit review. CI (`npm run check:dependency-description`, via `scripts/check-dependency-description.ts`) fails on pull requests if `package.json`'s `dependencies`/`devDependencies` are modified — added, removed, or version-bumped — and the PR description does not name every changed package, ensuring new dependencies are deliberate rather than accidental. A lockfile-only change, or any other `package.json` edit that doesn't touch those two fields, does not trigger this check.

Transitive dependencies (dependencies of dependencies) are covered by the license check but do not require separate call-out—they are pulled in by direct dependencies already under review.

## Baseline: Current Dependency Tree

As of commit 7620d26 (2026-09-24), the repository's transitive dependency tree contains:

- **MIT:** 259 packages
- **ISC:** 31 packages
- **Apache-2.0:** 19 packages
- **BSD-3-Clause:** 12 packages
- **BSD-2-Clause:** 8 packages
- **BlueOak-1.0.0:** 5 packages
- **MPL-2.0:** 3 packages
- **CC0-1.0:** 1 package
- **CC-BY-3.0:** 1 package
- **(MIT AND CC-BY-3.0):** 1 package
- **UNLICENSED:** 1 package (this repository itself—excluded by name)

**Total:** 341 packages

All licenses in the current tree are on the approved list. This baseline is recorded for comparison—future PRs that increase the count of a license type or introduce a new license will be flagged for review.

## References

- [SPDX License List](https://spdx.org/licenses/) — canonical license identifiers
- [Choose a License](https://choosealicense.com/) — plain-English license summaries
- [tl;drLegal](https://tldrlegal.com/) — license compatibility and restrictions

## Related

- `.github/workflows/ci.yml` — CI job running `npm run license:check` and `npm run check:dependency-description`
- `scripts/check-licenses.ts` — The license validation script
- `scripts/check-dependency-description.ts` — The direct-dependency-change description check
- `package.json` — Direct dependencies (additions require review)
