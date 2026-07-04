description: A storage node accepts a new version of a block even when it skipped intermediate versions, silently building the new version on stale data and serving a wrong result that diverges from other nodes. Add a check that rejects (or repairs) such gaps instead of caching a divergent block.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-core/src/network/struct.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# Commit accepts non-contiguous revisions — add a contiguity guard

## Problem (confirmed)

`StorageRepo.commit()` partitions each block's request into three buckets
(`storage-repo.ts:387-411`):

- **idempotent** — `latest.rev === request.rev && latest.actionId === request.actionId` → skip.
- **missedCommits** — `latest.rev >= request.rev` but a different action → stale conflict, returns
  `missing` transforms so the caller can catch itself up.
- **toCommit** — everything else (`latest.rev < request.rev`, or no `latest` yet).

The `toCommit` bucket does **not** distinguish "one ahead" (`latest.rev === request.rev - 1`,
the normal contiguous case) from "many ahead" (`latest.rev < request.rev - 1`, a gap — the node
missed one or more intermediate commits). Both fall through to `internalCommit`
(`storage-repo.ts:526-567`), which reads the prior materialized block at `latest.rev`
(line 540-543) and applies rev N's pending transform on top of it (line 547). When `latest.rev`
is older than `request.rev - 1`, that prior block is the **wrong base**: the resulting
materialization diverges from every up-to-date replica, is saved via `saveMaterializedBlock`
(line 550), recorded as revision N (`saveRevision`, line 556), and stamped as `latest` (line 560)
— then served to readers and cached as authoritative. No error, no signal.

Why restoration doesn't catch it today: `ensureRevision` (`block-storage.ts:225-254`) only fires
the restore callback when the target rev is outside `meta.ranges`. But `internalCommit` never
consults `ensureRevision` for its base — it reads `latest.rev`, which the node *does* hold — so
the missing *predecessor* (rev N-1) is never fetched. (The companion ticket
`st-pend-seeds-open-ended-ranges` fixes a separate lie in `meta.ranges` that would otherwise also
mask the gap from a read-path `getBlock`; this contiguity guard is independent of that fix because
it keys off `latest.rev`, not `ranges`.)

## Expected behavior

A commit whose `request.rev` is more than one ahead of the block's `latest.rev`
(`latest && latest.rev < request.rev - 1`) is a **gap**. The node must not materialize rev N on
the stale base. It must instead:

