description: Five small transaction-layer cleanups (dedup a peer set, stop reaching into a collection's private fields, replace untyped escape-hatch casts, delete a dead code path, and stop a crash on a partial storage result) were implemented and have now passed an adversarial review.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/src/network/i-repo.ts
  - packages/db-core/src/network/i-key-network.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-core/test/transaction.spec.ts
  - packages/db-core/test/transactor-source.spec.ts
  - packages/db-core/src/transaction/index.ts
----

# Complete: assorted transaction-layer cleanup + one crash fix

Five items landed in implement; this review verified all five against a fresh
read of the diff, closed the one behavioral test gap the implementer flagged,
and re-ran build + lint + the affected suites. No major findings; no new
tickets spawned.

## What shipped (unchanged from implement)
1. GATHER nominees deduped by peer identity (`toString()`-keyed `Map` instead of
   reference-keyed `Set`) in `coordinator.gatherPhase`.
2. Revision handling moved off private-field pokes onto two public `Collection`
   methods — `getNextRev()` and `recordCommitted(actionId)` — and the five
   `collection['source'].actionContext…` bracket sites in the coordinator now
   route through them.
3. Escape-hatch `as any` casts given typed homes: `MessageOptions.coordinatingBlockIds?`
   (`i-repo.ts`) and optional `IKeyNetwork.recordCoordinator?()` (`i-key-network.ts`).
4. Dead `TransactionContext` / `TransactionCoordinator.commitTransaction` path
   deleted (whole `context.ts` file, the method, its imports, the `index.ts`
   re-export).
5. Sparse-result crash fixed in `TransactorSource.tryGet`: a transactor returning
   a result object that omits the requested id no longer throws
   `TypeError: Cannot destructure property 'block' of undefined`; it falls through
   to `undefined`.

## Review findings

**Checked:** the full implement diff (all 8 src files + 2 test files) read fresh
before the handoff summary; correctness / DRY / type-safety / error-handling /
resource-cleanup angles on each item; every `IKeyNetwork` implementation in the
repo (to confirm item 3's now-optional method breaks none); every surviving
reference to the deleted `TransactionContext` path (source, tests, docs); build
(`tsc`) for db-core and db-p2p; eslint on all touched files; the four affected
db-core suites.

**Found + fixed in this pass (minor):**
- *Item 1 had no direct regression test* — the implementer's own top-listed gap.
  The existing supercluster tests never forced two clusters to nominate the same
  physical peer via distinct `PeerId` objects, so nothing actually pinned the
  dedup. Added `should dedup a peer nominated by two clusters into a single
  supercluster entry` to `transaction.spec.ts`: two critical clusters each return
  a *fresh* `peerIdFromString(sameId)` object, and the test asserts every pend
  request's `superclusterNominees` deep-equals a single-element list. This fails
  against a reference-keyed `Set` (would carry the peer twice) and passes now.
  Suite went 130 → 131.

**Verified, no change needed:**
- *Item 2 append shape matches its origin.* `recordCommitted` produces
  `{ committed: [...prev, {actionId, rev}], rev }`; the `syncInternal` inline bump
  (`collection.ts:352-354`) produces the identical shape in both the
  has-context and no-context branches. No drift.
- *Item 3 casts genuinely removed, nothing widened.* All `IKeyNetwork`
  implementations (`SingleNodeKeyNetwork`, `MockKeyNetwork`, `MockMeshKeyNetwork`,
  `NetworkSimulation`) simply omit the now-optional `recordCoordinator`, which is
  legal; `Libp2pKeyPeerNetwork.recordCoordinator(key, peerId, ttlMs = …)`
  structurally satisfies the optional member. Both package builds type-check.
- *Item 4 fully excised.* `context.ts` is gone; no `TransactionContext` /
  `new TransactionContext` remains in any `src`. The only surviving mentions are a
  comment in `transaction.spec.ts`, a generated `docs/review.html` dashboard, and
  a *separate* fix-stage ticket
  (`txn-session-execute-double-applies-actions`) whose `files:` list still names
  the deleted `context.ts` — that ticket is not part of this diff and is out of
  scope to edit here; its own body already notes tx-13 deletes the path. The
  same-named `commitTransaction` in `quereus-plugin-optimystic` and db-p2p's
  cluster-coordinator are unrelated and untouched.
- *Item 5 covered by a new test the implementer added* (`transactor-source.spec.ts`,
  sparse-result case) plus the pre-existing `block: undefined` sibling; both green.
  Re-read the guard: `entry` is only truthy when the key is present, so a genuine
  miss records no read dependency — the test asserts exactly that.

**Major findings:** none.

**Speculative / tripwires:** none worth parking. One pre-existing edge was noted
and deliberately *not* touched: `CoordinatorRepo.pend`'s
`coordinatingBlockIds[0]!` would index `undefined` if a caller passed an *empty*
(non-nullish) `coordinatingBlockIds` array, since `?? allBlockIds` only guards the
absent case. This behavior is unchanged by item 3 (the old `(options as any)?.…`
had it too), and the sole real caller (`NetworkTransactor.pend`) always passes a
populated list, so it is not reachable today — recorded here only, not filed.

## Validation run
- `packages/db-core`: `yarn build` (tsc) — clean.
- `packages/db-p2p`: `yarn build` (tsc) — clean.
- `npx eslint` on all 10 touched files — clean (exit 0).
- `transaction.spec.ts` + `transactor-source.spec.ts` + `collection.spec.ts` +
  `network-transactor.spec.ts` — **131 passing**.

The whole-package db-core suite (cohort-topic, reactivity, matchmaking, etc.) was
not run — those subsystems are outside this diff and the package `tsc` build
already type-checks every `src/` file. No `.pre-existing-error.md` needed; nothing
failed.
