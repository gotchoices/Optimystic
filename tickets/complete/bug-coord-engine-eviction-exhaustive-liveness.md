description: When a node ran low on memory it threw away the least-useful of its small in-memory working sets, but its test for "useless" only checked two of the four things such a working set can hold — so it silently discarded linked child groups and recorded group-resize decisions. Eviction now ranks working sets by what they actually hold, releases a trust record the discarded set may have published, and a discarded set is fully switched off so a job already in flight cannot revive it.
files:
  - packages/db-p2p/src/cohort-topic/host.ts                            # EngineStateKind/EngineLiveness, CoordEngine.liveness, EVICTION_RANK, evictionRank + evictOne, onEngineEvicted wiring, ChildRegistry.hasLinkedChildren, closed-engine guards
  - packages/db-core/src/cohort-topic/promotion.ts                      # PromotionLifecycle.hasAdoptedState
  - packages/db-core/src/cohort-topic/membership/verifier.ts            # MembershipVerifier.forget
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts    # 6 tests in "coord-engine registry cap"
  - packages/db-core/test/cohort-topic/promotion.spec.ts                # "adopted-state census" describe
  - packages/db-core/test/cohort-topic/membership.spec.ts               # 4 forget() tests in "stale trust-lock recovery"
  - docs/cohort-topic.md                                                # §Cold-start instantiation "Cost (tripwires)"; anti-DoS wiring summary
----

# Coord-engine eviction ranks by an exhaustive liveness census

## What shipped

A node keeps one small in-memory working set — a `CoordEngine` — per cohort coordinate it serves. The
coordinate is a hash over attacker-chosen inputs and an engine is created *before* the per-coordinate
anti-DoS gates run, so the registry is hard-capped (`coordEnginesMax`, default 2048) and evicts under
pressure. Two defects in that eviction, plus one found during review:

1. **The "is this engine worth keeping" test was not exhaustive.** It asked only "does it hold registration
   records?" and "does it hold a cold-start forwarder?". An engine holding *only* linked child cohorts, or
   *only* adopted promotion/demotion state, answered no to both and was reclaimed as a throwaway.
2. **The eviction path's stated safety claim was false.** It claimed an evicted engine had never published a
   membership certificate. On a keyed node the gossip-cadence driver calls `pumpMembership` for *every*
   engine, record-less ones included, so eviction could strand a verifier trust-lock.
3. **(found in review) An evicted engine kept running.** See *Review findings*.

Landed shape:

- `EngineStateKind = "records" | "forwarders" | "children" | "promotion"` with
  `EngineLiveness = Readonly<Record<EngineStateKind, boolean>>`, and one `CoordEngine.liveness()` census.
  `hasState()` / `hasForwarders()` now derive from it, so the two views cannot drift.
- `EVICTION_RANK` = `{ records: "pinned", forwarders: "pinned", children: 1, promotion: 1 }`. `evictOne()`
  picks the `(rank, recency)`-lexicographically-least candidate: rank first, LRU only to break ties within a
  rank.
- `CoordEngineContext.onEngineEvicted?`, fired for **every** victim, wired at the host to
  `verifier.forget(bytesToB64url(coord))` — unconditional, no "did this engine publish" tracking.
- `PromotionLifecycle.hasAdoptedState()` and `MembershipVerifier.forget(cohortCoord)` in db-core.

