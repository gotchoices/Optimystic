description: Modeled cohort-topic tree in the substrate-simulator — tier addressing (coord_d), promotion/demotion hysteresis, willingness + load barometer, topic-traffic flow, and the metrics-stream events. Spec mirror for the production cohort-topic-* tickets. Reviewed; build + 81 tests green.
files:
  - packages/substrate-simulator/src/topic-addressing.ts
  - packages/substrate-simulator/src/willingness.ts
  - packages/substrate-simulator/src/topic-events.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/hex.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/topic-addressing.spec.ts
  - packages/substrate-simulator/test/willingness.spec.ts
  - packages/substrate-simulator/test/topic-tree.spec.ts
  - packages/substrate-simulator/test/no-real-time.spec.ts
  - docs/cohort-topic.md
  - packages/substrate-simulator/README.md
----

# Complete: simulator cohort-topic tree

The modeled topic tree — the spec mirror the production `cohort-topic-*` substrate is checked
against. Modeled behaviour only, layered on `simulator-fret-cohort-model`'s `RingModel`, with
every state transition scheduled on the virtual clock. Implemented over three phases (tier
addressing + node state; lifecycle + barometer + willingness; traffic + events). See the
implement commit `270d797` for the full shipped surface; this file records the **review pass**.

## Review findings

**Diff reviewed:** implement commit `270d797` (8 src/test files, +1405 lines), read fresh against
`docs/cohort-topic.md` before the handoff summary. Build was green and 81 tests passing at intake;
both remain green after the review edits.

### Checked

- **Tier addressing (`topic-addressing.ts`).** `coord_d = H(d ‖ prefix(P, d·log₂F) ‖ topicId)`
  matches doc §Tier addressing; `coord_0` correctly falls out of the general form at `d=0` (no
  special path). `prefixBits` bit-packing, partial-byte zeroing, and bounds checks verified
  against the unit tests and by hand. Async confined to this one file and registered in the
  `no-real-time` `ASYNC_ALLOWED` guard — confirmed every other new file is synchronous and the
  guard scans them. **No issues.**
- **Promotion/demotion + hysteresis (`topic-tree.ts`).** Cap / fast+overload / slope triggers and
  the demotion conjunction (sticky floor ∧ `≤cap_demote` held `T_demote` ∧ `childCohortCount==0`)
  match doc §Promotion/§Demotion/§Hysteresis. Idempotency of `promote`/`demote`, the low-load
  hysteresis clock, and the eager-promote / tick-driven-demote split verified. The three
  load-bearing properties (depth law ±1, thrash absorption, no-demote-with-children) are tested
  and green. **One latent gap found — see Major below.**
- **Willingness + barometer (`willingness.ts`).** Edge T2/T3 permanently off even under
  override+zero-load (profile gate precedes override/load), Core all four, load-bucket shed/recover
  at `bucket_overload`, cohort-quorum aggregation, and `classifyAdmission`
  (unwilling_cohort/accepted/unwilling_member) all match doc §Willingness/§Tier ladder and are
  tested. **One naming issue found — see Minor below.**
- **Traffic + events (`topic-events.ts`, `topic-tree.ts`).** Window→per-minute rate rollup, the
  one-gossip-round staleness, the typed `SimEvent` union, and `recordNoState`/`recordAdmission`
  routing verified. **One staleness-fidelity bug found — see Minor below.**
- **Engine integration.** Scheduler/`EventContext` usage, virtual-clock causality, registry
  keying (`${topicHex}:${coordHex}`), and the gossip self-reschedule loop reviewed. No wall-clock,
  randomness, or async leaked into the sync layer (guard test green). **No issues.**
- **Docs.** `docs/cohort-topic.md` forward-notes (collision rate, depth law, thrash, no-demote)
  and the README third-layer section + quick-start read against the code — accurate and consistent
  with the shipped behaviour. **No issues.**
- **Resource cleanup / perf.** `lastGrowthSamples` is window-trimmed (bounded by `cap_promote` in
  practice); registry and gossip loops are O(states) per round — acceptable for a model. **No
  issues, with one same-timestamp accumulation caveat noted below (not actionable).**

### Found and disposed

**Minor — fixed inline:**

