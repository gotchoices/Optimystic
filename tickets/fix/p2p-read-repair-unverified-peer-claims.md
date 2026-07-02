----
description: When a node repairs or restores a block, it trusts whatever version number peers claim without any proof, so a single lying peer can push a node to accept bogus or wrong content.
files: packages/db-p2p/src/repo/coordinator-repo.ts (queryClusterForLatest / fetchBlockFromCluster ~265-326), packages/db-p2p/src/libp2p-node-base.ts (reconcileBlock / saveReplicatedBlock ~577-600)
difficulty: hard
----

# Read-repair and reconcile trust unverified peer claims to drive restoration

## The problem

Two restoration paths act on peer-reported revision numbers with no
authentication:

- `queryClusterForLatest` (`repo/coordinator-repo.ts:265-326`) takes the maximum
  `ActionRev` any peer reports — with no signature or commit-certificate check —
  and `fetchBlockFromCluster` restores against it. A single lying peer can steer
  spurious restoration and get its content accepted.
- `reconcileBlock` (`libp2p-node-base.ts:577-600`) similarly picks
  `Math.max(revs)` across cohort archives and calls `saveReplicatedBlock` with no
  content verification, so a malicious cohort member can seed bogus replicas.

## Expected behavior

A reported "latest" must be backed by verifiable evidence before a node restores
or replicates against it. An unverifiable claim must not drive restoration or
content acceptance.

## Suggested-fix hint

Verify the reported latest against a commit certificate before restoring (the
`CommitCert` machinery already exists), or require multi-peer agreement plus a
content-hash validation of the fetched block against the committed `actionId`.

## Interactions to cover
- A minority of lying peers reporting an inflated `ActionRev`.
- A cohort member serving content whose hash does not match the committed
  `actionId`.
- Legitimate late/lagging peers must still be able to restore honest blocks
  (do not fail-close on honest divergence).

## TODO
- Reproduce: one peer over-reports latest → node restores/accepts bogus content.
- Add commit-cert (or multi-peer + content-hash) verification to both paths.
