# Arachnode Ring Shifting & Responsibility Handoff

This document specifies **how a storage node safely changes rings** in Arachnode: when it
decides to move, and how it transfers the data it stops being responsible for without ever
dropping a key below its replication floor. It is the design that the ring-migration
implementation builds from. Read `arachnode.md` first for the ring model.

## Terms (defined once)

- **Ring depth `R`** — a node's keyspace partitioning level. Ring 0 covers the whole keyspace;
  ring `R` covers a `1/2^R` slice selected by the first `R` bits of the node's hashed coordinate.
  Moving **out** = `R → R+1` (half as much keyspace); moving **in** = `R → R-1` (twice as much).
- **Shed range** — the half of a node's current slice it stops covering when it moves **out**.
  Moving **in** sheds nothing (the node takes on *more* keyspace), so the release protocol below
  applies only to move-**out** and to a node **leaving** storage entirely.
- **Replication floor `N`** — the minimum number of complete, serving replicas every key must
  have. In this codebase it is the cohort size FRET assembles for a block
  (`RebalanceMonitor.getCohortSize()`), and the cluster admission floor
  (`minAbsoluteClusterSize`); the handoff must not let the *serving* replica count for any key
  fall below it.
- **Post-move holder** — a peer that is responsible for a shed key under the *new* topology
  (i.e. after this node has left the shed range), as seen through FRET `findCluster` /
  `assembleCohort`.
- **`ArachnodeInfo.status`** — the already-existing advertised lifecycle field
  (`'joining' | 'active' | 'moving' | 'leaving'`, see
  `packages/db-p2p/src/storage/arachnode-fret-adapter.ts`). The handoff drives it.

## The invariant this protocol exists to protect

> **Replication-floor invariant.** For every key `k`, at every instant `t` during and after any
> ring shift, the number of nodes that are **both** (a) responsible for `k` under their
> currently-advertised ring/partition **and** (b) `status === 'active'` (serving) for `k` is
> **≥ N**.

Everything below is in service of this one sentence. A reviewer tests the protocol by trying to
construct an instant where it is violated.

## Why the current code violates it

Two live code paths flip responsibility with no safety:

1. **Undamped, unilateral ring flip.** `libp2p-node-base.ts` (~line 1017) polls
   `RingSelector.shouldTransition()` every 60 s and, on a move, immediately calls
   `fretAdapter.setArachnodeInfo(newRing)` — a single metadata write that changes the node's
   advertised responsibility instantly, with no `moving` phase and no data handoff. The demand
   signal driving it, `RingSelector.determineRing()` = `ceil(-log2(coverage))`
   (`ring-selector.ts:79`), is computed from an **instantaneous** snapshot of `getRingStats()`
   and capacity with no smoothing — a classic undamped reactive loop that oscillates when
   `-log2(coverage)` sits near an integer.
2. **Release-before-confirm on rebalance.** On the cohort-churn path
   (`libp2p-node-base.ts:982-988`) a `lost` block is *released* — `untrackBlock` stops the spread
   monitor re-pushing it — **synchronously and unconditionally**, while the corresponding push to
   the new owners (`BlockTransferCoordinator.handleRebalanceEvent`) runs fire-and-forget,
   is **skipped entirely during a partition**, is timeout-bounded, and has its result only logged.
   So a node can stop being a spreading holder of a block whose push failed or never ran.
   (Local block *bytes* are not deleted by `untrackBlock`, so the replica is not physically lost
   at that instant — but the node has stopped advertising/spreading it, and a later storage sweep
   may reclaim it. The design must gate release on confirmation regardless.)

## Part 1 — Damping the ring-shift decision

The move decision must not flip on small fluctuations around a ring boundary. Three mechanisms,
all applied to the demand signal *before* it can trigger a shift:

### 1.1 Smoothing

Maintain an exponentially-weighted moving average of the continuous demand depth
`d = -log2(smoothedCoverage)`, updated once per sample (the existing 60 s tick), rather than
reading an instantaneous value:

```
smoothedCoverage ← α · coverage_now + (1 − α) · smoothedCoverage      (α ≈ 0.2)
d = clamp(-log2(max(ε, smoothedCoverage)), 0, 16)
```

`coverage_now` is the existing `capacity.available / estimatedTotalData`. Both inputs
(`estimatedTotalData` from `getRingStats()`, and `capacity`) are smoothed via the same EWMA so a
single noisy sample cannot move `d`.

### 1.2 Hysteresis / dead-band