1. **Traffic reply mixed live stock with lagged rates** (`topic-tree.ts`). `trafficSignal` read
   `directParticipants`/`childCohortCount` from *live* state while the rate fields came from the
   gossiped snapshot — contradicting doc §Topic traffic signal ("the responder does not recompute
   from raw counters at reply time… lags by at most one gossip round"). The model even computed
   `state.traffic.participants` and then ignored it (dead field). Fixed: `state.traffic` now holds
   the full gossiped `TopicTrafficV1`-shaped snapshot (rates **and** stock), and `trafficSignal`
   reads every field from it. Strengthened the traffic test to assert a mid-round arrival is
   invisible to `trafficSignal` until the next round publishes it (the stock-count lag, previously
   unguarded).
2. **Exported type-name typo** (`willingness.ts`, `index.ts`). `MemberWillinessOptions` →
   `MemberWillingnessOptions` (the sibling interface `MemberWillingness` was already correct). No
   external consumers yet, so the rename is safe.

**Major — filed to the owning downstream ticket (not a new ticket):**

3. **Demotion never decrements the parent's `childCohortCount`** (`topic-tree.ts`). `demote()`
   clears the cohort's own `promoted` flag but does not notify its parent to drop it from the
   tier-(d+1) child set, and no parent link is stored. Since the no-demote-with-children rule pins
   any cohort with `childCohortCount > 0`, a multi-tier tree can grow but **never collapse** — once
   a child demotes its parent is pinned forever. The simplified `register` driver increments
   `parent.childCohortCount` on child creation but nothing ever decrements it. This is latent
   (no current test builds a deep tree and then drains it), and it is squarely the churn ticket's
   territory: `simulator-churn-and-willingness` (ticket 4) drives departures → TTL eviction →
   demotion and must demonstrate the tree shrinking back. Rather than bake a fragile partial model
   here (re-promotion-after-demotion re-counting is itself churn-territory), the gap is recorded as
   an explicit scope addition + a *Done when* "deep tree collapses to the root" test in that
   ticket's `## TTL / renewal / failover` section. **Action: scope note added to
   `tickets/implement/4-simulator-churn-and-willingness.md`.**

### Noted, no action (handoff gaps confirmed reasonable)

- **Simplified `register` growth driver** — root-outward promotion-follow, not the `d_max`→root
  walk. Confirmed it bakes in no assumption ticket 4 (`simulator-participant-walk`) must
  contradict: it only produces promotion-driven shape, and the walk model owns lookup/back-off.
- **State-level vs member-level willingness are two surfaces** not yet wired inside `TopicTree`.
  Confirmed owned by ticket 4 (`simulator-churn-and-willingness`, which "drives them under
  churn-induced load"). Seam (`recordAdmission` + `classifyAdmission`) is adequate.
- **Slope pre-promotion** has only indirect coverage (depth-law driver registers at `now=0`, so
  span≤0 short-circuits and slope never fires). A dedicated timed-arrival slope test would
  strengthen the floor; deferred — the convergence ticket (`simulator-promotion-convergence`)
  exercises growth dynamics and is the natural home.
- **Depth-law `+1` bias** (observed = law+1 at power-of-F boundaries) sits inside the documented
  ±1 tolerance; pinning "tree depth" as index vs count is explicitly the convergence ticket's
  characterization, not this smoke check's.
- **Gossip multi-round / rotation-epoch reset, wire serialization, threshold sigs** — out of scope
  per ticket; owned by tickets 4, 8 respectively.
- **Same-timestamp growth-sample accumulation** — `pushGrowthSample` only trims by age, so many
  arrivals at one virtual instant grow `lastGrowthSamples` unbounded for that instant. Bounded by
  `cap_promote` in the current drivers (attach stops after promotion); not actionable now, but a
  future continuous-arrival scenario should cap sample count as well as age.

### Validation

`yarn build` clean; `yarn test` **81 passing** after the review edits (unchanged count — the
strengthened traffic assertions live inside the existing traffic test). Only the
`substrate-simulator` package was exercised; no `.pre-existing-error.md` written (no unrelated
failures surfaced). The `portal:` FRET dependency caveat
(`fret-portal-dependency-resolution`) is unchanged and still applies to CI.

## Downstream

- `simulator-participant-walk` (4) — full `d_max`→root walk + anti-flood instrumentation.
- `simulator-churn-and-willingness` (4) — churn/failover/willingness back-off **and** the
  demotion-cascade / tree-collapse loop added during this review.
- `simulator-promotion-convergence` (5) — rigorous N-sweep depth-law characterization + slope.
- `simulator-metrics-and-scenarios` (6) — richer `MetricsSink` consuming the `SimEvent` stream.
- `fold-simulator-findings-into-design-docs` (7) — folds measured parameters back into the doc.
