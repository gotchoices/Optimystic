description: Reading a block "as of" a point in time now crashes whenever that block wasn't the one changed at that moment — a very common case — because the code that tracks "which versions I can rebuild" was made too literal and no longer accounts for the fact that an unchanged block's older version still answers a newer point-in-time read.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/src/storage/helpers.ts
difficulty: medium
----

# `meta.ranges` point-per-revision coverage breaks descending-walk historical reads

## Summary

The fix in `st-pend-seeds-open-ended-ranges` correctly stopped `savePendingTransaction` from
seeding an open-ended `ranges: [[0]]` (which falsely claimed coverage of every revision). But it
**over-corrected**: it made every committed revision claim only its own single-point closed range
`[rev, rev+1)`, so a block's coverage becomes a set of disjoint points
(`[[1,2],[3,4]]`, …). That model contradicts how `materializeBlock` actually serves a revision,
and it introduced a reachable crash on a normal read path.

## Background: revisions are sparse in the global rev space

`rev` on a block is the **collection-level (global) revision** at which the block was modified.
`internalCommit` (`storage-repo.ts:526`) writes a revision record for a block **only** at the
commit's global rev, so a block is modified at a sparse subset of global revs (e.g. block B at revs
1 and 5, never at 2/3/4).

`getBlock(rev)` is contractually "the block's state **as of** global rev N" = the highest committed
revision **≤ N**. The reference in-memory transactor implements exactly this:
`packages/db-core/src/testing/test-transactor.ts:91` → `latestMaterializedAt(blockState, context.rev)`.
`materializeBlock` (`block-storage.ts:274`) realises it with a **descending walk**:
`listRevisions(targetRev, 1)` finds the highest committed rev ≤ target and materialises it.

So a node that holds the materialization chain from a block's earliest committed rev can reconstruct
**every** rev from that earliest through its latest — not just the exact points at which it was
modified. Reconstructible coverage is a **contiguous span**, not a set of points.

## The bug

`ensureRevision` (`block-storage.ts:243`) gates the descending-walk serve on `inRanges(targetRev,
meta.ranges)`. With point-per-revision ranges, `inRanges` is **false** for any global rev between /
above a block's modified revs. `ensureRevision` then treats the rev as absent and calls
`restoreBlock`. With no `restoreCallback` wired (production has none — see
`st-recoverblock-no-production-caller`), it throws:

```
Error: Block <id> revision <n> not found during restore attempt.
```

Previously (open-ended seed), `inRanges` was true, `ensureRevision` fell through, and
`materializeBlock`'s descending walk served the correct prior state.

### Reachable through the public API — not just a unit-level artifact

`TransactorSource.tryGet` (`packages/db-core/src/transactor/transactor-source.ts:29`) passes
`context = this.actionContext` on **every** read, whose `.rev` is the collection's log tip.
`StorageRepo.get` (`storage-repo.ts:176`) forwards that to `getBlock(context.rev)`. So reading **any
block that was not the one modified by the latest commit** — extremely common in a multi-block
collection (b-tree siblings, header blocks, etc.) — now requests a global rev above that block's
last-modified rev and **throws** instead of serving its prior state.

The existing suite does not catch it because most in-test reads are served from the `CacheSource`
in front of the transactor (blocks read shortly after being written into the same tracker), so the
`transactor.get(context.rev)` path with a stale-for-this-block rev is rarely exercised. It fires on
cache misses and cross-node reads.

## Reproduction (both confirmed against HEAD `2dd6806`)

Unit level — throws:

```ts
// block modified at global revs 1 and 3 (sparse); read rev 2 (unmodified)
await repo.commit({ actionId: 'a1', blockIds: [blk], tailId: blk, rev: 1 });
await repo.commit({ actionId: 'a3', blockIds: [blk], tailId: blk, rev: 3 });
await new BlockStorage(blk, raw).getBlock(2);
// => Error: Block blk revision 2 not found during restore attempt.
```

Public `get()` — throws (block B unchanged at collection tip rev 2):

```ts
await repo.commit({ actionId: 'a1', blockIds: [A, B], tailId: A, rev: 1 }); // insert A,B
await repo.commit({ actionId: 'a2', blockIds: [A],    tailId: A, rev: 2 }); // modify only A
await repo.get({ blockIds: [B], context: { committed: [], rev: 2 } });
// => Error: Block B revision 2 not found during restore attempt.
```

Simulating the old open-ended seed on the same state serves `getBlock(2)` → rev-1 materialization
(`actionRev {rev:1}`), confirming this is a **regression** introduced by the point-range model, not
pre-existing.

## Expected behaviour

`meta.ranges` should state the **contiguous span(s)** a node can reconstruct, honouring the
descending-walk semantics: once a node holds a block's materialization chain from its earliest
committed rev `E` up through its latest `L`, coverage is `[E, L+1)` — every rev in that span is
serveable locally, so `inRanges` must be true across it. A **genuine** gap (a rev **below** any
reachable materialization — e.g. a truncated / peer-restored later span with nothing at/under the
target) is the only case that should miss `inRanges` and trigger restore. `materializeBlock`'s own
"Failed to find materialized block" throw already marks that true-gap case.

## Candidate fix (validate during implement)

On commit, extend coverage from the prior latest through the new rev rather than claiming an
isolated point. In `setLatest`, capture the prior `meta.latest?.rev` **before** overwriting and
claim `[prevRev, latest.rev + 1)` (falling back to `[latest.rev, latest.rev + 1)` on the first
commit). `mergeRanges` then folds it into the existing span (new range starts at `prevRev`, which is
`≤` the existing range's exclusive end `prevRev+1`, so they join) yielding one growing `[E, L+1)`.
This bridges only revs the node can actually serve (nothing modified this block between `prevRev`
and `latest`, so descending-walk from any intermediate rev resolves to `prevRev`). The same
low-bound-continuity reasoning applies to `recover` (`[currentRev+1, maxRev+1)` — reconsider whether
it should start at the block's earliest held rev) and to `saveReplica`/`saveDeletion`.

## Tests to add / change

- **Reverse the `'non-contiguous commits stay disjoint (the gap survives)'` test** in
  `block-storage.spec.ts` (currently asserts `[[1,2],[3,4]]`). Under correct semantics a commit at
  rev 1 then rev 3 yields **contiguous** `[[1, 4]]` — rev 2 IS reconstructible (descending-walk to
  rev 1). This test currently pins the buggy behaviour.
- `getBlock(intermediateRev)` between two sparse commits serves the prior materialization (no throw).
- `StorageRepo.get({ blockIds:[B], context:{ rev: tip } })` for a block unchanged at `tip` returns
  B's prior state (public-API regression guard).
- Genuine-gap guard: a node whose lowest reachable materialization is rev K, asked for rev < K,
  still misses `inRanges` (so restore would fire) — confirm the fix does not over-claim below `E`.

## Interaction with siblings (context, not blockers)

- `st-commit-contiguity-guard-premise` (`blocked/`) concerns commit **accepting** non-contiguous
  bases. This ticket is about **coverage/reads**, orthogonal — but the contiguity semantics chosen
  there should be cross-checked so "gap" means the same thing on both the write-guard and the
  read-coverage sides.
- `st-recoverblock-no-production-caller` (`fix/`) owns wiring a real `restoreCallback`. Until that
  lands, an over-claiming *or* under-claiming `ranges` both fail loudly rather than silently
  repairing — so getting coverage honest here matters before restoration is wired, not after.
