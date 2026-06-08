description: Review the churn/failover/willingness-back-off layer added to substrate-simulator — churn generator, deterministic primary/backup + TTL renewal + three-failure backup promotion, partition split/heal convergence, exponential UnwillingCohort back-off + gossip staleness, and the demotion-cascade tree-collapse fix carried over from the tree ticket. Build + 102 tests green.
files:
  - packages/substrate-simulator/src/cohort-membership.ts
  - packages/substrate-simulator/src/registration.ts
  - packages/substrate-simulator/src/partition.ts
  - packages/substrate-simulator/src/backoff.ts
  - packages/substrate-simulator/src/churn.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/topic-events.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/cohort-membership.spec.ts
  - packages/substrate-simulator/test/registration-failover.spec.ts
  - packages/substrate-simulator/test/partition.spec.ts
  - packages/substrate-simulator/test/backoff.spec.ts
  - packages/substrate-simulator/test/churn.spec.ts
  - packages/substrate-simulator/test/topic-tree.spec.ts
  - docs/cohort-topic.md
  - packages/substrate-simulator/README.md
----

# Review: simulator churn, failover, and willingness back-off

Population dynamics layered on the modeled cohort-topic tree (`simulator-cohort-topic-tree`).
Churn and willingness share per-member state: churn drives load + failover; willingness gates
admission under that load. All modeled behaviour on the synchronous virtual clock — no async, no
wall-clock, no randomness outside the seeded RNG (the `no-real-time` guard scans the new files and
is green). Builds on `simulator-fret-cohort-model` (RingModel) and the event clock.

## What shipped

**`cohort-membership.ts`** — deterministic primary/backup sharding (cohort-topic.md §Primary and
backup sharding). `CohortMembership` holds a sorted member-id snapshot + derived `cohortEpoch`
(`fnv1a32` of the sorted ids); `assign(participantId)` = `order[slot]` + 2 wrap-around backups,
`slot = H(participantId ‖ cohortEpoch) mod k`. `split`/`merge` model partition/heal; a merged set
reproduces the pre-split epoch ⇒ same assignment. **Modeled-hash note:** the doc specifies sha256;
the simulator hashes synchronously (FNV-1a, like `deriveTopicId`) — only determinism matters for
the model.

**`registration.ts`** — TTL renewal + failover (cohort-topic.md §TTL and renewal, §Membership
rotation, §Failure modes). `TopicCohort` holds the authoritative per-participant `RegistrationRecord`
and serves via the deterministic slot order *skipping unreachable members* (`membership ∩ ¬dead` —
the single lever crashes, churn-out, and partition all pull). `renew` returns `primary_moved` when
the effective primary changed (lazy handoff: previous primary serves until the next ping picks up
the move — *not* eager). `evictStale` drops records aged past TTL. `ParticipantRenewal` is the
participant-side loop: pings every `ttl/3`, three consecutive unreachable pings promote the first
reachable backup via re-attach, primary+all-backups gone ⇒ re-lookup (re-register).

**`partition.ts`** — `PartitionSpec` + `splitMembership`/`healMembership`/`checkConvergence`. The
convergence oracle proves a healed assignment reproduces the pre-split primary.

**`backoff.ts`** — exponential `UnwillingCohort` back-off (`backoffDelay = base·factor^n` capped at
`maxMs`), the `BackoffAdmission` retry driver (counts rejections + time-to-admit), and
`WillingnessGossip` modeling ~1-heartbeat staleness (routes against the stale gossiped candidate
set, verifies the routed member against *live* willingness ⇒ `UnwillingMember` on a stale-willing
member).

**`churn.ts`** — `ChurnConfig` + `ChurnGenerator`: scheduled arrivals/departures at
`churnPctPerMin` with per-event latency jitter, all from the seeded RNG, surfaced via
`onArrival`/`onDeparture` callbacks (the generator owns *when*, the caller owns *what*).

**`topic-tree.ts`** (carried-over review fix) — the demotion cascade. Each `TopicCohortState` now
stores `parentCoord` + `linkedToParent`; `demote` sends the modeled `DemotionNoticeV1` by
decrementing the parent's `childCohortCount`, and `register` re-links symmetrically on re-growth.
Demotion is generalized from "promoted → unpromoted" to "release forwarder state" so an unpromoted
leaf also frees its parent — which is what lets a deep tree **collapse to the root** as load drains.

**`topic-events.ts`** — added `Evicted`, `BackupPromoted`, `PrimaryMoved`, `Admitted` to the
`SimEvent` union (additive; ticket-6 metrics engine not built yet).

## Use cases for testing / validation (the *Done when* set, all green)

