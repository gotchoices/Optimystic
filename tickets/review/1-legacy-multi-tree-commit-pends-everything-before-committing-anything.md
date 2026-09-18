description: In the default commit mode, a write that touches a table and its indexes used to save each one separately, so when two machines raced on the same unique value the loser's row was saved before its unique index refused it. That commit now reserves every piece first and saves only once all pieces are accepted, so a refused write leaves nothing behind. Review the implementation.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitDirtyTreesLegacy`, `legacyBatch`, `commitBatchLegacy`, `legacyTransaction`, `restoreUncommittedTrees`, `sweepDirtyTreesLegacy`, `DirtyTree.getCollection`, `PartialCommitError` doc, the `CoordinatorPartialCommitError` branch of `commitTransaction`)
  - packages/db-core/src/transaction/coordinator.ts (`CoordinatorOptions`, `PendValidationMode`, `pendValidationFor`, `pendCollection`, `stagedCollections`)
  - packages/db-core/src/network/struct.ts (`PendRequest.validation` and `PendRequest.priority` docs)
  - packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/pend-validation.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/testing/mesh-harness.ts (comment-only: which pends carry no validation)
  - packages/db-core/test/coordinator-unvalidated-pend.spec.ts (new)
  - packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts (new — the regression)
  - packages/quereus-plugin-optimystic/test/selective-failure-transactor.ts (new shared helper)
  - packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts (rewritten)
  - packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, committed-read-stall.spec.ts, commit-gate.ts, concurrent-secondary-unique-refusal.spec.ts, concurrent-insert-refusal.spec.ts, two-node-multi-collection-commit.spec.ts (harness or comment updates)
  - docs/transactions.md (the legacy commit section, rewritten), docs/internals.md, docs/debugging.md
  - tickets/backlog/debt-session-mode-bridge-coverage.md (note appended)
difficulty: hard
repro: verified
----

# Legacy multi-tree commit: pend everything, then commit everything — review handoff

## What changed, in one paragraph

A legacy (no-coordinator) commit that has two or more trees with something to push now goes through a `TransactionCoordinator` built for that one commit over exactly those trees' collections, with a new constructor option `pendValidation: 'none'` so its pends carry bare transforms (the shape every legacy write always sent) and the aged retry priority on the pend itself. A single-tree commit still uses that tree's own `sync()`, untouched. The per-tree sweep, with its pre-flight refresh and its `PartialCommitError`, remains only as a fallback for trees that cannot share one batch (different transactor instances, or test doubles with no collection). A commit-phase split on the batch surfaces as db-core's `CoordinatorPartialCommitError`, in legacy mode too; the bridge then restores the failed trees to their pre-transaction snapshots (the old sweep's contract for unsynced trees) and latches degraded as before.

## The reproduction and its result

`packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts`: two nodes on the in-process mock mesh (`startMockMesh(2)`), six rounds per case, same-tick inserts of different rows with one unique value, for `T(id pk, g, v unique)` alone and with a plain index on `g`; plus the mirror race (same primary key, different unique values). Before the change: torn on round 0 of both value-race cases with exactly the field signature (`PartialCommitError`, main table persisted, `_uniq_1.v` not). After: 18 of 18 rounds refuse the loser with the plain `UNIQUE constraint failed: T.v` (or `T.id` in the mirror), no partial-commit error in the cause chain, exactly the winner's row on both nodes, and exactly one committed entry in every tree, read through a fresh `Tree` around the vtab. The mirror also re-inserts the refused value under a new key from the loser's node to prove no orphan index entry stands.

## A second defect found and fixed on the way

The first full plugin run failed `concurrent-row-change-refusal.spec.ts` ("a row deleted through a handle whose index tree never saw the entry leaves no orphan"). The coordinator's participant filter, `stagedCollections`, keyed on tracker transforms alone, so a collection whose only staged action changed no block (a blind index delete against a stale view) was dropped from the batch; the sweep never hit this because each tree's `updateAndSync` refreshed and replayed first. The filter now uses `Collection.hasUnsyncedChanges()` (pending actions or transforms), the predicate `sync` loops on. This is a latent session-mode fix as well: a session-mode delete through a stale index tree would have committed the row delete without the index delete. No session-mode test was added for it; the legacy case is covered by the existing spec that found it.

## Decisions the ticket left open, and what was chosen

