<!--
Please read CONTRIBUTING.md before opening this PR.
PRs against an unassigned issue will be closed with a pointer back to it.
-->

## What this changes

<!-- One or two sentences. What behavior is different after this PR? -->

## Why

<!-- The diff shows what changed. Explain why this is the right change. -->

Closes #<!-- issue number -->

## Testing

<!-- Name the test(s) you added or updated, and what would break without this change. -->

- [ ] Added or updated a test that fails without this change
- [ ] Tests run against a real Postgres (not mocked)
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` succeeds

## Backend checklist

<!-- Delete any line that genuinely doesn't apply. -->

- [ ] Introduces no signing path, private key, or outbound transaction submission
- [ ] Event folding stays inside a single database transaction
- [ ] Indexer changes remain resumable from the persisted cursor
- [ ] No bigint reaches a response body unserialized (still stringified)
- [ ] Schema changes are additive, or the breaking change is described below
- [ ] Updated CHANGELOG.md's `[Unreleased]` section (if this is a user-visible change, a migration, or requires an operator action)
- [ ] Ran `npm run openapi:generate` and committed the updated `openapi.json` (if this adds or changes an API route)

### Schema changes

<!-- Any new/changed/removed columns or tables, and whether existing databases need attention. Write "None" if not applicable. -->

None

### New contract events handled

<!-- If this adds a decoder for a new event, name it and the ourdao-contracts commit that introduced it. Write "None" if not applicable. -->

None

## Anything reviewers should look at closely

<!-- Optional. Point at the part you're least sure about. -->
