description: In the default commit mode, a write that touches a table and its indexes used to save each one separately, so when two machines raced on the same unique value the loser's row was saved before its unique index refused it. That commit now reserves every piece first and saves only once all pieces are accepted, so a refused write leaves nothing behind. Reviewed and complete.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitDirtyTreesLegacy`, `legacyBatch`, `commitBatchLegacy`, `legacyTransaction`, `restoreUncommittedTrees`, `sweepDirtyTreesLegacy`, `DirtyTree.getCollection`, `PartialCommitError` doc, the `CoordinatorPartialCommitError` branch of `commitTransaction`)
  - packages/db-core/src/transaction/coordinator.ts (`CoordinatorOptions`, `PendValidationMode`, `pendValidationFor`, `pendCollection`, `stagedCollections`)
  - packages/db-core/src/network/struct.ts (`PendRequest.validation` and `PendRequest.priority` docs)
  - packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/pend-validation.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/testing/mesh-harness.ts (comment-only: which pends carry no validation)
  - packages/db-core/test/coordinator-unvalidated-pend.spec.ts (new)
  - packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts (new — the regression)
  - packages/quereus-plugin-optimystic/test/legacy-batch-shared-collection-id.spec.ts (new in review — two tree instances over one collection id)
  - packages/quereus-plugin-optimystic/test/selective-failure-transactor.ts (new shared helper)
  - packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts (rewritten)
  - packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, committed-read-stall.spec.ts, commit-gate.ts, concurrent-secondary-unique-refusal.spec.ts, concurrent-insert-refusal.spec.ts, two-node-multi-collection-commit.spec.ts, committed-read-conformance.spec.ts, two-node-secondary-index-convergence.spec.ts (harness or comment updates)
  - docs/transactions.md (the legacy commit section, rewritten), docs/internals.md, docs/debugging.md
  - tickets/backlog/debt-session-mode-bridge-coverage.md, tickets/backlog/bug-concurrent-unique-refusal-is-not-a-constraint-error.md (notes appended)
difficulty: hard
repro: verified
----

# Legacy multi-tree commit: pend everything, then commit everything — complete

## What shipped

A legacy (no-coordinator) commit with two or more trees that have something to push goes through a `TransactionCoordinator` built for that one commit over exactly those trees' collections. The coordinator's new constructor option `pendValidation: 'none'` makes its pends carry bare transforms (the shape every legacy write always sent) with the aged retry priority on the pend itself. A single-tree commit still uses that tree's own `sync()`. The per-tree sweep, with its pre-flight refresh and its `PartialCommitError`, remains only as a fallback for trees that cannot share one batch. A commit-phase split on the batch surfaces as db-core's `CoordinatorPartialCommitError` in legacy mode too; the bridge restores the failed trees to their pre-transaction snapshots and latches degraded.

A second defect was fixed on the way: the coordinator's participant filter keyed on tracker transforms alone, so a collection whose only staged action changed no block (a blind index delete against a stale view) was dropped from the batch. The filter now uses `Collection.hasUnsyncedChanges()`, the predicate `sync` loops on.

The implement-stage handoff (its reproduction, decisions, coverage list, and consequences) is preserved below the review findings.

## Review findings

### What was checked

- The implement diff, read with fresh eyes before the handoff: the coordinator changes (option plumbing, `pendValidationFor`, the pend-request shape, the widened participant filter), the whole of the bridge's legacy commit path, the `PendRequest` docs, the three docs files, and every changed or new spec.
- The coordinator's retry loop, refresh-between-attempts, stale-loss restore, and partial-commit reporting, to confirm the legacy transaction (no statements, no reads, no `beginTransaction` on the coordinator) is handled on every exit: clean loss (trackers restored, bridge rolls back to pre-transaction snapshots, guard refusal mapped to the constraint message), refresh-saved participants (reported as committed), and commit-phase split (committed half folded, failed half restored by the bridge).
- Whether consuming a refresh-saved entry clears the collection's pending actions, which the widened `hasUnsyncedChanges` filter relies on for the "everything saved, return now" exit. It does (`Collection.unstage` filters pending by identity).
- Resource cleanup: the per-commit coordinator registers nothing durable; in-flight marks are disposed in `commit`'s `finally`; the stamp entry is released on every success exit.
- Validation, all green: `yarn build`; `yarn lint`; `yarn lint:docs`; `yarn typecheck`; `yarn workspace @optimystic/db-core test` (1803 passing); `yarn workspace @optimystic/quereus-plugin-optimystic test` (992 passing, 13 pending, 0 failing — 991 from the implement stage plus the new witness below). db-p2p's suite was not run: its four changed files are comment-only and the build compiled them.
- Every open backlog ticket and doc that names the old sweep, for stale statements.

