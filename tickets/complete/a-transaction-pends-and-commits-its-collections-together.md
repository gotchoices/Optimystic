description: A transaction that writes several collections (a table and its indexes, or several tables) now sends all of them to the other machines in one reservation request and one commit request, so a one-row insert into a table with five indexes costs the other machine of a two-machine group three cluster requests instead of twenty-four.
prereq: a-coordinator-runs-an-actions-collections-as-one-record
architecture: docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block
files: packages/db-core/src/transactor/transactor.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/network/transaction-size.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/src/storage/action-change-hold.ts, packages/db-p2p/test/floored-read-consults-a-lagging-coordinator.spec.ts, packages/db-p2p/test/superseded-own-write-is-saved.spec.ts, packages/quereus-plugin-optimystic/test/two-node-write-request-count.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-wake-consistency.spec.ts, docs/internals.md, docs/correctness.md, docs/transactions.md, packages/db-p2p/docs/cluster.md
----
# A transaction pends and commits its collections together

Third of three tickets for GitHub #42. The first two let a coordinator run one action's pends, or commits, of several collections as ONE consensus record (`IRepo.pendMany` / `IRepo.commitMany`). This one makes the writer use them.

## What changed

**`ITransactor`** gained two optional methods, `pendMany?` and `commitMany?`. Both answer `undefined` for "these could not go as one; send them your usual way". That is never a verdict, and nothing of the batch is left pended when `pendMany` answers it.

**`NetworkTransactor`**
- `pendMany`: union of every request's blocks. It answers `undefined` before sending anything when the cover `pend` computes (now factored out as `coordinatorCover`) needs more than one coordinator, a lookup throws, the coordinator's repo has no `pendMany`, or the batch together is over `MAX_TRANSACTION_BYTES` (new `transactionBytes` helper in `transaction-size.ts`). Otherwise it discharges owed cancels and sends one `repo.pendMany`, with `coordinatingBlockIds` set to the union.
  - Success: it seeds the per-transaction coordinator cache for every block and records the hint (a shared `recordCoordinatorHints` helper, also used by `pend`).
  - Refusal: it cancels the union (awaited and logged, never replacing the verdict) and returns `refusalFrom([answer])`.
  - Throw: it cancels the union and answers `undefined`.
- `commitMany`: each request's blocks go tail first (`tailFirst`). One coordinator comes from `soleCommitCoordinator`, which prefers the cache `pendMany` seeded. Requests are built by the new module-level `repoCommitRequest`, which `sendCommit` now uses too, so every commit request is built in one place. Success → `mergeDurability([answer.durability])`. Refusal → `refusalFrom`. Throw → `undefined`.

**`TransactionCoordinator`**
- The request builders are split out. `pendRequestFor` builds a pend request, and `pendCollection` now just sends one. `commitRequestFor` returns a `CommitRequest`, or a string saying why there is none. `commitCollection` sends with its 3 transient retries.
- Shared classifiers: `pendRefusalError`, `pendFailure` (the old inline loop in `pendPhase`) and `collectionCommitOutcome` (the old inline mapping in `commitCollection`, with its `NOTE:` moved along).
- `pendPhase`: with two or more collections and `pendMany` present, it calls `pendTogether`. Every request is marked `soleReservation: true`.
  - Success: every collection is pended with its own blocks.
  - Refusal: classified once.
  - Throw: a hard failure, and every collection's blocks are cancelled through `cancelPhase`.
  - `undefined`: the old fan-out, with requests rebuilt unmarked (`sole` is false for two or more).
  - A collection missing from the registry also answers `undefined`, so the per-collection path reports it as before.
- `commitPhase`: with two or more collections and `commitMany` present, it calls `commitTogether`. Each collection gets the batch's one answer, stamped with its own blocks and revision. On `undefined`, a throw (logged), or a request that cannot be built, it falls back to `commitEach` (the old fan-out). The aggregation is unchanged except for two things: errors are de-duplicated (a batched refusal gives every collection the same reason), and a rejected `commitCollection` promise now counts as a failed collection instead of being left out of both sets.
- A `NOTE:` in `commitPhase` names the residual: a batched pend followed by a per-collection commit.

