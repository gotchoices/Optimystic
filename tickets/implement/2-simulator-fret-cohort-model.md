description: Simulator model over real FRET hash/distance/size-estimator computing n_est, d_max, and two-sided cohort membership per coordinate — same math as production.
prereq: simulator-event-clock
files:
  - C:/projects/Fret/packages/fret/src/estimate/size-estimator.ts
  - C:/projects/Fret/packages/fret/src/ring/hash.ts
  - C:/projects/Fret/packages/fret/src/ring/distance.ts
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts
  - docs/cohort-topic.md
effort: high
----

# Simulator FRET cohort-assembly and network-size-estimation model

A thin model layer over **real FRET exports** so the simulator derives coordinates, cohort membership, `n_est`, and `d_max` using the *same math production will use*. This is the FRET integration dependency surface called out in GROUNDING: optimystic does not yet call FRET for this, so the simulator is the first consumer and must wrap the real functions rather than reimplement them. Treat FRET as **read-only**; only extend FRET if a needed export is genuinely missing, and if so, note it explicitly in the handoff.

Builds directly on the `EventScheduler` from `simulator-event-clock`: cohort (re)assembly and `n_est` recomputation are scheduled events on the virtual clock (modeled coarsely as a gossip-round latency per the event-clock ticket's stabilization decision), not a full stabilization loop.

## Real FRET surfaces consumed

- `C:/projects/Fret/packages/fret/src/estimate/size-estimator.ts` — `estimateSizeAndConfidence(store, m): { n, confidence }`. Source of `n_est` and the confidence used by the `d_max` clamp.
- `C:/projects/Fret/packages/fret/src/ring/hash.ts` — `hashKey` / `hashPeerId` for ring-coordinate derivation (the basis for `coord_d`, which the *next* ticket layers on).
- `C:/projects/Fret/packages/fret/src/ring/distance.ts` — XOR-distance primitives for two-sided cohort assembly.
- `C:/projects/Fret/packages/fret/src/service/fret-service.ts` — `assembleCohort` (alternating successor/predecessor two-sided walk; auto-adapts when `n < k`; `minSigs = k − x`). cohort-topic.md §FRET integration (~L459) states the layer uses this **without modification**.

## What this model computes

Per `docs/cohort-topic.md` §Maximum useful depth (~L81–86):

```
d_max = max(0, ⌊log_F(n_est)⌋ − 1)
// clamp: if confidence < confidence_min (default 0.3) → d_max = ⌊d_max_cap / 2⌋
```

Interface sketch (final shapes pinned during implement):

```ts
interface RingModel {
	/** Ring coordinate for a key/peer, via FRET hashKey/hashPeerId. */
	coordOf(key: Bytes): RingCoord;
	/** XOR distance between two coordinates, via FRET distance primitives. */
	distance(a: RingCoord, b: RingCoord): bigint;
}

interface CohortModel {
	/** Two-sided cohort of k peers around `coord`, via FRET assembleCohort. */
	assemble(coord: RingCoord, k: number): PeerRef[];
	/** minSigs = k − x for threshold checks downstream. */
	minSigs(k: number, x: number): number;
}

interface SizeModel {
	/** n_est + confidence for the modeled population, via FRET estimateSizeAndConfidence. */
	estimate(): { n: number; confidence: number };
	/** d_max with the confidence clamp applied. */
	dMax(cfg: { F: number; capPromote: number; dMaxCap: number; confidenceMin: number }): number;
}
```

The model is populated from the simulator's injected population (peers placed on the ring by `MockMeshKeyNetwork` XOR placement from the event-clock ticket). As churn adds/removes peers (later ticket), the underlying FRET store is updated and `estimate()` / `assemble()` reflect it on the next scheduled recompute.

Out of scope: the full FRET stabilization loop (neighbor discovery / bootstrap). Per the event-clock ticket's decision, stabilization is modeled as a single gossip-round latency before a cohort is considered "assembled".

## Doc sync

- `docs/cohort-topic.md` §Tier addressing / §Maximum useful depth: add a note that coordinate distribution and `d_max` are validated by the simulator against real FRET math (forward-reference; the measured numbers land in `fold-simulator-findings-into-design-docs`). Do **not** restate FRET internals in the optimystic doc — link to the FRET source paths.

## TODO

### Phase 1 — wiring
- Add the `packages/substrate-simulator` dependency on FRET (workspace/path ref) and confirm the four source files above are importable as ES modules (no inline `import()`).
- Implement `RingModel.coordOf` / `distance` over `hashKey`/`hashPeerId` and the distance primitives. No reimplementation of the hash.

### Phase 2 — cohort + size
- Implement `CohortModel.assemble` delegating to `assembleCohort`; verify `n < k` adaptation passes through unchanged. Implement `minSigs(k,x)`.
- Implement `SizeModel.estimate` over `estimateSizeAndConfidence` and `SizeModel.dMax` with the `confidence_min` clamp to `⌊d_max_cap/2⌋`.
- Schedule `(re)assemble` and `estimate` recomputes as virtual-clock events (one gossip-round latency), driven by the event-clock engine.

### Phase 3 — validation + doc sync
- Add the unit/scenario tests under *Done when*.
- Update `docs/cohort-topic.md` §Tier addressing / §Maximum useful depth with the simulator-validation forward note.
- If any required FRET export was missing and had to be added, document it in the review handoff (which export, why, where).

## Done when

- `yarn build` for `packages/substrate-simulator` (tsc) is green; ES modules, no `any`, tabs.
- `yarn test` for the simulator package passes, including:
  - `n_est` tracks an injected population within FRET's reported confidence band across N ∈ {10, 100, 1k, 10k, 100k}.
  - `d_max == ⌈log_F(N/cap_promote)⌉`-regime values hold for the same N sweep (verify against the `max(0, ⌊log_F(n_est)⌋−1)` formula and the depth law the convergence ticket later asserts).
  - The clamp engages (`d_max == ⌊d_max_cap/2⌋`) when injected confidence is forced below `confidence_min`.
  - `assemble` returns the same `k` peers as direct `assembleCohort` calls for the same coordinate/population (the model adds no divergence).
- No modification to FRET source unless a missing export forced it — and that is called out in the handoff.
