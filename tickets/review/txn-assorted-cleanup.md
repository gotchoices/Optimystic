description: Five small transaction-layer cleanups were made — dedup a peer set, stop reaching into a collection's private fields, replace untyped escape-hatch casts, delete a dead code path, and stop a crash when a storage backend returns a partial result — and now need a review pass.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/src/network/i-repo.ts
  - packages/db-core/src/network/i-key-network.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/src/libp2p-key-network.ts
  - packages/db-core/test/transactor-source.spec.ts
  - packages/db-core/src/transaction/index.ts
difficulty: medium
----

# Review: assorted transaction-layer cleanup + one crash fix

Five items from the implement ticket landed. Four are low-severity tidy-ups;
item 5 was a reachable crash. Build (`tsc`) passes for both `db-core` and
`db-p2p`; the focused db-core suites (transaction, transactor-source,
collection, network-transactor) all pass — 130 tests. Details and honest gaps
below.

## What changed, and how to validate each

### 1. GATHER nominees deduped by peer identity
`coordinator.ts` `gatherPhase` now merges cluster nominees into a
`Map<string, PeerId>` keyed by `peerId.toString()` and returns
`new Set(map.values())`, instead of a reference-keyed `Set<PeerId>`. Reason:
each `queryClusterNominees` builds a fresh `PeerId` object per call
(`peerIdFromString`), so a `Set` keyed by object reference kept the same
physical peer twice when it nominated for two critical clusters. Return type is
unchanged (`ReadonlySet<PeerId> | null`); the single consumer only does
`Array.from(...)`.