**Children and promotion are ranked (1), not pinned — deliberate.** A child link is peer-supplied input (in
key-less-permissive mode the host records one with no signature check), so pinning on it would let one peer
make all `coordEnginesMax` slots un-evictable and turn every subsequent legitimate coordinate into a
`CoordEngineRegistryFullError` — reopening the exact spray vector the cap closes. Ranking keeps the hard
guarantee (some engine is always evictable while any unpinned one exists) while making the realistic loss the
*last* to go. The residual — a rank-1 engine still dies under a large enough spray — is what
`tickets/implement/2-bug-promotion-state-survives-engine-eviction.md` addresses durably for the promotion arm.
The children arm needs no equivalent: a linked child set is gossip-replicated and re-advertised by every
cohort member each `willingnessHeartbeatMs` (`gossipRound`'s child-set resync), so a re-instantiated engine
rebuilds it from the cohort.

## Review findings

Reviewed the implement diff (`a471746d`, `ba7f5e2e`) first, then the handoff. Ran root `yarn build`,
`yarn lint`, `yarn typecheck`, and both test suites.

### Major — fixed inline (no ticket filed)

**An evicted engine kept being driven, and could re-lock the coordinate eviction had just released.**
`driveTick` iterates a `registry.all()` *snapshot* and `await`s between engines. An inbound register /
child-link / cold-sibling frame landing in one of those awaits reaches `registry.forCoord`, which can evict —
and `close()` — an engine the tick has not reached yet. The tick then drove a closed engine: `gossipRound`
broadcast on a closed bus, and on a keyed node `pumpMembership` republished a cert, re-running
`onCertPublished` → `verifier.cache` and re-establishing the trust-lock `onEngineEvicted` → `verifier.forget`
had *just* dropped, for a coordinate the node no longer serves. That is this ticket's own bug surviving in a
residual race window, so it belonged in this pass rather than a follow-up.

Fixed as an invariant rather than a driver patch — climbing the *boundary invariant* rung: `close()` now sets
a `closed` flag and `publishMembership`, `gossipRound` and `demotionTick` are inert afterwards, so a closed
engine does nothing regardless of who still holds a reference. Guarding in the driver would have left every
other holder of a stale reference exposed. Covered by a new test ("an evicted engine is inert…"); verified
non-vacuous by removing the `gossipRound` guard and re-running (1 failing), then restoring.

### Minor — fixed inline

- **Eviction's census allocated garbage per engine.** `liveness().children` called `linkedChildren()`, which
  materializes one object per linked child across all topics, only to read `.length`. `evictOne` runs the
  census once per resident engine per eviction (up to 2048). Added a short-circuiting, allocation-free
  `ChildRegistry.hasLinkedChildren()` and read that instead. `records` still goes through
  `store.listAll()` — pre-existing (the old idle predicate did the same), left alone and noted at the site.
- **The exhaustiveness test's stated rationale was wrong.** It claimed "nothing type-checks that the engine
  reports every kind". `EngineLiveness` is a total `Record`, so a missing key and an excess key both fail to
  compile — confirmed with a scratch `tsc --strict` case covering the literal, excess-key and spread forms.
  The test is still worth keeping (it catches a dynamically-built or stand-in `liveness()`), so the comment
  was corrected to say what it actually guards rather than the test being deleted.
- **`promotion.spec.ts` used "pins the engine" throughout**, where this change makes *pinned* a load-bearing
  term meaning "never an eviction candidate" — the opposite of what rank-1 promotion state is. Reworded to
  "ranks"/"outranks"; that distinction is the whole point of the suite.
- **Docs.** Re-read every doc passage the change touches. `docs/cohort-topic.md` §Cold-start instantiation
  and the anti-DoS wiring summary were correctly rewritten by the implementer; added the closed-engine
  invariant. Remaining "idle engine" mentions in that file (lines ~766, ~776, ~781) are about *gossip*
  idleness, not eviction, and are still accurate; line ~1023's LRU is a different cache.

### Tripwires parked (not tickets)

- **`forget` discards a coordinate's cache entry whatever its provenance** — a remotely fetched cert goes
  along with a self-published lock, so the next sight of the coordinate re-runs the trust gate from cold, and
  an attacker can drive that by spraying coordinates. Weighed and judged harmless *today*: with a working
  trust anchor the refetch re-derives the same `"trusted"` verdict, and with the anchor `"unknown"` the
  coordinate was already trust-on-first-use with a bounded re-TOFU exit (`staleGapRecoveryStrikes`), so
  `forget` only shortens a path that was already open. `NOTE:` at
  `packages/db-core/src/cohort-topic/membership/verifier.ts` `forget()`, with the revisit condition: if
  `forget` gains a caller in a regime where re-TOFU is not otherwise reachable, narrow it to clearing
  `trusted` rather than deleting the entry.
- **Census cost.** `NOTE:` at the `liveness()` site: `evictOne` runs up to `coordEnginesMax` censuses per
  reclaim; three arms are now O(1), `records` still materializes every registration. Unmeasured, and bounded
  by a registry full of *cold* engines in the case that matters. Revisit condition: if eviction shows up in a
  profile, give `RegistrationStore` an `isEmpty()` (its `byTopic` map already knows). The implementer's
  existing `NOTE:` on `hasState`/`hasForwarders` was kept and corrected.

### Checked, nothing found

- **Coordinate-key agreement.** `verifier.forget(bytesToB64url(servedCoord))` really does match what
  `verifier.cache` keys on: `snapshotAt` builds the snapshot with `coord: servedCoord` and
  `membershipCertSignable` sets `cohortCoord: bytesToB64url(snapshot.coord)`. Had these diverged the whole
  trust-lock fix would have been a silent no-op.
- **Other state keyed by an evicted coordinate.** `PromoteGate.highWater` is keyed `${cohortCoord}|${tier}`
  and is *not* cleared on eviction — correct: it is an `LruMap` capped at `PROMOTE_HIGHWATER_MAX_KEYS`, grows
  only on a verified apply, and a surviving entry only ever *drops* a stale notice.
- **Interface widening.** `MembershipVerifier.forget` and `PromotionLifecycle.hasAdoptedState` reached every
  implementor and fake; root `yarn build` and `yarn typecheck` are clean. The implementer's own note that the
  first commit left db-core not building was accurate and was fixed in the second.
- **Eviction ordering / teardown.** `evictOne` closes the victim, deletes both map entries, then fires
  `onEngineEvicted`; `verifier.forget` is two `Map.delete`s and cannot throw, so no partial-eviction path
  exists. `registry.close()` at host stop deliberately does not fire the hook.
- **Rank arithmetic.** `evictionRank` returns `undefined` on the first pinned class and otherwise the maximum
  numeric rank; the `(rank, recency)` comparison in `evictOne` is correct lexicographic order.

### Considered and not filed

- **"No test exercises rank 1 vs rank 1."** Both ranked classes share rank 1, so a child-holder and a
  promotion-holder tie and fall through to LRU — which is exactly what the existing LRU tests cover. A test
  asserting a tie is a test of `Object.keys` order, not of a contract.
- **`hasState()` / `hasForwarders()` have no production call sites** (confirmed by grep over `packages/*/src`
  — only the declarations). They are legitimate `CoordEngine` interface surface and removing them would churn
  several specs for no behavioural gain. The perf half is already parked as a tripwire at the site.
- **Eviction under real memory pressure / the default 2048-engine path is untested**, as the handoff said.
  That needs a keyed multi-node harness over the wire; it is an integration-coverage gap, not a defect, and
  the per-unit behaviour it would exercise is covered directly.
- **`host.ts` is 3148 lines** (`wc -l packages/db-p2p/src/cohort-topic/host.ts`), and this change added ~200.
  Genuinely large, but a split is its own design exercise with no defect behind it, and no site-claim grep hit
  covers it. Not filed on the strength of this diff alone.

## Validation

- Root `yarn build`, `yarn lint`, `yarn typecheck` — all clean.
- `yarn workspace @optimystic/db-core test` — **1469 passing**.
- `yarn workspace @optimystic/db-p2p test` — **2483 passing, 49 pending** (2482 before this review's added
  test; the 49 pending are pre-existing). No test was skipped, disabled or loosened.
- Non-vacuity: both rank tests were confirmed by the implementer to fail with `children`/`promotion` set to
  rank 0; the review's new inertness test was confirmed to fail with the `gossipRound` guard removed.
