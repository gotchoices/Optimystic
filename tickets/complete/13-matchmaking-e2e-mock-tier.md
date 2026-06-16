description: Reviewed and accepted the in-process matchmaking peer-discovery test harness and its end-to-end suites (provider register/query, the seeker hang-out walk, and the multi-cohort sweep); fixed two dead imports and corrected harness comments that overstated which real components the seeker path drives.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (CoordEngine.records seam — reviewed)
  - packages/db-p2p/src/testing/matchmaking-mesh-harness.ts (reviewed; dead imports removed + header comments corrected)
  - packages/db-p2p/test/matchmaking/mesh-lifecycle.spec.ts (reviewed)
  - packages/db-p2p/test/matchmaking/mesh-walk.spec.ts (reviewed)
  - packages/db-p2p/test/matchmaking/mesh-sweep.spec.ts (reviewed)
  - docs/matchmaking.md (reviewed)
  - docs/architecture.md (reviewed)
----

# Matchmaking — mock-transport e2e tier (review complete)

## Summary

The implement-stage work landed as described: a mock-transport matchmaking mesh harness layered on the
cohort-topic mesh harness, driving the **real** provider manager, the **real** cohort `QueryV1` handler,
the **real** seeker walk client, and the **real** multi-cohort sweep over an in-process mesh on a virtual
clock. 15 new mesh tests pass (+3 honestly tagged `it.skip` for doc expectations that need a *serving*
promoted tier-`d ≥ 1` cohort — gated on cohort-topic promotion follow-ons). The `CoordEngine.records()`
seam is a small, correct, additive accessor (`store.listByTopic`). Builds and full suites are green.

Two minor defects were found and **fixed inline** (see findings). No major issues; no new tickets filed
(the remaining gaps fold into the already-tracked cohort-topic promotion follow-ons and the real-libp2p
e2e milestone — filing would duplicate existing scope).

## Validation (re-run during review)

- `yarn build` — **clean (exit 0)** in `db-core` and `db-p2p` (before and after the inline fix).
- `db-p2p` `yarn test` — **707 passing / 17 pending / 0 failing** (re-confirmed after the inline edit;
  the one stderr line in `host-antidos-coldstart.spec.ts` is an intentionally-provoked, handled
  `parent unreachable` log, not a failure).
- `db-core` `yarn test` — **818 passing / 0 failing**.
- `matchmaking/mesh-*.spec.ts` in isolation — **15 passing / 3 pending**.
- Lint: the repo has **no lint configured** (root `lint` is an `echo` placeholder; no eslint config
  present), so there was nothing to run — noted rather than skipped silently.

## Review findings

### What was checked

- **The implement diff first, with fresh eyes** (`git show e7bc499`): the `records()` seam, the full
  harness, all three spec files, and both doc edits.
- **The `records()` seam** (`host.ts`): additive accessor returning `store.listByTopic(topicId)`,
  sitting beside `holds`/`servesTopic`; matches the documented query-handler/aggregate-producer read.
  Correct and minimal. (Confirmed the production host does **not** yet wire any matchmaking `QueryV1`
  RPC handler — the seam is forward-looking, consumed today only by the mesh harness; this is the honest
  real-libp2p boundary, accurately reflected by the still-`pending` real-libp2p column.)
- **Underlying components the harness drives** — `SeekerWalkClient.run` (walk/hang-out/escalate state
  machine), `handleMatchmakingQuery` (appState decode + `evaluateQuery`), `runMultiCohortSweep`
  (select → query → filter → re-validate → dedupe), `MatchmakingProviderManager` (register /
  setCapacity / signalFull / withdraw). Traced each test's expected hop/tier/hang-out arithmetic against
  the real control flow — all assertions are sound (cold walk = `d_max+1` hops; borderline drains exactly
  `patienceMs`; adversarial over-report bounded by `patienceMs` with `tiersVisited == d_max+1`; sweep
  forgery dropped by `verifyProviderEntry`).
