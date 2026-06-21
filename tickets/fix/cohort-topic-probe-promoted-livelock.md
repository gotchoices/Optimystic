description: A read-only topic lookup of a popular topic that is still growing its tree can bounce between two nodes dozens of times before giving up, instead of answering quickly.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts (RouterWalkEngine.register: probe + promoted/no_state handling)
  - packages/db-core/test/cohort-topic/walk.spec.ts (walk unit tests, ScriptedRouter)
difficulty: medium
----

# Fix: read-only lookup probe livelocks on a promoted-but-unsharded topic

## Symptom (reproduced)

A `lookup` (read-only `RegisterV1.probe: true`) of a topic that is **promoted at the root but whose
target-tier child cohort for this prober's prefix-shard has not been instantiated yet** does not
resolve quickly. The walk bounces between the root (which keeps answering `Promoted(targetTier)`) and
the still-empty child tier (which answers `no_state`) until the `maxSteps` safety valve trips, then
returns `retry_later` → `CohortBackoffError`.

Measured at the walk layer (db-core, no production multi-tier wiring needed): with `d_max = 4` a single
probe consumed **36 router RPCs** (`maxSteps = 2*(d_max+2)+maxMemberRetries+8 = 36`) before backing
off. Cost scales ~`2*(d_max+2)+wantK` RPCs per lookup, and every other hop re-hits the **root** cohort
(the tree's hottest contention point), so this is an amplification / DoS vector, not just wasted
latency.

### Why it loops

`RouterWalkEngine.register` (packages/db-core/src/cohort-topic/walk.ts) follows `Promoted` outward
identically for a register and a probe. The divergence is at the terminal cohort:

- **Register:** reaches the promoted root → `Promoted(1)` → walks to tier 1 → tier-1 returns `no_state`
  on the *first* visit, but the register then re-hits the root, gets `Promoted(1)`, and arrives at
  tier 1 *as a follow-on* — the cohort host instantiates the tier-1 forwarder (`shouldInstantiate`
  with `followOn`/`bootstrap`) and **accepts**, terminating the walk.
- **Probe:** `handleProbe` (member-engine.ts) **never instantiates** (by design — a read is read-only).
  So tier 1 answers `no_state` forever; the walk steps inward to the root, which re-answers
  `Promoted(1)`, sending it back out to tier 1 — an unbroken root↔child loop until `maxSteps`.

`coord_0` is participant-independent (tier-0 caveat), so the inward step always re-hits the *same*
promoting root — there is no escape via a sibling.

### Reachability today vs. latent

In the current single-tier-0 milestone the production host hardcodes `followOn: false`
(`packages/db-p2p/src/cohort-topic/host.ts:797`; multi-tier follow-on derivation is parked as
`cohort-topic-followon-derivation`), so real multi-tier promotion is not yet wired and the loop is not
hit end-to-end in production. **But the defect lives in `walk.ts`, is reproducible with a unit-level
scripted router today, and becomes a live amplification vector the moment multi-tier promotion lands.**
`cohort-topic-followon-derivation` fixes the *register* path (instantiate-on-redirect); it does
**not** fix the probe, which by definition never instantiates and therefore needs its own termination
rule.

## Repro (drop-in walk unit test)

A `ScriptedRouter`-style cyclic router that answers `Promoted(targetTier: 1)` whenever
`reg.treeTier === 0` and `no_state` otherwise, driven by `engine.register(TOPIC, 1, undefined,
{ probe: true })` with `d_max = 4`, returns `retry_later` after ~`maxSteps` RPCs. Assert the RPC count
is bounded to a small constant (e.g. `≤ d_max + 3`) once fixed.

## Required behavior

A read-only probe that follows a `Promoted` redirect and then receives `no_state` at (or while walking
inward from) the redirect target must **terminate promptly with `retry_later`** ("the responsible
child cohort is not instantiated yet — back off"), rather than walking back inward to the promoting
ancestor and re-following the same redirect.

Candidate fix (in `RouterWalkEngine.register`): track whether the probe has already followed at least
one `Promoted` redirect; if so, a subsequent `no_state` resolves to `retry_later` immediately instead
of stepping inward. (Equivalently: a probe must never walk inward *past* a tier it was promoted to.)
The register path must be left unchanged — verify the existing "non-probe re-issues bootstrap at the
root" test still passes, and that a normal multi-tier register still terminates by instantiation.

Open design question for the implementer: is `retry_later`/`CohortBackoffError` the right *lookup*
answer for a topic that is demonstrably live (promoted, populated in other shards) but whose
prober-local child cohort is transiently absent — or should `lookup` instead resolve the nearest
served ancestor cohort (e.g. the promoting root's current participants) as the hint? Pick one and
document the contract; `CohortBackoffError` is acceptable but should be a deliberate choice, not a
fall-out of the loop.

## Acceptance

- New walk unit test reproducing the loop now bounds probe RPC count to a small constant on a
  promoted-but-unsharded topic.
- Register-path walk tests (bootstrap re-issue at root, normal accept) unchanged and green.
- `docs/cohort-topic.md` §Lookup note updated if the resolved-vs-backoff contract changes.
