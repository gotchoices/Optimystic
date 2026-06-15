description: Build a validity-envelope model in the substrate-simulator — systematically locate and characterize the boundaries (critical parameter values) at which each design claim transitions from holding to breaking, turning today's single-point pass/fail claims into boundary curves that define the operating regime in which the design model holds. Fold the boundaries back into the design docs as an explicit "operating envelope" per subsystem.
difficulty: hard
files:
  - packages/substrate-simulator/src/scenarios.ts
  - packages/substrate-simulator/src/sweep.ts
  - packages/substrate-simulator/src/promotion-convergence.ts
  - packages/substrate-simulator/src/partition.ts
  - packages/substrate-simulator/src/reactivity.ts
  - packages/substrate-simulator/src/matchmaking.ts
  - packages/substrate-simulator/src/seeker-walk.ts
  - packages/substrate-simulator/src/walk.ts
  - docs/cohort-topic.md
  - docs/reactivity.md
  - docs/matchmaking.md
----

# Build a validity-envelope model for the design simulator

The simulator today proves each design claim *holds at its nominal operating point*. It does not
say *for what range of conditions* the claim holds, nor *where it breaks*. This ticket adds that:
a model of the **operating envelope** — the conditions and boundaries within which the substrate's
quantitative design claims are valid — and folds the boundaries back into the design docs.

## Why this is a separate ticket from adversariality-hardening

Two distinct questions, two tickets:

- **`simulator-strengthen-scenario-adversariality`** asks *does each claim genuinely hold at its
  configured operating point?* — it removes structural guarantees so the pass/fail signal is
  emergent, and pins the one unexercised promotion path. It does not move the operating point.
- **This ticket** asks *for what range of conditions does each claim hold, and exactly where does
  it break?* It sweeps a stress axis until a claim flips pass→fail, records that critical value,
  and reports the **margin** between it and the operating point the design assumes.

They are complementary, not redundant. Landing the adversariality ticket first improves this one's
signal (the boundary-finder is then locating the edge of a claim with teeth), but it is a
cross-reference, not a hard prereq.

## Three validation modes — this adds the third

