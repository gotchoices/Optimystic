description: A new opt-in test suite spins up a handful of real networked nodes (over real TCP) and checks that the peer-group substrate behaves correctly over a real network — group assembly, signed membership proof, and gossip replication — at small scale, complementing the existing fast in-memory simulation tests.
files:
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (new)
  - packages/db-p2p/test/real-libp2p.integration.spec.ts (pattern reused)
  - packages/db-p2p/test/util/relay-topology.ts (pattern reused)
  - packages/db-p2p/src/libp2p-node-base.ts (cohortTopic activation — exercised, not changed)
  - packages/db-p2p/src/cohort-topic/host.ts (host engines/protocols — exercised, not changed)
  - docs/architecture.md (Doc Sync Status: Real-libp2p e2e column)
  - docs/cohort-topic.md (§Validation — real-libp2p tier + real-network observations)
  - docs/reactivity.md (§Real-libp2p e2e coverage)
  - docs/matchmaking.md (§Real-libp2p e2e coverage)
  - tickets/backlog/matchmaking-real-libp2p-query-transport.md (new — filed gap)
----

# Review: substrate real-libp2p e2e fidelity tier

## What landed

A new **env-gated** integration spec, `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`,
stands up **3–16 production `createLibp2pNode({ cohortTopic: { enabled: true } })` nodes over real TCP**
and exercises the cohort-topic / reactivity / matchmaking substrate against real FRET stabilization and
real cohort-topic protocols. It is the high-fidelity, small-N counterpart to the three mock-tier suites:
the mock tier proves behavior at scale with in-process routing; this tier proves the **piece the mock mesh
stubs** behaves over real sockets. No production code was changed — this ticket is test + docs only.

Gate: `OPTIMYSTIC_INTEGRATION=1` or `RUN_LONG_TESTS=1` (same gate as `real-libp2p.integration.spec.ts`).
Skips cleanly otherwise — the whole `describe` is `describe.skip` when ungated, so **no real node is even
brought up** in the default `yarn test`.

## How to run / validate

```
# from packages/db-p2p
yarn build                 # tsc; tsconfig include = ["src","test"], so the spec IS type-checked (strict)
yarn test                  # default suite — gated spec skips cleanly
OPTIMYSTIC_INTEGRATION=1 yarn test:integration                 # runs this spec (+ the other *.integration.spec.ts)
# or just this file:
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/substrate-real-libp2p.integration.spec.ts" --reporter spec
# wider real run (default N=4): OPTIMYSTIC_SUBSTRATE_N=8 (clamped to 3..16)
```

**Verification I actually ran (all green):**
- `yarn build` (db-p2p, tsc 5.9.3): exit 0 — the spec type-checks under `strict` + `noUncheckedIndexedAccess`.
- Default `yarn test` (full db-p2p): **726 passing, 27 pending, 0 failing (~44 s)**. The +10 pending vs. the
  prior 17 are exactly this gated suite (10 `it`s, all pending when ungated). The
  `cohort-topic cold-start: … parent unreachable` line is the pre-existing intentional negative-test log in
  `host-antidos-coldstart.spec.ts`, not a failure.
- Gated suite: **7 passing, 3 pending (honest skips), 0 failing**, validated at **N ∈ {3, 4, 8, 16}**
  (~2 s / 2 s / 4 s / 11 s) and **re-run 4× at N=4 with zero flakes** after the connectivity fix below.

## What is real over the wire (the 7 passing tests — the floor, treat as a starting point)

1. **FRET cohort assembly + coordinate derivation** — real two-sided stabilization assembles the whole-mesh
   tier-0 cohort (`wantK = N`); **every node derives one identical coord + epoch** (the determinism threshold
   signing depends on). This is precisely what the mock mesh stubs (it just XOR-sorts).
2. **MembershipCertV1 verify end-to-end** — a routed primary collects a genuine `(N−1)`-of-`N` threshold
   `MembershipCertV1` over the real `/sign` RPC, serves it over `/membership`, and a *remote* participant's
   `service.verifier()` verifies the real collected-multisig. A forged single-signer cert is `untrusted`.
3. **Stale-cert one-fetch-and-retry** — priming the verifier with a stale cached cert forces exactly one
   real `/membership` refetch, which then verifies.
4. **Cohort-gossip record replication** — a record admitted on the routed primary (over the real willingness
   quorum) replicates into a sibling store over real `/cohort-gossip`; the sibling becomes a warm-failover
   target (the cohort-side half of primary handoff).
5. **Reactivity origination gate over real FRET** — the production bridge is installed
   (`blockChangeNotifier` is the decorating notifier) and the real `selfIsCohortMember` gate agrees
   node-for-node with `assembleCohort(coord_0(H(tail ‖ "reactivity")), wantK)`.
6. **Matchmaking provider record** — a T2 provider registration is admitted by a real cohort, held by the
   primary (`records()`), and replicates to a sibling over `/cohort-gossip`.
7. **Same-FRET-ring consistency** — for several coords, every node agrees on the assembled cohort (one ring,
   not per-node disagreement) — the consistency a cross-layer (substrate ↔ transaction) read depends on.

## Honest real-vs-modeled boundary (the 3 skips — NOT faked, tagged with trackers)

Two of the parent ticket's six scenarios need **production wiring that does not exist yet**; one is a
deliberate scope choice. All three are `it.skip` with the reason + tracker in the title:

