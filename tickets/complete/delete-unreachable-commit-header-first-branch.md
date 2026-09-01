description: Removed dead code that would have committed a new collection's header block before everything else — it could never actually run — and brought every comment, doc, and test that still described it as live in line with what the code does.
files:
  - packages/db-core/src/transactor/network-transactor.ts (`commit` — header-first branch deleted; two further stale comments fixed in review)
  - packages/db-core/src/transactor/transactor-source.ts (`transact` — `headerId` and `tailId` jsdoc)
  - packages/db-core/src/network/struct.ts (`CommitRequest.headerId`/`tailId` doc comments)
  - packages/db-core/src/testing/test-transactor.ts (`CommitLandsButReportsStale` docstring — fixed in review)
  - packages/db-core/test/commit-digest-threading.spec.ts (both request shapes made production-realistic; routing tripwire NOTE added in review)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (two stale comments; filter logic unchanged)
  - docs/internals.md (header-first parenthetical dropped)
----

# What landed

`NetworkTransactor.commit` had a branch that committed a new collection's header block ahead of
everything else, guarded by `request.headerId && !request.blockIds.includes(request.headerId)`.
That guard is always false in production, so the branch was dead code exercised only by two
hand-built test requests. It is now deleted, and the commit order is plainly tail-then-sweep: the
log tail commits first on its own, every other touched block (the header included) is swept
afterwards.

The tail-then-sweep half of that order is load-bearing and unchanged — `Collection.bootstrapContext`
relies on the tail being readable with `context=undefined`, and sweeping first could leave a
committed header pointing at a never-committed tail.

`CommitRequest.headerId` survives as what it actually is: collection-identifying metadata, set only
on the commit that creates a collection, read by db-p2p's dispute reporting
(`dispute-service.ts:534`) as the first entry in a three-way fallback for naming the collection.
`TransactorSource.transact` still forwards it under the same `isNew` condition; no forwarding logic
changed.

# Review findings

## Verified: is the deleted branch really unreachable?

Re-derived independently rather than trusting the implement ticket's instrumentation, by
enumerating every production caller of `NetworkTransactor.commit`:

- **`TransactorSource.transact`** — sets `headerId` only when `transform.inserts` has the header
  (`isNew`), and passes `blockIds: pendResult.blockIds`. `NetworkTransactor.pend` returns
  `blockIds: blockIdsForTransforms(blockAction.transforms)` (`network-transactor.ts:652`), and
  `blockIdsForTransforms` (`transform/helpers.ts:41`) unions insert / update / delete ids. So an
  inserted header id is in `blockIds` by construction whenever `headerId` is forwarded — the guard
  cannot be true.
- **`TransactionCoordinator.commitCollection`** (`transaction/coordinator.ts:1195`) — the
  multi-collection path. It builds its `CommitRequest` without a `headerId` at all, so the branch
  could never fire there either. (It also means the dispute-service fallback chain, not
  `commit.headerId`, is what names a collection on that path — unchanged by this work.)

No other production site constructs a `CommitRequest` for `NetworkTransactor`. The claim holds.

## Fixed inline (minor)

Five sites the implement pass left describing the old order, or left in a shape production never
builds. All fixed in this review; no behavior change in any of them.

- **`network-transactor.ts`, torn-action comment** — read "The tail (and header) already committed
  durably when this returns". No longer true as stated: the header now rides in the sweep, which is
  the very call that just errored, so it may or may not have landed. Reworded to the tail, plus any
  sweep batch that landed before the error.
- **`network-transactor.ts`, `staleFromBatches` docstring** — said it is shared by `commitBlock`
  "(tail/header)". `commitBlock` now has exactly one call site, the tail. Corrected.
- **`test-transactor.ts`, `CommitLandsButReportsStale` docstring** — claimed "the collection header
  and log tail are committed BEFORE the sweep". A file the implement pass should have touched and
  did not; it is the shared fixture behind both own-entry replay suites, so a wrong ordering claim
  there misleads at two call sites. Corrected to the tail alone.
- **`transactor-source.ts`, `tailId` jsdoc** — said the tail's transform "is performed next", a
  leftover from when the header went first. Now says committed FIRST.
- **`commit-digest-threading.spec.ts`, first test** — the implement pass reshaped the *second*
  digest test to a realistic request but left the first one passing `headerId: ids.header` with the
  header held OUT of `blockIds`. Post-deletion that header simply never commits, so the test was
  declaring a digest for a block it no longer exercised, in exactly the impossible shape this
  ticket set out to remove. Header added to `blockIds`; the per-peer subsetting assertions the test
  exists for are unaffected (b1 still routes to peer-B, b2 to peer-C).
- **`docs/internals.md`** — rewrapped the short orphan line left by the deleted parenthetical.

## Tripwires recorded (not filed as tickets)

- **The digest-threading tests are coupled to their fixture's routing table.** Both single-block-batch
  assertions only hold while the header/tail prefer peer-A and the other swept block (b2) prefers
  peer-C; re-pointing b2 at peer-A would merge them into one batch and the tests would still pass
  while silently no longer proving anything. The implement handoff flagged this but parked it
  nowhere a future reader would meet it. Now a `NOTE:` on `setup()`'s docstring in
  `commit-digest-threading.spec.ts`, at the routing block itself.

## Checked and clean (no action)

- **`dispute-service.ts:534`** — `commit.headerId ?? coordinatingBlockIds?.[0] ?? blockIds[0]!`
  still reads correctly. `headerId` is populated by exactly the same rule as before; only its
  ordering effect (which it never had) is gone.
- **`concurrent-diary-append-acknowledgement.spec.ts`'s `kept` filter** and
  **`collection.spec.ts`'s `PartialCommitTransactor`** — both filter `blockIds` by
  `id === tailId || id === headerId`. Neither depended on the deleted branch (both only ever keep
  ids already present in `blockIds`), so both are correct as they stand.
- **`transactor-source.spec.ts:162`** — commits with both `headerId` and `tailId` outside
  `blockIds`. Synthetic shape, unaffected by the deletion (the tail commits regardless), still
  passing. Left alone rather than churned.
- **No stale prose left elsewhere.** Grepped `packages/` and `docs/` for header-first / "commits the
  header" / "header and tail" phrasings; every remaining hit is either about a different subject
  (read order in `docs/transactions.md`, block-header fields) or now accurate.
- **Diff is behavior-only-by-deletion.** Skimmed the implement diff for stray logic changes riding
  along with the comment rewrites: none. `commitBlock` is now single-call-site with a `tailId?`
  parameter that is always its own `blockId`; slight over-generality, but it is a clear named
  abstraction carrying real conflict-vs-transient error splitting, so collapsing it would be churn
  for no gain.

## Not found

No correctness, resource-cleanup, type-safety, or error-handling defects. That is expected for the
shape of this change — it deletes an unreachable branch and edits comments; it adds no state, no
allocation, no new failure path. The one place a defect *could* have hidden was the reachability
claim itself, and that is verified above from both callers.

# Validation

- `yarn lint` (repo root): clean.
- `packages/db-core`: `yarn build` clean, `yarn test` → **1546 passing** (before and after the
  review's edits).
- `packages/db-p2p`: `yarn build` clean, `yarn test` → **2489 passing, 49 pending**. The 49 pending
  are pre-existing `it.skip`s tagged against their own parking tickets, unrelated to this change.
- No new tests: this is a deletion plus comment/doc accuracy. Test coverage of the surviving
  behavior (tail-first, then per-peer sweep batching, with digests subset per batch) is unchanged
  and now runs against request shapes production actually produces, which it did not before.