**`soleReservation` doc** (`struct.ts`), plus `docs/internals.md` (the two sections the ticket named, the size-limit bullet and the change-hold bullet), `docs/correctness.md` (§2 pend-verdict paragraph, Theorem 3's eventual-visibility bullet and Phase 2, §7.3), `docs/transactions.md` (session-mode atomicity callout), `packages/db-p2p/docs/cluster.md` (deferral paragraph) and the `action-change-hold.ts` header comment are all updated. They state that batching groups the collections within a phase, and that the pend and the commit stay two separate consensus rounds.

## Tests

- `two-node-write-request-count.spec.ts` re-pinned. The session-mode indexed case now expects **3** and is renamed to say the collections travel together. Added `legacy mode: an insert into a table with five indexes costs three` (#42 measured 24 for this shape). The two no-index cases still expect 3; the helper now takes an index count, so the table's one non-key column is `c0` instead of `g`.
- `two-node-index-wake-consistency.spec.ts` (GitHub #47) had to change, and this needs a reviewer's eye. Its lag hook held every cluster delivery to node 1 that carried the index's commit. A batched record carries the table's commit too, so the hook held both: the wake never ran, the 10 s fallback outlived the 5 s transaction, and the control case failed with `TransactionExpiredError`. The hook now wraps node 1's `storageRepo.commit` and holds the commit whose `tailId` is the index's tail. A batch is applied one `StorageRepo.commit` per collection, table first, so the gap still exists and the control still observes it. Both cases pass.
- No new tests. The fallbacks are the paths every existing multi-collection spec runs (`TestTransactor` has neither method).
- `network-transactor.spec.ts`: `makeTransactor`'s `getRepo` used to return an `ITransactor` as an `IRepo`, which only type-checked structurally. The new optional methods have different signatures, so it now returns an explicit four-method repo view.

## Validation run

- `yarn workspace @optimystic/db-core test`: 1908 passing.
- `yarn workspace @optimystic/db-p2p test`: 3537 passing, 74 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` (after `yarn build`): 1064 passing, 14 pending; smoke ok.
- `yarn typecheck`, `yarn lint:docs` and eslint on the changed files are clean. db-core was rebuilt after the last comment edit.
- Not run: `yarn test:integration` and `yarn check:rn`.

## Deviations from the ticket and known gaps

- **Order in `pendMany`**: the ticket says to discharge owed cancels first and then check the cover. I check the cover (and the size) first, so the answer `undefined` has no side effects; the owed-cancel discharge runs right before sending.
- **Owed cancel after a thrown `pendMany`**: the ticket says an undischarged cancel "goes out ahead of" the fallback pends. In fact `OwedCancels.beforePend` *supersedes* an owed cancel of the same action on the blocks a new pend names, because the fallback pends rewrite those records. That is correct behaviour, and the doc comment says what actually happens.
- **Size**: not in the ticket. A batch whose sum is over `MAX_TRANSACTION_BYTES` answers `undefined`, so collections that each fit still commit, one request each. The alternative was to throw `TransactionTooLargeError` for a transaction the per-collection path would accept.
- **Residual cases**: besides a thrown `commitMany`, a commit can also reach the per-collection path after a batched pend if `txnCoordinatorCache` evicted the action's entry (TTL at least 60 s, cap 1000 entries) and a live lookup splits the blocks. It is noted in the `commitPhase` `NOTE:` and in correctness.md. It cannot happen on a group no larger than a cohort.
- **Test wrappers**: `DelegatingTransactor` forwards both methods through getters, as it does `queryClusterNominees`. The two db-p2p wrappers that only re-route reads also forward them (`readingThroughCoordinator`, `readingFrom`). Wrappers that intercept or record `pend`/`commit` deliberately do **not** forward them, since forwarding would let a multi-collection write bypass the interception: `interceptFirstCommit`, `landOnlyTheTailOnce`, the diary tear wrapper, and `recording` in `node-count-mesh.ts`. All of these are used for single-collection writes today.
- **Two-coordinator path**: unverified by test, as the ticket expected (backlog `debt-no-mesh-fixture-forces-two-coordinator-batches`). Checked by reading the code only.
- **Existing mixed-build `NOTE:`**: the `NOTE:` at `RepoClient.pendMany` (from the prereq) about a coordinator on an older build was left as is. The maintainer decision says not to *add* one; whether to remove that one is the reviewer's call.
- **Order of a batch's operations**: it follows the coordinator's collection-map order, which for legacy commits is the order the trees were marked dirty, and for SQL inserts that puts the table first (the #47 control relies on it). If the index came first there would be no visible gap, and the change hold would have nothing to do. Correctness doesn't depend on the order; only that spec's control does.

## Use cases for review

- A one-row insert into a table with N indexes on a two-member group costs the other member 3 cluster requests in legacy and in session mode.
- One collection: unchanged (`pend` with the mark, then `commit`'s one round).
- A transactor without the methods (`TestTransactor`, the reference peer): today's fan-out exactly.
- A batched pend refused by a rival: one retryable conflict, nothing left pended, and the retry loop re-drives.
- A batched commit refused: every collection is retained by `commitOnceLatched`, and the refresh between attempts finishes any whose log entry landed.

## Review findings

Reviewed the diff of `ticket(implement): a-transaction-pends-and-commits-its-collections-together` before the handoff, then the touched docs and the db-p2p `RepoClient` batch methods from the prereq.

**Checked and found sound**
- `NetworkTransactor.pendMany`: answers `undefined` before any side effect (size, cover, batch-capable repo); owed cancels discharged only once it will send; refusal and throw both cancel the union, awaited and never replacing the verdict; success seeds the per-transaction coordinator cache for every block, so `commitMany`'s `soleCommitCoordinator` reaches the same peer. The cover-first ordering (a deviation from the ticket) is the better choice and is documented.
- `NetworkTransactor.commitMany`: tail-first per request, digests narrowed per request through the shared `repoCommitRequest`, throw → `undefined` with the same own-revision reasoning as `commitInOneRound`.
- `TransactionCoordinator`: the fallback after an `undefined` batched pend rebuilds the requests without `soleReservation`; a thrown `pendMany` from a non-network transactor is a hard failure with a cancel of every collection; commit aggregation de-duplicates the batch's single reason and now counts a rejected `commitCollection` as a failed collection (previously it was in neither set).
- Refactors (`pendRequestFor`, `commitRequestFor`, `pendRefusalError`, `pendFailure`, `collectionCommitOutcome`) are behaviour-preserving extractions; the moved `NOTE:` keeps its revisit condition.
- Test wrappers: the ones that forward both methods only re-route reads; the interceptors deliberately forward neither. The `two-node-index-wake-consistency` hook change (gate at `StorageRepo.commit` on the index tail instead of on cluster delivery) keeps the control meaningful: the hold-disabled case still observes the gap.
- Batched refusal paths are exercised end to end by the existing two-node race specs (`two-node-unique-value-race`, `two-node-index-mutation-sweep`), which now go through the batch.
- Docs (`internals.md`, `correctness.md`, `transactions.md`, `cluster.md`, `action-change-hold.ts` header) state that batching groups collections within a phase and keeps pend and commit as two consensus records, as the maintainer asked. `ClusterMember.validateCommitAgainstRefusedPend`, cited in correctness.md, exists.

**Found and fixed in this pass (minor)**
- The coordinator batched the pend whenever the transactor offered `pendMany`, even without `commitMany`. The batched pend's `soleReservation` mark promises the commit goes as one request, so a transactor (or wrapper) offering only `pendMany` would have let a held-back pend decision meet per-collection commits — the tear the mark exists to prevent. `pendPhase` now requires both methods; the `ITransactor.pendMany` doc and `docs/internals.md` say so.
- Removed the mixed-build `NOTE:` at `RepoClient.pendMany` (and the "two NOTEs" reference on `commitMany`): the maintainer decision on this ticket says mixed-version groups get no handling and no `NOTE:`.

**Tripwires / existing tickets**
- The residual where a commit after a batched pend goes per collection (thrown `commitMany`, or the coordinator cache evicting the action's entry) is already a `NOTE:` in `TransactionCoordinator.commitPhase` and in correctness.md; left as is.
- `coordinator.ts` is 2102 lines (`wc -l`); appended a re-measure to the existing backlog `debt-collection-write-retry-logic-outgrew-its-file`, which already names this file, rather than filing a new ticket.
- The two-coordinator batched path stays unverified by test; already backlog `debt-no-mesh-fixture-forces-two-coordinator-batches`.

**Tests**
- No tests added or cut. The new request-count case pins the #42 number (a measured contract); the re-pinned indexed case replaces the old four-per-collection expectation. The `pendMany`-without-`commitMany` fix has no test: no transactor in the tree offers one without the other, so it is a guard on a contract stated in the type's doc, not a reachable defect.

**Validation**: db-core and db-p2p rebuilt after the edits. `yarn workspace @optimystic/db-core test` 1908 passing; `yarn workspace @optimystic/db-p2p test` 3537 passing, 74 pending; `yarn workspace @optimystic/quereus-plugin-optimystic test` 1064 passing, 14 pending, smoke ok; `yarn typecheck`, `yarn lint:docs` and eslint on the changed files clean. Not run: `yarn test:integration`, `yarn check:rn` (no change to the integration or React Native surfaces beyond what implement already shipped).
