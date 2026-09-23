description: When a machine notices it has become responsible for a block, its background rebalance fetches a copy of that block from another machine and then throws the copy away. It only ever does this for blocks it already stores, so the fetch is always wasted network traffic — and after a restart it does one per stored block, with no cap.
architecture: docs/arachnode-ring-handoff.md
files:
  - packages/db-p2p/src/cluster/block-transfer.ts (`pullBlocks`, `executePull`, `withTimeout`, the `restorationCoordinator` constructor parameter, `RebalanceReactionResult.pulled`, and the class doc line "For gained blocks: delegates to RestorationCoordinator.restore()")
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`RebalanceEvent.gained` — the doc phrase "the reaction pulls each")
  - packages/db-p2p/src/libp2p-node-base.ts (the rebalance wiring: the `BlockTransferCoordinator` construction, the `for (const blockId of event.gained) ownedBlocks.add(blockId)` line and the comment above it)
  - packages/db-p2p/src/storage/ring-shift-coordinator.ts (`RingShiftCoordinator` class doc and `moveIn` — both say the gained half is pulled by the restoration/rebalance path)
  - packages/db-p2p/test/block-transfer.spec.ts (the `pullBlocks` describe block, and the `handleRebalanceEvent` cases asserting on `restoreCalls`)
  - packages/db-p2p/test/rebalance-committed-holders.spec.ts (`transfersOf` reads `event.gained` as "a pull per gained block")
  - docs/internals.md (§ RebalanceMonitor → Holder evidence; § Gated release; § RingShiftCoordinator move-in)
  - docs/arachnode-ring-handoff.md ("Move-in needs no release phase", and the `block-transfer.ts` entry under "Key code sites")
repro: verified
difficulty: easy
----

# What is wrong

A node's background rebalance watches which blocks it is responsible for. When it becomes responsible for a block it reports that block `gained`, and the reaction fetches a copy of the block from another machine over the `/db-p2p/sync` protocol — then drops what it fetched on the floor. Nothing is written to storage.

The fetch can never be useful, because the set of blocks the rebalance monitor watches is built entirely from what this machine already stores. So a block reported `gained` is always a block this machine already has: the fetch cannot supply a missing block, and since nothing is saved it cannot refresh a stale one either.

# Why the watched set can only contain blocks this node holds

`RebalanceMonitor` iterates `trackedBlocks`, which on a live node is the shared `ownedBlocks` set wired in `libp2p-node-base.ts`. Exactly three things add to it, and no caller of `RebalanceMonitor.trackBlock` exists outside tests:

- `storageRepo.onAnyCollectionChange` — fires when a block becomes durably committed or is received as a replica on this node.
- `seedOwnedBlocksFromStorage` — enumerates the ids already on disk at startup.
- the rebalance handler's own `for (const blockId of event.gained) ownedBlocks.add(blockId)`, which cannot introduce a new id because `gained` is a subset of the set being iterated.

All three mean "this node stores it". The comment above the third claims a gained block "is added immediately so it is tracked even before its next commit/replica touches the feed"; that is not true, and the line is a no-op.

# What it costs

Two shapes, both verified by running them:

- **Every restart.** `responsibilitySnapshot` and `holderEvidence` are per-monitor in-memory state, so a restarted node has no memory of what it was responsible for. The startup storage scan fills `trackedBlocks` with every stored block, and the first check then reports all of them `gained`. Each one starts a `RestorationCoordinator.restore` walk, which asks ring peers one at a time over `/db-p2p/sync` until one answers. With 200 stored blocks the check reported 200 `gained` — and 64 `grown`, because `growthBlockBudget` caps the growth arm and nothing caps this one.
- **Every gain, at any time.** A block whose cohort changes so that this node re-enters it is fetched and discarded the same way.

The `rebalance-pushes-freshly-committed-blocks-back-to-members-that-hold-them` ticket and its follow-up `received-replicas-report-their-source-as-a-holder` both landed, so a block that arrives by commit, by push or by repair now carries holder evidence and is suppressed from `gained` at the next check. Neither covers the restart case: a block read off disk at startup has no evidence, and there is nowhere for that evidence to come from.

# What the fetch would have to become to be worth keeping, and why it should not

For the fetch to help, two things would have to be true that are not:

1. It would have to be aimed at a block this node is missing or behind on. Nothing enumerates such blocks — you cannot list what you do not have — and nothing is going to, because that is not how a missing copy is delivered here. A holder notices its cohort grew and **pushes** (the `grown` arm, `SpreadOnChurnMonitor`, `UnderReplicationDrain`); a reader that finds its own copy behind repairs it through `CoordinatorRepo` read-repair or the commit-path reconcile. Both of those run corroboration and certification rules before they persist anything.
2. It would have to persist what it got. `RestorationCoordinator.restore` verifies nothing — `queryPeer` hands back whatever archive a peer returned — which is why the only code path that persists a restore, `BlockStorage.restoreRevision`, runs `vetRestoredArchive` first and strips any commit proof the archive carried. Making the rebalance reaction persist a single peer's unverified answer would be a new, weaker repair path beside two that already exist and are careful.

So the fix is to take the fetch out, not to make it store.

# Expected behaviour after this change

- Reacting to a `gained` block makes no network call and no local storage read. A restart costs nothing on this arm, whatever the store size.
- `RebalanceReactionResult` no longer carries a `pulled` field, so nothing claims a block is "now durably held locally" on the strength of a discarded fetch.
- `RebalanceEvent.gained` stays, and stays honest: it reports that this node has become responsible for a block it already holds. Nothing acts on it; it is a signal for logs and for the monitor's own bookkeeping.
- A node that gains responsibility for a block it does **not** hold still receives it — by a holder's growth push, or by repair on first read. That is unchanged, because it was never the fetch doing it.

