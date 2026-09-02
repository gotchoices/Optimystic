----
description: When only one machine holds a piece of data, its writes are saved without the signed receipt that other machines demand before accepting a copy — so that data can never be handed to a second machine, and the first machine to create a shared workspace can never share what it wrote.
files: packages/db-p2p/src/repo/coordinator-repo.ts (commit, the `peerCount <= 1` branch and the post-consensus local fallback), packages/db-p2p/src/cluster/commit-proof.ts (buildBlockCommitProof, BlockCommitProof), packages/db-p2p/src/cluster/cluster-repo.ts (applyConsensusOperation, "Project the consensus record into a durable BlockCommitProof"), packages/db-p2p/src/storage/storage-repo.ts (persistProofIfContentMatches, backFillProof), packages/db-p2p/src/cluster/block-transfer-service.ts (handlePush, requirePushCertificate), packages/db-p2p/src/libp2p-node-base.ts (the `blockTransfer` option)
difficulty: hard
repro: verified
----

# A revision committed to a cohort of one can never be certified, so it can never be replicated

## What happens

`BlockTransferService.handlePush` refuses a pushed block that carries no verifying
`BlockCommitProof` — `requirePushCertificate` defaults to `true`, and the refusal is logged as
`push:reject-uncertified … reason=no-proof`. That default assumes every committed revision has a
retained proof. It does not.

A proof is minted in exactly one place: `ClusterMember.applyConsensusOperation` projects the
consensus `ClusterRecord` (`buildBlockCommitProof`) and hands it to `StorageRepo.commit`, which
retains it when the local materialization matches the digest the commit op declared
(`persistProofIfContentMatches`). Two commit paths in `CoordinatorRepo.commit` pass no proof at all:

- the **solo-cohort short-circuit** — when `getClusterSize(blockId)` returns `<= 1`, the commit goes
  straight to `this.storageRepo.commit(request, options)`, bypassing consensus entirely;
- the **post-consensus local fallback** — the `storageRepo.commit(request, options)` this method
  runs when the local member did not execute during consensus.

`backFillProof` cannot rescue either: it can only retain a proof that already exists, and for a
solo commit no cohort ever signed anything. The revision is **permanently uncertifiable** — the
signatures it would need were never produced and cannot be produced after the fact.

## Why it matters

Every workspace starts on one machine. A founder writes its whole store while it is the only holder
— cohort of one on every block — then a second machine joins. Under the strict default, none of the
founder's blocks can ever be pushed to the joiner: the joiner refuses all of them for want of a
receipt that will never exist.

The same wall stands in front of `BlockTransferCoordinator.confirmReplicated`: a block that cannot
be pushed is never confirmed replicated, so a rebalance never releases it, and a ring shift's
confirm phase (`docs/arachnode-ring-handoff.md` § Phase B) aborts on it. The `blockTransfer`
option's own documentation frames this as a **migration** backlog — blocks written before proofs
existed. The measurement below shows it is not only migration: current code keeps producing
uncertifiable blocks wherever a write lands on a cohort of one, which is every solo device and every
newly founded workspace.

## Measurement (2026-09-01, verified)

Driven from the sibling `sereus` checkout — two real `CadreNode`s over libp2p, one founding a strand
and one joining. For every block in each node's raw store, `getBlockProof(blockId, latest.rev)`:

| stage | blocks holding a retained proof |
| --- | --- |
| founder, after strand bootstrap (solo) | **0 of 18** |
| founder, after the joiner attached and a further write landed | **0 of 21** |
| joiner's own store | 0 of 3 |

`CoordinatorRepo` logged `cluster-fetch:solo-self-skip` 140 times across that run — a cohort of one
for every block, so consensus never ran and no proof was ever minted.

In the fuller `strand-membership-closed-strand-e2e` scenario (real membership flow, more writes) the
sender offers 15–21 blocks per peer and the receiver accepts 3, rejecting the rest; **every** one of
the 74 rejections observed carried `reason=no-proof`.

## Direction (decided)

Maintainer's call, 2026-09-01: **mint a real proof on the solo path** rather than weakening the
receiver.

A cohort of one is still a cohort. When `CoordinatorRepo.commit` takes the `peerCount <= 1` branch,
the coordinator should produce a `BlockCommitProof` over a one-peer membership — `v: 1`,
`membershipVersion: 2`, `peerIds: [self]`, the commit `RepoMessage` it is about to apply, and its
own promise-round and commit-round signatures over the same hashes a multi-peer cohort would sign —
and pass it down the existing `ICommitProofPersister` argument. `persistProofIfContentMatches` then
retains it under the same digest-match rule as every other commit, and nothing on the receiver
changes: `certifyContent` verifies a one-signer cohort exactly as it verifies ten, because both
thresholds are satisfied by 1 of 1.

The artifact stays honest about what it asserts — "one peer, which was the whole cohort at the time,
committed these bytes at this revision" — and it remains offline-verifiable from the peer id alone,
like every other proof.

The two alternatives were weighed and not chosen: relaxing `requirePushCertificate` moves the trust
decision onto every embedder (and in `sereus` today, strand nodes wire no inbound stream
authorization at all, so the certificate is the only thing standing between an arbitrary dialer and
a member's block store); and an authorization-hook escape on the receiver leaves the uncertifiable
blocks uncertifiable, merely tolerated.

## Edge cases & interactions

- **The post-consensus local fallback** (the second no-proof site). It runs where consensus already
  happened elsewhere, so a self-signed one-peer proof would be a *false* statement about that
  commit's cohort. Decide it explicitly: either leave it unproven (and accept that those revisions
  stay uncertifiable until a later commit or a repair supersedes them) or thread the record's real
  proof to it. Whichever way, say so at the site.
- **Growth from one to many.** A block that has a one-peer proof at rev 3 and a full-cohort proof at
  rev 4 must verify at both. Nothing keys retention to cohort size today; confirm that stays true.
- **A stale one-peer proof.** A node that was briefly alone (peers unreachable, not absent) mints a
  one-peer proof for a revision the rest of the cohort never saw. That is the same divergence a solo
  commit already creates today — this ticket makes it *certifiable*, which is arguably worse than
  uncertifiable, since a receiver now accepts it. Weigh whether the verifier should distinguish a
  one-signer proof from a threshold proof at the *acceptance* boundary (e.g. accept it for
  replication but never let it win a corroboration contest against a multi-signer proof).
- **`MAX_PROOF_SIGNERS` / size.** A one-peer proof is the cheapest possible; no new bound needed, but
  confirm the size test still pins the multi-peer figure rather than a min.
- **Verification cost on the push path** is per-proof; a founder's whole store now arrives *with*
  proofs where it previously arrived with none, so a joiner's first catch-up does real signature
  work per block. Measure it on the `sereus` catch-up scenario before assuming it is free.
- **Existing uncertifiable blocks** — every store written before this lands still holds them. This
  ticket does not migrate them; say plainly in the handoff whether operators need the
  `requirePushCertificate: false` window to clear that backlog, or whether a rewrite-on-commit path
  eventually supersedes them.

## Verification

The failing scenario lives in the sibling repo, so it is evidence rather than a gate here:

```
cd ../sereus/packages/integration-tests
yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts
```

Two tests ("replicates the founder's blocks PHYSICALLY into the joiner's own block store" and
"serves the strand's founding membership from the joiner alone after the founder stops") fail
deterministically today with the catch-up gap. In-repo, the proof-retention rule wants a unit test
that a solo-cohort commit leaves a proof `certifyContent` accepts for the exact `(blockId, rev,
actionId)` it committed.
