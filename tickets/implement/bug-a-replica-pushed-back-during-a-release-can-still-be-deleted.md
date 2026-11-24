description: When a storage node hands data to other machines, it writes down which version it was holding so that it will not later delete a copy someone has since sent back to it. It writes that down a moment too late, so a copy that arrives in the gap is recorded as if it were the version handed over — and can then be deleted even though the node has started serving it again.
architecture: docs/arachnode-ring-handoff.md#local-bytes-vs-tracking
files: packages/db-p2p/src/storage/released-block-ledger.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/storage/ring-shift-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/ring-shift-coordinator.spec.ts, packages/db-p2p/test/released-block-sweep.spec.ts, docs/arachnode-ring-handoff.md, packages/db-p2p/docs/storage.md
repro: verified
difficulty: medium
----

# A replica pushed back during a release can still be deleted

## The defect, reproduced

`ReleasedBlockLedger.record` is the only writer of the record that permits a block's bytes to be deleted, and the revision it stores in that record — `ReleasedBlockEntry.releasedRev`, the thing the sweep's "has this been written again?" check compares against — is read *inside `record`*, from this node's own metadata, at the moment the entry is written. Both callers call `record` only **after** the handoff has released the range and the node has stopped serving it. So a replica a peer pushes back in the gap between the release and the ledger write is read as if it were the revision handed over, and the sweep then deletes a block the node has accepted again and is serving.

Reproduced at the ledger layer on 2026-11-24 (temporary spec, since removed): land rev 1 through `StorageRepo.saveReplicatedBlock`, then land rev 2 — the push in the gap — then `record`. The entry came back carrying `releasedRev: 2`, and one `ReleasedBlockSweep.sweep` over the real repo reported `deleted: 1, kept: 0`: the bytes of the revision the node had just accepted were deleted. With the release-time revision (1) recorded, `deleteBlockIfNotAdvanced` would have seen `latest.rev (2) > pastRev (1)` and kept them.

The direction matters and the existing comments argue the opposite case correctly: a write landing *after* the read makes the recorded revision too old, the sweep declines, bytes are kept — harmless. Only a write landing *between the release and the read* is recorded as though it were the released revision.

## Root cause

One site, two arms. The ledger *sources* the revision itself, so every caller is structurally late — the ledger cannot see the release it is recording. The fix removes the ledger's ability to be late: the revision becomes a **required argument**, supplied by the step that made the release decision, and the ledger stops reading metadata at all.

The step that made the release decision is the same one on both arms: `BlockTransferCoordinator.confirmReplicated` (Phase B of a ring shift; the lost-block confirm of the rebalance reaction). It is also the step that already knows the answer — `pushBlockToPeers` returns `PushBlockOutcome.latest` (`result.state?.latest`, the revision of the bytes it read and handed over), which `executeConfirm` currently discards. So the confirmed revision travels out of the confirm instead of being re-derived after the fact, and no new store read or dependency is added anywhere.

That also makes the entry's meaning exact and checkable: **the revision this node handed over**, not "whatever its metadata said at some later moment".

## The shape

`packages/db-p2p/src/cluster/block-transfer.ts`

- `executeConfirm` captures `outcome.latest?.rev` from the **first** `pushed` outcome it sees — including when that is `undefined` — and returns it alongside `confirmed` / `confirmedPeers` / `noLocalData`. First, not the confirming round: a long confirm may run several attempts, and a write landing between two of them would otherwise be recorded as released. The earliest revision read is the most conservative one still available, and recording it only ever makes the sweep decline — bytes kept, and the block re-offered by the next pass. Say that in a comment where the capture happens, so a later reader does not "simplify" it to the last read.
- `confirmReplicated` returns `{ confirmed, unconfirmed, confirmedRevs }`, where `confirmedRevs: Map<string, number>` holds an entry **only** for a confirmed block whose revision was read. Absent and "no revision" are deliberately the same thing: both become an entry with no `releasedRev`, under which the sweep declines a block that holds any revision now. Its early returns (partition, non-positive floor) carry an empty map.
- `RebalanceReactionResult` gains `releasedRevs: ReadonlyMap<string, number>` — the revision each block in `released` was confirmed replicated at. The synthetic "nothing to confirm" branch in `handleRebalanceEvent` (`event.lost.length === 0 || event.newOwners.size === 0`) carries an empty map.
- `ReplicationConfirmer` (declared in `ring-shift-coordinator.ts`) gains the same field in its return type.

`packages/db-p2p/src/storage/ring-shift-coordinator.ts`

- `confirmShedRange` passes the confirmer's `confirmedRevs` out on its `{ ok: true }` result.
- Phase C hands it to `onRelease`, whose signature becomes `(blockIds: string[], releasedRevs: ReadonlyMap<string, number>) => void | Promise<void>`. Nothing else about the phase moves: the revisions were read during Phase B, strictly before the advertisement flips, which is what makes every later write an advance.

`packages/db-p2p/src/storage/released-block-ledger.ts`

