description: When a storage node hands data to other machines, it writes down which version it was holding so that it will not later delete a copy someone has since sent back to it. It writes that down a moment too late, so a copy that arrives in the gap is recorded as if it were the version handed over — and can then be deleted even though the node has started serving it again.
architecture: docs/arachnode-ring-handoff.md#local-bytes-vs-tracking
files: packages/db-p2p/src/storage/released-block-ledger.ts, packages/db-p2p/src/storage/ring-shift-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/storage-repo.ts
repro: static
severity: edge-case
likelihood: contrived
tradeoffs: The gap is a handful of event-loop turns and the damage repairs itself through read repair, so a maintainer may reasonably keep the current single read rather than thread a revision per block out of both release paths.
----

# A replica pushed back during a release can still be deleted

## What the system promises

A node deletes a block's bytes only after a handoff confirmed that enough other machines hold it. Because a peer may send the same block back afterwards — pushes are idempotent and several machines may push the same block — the node also promises not to delete a block it has *accepted again* since the handoff. The way it keeps that second promise is to remember, per released block, which version it was holding at the moment of release, and to refuse to delete the block later if its version has moved past that.

## Where that breaks

The remembered version is read **after** the release, not at the moment the release was decided. In `ReleasedBlockLedger.record` the node asks its own metadata what version it holds, and both callers call `record` only once the handoff has already released the range and the node has stopped serving it.

So there is a gap: release happens, then a few event-loop turns pass (the untrack loop, the growth bookkeeping on the rebalance path), then the version is read. A replica that arrives inside that gap is accepted first and read second, so the version written down is the version the push just delivered. Later, when the sweep asks "has this moved past what I recorded?", the answer is no — and the block is deleted.

The node is, by then, serving that block again: a push that moved the version forward emits a collection change, and the owned-block feed turns that back into a tracked block. The result is a block the node advertises and has no bytes for, until a read misses and read repair fetches it back.

The direction of the error is worth being precise about, because the code comments argue the opposite case correctly. A write landing *after* the read makes the recorded version too old, which makes the sweep decline the block — harmless. It is only a write landing *between the release and the read* that is recorded as though it were the released version.

Not observed running — read out of the code. What would confirm it is a test that lets a replica land between the release and the ledger write and then checks whether the sweep deletes the block.

## What the fix has to establish

The recorded version must be the one the release decision was made on, not one read afterwards. That means capturing the held version at or before the point the handoff releases the range — inside the ring shift's confirm/release step, and at the confirmed rebalance release — and handing it to the ledger, rather than having the ledger go and look. Then any write at all after that point moves the version past what was recorded, and the sweep declines, which is the safe direction in every ordering.

Both release paths need the same treatment; a fix on one of them leaves the class open on the other.

## Promoted to fix (garden, 2026-11-23)

Pulled into this release: the deletion it races was added by `3.3-a-node-deletes-what-it-released` and is not yet released, so the release should not introduce it with a known window in which a block the node is serving can be deleted, however rare.
