description: The in-process test that simulates many cohort nodes drives all of its timing from a fake clock, except for one component (the gossip message bus) that still reads the real wall clock — which works today but would make the test fail intermittently if the suite ever ran longer than 90 seconds.
files:
  - packages/db-core/src/cohort-topic/gossip/bus.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts
difficulty: medium
----

# Inject a virtual clock into the cohort gossip bus (close the mock-tier wall-clock dependency)

## Background

The cohort-topic mock-tier-at-scale harness (`cohort-topic-mesh-harness.ts`, added by
`cohort-topic-e2e-mock-tier`) is virtual-clock-driven: TTL eviction, renewal, gossip rounds, and
demotion hysteresis are all advanced by an explicit `now` passed to engine methods, never by sleeping.

One seam escapes the virtual clock. The inbound gossip bus (`gossip/bus.ts`) accepts an injectable
`now?: () => number` but **defaults to `Date.now()`**, and the FRET host (`host.ts`) does not inject
one. So when a replicated gossip frame arrives, `mergeRecords` compares the **real** wall clock against
the frame's `lastPing` to drop TTL-dead records (`bus.ts` line ~177:
`if (now - incoming.lastPing > incoming.ttl) continue`).

The harness works around this by basing its virtual-clock origin on `Date.now()` rather than a
synthetic constant (`const T0 = Date.now()` in both scale specs, with an explanatory comment). Relative
TTL math stays deterministic; only the absolute base tracks wall time.

## The latent problem

If the whole suite ever runs **longer than `ttl` (90 s)** between a record being stamped and its
replication merge, the real-clock guard would spuriously treat the record as dead and drop it on
replication — a flaky replication failure that depends on machine speed / CI load, not on logic. The
current suites run in ~3 s, so it does not bite today; this is a robustness/maintenance concern, not an
active failure.

## What to do

Give the FRET host a seam to inject the gossip bus's clock, and have the harness pass the same virtual
clock it already threads through the engine methods. Then the mock-tier suites can use a synthetic
`T0` (e.g. a fixed constant) instead of `Date.now()`, making them fully wall-clock-independent.

Note this is purely a test-determinism / seam concern. Production behavior is correct as-is — the bus
*should* use the real clock in a live node; this only adds the injection point the virtual-clock
harness needs.

## Acceptance

- `host.ts` exposes a way to inject the gossip bus `now` (plumbed from host options), defaulting to the
  real clock when unset (no production behavior change).
- The harness threads its virtual clock into the bus; the scale specs switch `T0` from `Date.now()` to
  a synthetic constant and drop the explanatory wall-clock comments.
- Re-running the scale suites under an artificially long virtual-time span (stamp-to-merge gap > 90 s)
  no longer drops replicated records.
- `docs/cohort-topic.md` §Validation's note about the wall-clock base is updated to reflect the fix.