### Found and fixed inline (minor)

- **Two dirty tree instances over one collection id were silently half-committed.** `commitBatchLegacy` keys the coordinator's collection map by id, so two `Tree` instances over one id (two tables declared over the same URI in one Database) collapsed to one entry; the dropped instance's staged rows were never pushed, and the commit reported success with no latch. The old sweep pushed both (the second instance's `sync` refreshes onto the first's commit and replays). Fixed: `legacyBatch` sends such a pair to the sweep, with a comment naming the witness. Witness: `packages/quereus-plugin-optimystic/test/legacy-batch-shared-collection-id.spec.ts`, which failed before the guard (the first instance's row read back `undefined`) and passes after. The fallback list in `legacyBatch`'s doc and in `docs/transactions.md` names the case.
- **Three stale "tree-by-tree sweep" statements**: `docs/internals.md` (the snapshot-boundary pin bullet, which now describes both publish shapes and the renamed MID-PUBLISH stall test), the header comment of `test/committed-read-conformance.spec.ts`, and an assertion message in `test/two-node-secondary-index-convergence.spec.ts`.
- **`tickets/backlog/bug-concurrent-unique-refusal-is-not-a-constraint-error.md`** got a section saying where the legacy refusal now surfaces (raw, out of the coordinator's refresh, mapped in `commitTransaction`'s catch, as session mode's is) and that the new race spec should gain the type assertion with the two specs it names.

### Major findings

None. The one real defect found (above) was a one-line guard with a class-level explanation at the site and a witness, so it was fixed here rather than filed.

### Tripwires

No new ones. The two the implement stage recorded stand as written: the `NOTE:` at `commitBatchLegacy` (the batch pends at the revision the handle holds, so a stale tree costs one refused attempt plus the first backoff before the retry pends fresh) and the `NOTE:` at `legacyBatch` (tables on different transactor instances keep the sweep; closing it needs one batch per transactor). The mixed-transactor fallback remains untested because no host declares that configuration.

### Considered and left alone

- **Session-mode asymmetry after a partial commit.** The legacy path restores the failed trees to their pre-transaction snapshots inside `commitBatchLegacy`; session mode still leaves failed collections holding their staged DML. That is unchanged session behaviour, noted by the implementer, and inside the scope of `backlog/debt-session-mode-bridge-coverage`; not changed here.
- **The legacy coordinator stamp differs from `TransactionState.stampId`** (the value the SQL stamp-id function reports). No member ever sees the coordinator's stamp and the log entries carry the transaction id, so nothing observable depends on the two agreeing.
- **`peerId` held on the bridge rather than on `TransactionState`.** The bridge is single-writer and the field is reset on every `beginTransaction`; moving it would touch the shared state type for no behavioural gain.
- **`commit:collections` still prints `mode=legacy` for both the batch and the fallback sweep.** `docs/debugging.md` says how the set is pushed, and the error class distinguishes the two after the fact.
- **The `stagedCollections` widening in session mode** has no direct test. The legacy case that found it (`concurrent-row-change-refusal.spec.ts`) exercises the same coordinator code; the session-mode drive of it is already an open arm of `backlog/debt-session-mode-bridge-coverage`.
- **Real-socket integration (`yarn test:integration`) was not run**, as the implementer said. The fix is proven on the mock mesh, which reproduced the field signature; sereus should re-run its six-round harness before closing its blocked ticket.

---

# Implement-stage handoff (preserved)

## The reproduction and its result

`packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts`: two nodes on the in-process mock mesh (`startMockMesh(2)`), six rounds per case, same-tick inserts of different rows with one unique value, for `T(id pk, g, v unique)` alone and with a plain index on `g`; plus the mirror race (same primary key, different unique values). Before the change: torn on round 0 of both value-race cases with exactly the field signature (`PartialCommitError`, main table persisted, `_uniq_1.v` not). After: 18 of 18 rounds refuse the loser with the plain `UNIQUE constraint failed: T.v` (or `T.id` in the mirror), no partial-commit error in the cause chain, exactly the winner's row on both nodes, and exactly one committed entry in every tree, read through a fresh `Tree` around the vtab. The mirror also re-inserts the refused value under a new key from the loser's node to prove no orphan index entry stands.

## Decisions the ticket left open, and what was chosen

- **Error class for the legacy residual.** `CoordinatorPartialCommitError` passes through unchanged; `PartialCommitError` now only arises from the fallback sweep, and its doc plus `docs/transactions.md` say so. The plugin still exports `PartialCommitError` (VoteTorrent's issue-17 script constructs it directly). Both messages contain `not atomic`, which is what the existing degraded-latch specs matched on.
- **`reads` on the legacy transaction:** `[]`, matching what the single-tree sync records. The coordinator-appended entries carry the participant list and an empty reads field; the reopen-after-mixed-history case in `legacy-commit-atomicity.spec.ts` covers a history of both entry shapes.
- **Transaction identity:** a fresh stamp per commit, peer id from the factory (or `'local'`, as `TransactionSession.create` defaults), engine id `'legacy'`, empty schema hash, and a five-minute TTL (`LegacyCommitTtlMs`) because no member sees the stamp and the default 30 s could expire a contended commit before its retry budget (about 21 s of backoff) is spent.
- **Reaching the collection from a `DirtyTree`:** an optional `getCollection()` on the interface (a `Tree` has it); a double without it takes the sweep. Consistent with every other optional accessor there.
- **Partial-commit restore in legacy mode:** the failed trees are restored to their pre-transaction snapshots inside `commitBatchLegacy` before rethrowing, so the shared `CoordinatorPartialCommitError` branch in `commitTransaction` is unchanged for session mode, which still leaves failed collections holding their staged DML.
- **Pre-flight:** removed from the batch path (the coordinator's refresh between attempts does that work); kept inside the fallback sweep so that path's guarantees are exactly what they were.

## What the tests cover

- The race (above), both table shapes, plus the same-key mirror.
- A pend refusal on the index tree: nothing persisted, plain error, no latch, the handle is not wedged, reopen shows the pre-transaction rows (`legacy-commit-atomicity.spec.ts`).
- The residual: a persistent commit failure on the index tree after every pend succeeded, retried three times by the coordinator's forward recovery and then reported as `CoordinatorPartialCommitError` naming `[main]` committed and `[index]` failed; the main table's rows stay visible, the index tree reads pre-transaction, the bridge latches, reopen shows the split.
- A mixed history (single-tree commits, then batched ones) reopened through a fresh handle, by full scan and through the index.
- The degraded latch on the batch path, and the committed-read refusal naming the committed and failed sets (`committed-read-isolation.spec.ts`).
- The pend shape: an unvalidated coordinator's pends carry no `validation` and carry `priority: 1` on the retry; the default coordinator's carry the pair and age inside the transaction (`coordinator-unvalidated-pend.spec.ts`).
- The two-handle racing case in `concurrent-secondary-unique-refusal.spec.ts` asserts exactly one row on both handles and no `not atomic` text.
- Two tree instances over one collection id both land (`legacy-batch-shared-collection-id.spec.ts`, added in review).
- `committed-read-stall.spec.ts`'s "partial commit under a stall" case changed meaning: with the coordinator's three-attempt forward recovery, a stall released into a single thrown commit failure recovers and the write completes whole; the case asserts that. The permanent split is pinned by the two specs above via `selective-failure-transactor.ts`, whose failure holds across the retries.
- GitHub issue 17's `legacy-multi-tree-tear.test.mjs` only constructs `PartialCommitError`; it is not a witness. The `two-node-unique-value-race` spec is the witness for that report's shape too.

## Consequences to carry

- `backlog/debt-a-failed-refresh-can-leave-a-collection-half-restaged` is now reachable in default mode; its arm was appended by the fix stage.
- `backlog/debt-session-mode-bridge-coverage` got a note: Arm A's branch is exercised from the legacy side; the session-mode drive of it, and Arm B, remain open.
- A legacy multi-tree commit now carries the session-mode residual (a permanent commit-phase loss after every pend succeeded) rather than the sweep's wider window. Members configured `unvalidatablePendPolicy: 'reject'` refuse legacy batches as they refused legacy syncs: no change.

## For sereus

The unblock condition of `../sereus/tickets/blocked/concurrent-unique-value-race-commits-both-rows.md` (a same-instant unique-value loser refused with nothing stored) is met on the mock mesh: `packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts`, 18 of 18 rounds. The loser now sees `UNIQUE constraint failed: Strand.StampId`-style messages with no `PartialCommitError`; a caller that classifies retries by catching `PartialCommitError` should also expect `CoordinatorPartialCommitError` for the (now narrower) commit-phase residual.