Let `R` be the node's **currently-advertised** ring. Do not move to `R±1` unless the smoothed
depth is solidly past the boundary by a dead-band `h` (≈ 0.5 ring):

- Move **out** (`R → R+1`) only when `d ≥ R + 1 − h` **and** `usedPercent > moveOut` (the
  existing 0.85 threshold).
- Move **in** (`R → R-1`) only when `d ≤ R − 1 + h` **and** `usedPercent < moveIn` (existing 0.40)
  **and** `R > 0`.

The gap of width `2h` around each integer is the region where a hovering ratio produces **no**
move. This replaces the current `newRingDepth = determineRing() ± 1`, which recomputes the target
from the noisy instantaneous formula and can disagree with the node's own advertised ring on the
very next tick.

### 1.3 Minimum dwell + one-ring-at-a-time

- **Minimum dwell.** A node must remain at a ring for at least `minDwellMs` (default 10 min,
  configurable) after a *completed* shift before starting another. This bounds shift frequency
  independent of signal noise.
- **No re-entrant shift.** No new shift may start while `status === 'moving'` (a shift is already
  in flight).
- **Single step.** A shift moves by exactly ±1 ring. Even if `d` implies a two-ring jump, the node
  takes one step, lets the dwell timer and re-sampled signal settle, then re-evaluates. This keeps
  the shed/gain range to exactly half/double and bounds the membership delta (see Part 3).

### 1.4 Choosing the parameters

`α`, `h`, `minDwellMs`, and the `moveOut`/`moveIn` thresholds live in `RingSelectorConfig` with the
defaults above. They are chosen so that: (a) the dead-band width `2h ≈ 1` ring guarantees a full
integer of separation between the move-out and move-in triggers, so a node cannot satisfy both; and
(b) `minDwellMs` ≫ the rebalance debounce/interval (5 s / 60 s) so a shift always outlives several
topology samples. Deployments tune them; the invariant in Part 2 does not depend on their values.

## Part 2 — Two-phase responsibility handoff

A move-out (or leave) transfers the shed range through three ordered steps. **Old responsibility is
retained until the shed range is confirmed replicated.** The state machine:

```
        (move-out decided, dwell satisfied)
 active ─────────────────────────────────────▶ moving:ADVERTISE
   ▲                                                  │  publish new ring/partition to FRET metadata;
   │                                                  │  status='moving'; KEEP serving old range
   │ rollback (any failure / crash / timeout)         ▼
   │                                            moving:CONFIRM
   │ ◀───────────────────────────────────────────────┤  for every block in the shed range,
   │                                                  │  confirm ≥ N post-move holders hold a
   │                                                  │  current replica (still serving old range)
   │                                                  ▼
   └──────────────────── active(new ring) ◀── moving:RELEASE
                             stop serving + stop spreading the shed range;
                             only now may the range become GC-eligible
```

### Phase A — advertise-new-ring

Set `status = 'moving'` and write the target `ArachnodeInfo` (new `ringDepth`, new `partition`) to
FRET metadata. The node **keeps serving and spreading its entire current range** — nothing is
released. Publishing the target ring is what makes the impending change *observable* to peers'
`findCluster` / `deriveExpectedCluster`, so the shift becomes an agreed membership change (Part 3),
not a silent local flip.

### Phase B — confirm-replication

Enumerate the blocks the node currently holds in the shed range. For each, confirm it is replicated
to **≥ N post-move holders, excluding self and excluding any peer that is itself `status='moving'`
and shedding the same sub-range** (see concurrent-moves below). The existing push primitive is the
confirm mechanism: `BlockTransferClient.pushBlocks` returns a `missing` list, so a block counts as
confirmed on a holder when that holder reports it *not* missing (it already had it, or accepted the
push). Retries and per-block timeouts apply. The phase completes only when **every** block in the
shed range is confirmed to the floor.

If confirmation cannot be reached for any block (holders unreachable, partition detected, floor not
met within a bound), the shift **aborts** and rolls back to `active` at the *old* ring — the node
keeps the range.

### Phase C — release-old-range

Only now: set `status='active'` at the new ring, stop serving and stop spreading the shed range
(the authoritative `untrackBlock` / spread self-prune), and mark the shed range's local bytes
GC-eligible. Because release happens strictly after Phase B confirmed ≥ N *other* serving holders,
the serving replica count for every shed key never dips below N — the invariant holds across the
release instant.

**Move-in needs no release phase.** A node moving in only *gains* keyspace; it pulls the new half
(existing `RestorationCoordinator` path) and sheds nothing, so the floor is never at risk from the
mover. It still uses Phase A (advertise) so peers observe the membership change.

