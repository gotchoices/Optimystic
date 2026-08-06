description: A storage node that failed partway through a write the rest of the cluster accepted used to keep a dead leftover record forever, which made it reject every later write to that data. Those leftovers are now deleted at the two moments they become unusable.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, docs/repository.md
difficulty: medium
----

# Review: drop pending records that can no longer be promoted

## What changed

A write leaves two records on a node: a **pending record** (written by `pend`) and, on commit, a
**committed record** — commit *moves* the pending record into the committed namespace atomically
(`promotePendingTransaction`). Two code paths used to write a committed record, or give up on a
batch, without ever removing the matching pending record. Those orphans are unpromotable forever and
`StorageRepo.pend` reports each as a conflicting action on every later write to the block; under
`policy: 'f'` the node then refuses to participate in that block's writes permanently while still
looking healthy and serving reads.

Both arms landed as specified in the implement ticket, plus the doc/test work.

### Arm 1 — `StorageRepo.commit` drops the batch's pendings on a divergence failure

`storage-repo.ts`. New private helper `dropUnpromotablePendings(blocks, actionId)`
(`storage-repo.ts:750`) deletes `actionId`'s pending record across a set of block storages,
tolerating absence. Two call sites, both **inside** commit's `try` (per-block latches still held):

- Before the pre-loop `Pending action … not found` throw (`storage-repo.ts:651`), over `toCommit`.
- After the mid-loop `break` (`storage-repo.ts:713`), over `toCommit`, **gated on
  `err instanceof MissingBaseRevisionError`** via a new `divergentFailure` flag set in the catch
  (`storage-repo.ts:702`).

The discriminator is the part that matters. `ClusterMember` splits commit failures into *divergence*
(tolerate + reconcile every block in the batch) and *genuine fault* (propagate for retry).
Divergence ⇒ every block advances past the action ⇒ drop. Genuine fault ⇒ a retry can still replay
the pendings ⇒ **keep**. Documented as a table in a new doc comment on `commit`
(`storage-repo.ts:498`).

Cleanup failures are logged and swallowed, never propagated — the pre-loop throw's message is
pattern-matched by `ClusterMember.isMissingPendingActionError`, so a swapped error would misroute
consensus.

### Arm 2 — `BlockStorage.saveForwardRevision` maintains Invariant P

`block-storage.ts:272`. **Invariant P**: a block never holds a pending record and a committed record
for the same action id at the same time. `saveForwardRevision` (shared by `saveReplica` and
`saveDeletion`) now calls `deletePendingTransaction(actionId)` immediately after `saveRestored`
writes the committed transform. On the write path only — the monotonic guard returns before this, so
an equal-or-older `saveReplica`/`saveDeletion` still deletes nothing. Placed in
`saveForwardRevision`, not `saveRestored`, so `ensureRevision`'s historical restore (different latch,
can overlap a live commit) is untouched.

Arm 2 covers the *ahead*-divergence route, where commit returns stale early and Arm 1 never runs, and
the `StorageRepo.get` read-driven-promotion route (heals via read-repair → `saveReplicatedBlock`).

### Docs

- `i-block-storage.ts`: Invariant P stated on `promotePendingTransaction`, with the obligation
  restated on `saveReplica` and `saveDeletion`.
- `docs/repository.md`: new `#### Invariant P` subsection under the `commit(request)` behaviour list —
  what the invariant is, who maintains it, why an orphan is permanent, and the commit-side
  divergence-vs-fault split.

## Validation

`yarn build` from root: clean. Full workspace `yarn test`: **all green, no failures** (db-p2p 1537
passing / 44 pending; every other package unchanged and passing). No `.pre-existing-error.md` was
needed.

Targeted run of the two touched specs: 106 passing.

```
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/storage-repo.spec.ts" "test/block-storage.spec.ts" --reporter spec
```

### Tests added / changed

`storage-repo.spec.ts`, inside `describe('mixed batch (one block committable, one with no base)')`:

