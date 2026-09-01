description: A save that touched more records than the local memory cache holds used to describe only the most recent ~126 of them, quietly leaving the rest unable to gain new replicas by push; now each record's starting content is pinned the moment it is changed, so a save of any size describes everything it read and changed.
files: packages/db-core/src/transform/base-pins.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/collection/collection.ts, packages/db-core/test/digest-cache-coverage.spec.ts, packages/db-core/test/digest.spec.ts, docs/repository.md, docs/internals.md
----

# Complete: digest coverage no longer capped by the read cache

Implemented in `f4a4f7dc`; reviewed, corrected and extended here.

## What shipped

`computeBlockContentDigests` describes a commit from `Tracker.peekMaterialized`, which used to
re-probe the 128-entry `CacheSource` LRU at sync time — so a transaction touching more blocks than
the cache holds had already evicted its own early bases before describing them, and coverage capped
at `min(N, 126)` rather than thinning out.

The fix is a **transaction-scoped base-pin store**:

- **`src/transform/base-pins.ts`** (new) — `PinnedBase` (`{ block, rev, gen }`) and `BasePins`
  (`get`/`set`/`delete`/`retainOnly`/`adopt`/`bindAuthority`/`size`).
- **`Tracker`** — a third optional constructor parameter `public readonly pins: BasePins`
  (additive; every existing call site compiles unchanged). `update()` pins the committed base the
  first time an update is staged for an id, re-pinning only on generation drift, so a block updated
  50 times pays one base clone. `insert()`/`delete()` drop the pin; `reset(t)` prunes to the ids
  still in `t.updates` — the single reclamation point. `peekMaterialized()` prefers a *fresh* pin
  (the source generation must still match) and clones it before `applyTransform`; a stale or absent
  pin falls through to the unchanged live-peek path.
- **`Atomic.commit()`** — adopts its pins into the parent tracker *before* `reset()`, so a single
  oversized `act()` keeps the bases its handlers read.
- **`Collection.syncAttempts`** — the per-attempt snapshot tracker joins the live tracker's pin
  store; `createReadTracker` keeps a private one.

No wire change: `Transforms`, `CommitRequest`, `BlockContentDigests` and `blockDigestsField` are
untouched, so a commit that declares nothing serializes exactly as before.

**Measured, through the production path (`Collection.act`/`sync`), in
`test/digest-cache-coverage.spec.ts`:** against unmodified `src`, 126 declared at both N=256 and
N=512 — the cap reproduced. After the fix, 256/256 and 512/512.

## Review findings

### Verified sound — three things that look like defects and are not

Recorded because each is the obvious thing a next reviewer will re-derive.

- **A stale pin cannot declare wrong content as if it were right.** `probeBase` reads the base and
  its committed revision in one synchronous probe, so `(block, rev)` is always a self-consistent
  pair; the member checks `preview.baseRev === declared.baseRev` and *abstains* on mismatch
  (`ClusterMember.validateCommitOperations` → `StorageRepo.previewCommitDigest`). So even in the one
  case where the freshness gate cannot fire — `CacheSource.transformCache` silently skips an id that
  is no longer resident, and therefore does not bump its generation — the worst outcome is an
  abstain, never a reject and never a false attestation.
- **Retaining pins across a rollback is correct.** `reset(transforms)` (coordinator rollback,
  `restorePending`) keeps the pins for still-staged ids. A pin is a fact about the *cache* — the
  committed base of an id at a generation — not about the transaction that took it, so the restored
  transaction's pins are the same bases it would re-probe.
- **The blind-update carve-out and the read-far-then-update residual are genuinely undeclarable,**
  not gaps the pin store should have closed: a commit must never pay a network read to describe
  itself.

### Fixed inline

- **Major → retired as an invariant, no ticket.** `Tracker.pins` is a public constructor parameter,
  and a pin's `rev`/`gen` are counters *private to one base source*. Nothing stopped a caller from
  sharing one store between trackers over different `CacheSource`s — two caches number generations
  from 0 independently, so a pin taken against cache A would pass the freshness check against cache
  B and declare A's content for B's block, silently. Climbed to the boundary-invariant rung rather
  than filing the instance: `BasePins.bindAuthority()` binds a store to the base source at the
  bottom of the binding tracker's stack and throws when a tracker with a different base source
  joins; `adopt()` asserts the same. Dormant today (the single sharing site is same-source), so this
  guard closes the class rather than fixing a live bug. Covered by a new test.
