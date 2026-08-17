----
description: One test file has grown to over five thousand lines covering half a dozen unrelated subjects, which makes it slow to navigate and easy to bury duplicate or dead coverage in. Split it by subject.
files:
  - packages/db-core/test/transaction.spec.ts (5,150 lines — the file to split)
  - packages/db-core/test/collection.spec.ts (1,343 lines — an example of the size the split parts should land at)
  - eslint.config.js (optional second arm: a max-lines cap for test files, to hold the line afterwards)
difficulty: medium
tradeoffs: Splitting a test file changes no behaviour and buys only navigability, so a maintainer may reasonably decide the churn is not worth it — especially while other tickets have in-flight edits to the same file that a split would conflict with.
----

# The problem

`packages/db-core/test/transaction.spec.ts` is **5,150 lines**, measured with:

```bash
find packages -name "*.spec.ts" -not -path "*/node_modules/*" -exec wc -l {} + | sort -rn | head
```

It is more than **twice** the next-largest spec in the repo (`packages/db-p2p/test/storage-repo.spec.ts`,
2,300 lines) and roughly four times the median large spec. It is an outlier, not the house style.

The size is not one subject that happens to be big. The file's top-level `describe` blocks cover
several unrelated subjects, among them:

- the transaction coordinator's GATHER / PEND / COMMIT phases and its supercluster handling,
- the coordinator's backoff-and-retry behaviour when a commit loses a race,
- transaction validation,
- transaction sessions,
- client transaction signatures,
- statement recording.

Each of those has its own helper classes and fixtures, defined inline near where they are first
used. Two consequences show up in practice:

- **Helpers get re-invented rather than reused.** The file already carries several near-identical
  hand-rolled transactor wrappers, each forwarding the same five methods to an inner transactor.
  They were separately written because nobody scrolling to line 4,100 knows what exists at line 900.
- **Coverage is hard to audit.** Answering "is this behaviour already tested?" means reading five
  thousand lines, so the honest answer is usually "probably, somewhere" — which is how duplicate
  and dead coverage accumulates.

# What good looks like

Split by subject into files sized like the rest of the repo's specs (roughly 800-1,500 lines each),
with shared fixtures lifted into a small `test/helpers/` module rather than copied. Nothing about
what is asserted should change — this is a move, not a rewrite, and the total passing count before
and after must match.

An optional second arm, if the split is done: add a `max-lines` cap for `**/*.spec.ts` in
`eslint.config.js`, set just above the largest post-split file, so the next file to grow past it
fails lint instead of quietly becoming the new outlier. Without this the file re-grows.

# Arm added by the `debt-e2e-stale-cache-hit-read-rejected` review

The duplication is not confined to this one file, and the `test/helpers/` module above is the
natural home for the fix. Standing up a `TransactionValidator` needs the same four-part wiring every
time — an engine registration map, a stub validation-coordinator factory, a block-state provider,
and a `makeTxn` that builds a correctly-hashed stamp. That block is currently hand-copied at roughly
fifteen sites inside `transaction.spec.ts` and again, in near-identical form, in two other files:

- `packages/db-core/test/occ-structural-read-exclusion.spec.ts` (`makeValidator`, ~line 261)
- `packages/db-core/test/read-dependency-e2e.spec.ts` (`makeValidator`, ~line 74)

Counted with:

```bash
grep -c "new TransactionValidator" packages/db-core/test/transaction.spec.ts
grep -rln "new TransactionValidator" packages/db-core/test packages/db-core/src
```

The copies have already drifted in small ways (which constructor arguments are supplied, whether the
provider reads a real transactor or a synthetic revision map), so a reader cannot tell at a glance
whether two tests are validating under the same conditions. When the split lifts fixtures into
`test/helpers/`, lift this wiring too and have all three files use it.

# Sequencing note

Other tickets have in-flight edits against this file (they cite line ranges within it). A split
invalidates those line references and will conflict with any uncommitted work, so this should be
scheduled when the board is quiet on `transaction.spec.ts`, not alongside it.
