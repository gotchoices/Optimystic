description: A storage node that failed partway through a write the rest of the cluster accepted used to keep a dead leftover record forever, which made it reject every later write to that data. Those leftovers are now deleted at the two moments they become unusable, and reviewed.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, docs/repository.md, docs/internals.md
----

# Complete: drop pending records that can no longer be promoted

## What the change is

A write leaves two records on a node: a **pending record** (written by `pend`) and, on commit, a
**committed record**. Commit *moves* the pending record into the committed namespace atomically
(`promotePendingTransaction`). Two code paths used to write a committed record — or give up on a
batch — without ever removing the matching pending record. Those leftovers can never be promoted,
and `StorageRepo.pend` reports each as a conflicting action on every later write to the block; under
the fail-on-pending policy the node then refuses to participate in that block's writes permanently
while still looking healthy and serving reads.

**Arm 1 — `StorageRepo.commit` drops the batch's pending records on a divergence failure.** New
private helper `dropUnpromotablePendings(blocks, actionId)` deletes the action's pending record
across a set of block storages, tolerating absence. Two call sites, both inside commit's `try` so the
per-block latches are still held: before the pre-loop `Pending action … not found` throw, and after
the mid-loop `break` — the latter gated on `err instanceof MissingBaseRevisionError` via a
`divergentFailure` flag.

The discriminator is the load-bearing part. `ClusterMember` splits commit failures into *divergence*
(tolerate, then reconcile every block in the batch from a cohort peer) and *genuine fault* (propagate
for retry). Divergence ⇒ every block advances past the action ⇒ drop. Genuine fault ⇒ a retry can
still replay the pending records ⇒ keep. Cleanup failures are logged and swallowed, never propagated:
the pre-loop throw's message is pattern-matched by `ClusterMember.isMissingPendingActionError`, so a
swapped error would misroute consensus.

**Arm 2 — `BlockStorage.saveForwardRevision` maintains Invariant P.** *Invariant P*: a block never
holds a pending record and a committed record for the same action id at the same time.
`saveForwardRevision` (shared by `saveReplica` and `saveDeletion`) now calls
`deletePendingTransaction(actionId)` right after `saveRestored` writes the committed transform. On
the write path only — the monotonic guard returns before it, so an equal-or-older
`saveReplica`/`saveDeletion` deletes nothing. Placed in `saveForwardRevision` rather than
`saveRestored`, so `ensureRevision`'s historical restore (different latch, can overlap a live commit)
is untouched.

## Validation

From the repo root: `yarn lint` clean, `yarn build` clean, `yarn test` green across every workspace
(exit 0; db-p2p 1540 passing / 44 pending, plus the four storage-backend packages). Each backend
package was also run individually to confirm the new conformance case executes there: filesystem 53
passing, SQLite 50, LevelDB 45, IndexedDB 44.

`yarn test:integration` was **not** run — it stands up real TCP meshes and routinely exceeds the
runner's 10-minute idle window, so it is not agent-runnable. See *Left for a human* below.

## Review findings

**Read first, cold:** the implement-stage diff (`git show c6a5bf4`), then the surrounding source —
`StorageRepo.commit` / `internalCommit` / `readCommitBase` / `refuseMissingBase`, `BlockStorage`'s
forward-write and pending paths, `ClusterMember.applyConsensusOperation` and
`reconcileDivergentCommit`, `CoordinatorRepo.commit` / `cancel`, `db-core`'s coordinator
`cancelPhase`, the raw-storage conformance suite and all five backend implementations, and every doc
page mentioning `saveReplica` or pending records.

### Minor — fixed in this pass

- **The "no-op on every backend" claim was asserted, never tested.** Both arms delete a pending
  record without first checking it exists — `dropUnpromotablePendings` over a whole batch, and
  `saveForwardRevision` on every forward write. The doc comments state that deleting an absent record
  is a tolerated no-op on every backend, but the raw-storage conformance suite only covered deleting
  a record that *was* there, and the new tests only exercised the in-memory backend. A backend that
  threw on a miss (an `ENOENT` unlink, a strict key delete) would turn every ordinary commit into a
  logged failure. Added a conformance case — `deletePendingTransaction on an absent entry is a
  tolerated no-op` — covering absent-entry delete, delete of a different action beside a live pending
  (the scoping the tripwire depends on), and double-delete idempotence. It runs on all five backends
  and passes; this is the boundary invariant, so any backend added later inherits the check.

