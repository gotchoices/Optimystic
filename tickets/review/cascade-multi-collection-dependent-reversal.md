description: When a bad transaction is automatically undone and it had written to several collections, the cleanup now undoes it in every collection instead of just one — closing a silent gap that left bad data committed in the others.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/test/cascade.spec.ts
difficulty: medium
----

# Review: cascade reverts a multi-collection dependent in every collection

## What this fixes

This is the fix for **MAJOR finding #1** filed by the review of `7.6-invalidation-cascade-detection`
(see `tickets/complete/7.6-invalidation-cascade-detection.md`): the read-dependency cascade engine
(`cascadeInvalidate`) deduped invalidated work by **`actionId` alone**. In Optimystic a transaction that
touches N collections is written to **every** affected collection's log under the **same** `actionId` (one
log entry per collection, each carrying that collection's own `blockIds`/`rev` but the same full read set).
The cascade processed the first such collection-entry, recorded the `actionId`, and then skipped every
sibling — so a multi-collection read-dependent was reverted in only **one** collection and left committed
(with bad data, and no child `InvalidationEntry`) in all the others. Silent partial reversal.

## The change (implemented)

The dedup identity is now the **`(collectionId, actionId)` pair**, not `actionId` alone, while the
transaction **horizon** still counts **distinct transactions** (so a multi-collection dependent counts once
and is reverted all-or-nothing, never split across the budget). The root stays excluded globally — the
caller drives the root reversal through consensus across all its collections, so the cascade must never
re-process the root in any collection.

Seven edits in `packages/db-p2p/src/dispute/cascade.ts`:

- **New `entryKey(collectionId, actionId)` helper** — the per-collection-entry dedup key. Mirrors `pairKey`
  and uses a **NUL separator** (`\0`), matching the existing `pairKey` convention so ids containing spaces
  cannot collide. *(Note: the ticket text illustrated a space separator; `pairKey` actually uses a literal
  NUL byte in source, so `entryKey` follows that for collision-safety and consistency. Functionally either
  works for the test ids; NUL is the safer mirror.)*
- **State swap** in `cascadeInvalidate`: `invalidatedIds: Set<ActionId>` → `processedEntries: Set<string>`
  (entryKeys reverted this cascade) plus `invalidatedTxns: Set<ActionId>` seeded with the root (distinct
  transactions, for the horizon). The old `totalInvalidated` counter is gone.
- **Candidate-loop skip** now keys on `processedEntries.has(entryKey(...))`.
- **Horizon check**: `!invalidatedTxns.has(cand.actionId) && invalidatedTxns.size + 1 > maxCascadeTransactions`
  — an already-counted transaction's remaining collection-entries pass freely.
- **On invalidate**: record both `processedEntries.add(entryKey(...))` and `invalidatedTxns.add(actionId)`.
- **`unevaluable` dedup** is now per `(collectionId, actionId)`.
- **`collectCandidates` signature** is `(envs, pairs, rootActionId, processedEntries)`; its exclusion is
  `action.actionId === rootActionId || processedEntries.has(entryKey(env.collectionId, action.actionId))`
  — a not-yet-reverted entry of the same transaction in a *different* collection remains a live candidate.
  All three call sites updated (max-depth remainder, per-round, max-transactions remainder).

## Horizon decision (documented)

`maxCascadeTransactions` counts **per transaction (actionId)**, not per collection-entry. Rationale: the
config is named "transactions", the root counts once, and — critically — per-transaction atomicity is what
guarantees a multi-collection dependent is reverted all-or-nothing even at the budget edge. Per-entry
counting was rejected: it would let the horizon revert some of a transaction's collections and escalate the
rest — re-introducing the exact partial reversal this ticket closes.

## Validation performed (this is a floor, not a ceiling)

- `cd packages/db-p2p && yarn test:verbose` → **898 passing / 30 pending / 0 failing** (the 30 pending are
  pre-existing `DOC EXPECTATION NOT YET IMPLEMENTED` skips, unrelated). The full "Invalidation cascade" block
  is green: 10 prior tests + 3 new ones.