- The two `KNOWN GAP:` specs are flipped to `.to.equal(true)` and renamed —
  `drops a not-yet-reached sibling's pending, which could never be promoted` and
  `drops them for the missing-pend divergence too (no refusal involved)`. The latter still asserts
  the throw carries `Pending action` and omits `MISSING_BASE_REVISION_REASON`. The only remaining
  `KNOWN GAP:` in the file is the unrelated pending-only-insert one
  (`debt-pending-only-insert-unreadable-with-context`) — verified by grep.
- **`KEEPS the pendings when the failure is a genuine fault, and a retry replays them`** — the
  regression guard for the discriminator. A `MemoryRawStorage` subclass throws a one-shot fault from
  `saveMaterializedBlock` for one block; asserts both the faulting block and the not-yet-reached
  sibling keep their pending records, then that a retry of the same `(actionId, rev)` commits both.
- `an idempotent-retry block is not in the batch, so cleanup cannot touch it` — an `alreadyDone`
  block stays committed and writable.
- `surfaces the refusal even when a sibling block committed first` gained a change-event assertion:
  the landed sibling still emits exactly one event with the right `blockIds`/`actionId`/`rev`.

`block-storage.spec.ts`, new `describe('Invariant P on the forward write paths')`: `saveReplica`
clears a matching pending; a later `policy: 'f'` pend is then accepted (through `StorageRepo`);
`saveDeletion` clears one; the monotonic no-op deletes nothing.

## Use cases worth exercising

- **Reconcile after a missing-base refusal.** Node misses a block's creating revision → commit
  refuses → `ClusterMember` reconciles → later writes to every block in that batch are accepted.
- **Reconcile after a missing pend.** Same, but the node never received the pend at all: commit
  throws before the per-block loop, every block in the batch keeps working afterwards.
- **Transient storage fault mid-batch.** Must NOT reconcile-and-forget: the batch's pendings survive
  and the retry replays them. This is the behaviour a careless "always drop" would silently break.
- **Replica/tombstone landing on a node that had pended the same action.** Revision lands, pending
  twin gone, node keeps participating.

## Known gaps / what a reviewer should push on

- **`yarn test:integration` was deliberately NOT run** (per the implement ticket): it exercises real
  TCP meshes and routinely exceeds the runner's 10-minute idle window. The cluster-level round trip —
  `ClusterMember.applyConsensusOperation` → `reconcileDivergentCommit` → `saveReplicatedBlock` → a
  later successful pend on the same block — is therefore covered only at the `StorageRepo` /
  `BlockStorage` layer, by simulating reconcile with a direct `saveReplicatedBlock` call. Worth a
  human/CI pass.
- **The discriminator's fault arm is only as good as `ClusterMember`'s retry behaviour.** Arm 1
  assumes a propagated commit fault is retried. That assumption is recorded as a `NOTE:` tripwire at
  the discriminator, not enforced anywhere.
- **Arm 2 deletes only the committing `actionId`**, not every pending whose action is already
  committed. A pending orphaned by a route that lands a *different* action id would survive. Judged
  out of evidence-scope and recorded as a `NOTE:` tripwire; a reviewer may disagree about whether the
  sweep is warranted now.
- **No crash-consistency test for the Arm 2 ordering.** The pending delete lands between
  `saveRestored` and `saveMetadata`. A crash in that window leaves a committed record with `latest`
  unadvanced — the existing Crash-D3 shape `recover()` already handles — but nothing in the suite
  pins that specific interleave for the forward path.
- **The fault-injection test injects at `saveMaterializedBlock`.** That is one representative
  non-divergence fault; it does not prove every other raw-storage throw site stays outside
  `readCommitBase`'s deliberately-unnarrowed catch (which converts throws to `MissingBaseRevisionError`
  and therefore *would* be treated as divergence). Reviewer may want to confirm that boundary is
  where it should be.

## Review findings

- Tripwire recorded at the Arm 2 deletion site (`block-storage.ts`, in `saveForwardRevision`):
  deletes only this revision's `actionId`, not a sweep — widen if orphaned pendings ever appear in
  the field on blocks whose committing action id differs.
- Tripwire recorded at the Arm 1 discriminator (`storage-repo.ts`, after commit's per-block loop): a
  non-divergence fault keeps the batch's pendings so a retry can replay them; if `ClusterMember` ever
  stops retrying propagated commit faults, the discriminator can collapse to "always drop".
