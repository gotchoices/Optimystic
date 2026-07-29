description: When a node repairs a damaged block it decides how many other peers must agree before it trusts a copy, and out of the box that number is now as low as one — so a large deployment that never touched the settings can be tricked into accepting one peer's word by anything that makes the peer group look smaller than it is.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts
difficulty: medium
----

# The repair corroboration floor lost its default protection

## What happens

Both block-restoration paths — read-repair (`CoordinatorRepo.queryClusterForLatest`) and the
commit-path reconcile (`createReconcileBlock`) — require a claimed revision to be seconded by two
distinct peers before they will act on it, *unless* the peer group genuinely cannot supply two. That
"genuinely" is enforced by `corroboratorCapacity(visiblePeers, yardstick) = max(visiblePeers,
yardstick - 1)`: the requirement may only be relaxed for a group that is really small, never for one
that merely *looks* small. Peer-group views are unauthenticated (they come from a routing lookup on
the read path, and from a coordinator-supplied list on the commit path), so without that yardstick a
partition — or an attacker with routing influence — can shrink the view to one peer and have its
single unverified claim drive a repair.

Until ticket `corroboration-floor-uses-assumed-cluster-size`, the yardstick was `clusterSize`, which
defaults to 10. An unconfigured node therefore held a floor of `max(visible, 9)`: a shrunken view
gained nothing. That ticket switched the yardstick to `assumedClusterSize`, which is correct in
principle — how many peers exist is a different question from how many copies to keep — but
`libp2p-node-base` resolves `assumedClusterSize` to `minAbsoluteClusterSize` (2) when the operator
sets nothing. So every node built through `createLibp2pNodeBase` with default configuration now has a
floor of `max(visible, 1)`, i.e. one voter suffices as soon as the view is down to one peer.

Net effect: the shrunken-view protection that used to be on by default is now off by default, for
deployments of every size.

## Why this is not simply the previously-accepted tradeoff

The prerequisite ticket (`split-admission-floor-from-replication-factor`, see
`tickets/complete/`) deliberately accepted a comparable weakening for the *membership admission
gate*, on the reasoning that a large healthy network normally takes the confident measured branch and
so sits at full strength regardless of configuration; only an already-unconfident node falls back to
`assumedClusterSize`.

The corroboration floor has no such measured branch. It reads `assumedClusterSize` unconditionally,
on every repair, healthy or not. The mitigating factor that made the admission-gate tradeoff
acceptable does not exist here, so this needs its own decision rather than inheriting that one.

## What "fixed" should look like

Any of these would resolve it; the choice is the point of the ticket.

- **Two yardsticks.** Let the admission gate keep the permissive default (2) while the corroboration
  floor falls back to `clusterSize` when the operator did not state an `assumedClusterSize`. The
  fallback already exists in `CoordinatorRepo`'s constructor (`policy.assumedClusterSize ??
  policy.clusterSize`) but is dead code in practice, because `libp2p-node-base` hands it a value that
  is already defaulted to 2. Cost: a two-node mesh must configure one setting before it can
  self-repair — which is exactly the state the prerequisite ticket was trying to leave behind, so
  weigh this against that goal rather than reverting it by reflex.
- **Derive the yardstick from observation** rather than from a static default — e.g. the largest peer
  group this node has ever seen for the key. `backlog/feat-admission-floor-from-observed-cohort-high-water-mark`
  already proposes this for the admission gate; the same signal would remove the trade here too, and
  doing both at once may be cheaper than doing either alone.
- **Accept and bound it**: if the default really should stay at 2, say so at the decision site with
  the reasoning above, and consider warning at construction when `clusterSize` is much larger than
  `assumedClusterSize`, so an operator who is silently in the relaxed branch finds out.

## Expected behavior to pin in tests

Whichever direction is chosen, the pair of cases that must not both pass silently:

- A node with a large replication factor and no `assumedClusterSize`, whose peer view has been shrunk
  to one peer, must not repair from that peer's uncorroborated claim (this is what
  `'does not relax the floor when a LARGER configured cluster merely looks small'` in
  `test/coordinator-repo-read-repair.spec.ts` pins today at the `CoordinatorRepo` layer — it passes
  only because that test constructs the repo directly and so reaches the `?? clusterSize` fallback
  the real node path bypasses).
- The same assertion at the layer the real node actually uses, i.e. against the config
  `libp2p-node-base` resolves — no such test exists, which is why the regression landed unnoticed.

## Documentation already updated

The review pass that filed this ticket corrected the docs to describe the shipped behavior honestly
rather than the intended behavior: `packages/db-p2p/src/cluster/quorum-restore.ts` (caveat on the
`corroboratorCapacity` doc comment, referencing this slug), `packages/db-p2p/src/libp2p-node-base.ts`
(both the `clusterPolicy.assumedClusterSize` jsdoc and the `consensusConfig` comment),
`packages/db-p2p/src/cluster/reconcile-block.ts` (the `assumedClusterSize` dep jsdoc) and
`docs/transactions.md`. Those will need another pass once the behavior changes.
