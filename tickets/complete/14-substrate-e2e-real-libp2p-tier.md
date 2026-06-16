description: A new opt-in test suite spins up a handful of real networked nodes (over real TCP) and checks that the peer-group substrate behaves correctly over a real network — group assembly, signed membership proof, and gossip replication — at small scale, complementing the existing fast in-memory simulation tests.
files:
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (new, reviewed)
  - packages/db-p2p/src/cohort-topic/protocols.ts (verified: 5 protocols, no query/notify)
  - packages/db-p2p/src/cohort-topic/host.ts (verified: no QueryV1 handler registered)
  - packages/db-p2p/src/libp2p-node-base.ts (verified: emit transport deferred to sibling ticket)
  - docs/architecture.md, docs/cohort-topic.md, docs/matchmaking.md, docs/reactivity.md (doc sync verified)
  - tickets/backlog/matchmaking-real-libp2p-query-transport.md (new gap ticket, verified well-formed)
----

# Complete: substrate real-libp2p e2e fidelity tier

## What landed

An **env-gated** integration spec, `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`,
stands up **3–16 production `createLibp2pNode({ cohortTopic: { enabled: true } })` nodes over real TCP**
and exercises the cohort-topic / reactivity / matchmaking substrate against real FRET stabilization and the
real cohort-topic protocols. It is the high-fidelity, small-N counterpart to the three mock-tier suites:
the mock tier proves behavior at scale with in-process routing; this tier proves the piece the mock mesh
stubs behaves over real sockets. **No production code was changed** — test + docs only. Gate:
`OPTIMYSTIC_INTEGRATION=1` / `RUN_LONG_TESTS=1`; the whole `describe` is `describe.skip` when ungated, so
the default `yarn test` brings up no real node.

Also filed: `tickets/backlog/matchmaking-real-libp2p-query-transport.md` (the missing `/query` cohort
protocol + seeker-walk binding the matchmaking skip depends on).

## Review findings

### What was checked

- **Read the implement-stage diff first** (commit `c34032d`) with fresh eyes — the full 546-line spec, all
  four doc edits, and the new backlog ticket — before the handoff summary.
- **Verified every load-bearing claim against production source** rather than trusting the handoff:
  - `protocols.ts` registers exactly **five** cohort-topic protocols (`register`, `cohort-gossip`,
    `promote`, `membership`, `sign`) — **no `query`, no `notify`/`emit`** protocol. ✓
  - `host.ts` registers **no `QueryV1` RPC handler** (only a comment references one) — the matchmaking
    seeker-query skip is honest. ✓
  - `libp2p-node-base.ts:764` explicitly states "installing the origination manager + emit transport is a
    sibling ticket"; the bridge no-ops at `if (!hook) return;` until a consumer attaches — the reactivity
    delivery skip is honest. ✓
- **Build:** `yarn build` (db-p2p, tsc 5.9.3) exit 0 — the spec type-checks under `strict` +
  `noUncheckedIndexedAccess` (tsconfig `include` covers `test/`).
- **Gated suite re-run independently:** 7 passing / 3 pending / 0 failing. **Re-ran for flakiness — 3× at
  N=4 and 1× at N=8, all stable, zero flakes** (~2 s / ~4 s). The connectivity + retry fix holds on this
  machine.
- **Default suite re-run:** **726 passing, 27 pending, 0 failing (~44 s)** — the +10 pending vs. the prior
  17 are exactly this gated suite (skipped when ungated). The `… parent unreachable` console line is the
  pre-existing intentional negative-test log in `host-antidos-coldstart.spec.ts`, emitted during a passing
  test, **not a failure** (0 failing confirmed).
- **Lint:** the repo's `lint` script is a no-op stub (`echo 'Lint not configured'`); `tsc --strict` via
  `yarn build` is the effective static check and passed.
- **Doc sync:** read all four edited docs end-to-end. The Doc Sync Status table reads honestly
  (cohort-topic **done**; reactivity **substrate done / delivery deferred**; matchmaking **substrate done /
  query deferred**) with deferred seams + trackers named. **All cross-referenced tickets exist:**
  `matchmaking-query-rate-limit`, `optimystic-network-reactive-watch-integration-test` (backlog),
  `12.5-reactivity-tail-rotation-transport` (plan). No stale "real-libp2p pending" reference survives.
- **Resource cleanup:** the `after` hook stops every spawned node and runs even if `before` throws
  (mocha semantics) — no node leak across the suite.
- **Skip honesty:** all three `it.skip` titles carry the production-gap reason + tracker; none fake a
  passing assertion.

### What was found

- **No major findings.** The two production gaps (matchmaking `QueryV1` transport, reactivity emit
  transport) are real, are correctly surfaced as tagged skips rather than faked, and are already filed —
  `matchmaking-real-libp2p-query-transport` (newly filed here, well-formed, references the right seams) and
  `12.5-reactivity-tail-rotation-transport` (existing). No new ticket needed beyond these.
