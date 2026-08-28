description: The core library can now hash a block's agreed-on content and work out, from locally staged changes alone, what each block will contain after a commit — the groundwork for letting other nodes check a commit against what the client said it would write.
files: packages/db-core/src/blocks/helpers.ts, packages/db-core/src/cluster/membership.ts, packages/db-core/src/utility/canonical-json.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/utility/lru-map.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/index.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-core/test/digest.spec.ts, packages/db-core/test/cache-source.spec.ts, packages/db-core/test/lru-map.spec.ts, docs/internals.md
----

# Commit content digest — part 1 of 3: core primitives (complete)

Part 1 of the split from `commit-cert-bind-block-content-digest`. Parts 2 and 3
(`commit-cert-digest-threading`, `commit-cert-digest-member-check`) thread the digests through the
commit path and make members check them. This slice is primitives only — **no behavior changes**
beyond moving the canonical block-hash helper from db-p2p into db-core.

## What shipped

**Canonical block hash lives in db-core.** `canonicalBlockHash` moved from
`packages/db-p2p/src/cluster/quorum-restore.ts` to `packages/db-core/src/blocks/helpers.ts` and is
exported through the blocks barrel. db-p2p's `reconcile-block.ts` and `test/quorum-restore.spec.ts`
import it from `@optimystic/db-core`; no copy was left behind.

**Digest types.** `BlockContentDigest` (`digest`, plus `baseRev` except for base-independent
inserted blocks) and `BlockContentDigests` (per-id record) in `network/struct.ts`, with an optional
`blockDigests` field added to `CommitRequest` and `RepoCommitRequest`. Nothing produces or consumes
the field yet — that is parts 2 and 3.

