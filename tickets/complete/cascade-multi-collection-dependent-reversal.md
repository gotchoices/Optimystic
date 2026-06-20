description: When a bad transaction is automatically undone and it had written to several collections, the cleanup now undoes it in every collection instead of just one — and does so completely even when the cleanup hits its safety budget mid-way.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/test/cascade.spec.ts
difficulty: medium
----

# Complete: cascade reverts a multi-collection dependent in every collection (incl. at the budget edge)

Archived summary of the implemented + reviewed fix for MAJOR finding #1 of
`7.6-invalidation-cascade-detection`: the read-dependency cascade engine (`cascadeInvalidate`) deduped
invalidated work by `actionId` alone, so a transaction that wrote to N collections (one log entry per
collection, all sharing the same `actionId` and read set) was reverted in only one collection and left
committed — with bad data — in the rest. Silent partial reversal.

## What was implemented (pre-review)

Dedup identity became the **`(collectionId, actionId)` pair** (`entryKey`), while the transaction
**horizon** (`maxCascadeTransactions`) still counts **distinct transactions** so a multi-collection
dependent counts once and is reverted all-or-nothing. Three regression tests were added. See the
implement commit `de41b3e` for the full description.

## Review findings

Adversarial pass over the implement diff (`de41b3e`) and the files it touched/should have touched.

### MAJOR — fixed inline: silent partial reversal survived at the transaction horizon

The implement diff fixed the common case but **re-introduced the exact bug it set out to close at the
budget boundary**, contradicting its own documented guarantee ("per-transaction atomicity guarantees a
multi-collection dependent is reverted all-or-nothing *even at the budget edge*").

- **Root cause.** When a would-be-invalidated **new** transaction was refused at the horizon, the loop did
  `break`, abandoning the rest of the round's sorted candidates. Candidates are sorted by `(rev,
  collectionId, actionId)`. Because cross-collection revisions are independent sequences, an independent
  over-budget transaction can sort **between** a protected (already-counted) multi-collection
  transaction's two collection-entries. The `break` then dropped the protected transaction's
  later-sorted sibling entry → it was reverted in one collection and only **escalated** (left committed)
  in the other. Silent partial reversal.
- **Reproduced** with a probe before fixing: root `tinv` writes `X@2` in `A`; `t2` (one transaction) writes
  `P@3` in `A` and `Q@5` in `B`, both reading `X@2`; independent `tN@4` (in `A`) reads `X@2`; budget = root + 1.
  Pre-fix result: `invalidated = [A:t2]`, with `B:t2` sitting in the escalation remainder (A entries 2,
  B entries 0). All-or-nothing violated.
- **Fix** (`packages/db-p2p/src/dispute/cascade.ts`): on a horizon refusal, **skip only the over-budget
  newcomer** (`continue`) instead of breaking the round, so already-counted transactions finish every
  remaining collection-entry. The `max-transactions` escalation is now built **once after** the protected
  transactions drain, so its `remainder` reflects only what was genuinely left un-cascaded (never a
  half-reverted transaction). Removed the `horizonHit` early-break; added a `horizonReached` flag and a
  post-loop escalation block. Non-horizon cascades are byte-for-byte unaffected (the early break was the
  only place the loop ever exited before its natural fixpoint).
- **Regression test added** (`packages/db-p2p/test/cascade.spec.ts`): *"reverts a multi-collection
  dependent all-or-nothing even when an over-budget txn interleaves at the horizon"* — the probe scenario,
  now asserting `invalidated = ['A:t2','B:t2']`, `escalation.reason = 'max-transactions'`,
  `remainder = ['tN']`, `tN` not applied, A entries 2 / B entries 1. Fails pre-fix, passes post-fix.

### Verified — no finding

- **Coordinator commit-shape assumption (the implementer flagged this as "confirm against the real
  coordinator").** Confirmed against `packages/db-core/src/transaction/coordinator.ts:532-548`: every
  collection's `log.addActions(...)` is called with `actionId = transaction.id` (identical across
  collections) and `transaction.reads` (the whole transaction's read set, identical across collections),
  with per-collection `blockIds` via `blockIdsForTransforms`. The in-memory harness therefore models the
  real multi-collection log shape faithfully; the fix's premise holds in production code.
- **`assertForwardOnly` vs. cross-collection entries.** Re-read: it only compares revs within the same
  collection, so a transaction's `A:t2@3` / `B:t2@2` cross-collection entries cannot trip it. Correct.
- **Diamond / idempotency / already-applied paths.** Re-derived for the multi-collection case; covered by
  the three implement tests plus the new one. The `entryKey`-keyed `processedEntries` and the
  `invalidatedTxns.has(...)` horizon short-circuit together ensure a sibling entry is never lost and never
  double-processed across rounds.
- **Horizon cannot leak unbounded distinct transactions.** The `!invalidatedTxns.has(...)` bypass only ever
  admits entries whose transaction is **already counted**; a genuinely new transaction always hits the
  `size + 1 > max` guard. Confirmed.
- **`unevaluable` dedup** is per `(collectionId, actionId)` — correct for the multi-collection case.

### Deferred — pre-existing, out of scope: literal NUL byte in `pairKey` source

`pairKey` (`cascade.ts:67`) embeds a **literal `0x00` byte** as its template-literal separator (not the
`\0` escape `entryKey` uses). Runtime behaviour is identical and correct — but the literal byte makes git
treat the whole file as **binary** ("Bin" in `--stat`, unreadable text diffs on every future change).
Pre-existing (untouched by this ticket; the implementer flagged it too). Attempted to normalize it to the
`\0` escape during review, but this environment collapses the `\0` escape back into a literal NUL on
Bash-level writes to this tracked file (the Edit-tool-written `entryKey` keeps its escape; Bash writes to
the un-Edited line 67 revert to the cached NUL). Left as committed (runtime-correct) and filed as a small
backlog ticket — `cascade-pairkey-nul-byte-normalization` — to be done through the editor by tooling that
cooperates.

### Docs

No markdown/design docs reference the cascade horizon or `maxCascadeTransactions` (grepped). The
documentation surface is the JSDoc in `cascade.ts`, which was updated by the fix (horizon-refusal comment,
post-loop escalation comment, `horizonReached` rationale) to reflect the now-true all-or-nothing guarantee.

## Validation

- `cd packages/db-p2p && yarn build` (tsc) → exit 0, no type errors.
- `cd packages/db-p2p && yarn test` → **899 passing / 30 pending / 0 failing** (the 30 pending are the
  pre-existing `DOC EXPECTATION NOT YET IMPLEMENTED` skips; the +1 over the implementer's 898 is the new
  regression test). Full "Invalidation cascade" block green: 14 tests. No `.pre-existing-error.md` written.

## Known latent gaps (carried forward, not regressions)

- `cascadeInvalidate` is still **not wired into a live composition root** — no production path builds the
  `CollectionEnv` universe / cross-collection read index and invokes it. This remains a latent, pre-wiring
  correctness fix exercised only by the unit harness. Whether the multi-collection commit shape deserves
  its own integration test against the real coordinator is the wiring ticket's call (the assumption itself
  is now verified above).