## Part 3 — Interactions & edge cases (the adversarial surface)

### Concurrent moves (two adjacent nodes at once)

Two nodes whose slices are adjacent may both decide to shed an overlapping sub-range at the same
time. The danger: each confirms the *other* as a post-move holder and both release, leaving the
overlap uncovered.

**Rule:** a peer that is `status='moving'` **and** advertises a target partition that *also* sheds
the same sub-range does **not** count toward a confirmer's replication floor for that sub-range.
Confirmation counts only holders that will still cover the key after their own advertised move. No
global lock is needed: each mover independently retains its old responsibility until it confirms,
and because a same-range mover is excluded from the count, two adjacent movers cannot both reach
"confirmed" on the shared overlap simultaneously — at least one will fail to find N qualifying
holders and abort (rolling back to keep the range). The **safe-overlap window** is exactly the span
in which both remain `active`-serving until each independently confirms; the invariant holds
throughout because neither releases before confirming against *stable* (non-moving) holders.

### Failure mid-handoff (crash between advertise and release)

A node that crashes after Phase A but before Phase C never executed the release: it never stopped
serving and never GC'd the shed range. On restart it re-derives responsibility from FRET; if still
responsible it resumes serving, and its stale `status='moving'` metadata is refreshed to `active`.
Peers must treat a `moving` node as **still-responsible for its old range** until it transitions to
`active` at the new ring — i.e. `moving` is fail-*toward*-the-old-holder. This guarantees a
mid-handoff crash leaves the shed range covered.

### Interaction with cluster-membership agreement

A ring shift changes which blocks a node is responsible for, which is a **membership change** the
rest of the cluster must agree on — not a unilateral local move. The existing member-side admission
gate (`packages/db-p2p/src/cluster/cluster-repo.ts`, `admitMembership`) admits a declared peer set
only if it is within `clusterSizeTolerance` symmetric-difference of the member's own FRET-derived
view and not a self-shrink below `ceil(admissionFraction · K_est)`.

The handoff is compatible **because** old responsibility is retained through Phases A–B: during the
shift the affected blocks' cohort is a *superset* (old holder **plus** new holders), a bounded
delta of ~one member per block — well inside the tolerance window — rather than a wholesale-disjoint
swap that would be rejected. Requirements this imposes:

- Phase A must publish the metadata change **before** the node begins voting/serving in the new
  range, so peers' `deriveExpectedCluster` (`findCluster`) reflects it and the derived views
  converge.
- The single-step rule (§1.3) is load-bearing here: a one-ring shift bounds the per-block cohort
  delta so it stays within tolerance. A multi-ring jump could swap enough of the set to trip the
  admission gate.
- The cert-anchored membership model in
  `tickets/backlog/feat-cluster-membership-threshold-cert-anchoring.md`, if/when it lands, replaces
  the tolerance window with a signed membership cert; a ring shift then becomes a membership-cert
  rotation (`prevEpoch`/`rotationSig`). This spec's advertise→confirm→release ordering maps onto
  that rotation unchanged (advertise = propose new epoch, release = old epoch retired).

### Replication-floor invariant (restated for the reviewer)

The tests must assert: at no simulated instant during a move-out — including the release instant,
under a concurrent adjacent move, and under a mid-handoff crash — does the count of `active`-serving
responsible holders for any shed key fall below N. Release is reachable only through a confirmed
Phase B, so the property reduces to "Phase B's count excludes self and same-range movers and
requires ≥ N," which the tests verify directly.

## Key code sites the implementation touches

- `packages/db-p2p/src/storage/ring-selector.ts` — damping (Part 1): EWMA state, dead-band in
  `shouldTransition`, dwell timer, single-step target. Extend `RingSelectorConfig`.
- `packages/db-p2p/src/libp2p-node-base.ts` (~899, ~982-988, ~1017-1027) — drive the state machine:
  replace the unilateral `setArachnodeInfo` flip with advertise→confirm→release; gate the
  rebalance `untrackBlock` release on push confirmation.
- `packages/db-p2p/src/cluster/block-transfer.ts` — `pushBlocks` already returns `missing`; expose a
  confirm result the release step can gate on (do not release blocks whose confirmation failed).
- `packages/db-p2p/src/cluster/rebalance-monitor.ts` — `RebalanceEvent.newOwners` and
  `getCohortSize()` supply the post-move holders and floor N.
- `packages/db-p2p/src/storage/arachnode-fret-adapter.ts` — `status` transitions and metadata
  publication in Phase A.
</content>
</invoke>
