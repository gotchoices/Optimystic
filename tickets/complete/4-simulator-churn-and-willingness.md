description: COMPLETE — churn/failover/willingness-back-off layer on the modeled cohort-topic tree (deterministic primary/backup sharding, TTL renewal + three-failure backup promotion, partition split/heal convergence, exponential UnwillingCohort back-off + gossip staleness, churn generator) plus the carried-over demotion-cascade tree-collapse fix. Reviewed; build + 103 tests green.
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

# Complete: simulator churn, failover, and willingness back-off

Population dynamics layered on the modeled cohort-topic tree. Churn drives load + failover;
willingness gates admission under that load; the demotion cascade lets a load-grown tree collapse
back to the root as load drains. All behaviour on the synchronous virtual clock — no async, no
wall-clock, no randomness outside the seeded RNG.

See the implement commit (`ticket(implement): simulator-churn-and-willingness`) for the full
shipped-work breakdown; it remains accurate. This document records the review pass.

## Review findings

Adversarial pass over the implement diff (read fresh before the handoff summary). Build clean,
`yarn test` **103 passing** (was 102; +1 added this pass — see below). No lint is configured for
this package (root `lint` is a stub); strict `tsc` is the static gate and is green. No
`.pre-existing-error.md` written — no unrelated failures surfaced.

### What was checked

- **SPP / DRY / modularity** — `cohort-membership` (pure assignment), `registration` (cohort +
  participant views), `partition`, `backoff`, `churn` are cleanly separated; the generator
  "owns *when*, caller owns *what*" boundary holds. One deliberate duplication noted below.
- **Determinism** — `fnv1a32` assignment, seeded-RNG churn, `(at, seq)` event ordering. The churn
  byte-determinism test and the no-real-time guard both pass; reproducibility holds.
- **Error handling / guards** — constructor `RangeError`s (`churnPctPerMin`, `latencyJitterMs`,
  cohort `k`, load bucket, back-off `attempt`); empty-pool / empty-active early returns in churn;
  whole-cohort-unreachable falls through to re-lookup. All exercised or trivially safe.
- **Resource cleanup / lifecycle** — lazy `primary_moved` handoff, TTL eviction, idempotent
  `start()`/`linkToParent`/`unlinkFromParent`, `Math.max(0, …)` decrement floor. Sound.
- **Type safety** — strict `tsc` clean; no `any`, discriminated `SimEvent` union extended additively.
- **Edge / error / interaction paths** — backup-promotion window (exactly three `ttl/3` failures),
  primary+all-backups-dead re-lookup, TTL boundary (`> ttl`, not `>=`), gossip-staleness
  `UnwillingMember` → sibling recovery → quorum-loss `UnwillingCohort`, partition divergence vs
  heal convergence. Covered.
- **Docs** — read every touched file against the code. `docs/cohort-topic.md` §Willingness and
  §Failure modes forward-notes, and the `README.md` third-layer paragraph, accurately describe the
  shipped behaviour (three-failure detection, one-TTL promotion bound, epoch-reconstituting heal,
  FNV-vs-sha256 modeling note, demotion-decrements-parent collapse). No stale claims found.

### Findings and disposition

**Minor — fixed inline:**

- **Multi-child (fan-out) demotion cascade was untested** (the implementer's own flagged gap #4,
  "good first target for the reviewer"). The link/unlink logic is per-child, so a fan-out *should*
  collapse, but only the single linear branch was covered. Added
  `TopicTree — demotion cascade collapses a fan-out (multi-child) parent` to `topic-tree.spec.ts`:
  a promoted root pinned by 3 sibling tier-1 leaves; on drain every child releases (decrementing
  the root across one tick) and only the *following* tick does the root demote — asserting
  `childCohortCount → 0`, all `linkedToParent` cleared, and exactly `branches + 1` `Demoted`
  events. Confirms the cascade generalizes beyond a linear chain. (103rd test.)