- **Aspect sweep** (SPP / DRY / modularity / scalability / maintainability / performance / resource
  cleanup / error handling / type safety): harness `stop()` tears down the underlying cohort mesh; the
  virtual clock is correctly isolated per-seek; no leaked timers (sleeps are synchronous on the virtual
  clock); types are explicit throughout.
- **Test breadth**: happy path, capability-filter edges (`must`/`mustNot`/`minBudget`/pathological),
  self-throttle, TTL withdrawal, cold/sparse/hot/borderline/adversarial walk regimes, and sweep
  union/cold-root/log-bucket/forgery. Good coverage for the single-tier-0 substrate this milestone targets.
- **Docs**: re-read every touched file; `architecture.md` Doc Sync Status row and `matchmaking.md`
  §Test expectations + the two §Worked scenarios accurately map each claim to a named test or a tagged
  `it.skip`. Consistent with the new reality.

### Found and fixed (minor, in this pass)

- **Two dead imports** in `matchmaking-mesh-harness.ts`: `MatchmakingSeekerManager` (only referenced from
  a jsdoc `@link`) and `bytesToPeerIdString` (never referenced) — neither flagged by `tsc` because
  `noUnusedLocals` is off in this package. Removed both.
- **Overclaiming header comments** in the same file: the module header stated the harness drives "the real
  provider/seeker **managers**" and that "provider/seeker registration rides … `MatchmakingSeekerManager`".
  That is inaccurate for the seeker — the seeker walk drives the real `SeekerWalkClient` and builds
  per-tier registrations from the real `MatchmakingSeeker` payload dispatched straight through the cohort
  engines; the one-shot `MatchmakingSeekerManager` wrapper is **not** on that path. Corrected both
  sentences so the "what is real" contract is truthful. (Re-built + re-ran the suites after the edit.)

### Found, judged acceptable (no change)

- **The public `module.ts` session layer is not driven at the mesh tier.** `MatchmakingSeekerSession.walk`
  (which combines the walk's `maxChildCohortCount` hotness signal with a sweep escalation),
  `MatchmakingProviderSession`, and `createMatchmakingQuorumDiscovery` are bypassed by the harness, which
  drives the lower-level managers / walk client / sweep directly. These thin glue classes are unit-tested
  with injected ports in `module.spec.ts`, and the combined walk→sweep escalation is only *meaningful* on
  a hot/promoted topic — the very thing the single-tier-0 substrate can't yet build. So the integration
  value of driving them end-to-end folds naturally into the cohort-topic promotion follow-ons + the
  real-libp2p tier; not filed separately to avoid duplicating that tracked scope. **Noted as a known gap.**
- **The `withdraw` test exercises TTL eviction, not a withdraw-specific wire effect.** By documented design
  (`provider-manager.ts` header), withdrawal has *no* wire realization — it stops renewal and lets the
  record age out by TTL — so the record is unchanged in the cohort store until `sweepStale`. The test is an
  honest reflection of that contract (withdrawn provider eventually disappears), even though the same
  outcome would hold without the `withdraw()` call. Correct as written; called out for honesty.
- **Modeled `directParticipants` counts providers + seekers** (`r.appState !== undefined`) in
  `queryCohort`/sweep, whereas the substrate's `store.directParticipants` counts all records. This feeds
  only the *default* (un-`setTraffic`'d) traffic snapshot, and every regime test injects its traffic
  explicitly, so it never affects an assertion. Benign modeling detail.
- **Traffic regimes, single-tier-0 substrate, patience-drain-on-hops, sweep crypto/topology, the walk
  transport shortcut, and the unexercised `gossipReplicate`** — all already disclosed honestly in the
  implement handoff's Gaps section and the doc mapping; re-confirmed accurate. The three skipped doc
  expectations correctly point at their cohort-topic parking tickets.

### Major issues

None. No fix/plan/backlog tickets filed.
