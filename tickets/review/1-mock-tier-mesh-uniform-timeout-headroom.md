description: Review the uniform 120s timeout bump across the real-Ed25519 in-process mesh e2e test class in packages/db-p2p.
prereq:
files:
  - packages/db-p2p/test/reactivity/mesh-cold-to-hot.spec.ts (already 120s — verified, left as-is)
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts (60s → 120s)
  - packages/db-p2p/test/reactivity/mesh-partition-healing.spec.ts (60s → 120s)
  - packages/db-p2p/test/reactivity/mesh-mobile-resume.spec.ts (30s → 120s)
  - packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts (30s → 120s)
  - packages/db-p2p/test/matchmaking/mesh-lifecycle.spec.ts (60s → 120s; both describe blocks)
  - packages/db-p2p/test/matchmaking/mesh-sweep.spec.ts (30s → 120s)
  - packages/db-p2p/test/matchmaking/mesh-walk.spec.ts (30s → 120s)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (60s → 120s; judgment call)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts (30s → 120s; judgment call)
difficulty: easy
----

## What was done

Set `this.timeout(120_000)` uniformly across every describe block in the real-Ed25519 in-process mesh
e2e class (`reactivity/mesh-*`, `matchmaking/mesh-*`). Updated each adjacent comment to state the
shared rationale: these tests run serially in a single ~7-minute Node process; tests near the back of
the suite face a large GC-pressured heap, so wall-clock variance stacks on top of the isolation cost —
machine load, not a defect, threatens the clock. 120s is the uniform ceiling so no sibling becomes the
next whack-a-mole timeout victim.

`mesh-cold-to-hot` was already at 120s from commit `83ab553`; the value and comment were verified and
left unchanged.

## Judgment call to flag for the reviewer

`cohort-topic-scale-antiflood` and `cohort-topic-scale-lifecycle` were also bumped from 60s/30s to
120s as **insurance** even though they were not in the observed flake set. These tests drive the
cohort mesh with **virtual time** (documented "fast and deterministic") and were not seen flaking. They
share the same single-process Node heap as the mesh specs and still do real Ed25519, so raising them is
cheap, consistent insurance against them becoming the next relocation target.

The reviewer may prefer to revert these two to their original ceilings if the virtual-time claim fully
eliminates the load risk. The ticket intentionally flagged this as a judgment call rather than a hard
requirement.

## Validation performed

All 9 changed spec files were run in isolation; 47 tests passing, 8 pending (pre-existing skip tags),
0 failures:

- `test/reactivity/mesh-tail-rotation.spec.ts` — 7 passing
- `test/reactivity/mesh-partition-healing.spec.ts` — 4 passing
- `test/reactivity/mesh-mobile-resume.spec.ts` — 4 passing
- `test/reactivity/mesh-slow-subscriber.spec.ts` — 2 passing
- `test/matchmaking/mesh-lifecycle.spec.ts` — 6 passing
- `test/matchmaking/mesh-sweep.spec.ts` — 4 passing
- `test/matchmaking/mesh-walk.spec.ts` — 5 passing (+3 pending)
- `test/cohort-topic/cohort-topic-scale-antiflood.spec.ts` — 8 passing (+2 pending)
- `test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts` — 7 passing (+6 pending)

## Intentionally deferred

**Multi-run flake confirmation** is a CI/human job. The failure mode is intermittent over a ~7-minute
full suite run; a single isolated run cannot reproduce or confirm the fix. The change is validated
correct in isolation; CI confirms whether the flake is resolved over multiple runs.

**Direction 2 (serialize/quarantine the mesh e2e lane)** — a second mocha invocation or tagged lane to
give the mesh class a clean process — is the documented next step if 120s proves insufficient. It is a
CI-architecture change (new mocha invocations, root-hook coordination) that is larger, riskier, and
cannot be confirmed by an agent run. File a follow-up if flakes survive the 120s headroom.

## Pre-existing build error

`npx tsc --noEmit` in `packages/db-p2p` fails with a deprecation error from `tsconfig.json:19`
(`downlevelIteration` deprecated in TS 7.0). This predates the ticket — only spec comments and
`this.timeout()` values were changed; `tsconfig.json` is untouched. Documented in
`tickets/.pre-existing-error.md`.
