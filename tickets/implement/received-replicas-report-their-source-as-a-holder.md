description: When a machine stores a copy of a block that another machine sent it, it should remember that the sender has that block. Today it does not, so its next background check sends the copy straight back to the sender and fetches it again — two useless transfers per copy received.
architecture: docs/internals.md#rebalancemonitor
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordCommittedHolders`, `CommittedHolders`, `CommitEvidence`, `carryGrowthState` — the holder-evidence path; today its only producers are the two commit sites)
  - packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferService.handleRequest` has the `Connection`; `handlePush` does not receive it, and must, to name the sender)
  - packages/db-p2p/src/cluster/reconcile-block.ts (`createReconcileBlock` — `selected.supporters` names the peers whose archives corroborated the revision that was restored)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`CommittedHoldersSink` is declared and exported here)
  - packages/db-p2p/src/repo/coordinator-repo.ts (the other existing producer)
  - packages/db-p2p/src/libp2p-node-base.ts (`committedHoldersTarget` and `onCommittedHolders`, declared well below the libp2p service factories that now need them)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.onCommittedHolders`)
  - packages/db-p2p/test/rebalance-committed-holders.spec.ts (the commit-side regression suite this work extends)
repro: verified
----

# A node that receives a replica must record where it came from

## The one thing that is missing

`RebalanceMonitor` decides whether to push a block to a cohort peer by asking whether it has any evidence that peer already holds it. That evidence arrives through exactly one method — `RebalanceMonitor.recordCommittedHolders` — and that method has exactly two producers today, both on the commit path: `ClusterMember` after a durable consensus apply, and `CoordinatorRepo` when it acknowledges a cohort commit.

Every other way a block can arrive reports nothing. A block received as a replica is persisted by `StorageRepo.saveReplicatedBlock`, which emits a collection change, so the block enters the node's owned-block set exactly as a committed block does — but with no evidence attached. The monitor therefore treats it as a block it has never seen: it reports the whole non-self cohort `grown` (the reaction pushes the block to each of them, including the peer that just sent it) and reports the block `gained` (the reaction fetches it again over `/sync` and then discards what it fetched — see the separate ticket `bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy`).

So the work is not a new mechanism. It is giving the existing evidence path the producers it is missing.

## Reproduction, as measured

Confirmed on a throwaway spec (since deleted) built from the pieces `packages/db-p2p/test/block-transfer-push-persist.spec.ts` already uses: a `StorageRepo` over `MemoryRawStorage`, a `BlockTransferService` over it, and a started `RebalanceMonitor` whose tracked set is fed from `storageRepo.onAnyCollectionChange` and whose `keyNetwork.findCluster` answers with self and one sender. One `handlePush` of a block from that sender, then `monitor.checkNow()`:

```
gained= [ 'block-pushed' ] grown= [ [ 'block-pushed', [ '12D3KooWBiZX1NTLkpc8qn1Zj7gSWdnPAZEeevjLLK7VnfqLcHiP' ] ] ]
```

That peer id is the sender's. The block is pushed back to the machine it came from and fetched again from the cohort.

## The three arms

**The push receiver.** `BlockTransferService.handlePush` accepts a block and persists it; the peer that sent it is on the `Connection` that `handleRequest` already holds but does not pass down. Thread it in and report the sender as a holder of each block the call *accepted* — not of a block that failed parsing, certification or persistence, which is exactly the set already excluded from `missing`. Report on every acceptance, including the monotonic no-op where `saveReplicatedBlock` finds the pushed revision already held and emits no collection change: the sender is a holder either way, and the block may already be tracked from an earlier route. A push arriving with no resolvable remote peer id reports nothing.

**The commit-path reconcile and read-repair acquisition.** Both are the one closure `createReconcileBlock` returns — `libp2p-node-base` hands the same instance to `ClusterMember` as `reconcileBlock` and to `CoordinatorRepo` as `acquireBlockFromCohort` — so one change covers both. On a successful restore (the `reconcile:restored` path, after `saveReplicatedBlock` resolves) the peers that corroborated the selected revision are `selected.supporters`, already in hand. Report those. A decline persists nothing and must report nothing: the evidence path also suppresses the `gained` report, and that suppression is only honest for a block this node now holds.

**The wiring.** `libp2p-node-base` declares `committedHoldersTarget` and the `onCommittedHolders` closure over it at a point well *below* `const libp2pOptions` — and the `blockTransfer` service factory lives inside `libp2pOptions`, evaluated at `createLibp2p`. Hoisting the two declarations above `libp2pOptions` is enough; they close over nothing, so the move is mechanical. The `createReconcileBlock` construction also sits below that point today but above the sink, so it needs the same hoist to reach it. Both monitors stay late-bound as they are now: on a node where rebalance or FRET is off, `committedHoldersTarget` is never assigned and the reports fall on the floor, which is the existing contract.

## Naming

`recordCommittedHolders`, `CommittedHolders` and `CommittedHoldersSink` are named for the only producer they had. Once a received replica and a repaired block report through the same path, the names say something untrue about half their callers. Rename them to `recordBlockHolders`, `BlockHolders` and `BlockHoldersSink` (and `MeshOptions.onCommittedHolders` to `onBlockHolders`), and rewrite the doc comments on the method and on the interface to state the widened premise: *these peers are evidenced to hold this block, and this node holds it too, so it needs no pull.* The rename is mechanical — roughly fifty identifier sites across `rebalance-monitor.ts`, `cluster-repo.ts`, `coordinator-repo.ts`, `libp2p-node-base.ts`, `mesh-harness.ts` and four specs — and the monitor's internal `commitEvidence` field and `CommitEvidence` type should move with it. If the rename collides with in-flight work on those files, widening the doc comments in place is an acceptable fallback, but do not leave the names commit-specific while the semantics are general.

## How far the evidence is trusted

A pushing peer's claim to hold the block it pushed is its own word; so is a receiving peer's report that it persisted a push, which `recordGrowthOutcome` already accepts as confirmation. The trust class is therefore unchanged by this work, and the cost of a lie is bounded the same way: one cohort member that does not get a copy it would otherwise get, re-detected whenever that peer leaves the cohort and rejoins, or whenever a commit touches the block. Worth one sentence at the new call sites; not worth a new attestation.

## What this does not close

The `gained` arm is only narrowed here, not fixed: a received replica stops being reported `gained`, but a restart still reports every block on disk `gained` and fetches each one pointlessly. That is `bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy`, which resolves at a different site. Neither ticket blocks the other; whichever lands second should re-read the other's assertions.

The restoration wire (`RestorationCoordinator` and `BlockStorage.restoreBlock`) is deliberately out of scope: it does not go through `StorageRepo`, emits no collection change, and so never puts a block in the owned set for the monitor to act on.

# TODO

- Hoist `committedHoldersTarget` and `onCommittedHolders` in `libp2p-node-base.ts` above `const libp2pOptions`, moving the `createReconcileBlock` construction (and `fetchArchiveFromPeer`, which it needs) with them if the hoist requires it.
- Rename `recordCommittedHolders` to `recordBlockHolders`, `CommittedHolders` to `BlockHolders`, `CommittedHoldersSink` to `BlockHoldersSink`, `MeshOptions.onCommittedHolders` to `onBlockHolders`, and the monitor's internal `commitEvidence` and `CommitEvidence` to match. Rewrite the doc comments to state the widened premise and to name all four producers.
- Pass the inbound connection's remote peer id from `BlockTransferService.handleRequest` into `handlePush`, and report each accepted block's sender through an optional `onBlockHolders` on `BlockTransferServiceComponents` (optional, so directly-constructed services in tests keep working). Report on the monotonic no-op acceptance too; report nothing for a block that landed in `missing`, and nothing when no remote peer id resolves.
- Add an optional `onBlockHolders` dep to `ReconcileBlockDeps` and call it with `selected.supporters` after a successful restore in `createReconcileBlock`, beside the `reconcile:restored` log. Nothing on either decline.
- Wire both new producers to the node's sink in `libp2p-node-base.ts` — the block-transfer service factory inside `libp2pOptions`, and `createReconcileBlock`'s deps.
- Extend `packages/db-p2p/test/rebalance-committed-holders.spec.ts` (or a sibling spec beside it) with the push case: deliver a push from one peer to a receiver whose monitor is fed by its own storage feed, run `checkNow()`, and assert the sender appears in neither `grown` nor `gained`. One test per behaviour — give the reconcile arm its own case only if it can be driven without mocking a module this repository owns; otherwise cover it through the mesh harness, or leave it to the push case plus the type-level wiring.
- Update `docs/internals.md` § Cluster Health Monitors → RebalanceMonitor: the "Commit evidence" paragraph now describes four producers, not two. Widen the `RebalanceEvent.gained` doc comment in `rebalance-monitor.ts` too — it says "A block first seen through a commit this node holds".
- Run `yarn workspace @optimystic/db-p2p test`, and `yarn typecheck` from the root after `yarn build`.