# Leave a note where the hook used to be

The one thing removal gives up is a place to hang a pull if `trackedBlocks` ever starts carrying blocks this node does not hold (a declared-placement feed, for instance). Record that as a `NOTE:` at the `gained` handling site rather than as a ticket, and say in it that such a pull would have to persist what it fetches and would therefore belong with the corroborating repair paths in `cluster/reconcile-block.ts`, not here.

# Reproduction

Two observations, both run against the current tree:

- A `RebalanceMonitor` given a `trackedBlocks` set of 200 ids and no holder evidence — the shape `seedOwnedBlocksFromStorage` leaves after a restart — returns an event with `gained.length === 200` and `grown.size === 64`.
- A `BlockTransferCoordinator` over a repo that already holds `held-1`, handed `{ gained: ['held-1'] }`, calls `restore('held-1')` once, returns `pulled: ['held-1']`, and never calls `saveReplicatedBlock`.

The second is the one to pin, inverted, in `packages/db-p2p/test/block-transfer.spec.ts`: the reaction must make **no** restoration call for a gained block. The first needs no new test — the change does not alter what the monitor reports, and `rebalance-monitor.spec.ts` already covers gained detection.

# Also settled here, so it does not get re-asked

The source ticket carried a 2026-09-17 observation from the sereus repository: after the first `Message` insert of every run, node A opened 27 `/db-p2p/block-transfer` streams, in 7 of 7 no-delay runs and in none of the delayed run. Two things about it:

- Those are **push** streams (the `grown` arm), not the fetch this ticket removes. Removing the fetch will not change that count.
- The measurement predates the holder-evidence work by six days. A collection's first commit is an ordinary commit: it reaches `CoordinatorRepo.commit`, which reports its holders through `acknowledgeCommit` → `reportBlockHolders` for every block in `request.blockIds`, and each cohort member reports its own after a durable apply. Creation does not go down a path that skips the report. The only way a first commit reports nothing is a solo cohort, which is deliberate.

What could still produce those pushes is already recorded as a tripwire at the site — the `NOTE:` in `RebalanceMonitor.performRebalanceCheck` saying a block enters `trackedBlocks` at storage apply while its evidence arrives only after the durable verdict, so a check landing in that window reports it `gained` and `grown` anyway. That note names its own revisit condition: "if relay traces show post-commit transfers surviving". The 2026-09-17 trace cannot satisfy it, because it was taken before the evidence path existed. Nothing should be filed on it; ask sereus for a remeasure on a build that includes these commits, and only then re-read that note.

# TODO

- Delete `pullBlocks` and `executePull` from `BlockTransferCoordinator`, along with `withTimeout` (they are its only caller) and the `restorationCoordinator` constructor parameter.
- Drop the `pulled` field from `RebalanceReactionResult` and the gained/fetch half of `handleRebalanceEvent`, including the pull counters in the `rebalance:start` / `rebalance:done` log lines. Keep `event.gained.length` in the start line if it is still worth logging, but stop describing it as a transfer.
- Update `BlockTransferCoordinator`'s class doc: it opens with "For gained blocks: delegates to RestorationCoordinator.restore()". Replace that with what the class now does — confirm lost blocks replicated, and push grown blocks.
- Add the `NOTE:` described under "Leave a note where the hook used to be".
- In `libp2p-node-base.ts`: drop `restorationCoordinatorV2` from the `BlockTransferCoordinator` construction (it stays in use as `newRestoreCallback` for `BlockStorage` — do not remove it), remove the `ownedBlocks.add(event.gained)` line, and correct the comment block above the handler, which describes the reaction as "pull gained / push lost" in three places and claims a gained block is added to the set "before its next commit/replica touches the feed".
- Correct `RebalanceEvent.gained`'s doc in `rebalance-monitor.ts`: it says "the reaction pulls each". Say instead that it is a responsibility signal for a block this node already holds, and that no transfer follows.
- Correct `RingShiftCoordinator`'s class doc and `moveIn`: both say a move-in "pulls the gained half via the restoration / rebalance path", which was never true. What actually delivers the gained half is the existing holders' own growth push (their cohort grew to include the mover) plus repair on first read. The "Move-in needs no release phase" paragraph in `docs/arachnode-ring-handoff.md` says the same thing and needs the same correction.
- Tests: replace the `pullBlocks` describe block in `block-transfer.spec.ts` with one regression that the reaction makes **no** restoration call for a gained block, and adjust the `handleRebalanceEvent` cases that assert `restoration.restoreCalls` contains the gained block. `MockRestorationCoordinator` can stay as the "no call was made" witness.
- `rebalance-committed-holders.spec.ts`'s `transfersOf` helper labels `event.gained` as `pulls`. Re-label it so the spec says what it now measures (a responsibility report, not a transfer). Its assertions — that a seeded commit produces neither a report nor a push — are still the right ones and should not change in substance.
- Update `docs/internals.md` in three places: § RebalanceMonitor → **Holder evidence** ("the next check would report it `gained` (a pull over `/sync`)"), § **Gated release** (the `{ pulled, released, … }` result shape), and § RingShiftCoordinator move-in. Also the `block-transfer.ts` entry under "Key code sites (implemented)" in `docs/arachnode-ring-handoff.md`, which lists the same result shape.
- Run `yarn build`, then `yarn workspace @optimystic/db-p2p test` and `yarn lint:docs` from the root — the test harness refuses a stale build.