- `record(blockIds, source, releasedRevs: ReadonlyMap<BlockId, number>)` — no metadata read, no `heldRevisions`. `ReleasedBlockLedgerDeps` loses that field and keeps only `now?`, so the whole deps argument becomes optional.
- Rewrite `ReleasedBlockEntry.releasedRev`'s doc comment: it is now the revision the confirmed handoff handed over, captured by the confirm step, absent when the confirm read none. Keep the explanation of *why* absent means "decline a block that holds one now", and drop the sentence about `StorageRepo.heldRevisions` leaving a block out.
- The module header and `record`'s own comment both describe the read-per-release; both need to say instead that the caller supplies the revision and why that is the only ordering that is safe. The refresh-on-re-release paragraph stays true as written.

`packages/db-p2p/src/libp2p-node-base.ts`

- `recordReleased(blockIds, source, releasedRevs)` passes the map straight through to the ledger.
- The ring-shift `onRelease` and the rebalance reaction each forward what they were given (`result.releasedRevs`). **No new `await` goes in front of the rebalance reaction's untrack / growth-feedback loops** — the comment there explaining why those effects stay synchronous ahead of the ledger write is load-bearing, and sourcing the revisions from the confirm is what keeps it true.
- The `ReleasedBlockLedger` construction (around line 1229) loses its `heldRevisions` dep; the comment above it explaining why the ledger is built after the repo goes with it.

## Tests

One new case, in `packages/db-p2p/test/ring-shift-coordinator.spec.ts` beside the existing `released-block eligibility` describe, which already owns this chain: a move-out whose Phase C release is followed — before the ledger write, as the production wiring orders it — by a replica landing through a real `StorageRepo`, and then a real `ReleasedBlockSweep` over that repo. Assert the entry carries the confirmed revision, not the pushed one, and that the run reports `kept: 1, deleted: 0` with the bytes still readable. It needs a real `StorageRepo` + `MemoryRawStorage` (the existing case there uses a stubbed deleter and a fixed revision, so it cannot see this), and `StubConfirmer` must report a `confirmedRevs` map for the revision it pretends to have handed over.

That is the whole new-test budget. The rebalance arm needs none: the revision is a required argument of `record` and comes out of the one confirm primitive both arms call, so there is no path that can forget to supply one — the type is the enforcement, and `block-transfer.spec.ts` already drives `confirmReplicated` and `handleRebalanceEvent` directly if a field assertion turns out to be worth adding to an existing case.

`packages/db-p2p/test/released-block-sweep.spec.ts` and the existing eligibility case in the ring-shift spec both construct the ledger with a `heldRevisions` dep and call `record` with two arguments; both need updating to the new signature. The sweep spec's case is about a block whose metadata the interrupted delete took — under the new signature it passes an empty map, which is the same "no revision" reading it asserts today.

Run only what this touches (`tickets/rules/testing.md`): `yarn workspace @optimystic/db-p2p test` is the full package suite and takes minutes — do not run it. Run the two spec files, plus `block-transfer.spec.ts` because the confirm primitive's return type changed:

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/ring-shift-coordinator.spec.ts" "test/released-block-sweep.spec.ts" "test/block-transfer.spec.ts" --colors --reporter spec
```

and `yarn workspace @optimystic/db-p2p typecheck`, which is what catches every call site of the four changed signatures.

## Docs

- `docs/arachnode-ring-handoff.md` § Local bytes vs. tracking — the rule's three consequences do not yet mention the revision at all. Add the fourth: the recorded revision is the one the confirm handed over, so every write after the confirm is an advance and a block pushed back is kept. The file-list entry for `released-block-ledger.ts` near the end says "the per-entry revision the sweep's written-again check reads"; say where that revision now comes from. The `handleRebalanceEvent` returns `{ … }` line in the same list gains `releasedRevs`.
- `packages/db-p2p/docs/storage.md` § Deleting a block — "the committed revision this node held at the time" (line ~165) becomes the revision the confirmation handed over. The "A block written again since its release is kept" paragraph (line ~171) is correct as written and stays, including its closing note that a push of a revision this node already held advances nothing and is therefore deleted.

## Notes for the implementer

- `debt-three-kv-ledgers-repeat-the-same-record-shape` (backlog) proposes folding this ledger in with two others. It is untouched by this change beyond the new `record` signature — nothing here makes that refactor harder, and no coordination is needed.
- `ReleasedBlockEntry` is a stored shape with a validating parser (`isEntryFor`). The stored shape does **not** change: an entry written by the current build is still read correctly, it just carries a revision that may be a push's. No migration.

## TODO

- Capture the first-read revision in `executeConfirm` and return it; thread `confirmedRevs` out of `confirmReplicated` and `releasedRevs` out of `handleRebalanceEvent`; add the field to the `ReplicationConfirmer` return type.
- Carry the map out of `confirmShedRange` and hand it to `onRelease` in Phase C; widen `RingShiftDeps.onRelease`.
- Make the revisions a required argument of `ReleasedBlockLedger.record`, drop the `heldRevisions` dep, and rewrite the three comments that describe the read-per-release (module header, `record`, `releasedRev`).
- Forward the map through `recordReleased` and both release call sites in `libp2p-node-base.ts`; drop the ledger's `heldRevisions` wiring.
- Update `StubConfirmer` and the two existing specs to the new signatures.
- Add the one new case: a replica landing after Phase C's release and before the ledger write is kept by the sweep, not deleted.
- Update the two documents above.
- Run the three spec files and the package typecheck.
