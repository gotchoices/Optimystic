description: Simulator FRET model layer — RingModel/CohortModel/SizeModel wrapping real FRET (hashKey, xorDistance, assembleCohort, estimateSizeAndConfidence) to derive coords, cohorts, n_est, d_max on the virtual clock. Reviewed: build + 59 tests green; 2 coverage gaps fixed inline; 2 major design/ops items filed to backlog.
files:
  - packages/substrate-simulator/src/ring-model.ts
  - packages/substrate-simulator/src/cohort-model.ts
  - packages/substrate-simulator/src/size-model.ts
  - packages/substrate-simulator/src/fret-model.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/fret-model.spec.ts
  - packages/substrate-simulator/test/no-real-time.spec.ts
  - packages/substrate-simulator/package.json
  - C:/projects/Fret/packages/fret/src/service/cohort.ts
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts
  - C:/projects/Fret/packages/fret/src/index.ts
  - docs/cohort-topic.md
  - packages/substrate-simulator/README.md
----

# Complete: simulator FRET cohort-assembly & network-size model

A thin model layer over **real FRET** so the design simulator derives ring coordinates, cohort
membership, `n_est`, and `d_max` with the same math production uses. `RingModel`/`CohortModel`/
`SizeModel` are assembled by `FretModel` over a single `DigitreeStore`; the model wraps FRET's
`hashKey`, `xorDistance`, `assembleCohort`, and `estimateSizeAndConfidence` and reimplements none
of them. Composes on the `SimWorldCore` seam from `simulator-event-clock`.

Validation: `packages/substrate-simulator` — `yarn build` (tsc) clean; `yarn test` **59 passing**
(was 57 at implement handoff; +2 added in review). FRET's own cohort specs remain 12/12.

## Review findings

Adversarial pass over the implement diff (`533a23b`) with fresh eyes, then the handoff. Read every
touched file plus the FRET sources the wrappers delegate to. Build (tsc) and tests run green.

### Checked & verified correct (no change)
- **FRET delegation is faithful, not a reimplementation.** `assembleCohort` extraction in FRET
  `service/cohort.ts` is **byte-identical** to the old inline `FretService.assembleCohort` body;
  the service now delegates. `RingModel.coordOf`→`hashKey`, `distance`→`xorDistance`,
  `SizeModel.estimate`→`estimateSizeAndConfidence`, `CohortModel.assembleIds`→`assembleCohort`.
- **`distance` byte-order is correct.** FRET `xorDistance` returns big-endian bytes;
  `RingModel.bytesToBigInt` reads big-endian → the bigint is a faithful XOR-metric distance.
- **Shared-state wiring is sound.** `FretModel` hands the *same* `DigitreeStore` and `peersById`
  Map to `CohortModel`/`SizeModel`; `addPeer`/`removePeer` mutate both, so cohort/size views see
  churn live (and the cached `lastEstimate` lags by design until the next scheduled recompute).
- **`computeDMax` formula** matches `cohort-topic.md` (`max(0, ⌊log_F(n_est)⌋−1)`); the N-sweep
  test cross-checks it against two independent oracles within ±1 of the depth law.
- **`no-real-time` guard scoping** is justified: `Math.random`/`Date.now`/`new Date`/timers stay
  banned globally; `await`/`Promise` are exempted only for `ring-model.ts`/`fret-model.ts`, which
  wrap FRET's async sha256 `hashKey` at *seed time* — never inside a scheduler event — so
  byte-determinism is intact. (Minor: the exemption matches on basename only; acceptable for a
  test-only heuristic, noted not fixed.)
- **Docs reflect reality.** `docs/cohort-topic.md` validation notes link the four real FRET source
  paths (relative `../../Fret/...` resolves correctly from `docs/`); `README.md` corrects the
  stale "no p2p-fret / engine only" framing, documents the portal dep and async `coordOf` seam,
  and the quick-start snippet matches the actual API surface.

