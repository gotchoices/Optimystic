description: Three separate places in the peer-to-peer layer each contained their own copy of the same routine for sending a block to another machine; all three now go through one shared routine, and only their differing log lines remain per site — this ticket records that and asks for the closing decision.
files:
  - packages/db-p2p/src/cluster/block-transfer-service.ts (`pushBlockToPeers`, `PushBlockOutcome`, `PushBlockOptions` — the shared loop)
  - packages/db-p2p/src/cluster/block-transfer.ts (`BlockTransferCoordinator.executePush` and `executeConfirm`, converted)
  - packages/db-p2p/src/cluster/spread-on-churn.ts (the spread loop, converted)
  - packages/db-p2p/src/repo/under-replication-drain.ts (the fourth sender, built on the helper from the start)
tradeoffs: The three callers still carry their own log lines for the same outcomes (`push:peer-error` / `push:fail` / `push:unreachable` say one thing three ways), and folding those into the helper would trade a greppable per-monitor namespace for one shared one — a maintainer might reasonably prefer to leave the diagnostics where they are.
----

# What was duplicated

Sending a block to another machine always takes the same four steps: read the block from local storage; build its certification (revision metadata plus the retained cohort proof, via `sourceBlockCertification`); call `BlockTransferClient.pushBlocks`; and treat a response that lists the block as missing as a failure rather than a success, because the receiver only omits it from `missing` after it has actually persisted it.

That sequence was written out three times — `BlockTransferCoordinator.executePush`, `BlockTransferCoordinator.executeConfirm`, and the spread loop in `SpreadOnChurnMonitor` — each with its own comment explaining why a non-throwing round trip is not proof the replica landed.

# What `under-replication-drain-and-full-replication-event` did about it

It extracted `pushBlockToPeers` beside `sourceBlockCertification` in `block-transfer-service.ts` and converted **all three** existing copies to it, then built the drain (the would-be fourth copy) on it:

- `executePush` calls it with `stopAfterConfirmed: 1` ("until one new owner accepts"), `executeConfirm` with `stopAfterConfirmed: floor`. Both pass `transferTimeoutMs` as the client's per-peer dial and reply deadlines instead of the old `withTimeout` race, which had left the dial running after resolving `undefined`; the timeout now aborts the dial and tears down a silent stream. Worst-case per-peer wait is therefore two deadlines rather than one — noted on `BlockTransferConfig.transferTimeoutMs`. `withTimeout` remains for the pull (restore) path only.
- The spread loop passes its two per-target deadlines through unchanged and keeps its `unavailable` (keep tracked) versus `no-local-data` (untrack) distinction, which the helper's outcome now carries as two separate statuses.
- The helper logs nothing per peer. Each caller keeps its own log lines and namespace (`block-transfer`, `spread-on-churn`, `under-replication-drain`) so existing log-based diagnostics and the `docs/debugging.md` rows stay true.

The helper's interpretation rule, stopping condition and the two nothing-pushed outcomes are pinned in `block-transfer.spec.ts` ("pushBlockToPeers (the one push loop)").

# What remains, and the decision

Nothing of the duplicated core remains. What is left is cosmetic: the three callers describe the same three outcomes (confirmed, receiver refused, unreachable) with differently named log tags. Folding those into the helper under one namespace would lose the per-monitor filterability the debugging doc relies on, so it was deliberately not done.

Close this ticket at the next gardening pass unless a reader wants the log tags unified as well; in that case the work is a rename across the three `log(...)` sites and the corresponding rows in `docs/debugging.md`, nothing more.
