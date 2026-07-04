description: Review documentation, tripwire comment, and regression test added to confirm that a private key passed to sign() is never copied into the replicated transaction record.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/statement-secret-arg-redaction.spec.ts, docs/transactions.md, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/src/plugin.ts
difficulty: easy
----

## What was built

No source-behavior change. Only documentation, one NOTE-tagged comment, and verification that the pre-existing regression test is wired to the suite.

### Regression guard (pre-existing, verified green)

`packages/quereus-plugin-optimystic/test/statement-secret-arg-redaction.spec.ts` — two tests:

1. **Argument redaction** — `INSERT ... VALUES (probe_sign('hello', '<SECRET>'))` results in a recorded statement containing `sig(hello)` and NOT the secret. Pins the guarantee that function arguments are evaluated away before the statement record is built.
2. **Column-value exposure** — `INSERT INTO keys (id, priv) VALUES ('<SECRET>')` records the secret verbatim. Pins the true exposure boundary so a future reader can't mistake "column value is still recorded" for a regression of the argument-redaction guarantee.

Both pass in `yarn test` (296 passing, 0 failing, 11 pending).

### Tripwire comment added

`txn-bridge.ts`, `addStatement()` docblock — `// NOTE:` block explains that recorded statements are engine-rebuilt from evaluated values, not source SQL; names the relevant test and docs section.

### docs/transactions.md

New section "Secrets and the replicated statement record" (placed before "Terminology"):
- explains the rebuild mechanism
- shows concrete SQL examples of what is vs. is not recorded
- states the rule: never store raw private-key material as a column in an optimystic-backed table

### packages/quereus-plugin-crypto/README.md

Security note inserted at the top of the `sign()` SQL function section.

### packages/quereus-plugin-crypto/src/plugin.ts

Security note added as a block comment in the `sign` function schema, near the `returnType` field.

## Test coverage

The regression guard was pre-existing from the fix stage. The implement stage verified it is picked up by the mocha glob `test/**/*.spec.ts` and passes with the full suite.

## Known gaps / tripwires

- The `sign` schema comment in `plugin.ts` refers to "the Quereus engine rebuilds the replicated statement from evaluated column values" — this is correct for the optimystic adapter but the crypto plugin itself has no direct dependency on the adapter. The comment is accurate as written (it says "with respect to Optimystic replication") but is documenting a cross-package guarantee. If the crypto plugin is ever used with a different replication layer, this note should be revisited. Filed as a code-comment tripwire, not a ticket.

## Review findings

- Tripwire at `txn-bridge.ts:addStatement` parked in the NOTE comment; listed in `## Review findings` per tripwire rules.
- No behavior change; review focus is documentation accuracy and comment placement.