- **Error class for the legacy residual.** `CoordinatorPartialCommitError` passes through unchanged; `PartialCommitError` now only arises from the fallback sweep, and its doc plus `docs/transactions.md` say so. The plugin still exports `PartialCommitError` (VoteTorrent's issue-17 script constructs it directly). Both messages contain `not atomic`, which is what the existing degraded-latch specs matched on.
- **`reads` on the legacy transaction:** `[]`, matching what the single-tree sync records. The coordinator-appended entries carry the participant list and an empty reads field; the reopen-after-mixed-history case in `legacy-commit-atomicity.spec.ts` covers a history of both entry shapes.
- **Transaction identity:** a fresh stamp per commit, peer id from the factory (or `'local'`, as `TransactionSession.create` defaults), engine id `'legacy'`, empty schema hash, and a five-minute TTL (`LegacyCommitTtlMs`) because no member sees the stamp and the default 30 s could expire a contended commit before its retry budget (about 21 s of backoff) is spent.
- **Reaching the collection from a `DirtyTree`:** an optional `getCollection()` on the interface (a `Tree` has it); a double without it takes the sweep. Consistent with every other optional accessor there.
- **Partial-commit restore in legacy mode:** the failed trees are restored to their pre-transaction snapshots inside `commitBatchLegacy` before rethrowing, so the shared `CoordinatorPartialCommitError` branch in `commitTransaction` is unchanged for session mode, which still leaves failed collections holding their staged DML (unchanged behaviour, noted as an asymmetry below).
- **Pre-flight:** removed from the batch path (the coordinator's refresh between attempts does that work); kept inside the fallback sweep so that path's guarantees are exactly what they were.

## How to validate

```
yarn build
yarn workspace @optimystic/quereus-plugin-optimystic test      # 991 passing, 13 pending, 0 failing (2 min)
yarn workspace @optimystic/db-core test                          # 1803 passing (10 s)
yarn lint && yarn lint:docs && yarn typecheck
```

Targeted, from `packages/quereus-plugin-optimystic`:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/two-node-unique-value-race.spec.ts" "test/legacy-commit-atomicity.spec.ts" "test/committed-read-isolation.spec.ts" "test/committed-read-stall.spec.ts" "test/concurrent-*.spec.ts" "test/two-node-*.spec.ts" "test/session-mode-commit.spec.ts" --reporter spec --exit
```

To see the regression fail, revert `legacyBatch` to return `undefined` unconditionally: both value-race cases fail on round 0 with the field signature.

## What the tests cover, and what they do not

Covered:
- The race (above), both table shapes, plus the same-key mirror.
- A pend refusal on the index tree: nothing persisted, plain error, no latch, the handle is not wedged, reopen shows the pre-transaction rows (`legacy-commit-atomicity.spec.ts`).
- The residual: a persistent commit failure on the index tree after every pend succeeded, retried three times by the coordinator's forward recovery and then reported as `CoordinatorPartialCommitError` naming `[main]` committed and `[index]` failed; the main table's rows stay visible, the index tree reads pre-transaction, the bridge latches, reopen shows the split.
- A mixed history (single-tree commits, then batched ones) reopened through a fresh handle, by full scan and through the index.
- The degraded latch on the batch path, and the committed-read refusal naming the committed and failed sets (`committed-read-isolation.spec.ts`).
- The pend shape: an unvalidated coordinator's pends carry no `validation` and carry `priority: 1` on the retry; the default coordinator's carry the pair and age inside the transaction (`coordinator-unvalidated-pend.spec.ts`).
- The two-handle racing case in `concurrent-secondary-unique-refusal.spec.ts` now asserts exactly one row on both handles and no `not atomic` text; its comment excusing the tear is gone.

Not covered, honestly:
- **db-p2p's suite was not run.** Its four changed files are comment-only; the build compiled them.
- **`yarn test:integration` (real sockets) was not run.** The sereus report was measured on two real nodes; the fix is proven here on the mock mesh, which reproduced the same signature. Sereus should re-run its six-round harness before closing its blocked ticket.
- **The mixed-transactor fallback** (two tables on different transactor instances in one SQL transaction) has no test; no host declares that configuration. The `NOTE:` at `legacyBatch` says what it would take.
- **The session-mode side of the `stagedCollections` fix** has no direct test.
- **`committed-read-stall.spec.ts`'s "partial commit under a stall" case changed meaning.** With the coordinator's three-attempt forward recovery, a stall released into a single thrown commit failure now recovers and the write completes whole; the case asserts that instead. The degraded latch is still exercised, without a stall, in `committed-read-isolation.spec.ts` and `legacy-commit-atomicity.spec.ts` via a failure that holds across the retries (the new `selective-failure-transactor.ts` helper, which replaced two one-shot inline harnesses that the retry would have silently recovered).
- **GitHub issue 17's `legacy-multi-tree-tear.test.mjs`** only constructs `PartialCommitError` and checks `uniqueEnforcementTreeName`; it never drives a commit, so it stays green on either side of this change and is not a witness. The `two-node-unique-value-race` spec is the witness for that report's shape too (its trigger, a pend conflict on the index tree, now leaves nothing behind rather than being made rarer).

## Tripwires recorded

- `commitBatchLegacy` (`NOTE:`): the batch pends at the revision the handle currently holds; a stale tree costs one refused attempt plus the first backoff (about 50 to 100 ms) before the retry pends fresh, where the sweep's `updateAndSync` refreshed first. Refresh the batch's collections before committing if contended legacy commits ever show that latency.
- `legacyBatch` (`NOTE:`): the mixed-transactor fallback and what closing it would take.

## Consequences to carry (from the ticket)

- `backlog/debt-a-failed-refresh-can-leave-a-collection-half-restaged` is now reachable in default mode; its arm was appended by the fix stage.
- `backlog/debt-session-mode-bridge-coverage` got a note: Arm A's branch is exercised from the legacy side; the session-mode drive of it, and Arm B, remain open.
- The `commit:collections` trace line still prints `mode=legacy` for both the batch and the fallback sweep; the error class distinguishes them after the fact, and `docs/debugging.md` says how the set is pushed.
- A legacy multi-tree commit now carries the session-mode residual (a permanent commit-phase loss after every pend succeeded) rather than the sweep's wider window. Members configured `unvalidatablePendPolicy: 'reject'` refuse legacy batches as they refused legacy syncs: no change.

## For sereus

The unblock condition of `../sereus/tickets/blocked/concurrent-unique-value-race-commits-both-rows.md` (a same-instant unique-value loser refused with nothing stored) is met on the mock mesh: `packages/quereus-plugin-optimystic/test/two-node-unique-value-race.spec.ts`, 18 of 18 rounds. The loser now sees `UNIQUE constraint failed: Strand.StampId`-style messages with no `PartialCommitError`; a caller that classifies retries by catching `PartialCommitError` should also expect `CoordinatorPartialCommitError` for the (now narrower) commit-phase residual.
