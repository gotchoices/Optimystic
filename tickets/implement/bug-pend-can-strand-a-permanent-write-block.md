description: A storage node can be left holding a leftover "write in progress" marker for a write that already finished, and that marker makes the node refuse every future write to that block forever.
files:
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.pend, ~line 501-652 — the whole method is restructured)
  - packages/db-p2p/src/storage/block-storage.ts (BlockStorage.savePendingTransaction, ~line 158 — the seam guard)
  - packages/db-p2p/src/storage/i-block-storage.ts (~line 16 error classes, ~line 74 signature + doc)
  - packages/db-p2p/src/storage/block-latch.ts (~line 93 — acquireBlockWriteLatches doc names its callers)
  - packages/db-core/src/network/stale-failure.ts (isOwnRevision — used unchanged by pend's classification)
  - packages/db-p2p/test/storage-repo.spec.ts (pend race + atomicity tests)
  - packages/db-p2p/test/block-storage.spec.ts (seam guard unit tests; ~line 1697 is the gating pattern to copy)
  - docs/repository.md (Invariant P, ~line 132)
repro: static
difficulty: medium
----

# Make `pend` incapable of writing a pending record that can never be promoted

## Background — what breaks today

When a client writes, a storage node first records a "this write is coming" marker for each block
the write touches (a **pending record**), and later promotes that marker into a real committed
revision. Promotion at commit is the only thing that removes a marker on the success path.

`StorageRepo.pend` decides whether to write a marker by reading the block's current revision
(`blockStorage.getLatest()`, in the per-block classification loop) and writes the marker afterwards,
in a separate `Promise.all` fan-out that takes the block's write latch one block at a time. **The
read is unlatched and the write is latched, so they are not one atomic step.** A commit landing in
the gap is invisible to the decision that already ran, and a marker gets written for a revision that
is already taken.

Nothing removes such a marker:

- The follow-on commit sees the block already at that revision and routes it to `commit`'s
  `alreadyDone` partition, which skips `internalCommit` — the only promoter — so the marker is never
  promoted.
- `cancel` would delete it, but the client only cancels when the write *fails*. Here the write
  succeeds, so no cancel follows.

From then on the node reports that marker as a conflicting in-flight action to every later writer of
the block (`StorageRepo.pend`'s own `listPendingTransactions` scan, and
`ClusterMember.validatePendOperations`'s rival check). The node keeps serving reads and looks
healthy while contributing nothing to that block's writes. `docs/repository.md`'s **Invariant P**
already describes this end state and already names `pend`'s obligation not to create it; what it
does not say is that `pend`'s own check-then-act split creates it anyway.

### The interleaving

One node, one block X, one action A (this is the retry of a write whose blocks committed in groups —
some landed, the rest were refused):

1. A's retry pends X. `pend` reads X's revision unlatched: still behind, so X is neither `satisfied`
   nor stale, and X is queued for a marker.
2. A's earlier commit for X arrives and lands. X advances to the requested revision and A's original
   marker is promoted away.
3. A's retry reaches its save fan-out, takes X's write latch, and writes a marker for A.

X now holds both a committed record and a marker for action A. A's next commit routes X to
`alreadyDone` and returns success, so no `cancel` follows and the marker stays forever. The same gap
strands a marker when the commit landing at step 2 belongs to a *different* action; that does not
violate Invariant P (which is per action) but the marker is equally unpromotable and wedges the
block the same way.

## The fix, in two parts

### Part 1 — `pend` classifies and saves under one multi-block latch hold

Restructure `StorageRepo.pend` so its classification reads and its marker writes happen inside a
single `acquireBlockWriteLatches(blockIds)` hold. This removes the check-then-act split outright
rather than narrowing it, and — because the current unlatched `getLatest()` is *moved* rather than
duplicated — **it costs no additional storage reads on any path.**

Concretely (the two loops replace today's unlatched loop plus latched fan-out):

```ts
// checkPendValidation stays OUTSIDE the hold — it can call a caller-supplied hook, and no
// caller-supplied code may run while N block write latches are held.
const blockIds = blockIdsForTransforms(request.transforms);
const { latches, release } = await acquireBlockWriteLatches(blockIds);
try {
  // Pass 1 — classify. Exactly today's loop body, now reading under the latch.
  //   isOwnRevision(latest, request.rev, request.actionId) → satisfied.add(blockId); continue
  //   latest && latest.rev >= (request.rev ?? 0)          → staleAt + gather `missing`
  //   then listPendingTransactions() → pendings
  // Early returns for `missing` / policy 'f' / policy 'r' happen here, with ZERO markers written.

  // Pass 2 — save. Same hold, so nothing can advance a block between the two passes.
  for (const blockId of blockIds) {
    if (satisfied.has(blockId)) continue;
    await blockStorage.savePendingTransaction(
      request.actionId, transformForBlockId(request.transforms, blockId), request.rev,
      latches.get(blockId)!);
  }
  return { success: true, pending: pendings, blockIds } as PendSuccess;
} finally {
  release();
}
```

Two passes, not one interleaved loop, is load-bearing: with a single loop a block refused partway
through would leave markers already written for earlier blocks, and retracting those under the hold
could delete a marker an *earlier* pend of the same action legitimately left. Classifying everything
before writing anything means no marker is ever written that has to be taken back.

Why this is safe and why it does not deadlock:

- `acquireBlockWriteLatches` dedups and sorts, and is the package's only sanctioned multi-latch
  entry point. `StorageRepo.commit` and `applyInvalidation` already use it, so all three acquire in
  the same global order and no cycle exists. Single-latch `withBlockWriteLatch` holders never nest.
- No caller of `StorageRepo.pend` holds a block latch (`ClusterRepo` ~line 1745,
  `CoordinatorRepo` ~lines 1359/1379, `service.ts` ~line 294 — all unlatched), so the hold cannot
  re-enter itself. Verify this still holds when implementing.
- Everything inside the hold is local storage I/O: `getLatest`, `listRevisions`, `getTransaction`,
  `getPendingTransaction`, `listPendingTransactions`, `savePendingTransaction`. **No network I/O and
  no caller-supplied hook may enter the hold** — that is the same rule `commit` already keeps, and
  it is what keeps hold times short. `getBlock`/`restoreRevision` must not be called here.
- Early `return`s inside the `try` are fine; `finally` releases. `commit` sets that precedent.

The policy-`'r'` branch (which reads each rival's transform to populate the response) moves inside
the hold too. That is a small bonus: it removes the "possible that since enumeration, the action has
been promoted" race for the blocks this pend holds. Keep the `?? getTransaction(...)` fallback
anyway — a rival on a block outside this hold is still possible via a partially-overlapping pend.

Delete the two now-false comment blocks in `pend`: the "Potential race condition … prioritizes
letting the commit be the final arbiter" note above the classification loop (~line 534) and the
"Note: that this is not atomic … this check during pend is conservative" note above the fan-out
(~line 626). Replace them with a short statement of the new property: the classification and the
save are one atomic step per pend, so a pend never writes a marker for a revision already taken.

### Part 2 — the storage seam refuses an unpromotable marker

Make the bad state unrepresentable at the seam so a future caller cannot recreate it.
`BlockStorage.savePendingTransaction` already runs under the block write latch and **already reads
the block's metadata unconditionally** (it reads, then seeds only when absent), so `meta.latest` is
already in hand and the guard costs one comparison and no I/O.

Add `rev` to the signature on both `BlockStorage` and `IBlockStorage`, before the latch (the
interface's stated convention is that the latch token is the LAST parameter):

```ts
savePendingTransaction(actionId: ActionId, transform: Transform, rev: number | undefined,
                       latch: BlockWriteLatch): Promise<void>;
```

Guard, placed immediately after the `getMetadata` read and before the seed branch:

```ts
if (rev !== undefined && meta?.latest !== undefined && meta.latest.rev >= rev) {
  throw new PendRevisionTakenError(this.blockId, actionId, rev, meta.latest);
}
```

The seam's question is **"could this marker ever be promoted?"**, not "is this our own revision?" —
so it deliberately does *not* call `isOwnRevision`. `latest.rev >= rev` collapses both unpromotable
cases into one rule: the writer's own already-committed revision (`===`, which `commit` partitions
as already-done and never promotes) and a rival's win (`>`, which `commit` refuses as stale). The
error carries `latest` so the message can name which it was. `rev === undefined` (an insert-only
claim) names no revision, so no comparison applies and the existing insert-collision handling in
`pend` is unchanged — this carve-out is required by the existing rev-less-pend test at
`packages/db-p2p/test/block-storage.spec.ts` ~line 1697.

New error class in `i-block-storage.ts`, beside `RevisionNotCoveredError`:

```ts
export class PendRevisionTakenError extends Error {
  constructor(readonly blockId: BlockId, readonly actionId: ActionId,
              readonly rev: number, readonly latest: ActionRev) {
    super(`Block ${blockId}: cannot pend action ${actionId} at revision ${rev}; the block is `
        + `already committed at revision ${latest.rev} (action ${latest.actionId}), so the `
        + `pending record could never be promoted`);
    this.name = 'PendRevisionTakenError';
  }
}
```

It **throws** rather than returning a status, and Part 1 makes it unreachable from `pend`: every
block reaching pass 2 was observed under the same held latch to satisfy `latest === undefined ||
latest.rev < rev` (or `rev === undefined`), and no writer can advance it without that latch. So
`pend` does not catch it — a throw here means a caller has reintroduced check-then-act, and an
assertion that fires loudly is the point. A returned status would be a value a caller could ignore,
which is the failure mode being designed out.

`BlockStorage` is the only production implementer of `IBlockStorage`; the only production caller of
this method is `StorageRepo.pend`. Everything else is test setup, so the required-parameter change
surfaces every site as a compile error — pass `undefined` at sites that are seeding a pending record
rather than modelling a real revision-carrying pend.

## Rejected alternatives (do not implement these)

- **Re-read the revision inside the latch, immediately before each save, and skip the save when
  taken.** Closes this instance, leaves the check-then-act shape available to the next caller, and
  makes a "skipped" block indistinguishable from a saved one in the response.
- **Keep the per-block `withBlockWriteLatch` fan-out and let the seam guard be the whole fix.**
  Smaller diff, but a refusal mid-fan-out leaves markers already written for sibling blocks, whose
  removal then depends on `NetworkTransactor.pendPhase`'s best-effort background `cancelBatch`
  (`packages/db-core/src/transactor/network-transactor.ts` ~line 589). That reintroduces the same
  disease through a smaller hole.
- **A background sweep for leftover markers.** Costs nothing on the write path but leaves the bad
  state reachable and the invariant unenforced between sweeps, and it cannot distinguish a genuinely
  in-flight marker from a stranded one without the revision comparison this design does inline. The
  *residual* stranding class it would address — a client that dies between a stale result and its
  `cancel` — is pre-existing, is already documented in `StorageRepo.commit`'s doc comment, is not
  created by `pend`, and is filed separately as
  `backlog/debt-unpromotable-pending-records-need-a-sweep`.

## Edge cases & interactions

- **Torn-action retry (`satisfied` carve-out).** A retry whose block is already committed at exactly
  the requested revision under the same action id must still be waved through with no marker and
  must still appear in the returned `blockIds` (so a later `cancel` covers it). `isOwnRevision` stays
  the single rule for this in pass 1. `tickets/backlog/debt-torn-commit-mesh-coverage-drops-no-blocks`
  tracks the mesh-level coverage gap for this same carve-out — do not fold it in here.
- **Rev-less pend (`request.rev === undefined`, updates-only).** Makes no `getLatest()` call in pass
  1 and no revision comparison at the seam. The existing test "a pend seeding metadata and a replica
  push on a fresh block never erase latest (B)" (`block-storage.spec.ts` ~line 1697) gates on the
  first `getMetadata` for the block, which is still the one inside `savePendingTransaction` — confirm
  it still passes unchanged.
- **Insert-only claim onto an existing block.** `transforms.insert` with `rev === undefined` still
  takes the insert-collision path in pass 1 (`latest.rev >= (request.rev ?? 0)` degrading to
  `>= 0`), and still reports no `staleAt`. Unchanged.
- **A block with no metadata at all.** `latest === undefined`; pass 1 classifies it as pendable and
  the seam allows the seed-then-save. Unchanged.
- **Concurrent commit for the same block and action.** Now serializes against the pend on the block
  latch. Either order must leave no leftover marker: pend-first writes the marker and the commit
  promotes it; commit-first advances `latest` and pend classifies the block as `satisfied`.
- **Concurrent commit for a *different* action.** Commit-first → pend classifies stale and returns a
  conflict with `staleAt`, writing zero markers. Pend-first → marker written, commit then refuses as
  stale and the client cancels — today's behaviour, unchanged.
- **Partially overlapping pends.** Two pends sharing some blocks serialize only on the shared ones.
  The rival-pending scan is still approximate across non-overlapping blocks; that is the existing
  conservative behaviour and is not what this ticket fixes.
- **Deadlock.** A pend and a commit over overlapping block sets, issued in opposite request orders,
  must both complete: both acquire through `acquireBlockWriteLatches`, which sorts. Also check a
  pend overlapping an `applyInvalidation` hold.
- **Duplicate block ids in one pend's transforms.** `acquireBlockWriteLatches` dedups (a repeated id
  would deadlock a plain FIFO mutex against itself), but `blockIds` is used directly for the pass-2
  loop and for the returned `blockIds` — make sure a duplicate does not cause a double save or a
  duplicated response entry.
- **Throw out of pass 1 or pass 2.** `finally { release() }` must release every latch on every path,
  including the `Missing action ${actionId} for block ${blockId}` throw already in the classification
  loop.
- **Latch-hold duration.** Pend now blocks concurrent commits on its blocks for the duration of both
  passes. Accepted: everything inside is local I/O, and `commit` already holds the same set for a
  comparable span. If a pend ever needs to do anything non-local, it must happen outside the hold.

## Tests

Add to `packages/db-p2p/test/storage-repo.spec.ts` (copy the `GatedRaw` / `makeGate` pattern from
`block-storage.spec.ts` ~line 1697 — subclass `MemoryRawStorage`, pause inside an overridden
`getMetadata` for one block id, once):

- **The repro — a commit landing in `pend`'s window strands nothing.** Arm the gate on the FIRST
  `getMetadata` for block B (which is `pend`'s classification `getLatest()`). Drive a pend for
  action `a1` at rev 1 on B; while parked, run `repo.commit({ actionId: 'a1', blockIds: [B],
  rev: 1 })`; release; await both. Assert `raw.getPendingTransaction(B, 'a1')` is `undefined` and
  `raw.getMetadata(B)!.latest` is `{ rev: 1, actionId: 'a1' }`. Expected to FAIL before the change
  (the marker is written after the commit promoted the original) and pass after. Also assert the
  commit does not land while the gate is parked, which is what proves the hold rather than luck.
- **Same, with the racing commit under a DIFFERENT action id.** The pend must return a conflict
  (`conflict: true`, `staleAt.rev`) and leave no marker for either action beyond the committed one.
- **Multi-block atomicity.** A pend over `{X, Y}` where X's revision is taken during the window must
  write markers for neither X nor Y — assert both `getPendingTransaction` reads are `undefined`.
- **A block still wedged is not created.** After the repro test's action completes, a fresh pend from
  a different action at the next revision on B succeeds (proves the node still accepts writes).
- **Satisfied carve-out unchanged.** Torn-action retry at exactly the committed rev/action: pend
  succeeds, no marker written for that block, and the block still appears in the returned
  `blockIds`.
- **No deadlock.** A pend over `[X, Y]` and a commit over `[Y, X]` issued concurrently both settle.

Add to `packages/db-p2p/test/block-storage.spec.ts`:

- `savePendingTransaction` with `rev` equal to a committed `latest.rev` under the SAME action id
  throws `PendRevisionTakenError` and writes nothing (`getPendingTransaction` still `undefined`).
- Same with a committed `latest.rev` greater than `rev` under a DIFFERENT action id — throws.
- `rev === undefined` on a block with a committed `latest` — allowed, marker written.
- No metadata at all — allowed; metadata is seeded with `{ latest: undefined, ranges: [] }` as today.
- Confirm the existing ~line 1697 rev-less pend/replica race test still passes unchanged.

## Docs

- `docs/repository.md` **Invariant P** (~line 132): the paragraph beginning "`StorageRepo.pend`
  carries the mirror-image obligation" currently states the obligation without saying anything
  enforces it. Extend it to say how it is now enforced — `pend` classifies and writes under one
  multi-block write-latch hold, so no commit can land between the two, and
  `BlockStorage.savePendingTransaction` refuses outright to write a pending record for a revision the
  block has already reached. Keep the existing explanation of *why* a stranded record is fatal.
- `packages/db-p2p/src/storage/block-latch.ts` (~line 93): `acquireBlockWriteLatches`' doc says "Two
  callers need it (`StorageRepo.commit` and `applyInvalidation`)". It is three now — add
  `StorageRepo.pend`. The claim that every multi-latch holder acquires in one global order is what
  keeps the new hold deadlock-free, so this comment is load-bearing, not cosmetic.
- `IBlockStorage.savePendingTransaction`'s doc: describe the new `rev` parameter, the refusal rule,
  and `PendRevisionTakenError`. Say plainly that the seam's question is whether the record could ever
  be promoted, which is why it does not use `isOwnRevision`.
- `IBlockStorage.promotePendingTransaction`'s Invariant P doc block: it lists the obligations on
  other writers; add a sentence that the pend side is now enforced at `savePendingTransaction`.

## TODO

- Add `PendRevisionTakenError` to `packages/db-p2p/src/storage/i-block-storage.ts` beside
  `RevisionNotCoveredError`, importing `ActionRev` / `ActionId` as needed, and export it from the
  package's storage barrel if `RevisionNotCoveredError` is exported there.
- Add `rev: number | undefined` before `latch` on `IBlockStorage.savePendingTransaction` and
  `BlockStorage.savePendingTransaction`; implement the guard using the metadata already read.
- Restructure `StorageRepo.pend` into the latched two-pass form above; keep `checkPendValidation`
  outside the hold; keep `isOwnRevision` as the `satisfied` rule in pass 1.
- Delete the two stale race/atomicity comment blocks in `pend` and replace them with the new
  property statement.
- Update every remaining `savePendingTransaction` call site (test setup across
  `packages/db-p2p/test/block-storage.spec.ts`, `storage-repo.spec.ts`, `storage-monitor.spec.ts`'s
  mock) to the new arity — `undefined` where the site is seeding rather than modelling a real pend.
  Raw-storage-level calls (`IRawStorage.savePendingTransaction`, 3 args, no latch) are a different
  method and are NOT changed.
- Write the storage-repo race/atomicity tests and the block-storage seam tests listed above.
- Update `docs/repository.md`, `block-latch.ts`, and the two `IBlockStorage` doc blocks.
- Validate, in the foreground: `yarn workspace @optimystic/db-p2p build` then
  `yarn workspace @optimystic/db-p2p test`. The db-p2p suite runs about 2m46s — well inside the idle
  window, but do not redirect its output to a file.
- Also run the three storage-driver packages (`packages/db-p2p-storage-fs`, `-ns`, `-rn`), which
  consume `packages/db-p2p/src/testing/raw-storage-conformance.ts` and drive `repo.pend` through the
  new hold, plus `packages/quereus-plugin-optimystic`. Root `yarn typecheck` after `yarn build`
  catches any missed call site in the esbuild-built packages.
- Hand off to `review/` naming honestly: whether the repro test was confirmed to fail before the
  change, and whether the deadlock and duplicate-block-id cases got real tests or only reasoning.