**Recency-neutral reads.** `LruMap.peek` (read without refreshing eviction order),
`CacheSource.peek` (cloned cached block, no source consult, no read-dependency record), and
`CacheSource.getCachedRevision` (the source-learned materialized revision, deliberately not the
block's own `state.latest.rev`).

**`Tracker.peekMaterialized(id)`** — what a block materializes to under the staged transforms,
computed without loading from the source, plus the committed revision of the base used. Uses the
canonical `applyTransform`, the same function `StorageRepo.internalCommit` uses on the member side.

**`computeBlockContentDigests(tracker, blockIds)`** (`transform/digest.ts`) — per id,
`peekMaterialized`, skip if not locally computable, otherwise `canonicalBlockHash`.

## Review findings

**Read first**: the implement diff (`0b4a50e4`) end to end, plus every caller of the helpers it
touched — `transformForBlockId`, `applyTransform`, `transformCache`, and the member-side commit at
`packages/db-p2p/src/storage/storage-repo.ts:874`.

**Checked and confirmed correct** (no action):

- *Client/member semantic agreement.* `peekMaterialized` materializes with `applyTransform`, and the
  member side at `storage-repo.ts:874` calls the same function on the same shape. Verified rather
  than assumed.
- *The delete short-circuit the implementer flagged for scrutiny.* `peekMaterialized` returns early
  on any staged delete instead of letting `applyTransform` observe it. `applyTransform` returns
  `undefined` for `delete: true` unconditionally, regardless of what else the transform carries, so
  the two cannot diverge — including in the malformed insert-plus-delete state reachable through the
  phantom-delete path noted in `Tracker.tryGet`. In that state the short-circuit agrees with the
  *commit* path, which is the side that matters, even though it disagrees with `Tracker.tryGet`.
- *Digest accuracy when the cache moves under a staged transform.* If `transformCache` folds another
  action's commit into the base between staging and digesting, `peek`/`getCachedRevision` return the
  new content at the new revision, and the digest still describes exactly what commit will produce at
  that revision. (The transaction itself would fail read-dependency validation, but the digest is not
  wrong.)
- *Sequential hashing in `computeBlockContentDigests`.* Considered and rejected as a finding:
  SHA-256 is CPU-bound and Node runs it on one thread, so `Promise.all` would buy nothing here.
- *No import cycle* from the new `transform/digest.ts` to `blocks/helpers.ts` — the value-level
  imports go to concrete modules, not barrels.

**Minor — fixed in this pass:**

- *The diff introduced a second, byte-identical `canonicalJson` inside db-core*, sitting directly
  under a doc comment warning that a drifted copy "reports honest content as forged". Extracted to
  `packages/db-core/src/utility/canonical-json.ts`; `blocks/helpers.ts` and `cluster/membership.ts`
  both import it. Byte-identical implementations, so zero behavior change. (db-p2p's private
  `ClusterMember.canonicalJson` is a third copy — pre-existing, cross-package, and it hashes cluster
  records rather than blocks, so it stayed out of scope.)
- *`computeBlockContentDigests` was typed `Tracker<IBlock>`*, forcing callers holding a
  `Tracker<T>` to lean on TypeScript's method bivariance. Made generic over `T extends IBlock`.
- *Docs were stale.* `docs/internals.md` section "Mutation Contracts" lists every function that
  clones and why; the two new cloning entry points were missing. Added `CacheSource.peek()` and
  `Tracker.peekMaterialized()` to the "Functions That CLONE" table. No other doc the change touched
  or should have touched described behavior this slice altered — `blockDigests` has no runtime
  behavior yet, so documenting it belongs with parts 2 and 3.
- *Three test gaps*, all in `packages/db-core/test/digest.spec.ts`:
  - **insert with staged updates was entirely uncovered** — the branch whose in-line clone the
    implementer wrote a three-line comment to justify. It is reachable in normal use, because
    `Tracker.insert` clears a staged delete but not staged updates. Added a test asserting the digest
    describes insert-then-updates (what commit produces, not what `tryGet` serves) and that the
    staged insert stays pristine.
  - **the "require BOTH `peek` and `getCachedRevision`" guard was untested.** Added a test that
    evicts a block from a size-1 cache, confirms the stale revision entry lingers, and asserts the id
    is omitted rather than paired with the stale revision.
  - **the cache-corruption regression was not actually detectable.** The existing "leaves state
    observably unchanged" test used a scalar-set operation, which is idempotent — a peeked base that
    leaked back into the cache would have passed it. Switched it to a splice operation (visibly wrong
    if applied twice) and added an assertion on the cached base itself.

**Major — one ticket filed:** `tickets/backlog/debt-transform-for-block-id-clone-insert.md`.
`transformForBlockId` deep-clones `updates` but returns `insert` by reference, while every consumer
of the result mutates in place. This diff's `peekMaterialized` is the **third** site to hand-write
the same guard (after `test-transactor.ts`'s `applyTransformSafe`, and ahead of ticket
`commit-cert-digest-member-check`, which specifies a fourth). Filed at the invariant rather than the
instance — make the helper's clone contract total so no caller can forget — rather than as a bug
against this diff, which guards correctly. No live defect: every caller that skips the guard was
read, and none of them passes the result to `applyTransform`.

**Tripwire — recorded, not ticketed:** digest coverage is bounded by the read cache, not by the
transaction, so a commit touching more update-carrying blocks than the `CacheSource` capacity
(default 128) silently digests only the resident ones. Safe by design (omission falls back to
corroboration) but quieter than it looks. Parked as a `NOTE:` at the top of
`packages/db-core/src/transform/digest.ts`.

**Accepted tradeoffs left alone:** the never-pruned `generations` and `revisions` maps in
`CacheSource` each carry a `NOTE:` explaining the decision and its revisit condition. Neither
condition has tripped; not re-filed.

**Gaps deliberately not closed here** (they belong to the later slices, and are not defects):

- `blockDigests` still has no producer or consumer. The claim in its doc comment — that the generic
  cluster message hash folds it into every cohort signature with no helper change — remains an
  untested design assertion until part 2 wires it.
- Cross-package client/member digest agreement is only tested within db-core. The real equality
  against `StorageRepo.internalCommit`'s materialization is part 3's test surface.
- The `peek` clone contract is duck-typed, so a source double exposing `peek` without cloning could
  be mutated by `applyTransform`. Documented at both ends; only `CacheSource` implements it today.

## Validation

`yarn lint`, `yarn build`, `yarn typecheck`, and `yarn test` from the root — all green.
1411 passing in db-core (up from 1409: two tests added, one strengthened in place), 258 in db-p2p,
and the rest of the workspace unchanged. No pre-existing failures encountered.