- **Validation floor:** existing multi-collection tests ("should propagate
  supercluster nominees to pend requests", "should query cluster nominees…")
  pass.
- **GAP (worth a reviewer test):** no test asserts the *dedup* itself — i.e. the
  same physical peer nominated by two different critical clusters ending up
  **once** in the supercluster. The existing tests don't force two clusters to
  share a nominee via distinct `PeerId` instances. A focused test that stubs
  `queryClusterNominees` to return the same peer-id string (as two separate
  `peerIdFromString` objects) across two blocks and asserts the pend request's
  `superclusterNominees` has length 1 would nail the regression this fix targets.

### 2. Revision handling moved onto `Collection`
Added two public methods to `Collection` (`collection.ts`):
- `getNextRev(): number` — `(source.actionContext?.rev ?? 0) + 1`.
- `recordCommitted(actionId: ActionId): number` — appends the committed
  `ActionRev` and bumps `rev`, mirroring the inline bump in `syncInternal`.

The coordinator's five bracket-access sites into the private `source` field
(`collection['source'].actionContext…`) now route through these: three read-only
sites use `getNextRev()`; the `commit()` and `execute()` read-write blocks use
`recordCommitted(transaction.id)`. No behavior change intended — same arithmetic,
same append shape.

- **Validation floor:** "should update actionContext after coordinator.execute()",
  "should update actionContext.rev after successful session.commit()", and the
  sequential-execute tests pass — these exercise the rev bump end-to-end.
- **GAP:** no *direct* unit test on `getNextRev`/`recordCommitted` in isolation;
  they're covered only through the coordinator. Low risk (trivial methods), but a
  reviewer may want a one-liner asserting `recordCommitted` advances rev and
  appends the entry.
- **Cross-ticket note:** the original brief flagged sibling tickets tx-4/tx-7 as
  also touching this commit/execute seam. If their work merges and conflicts
  here, prefer these method-based accessors over re-introducing the inline poke.

### 3. Escape-hatch casts given typed homes
- `MessageOptions` (`i-repo.ts`) gained `coordinatingBlockIds?: BlockId[]`. The
  `as any` on the pend options object (`network-transactor.ts`) and the
  `(options as any)?.coordinatingBlockIds` read (`coordinator-repo.ts`) are both
  gone; the field now rides the typed member (fallback `?? allBlockIds` kept).
- `IKeyNetwork` (`i-key-network.ts`) gained an optional
  `recordCoordinator?(key, peerId, ttlMs?): void`. The `pn: any` feature-detect
  alias in `network-transactor.ts` is replaced by
  `this.keyNetwork.recordCoordinator?.(…)`. `Libp2pKeyPeerNetwork`'s concrete
  `recordCoordinator(key, peerId, ttlMs = 30*60*1000)` structurally satisfies the
  optional member — **confirmed by the db-p2p `tsc` build passing**.

- **Validation floor:** type-only; guaranteed by both package builds. No new
  runtime test — the `coordinatingBlockIds` threading and `recordCoordinator`
  hint live on the libp2p/cluster network path, which the unit suites don't
  drive. This matches the pre-change coverage (the casts were never runtime-tested
  either), so the fix doesn't *lower* coverage, but a reviewer wanting belt-and-
  suspenders could add a coordinator-repo test asserting `coordinatingBlockIds`
  from options is used as the cluster anchor.

### 4. Dead `TransactionContext` / `commitTransaction` path deleted
Removed `packages/db-core/src/transaction/context.ts` (whole file),
`TransactionCoordinator.commitTransaction`, its import, the
`transaction/index.ts` re-export, and the now-unused imports
(`ActionsEngine`, `createActionsStatements`, `createTransactionStamp`,
`createTransactionId`). Confirmed no `new TransactionContext(...)` anywhere and no
external importer of the export (grepped db-core + db-p2p + quereus). The
same-named `commitTransaction` in `quereus-plugin-optimystic` (TransactionBridge)
and `db-p2p` (cluster-coordinator) are **unrelated** and untouched. Updated the
two stale comment lines in `transaction.spec.ts` that referenced the deleted
path.

- **Validation floor:** full db-core `tsc` build is clean (compiles every
  `src/`), and the transaction suite passes with the path gone.

### 5. Sparse-result crash in `TransactorSource.tryGet` (the real bug)
`tryGet` asserted `result[id]!` and destructured it. A transactor that returns a
**sparse** results object omitting `id` (block genuinely not found) made `result`
truthy but `result[id]` `undefined`, so destructuring threw
`TypeError: Cannot destructure property 'block' of undefined`. Now it reads
`const entry = result?.[id]; if (entry) { … }` and falls through to `undefined`
on a miss. Read-dependency recording and the `state.pendings` TODO are preserved.

- **Validation:** **new test added** — `transactor-source.spec.ts` "should return
  undefined (not throw) from tryGet when the transactor returns a SPARSE result
  missing the requested id" uses a stub transactor whose `get` returns `{}`, and
  asserts `tryGet` resolves `undefined` and records no read dependency. Fails
  (throws) against the old code; passes now.
- Note the pre-existing sibling test "…when result entry has no block" covers a
  *different* case (key present, `block: undefined`) — both are green.

## Suggested reviewer focus (highest value first)
1. **Item 1 dedup has no direct regression test** — the one behavioral gap most
   worth closing (see the test sketch above).
2. Confirm item 2's `recordCommitted` append shape exactly matches the
   `syncInternal` inline bump it mirrors (it does today — check they don't drift).
3. Sanity-check that dropping `as any` in item 3 didn't silently widen/narrow any
   inferred type at the call sites (build says no).

## How to run
```
cd packages/db-core && yarn build        # tsc, clean
cd packages/db-p2p && yarn build          # tsc, clean
cd packages/db-core && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/transaction.spec.ts" "test/transactor-source.spec.ts" \
  "test/collection.spec.ts" "test/network-transactor.spec.ts" --colors --reporter spec
```
Only these four db-core specs were run (the areas touched); the full db-core
suite (cohort-topic, reactivity, matchmaking, etc.) was **not** run — those
subsystems are outside this diff, and the whole-package `tsc` build already
type-checks every `src/` file. No `.pre-existing-error.md` was needed; nothing
failed.