**Minor — noted, deliberately left (with reason):**

- **`TopicCohort.reattach` re-registers with `ttl = 0` when no record exists**
  (`registration.ts`). This path is **not reachable** through the current caller: a participant
  only re-attaches after it has registered, and a cohort's records are never auto-evicted on a tick
  in the failover loop (`evictStale` is caller-driven, used only in tests). It would become a real
  bug only if a future scenario (`simulator-metrics-and-scenarios`) wired `evictStale` onto a
  gossip tick *and* a participant's primary went unreachable after its own record had aged out — the
  re-attach would then mint an immediately-evictable record. The correct fix needs the participant's
  TTL threaded into `reattach` (or the renewal loop routing a missing-record case through its
  TTL-aware `reLookup`), which is a contract change broader than a minor inline edit and untestable
  on the current code path. Left unchanged to avoid adding untested behaviour to modeled production
  code; flagged here so the scenario ticket addresses it when the eviction tick lands.

- **`WillingnessGossip.admit` / `gossipedCandidates` duplicate `classifyAdmission`'s candidate
  loop** (`backoff.ts` vs `willingness.ts`). Deliberate, not accidental: the gossip variant routes
  against the *stale gossiped* candidate set but verifies the routed member against *live*
  willingness — that asymmetry is the whole point of the staleness model and can't share the live
  classifier without losing it. Acceptable; not worth a forced abstraction.

- **`Admitted` `SimEvent` is declared but never emitted.** Additive vocabulary for the not-yet-built
  `simulator-metrics-and-scenarios` (6) metrics engine; `BackoffAdmission` records time-to-admit in
  a counter rather than an event. Disclosed in the handoff. No action.

- **Churn can depart-then-re-arrive the same id within one tick.** `scheduleDeparture` pushes the
  id to `pool` before `scheduleArrival` (same `churnOnce` loop) draws from it, so a just-departed id
  is eligible to arrive in the same tick. A modeling quirk only — it doesn't affect the balanced/
  population-stable/byte-deterministic properties the tests assert, and a caller wiring callbacks to
  a real ring would still see matched add/remove counts. No action.

**Major — none.** No correctness, safety, or scalability defect warranting a new fix/plan ticket.

### Honest gaps carried forward (unchanged, owned by later tickets — not review-blocking)

These are the implementer's disclosed gaps that are genuinely out of this ticket's scope; recorded
so they aren't silently lost:

1. Churn is **not** wired through the real FRET `DigitreeStore` — no end-to-end
   churn → store mutation → cohort reassembly → handoff test. → `simulator-metrics-and-scenarios` (6).
2. "No cascade" uses a synthetic rolling-second capacity gate, not the live
   barometer → willingness → `classifyAdmission` chain under a real burst. → ticket 6.
3. Partition test rotates a single cohort rather than two concurrently-live side cohorts physically
   merging. Convergence is proven at the membership + renewal/`primary_moved` levels. → ticket 6.
4. ~~Multi-child collapse untested~~ — **closed this pass** (see fixed-inline above).
5. Re-lookup re-registers on the current cohort, not the full `d_max`→root walk. →
   `simulator-participant-walk`.
6. `primary_moved` / `BackupPromoted` emit to two different sinks; a consumer wiring them
   separately should be aware.
7. Modeled FNV hash (not sha256) for `cohortEpoch`/`slot` — determinism-only, same simplification
   the tree ticket made for `deriveTopicId`; the production substrate owns the real digest.

## Validation

- `yarn build` — clean.
- `yarn test` — **103 passing** (102 from implement + 1 added in review).
- No lint configured (root `lint` is a stub); strict `tsc` build is the static check, green.
- The `portal:` FRET dependency caveat (`fret-portal-dependency-resolution`) is unchanged and
  still applies to CI.
- Settled back-off parameters and measured recovery-time latencies still fold into the design docs
  via `fold-simulator-findings-into-design-docs` (forward-notes already in place).
