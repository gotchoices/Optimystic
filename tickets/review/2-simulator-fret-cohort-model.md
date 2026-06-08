description: Review the simulator FRET model layer — RingModel/CohortModel/SizeModel wrapping real FRET (hashKey, xorDistance, assembleCohort, estimateSizeAndConfidence) to compute coords, cohorts, n_est, d_max on the virtual clock. Implemented; build + 57 tests green. Cross-repo FRET edits + portal dep need scrutiny.
prereq:
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

# Review: simulator FRET cohort-assembly & network-size model

A thin model layer over **real FRET** so the simulator derives ring coordinates, cohort
membership, `n_est`, and `d_max` with the *same math production will use*. Wraps FRET's
`hashKey`, `xorDistance`, `assembleCohort`, and `estimateSizeAndConfidence` — reimplements
none of them. Composes on the `SimWorldCore` seam from `simulator-event-clock`.

## What shipped

- **`RingModel`** (`ring-model.ts`) — `coordOf(key)` → FRET `hashKey` (sha256, async);
  `distance(a,b): bigint` → FRET `xorDistance` (bytes presented as bigint, no distance math
  reimplemented).
- **`CohortModel`** (`cohort-model.ts`) — `assemble(coord,k): PeerRef[]` and `assembleIds(...)`
  → FRET `assembleCohort` over a shared `DigitreeStore` (two-sided alternating walk, auto-adapts
  when `n < k`); `minSigs(k,x) = k − x`.
- **`SizeModel`** (`size-model.ts`) — `estimate()` → FRET `estimateSizeAndConfidence`;
  `dMax(cfg)` = `max(0, ⌊log_F(n_est)⌋−1)` clamped to `⌊dMaxCap/2⌋` when `confidence <
  confidenceMin`. Pure `computeDMax(n, conf, cfg)` + `DEFAULT_DMAX_CONFIG` (F=16, capPromote=64,
  dMaxCap=60, confidenceMin=0.3, from cohort-topic.md §parameter table).
- **`FretModel`** (`fret-model.ts`) — facade owning one `DigitreeStore` seeded by `hashKey`;
  `addPeer`/`removePeer` (churn, for the later ticket); `scheduleRecompute(scheduler,
  gossipRoundMs)` snapshots `n_est` as a virtual-clock event one gossip round out (Decision 6
  stabilization-as-latency, not a stabilization loop).

## How to validate

```
cd packages/substrate-simulator
yarn build      # tsc — clean
yarn test       # mocha + chai — 57 passing (~8s); was 49 at event-clock handoff, +8 here
```

Test scenarios in `test/fret-model.spec.ts` (the floor, not the ceiling):
- **N sweep {10,100,1k,10k,100k}** — `n_est` within `[N/4, 4N]`; `d_max` equals the formula
  (independent oracle) and is within ±1 of the depth law `⌈log_F(N/cap_promote)⌉`.
- **Clamp** — `computeDMax` with forced sub-`confidence_min` → 30; plus a degenerate single-peer
  real-FRET population (FRET reports confidence 0.2) → `d_max == 30`.
- **Cohort parity** — `assembleIds`/`assemble` byte-identical to a direct `assembleCohort(store,
  coord, k)` over an independently-seeded reference store; `n < k` returns the whole ring.
- **Scheduled recompute** — `lastEstimate` is `undefined` until the event at `gossipRoundMs`
  fires; churn is reflected only after the next recompute.

Manual: the README quick-start block runs the model end to end.

## ⚠️ Reviewer attention — known gaps & decisions

