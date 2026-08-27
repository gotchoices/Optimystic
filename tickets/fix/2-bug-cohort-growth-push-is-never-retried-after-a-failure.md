----
description: When a machine tries to send a copy of its data to a machine that just joined, and that send fails, it is never tried again — so the copy that was supposed to fix the "only one machine has this data" problem silently never happens.
prereq:
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts
repro: static
severity: wrong-result
likelihood: normal-use
tradeoffs: Closing it means the monitor can no longer decide on its own what it has already done — it has to be told by the code that does the pushing — and that feedback channel is real design work for a path that already self-heals in the common case (a peer that goes away drops out of the cohort and is re-detected when it comes back), so a maintainer may reasonably wait for a field report first.
----

# Growth push: "we told that peer" is recorded before anyone checks that the telling worked

Found reviewing `replicate-owned-blocks-when-the-cohort-grows`, which added the cohort-growth
replication arm. The arm itself is correct; this is the gap on its failure path.

## What happens today

`RebalanceMonitor` keeps, per block, the set of peers it has already seen become co-responsible for
that block (`responsibilitySnapshot`, `cohortPeers`). Each check reports the peers *not* in that set
as `grown`, and — in the same statement — adds them to it:

```ts
if (newPeers.length > 0) {
  if (grown.size < this.growthBlockBudget) {
    grown.set(blockId, newPeers)
    seenCohortPeers = new Set(currentPeers)   // <- recorded as "seen" right here
  }
  ...
```

Only *after* that does `BlockTransferCoordinator.handleRebalanceEvent` actually push the block to
those peers. When the push does not land, the coordinator reports the block in `underReplicated`, and
`libp2p-node-base.ts` writes one log line about it and does nothing else. The monitor is never told.
So on the next check those peers are already "seen", nothing is reported `grown`, and the copy is
never attempted again.

## Why it matters

This is the exact defect the growth arm exists to fix, surviving one transient failure. Concretely,
a two-machine deployment: A holds a block written while it was alone, B joins and becomes
co-responsible, the one growth check fires, and the push to B fails. The block stays on A only. Every
read of it by anyone other than A declines permanently (block repair needs two distinct cohort peers
to claim the same revision, and there is only ever one claimant), which is the original
`fix/single-holder-block-is-permanently-unreadable` symptom, unhealed.

## Ways the push fails while the peer stays in the cohort

The arm partly self-heals when a peer *leaves* — a peer that drops out of the cohort also drops out
of the seen set, so its return is re-detected. The gap is the cases where the peer stays in the
cohort and the push still does not land:

- **the dial or the response times out** — the peer is known to FRET but momentarily unreachable
  (relay hiccup, NAT re-bind, the connection whose open triggered this very check having just gone);
- **the receiver refuses to persist** — `BlockTransferService.handlePush` reports the block in
  `missing` on any persist failure (transient storage fault), which the sender correctly does not
  count as confirmed;
- **a partition is detected between the check and the reaction** — the monitor's own partition
  suppression already passed, then `confirmReplicated` finds `detectPartition()` true and leaves every
  block unconfirmed.

All three resolve at the same code site and are one ticket, not three.

`confirmReplicated`'s own `maxRetries` (default 2, with backoff) retries within the pass. That covers
a hiccup of a few seconds; it does not cover a peer that is unreachable or faulted for longer than
the pass.

## What the fix should establish

An invariant, rather than a patch per failure mode: **a peer enters the per-block seen set only once
a replica has been confirmed on it.** Everything above then re-detects for free, and no future failure
mode can be added to the list.

That needs the reaction's outcome to reach the monitor — some way for the coordinator (or the
node-base handler that already receives `replicated` / `underReplicated`) to tell the monitor which
peers actually confirmed. Whatever shape that takes should answer two things the current design does
not have to:

- **Give-up policy.** A peer that permanently refuses would otherwise be re-pushed on every check
  forever. Bounded today by `minRebalanceIntervalMs` (60s) and `growthBlockBudget`, but that is a
  rate limit, not a decision. Say when the node stops trying, and whether stopping is observable.
- **Whether a re-check needs a trigger of its own.** Checks fire only on libp2p connection events. If
  the failure was "the peer is briefly unreachable" and no further connection event arrives, a
  correctly-invalidated seen set still gets no check to act on it. See the `NOTE:` on the growth
  budget in `rebalance-monitor.ts`, which parks the same observation for the deferred-block backlog.

## Not asking for

Not asking to relax the two-claimant repair floor — see
`blocked/repair-floor-defends-a-door-the-push-path-leaves-open` for that question, which is separate
and does not gate this.
