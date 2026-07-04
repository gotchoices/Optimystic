description: The worry that a private signing key passed to a SQL function gets copied into replicated data and sent to other machines turned out not to happen — record the finding, lock it with a test, and document the one real thing to avoid (never store a raw key in a replicated table).
files: packages/quereus-plugin-optimystic/test/statement-secret-arg-redaction.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, docs/transactions.md, packages/quereus-plugin-crypto/README.md, packages/quereus-plugin-crypto/src/plugin.ts
difficulty: easy
----

## What the fix stage found

The original concern (from a security review) was: a statement like
`INSERT ... VALUES (sign(<data>, '<privkey>'))` is captured **verbatim** into the
replicated transaction record and shipped to validator peers to re-execute, so
the private key leaves the machine.

**Reproduced and disproved.** The replicated `mutationStatement` is **not** the
user's SQL text. The Quereus engine **rebuilds** it from the already-evaluated
row values — see
`packages/quereus-plugin-optimystic/node_modules/@quereus/quereus/src/util/mutation-statement.ts`
(`buildInsertStatement` / `buildUpdateStatement` / `buildDeleteStatement`, each
called from `dml-executor.ts` with the post-evaluation `newRow`). A function's
arguments are evaluated and discarded before the statement is rebuilt, so:

- A secret passed as a **function argument** (`sign(data, key)`) never reaches the
  record — the record holds only the function's **result** (a public signature).
  Peers re-run `insert ... values (1, '<signature>')`; they never re-run `sign()`,
  so no key is present to leak. **Literal-vs-bound is irrelevant here** — the
  argument is gone either way.
- The **only** value that lands in the record is one that becomes a **persisted
  column value**. So storing a raw key *as a column* (`INSERT INTO keys(priv)
  VALUES('<key>')`) does replicate it — but that is inherent to any replicated
  store and, again, literal-vs-bound makes no difference (a bound param that
  becomes a column value is re-literalized into the rebuilt statement too).

Empirical proof lives in the regression test added this stage
(`test/statement-secret-arg-redaction.spec.ts`, 2 passing): the argument case
records `sig(hello)` with the secret absent; the column-value case records the
secret verbatim.

### Design decision: no redact/reject in the replication layer

The ticket asked us to resolve redact-vs-reject. **Neither is warranted:**

- Nothing to **redact** — `sign()` (and its key argument) never appears in the
  recorded statement; only its evaluated result does.
- **Rejecting** "secret-bearing" DML is undecidable and wrong — the recording
  layer sees only literal values (post-evaluation); it cannot tell a private key
  from any other TEXT, and rejecting column-valued strings would break normal
  writes. A persisted column value is legitimate data the DB must replicate.

The correct response is **documentation of the actual model**, plus the
regression guard that pins the argument-redaction guarantee so a future engine
change can't silently regress it.

## Remaining work (implement)

The reproducing/guard test is already committed and green. What's left is
documentation and one tripwire comment.

- [ ] **Verify the guard test runs in-suite.** Confirm
  `test/statement-secret-arg-redaction.spec.ts` is picked up by the package's
  `yarn test` (mocha glob `test/**/*.spec.ts`) and passes. It is hermetic (uses an
  inline `probe_sign` stand-in; no dependency on the crypto package being built).

- [ ] **docs/transactions.md** — add a short section (near the "Transaction
  Structure" / statement-record material) titled e.g. *"Secrets and the
  replicated statement record"* stating: recorded statements are rebuilt from
  evaluated row values, not source SQL; function arguments (including a key passed
  to `sign()`) are never recorded; only persisted column values are replicated;
  therefore **never store raw private-key material as a column in an
  optimystic-backed table** — sign/derive and store only the public result.

- [ ] **packages/quereus-plugin-crypto/README.md** and the `sign` JSDoc/comment in
  `packages/quereus-plugin-crypto/src/plugin.ts` (around the `sign` schema) — add a
  one-paragraph security note: passing a private key to `sign()` (as a literal or
  a bound parameter) is safe with respect to replication because the argument is
  evaluated away; the thing to avoid is persisting the key itself into a table.

- [ ] **Tripwire NOTE at the recording site.** In
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` at
  `addStatement(...)` (the statement-accumulation point), add a
  `// NOTE:`-tagged comment: statements recorded here are engine-rebuilt from
  evaluated values, so secrets passed as function arguments are not present; the
  only secret-exposure vector is a secret stored as a persisted column value —
  see docs/transactions.md. This orients a future reader who lands at the record
  site expecting raw SQL.

- [ ] Run `yarn test` for `packages/quereus-plugin-optimystic` and confirm green
  (stream with `tee`). No source-behavior change is expected — this stage only
  adds docs/comments/tests.
