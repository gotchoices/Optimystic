description: Raised every real-Ed25519 in-process mesh end-to-end test to a uniform 120-second timeout so machine load on a long serial test run can't tip a passing test into a false timeout.
prereq:
files:
  - packages/db-p2p/test/reactivity/mesh-cold-to-hot.spec.ts (already 120s — verified, unchanged)
  - packages/db-p2p/test/reactivity/mesh-tail-rotation.spec.ts (60s → 120s)
  - packages/db-p2p/test/reactivity/mesh-partition-healing.spec.ts (60s → 120s)
  - packages/db-p2p/test/reactivity/mesh-mobile-resume.spec.ts (30s → 120s)
  - packages/db-p2p/test/reactivity/mesh-slow-subscriber.spec.ts (30s → 120s)
  - packages/db-p2p/test/matchmaking/mesh-lifecycle.spec.ts (60s → 120s; both describe blocks)
  - packages/db-p2p/test/matchmaking/mesh-sweep.spec.ts (30s → 120s)
  - packages/db-p2p/test/matchmaking/mesh-walk.spec.ts (30s → 120s)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (60s → 120s; insurance)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts (30s → 120s; insurance)
----

# Uniform 120s timeout across the real-Ed25519 in-process mesh e2e class

## Summary of completed work

The implement stage set `this.timeout(120_000)` uniformly across every describe block in the
real-Ed25519 in-process mesh e2e suites (`reactivity/mesh-*`, `matchmaking/mesh-*`) plus the two
`cohort-topic/*-scale-*` specs (as insurance), and rewrote each adjacent comment with the shared
rationale: the suite runs serially in a single ~7-minute Node process, so tests near the back face a
large GC-pressured heap and wall-clock variance stacks on the isolation cost — machine load, not a
defect, threatens the clock. `mesh-cold-to-hot` was already at 120s and was left unchanged.

The change is test-only: nothing but `this.timeout()` literals and comments. No production code, no
harness code, no config touched.

## Review findings

### What was checked

- **Diff scope / correctness.** Reviewed `git show 4534296` in full. The diff is exclusively
  `this.timeout()` value changes and comment rewrites across 9 spec files; no functional/source/config
  lines. Confirmed all 11 in-scope describe blocks (9 mesh-* + 2 cohort-scale) plus the pre-existing
  `mesh-cold-to-hot` now read `this.timeout(120_000)` via a repo-wide grep — uniformity is real and
  complete for the named class.
- **Tests.** Ran all 9 changed spec files together via mocha: **47 passing, 8 pending, 0 failing**
  (15s wall-clock in isolation — confirming the implementer's thesis that per-test cost is small and
  the flake is full-suite load variance). The 8 pending are pre-existing `DOC EXPECTATION NOT YET
  IMPLEMENTED` skip tags, unrelated to this ticket.
- **Typecheck.** `./node_modules/.bin/tsc --noEmit` (package-local TS 5.9.3) exits 0 — clean.
- **Pre-existing build error.** The implement-stage `npx tsc` "failure" was already triaged in commit
  `1f10d5a` to `tickets/backlog/tsconfig-downleveliteration-ts6-forward-compat.md`: it is an `npx`
  resolution artifact (a stray global TS 6.0.3 vs the pinned local 5.9.3 that builds clean), not a real
  failure. Independently reconfirmed here — local tsc exits 0. No `.pre-existing-error.md` remains and
  none needs to be written.

### Findings

- **Minor — none requiring an inline fix.** The change is correct and minimal.

- **Observation (accepted, not actioned): scope boundary.** Two other real-Ed25519 in-process
  cohort-topic specs in the same Node heap were *not* bumped — `cohort-topic/live-tier.spec.ts` (15s,
  plus a nested 15s) and `cohort-topic/host-node-activation.spec.ts` (40s). Leaving them is the right
  call: they use lighter single-cohort harnesses (not the multi-cohort `build*Mesh` harnesses), were
  not in the observed flake set, and carry their own tuned ceilings. Blanket-raising every timeout to
  120s would erode the timeout's value as a genuine-hang signal. The implementer's comment phrase
  "full real-Ed25519 mesh e2e class" should be read as the mesh-* + cohort-scale set this ticket
  addresses, not literally every real-crypto cohort spec. No change made; flagged for future awareness
  if those two ever start flaking.

- **Observation (accepted, not actioned): DRY.** The 4-line rationale comment and the `120_000`
  literal are repeated verbatim across 11 describe blocks. A shared constant would be DRYer, but the
  blocks span three independent harness directories with no common test-utils module, and mocha's
  `this.timeout()` needs the per-suite function context. Introducing a cross-directory constants module
  for a test timeout is over-engineering relative to the change. Left as-is.

- **Major — none.** No new fix/plan/backlog tickets filed.

### Disposition

Clean pass. No inline fixes were necessary and no new tickets were spawned. The one pre-existing build
error in the area is already triaged to backlog. The remaining open item — multi-run flake
confirmation over the full ~7-minute suite, and the larger Direction-2 serialize/quarantine lane if
120s proves insufficient — is correctly deferred to CI/human as documented by the implementer; it is
intermittent over a long full run and not confirmable from a single agent run.
