description: When a node copies the blocks of one large commit to another machine, it sends the commit's signed proof again with every block, and that proof lists every block of the commit, so copying a commit costs bandwidth that grows with the square of its size. Send each proof to a peer once.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferRequest.blockProofs`, `pushBlockToPeers`, `sourceBlockCertification`, `handlePush`), packages/db-p2p/src/cluster/block-transfer.ts (`BlockTransferCoordinator`), packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/storage/block-archive.ts (`serveBlockArchive`, `fitConsultContent`, `servableProof`), packages/db-p2p/src/storage/struct.ts (`ArchiveRevisions`)
tradeoffs: The cost lands only on the copy paths (cohort growth, rebalance, spread on churn, the under-replication drain, repair archives), not on commits, and only for commits that touch many blocks; batching pushes by commit changes the per-block retry and confirmation accounting every sender shares, which is a lot of surface for a cost most deployments never see.
----
# A commit proof crosses the wire once per peer

Split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60), which fixed the same quadratic in storage and left the wire as it was.

## What happens

Every replication push carries one block (`pushBlockToPeers` in `packages/db-p2p/src/cluster/block-transfer-service.ts`; all three senders go through it) and attaches that block's `BlockCommitProof` in `blockProofs`. The proof carries the commit message verbatim, which lists every block id and declared digest of the commit. So copying all N blocks of one commit to one peer sends N copies of a proof whose size is linear in N. From the reporter's numbers, not measured on the wire: one 528 KB proof covered 3,383 blocks, so pushing that commit to one new peer would send about 1.7 GB of proof alongside its blocks. The obvious trigger is the cohort-growth push: a solo node that bulk-imported, then adds a second machine, pushes every block. Repair archives have the same shape: `ArchiveRevisions` carries the proof inside each revision entry, and a consult answering several blocks of one commit (`fitConsultContent` in `packages/db-p2p/src/storage/block-archive.ts`) repeats it per block.

## What cannot be done

Cutting the proof to what one block's claim needs. The promise and commit signatures cover the whole message (`computeClusterMessageHash`, `computeClusterCommitHash` in `packages/db-core/src/cluster/membership.ts`); signing a per-block structure instead (a Merkle root over `blockDigests`, say) changes the signed preimage, which invalidates every stored proof and breaks every cohort running two builds — the internals doc rules that out under *Both consensus rounds carry the coordinator's own member's vote*.

## Expected behavior

A peer receives a given proof once per copy session rather than once per block, for both pushes and repair answers, with no change to what a receiver verifies or stores (the receiver already stores the proof once since `a-commit-proof-is-stored-once-not-once-per-block`). Candidate shapes to weigh in plan: group a sender's pushes by `messageHash` into multi-block requests under the frame limit, with a request-level `proofs` map and per-block references; or send a reference first and the proof only when the receiver answers that it lacks it. Either has to keep the per-block certification and per-block `missing` accounting that rebalance confirmation, ring-shift release and the drain rely on.
