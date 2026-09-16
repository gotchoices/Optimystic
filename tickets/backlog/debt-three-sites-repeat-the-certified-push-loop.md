description: Three separate places in the peer-to-peer layer each contain their own copy of the same routine for sending a block to another machine, so a fix or a policy change has to be made three times and is easy to miss once.
files:
  - packages/db-p2p/src/cluster/block-transfer.ts (`BlockTransferCoordinator.executePush` and `BlockTransferCoordinator.executeConfirm`)
  - packages/db-p2p/src/cluster/spread-on-churn.ts (the spread loop inside the monitor's check)
  - packages/db-p2p/src/cluster/block-transfer-service.ts (`sourceBlockCertification`, `BlockTransferClient.pushBlocks` — the shared pieces the three already agree on, and where a shared loop would live)
tradeoffs: The three copies are not identical — each carries its own retry, timeout and diagnostic policy — so a single helper needs enough parameters that it may not read as simpler, and a maintainer might reasonably prefer three readable loops to one configurable one.
----

# The duplication

Sending a block to another machine always takes the same four steps: read the block from local storage; build its certification (revision metadata plus the retained cohort proof, via `sourceBlockCertification`); call `BlockTransferClient.pushBlocks`; and treat a response that lists the block as missing as a failure rather than a success, because the receiver only omits it from `missing` after it has actually persisted it.

That sequence is written out three times:

- `BlockTransferCoordinator.executePush` — the lost-block handoff, pushing until one new owner accepts.
- `BlockTransferCoordinator.executeConfirm` — the release gate and the cohort-growth arm, pushing until a floor of distinct owners confirm.
- `SpreadOnChurnMonitor`'s spread loop — the churn-resilience push, with its own per-target dial and response deadlines.

They differ in their retry shape, their stopping condition, and their diagnostics, but the read-certify-push-interpret core is the same in all three. The response-interpretation step in particular is a correctness detail: each copy carries its own comment explaining why a non-throwing round trip is not proof the replica landed. Three copies of a subtle rule is three chances to get it wrong.

# Why it is worth collecting

Any change to how a block is placed has to be made in three places today. Two concrete examples already in the tree: the certified-push policy (a receiver refusing an uncertified block) had to be reasoned about separately in each copy, and each copy has its own note about what a `missing` entry in the response means.

`under-replication-drain-and-full-replication-event` would have made it four. That ticket instead extracts a shared helper — `pushBlockToPeers`, beside `sourceBlockCertification` — and uses it, converting the `BlockTransferCoordinator` copies where they fit. Whatever it could not convert is what this ticket is about, and the helper it leaves behind is the target to converge on.

# What "done" looks like

Every site that sends a block to another machine goes through one helper for the read-certify-push-interpret core, with retry, stopping condition and deadlines as its parameters. A `NOTE:` at any site deliberately left out says why, rather than leaving a reader to guess whether it was missed.
