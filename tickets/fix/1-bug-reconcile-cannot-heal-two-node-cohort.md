----
description: A node that is missing data now correctly asks its peers to send it, but the repair requires two peers to independently supply the same content — so in a two-node group, where only one other peer exists, the repair always declines and the node stays empty.
files: packages/db-p2p/src/libp2p-node-base.ts (reconcileBlock, fetchArchiveFromPeer), packages/db-p2p/src/cluster/quorum-restore.ts (selectQuorumBlock), packages/db-p2p/src/cluster/cluster-repo.ts (reconcileDivergentCommit)
difficulty: medium
----

# Reconcile's content quorum still requires two block-carriers, so two-node cohorts cannot heal

Continuation of `bug-member-commits-unmaterializable-revision` (fixed, `d6a22d2`). That fix
stopped a member recording a revision it cannot materialize, and routes the refusal to
`reconcileDivergentCommit` so the node pulls what it is missing. The implementer flagged, from
code reading, that the pull itself may still decline in exactly the cohort size that needs it:

> Reconcile's content quorum needs two block-carriers, so in the trace's exact two-node cohort
> the heal may still decline. Pre-existing; probably the next thing the embedder hits.

**This is a `fix/` ticket, not `implement/`: reproduce it before changing anything.** Two
previous root-cause claims on this same convergence failure were confidently reasoned from code
and log shape, and both were wrong. Get a failing test first.

## Evidence that something is still wrong

The downstream scenario (`control-db-two-node-convergence` in the sibling `sereus` repo) still
fails with `d6a22d2` built and active, after both prior fixes (`50af693`, `d6a22d2`) landed.
That is an observation, **not** proof this ticket's mechanism is the cause — establishing that
is the job.

## What to do

1. **Reproduce at the unit level.** Drive `reconcileBlock` on a node missing a block, in a cohort
   with exactly one other peer that holds it. Assert what actually happens. If it heals, this
   ticket's premise is wrong — say so, close it, and look elsewhere.
2. **If it declines**, establish precisely where. `selectQuorumBlock` in
   `quorum-restore.ts` is the prime suspect: unlike `quorumSize`, which commit `50af693` capped
   by the number of peers that could actually corroborate, the content gate was deliberately left
   on the strict floor. That commit's message says so explicitly — removing the old fallback
   "changes nothing observable there (its `selectQuorumBlock` content gate already required two
   block-carrying corroborators with no relaxation), so a two-member cohort could never reconcile
   before and still cannot."
3. **Then decide whether relaxing it is right**, and apply the same reasoning `50af693` used for
   `quorumSize`: cap the requirement by how many peers could possibly supply the content, using
   `max(observed peers excluding self, clusterSize − 1)` so an unauthenticated `findCluster` view
   cannot be shrunk by an attacker to talk the requirement down to one.

   Note the asymmetry that makes this *less* dangerous than it first looks, and confirm it before
   relying on it: a content block is content-addressed, so a peer supplying block bytes for a
   given block id cannot substitute different content without the id changing. If that holds,
   requiring two independent carriers buys much less than requiring two independent *revision
   claims* did, and relaxing it at small cohort sizes is close to free. **Verify this rather than
   assuming it** — check whether the id is actually re-derived and checked from the received bytes
   on the receive path, or merely trusted from the response envelope.

## Edge cases

- Single-node cohort: must not attempt a fetch, must not error.
- No peer holds the block: must decline cleanly and remain retryable, not wedge.
- Peer supplies content whose hash does not match the requested id: must reject, and must not
  count toward any quorum.
- Repeated failed reconciles must not spin hot.

## TODO

- [ ] Reproduce the decline in a unit test, or disprove the premise and close.
- [ ] Confirm whether received block content is hash-verified against the requested id.
- [ ] If relaxing, mirror the `corroboratorCapacity` shape from `50af693` rather than inventing another.
- [ ] Re-run the downstream two-node scenario and report whether it converges — that, not the unit test, is the real acceptance signal.
- [ ] Full `db-p2p` suite green (baseline 1345 passing / 0 failing) and root `yarn lint` clean.