- **`saveForwardRevision`'s action-id scoping had no test on the write path.** The existing test only
  covered the monotonic *no-op* path, which never reaches the deletion. Nothing pinned that a landing
  replica leaves a genuinely in-flight pend for a *different* action alone — exactly what the "widen
  to a sweep" tripwire at that site would break. Added `leaves an unrelated action's pending alone on
  the write path` to `block-storage.spec.ts`.

- **The swallow-and-log contract had no test.** The doc comment explains at length that a cleanup
  failure must not replace the caller's error, because `ClusterMember` pattern-matches the
  `Pending action …` message to route the divergence to reconcile — but nothing exercised a throwing
  `deletePendingTransaction`. Added `a cleanup that itself fails must not replace the error the caller
  reports` to `storage-repo.spec.ts`, asserting the divergence signal survives and the injected fault
  does not leak.

- **`commit()`'s doc comment gave the wrong cure for the stale/ahead path.** It claimed the
  early-return path's pending records are removed later by replication via
  `BlockStorage.saveForwardRevision`. They are not: on that path this node is already *ahead*, so a
  later forward write carries a **different** action id, and Arm 2 deletes only the committing
  action's record. The actual cure is the losing client's `cancel`, which `CoordinatorRepo.cancel`
  runs through consensus so every member drops the record — verified by reading
  `coordinator.cancelPhase` → `NetworkTransactor.cancel` → `CoordinatorRepo.cancel`. Behaviour is
  correct; only the stated mechanism was wrong. Comment rewritten, and it now names the residual
  hole honestly (a client that dies between the stale result and its `cancel` still strands the
  record — pre-existing and orthogonal to this change).

- **`readCommitBase`'s accepted-tradeoff note understated its new blast radius.** That catch is
  deliberately unnarrowed, so a transient raw-storage read fault is converted into
  `MissingBaseRevisionError` and treated as divergence. The note said the price is that a transient
  fault "ALSO drops the pending" — singular, one block, which was true when only `refuseMissingBase`
  deleted. Arm 1 keys its cleanup off that same error type, so the price is now the whole batch's
  records. Note updated to say so, and to state that the discriminator must not be loosened beyond
  this error type. (This is a widening of an existing accepted tradeoff, not a new one — the tolerant
  reading is still the right default, since the cluster's policy is to heal rather than throw out of
  consensus.)

- **Docs were stale where the change should have touched them.** `docs/internals.md:767` describes
  `BlockStorage.saveReplica`'s persist behaviour step by step and did not mention the pending
  deletion; added it, with the monotonic-no-op carve-out and a link to the `docs/repository.md`
  Invariant P section. The same file's *commit divergence split* bullet documented the
  tolerate-vs-propagate rule at the cluster layer without the new storage-layer consequence; added
  the drop-vs-keep counterpart and the cross-layer agreement requirement. `docs/repository.md` and
  `i-block-storage.ts` were checked and are accurate as landed.

### Major — none

Nothing rose to a new ticket. The two arms are correct as specified and the discriminator is placed
where the cluster layer's own split lives. Specifically checked and found sound: cleanup over
`toCommit` cannot harm already-landed blocks (their record was promoted, so the delete is a no-op),
`recovered` Crash-D3 blocks (record already gone), `alreadyDone` blocks (never in `toCommit`), or the
refusing block itself (`refuseMissingBase` already deleted it); both cleanup call sites run inside
the `try` with the latches held; `divergentFailure` cannot leak across iterations because the loop
breaks on the first failure; and `Promise.all` with a per-item `try`/`catch` leaves no unhandled
rejection.

### Conditional / speculative — recorded as tripwires, not tickets

Two were already recorded at their code sites by the implementer and were re-read and left in place:
the Arm 2 deletion is scoped to the committing action id rather than a sweep (widen only if orphaned
records appear in the field on blocks whose committing action id differs), and the Arm 1 keep-arm
depends on `ClusterMember` retrying propagated commit faults (if that ever stops, the discriminator
can collapse to "always drop"). The scoping tripwire now has a test guarding it in both directions,
so widening it would fail loudly rather than silently.

The blast-radius concern from the `readCommitBase` finding above is parked as prose at that site
rather than as a ticket, for the same reason: it is fine today and only becomes work if typed faults
out of `BlockStorage` ever make narrowing possible.

### Considered and declined

- **Comment-to-code ratio.** Arm 2 is one line of code under twenty lines of comment, and Invariant P
  is now stated in four places (interface doc, `docs/repository.md`, the code site, the test's
  describe block). Measured against the surrounding file this matches house style — `storage-repo.ts`
  and `block-storage.ts` are uniformly this dense, and the repetition is at genuinely different
  altitudes (contract, architecture, site, test). Churning it would cost more than it returns.

- **`block-storage.ts:295` calls `this.storage.deletePendingTransaction(...)` directly rather than the
  class's own `deletePendingTransaction(actionId)` wrapper.** Looks like a DRY miss, but the wrapper
  logs under the label `cancel`, and this is not a cancel. The direct call is the right one.

### Source hygiene

`storage-repo.ts` is 991 lines and `block-storage.ts` 468 — both grew by well under a hundred lines
here (`git show c6a5bf4 --stat`: +82 and +23), and neither crosses a threshold this change created.
No split warranted. The new helper is short, single-purpose, and named for what it does.

## Left for a human / CI

- **`yarn test:integration` has not been run against this change.** The cluster-level round trip —
  `ClusterMember.applyConsensusOperation` → `reconcileDivergentCommit` → `saveReplicatedBlock` → a
  later successful pend on the same block — is covered only at the `StorageRepo` / `BlockStorage`
  layer, by simulating reconcile with a direct `saveReplicatedBlock` call. The suite needs real TCP
  meshes and exceeds the agent runner's idle window, so it is a CI or human pass.

- **No crash-consistency test pins the Arm 2 ordering.** The pending delete lands between
  `saveRestored` and `saveMetadata`; a crash in that window leaves a committed record with `latest`
  unadvanced, which the existing Crash-D3 `recover()` shape already handles, but nothing in the suite
  exercises that specific interleave on the forward path. Judged low value relative to cost — the
  window is already covered in shape, just not on this path.

- **Fault injection covers one representative throw site** (`saveMaterializedBlock`). It does not
  prove that every other raw-storage throw site stays outside `readCommitBase`'s unnarrowed catch.
  Given that catch is deliberate and now documented as such, this is a bounded rather than open
  question.
