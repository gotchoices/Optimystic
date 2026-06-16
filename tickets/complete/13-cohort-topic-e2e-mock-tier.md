description: A new in-process test harness spins up 48–64 simulated nodes to check that the shared "find-the-peers-for-a-topic" layer behaves the way its design doc promises — registration, renewal, promotion, failover, and flood resistance — at realistic cohort sizes.
files:
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (new — extracted + scaled harness)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (refactored to consume the harness)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts (new)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (new)
  - docs/cohort-topic.md (§Validation — mock-tier-at-scale coverage + tagged gaps)
  - docs/architecture.md (Doc Sync Status row)
----

# Complete: cohort-topic mock-tier e2e at scale

## What landed

The mock-transport e2e tier for the cohort-topic substrate, exercising the real `CohortTopicService` /
`CohortMemberEngine` + FRET host over an in-process mock mesh at production-shaped cohort size
(`k = 16`, `minSigs = 14`) inside 48–64-node rings, virtual-clock-driven (no wall-clock sleeps).

- **`src/testing/cohort-topic-mesh-harness.ts`** — the cohort-topic mock harness, extracted from
  `live-tier.spec.ts` and generalized (`wantK < N` cohorts, Edge/Core `profiles`, `antiDos` passthrough,
  `crashNode`, `routeTrace`, `coordTierMap`/`walkTraceFrom` walk-trace reconstruction). Kept as a sibling
  of the cluster `mesh-harness.ts` (they share no infrastructure and collide on `MeshOptions`).
- **`cohort-topic-scale-lifecycle.spec.ts`** (7 passing, 3 skip) — register / `ttl/3` renewal / TTL
  eviction; per-tier willingness gating; promotion + `Promoted(d+1)` redirect; sticky no-flap;
  root-never-demote; crash failover via signed `reattach`; gossip replication + eviction convergence.
- **`cohort-topic-scale-antiflood.spec.ts`** (8 passing, 2 skip) — §Anti-flood claims 1 (walk
  discipline), 3, 4 on real walks via the db-core predicates; claim-2 jitter rate bound; §Anti-DoS
  per-peer rate limit, topic-budget refusal, and `bootstrap: true` root instantiation.
- Doc sync: `docs/cohort-topic.md` §Validation + `docs/architecture.md` Doc Sync Status row.

Five doc expectations the single-tier-0 milestone cannot yet satisfy are tagged
`it.skip([… DOC EXPECTATION NOT YET IMPLEMENTED …])` against their parking tickets
(`cohort-topic-participant-coord-routing-key-mismatch`, `cohort-topic-followon-derivation`,
`cohort-topic-parent-child-link`, rotation handoff) rather than omitted.

## Review findings

**Verification run (post-review):** `yarn build` (db-p2p, project TS 5.9.3) clean exit 0; `yarn test`
(full db-p2p suite) **692 passing, 14 pending, 0 failing** (~33 s). The
`cohort-topic cold-start: … parent unreachable` line is an expected `log()` from the pre-existing
`host-antidos-coldstart` negative test, not a failure. Re-ran the edited anti-flood suite in isolation:
8 passing, 2 pending. (Note: `npx tsc` pulls a TS 7.x prerelease that errors on the deprecated
`downlevelIteration` option in `tsconfig.json`; the project's pinned `tsc` 5.9.3 — what `yarn build`
uses — is clean. Not a regression from this ticket.)

**Checked — walk-trace reconstruction faithfulness (the load-bearing claim).** Confirmed the harness's
`coordTierMap` + `walkTraceFrom` faithfully recover the real walk's per-probe tier: the recorded
`routeTrace` keys are matched against `coord_d(participant, topic)` for `d ∈ [0, dMax]`, and the
non-vacuous assertions (`startTiers.size === 1`, `probes[0].treeTier === dMax`, `hasOutwardMove`,
`probes.length > 0`) would all fail if the recorded keys did not match the computed coords — they pass,
so the trace fed to `outwardMovesArePromoted` / `inwardStepsFollowNoState` / `retriesRestartAtDMax`
mirrors what the real `WalkEngine` did. The db-core predicates match their `docs/cohort-topic.md`
transcription and the simulator's `walk-metrics.ts` equivalents.

**Checked — the participant-coord prefix-collision finding (claim-1 fan gap).** Confirmed real and
correctly homed: `participantCoord` is carried as the dialable peer-id bytes, every Ed25519 libp2p id
base58-encodes to a constant `"12D3KooW…"` prefix, so `coord_d` (d≥1) collapses **across participants**
(within one participant the per-tier coords still differ, which is why the per-walk reconstruction is
sound). `cohort-topic-participant-coord-routing-key-mismatch` (backlog) is the right parking ticket.
The four other `it.skip`s map to genuinely-unimplemented features gated by existing backlog tickets.

**Fixed inline (minor).** Removed the dead `firstKey` field from `walkOnce`'s return in
`cohort-topic-scale-antiflood.spec.ts` (no longer consumed after the claim-1 rewrite). Re-typechecked
and re-ran the suite — clean.

**Filed as new tickets (major).**
- `tickets/fix/cohort-topic-topic-budget-eviction-leak.md` — **real product bug** (db-core, outside
  this diff). The per-cohort topic budget's `participantCount` is only ever touched **up** on admission
  (`member-engine.ts:228`); `sweepStale` and the gossip-eviction path never touch it **down**, and a
  tier-0 root never de-instantiates, so a topic whose participants all TTL-evict stays resident with a
  stale positive count **forever** — never `coldestEvictable()`, permanently occupying a budget slot. A
  cohort churning short-lived topics eventually refuses all new topics. This is exactly why the §Anti-DoS
  LRU cold-eviction test had to drive `createTopicBudget` directly instead of through the engine.
- `tickets/backlog/cohort-topic-gossip-bus-clock-injection.md` — the gossip bus's TTL-death guard
  (`gossip/bus.ts` `mergeRecords`) reads `Date.now()` because the host injects no virtual clock, forcing
  the harness's `T0 = Date.now()` workaround. Latent flake only if the suite ever spans > `ttl` (90 s)
  between stamp and replication merge (currently ~3 s). Backlog: add a host seam to inject the bus clock.

**Checked — not filed (deliberate scope, acceptable).** `participantPrimaryAt`/`participantPrimaryBackupAt`
use unbounded `for(;;)` key-grinding (~1/k and ~1/k² hit rates — bounded in practice; a future
regression would hang to the mocha timeout rather than fail fast, but this is test-only and documented).
`setupTopic` hand-seeds the willingness quorum rather than converging it via the live gossip cadence (a
deliberate harness shortcut mirroring the existing gossip-cadence tests). The `as never` casts in
`buildMesh` bypass the host's node/fret param types (pragmatic for a structural mock). Crash-failover
asserts the cohort side, not the participant-side 3-fail loop (unit-covered in db-core). None of these
warrant a ticket; an e2e of the full ping-fail→reattach round-trip and a willingness-convergence suite
would strengthen the tier and could be picked up opportunistically.

**Docs.** Read both changed doc sections against the code. `docs/cohort-topic.md` §Validation and
`docs/architecture.md` Doc Sync Status row accurately describe the delivered coverage and the tagged
gaps; no corrections needed beyond the two future-ticket cross-references the new tickets will carry.

## Result

Build clean, full suite green (692 passing / 14 pending / 0 failing). One minor cleanup applied inline;
two major findings (one product bug, one test-seam robustness gap) filed as forward tickets.
