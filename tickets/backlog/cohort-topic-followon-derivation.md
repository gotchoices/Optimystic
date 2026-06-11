description: Decide how the db-p2p cohort host derives the `followOn` signal for cold-start admission — distinguishing a Promoted follow-on register from a speculative d_max probe at a cold tier-(d+1) cohort — and whether RegisterV1 needs a wire field for it.
prereq:
files:
  - packages/db-core/src/cohort-topic/coldstart.ts (shouldInstantiate / ColdStartTrigger.followOn)
  - packages/db-core/src/cohort-topic/walk.ts (WalkEngine — the participant side that follows a Promoted redirect)
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1 — today carries only `bootstrap`)
  - docs/cohort-topic.md (§Cold-start instantiation, §Lookup, §Wire formats)
  - packages/db-p2p/src (future: cohort-topic service host — the ITopicRouter / cold-start binding)
difficulty: hard
----

# Decide how `followOn` is determined for cold-start admission

## Context

The cold-start admission gate `shouldInstantiate({ bootstrap, followOn, quorumWilling })` (db-core
`coldstart.ts`) instantiates a cold cohort as a forwarder only when the inbound `RegisterV1` is a
legitimate **growth point** — either the root `bootstrap` case **or** a `followOn`: a register that
arrived because a parent cohort redirected the participant with `Promoted(d+1)`.

`bootstrap` is a real wire field on `RegisterV1`. **`followOn` is not** — `RegisterV1` carries no
signal that distinguishes a `Promoted`-driven follow-on from a *speculative* `d_max` probe that
happens to land on a cold tier-`(d+1)` cohort. db-core therefore takes `followOn` as an explicit
boolean input to `shouldInstantiate` and leaves its derivation to the db-p2p cohort host, which has
the routing context. **That derivation is currently unspecified** — it is the single biggest open
item flagged by the implement handoff for the walk/promotion/cold-start work.

## Why it matters (the correctness consequence)

Without a correct `followOn`, a participant joining a freshly-promoted topic whose tier-`(d+1)` child
is not yet instantiated cannot converge:

1. The promoted tier-`d` cohort replies `Promoted(d+1)`.
2. The participant walks outward to `coord_(d+1)` — a cold cohort.
3. With `followOn = false` the cold cohort fails the admission gate and returns `NoState`.
4. The walk steps back inward to tier `d`, hits the still-promoted cohort, gets `Promoted(d+1)` again
   — an oscillation that only the `maxSteps` safety valve halts, surfacing `retry_later`.

So until `followOn` is derivable, that join path never succeeds; it only backs off and retries. The
db-core logic is internally consistent (and the oscillation is bounded — see the `maxSteps` regression
test added in the 9.6 review), but end-to-end cold-tier promotion is blocked on this decision.

## The question

How does the cohort host know an inbound register is a `Promoted` follow-on rather than a speculative
probe? Candidate directions to weigh (not exhaustive):

- **Wire field on `RegisterV1`** — e.g. a `followOn: true` / `redirectedFrom: <coord|tier>` flag the
  participant sets when it re-registers after a `Promoted` reply. Simplest to reason about, but it is
  **participant-asserted** — an attacker could set it to force speculative cold-start (anti-flood
  concern; coordinate with `cohort-topic-antiflood-antidos`). Touches §Wire formats and the wire
  ticket.
- **Host-side routing inference** — the cohort host infers follow-on from FRET routing context
  (was this register routed here as the redirect target of a coord this cohort just promoted?).
  Keeps the wire unchanged but needs the host to retain short-lived promotion/redirect state.
- **Correlation via the promoting parent** — the parent that emitted `Promoted(d+1)` vouches for the
  follow-on out of band (gossip / a signed redirect token the participant presents). Strongest against
  spoofing, heaviest to build.

Resolve which mechanism the db-p2p binding uses, whether it requires a `RegisterV1` wire change
(and therefore a revisit of the wire ticket), and how it interacts with anti-flood admission. The
decision is a prerequisite for `cohort-topic-core-module-fret-integration` to wire a correct
cold-start path.
