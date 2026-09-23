description: When a machine stores a copy of a block that another machine sent it, it now remembers that the sender has that block, so its next background check no longer sends the copy straight back to the sender and fetches it again. The same memory is now also fed by a repaired block.
architecture: docs/internals.md#rebalancemonitor
files:
  - packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferServiceComponents.onBlockHolders`, `handlePush`'s `senderPeerId` parameter, `reportSenderHolds`, the hoisted `remotePeerId` in `handleRequest`)
  - packages/db-p2p/src/cluster/reconcile-block.ts (`ReconcileBlockDeps.onBlockHolders`, `reportRestoredHolders`)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordBlockHolders`, `BlockHolders`, `HolderEvidence`, `holderEvidence`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`BlockHoldersSink`; `ClusterMember.reportBlockHolders`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CoordinatorRepo.reportBlockHolders`)
  - packages/db-p2p/src/libp2p-node-base.ts (`blockHoldersTarget` / `onBlockHolders`, hoisted above `libp2pOptions`; the four producer wirings)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.onBlockHolders`)
  - packages/db-p2p/test/support/linked-duplex-pair.ts (new — `makeLinkedPair`, shared by the two stream-path specs)
  - packages/db-p2p/test/rebalance-push-holders.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts
  - docs/internals.md (§ Cluster Health Monitors → RebalanceMonitor, the **Holder evidence** block; the `handlePush` paragraph under SpreadOnChurnMonitor)
----

# Complete: a received replica, and a repaired block, report who else holds them

`RebalanceMonitor` decides whether to push a block to a cohort peer by asking whether it has evidence that peer already holds it, and whether to pull a block by asking whether it has any memory of the block at all. Before this ticket that evidence had two producers, both on the commit path, so a block arriving any other way reported nothing: the next check pushed it back to the peer it came from and fetched it again.

Two producers were added and the mechanism was renamed off its commit-specific name.

- **`BlockTransferService.handlePush`** reports the sending peer as a holder of every block it *accepted* — literally `Object.keys(blocks)`, the complement of `missing` — through a new optional `onBlockHolders` on `BlockTransferServiceComponents`. A block that failed parsing, certification or persistence reports nothing; a push with no resolvable remote peer id reports nothing.
- **`createReconcileBlock`** reports `selected.supporters` after `saveReplicatedBlock` resolves. Both decline paths return above it. `libp2p-node-base` hands one closure instance to `ClusterMember` and to `CoordinatorRepo`, so this covers the commit-path reconcile and read-repair acquisition alike.
- **The rename**: `recordCommittedHolders` → `recordBlockHolders`, `CommittedHolders` → `BlockHolders`, `CommittedHoldersSink` → `BlockHoldersSink`, `MeshOptions.onCommittedHolders` → `onBlockHolders`, `CommitEvidence`/`commitEvidence` → `HolderEvidence`/`holderEvidence`, and the two sink-error log tags.
- **The wiring**: `blockHoldersTarget` and its forwarding closure moved above `const libp2pOptions`, because the `blockTransfer` service factory lives inside it and is evaluated at `createLibp2p`. Both monitors stay late-bound; with rebalance or FRET off every report falls on the floor, which is the existing contract.

## Review findings

### Checked

The implement-stage diff was read before the handoff. Beyond it:

- **Ordering — the one thing that could have silently voided the whole mechanism.** Evidence for a block the monitor does not track is swept at the next check, so a producer reporting *before* the block enters `trackedBlocks` would be a no-op. Verified that `StorageRepo.saveReplicatedBlock` emits its collection change synchronously before resolving (that change feed is what fills `ownedBlocks`, which *is* the monitor's tracked set), and that both new producers fire after that `await`. Correct on the advancing path. On the monotonic-no-op path no change event fires, so the evidence is dropped as untracked — harmless, since an untracked block is never checked.
- **The accepted set.** Walked every early-`continue` in `handlePush`: `blocks` and `missing` are disjoint and exhaustive, so `Object.keys(blocks)` is exactly `blockIds` minus `missing`. Both `createReconcileBlock` declines return above the report.
- **`selected.supporters` provenance**, in both branches of `selectQuorumRev` (corroborated and certified): always the peer ids of responders that claimed the revision, never proof signers, and never empty on a restore (a selection requires `supporters.size >= quorum`, quorum at least 1).
- **Self, and a non-cohort sender.** Both are inert: `carryGrowthState` intersects the remembered set against the current cohort *excluding self*, so a self entry and a spread-on-churn sender outside the block's cohort are dropped at the next check.
- **The wiring.** `blockHoldersTarget` is read only at call time, so the hoist introduces no temporal-dead-zone hazard; there is exactly one `BlockTransferService`, constructed against the local `storageRepo` (not `repoProxy`); all four producers reach the one sink.
- **Rename completeness.** Grepped every package's `src`, `test` and docs for the old names — no residue outside ticket files.
- **Docs.** Read every document that touches push or rebalance (`docs/internals.md`, `packages/db-p2p/docs/repo.md`, `docs/arachnode-ring-handoff.md`, `docs/debugging.md`). Only `internals.md` carries the holder-evidence material; its `handlePush` and **Holder evidence** sections reflect the new reality. The namespace catalogue in `debugging.md` never enumerated the sink-error tags, so it needed no change.
- **Non-vacuity.** Mutation-checked both new arms independently (disabling `reportRestoredHolders`, then `reportSenderHolds`); each fails its own tests and only its own. Both mutations reverted and confirmed clean by `git diff`.

### Found, fixed in this pass

- **The `holders` contract was stated wrong.** `BlockHolders.holders` claimed "Peers evidenced to hold **the same revision this node holds**". The push producer cannot promise that: a push whose declared revision this node already holds is accepted as a monotonic no-op and still reported, so its sender is evidenced to hold *some* revision at or below this one. No behavioural consequence — the growth arm counts copies and never reads a revision — but the contract as written was false, and a future reader would build on it. Reworded the field doc to say what the evidence actually claims, with a `NOTE:` tripwire for the day the growth arm becomes revision-aware, and added the same clarification to the **Holder evidence** block in `docs/internals.md`.
- **The remote peer id was derived twice** in `BlockTransferService.handleRequest` — once for the authorization gate, once for `handlePush`. Two readings of `connection` that could in principle disagree about who is on the other end. Hoisted to one `remotePeerId` local.
- **Rename residue.** Two `mesh-harness.ts` lambdas still named their `BlockHolders` argument `committed`; `rebalance-monitor-node-wiring.spec.ts` still called the sink a "committed-holders sink".
- **A duplicated test harness.** The new push spec re-declared `makeLinkedPair` verbatim from `block-transfer-roundtrip.spec.ts` — about 25 lines of the in-memory duplex pair that models the libp2p stream shape. Two copies of that drifting apart is how a harness quietly stops modelling the stream the production code meets, so it is now `packages/db-p2p/test/support/linked-duplex-pair.ts` and both specs import it.

### Tripwires parked

- The revision-blindness of holder evidence: a `NOTE:` on `BlockHolders.holders` in `packages/db-p2p/src/cluster/rebalance-monitor.ts`, plus the prose paragraph in `docs/internals.md`. It only becomes work if the growth arm ever starts caring which revision a peer holds.

### Considered, no ticket filed

- **The `gained` residual** — a restart still reports every block on disk `gained` and pulls each one pointlessly. The site-claim grep found `tickets/fix/bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy`, which already names the `gained` arm of `rebalance-monitor.ts` and the `ownedBlocks` feed as its arms. Nothing to add to it.
- **`libp2p-node-base.ts` size** (2027 lines, `wc -l packages/db-p2p/src/libp2p-node-base.ts`) — already claimed by `tickets/backlog/debt-node-factory-wiring-steps-own-their-teardown`. This ticket's hoist moves one `let` and one closure within that function and changes nothing else; `startup-rollback.spec.ts` and `rebalance-monitor-node-wiring.spec.ts` both pass.
- **The "no resolvable remote peer id" branch has no test** — agreed with the implementer. In the registered handler libp2p always supplies a connection, and the guard protects a contract rather than an observable defect.
- **Reconcile reports `selected.supporters`, not the content carriers.** Deliberate and correct: each supporter served an archive claiming the revision that was persisted, which is a first-person holder claim of exactly the trust class this mechanism already accepts from a pusher. Not narrowed.
- **A push reports a holder even for a block outside this node's cohort.** `handlePush` cannot know the cohort, and the report is inert — the next check intersects it away. Left unguarded.

### Tests

No test was cut and none was added. The four the implementer wrote each pin a distinct contract: two are the ticket's reproductions (push and restore), two pin the honesty premise that a producer reports only what this node actually holds (a refused block in a multi-block push; a declined reconcile pass). All four fail under mutation of the code they cover. The only test-side change is the shared-harness extraction above.

## Validation run

The full `yarn check` gate, all green:

- `yarn lint` — clean.
- `yarn lint:docs` — 47 documents, 164 anchored citations, 670 file mentions, 389 links, all resolve.
- `yarn lint:deps` — constraints, 5 guarded packages on their expected majors, 944 files with every import declared.
- `yarn build`, then `yarn typecheck` — clean; plus `tsc --noEmit -p packages/db-p2p/tsconfig.json` (which covers the specs) — clean.
- `yarn check:rn` — passed (Metro 3.5s, hermesc 12.9s).
- `yarn test` (root fan-out, 12 workspaces) — 0 failing, 7m 4s; `@optimystic/db-p2p` 3114 passing / 63 pending.
- `yarn test:integration` — 0 failing, 5m 1s (44 + 1002 passing).

A first `yarn test` run failed the build-freshness guard rather than a test: the mutation-check revert touched `src` after the build. Rebuilt and re-ran; the numbers above are from the clean run.