- **Minor (no fix warranted — honestly flagged by the implementer, deliberate small-N milestone choices):**
  - **Consistency test (#7) is weakened at `wantK = N`.** With exactly N nodes and `wantK = N`,
    `assembleCohort(coord, N)` returns the whole mesh for *every* coord, so the "different coords" dimension
    is partly trivial. It still genuinely asserts cross-node FRET convergence (a node that hadn't stabilized
    would return `< N` members), which is the real claim. The handoff documents this caveat explicitly and
    is careful **not** to over-claim a "cohort == transaction cluster for the same key" invariant (those
    hash to different coords by design). Left as-is.
  - **Engine-level vs. transport-level boundary (tests #4, #6).** These drive `engine.handleRegister` as a
    local call on the routed primary, while the willingness seed and record replication ride real
    `/cohort-gossip`. The full FRET-routed `service.register` walk is deliberately kept mock-tier-
    deterministic (a tagged skip) to avoid small-N routing flakiness. Acceptable for the milestone; the
    cohort-side admission it would drive *is* asserted over the real willingness quorum.
  - One bounded 300 ms settle after a willingness gossip wave is not load-bearing for correctness — the
    subsequent `quorumOn` bounded `waitFor` (20 s, plus a second seed-wave fallback) is what gates the
    assertion. Not a flake source in 4 runs.

### What was done

- Re-ran build, gated suite (4×, two N values), and the full default suite — all green; verified the three
  skip rationales directly in production source; confirmed all cross-referenced tickets exist and the docs
  are accurate. **No inline code changes were necessary** — the implementation is clean, well-commented,
  cleans up its resources, type-checks under strict, and its tests are stable. **No new fix/plan tickets
  filed** beyond the implementer's already-correct backlog ticket.

## What is real over the wire (the 7 passing tests)

1. **FRET cohort assembly + coordinate derivation** — real two-sided stabilization assembles the
   whole-mesh tier-0 cohort (`wantK = N`); every node derives one identical coord + epoch (the determinism
   threshold signing depends on).
2. **MembershipCertV1 verify end-to-end** — a routed primary collects a genuine `(N−1)`-of-`N` threshold
   `MembershipCertV1` over the real `/sign` RPC, serves it over `/membership`, and a remote participant's
   verifier verifies the real collected multisig; a forged single-signer cert is `untrusted`.
3. **Stale-cert one-fetch-and-retry** — a stale cached cert forces exactly one real `/membership` refetch,
   which then verifies.
4. **Cohort-gossip record replication** — a record admitted on the routed primary (over the real
   willingness quorum) replicates into a sibling store over real `/cohort-gossip`; the sibling becomes a
   warm-failover target.
5. **Reactivity origination gate over real FRET** — the production bridge is installed and the real
   `selfIsCohortMember` gate agrees node-for-node with the assembled reactivity cohort.
6. **Matchmaking provider record** — a T2 provider registration is admitted by a real cohort, held by the
   primary, and replicates to a sibling over `/cohort-gossip`.
7. **Same-FRET-ring consistency** — every node agrees on the assembled cohort for several coords (one ring,
   not per-node disagreement).

## Honest real-vs-modeled boundary (the 3 skips — verified production gaps, not faked)

- **Reactivity notification socket delivery** — origination bridge fires `onLocalCommit` and the build +
  verify path is real, but no emit transport / delivery protocol is registered in production
  (`libp2p-node-base.ts:764`). Tracked by `plan/12.5-reactivity-tail-rotation-transport` + backlog
  `optimystic-network-reactive-watch-integration-test`.
- **Matchmaking seeker `QueryV1` walk** — no `QueryV1` RPC handler registered on a production node. New
  backlog ticket `matchmaking-real-libp2p-query-transport` filed for the `/query` cohort protocol + seeker
  binding.
- **Full FRET-routed participant `service.register` walk** — kept mock-tier-deterministic
  (`live-tier.spec.ts` test 2) to avoid small-N FRET-routing flakiness; the cohort-side admission it would
  drive is asserted here over the real willingness quorum (test 4).

## Real-network observations

- **Full-mesh warm connectivity is load-bearing for `/sign`.** A star (leaf→bootstrap-only) topology left
  leaf↔leaf `/sign` dials cold and intermittently fell short of signing quorum; the `before` hook
  establishes an explicit full mesh of warm connections and the cert publish retries past transient
  sub-quorum rounds. A genuine real-transport finding (documented in `docs/cohort-topic.md` §Validation) —
  recovered by connection establishment + the next round, never a fabricated sub-quorum cert.
- **Stateful membership publisher.** `onStabilized` publishes the cert once in `before` and reuses it; a
  later `undefined` return is correct (no-op republish), not a bug.
- **Timing.** Small-N stabilization + threshold-cert is bounded and fast (~2 s @ N=4, ~4 s @ N=8, ~11 s @
  N=16), matching the simulator's "non-instant but bounded" expectation.

## Known gaps / not done (flagged, not papered over)

- Reactivity socket delivery + matchmaking query RPC are not validated over real sockets (production seams
  absent) — tracked as above.
- The full FRET-routed participant walk and multi-tier promotion are not at the real tier (small-N routing
  flakiness / single-tier-0 milestone) — covered deterministically at mock tier.
- Membership-rotation primary handoff via real FRET departure (epoch rotation on node-leave) is not
  asserted — real churn-detection latency makes it timing-bound / not agent-runnable; the cohort-side
  handoff readiness IS asserted, and crash-failover is mock-tier-covered.

## End
