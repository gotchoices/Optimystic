description: A storage node that hands data to other machines used to write down the wrong version number afterwards, so a copy a peer sent back in the meantime could be deleted even though the node had started serving it again. The version is now reported by the step that does the handing over, so the record always names what was actually given away.
architecture: docs/arachnode-ring-handoff.md#local-bytes-vs-tracking
files: packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/storage/ring-shift-coordinator.ts, packages/db-p2p/src/storage/released-block-ledger.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/ring-shift-coordinator.spec.ts, packages/db-p2p/test/released-block-sweep.spec.ts, docs/arachnode-ring-handoff.md, packages/db-p2p/docs/storage.md
repro: verified
----

# A replica pushed back during a release can still be deleted — implemented

## What changed, in one sentence

The revision a released block's ledger entry records is no longer read by the ledger after the release; it is a **required argument** supplied by `BlockTransferCoordinator.confirmReplicated`, which read it off this node's own store when it pushed the block to its new holders.

## The four signature changes

Each one is where a reviewer should check the threading, because the whole fix is that one value travels from the confirm to the ledger without anything in between re-deriving it.

- `BlockTransferCoordinator.confirmReplicated` → `{ confirmed, unconfirmed, confirmedRevs: Map<string, number> }`. An entry exists only for a **confirmed** block whose revision was read. Both early returns (partition, non-positive floor) carry an empty map.
- `BlockTransferCoordinator.handleRebalanceEvent` → `RebalanceReactionResult` gains `releasedRevs: ReadonlyMap<string, number>`. The synthetic "nothing to confirm" branch carries an empty map.
- `RingShiftDeps.onRelease(blockIds, releasedRevs)` — Phase C passes through what `confirmShedRange` carried out of Phase B. `ReplicationConfirmer` (the structural interface the stub satisfies) gained `confirmedRevs` to match.
- `ReleasedBlockLedger.record(blockIds, source, releasedRevs)` — the `heldRevisions` dep is gone, so `ReleasedBlockLedgerDeps` is now `{ now? }` and the whole deps argument is optional.

`executeConfirm` captures `outcome.latest?.rev` from the **first** `pushed` outcome it sees, guarded by a separate `revRead` flag so that "read, and the repo reported no latest" is distinguished from "not read yet". First and not last on purpose — a comment at the capture site says why, and a reviewer should push back if that comment does not justify itself: a write landing between two confirm attempts would otherwise be recorded as released, whereas recording a revision that is too *old* can only make the sweep decline.

## Validation / use cases

Run from `packages/db-p2p`:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-shift-coordinator.spec.ts" "test/released-block-sweep.spec.ts" "test/block-transfer.spec.ts" --colors --reporter spec
```

**51 passing.** Also run, all clean: `yarn workspace @optimystic/db-p2p typecheck` (exit 0 — this is what catches every call site of the four signatures above), `yarn workspace @optimystic/db-p2p build`, `yarn lint:docs` (49 docs, 909 citations resolve), `yarn lint:deps`. The package's full suite was deliberately **not** run (`tickets/rules/testing.md` — review owns it).

### The one test added

`packages/db-p2p/test/ring-shift-coordinator.spec.ts`, in the existing `released-block eligibility` describe: *"keeps a replica pushed back between Phase C and the ledger write, rather than deleting it"*. It verifies the defect is closed, over a real `StorageRepo` + `MemoryRawStorage` and a real `ReleasedBlockSweep`:

- rev 1 lands; the stub confirm reports having handed over rev 1
- the move-out's `onRelease` lands **rev 2 before calling `ledger.record`** — the production ordering, since the real `onRelease` untracks and then records
- the entry must carry `releasedRev: 1`, the sweep must report `found: 1, deleted: 0, kept: 1`, the block must still hold rev 2 and still read back through `repo.get`

Under the old sourcing this fails twice over: the entry would carry 2, and the sweep would report `deleted: 1, kept: 0` — which is the ticket's reproduction, now pinned.

`StubConfirmer` gained a `handedOverRev` field (the revision it pretends every push gave away) so both cases in that describe drive the new argument rather than a stubbed metadata read.

### Existing tests updated to the new signature

- the older eligibility case in the same spec: ledger built with no deps; `recordRelease` forwards the map it is handed; `confirmer.handedOverRev = 4` replaces the fake `heldRevisions` that used to answer 4
- `packages/db-p2p/test/released-block-sweep.spec.ts`: `record([BLOCK_ID], 'ring-shift', new Map())`. Same assertion as before (`releasedRev === undefined`) — an empty map is the "no revision" reading that the post-crash state, whose metadata the interrupted delete took, has always produced

### No test for the rebalance arm, deliberately

The revision is a required parameter of `record` and comes out of the one confirm primitive both arms call, so there is no path that can forget to supply one — the type is the enforcement, and the typecheck is what verifies it. `block-transfer.spec.ts` already drives `confirmReplicated` and `handleRebalanceEvent` directly if a reviewer judges a `releasedRevs` field assertion worth adding to an existing case there.

## Known gaps / things worth a reviewer's eye

- **The new test's push lands inside `onRelease`, not truly concurrently.** That is the window the defect lives in (the gap between the release and the ledger write) and it is deterministic, which is why it is reproduced this way rather than with a race. A reviewer who wants the *other* ordering — a push landing between two confirm attempts — will not find it covered; that path is what the first-read capture exists for, and it is asserted only by the comment, not by a test. Deciding whether that deserves one is a reasonable review call.
- **`StorageRepo.heldRevisions` is now unused by the ledger** but is still live for `stated-holdings.ts`, `cluster-repo.ts` and `mesh-harness.ts`, so nothing was removed from the repo's own surface.
- **Stored shape unchanged**, so no migration: an entry written by the previous build is still parsed by `isEntryFor`; it just carries a revision that may be a push's. A node mid-upgrade with such an entry on disk keeps the old (wrong-direction) behaviour for that one entry until the block is released again.
- `debt-three-kv-ledgers-repeat-the-same-record-shape` (backlog) proposes folding this ledger in with two others. Untouched beyond the new `record` signature; no coordination needed.

## Tripwires parked

None. Nothing conditional surfaced during the work — the change removes a capability (the ledger's ability to read metadata) rather than adding one that might later need bounding.

## Docs updated

- `docs/arachnode-ring-handoff.md` § Local bytes vs. tracking — the consequence list went from three to four; the new one states that the recorded revision is the one the confirmation handed over, so every write after the confirm is an advance. The file-list entries for `released-block-ledger.ts` and `handleRebalanceEvent` name the new argument and the new field.
- `packages/db-p2p/docs/storage.md` § Deleting a block — "the committed revision this node held at the time" became the revision the confirmation handed over, with the reason the ledger reads nothing itself. The "A block written again since its release is kept" paragraph was already correct and is unchanged, including its closing note that a push of an already-held revision advances nothing and is therefore deleted.
