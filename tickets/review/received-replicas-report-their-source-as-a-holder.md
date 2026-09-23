description: When a machine stores a copy of a block that another machine sent it, it now remembers that the sender has that block, so its next background check no longer sends the copy straight back to the sender and fetches it again. The same memory is now also fed by a repaired block.
architecture: docs/internals.md#rebalancemonitor
files:
  - packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferServiceComponents.onBlockHolders`, `handlePush`'s new `senderPeerId` parameter, `reportSenderHolds`)
  - packages/db-p2p/src/cluster/reconcile-block.ts (`ReconcileBlockDeps.onBlockHolders`, `reportRestoredHolders`)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordBlockHolders`, `BlockHolders`, `HolderEvidence`, `holderEvidence` — the renamed evidence path)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`BlockHoldersSink` declared here; `ClusterMember.reportBlockHolders`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CoordinatorRepo.reportBlockHolders`)
  - packages/db-p2p/src/libp2p-node-base.ts (`blockHoldersTarget` / `onBlockHolders`, hoisted above `libp2pOptions`; the four producer wirings)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.onBlockHolders`, now also bound to each node's reconcile closure)
  - packages/db-p2p/test/rebalance-push-holders.spec.ts (new — the push arm)
  - packages/db-p2p/test/reconcile-block.spec.ts (new `holder evidence for the rebalance monitor` describe)
  - docs/internals.md (§ Cluster Health Monitors → RebalanceMonitor, the **Holder evidence** block; and the `handlePush` paragraph under SpreadOnChurnMonitor)
----

# Review: a received replica, and a repaired block, report who else holds them

## What landed

`RebalanceMonitor` decides whether to push a block to a cohort peer by asking whether it has evidence that peer already holds it. That evidence arrives through one method, and before this ticket that method had two producers, both on the commit path. A block arriving any other way reported nothing, so the next check pushed it back to the peer it came from and fetched it again.

Two producers were added, and the existing path was renamed to stop claiming it is commit-specific.

**The push receiver.** `BlockTransferService.handleRequest` already holds the inbound `Connection`; it now passes `connection?.remotePeer?.toString()` into `handlePush`, which reports the sender as a holder of every block it *accepted* — literally `Object.keys(blocks)`, the complement of `missing`. A block that failed parsing, certification or persistence reports nothing. A push with no resolvable remote peer id reports nothing. The sink is a new optional `onBlockHolders` on `BlockTransferServiceComponents`, so directly-constructed services (the three existing block-transfer specs) are untouched.

**The reconcile.** `createReconcileBlock` gained an optional `onBlockHolders` dep and calls it with `selected.supporters` after `saveReplicatedBlock` resolves, beside the `reconcile:restored` log. Both decline paths `return` above it. `libp2p-node-base` hands the same closure instance to `ClusterMember` as `reconcileBlock` and to `CoordinatorRepo` as `acquireBlockFromCohort`, so this one change covers both the commit-path reconcile and read-repair acquisition.

**The wiring.** `blockHoldersTarget` and the `onBlockHolders` closure over it moved from inside the post-`createLibp2p` block up to just below `resolveClusterPolicy`, above `const libp2pOptions` — the `blockTransfer` service factory lives inside `libp2pOptions` and is evaluated at `createLibp2p`, so nothing declared below it is in scope. They close over nothing, so the move was mechanical; `createReconcileBlock` did **not** need to move, since it already sits below that point. Both monitors stay late-bound: on a node with rebalance or FRET off, `blockHoldersTarget` is never assigned and every report falls on the floor, which is the existing contract.