- **DRY.** The duck-typed "peek the base, read its committed revision, require BOTH" probe was
  written twice — in `probeBase` and in `peekMaterialized`'s fallback — with the same subtle
  invariant restated verbatim in both comments, so the two could drift apart into disagreeing about
  what "locally answerable" means. Extracted to one module-level `cachedBase(source, id)`.
- **DRY.** `baseGeneration` and `probeBase` each hand-rolled the same "chain through nested
  Trackers" walk. Both now go through one `baseSource()`.
- **Docs were stale.** `docs/repository.md` still stated the per-block omission rule as "a block
  whose base is not locally cached is simply left out" — the exact sentence this change invalidates;
  rewritten to state that coverage is a property of the transaction, with the two genuinely
  undeclarable cases named. `docs/internals.md`'s "Functions That CLONE" contract table gained the
  pinned-base rows (`Tracker.update()` → `BasePins`, and `peekMaterialized` cloning the pin as well
  as the staged insert). No other doc asserted the old cap.

### Tripwires (recorded at the code site, not filed)

- `collection.ts`, the pin-store sharing site — a sync attempt that ends in a stale failure is
  abandoned without `reset()`, so the log tail/header bases its append pinned stay in the shared
  store until the live tracker's next reset. Bounded (a few log blocks per attempt, capped by
  `maxAttempts`) and re-validated against the source generation before any use. `NOTE:` added with
  the closure (reset the abandoned tracker on the stale-failure branch) if the per-attempt footprint
  ever grows past the log blocks.
- `tracker.ts`, the pin site — read-far-then-update (a block read, evicted by 128+ other reads, and
  only *then* updated) pins nothing and stays undeclared. Pre-existing behaviour, pinned by a test;
  the implementer's `NOTE:` and pin-on-read closure sketch were reviewed and left as written.
- `base-pins.ts` — memory shape: retention proportional to the transaction's own write footprint.
  The implementer's `NOTE:` covers it; no change.

### Tests

Added 3 (1563 → 1566 in `db-core`), all fast unit-level, closing gaps where the only coverage was
the multi-second end-to-end pressure spec:

- `Atomic.commit` pin adoption — a 1-entry cache, two read-then-update pairs inside one atomic so
  the first base is evicted before the flush; asserts both declare with the right `baseRev`, and
  that the atomic reclaims its own store.
- A joined tracker (the `syncAttempts` shape: transforms by copy, pin store shared) declares an
  evicted base the *staging* tracker pinned.
- Joining a pin store from a tracker over a different base source throws.

The implementer's suite was otherwise sound and left intact: the pin-vs-eviction, stale-after-
`clear()`, stale-after-`transformCache()` (asserting the folded hash and explicitly *not* the stale
pinned one), one-probe-per-id, insert/delete-drops-pin, reset-retention, drift-blind-source, and
digest-pass-is-neutral cases all check the right things.

**Gap left open, deliberately:** no test drives a coordinator rollback and then asserts digest
coverage of the restored transaction specifically. The mechanism is covered by the reset-retention
unit test plus the green coordinator suite, and pins are generation-validated at use, so the
harness this would need is disproportionate to the residual risk. Not filed.

### Validation

`yarn lint` clean, `yarn typecheck` clean, `yarn build` clean. `db-core` 1566 passing, `db-p2p`
2492 passing. Full workspace `yarn test`: one failure in `@optimystic/reference-peer` —
distributed-diary "should handle concurrent writes from multiple nodes" exceeded its 10s mocha
timeout after one of three writers lost the super-majority race and backed off. Passed on an
immediate scoped re-run (6 passing). This test is already listed as INTERMITTENT in
`tickets/.pre-existing-known.md` with a tracking slug, so per that file it is not re-reported and no
`.pre-existing-error.md` was written. It is unrelated to this change (a 3-node libp2p consensus
race; nothing in this diff alters the pend/commit rounds).