1. **Absolute-target** (the fold-back's job): "depth == 4 at N = 1M." A point check against a number.
2. **Relationship / monotonicity** (`sweep.ts`): "more `cap_promote` ⇒ shallower tree." Direction
   only — deliberately not magnitude, not breakpoint.
3. **Boundary / envelope** (this ticket): "`root-not-overloaded` holds for arrivals-per-round
   `R < R*`; at `R ≥ R*` cumulative overshoot exceeds one round." The *critical value* and the
   *margin* to the design's assumed operating point.

The headline output is not "the claim passes" but "the claim has this much slack before it breaks" —
which is the actual engineering answer to *under what conditions does the model hold*.

## What a boundary readout looks like

A boundary-finder drives a single **stress axis** (monotone in harm) against an otherwise-nominal
config, locating the value at which a target claim flips pass→fail (scan or bisection over the
virtual clock — cheap and deterministic from `(seed, config)`). Per `(claim, axis)` it emits roughly:

```ts
interface EnvelopeBoundary {
  claim: string;             // e.g. 'root-not-overloaded'
  axis: string;              // e.g. 'arrivalsPerRound'
  criticalValue: number;     // last value at which the claim still holds — the envelope edge
  designAssumption: number;  // the operating point the design assumes (from the doc / DEFAULT_*)
  margin: number;            // criticalValue − designAssumption (or a ratio); > 0 ⇒ design sits inside the envelope
  monotoneDirection: 'increasing-harm' | 'decreasing-harm';
}
```

`designAssumption` + `margin` are the point: they state how much room each guarantee has before it
breaks. Where today the docs say "depth == 4," the envelope says "the depth law holds for `R < R*`,
churn `< C*`, …".

## Candidate envelope dimensions (the boundaries to characterize)

| Subsystem / claim | Stress axis (monotone in harm) | Boundary we expect to find |
|---|---|---|
| tree `root-not-overloaded` / depth-law | arrivals per gossip round `R` | `R*` past which cumulative tier-0 overshoot exceeds one round, and cold max-hops exceeds `d_max + 2` (lookahead-ON transient ≈ `2·d_max`) |
| depth-law | peer-ID prefix skew (hot-shard non-uniformity) | skew at which observed depth diverges from `⌈log_F(N/cap_promote)⌉` |
| promotion/demotion stability | arrival↔departure churn vs `T_demote` hysteresis | churn rate at which the tree flaps (promote/demote oscillation) instead of settling |
| walk `no-give-ups` / hop bound | fraction of members replying `UnwillingMember`/`UnwillingCohort` | unwilling fraction at which walks give up or hops blow past the bound |
| churn `no-lost-registrations` | member-kill rate × timing vs renewal window (`ttl/3`) | kill rate / stagger at which failover loses a registration (backups exhausted, or failover races renewal and loses) |
| churn `heal-convergence` | partition duration × concurrent membership change | partition/concurrent-churn at which heal fails to re-converge on one deterministic primary within a renewal window |
| reactivity `revision-continuity` | commit rate `cps` vs replay window `W` | `cps*` at which `W` stops covering a subscriber reconnect gap |
| reactivity tail-rotation drain | `T_rejoin_jitter / T_drain` ratio | ratio at which the re-registration wave fails to drain before the old tail stops forwarding |
| matchmaking bounded-harm | fraction of cohort reporters lying (incl. per-query flip) | adversary fraction past which mis-report harm is no longer bounded by `patienceMs` / `+1 hop/tier` |
| matchmaking hang-out fairness | seeker-pool contention (seeker:provider ratio) | ratio at which real contention exceeds `contention_factor_cap = 4` and the decision misfires |

## Expected artifact & fold-back

- A boundary-report module (sibling to `sweep.ts`) emitting `EnvelopeBoundary[]` plus a `Metrics`
  export, deterministic from `(seed, config)`.
- A separate doc fold-back ticket (mirroring `fold-simulator-findings-into-design-docs`) adds an
  **Operating envelope** subsection to `cohort-topic.md` / `reactivity.md` / `matchmaking.md` stating,
  per claim, the critical value and the margin to the nominal operating point.

## Use cases

- A reader/operator sees the slack each guarantee has before it breaks (capacity planning, parameter
  selection).
- A regression in a stress-handling code path moves a boundary *inward* — caught as a margin shrink,
  not just a single-point flip.
- The boundaries become the principled justification for the default parameter values
  (`cap_promote`, `F`, `T_demote`, `W`, `contention_factor_cap`): each default justified by the
  envelope margin it buys.

## Relationship to other tickets (cross-refs, not prereqs)

- `simulator-strengthen-scenario-adversariality` — complementary; harden the point-claims first so
  the boundary-finder locates the edge of a real claim.
- `cold-start-storm-default-claim-semantics` — the `R*` boundary above is the principled answer to
  that ticket's "what is actually bounded" question.
- `matchmaking-contention-from-seeker-pool`, `matchmaking-per-tier-patience-splitting` — the
  seeker-pool-contention and adversary-fraction boundaries quantify whether those deferred
  refinements are needed.

## Notes

- Reuse the existing drivers (`runConvergence`, `ParticipantWalk`, `TopicTree`, `checkConvergence`,
  `simulateRotationBurst`, `SeekerWalk`, the `Metrics` sink). This is new *measurement*
  (boundary-finding) over the existing model, not new modeling.
- Keep it deterministic and agent-runnable: scan/bisect on the virtual clock; gate the expensive
  full-tree axes (prefix-skew, unwilling-fraction) by N as `sweep.ts` already does.
- Scope spans all three subsystems by design; the plan stage should split it into per-subsystem
  boundary tickets chained by `prereq:`, plus the doc fold-back ticket — do not land it as one
  oversized implement ticket.