**The rename.** `recordCommittedHolders` → `recordBlockHolders`, `CommittedHolders` → `BlockHolders`, `CommittedHoldersSink` → `BlockHoldersSink`, `MeshOptions.onCommittedHolders` → `onBlockHolders`, and the monitor's internal `CommitEvidence`/`commitEvidence` → `HolderEvidence`/`holderEvidence`. Two log tags moved with them: `cluster-member:committed-holders-sink-error` → `cluster-member:block-holders-sink-error`, and the coordinator's equivalent. Doc comments on the method, the interface and the sink were rewritten to state the widened premise — *these peers are evidenced to hold this block, and this node holds it too, so it needs no pull* — and to name all four producers. No consumer of these names exists outside `db-p2p` (checked across every package's `src` and `test`).

**The mesh harness** now also binds `MeshOptions.onBlockHolders` to each node's reconcile closure, not only to its member and coordinator. The push producer has no harness analogue — the harness runs no `BlockTransferService` — and the option's doc comment says so.

## Tests

| test | what it verifies |
| --- | --- |
| `rebalance-push-holders.spec.ts` → `does not push a received replica back to its sender, nor pull it again` | the ticket's measured bug, end to end: a certified push over the registered stream handler, then `checkNow()` reports neither `gained` nor `grown` for that block |
| `rebalance-push-holders.spec.ts` → `reports only the blocks the push accepted` | a two-block push where one block's proof is missing: the sink names the accepted block alone, so a refused block does not get its `gained` report suppressed |
| `reconcile-block.spec.ts` → `reports the corroborating supporters after a restore` | `selected.supporters` are reported, and a behind peer that did not corroborate is not |
| `reconcile-block.spec.ts` → `reports nothing when the pass declines` | a decline persists nothing, so it must report nothing |

The push spec drives the **registered** handler (a linked in-memory duplex pair plus a real `BlockTransferClient`), with a connection carrying the sender's peer id, because the connection threading is half of what this ticket changed — calling the private `handlePush` directly would hand the id over by fiat.

Both push tests were checked non-vacuous by commenting out the `reportSenderHolds` call: the sink assertions fail, and with the sink assertion removed the monitor-level assertion fails too, with non-empty `pulls` and `pushes` — the reproduction the ticket describes.

## Validation run

- `yarn build` (root) — clean.
- `yarn typecheck` (root, after build) — clean.
- `yarn workspace @optimystic/db-p2p test` — 3114 passing, 63 pending, 0 failing.
- `yarn test` (root, full fan-out, before the two reconcile tests were added) — all packages green, 0 failing, 6m25s.
- `yarn lint:docs` — 47 documents, all citations resolve.
- `yarn lint`, `yarn lint:deps`, `yarn check:rn`, `yarn test:integration` were **not** run.

## Known gaps, for the reviewer to weigh

- **The `gained` arm is narrowed here, not fixed.** A received replica stops being reported `gained`, but a restart still reports every block on disk `gained` and fetches each one pointlessly. That is `bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy`, which resolves at a different site. If that ticket has landed since, its assertions and this one's are worth reading against each other.
- **The "no resolvable remote peer id" branch has no test.** Deliberate: if the guard were removed the sink would be called with `holders: [undefined]`, and `carryGrowthState`'s `intersect` against the current cohort drops it on the next check — so the branch guards a contract, not an observable defect. Judged below the test bar; say so if you disagree.
- **The monotonic no-op acceptance has no test of its own.** The ticket calls it out explicitly, and the implementation honours it — `blocks[blockId] = data` is set whether or not `saveReplicatedBlock` advanced anything, so there is no branch between the two cases. It is stated in `handlePush`'s doc comment. A test would pin the *absence* of a branch someone might later add.
- **Reconcile reports `selected.supporters` verbatim, including a peer that only claimed the revision without carrying its bytes.** A supporter is a peer whose archive corroborated the `(rev, actionId)`; it need not have been the content carrier. That is the right set for "who holds this block" — a claim is that peer's own word either way, the same trust class the ticket accepts for a pusher — but it is a slightly wider set than "who we actually got the bytes from", and worth a second opinion.
- **The trust class is stated, not enforced.** A pushing peer's claim to hold what it pushed is its own word; so is a reconcile supporter's claim. The ticket weighed this and concluded the cost of a lie is bounded the same way it already was — one cohort member that does not get a copy it would otherwise get, re-detected when it leaves the cohort and rejoins or when a commit touches the block. That reasoning is recorded at `recordBlockHolders`, at `reportRestoredHolders`, and in `docs/internals.md`; no attestation was added.
- **A push acceptance reports a holder even for a block this node is not responsible for.** The monitor drops evidence for a block that is not in `trackedBlocks` at the next check, and a non-responsible block's growth state is cleared wholesale, so the evidence is inert — but the report is made unconditionally, since `handlePush` does not know the cohort. Noted rather than guarded.
- **A mid-file change in `libp2p-node-base.ts`.** The hoist moves a `let` and a closure ~400 lines up a 1900-line function. Nothing else moved, and `startup-rollback.spec.ts` / `rebalance-monitor-node-wiring.spec.ts` both still pass, but the diff is worth reading for scope rather than for content.