- `cd packages/db-p2p && yarn build` (tsc) → exit 0, no type errors. `tsc` is the only type/lint gate.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.

### Three regression tests added to `packages/db-p2p/test/cascade.spec.ts`

The harness already supports multi-collection transactions: seed the **same** `actionId` with the **same**
`reads` into two collections, each with its own genesis revision so the revert computes a real `restore`
rather than a deferred-delete.

1. **`reverts a multi-collection dependent in every collection it wrote (not just one)`** — the core
   regression. Root `tinv` writes `X` in `A` (rev 2); `t2` writes `P` in `A` (rev 3) **and** `Q` in `B`
   (rev 2), both reading `X@2`. Asserts `result.invalidated` (sorted) `=== ['A:t2','B:t2']`, both
   `a.log.findInvalidation('t2')` and `b.log.findInvalidation('t2')` carry `cascadeRoot === 'tinv'`,
   `countInvalidationEntries(a) === 2` (root + t2), `countInvalidationEntries(b) === 1`, no escalation.
   **Pre-fix this fails** — only the lower-rev `B:t2` reverts.
2. **`is idempotent for a multi-collection dependent`** — run the cascade twice from the same root; the
   second run reports `['A:t2','B:t2']` again and adds **no** duplicate entries (counts stay A:2, B:1) via
   the `already-applied` path, per collection-entry.
3. **`counts a multi-collection dependent once at maxCascadeTransactions`** — budget = root + 1. The single
   multi-collection `t2` lands in **both** collections (one transaction); an independent dependent `t3`
   (distinct actionId, reads `X@2`) is the one escalated (`reason === 'max-transactions'`, remainder
   includes `t3`, `t3` never applied). Proves the horizon counts `t2` once, not once-per-collection-entry,
   and never splits it.

## Where a reviewer should push (known gaps / things to scrutinize)

- **Not wired into a live composition root.** As documented in the parent handoff, `cascadeInvalidate` is
  not yet invoked by any production data path (no engine builds the `CollectionEnv` universe / cross-collection
  read index and calls it). This remains a **latent, pre-wiring correctness fix** — exercised only by the
  unit harness. The dedup correctness is what's under review here, not end-to-end integration.
- **In-memory test harness only.** The `MemLogStore` / `MemoryRawStorage` harness models the multi-collection
  log shape (same actionId across collection logs) by construction — it does **not** prove that the *real*
  `TransactionCoordinator.commitToCollection` path actually produces that shape. The ticket's root-cause
  analysis asserts it does (`coordinator.ts` passes `transaction.reads` verbatim and uses `actionId =
  transaction.id` for every collection); a reviewer may want to confirm that against the coordinator code
  rather than take the harness as evidence.
- **`entryKey` separator divergence from the ticket.** I used a NUL separator (mirroring `pairKey`) where the
  ticket text showed a space. Confirm you agree this is the better choice; it only matters for ids containing
  the separator char, which the test ids do not exercise.
- **Stray NUL byte in `pairKey` source.** Pre-existing and unrelated to this fix: `pairKey`'s template
  literal contains a literal `0x00` byte as its separator (not an escape), which makes the file read as
  "binary" to grep/ripgrep. Left untouched (out of scope, minimal diff) but flagged — a reviewer may want a
  follow-up to normalize it to a `\0` escape for tooling friendliness.
- **Diamond/back-edge/legacy paths** were re-run green but not re-derived for the multi-collection case beyond
  what test 1–3 cover. `assertForwardOnly` is per-collection (compares revs only within the same collection),
  so a transaction's cross-collection entries (`A:t2@3`, `B:t2@2`) cannot trip it — worth a sanity re-read.

## Suggested review focus

1. Re-read `collectCandidates`' exclusion predicate and the candidate-loop top skip together — confirm that a
   sibling collection-entry of a counted transaction is never lost *and* never double-processed across rounds.
2. Confirm the horizon's `!invalidatedTxns.has(...)` bypass cannot let an unbounded number of *distinct*
   transactions through (it only ever bypasses entries whose transaction is already counted).
3. Decide whether the multi-collection commit-shape assumption deserves its own integration test against the
   real coordinator, or whether that is the wiring ticket's job.