1. **Cross-repo FRET edits the optimystic runner does NOT commit.** To wrap the real functions,
   FRET source (separate repo `C:/projects/Fret`) was extended — this is the "missing export"
   callout the ticket asked for:
   - Extracted the cohort walk into a standalone pure `assembleCohort(store, coord, wants,
     exclude)` in `src/service/cohort.ts`; `FretService.assembleCohort` now delegates to it
     (behavior-preserving — FRET's `cohort.assembly`/`cohort.properties` specs still pass, 12/12).
   - Added index re-exports: `xorDistance`/`clockwiseDistance`/`minDistance`/`lexLess`,
     `DigitreeStore`/`PeerEntry`/`PeerState`, `estimateSizeAndConfidence`/`SizeEstimate`,
     `assembleCohort`, `RingCoord`. (FRET's `exports` map only exposed `.`, blocking deep
     imports — these were genuinely missing.)
   - **FRET `dist/` was rebuilt (`yarn build`, green) but FRET `dist/` is gitignored and the
     edits are uncommitted in the FRET repo.** The portal dep points at that built dist.
     **For CI / a fresh clone the FRET changes must be committed in the FRET repo and FRET
     rebuilt**, else the portal resolves to stale/missing exports. (Pre-existing unrelated change
     in FRET `package.json` — a `--exit` test flag — was left untouched.)

2. **Dependency mechanism — `portal:` to local FRET.** `packages/substrate-simulator/package.json`
   now has `"p2p-fret": "portal:../../../Fret/packages/fret"` (mirrors the repo's existing
   `portal:../quereus` resolution). `yarn.lock` updated. db-p2p still consumes registry
   `p2p-fret@^0.4.0` and is **unaffected** (verified its `node_modules/p2p-fret` index has none
   of the new exports). yarn emits benign peer-dep warnings (`@libp2p/interface`, `libp2p` not
   provided) — the model imports only non-libp2p symbols, so they don't bite. yarn also notes
   portals "require `--preserve-symlinks`"; our build/test commands intentionally do **not** pass
   it, because default realpath resolution finds FRET's own `node_modules` (digitree etc.) —
   verified working. Reviewer: confirm `portal:` (vs. publishing a FRET 0.5.0) is the intended
   long-term mechanism.

3. **`no-real-time` guard relaxed for the model layer.** The `await`/`Promise` ban now applies to
   the engine core only; `ring-model.ts` and `fret-model.ts` are exempted because FRET's
   `hashKey` is async (sha256). The wall-clock / randomness / timer bans (`Math.random`,
   `Date.now`, `new Date`, `setTimeout`, `setInterval`) remain **global**. Rationale: async ≠
   non-determinism — sha256 is deterministic and the async seam runs only at seeding time, never
   inside a scheduler event. Reviewer: sanity-check this scoping.

4. **`n_est` is order-of-magnitude, not a tight CI.** FRET's median-gap estimator systematically
   overshoots a uniform population by ~1/ln2 ≈ 1.44× (measured ratios: N=10→2.9, N=100→1.24,
   1k→1.52, 10k→1.43, 100k→1.45). The test asserts same-order-of-magnitude (`[N/4, 4N]`). This is
   the honest reading of "within FRET's reported confidence band" — there is no narrower CI to
   assert against without re-deriving the estimator.

5. **Scale ceiling = 100k, not 1M.** The ticket's `n_est`/`d_max` sweep tops out at 100k
   (`Done when`). 100k seeds in ~3.8s (mocha timeout raised to 30s for that test). 1M was the
   *engine* ticket's scale target; seeding 1M sha256 hashes + btree inserts would add ~40s+ and
   validates nothing new about these formulas, so it is deliberately not tested here.

6. **Interface-sketch deviations (shapes pinned during implement, as the ticket allowed):**
   `coordOf` returns `Promise<RingCoord>` (sketch showed sync — forced by async `hashKey`);
   `distance` returns `bigint` via byte→bigint of `xorDistance`; `CohortModel` gained
   `assembleIds` (raw ids) alongside `assemble` (PeerRefs) to expose the parity surface.

7. **Not run here:** FRET's full suite (separate repo; has libp2p integration specs needing a
   network) — only its two cohort specs were run. The full optimystic monorepo `yarn test` was
   not run (long; db-p2p is unaffected by design, per the event-clock precedent).

## Doc sync done

- `docs/cohort-topic.md` §Tier addressing — added a simulator-validation note linking to the
  four FRET source paths (does not restate FRET internals); §Maximum useful depth — forward note
  on the formula/clamp validation. Measured numbers are deferred to
  `fold-simulator-findings-into-design-docs`.
- `packages/substrate-simulator/README.md` — documents the new FRET model layer, the `p2p-fret`
  portal dependency, the async `coordOf` seam, and a usage snippet; corrected the stale "depends
  on no p2p-fret / engine only" framing and Decision 5.