- **Reactivity notification *socket delivery*** — the origination bridge fires `onLocalCommit` and the build
  + verify path is real, but **no emit transport / subscriber-delivery libp2p protocol is registered in
  production** (`libp2p-node-base.ts` leaves "the origination manager + emit transport" to a sibling ticket).
  Tracked by `plan/12.5-reactivity-tail-rotation-transport` + backlog
  `optimystic-network-reactive-watch-integration-test`.
- **Matchmaking seeker `QueryV1` walk converging to a match** — a production node registers **no `QueryV1`
  RPC handler**; the seeker walk's `query()` seam is unbound. I **filed a new backlog ticket**
  `matchmaking-real-libp2p-query-transport` for the missing `/query` cohort protocol + seeker binding.
- **Full FRET-routed participant `service.register` walk** — deliberately kept mock-tier-deterministic
  (`live-tier.spec.ts` test 2) to avoid small-N FRET-routing flakiness; the cohort-side admission it would
  drive **is** asserted here over the real willingness quorum (test 4).

## Real-network observations worth a reviewer's eye

- **Full-mesh warm connectivity is load-bearing for `/sign`.** Initial runs flaked in the `before` hook
  ("gathered 2 of 3 required signatures"): a star (leaf→bootstrap-only) topology left leaf↔leaf `/sign`
  dials to resolve cold when the routed primary was a leaf, so the threshold collection fell short of quorum.
  Fix: `before` establishes an explicit full mesh of warm connections (every node dials every other's TCP
  addr) and waits for `getPeers() >= N-1`, and the cert publish retries past transient sub-quorum rounds
  (`publishCohortCert`). This is a genuine real-transport finding (documented in `docs/cohort-topic.md`
  §Validation): a cohort that has not yet inter-connected can briefly fail to reach signing quorum, recovered
  by connection establishment + the next round — never a fabricated sub-quorum cert (the
  sub-quorum-throws negative still holds).
- **Stateful membership publisher.** `onStabilized` publishes once (it republishes only when the first
  `k − x` members change), so the cert is published **once in `before`** and reused; it stays served on the
  primary's `/membership` for the remote-fetch tests. A second `onStabilized` returning `undefined` is
  correct behavior, not a bug.
- **Timing.** Stabilization + threshold-cert at small N is fast and bounded (seconds, not minutes), matching
  the simulator's "non-instant but bounded" expectation. The suite uses bounded polling with generous
  timeouts throughout — no fixed sleeps for correctness (one 300 ms settle after a willingness gossip wave).

## Suggested review focus (your tests are a floor, not a finish line)

- **Re-run the gate yourself**, ideally a few times and at a couple of N values, to confirm the
  connectivity/retry fix holds on your machine (real-transport timing is environment-sensitive). If you see
  a flake, the first suspects are the `before` connectivity bound (90 s FRET stabilize / 60 s connect) and
  the willingness seed (`WILLING_SIBLINGS_NEEDED = floor(N/2)`).
- **Challenge the `it.skip` rationales** — confirm there really is no production `QueryV1` handler / emit
  transport (grep `host.ts` protocol registration; `libp2p-node-base.ts` cohortTopic block) so the skips are
  honest and the new `matchmaking-real-libp2p-query-transport` ticket is warranted (not a duplicate).
- **Scrutinize the "consistency" test (#7).** It asserts same-ring determinism, NOT that the reactivity-topic
  coord equals a block's transaction-key coord (they hash to *different* coords by design — see the test's
  comment). If the parent ticket intended a stronger literal "cohort == transaction cluster for the same key"
  invariant, that is not a true invariant over different coords; confirm the weaker, real claim is the right one.
- **Engine-level vs. transport-level.** Tests 4 and 6 drive `engine.handleRegister` directly (a local call on
  the routed primary) but exercise real transport for the willingness seed (`/cohort-gossip`) and the record
  replication (`/cohort-gossip`). Confirm that boundary is acceptable, or push toward the full
  router-driven `service.register` (the skipped participant walk) if you want the register hop itself on the wire.

## Doc sync (final, all three subsystems)

- `docs/architecture.md` Doc Sync Status: the **Real-libp2p e2e** column now reads — cohort-topic **done**;
  reactivity **substrate done / delivery deferred**; matchmaking **substrate done / query deferred** — with
  the deferred seams + trackers named. (Honest "complete": the substrate is fully real over the wire; the two
  application-transport seams are explicitly unwired-and-tracked, not silently claimed.)
- `docs/cohort-topic.md` §Validation: new real-libp2p tier paragraph + a "real-network observations" block
  (confirmed-on-real-libp2p timings; the warm-connectivity finding; the tagged skips).
- `docs/reactivity.md` + `docs/matchmaking.md`: new §Real-libp2p e2e coverage subsections (what's confirmed
  real, what's deferred + tracker). No real observation contradicts the simulator.

## Known gaps / not done (flagged, not papered over)

- Reactivity socket delivery + matchmaking query RPC are **not** validated over real sockets (production
  seams absent) — tracked as above. The parent ticket framed these as expected scenarios; the production
  wiring for them was never built, which is why they are skips, not failures.
- The full FRET-routed participant walk and multi-tier promotion are not at the real tier (small-N routing
  flakiness / single-tier-0 milestone) — covered deterministically at mock tier.
- Membership-rotation primary handoff via real FRET *departure* (epoch rotation on node-leave) is not
  asserted — real churn-detection latency makes it timing-bound / not agent-runnable; the cohort-side
  handoff readiness (sibling serves the topic) IS asserted, and crash-failover is mock-tier-covered.