### Fixed inline (minor)
- **`RingModel.distance()` had zero test coverage** (public method, used by no test). Added a
  parity + invariant test: equals `bytesToBigInt(xorDistance(a,b))`, `distance(a,a) == 0n`,
  symmetric, positive for distinct coords. (`fret-model.spec.ts`, new `RingModel — XOR distance`
  block.) Caught a bigint-vs-`greaterThan` tsc error in the first draft — fixed.
- **`FretModel.addPeer()` (churn-in) had zero test coverage** — only `removePeer` was exercised.
  Added a churn-in test (disjoint seed populations): added peers join cohort assembly immediately
  (live store), but `lastEstimate.n` rises only after the next `scheduleRecompute` fires —
  mirroring the existing churn-out test. (`fret-model.spec.ts`.)

### Filed to backlog (major — design / ops, not fixable inline)
- **`dmax-confidence-clamp-semantics`** — `computeDMax` implements the low-confidence clamp as an
  unconditional *assignment* to `⌊d_max_cap/2⌋` (=30). For small/low-confidence populations this
  **inflates** `d_max` (e.g. single-peer → 30) rather than capping it, contradicting the doc's
  stated intent ("avoid pathological deep probes"). The wrapper faithfully implements
  `cohort-topic.md` as written, and the test codifies it — but the doc's "clamp" wording is
  ambiguous (set-to-30 vs. `min(formula, 30)`). This affects **production** FRET consumers too, so
  it needs a human design call to align doc + simulator + production. No live regression (nothing
  consumes the simulator yet).
- **`fret-portal-dependency-resolution`** — the `portal:../../../Fret/packages/fret` dep resolves
  against FRET's **gitignored, uncommitted** built `dist/`. It builds locally only because the
  local FRET dist is freshly built; a fresh clone / CI checkout gets stale-or-missing exports and
  the simulator build breaks. Needs a human decision: publish `p2p-fret@0.5.0`, build FRET in CI,
  or keep the portal with a documented bootstrap. db-p2p (registry `^0.4.0`) is unaffected today.

### Not done (with reason)
- **FRET-repo commit/publish not performed.** The cross-repo FRET source edits remain uncommitted
  in `C:/projects/Fret`; the optimystic runner commits only this repo, and committing/publishing
  another repo is a human action outside this ticket's authority. Tracked by
  `fret-portal-dependency-resolution` above — this is the blocking-for-CI item.
- **Full optimystic monorepo `yarn test` and full FRET suite not run.** db-p2p is unaffected by
  design (verified its `node_modules/p2p-fret` lacks the new exports); FRET's full suite needs a
  libp2p network. Per the event-clock precedent, only the affected package + FRET's two cohort
  specs were exercised. No `.pre-existing-error.md` was written — no unrelated failures surfaced.
- **1M-scale sweep not run.** Sweep tops out at 100k (~4s seeding) per the ticket's `Done when`;
  1M validates nothing new about these formulas and adds ~40s+.

## What shipped (unchanged from implement, recapped)
- `RingModel` — `coordOf(key)`→FRET `hashKey` (async sha256); `distance(a,b): bigint`→`xorDistance`.
- `CohortModel` — `assemble`/`assembleIds`→FRET `assembleCohort`; `minSigs(k,x)=k−x`.
- `SizeModel` — `estimate()`→FRET `estimateSizeAndConfidence`; `dMax(cfg)` with confidence clamp;
  pure `computeDMax` + `DEFAULT_DMAX_CONFIG` (F=16, capPromote=64, dMaxCap=60, confidenceMin=0.3).
- `FretModel` — facade over one `DigitreeStore`; `addPeer`/`removePeer` churn;
  `scheduleRecompute` snapshots `n_est` one gossip round out (Decision 6 stabilization-as-latency).
- Cross-repo FRET: extracted pure `assembleCohort` + deep-import index re-exports (see backlog
  ticket for the publish/commit follow-through).
