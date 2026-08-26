----
description: A machine copies its data to others when it loses responsibility for it, but never when new machines simply join and become co-responsible — so anything written while a deployment was one machine keeps exactly one copy forever, and no later machine can ever read it. Make a machine push copies of what it holds to peers that newly share responsibility for it.
prereq:
files: packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts
difficulty: hard
----

# Make the second copy, instead of teaching the reader to trust one

From `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). This is the
behavioural fix. Its sibling `name-the-single-holder-deadlock` is the diagnostics half; the two are
independent and may land in either order.

## The defect in one sentence

Block repair requires two cohort peers to agree, a block with one holder can only ever produce one
claim, and both mechanisms that could create a second holder consume that same repair decision — so a
singly-held block stays singly-held and stays unreadable by anyone but its holder, permanently.

Reproduced end-to-end against a real `CoordinatorRepo` + `createReconcileBlock`: with a 3-peer cohort
where one peer holds the block and the other affirmatively answers "I hold nothing", the reader
declines on every pass and never acquires the block — under an honest `assumedClusterSize: 3` and
under the unconfigured default alike. Full numbers are in the sibling ticket.

**This state is produced by growth, not by misconfiguration.** Anything committed while the
deployment was one node has one holder; the cohort that later derives for that key has three. A
deployment's founding records — schema, genesis, the first collection headers — are exactly the data
every later joiner must read, and exactly the data that is stranded. `clusterPolicy.assumedClusterSize`
cannot express "this block has one copy", so there is no configuration workaround.

## Why this is the fix rather than relaxing the read

The fix ticket weighed four directions. Three were rejected on measured grounds:

- **Relax the corroboration floor when every non-claimant affirmatively answered "I hold nothing".**
  Rejected. It is strictly weaker than today's rule — it drops the requirement that the cohort be
  small, so a widened view of nine non-holders plus one liar also passes — and, decisively, it is
  self-amplifying: `selectQuorumRev` counts distinct peer ids voting for the same `(rev, actionId)`,
  and an acquiring reader persists via `saveReplicatedBlock`, which advances `latest`, which
  `clusterLatestCallback` then reports. One accepted forgery makes the acceptor a genuine second
  voter, and the next reader sees a real two-peer quorum. A single bad acceptance becomes permanent
  cohort-wide truth.
- **Corroborate structurally against a parent the reader already holds.** Not buildable: parents name
  children by bare id only (`BranchNode.nodes: BlockId[]` in `db-core/src/btree/nodes.ts`;
  `BlockHeader` is `{ id, type, collectionId }`). No parent carries a child revision or content hash,
  so there is nothing independent to check a lone claim against. Adding one is a data-format change of
  the same magnitude as commit certificates — and it would still not cover a collection's own header
  block, which is the case in the report, because nothing inside the data points at it.
- **Verify the claim with a commit certificate instead of counting claimants.** Correct, and still the
  only way to make a *lone* claim trustworthy — but it is `backlog/debt-read-repair-commit-cert-verification`,
  whose own prerequisite (`feat-cluster-membership-threshold-cert-anchoring`) is not built. That
  ticket already carries this evidence. It remains the sound fix for blocks **already** stranded on an
  existing deployment; this ticket stops new ones being created and heals existing ones on any
  deployment whose holder is still online when the cohort grows.

**The remaining objection to this direction does not hold.** It is usually stated as "the acquiring
node faces the same trust decision, so pushing is no safer than pulling." It does not, because the
receiving side already exists and already accepts unverified pushes from any peer:
`BlockTransferService.handlePush` (`block-transfer-service.ts:199`) decodes a pushed payload,
checks only that it parses and has a `header`, and calls `saveReplicatedBlock` with
attacker-supplied `blockMeta` rev/actionId. No cohort-membership check, no signature, and no
authorization gate by default (`libp2p-node-base.ts:443` — absent `authorizeInboundStream`, every
service constructs its gate as `undefined`). This is already pinned green by
`test/block-transfer-push-persist.spec.ts:48` and `:65`, and is a documented design position for a
public database (`docs/internals.md:859`). A holder-initiated push therefore extends **no trust that
is not already extended**; it only changes who initiates. The wider question that raises is a human's
to answer and is filed separately as
`blocked/repair-floor-defends-a-door-the-push-path-leaves-open` — it does **not** gate this work.

## What is missing

Both existing push paths are triggered by a node **losing** something:

- `spread-on-churn` (`spread-on-churn.ts`) fires on peer *departure* — its whole config vocabulary is
  `departureDebounceMs`, `expansionStep`.
- `BlockTransferCoordinator.handleRebalanceEvent` (`block-transfer.ts:125`) pulls `event.gained` and
  pushes/confirms `event.lost`.

Nothing fires when a node **keeps** responsibility for a block and a new peer becomes co-responsible
for it. That is precisely the founding case: the founder never loses the block, so it never pushes;
the joiner never had it, so it is not in anyone's `gained` set as a transfer source. The block sits
with one copy.

The receiving primitive is already there and already correct for this use: `pushBlocks` /
`confirmReplicated` in `block-transfer.ts` push to candidate owners and count how many report holding
a current replica, with per-block timeout, retry, partition guard and an in-flight de-dup key.
`confirmReplicated` deliberately ignores `enablePush` because confirmation requires pushing; note
that when reusing it.

## Shape of the work

A cohort-growth trigger alongside the existing departure trigger:

```
peer joins / FRET neighbourhood widens
  → for each block this node tracks (the shared `ownedBlocks` set already threaded through
    RebalanceMonitor and SpreadOnChurn via `trackedBlocks`)
      → which cohort peers are newly co-responsible and do NOT already hold a current replica?
      → push to them, up to the replication floor