1. **Reject the commit with a distinct "behind" result** the caller can tell apart from an
   ordinary stale conflict — a normal stale means "*you* (caller) are behind, here are the newer
   transforms to apply"; a gap means "*I* (this node) am behind and cannot honor this commit
   because I lack the predecessor." The two are not interchangeable: on a gap the node has **no**
   `missing` transforms to hand back (that's the whole problem), so it must not masquerade as a
   normal stale with an empty `missing` list.

   *and/or (preferred when a restore path exists)*

2. **Restore the missing predecessor(s) first**, then materialize on the correct base. This keeps
   the node functional instead of stalling the write, but requires more surgery (see the
   restore-first stretch TODO) and only becomes observable once `st-pend-seeds-open-ended-ranges`
   makes `meta.ranges` honest. Treat this as an enhancement layered on top of the reject guard,
   not a replacement for it.

After the fix: applying a rev-N transform when the local `latest` is older than rev N-1 never
produces a locally-cached divergent block. The commit is either rejected as behind, or the missing
predecessor is restored and the transform is applied on the true rev N-1 base.

## Design — primary fix (reject on gap)

### 1. A distinct "behind" shape on `StaleFailure`

`CommitResult = CommitSuccess | StaleFailure` (`struct.ts:99`, `56-64`). `StaleFailure` already
carries optional `reason`, `missing`, `pending`. Add an optional, backward-compatible marker so a
gap is machine-distinguishable from a normal stale:

```ts
export type BehindBlock = {
	blockId: BlockId;
	/** The highest revision this node actually holds for the block. */
	have: number;
	/** The revision this node needs restored before it can honor request.rev. */
	need: number;   // === request.rev - 1
};

export type StaleFailure = {
	success: false;
	reason?: string;
	missing?: ActionTransforms[];
	pending?: ActionPending[];
	/**
	 * Blocks on which THIS node is behind: it lacks the predecessor revision(s)
	 * required to apply request.rev, so it returns no `missing` transforms. Distinct
	 * from `missing` (which reports commits the CALLER is behind on).
	 */
	behind?: BehindBlock[];
};
```

Existing consumers branch on `missing` (`network-transactor.ts:486, 577`) and on `success` — none
inspect unknown fields, so adding `behind` is non-breaking. Callers that want gap-aware retry can
opt in later.

### 2. Contiguity guard in the partition loop

In `StorageRepo.commit()` (`storage-repo.ts:387-411`), between the `latest.rev >= request.rev`
branch and the `toCommit.push(entry)` fallthrough, add the gap check:

```ts
// Gap guard: latest exists but is more than one revision behind request.rev.
// Materializing request.rev's transform onto this stale base would produce a
// block that diverges from up-to-date replicas. Reject as "behind" — we have no
// `missing` transforms to offer because we ourselves lack the predecessor(s).
if (latest && latest.rev < request.rev - 1) {
	behind.push({ blockId, have: latest.rev, need: request.rev - 1 });
	continue;
}
```

Collect `behind` alongside `missedCommits`, and after the partition loop, if any block is behind,
return before committing anything (mirror the `missedCommits.length` early return at line 413-419):

```ts
if (behind.length) {
	log('commit:behind actionId=%s behind=%d', request.actionId, behind.length);
	return {
		success: false,
		reason: `behind: missing predecessor revision(s) for block(s): ${behind.map(b => `${b.blockId}(have ${b.have}, need ${b.need})`).join(', ')}`,
		behind,
	};
}
```

Order the two early returns so a request that is *both* stale on one block and gapped on another
reports deterministically — pick one precedence (suggest: behind before missedCommits, since a
gapped node cannot even evaluate the stale set meaningfully) and note it in a comment.

### Scope notes / edge cases

- **`latest === undefined`** (no committed revision yet) is deliberately **out of scope** for this
  guard — it is the normal first-commit / pending-only-insert path, and an insert transform needs
  no predecessor. Do **not** treat a fresh block committing at rev > 1 as a gap here; if that turns
  out to be a real divergence vector it is a separate concern. Add a `NOTE:` at the guard site
  recording that `latest === undefined` is intentionally excluded so a future reader knows it was
  considered, not missed.
- The guard must sit **inside** the per-block partition loop (each block has its own `latest`),
  not once for the whole request — different blocks in one multi-block commit can be at different
  local revisions.

## Design — restore-first (stretch; optional, layered on the reject guard)

Only attempt if the reject guard is landed and green first. When a block is gapped and its
`BlockStorage` was constructed with a working `restoreCallback`:

- Trigger restoration of the predecessor before committing, e.g. `await storage.getBlock(request.rev - 1)`,
  which routes through `ensureRevision` → `restoreBlock` → `saveRestored` (`block-storage.ts:225-319`)
  and fills in the missing revision(s). This only fires correctly once
  `st-pend-seeds-open-ended-ranges` has made `meta.ranges` honest (otherwise `inRanges` short-circuits
  and the callback never runs) — hence the soft dependency.
- **Critical:** `internalCommit` currently materializes on `getBlock(latest.rev)` (`storage-repo.ts:540-543`).
  After restoring N-1, `latest` still points at the old rev, so the base is still wrong. The
  restore-first path must materialize on the block at `request.rev - 1`, not `latest.rev`. Either
  parameterize `internalCommit`'s base rev, or ensure the restore also advances the recorded
  revisions so the reverse-apply materialization in `materializeBlock` reconstructs rev N-1
  correctly.
- If `restoreCallback` is absent or restore fails, fall back to the reject "behind" result. Never
  proceed to materialize on the stale base.

## Reproduction / test (add to `packages/db-p2p/test/storage-repo.spec.ts`)

The existing harness (`storage-repo.spec.ts:42-49`) wires
`new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage))` over `MemoryRawStorage`,
with `makeInsertTransforms` / `makeUpdateTransforms` helpers and a `pend` → `commit` flow. Use it
to seed a block at rev K, then submit a commit for rev K+2 skipping K+1:

- pend + commit an insert at rev 1 (block present, `latest.rev === 1`).
- pend an update carrying `rev: 3` (skipping rev 2), then commit at rev 3.
- **Assert:** the commit returns `success: false` with a `behind` entry (`have: 1, need: 2`), and
  that a subsequent `get` of the block still returns the rev-1 materialization — i.e. no divergent
  rev-3 block was cached, and `latest.rev` is still 1.
- Contrast test (regression guard): a contiguous commit at rev 2 after rev 1 still succeeds and
  advances `latest` to 2, so the guard does not over-reject the normal case.

## Validation

- `cd packages/db-p2p && yarn test 2>&1 | tee /tmp/db-p2p-test.log` (stream, don't silently
  redirect). Confirm the new gap test and the contiguous-commit regression test pass and nothing
  else regresses.
- `yarn build` (or the repo's typecheck) to confirm the `struct.ts` `StaleFailure` addition and
  the `db-core` re-exports of `BehindBlock` typecheck across `db-core` and `db-p2p`.
- Check `packages/db-core/src/index.ts` exports so `BehindBlock` is re-exported if other packages
  need it.

## TODO

- Add `BehindBlock` type and optional `behind?: BehindBlock[]` field to `StaleFailure` in
  `packages/db-core/src/network/struct.ts`; re-export `BehindBlock` from `db-core`'s index.
- Add the contiguity guard (`latest && latest.rev < request.rev - 1`) inside the partition loop in
  `StorageRepo.commit()`, collecting a `behind` list and returning a distinct "behind"
  `StaleFailure` before any block is committed.
- Add a `NOTE:` comment at the guard site documenting that `latest === undefined` is intentionally
  excluded (first-commit / pending-only-insert path).
- Add the reproducing gap test and the contiguous-commit regression test to
  `packages/db-p2p/test/storage-repo.spec.ts`.
- Run `yarn test` (streamed) and the typecheck/build in `packages/db-p2p` (and `db-core` for the
  struct change); fix any fallout.
- (Stretch, optional — do only after the reject guard is green) Restore-first path: trigger
  predecessor restoration and materialize `internalCommit` on the true `request.rev - 1` base when
  a `restoreCallback` exists; fall back to the reject result otherwise. Note in the review handoff
  that this leans on `st-pend-seeds-open-ended-ranges` for honest `meta.ranges`.
