description: When one machine asks another what it holds of a block, the answer sends back a signed commit receipt for a version the asker already has — and therefore already has the receipt for. Let the asker say which receipt it holds so the answer can leave it out.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/sync/protocol.ts (`SyncRequest.held`), packages/db-p2p/src/storage/block-archive.ts (`serveConsultAnswer`, `askerHoldsServed`), packages/db-p2p/src/repo/coordinator-repo.ts (`queryClusterForLatest`)
tradeoffs: The saving only shows up on the steady-state consult — a quiet host re-reading its views — where the answer is already small, and it means the asker's own stored receipt, rather than the answering machine's copy, becomes the evidence behind that machine's claim; a maintainer may reasonably prefer not to blur who supplied the evidence for a saving that only matters on commits touching thousands of blocks.
----
# A consult answer omits a proof the asker already holds

Parked out of `feat-a-consult-answer-carries-each-commit-proof-once`, which deduped proofs *within* one answer and left this across-answers case alone.

## What happens

A latest-revision consult tells each peer what the asker holds of every block it asks about (`SyncRequest.held`). When a peer's own revision is at or below that, `serveConsultAnswer` leaves the block's bytes out (`contentOmitted: 'held'`) but deliberately keeps the commit proof for the revision it serves — and that revision is, by definition of this branch, one the asker already holds. An asker that holds the revision and landed it through any certified route already holds that proof, filed under the same message hash. So the steady-state consult — a host reloading its views every 15 s, past the read-repair window, consulting the cohort each time, every member answering "held" — re-sends the asker proofs it already has, once per member per block, every reload. The cost scales with the proof, which scales with the commit's block count.

## What would change

The asker says, per block, which proof it holds for its `held` revision — the message hash is all that is needed. A peer whose served `(rev, actionId)` equals the asker's held pair, and whose own proof for it has that same hash, answers with the claim and no proof. The asker, reading an answer with no proof for a revision it does hold, substitutes its own stored proof before judging the claim.

## Why this is not obviously free

The substitution changes who supplies the evidence behind a "certified claim" in `CoordinatorRepo.queryClusterForLatest`. The argument that it is sound: a proof certifies `(blockId, rev, actionId)` and nothing else — it never was evidence that *this particular peer* holds that revision, which is exactly what `verifyBlockCommitProofClaim`'s "what a passing verdict does not say" section states. The peer's assertion is "I hold this pair"; the proof's content is "the cohort committed this pair". Those are independent, so taking the second from the asker's own store does not weaken the first. The counter-argument is that it makes the certified-claim path read less obviously, and a future change that *did* start treating proof presence as peer evidence would break silently.

Worth settling on the evidence of a measurement: how many bytes a quiet node actually spends on repeated held-answer proofs, which the existing proof-size specs (`test/commit-proof.spec.ts`, `test/block-archive-proof.spec.ts`) give the per-proof half of.