- **Backup promotion within window** (`registration-failover.spec.ts`) — a crashed primary
  promotes `backups[0]` after exactly three `ttl/3` failures, repoints, recovery ≤ one TTL, and the
  re-attached backup then serves steadily (no further promotions/re-lookups). Companion test:
  primary + all backups dead ⇒ re-lookup.
- **Deterministic primary_moved** (`registration-failover.spec.ts`) — a membership rotation that
  re-slots a still-reachable primary surfaces as `primary_moved` on the next ping (one window).
- **Partition heal convergence** (`partition.spec.ts` + `cohort-membership.spec.ts`) — the merged
  membership reproduces the pre-split epoch/assignment; a subscriber serves on the isolated side,
  then converges to the pre-split primary via `primary_moved` within ~one gossip round of heal.
- **Back-off curve** (`backoff.spec.ts`) — exponential back-off suffers `O(log(window/base))`
  rejections (≤ 9 vs ≈ 100 for a fixed 1 s retry) yet admits within `maxMs` of capacity freeing.
- **Willingness gating, no cascade** (`churn.spec.ts`) — under a 40-participant burst against a
  capacity-4/sec gate, accepted/sec is capped at capacity and offered load *decays* across the run
  (back half ≤ front half), all participants eventually admit, total attempts bounded.
- **Gossip-lag edge case** (`backoff.spec.ts`) — a seeker routed to a stale-willing member gets
  `UnwillingMember`, recovers via a named sibling, and the gossip catches up one heartbeat later.
- **Deep tree collapses to root** (`topic-tree.spec.ts`) — a depth-3 chain built by load collapses
  bottom-up once drained, `childCohortCount → 0` at every tier, `Demoted` once per cohort; a
  rebuild restores every child count (increment/decrement symmetry).
- **Churn determinism** (`churn.spec.ts`) — two runs at the same `(seed, config)` churn the same
  peers in the same order; turnover is balanced and population-stable.

## Honest gaps — treat the tests as a floor, not a finish line

1. **Churn is not wired through the real FRET `DigitreeStore`.** The generator emits a
   population-event stream via callbacks; cohort membership for failover/partition is modeled as
   explicit `CohortMembership` id-sets, *not* derived from `FretModel.cohort.assemble`. Deliberate:
   the failover/partition/willingness properties don't need real FRET reassembly, and explicit
   memberships keep the deterministic-assignment + partition tests crisp and synchronous. **No test
   drives churn → FRET store mutation → cohort reassembly → handoff end-to-end** — that composition
   is `simulator-metrics-and-scenarios` (6) territory. A reviewer wanting to harden this could wire
   `onArrival`/`onDeparture` to `FretModel.addPeer`/`removePeer` + re-`assemble` and assert the
   resulting epoch change drives `primary_moved`.
2. **"No cascade" uses a synthetic rolling-second capacity gate**, not the live
   barometer → willingness → `classifyAdmission` chain wired into a real registration burst. The
   pieces are unit-tested separately; the integrated burst is light.
3. **Partition test rotates a single cohort** (whole → side-A → merged) rather than two
   concurrently-live side cohorts each serving participants and physically merging. Convergence is
   proven at the membership and renewal/`primary_moved` levels, not with two live partitions
   exchanging participants.
4. **Collapse test uses a single linear branch** (one child per tier). The link/unlink logic is
   per-child so a fan-out collapse should work, but **multi-child collapse is not separately
   tested** (growth-side multi-child is covered by the depth-law smoke test). Good first target for
   the reviewer.
5. **Re-lookup re-registers on the same cohort** (current membership), not the full `d_max`→root
   walk — that lookup path is the sibling `simulator-participant-walk` ticket.
6. **`primary_moved` / `BackupPromoted` emit to two different sinks** (cohort vs participant
   renewal). Tests pass one shared sink; a consumer wiring them separately should be aware.
7. **Modeled FNV hash** for `cohortEpoch`/`slot` instead of sha256 (determinism-only; noted in
   code). Same simplification the tree ticket made for `deriveTopicId`.

## Doc sync done

- `docs/cohort-topic.md` §Willingness — forward note: back-off curve + gossip-staleness
  simulator-validated; parameters fold via `fold-simulator-findings-into-design-docs`.
- `docs/cohort-topic.md` §Failure modes — new "Recovery time bounds" forward note (backup-promotion
  window, partition-heal convergence) to be filled with measured latencies by the fold ticket.
- `packages/substrate-simulator/README.md` — third-layer churn/failover/back-off paragraph.

## Validation

`yarn build` clean; `yarn test` **102 passing** (was 81; +21 this ticket). Only the
`substrate-simulator` package was exercised; no `.pre-existing-error.md` written (no unrelated
failures). The `portal:` FRET dependency caveat (`fret-portal-dependency-resolution`) is unchanged
and still applies to CI.
