description: Confirmed and documented that a private key passed to sign() is never copied into the replicated transaction record; only values stored as table columns are replicated.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/statement-secret-arg-redaction.spec.ts, docs/transactions.md, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/src/plugin.ts
----

## Summary

Security-review concern: does `INSERT ... VALUES (sign(data, '<privkey>'))` copy the
private-key literal into the replicated transaction record and ship it to peers?

**Answer: no.** The Quereus engine records a DML statement that it **rebuilds from the
already-evaluated row values**, not from the source SQL text. Function arguments are
evaluated and discarded before the rebuild, so a secret passed as an argument never
reaches the record. The only value that lands in the replicated record is one that
becomes a **persisted column value**.

The implement stage added documentation, one `NOTE:`-tagged tripwire comment, and verified
the pre-existing regression test is wired into the suite. No source behavior changed.

## What landed

- `docs/transactions.md` — new "Secrets and the replicated statement record" section
  (mechanism, concrete SQL examples, the rule "never store raw private-key material as a
  column in an optimystic-backed table").
- `packages/quereus-plugin-crypto/README.md` — security note at the top of the `sign()`
  function section.
- `packages/quereus-plugin-crypto/src/plugin.ts` — security note in the `sign` schema block.
- `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` — `NOTE:`
  tripwire in the `addStatement()` docblock explaining the rebuild mechanism.
- `packages/quereus-plugin-optimystic/test/statement-secret-arg-redaction.spec.ts`
  (pre-existing, from fix stage) — two tests pinning the argument-redaction guarantee and
  the true column-value exposure boundary.

## Review findings

**Verdict: accepted, no changes needed. Documentation-only ticket, claims verified
end-to-end.**

Checked:

- **Core mechanism claim (the linchpin)** — verified end-to-end, not just from the test.
  `optimystic-module.ts:904` feeds `txnBridge.addStatement(mutationStatement)`, where
  `mutationStatement` is the engine-provided rebuilt statement from the xUpdate args — NOT
  raw SQL. The docstring/docs claim is accurate at the recording site.
- **Referenced symbols/paths exist** — `buildInsertStatement` / `buildUpdateStatement` /
  `buildDeleteStatement` (quereus `src/util/mutation-statement.ts:10/33/59`), `dml-executor.ts`,
  `TransactionBridge.getStatements()` (`txn-bridge.ts:572`), and `optimystic.txnBridge`
  (exposed at `plugin.ts:64`) all exist. Docs and comments point at real code.
- **Regression test wiring** — matched by the mocha glob `test/**/*.spec.ts`; imports
  `../dist/plugin.js` (build required first — done). Both tests exercise the real
  `TransactionBridge` recording path; the hermetic `probe_sign` stand-in is a sound
  abstraction because redaction is an engine property (statement rebuild), not a property
  of `sign()` specifically.
- **Build / lint / typecheck / tests** — `yarn build` (optimystic) success;
  `yarn test` = **296 passing, 0 failing, 11 pending**; `eslint` on the three touched files
  clean; `tsc --noEmit` on crypto plugin clean. All green.
- **Docs accuracy vs. new reality** — read every touched file; docs, README, and both code
  comments describe the mechanism correctly and consistently.

Found:

- **Tripwire (carried from implement, confirmed valid)** — the `sign` schema comment in
  `crypto/src/plugin.ts` and the README security note document a cross-package guarantee
  (Optimystic replication behavior) that lives in the crypto package, which has no direct
  dependency on the adapter. Both are phrased "with respect to Optimystic replication," so
  they are accurate as written. Parked as a code-comment tripwire — revisit only if the
  crypto plugin is used with a different replication layer. Not a ticket.
- **WHERE-clause secrets (noted, no action)** — a secret used only as a WHERE predicate
  (e.g. `DELETE FROM t WHERE priv='<secret>'`) is also not recorded, since the rebuilt
  DELETE/UPDATE keys off the matched rows' primary key, not the original predicate. This is
  already covered by the docs' general rule ("only a persisted column value lands in the
  record"), so no doc change is needed. Recorded here for the index only.

Empty categories:

- **New tickets (major findings): none.** No correctness, security, type-safety, resource,
  or error-handling defect surfaced — the change adds no runtime code path.
- **Inline fixes (minor findings): none.** Documentation and comments are accurate,
  well-placed, and consistent across the five touched files; nothing to correct.