```

Design points to settle in the implementation, not assumed here:

- **Where it belongs.** `spread-on-churn` already owns "a peer set changed, re-spread"; adding a
  growth arm there keeps one place that reacts to churn. `rebalance-monitor` already computes
  gained/lost/floor. Pick one and say why in the handoff — do not add a third module that also
  watches peer churn.
- **How "does not already hold it" is established.** `confirmReplicated` gets this for free: a push
  response that omits the block from `missing` means the target already had it or accepted it. That
  makes the naive implementation (push to every co-responsible peer) correct but chatty. Measure the
  chattiness before optimising it; do not add a holder-inventory protocol on speculation.
- **Cost control.** This must not turn every peer join into a full re-replication of a node's entire
  block set on a large deployment. Bound it — by replication floor already met, by a per-pass block
  budget, or by debounce, in that order of preference. Whatever bound you choose, `log()` what it
  dropped: a silent cap reads as "everything got replicated" when it did not.
- **Honest limitation to state in the handoff.** This heals a stranded block only while its sole
  holder is online and notices the growth. A holder that was offline for the whole growth window
  leaves the block stranded until it next runs, and a holder that is gone for good leaves it stranded
  permanently. Say so plainly; it is the residual that commit-cert verification would cover and this
  ticket does not.

## TODO

- Write the failing end-to-end test first, using `src/testing/mesh-harness.ts` or the three-peer
  harness described in `implement/name-the-single-holder-deadlock`: node A commits a block while it is
  the only node; nodes B and C join and become co-responsible; B reads the block. Assert B gets the
  content. Today it does not.
- Decide and document where the growth trigger lives (`spread-on-churn` vs `rebalance-monitor`);
  reuse `BlockTransferCoordinator.confirmReplicated` rather than writing a second push loop.
- Implement the trigger over the shared `trackedBlocks` / `ownedBlocks` set, with a bound and a log
  line naming anything the bound dropped.
- Wire it in `libp2p-node-base.ts` next to the existing churn wiring, and add the node-wiring spec
  alongside `spread-on-churn-node-wiring.spec.ts` / `rebalance-monitor-node-wiring.spec.ts`.
- Cover the negative cases: a partition in progress must not push (match the existing
  `partitionDetector` guard); a block already at the replication floor must not re-push; repeated
  growth events must not re-push the same block in a loop.
- `yarn build`, then `yarn test` from `packages/db-p2p`; `yarn lint` from root. If the change touches
  timing-sensitive churn specs, run them twice before calling them green.
- In the review handoff, state the residual honestly: which singly-held blocks this does **not** heal,
  and that `backlog/debt-read-repair-commit-cert-verification` is what covers them.
