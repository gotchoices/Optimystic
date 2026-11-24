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
  have. In this codebase it is `RebalanceMonitor.getCohortSize()` (FRET's `clamp(ceil(sqrt(n)), 1, 3)`,
  never above the configured `clusterSize`), and the cluster admission floor
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
   signal driving it — `RingSelector.determineRing()` = `ceil(-log2(coverage))`, defined as
   `determineRing` in `packages/db-p2p/src/storage/ring-selector.ts` — is computed from an
   **instantaneous** snapshot of `getRingStats()`
   and capacity with no smoothing — a classic undamped reactive loop that oscillates when
   `-log2(coverage)` sits near an integer.
2. **Release-before-confirm on rebalance.** On the cohort-churn path (the `handleRebalanceEvent`
   branch that calls `untrackBlock` in `packages/db-p2p/src/libp2p-node-base.ts`) a `lost` block is
   *released* — `untrackBlock` stops the spread monitor re-pushing it — **synchronously and
   unconditionally**, while the corresponding push to
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
smoothedAvailable ← α · available_now + (1 − α) · smoothedAvailable   (α ≈ 0.2)
smoothedTotalData ← α · totalData_now + (1 − α) · smoothedTotalData
d = clamp(-log2(max(ε, smoothedAvailable / smoothedTotalData)), 0, 16)
```

The two demand inputs — `available` (`StorageAccount.capacity().availableBytes`, the node's
allotment bounded by what its disk will still hold, minus what it has used) and `totalData`
(`estimatedTotalData` from `getRingStats()`) — are each smoothed with the same-α EWMA, and the
smoothed coverage is their ratio, so a single noisy sample cannot move `d`. (Smoothing the inputs and dividing is a distinct
EWMA from smoothing the `available/totalData` ratio directly; the input-wise form is what the
implementation uses.) Each EWMA is seeded from its first real sample, not from 0 — a 0 seed would
peg `d` at the clamp ceiling for many ticks.

### 1.2 Hysteresis / dead-band

Let `R` be the node's **currently-advertised** ring. Do not move to `R±1` unless the smoothed
depth is solidly past the boundary by a dead-band `h` (≈ 0.5 ring):

- Move **out** (`R → R+1`) only when `d ≥ R + 1 − h` **and** `usedPercent > moveOut` (the
  default 0.85; see §1.5).
- Move **in** (`R → R-1`) only when `d ≤ R − 1 + h` **and** `usedPercent < moveIn` (the default
  0.40) **and** `R > 0` **and** `availableBytes ≥ minCapacity`. That last condition is the same floor
  §1.4 answers ring 16 below: a node short of room is empty, so `usedPercent` is low and `d` can be
  low too, and without it the tick would walk such a node one ring inward per dwell straight back to
  the whole keyspace.

The gap of width `2h` around each integer is the region where a hovering ratio produces **no**
move. A node already at ring 16 can never move further out, because `d` is clamped at 16 and so
`d ≥ 16 + 1 − h` is unreachable: ring 16 is the floor of advertised responsibility, and from there
the only remaining lever is refusing new data
([storage.md §10](../packages/db-p2p/docs/storage.md)). This replaces the current `newRingDepth = determineRing() ± 1`, which recomputes the target
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

### 1.4 A node that cannot measure its storage

`available` is unknown when the operator configured no allotment AND the backend reports no free
space (`packages/db-p2p/docs/storage.md` §9 — SQLite, LevelDB, memory, a web store under Node). The
decision then declines rather than substituting a number:

- **`determineRing` answers ring 0**, the whole keyspace. Unknown is not "low": a node with no
  figure has established nothing, so it must not advertise the narrowest ring either.
- **`shouldTransition` answers `{ shouldMove: false }` and folds NOTHING into the EWMA.** A node
  that cannot measure its storage does not shift rings, and seeding the smoothed signal from a
  figure that does not exist would carry the invention forward for many ticks after an allotment was
  finally configured. Logged once, not per tick.
- **The node advertises no `ArachnodeInfo.capacity` at all**, and `getRingStats` leaves such a peer
  out of both the peer count and the capacity total, so a peer that claimed nothing is never read as
  claiming zero. A ring where nobody said yields no stat, which falls through to the bootstrap
  estimate above.

**A node that CAN measure its storage and finds too little of it** is a different case, and it
answers the opposite end: `determineRing` returns `MAX_RING_DEPTH` (16, the deepest ring the model
has) when `availableBytes < minCapacity`. The narrowest slice of the keyspace is the least work such
a node can advertise, and it keeps serving what it already holds.

This answer used to be the sentinel `-1`, which `createArachnodeInfo` clamped to ring 0 with no
partition — so the node with almost no room told the network it would take the **whole** keyspace.
The sentinel is gone: every answer is a real ring in `[0, 16]`, and `createArachnodeInfo` carries no
clamp and no partition guard.

Not "advertise no storage role at all", which was the alternative: leaving storage releases *every*
range the node holds, which the handoff of Part 2 would then have to carry under its replication
floor, and a node short of room must not hand everything away at once.

Two consequences worth stating rather than hiding:

- **A running node that falls below the minimum does not jump to ring 16.** The single-step rule of
  §1.3 still moves it one ring per dwell. The below-minimum answer is taken at bootstrap, where
  there is no handoff to carry, and by any other one-shot caller — which is exactly where the old
  `-1 → ring 0` fault lived. What it does *not* do is move back **in**: the move-in arm of §1.2 reads
  the same floor, so the answer taken at bootstrap holds instead of being walked away one ring per
  dwell.
- **Ring 16 is the floor of advertised responsibility** (§1.2), so from there the only remaining
  lever is refusing new data.

### 1.5 Choosing the parameters

`α`, `h` and `minDwellMs` live in `RingSelectorConfig` with the defaults above, and are this
decision's own. They are chosen so that: (a) the dead-band width `2h ≈ 1` ring guarantees a full
integer of separation between the move-out and move-in triggers, so a node cannot satisfy both; and
(b) `minDwellMs` ≫ the rebalance debounce/interval (5 s / 60 s) so a shift always outlives several
topology samples. Deployments tune them; the invariant in Part 2 does not depend on their values.

**The `moveOut` / `moveIn` thresholds are NOT this decision's own, and are the operator's to set.**
They keep their names here, because "move" is this decision's vocabulary, but the node factory feeds
them from `NodeOptions.storageAllotment.thresholds` — `moveOut` from `shedAbove` (default 0.85),
`moveIn` from `reclaimBelow` (default 0.40). The same two figures are what `StoragePressure` names
its `shedding` and `slack` stages from, so the ring decision and every other reaction a node has to
filling up read one figure rather than two that can disagree. The thresholds, their validation and
the third one (`refuseAbove`, which this decision does not read) are documented in
[storage.md §10](../packages/db-p2p/docs/storage.md).

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
and shedding the same sub-range** (see concurrent-moves below). A node built with a network
membership predicate also excludes every peer the predicate refuses: such a peer is neither pushed
the block nor counted, since Arachnode info is something any ring member can advertise (see
[internals.md § Network Membership Predicate](internals.md#network-membership-predicate)). The existing push primitive is the
confirm mechanism: `BlockTransferClient.pushBlocks` returns a `missing` list, so a block counts as
confirmed on a holder when that holder reports it *not* missing (it already had it, or accepted the
push). Retries and per-block timeouts apply. The phase completes only when **every** block in the
shed range is confirmed to the floor.

> A receiver refuses a pushed block that carries no verifying cohort commit proof (`handlePush`,
> `requirePushCertificate` — see [internals.md](internals.md) § *Certified push*). A block committed
> before proofs existed can never be certified, so it can never confirm, so a shed range containing
> one aborts this phase every time. That is by design on the receiving side; the deployment remedy
> is to run receivers with `blockTransfer.requirePushCertificate: false` until those blocks have been
> rewritten under current code.

If confirmation cannot be reached for any block (holders unreachable, partition detected, floor not
met within a bound), the shift **aborts** and rolls back to `active` at the *old* ring — the node
keeps the range.

### Phase C — release-old-range

Only now: set `status='active'` at the new ring, stop serving and stop spreading the shed range
(the authoritative `untrackBlock` / spread self-prune), and record the shed range in this node's
**released-block ledger** (`ReleasedBlockLedger` in
`packages/db-p2p/src/storage/released-block-ledger.ts`). Because release happens strictly after Phase
B confirmed ≥ N *other* serving holders, the serving replica count for every shed key never dips below
N — the invariant holds across the release instant.

**The blob arm.** Blobs are where the bytes are, so a narrowing that reached only blocks would free
almost nothing on a node whose disk is mostly blobs. Release therefore also hands over the blobs
whose routing key the old slice covered and the new one does not: each is announced to the blob's
current cohort members, `stat`ed, and its `responsible` hold dropped only once the floor of them
answers `whole` — the release rule
[blobs.md § Placement, copying and durability](blobs.md#placement-copying-and-durability) already
states, reached through the same code. `shedNarrowedBlobs` in
`packages/db-p2p/src/blob/ring-shed-pass.ts` is the pass; the coordinator itself learns nothing about
blobs, it only reports the narrowing (`onNarrowed`). Two details that are easy to get wrong and are
therefore fixed here: the pass fires **only** from this phase, so a shift that rolled back sheds no
blobs; and it takes both partitions from that report rather than re-reading the node's advertisement,
which a later shift may have moved by the time the pass runs.

**Blobs do not gate the shift.** Phase B keeps its all-or-nothing rule for blocks. The blob arm runs
*after* release, per reference, and nothing it reports can roll a shift back: what confirms is
released, what does not is retained and the node keeps serving it. Coupling the two would let one
unconfirmable blob undo a block handoff that had already confirmed — a real guarantee traded for a
storage saving.

One consequence is worth stating because it is not a bug: a narrowed node also stops *accepting*
announcements for blobs outside its slice (`BlobAnnounceReceiver`), so a blob every member of its
cohort has narrowed past is declined by all of them. Its writer keeps its own copy and keeps
retrying — the blob-level form of "the network has no room for this where it routes".

**Move-in needs no release phase.** A node moving in only *gains* keyspace and sheds nothing, so the
floor is never at risk from the mover. It still uses Phase A (advertise) so peers observe the
membership change; the gained half is not fetched by this handoff — no blocks, and no blobs either,
for the same reason — and it is not guaranteed to be pushed either. The cohort-growth push ([internals.md § RebalanceMonitor](internals.md#rebalancemonitor))
derives a block's cohort from `findCluster` — FRET proximity plus network membership, with the
arachnode ring depth playing no part — so it delivers the gained half only where FRET routing also
places the mover in that block's cohort. What always delivers it is read repair on first access; the
`NOTE:` at `moveIn` in `packages/db-p2p/src/storage/ring-shift-coordinator.ts` records what that
costs and when a fetch phase would be worth adding.

### Local bytes vs. tracking

Untracking stops this node serving and spreading a block. It does not take the bytes: that is the
released-block ledger's entry plus the sweep that reads it (`ReleasedBlockSweep` in
`packages/db-p2p/src/storage/released-block-sweep.ts`), and the rule the whole handoff exists to
enforce is stated over that pair:

> **A block's bytes are deleted only after a release that confirmed at least the replication floor of
> other serving holders hold a current replica of it.**

Four consequences worth stating, because each is a way that rule could be lost:

- **The ledger is the sweep's only input.** The sweep never works out eligibility from this node's own
  ring or partition. Mid-shift the advertised partition is the *target* ring, so a block that looks
  outside this node's slice may be one whose Phase B is still running or whose handoff rolled back —
  and is still being served. Only a release that followed a confirmation writes an entry.
- **The entry is durable, and outlives the delete it records.** A restart must not forget which bytes
  are free to go, and the sweep's `deleteBlock` is ordered and idempotent
  ([storage.md § Deleting a block](../packages/db-p2p/docs/storage.md#deleting-a-block)) precisely so
  the entry can be dropped *after* the delete. A crash mid-delete therefore leaves content with no
  metadata and an entry that the next run finishes.
- **The revision an entry records is the one the confirmation handed over**, supplied by the confirm
  step itself (`BlockTransferCoordinator.confirmReplicated` reports it per confirmed block, and Phase C
  passes it to the ledger write). It is never read after the release, because by then the block may hold
  a replica a peer pushed back in the gap — recording *that* as the released revision would make the
  sweep's written-again check compare a block against itself and delete bytes this node had just
  accepted. Sourcing it from the confirm makes every write that lands after the confirm an advance, so a
  block pushed back is kept.
- **A block whose handoff never confirmed is never swept.** Nothing releases it, so nothing records
  it, so its bytes stay on this node — served, for ever. That is the safe direction, and it is also
  why the sweep cannot be relied on to free a node whose handoffs keep failing: see
  `tickets/backlog/bug-a-block-kept-after-a-failed-handoff-is-never-offered-again.md` for the lost
  block that is never offered again.

The sweep runs when a release has just written entries, when the node's pressure reading is at
`shedding` or above, and once shortly after start-up; it is bounded per run, and the ledger is what
makes stopping partway safe. [storage.md §10](../packages/db-p2p/docs/storage.md#10-how-full-is-too-full)
has the triggers and the ceiling on what it can free.

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

## Key code sites (implemented)

Part 1 (damping) and Parts 2–3 (this handoff) have landed. The state machine lives in a dedicated
coordinator rather than inline in `libp2p-node-base.ts`:

- `packages/db-p2p/src/storage/ring-selector.ts` — damping (Part 1): EWMA state, dead-band in
  `shouldTransition`, dwell timer, single-step target. `RingSelectorConfig`. Also the two
  unknown-capacity rules of §1.4 (ring 0 from `determineRing`, no move from `shouldTransition`), the
  below-minimum answer of that same section (`MAX_RING_DEPTH` from `determineRing`) and the optional
  capacity in `createArachnodeInfo`.
- `packages/db-p2p/src/storage/storage-account.ts` — the one accounting the decision reads:
  `NodeOptions.storageAllotment` bounded by the free space the backend reports, measured against
  what the node's stores hold, behind one 60-second memo (`packages/db-p2p/docs/storage.md` §9).
- `packages/db-p2p/src/storage/storage-pressure.ts` — the one READING of that accounting, and where
  the `moveOut` / `moveIn` thresholds of §1.5 come from (`packages/db-p2p/docs/storage.md` §10).
- `packages/db-p2p/src/storage/ring-shift-coordinator.ts` — the Part 2/3 state machine:
  `executeShift` (advertise→confirm→release for move-out; advertise-only for move-in), rollback on
  any Phase-B failure, `reconcileOnStart` for crash mid-handoff, and `onNarrowed`, the one thing
  Phase C reports to anything outside the block side.
- `packages/db-p2p/src/storage/arachnode-partition.ts` — the shared prefix/coverage predicates:
  `partitionCovers`, `isServingHolder` (fail-toward-old-holder), `qualifiesForFloor` (excludes
  same-range movers) and `narrowingSheds` (the half a move-out gives up, read by both the block and
  the blob arm). Single source of truth for block/peer responsibility derivation.
- `packages/db-p2p/src/blob/ring-shed-pass.ts` — the blob arm of Phase C: `selectShedBlobRefs` picks
  the held references the narrowing gives up, `shedNarrowedBlobs` hands each to the release arm of
  `BlobCohortReaction.releaseLost` and applies its answer. It never acquires, it decides nothing
  about what a node takes, and it cannot roll a shift back.
- `packages/db-p2p/src/cluster/block-transfer.ts` — `confirmReplicated(blockIds, owners, floor)` is
  the confirm primitive (pushes, counts holders reporting *not* `missing`, requires ≥ floor);
  `handleRebalanceEvent` returns `{ released, retained, releasedRevs, replicated, underReplicated, growth }` — release is gated on confirmation, `releasedRevs` carries the revision each released block was confirmed replicated at (what the ledger records), and the last three report the cohort-growth push arm (nothing is ever released off it). `growth` carries a per-block `GrowthOutcome { satisfiedPeers, complete }` that the caller feeds back to `RebalanceMonitor.recordGrowthOutcome`, so a grown peer is recorded as holding the block only once a push to it is confirmed; a block the reaction had no information about has no entry and is re-detected next check.
- `packages/db-p2p/src/cluster/rebalance-monitor.ts` — `RebalanceEvent.newOwners` / `.grown` / `.floor`
  and the now-public `getCohortSize()` supply the post-move holders, the newly co-responsible peers of
  blocks that are KEPT, and floor `N`. `recordGrowthOutcome` consumes the reaction's growth feedback
  (bounded by `growthMaxAttempts`, retried by the `growthRecheckIntervalMs` timer).
- `packages/db-p2p/src/storage/arachnode-fret-adapter.ts` — `status` transitions and the `moveFrom`
  field advertised through Phase A (the old range a `moving` node still serves).
- `packages/db-p2p/src/storage/released-block-ledger.ts` — the durable record of what Phase C and the
  confirmed rebalance release have released: `ReleasedBlockLedger.record` (the only writer, called from
  those two paths and nowhere else) and the per-entry revision the sweep's written-again check reads.
  That revision is a **required argument** of `record`, supplied by the confirm step that made the
  release decision; the ledger reads no metadata of its own, which is what keeps a revision pushed back
  after the release from being recorded as the one released.
- `packages/db-p2p/src/storage/released-block-sweep.ts` — `ReleasedBlockSweep.sweep` deletes what the
  ledger lists and nothing else, bounded per run, single-flight with one queued follow-on. The delete
  itself is `StorageRepo.deleteBlockIfNotAdvanced`, which takes the block's write latch and declines a
  block written again since its release.
- `packages/db-p2p/src/libp2p-node-base.ts` — wires the coordinator (driven off the damped
  `shouldTransition` trigger), the gated rebalance release, the `recordReleased` callback both release
  paths write the ledger through (inside the Arachnode gate), and the sweep itself (outside it, so a
  node whose FRET service is absent this run still finishes what a previous run left recorded).
