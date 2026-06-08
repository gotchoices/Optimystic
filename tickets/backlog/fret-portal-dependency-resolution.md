description: Decide the long-term mechanism for substrate-simulator's dependency on FRET, and make it CI-safe. Today it uses `portal:../../../Fret/packages/fret` pointing at the sibling FRET repo's *built dist*, but the FRET-side edits (extracted assembleCohort + new index re-exports) are uncommitted in the FRET repo and FRET `dist/` is gitignored. A fresh clone / CI checkout resolves to stale or missing exports and the simulator build fails. Choose: publish FRET 0.5.0 with the new exports, or commit FRET source + build dist in CI, or keep the portal with a documented bootstrap step.
prereq:
files:
  - packages/substrate-simulator/package.json
  - C:/projects/Fret/packages/fret/src/index.ts
  - C:/projects/Fret/packages/fret/src/service/cohort.ts
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts
----

# FRET dependency mechanism for the design simulator

`simulator-fret-cohort-model` wraps **real FRET** math (`hashKey`, `xorDistance`,
`assembleCohort`, `estimateSizeAndConfidence`). To do so it added a dependency:

```jsonc
// packages/substrate-simulator/package.json
"dependencies": { "p2p-fret": "portal:../../../Fret/packages/fret" }
```

and required edits **in the separate FRET repo** (`C:/projects/Fret`):

- New pure `assembleCohort(store, coord, wants, exclude)` in `src/service/cohort.ts`;
  `FretService.assembleCohort` delegates to it (behavior-preserving; FRET cohort specs 12/12 green).
- New `src/index.ts` re-exports: `xorDistance`/`clockwiseDistance`/`minDistance`/`lexLess`,
  `DigitreeStore`/`PeerEntry`/`PeerState`, `estimateSizeAndConfidence`/`SizeEstimate`,
  `assembleCohort`, `RingCoord` (FRET's `exports` map previously exposed only `.`).

## Why this needs a decision (CI/clone hazard)

These FRET changes are **uncommitted in the FRET repo**, and FRET `dist/` is **gitignored**. The
`portal:` ref resolves against FRET's *built dist*. Therefore:

- It builds/tests locally **only because** the local FRET `dist/` happens to be freshly built with
  the new exports.
- On a fresh clone or in CI, the portal resolves to a FRET checkout where the source edits are
  absent (uncommitted) and/or `dist/` is unbuilt → `import { assembleCohort } from 'p2p-fret'`
  fails and the simulator build breaks.

The optimystic ticket runner commits only the optimystic repo; it does **not** touch the FRET repo.

## Options to weigh (human sign-off)

1. **Publish `p2p-fret@0.5.0`** with the new exports; simulator depends on `^0.5.0` from the
   registry. Cleanest for CI; cost is a FRET release cadence + db-p2p still pins `^0.4.0` (verify
   it tolerates 0.5.0 or stays pinned).
2. **Commit FRET source + build `dist/` in CI** (un-gitignore dist, or build FRET as a CI step
   before the simulator). Keeps the portal; adds a cross-repo build step.
3. **Keep `portal:` with a documented bootstrap** ("clone FRET as a sibling, `yarn build` it
   first"). Lowest effort; fragile and undocumented-clone-hostile.

Note: db-p2p consumes registry `p2p-fret@^0.4.0` and is unaffected by the portal today (its
`node_modules/p2p-fret` lacks the new exports) — confirm any chosen path keeps that true or
migrates db-p2p deliberately. yarn emits benign libp2p peer-dep warnings under the portal; the
simulator imports only non-libp2p symbols.
