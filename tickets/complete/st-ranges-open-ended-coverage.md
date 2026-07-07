description: A node reading a stored block "as of" a past moment used to crash whenever that block was not the one changed at that moment — a very common case. The fix makes each block advertise that it can rebuild every revision from its first stored one onward, so those reads serve the correct prior state instead of throwing.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/helpers.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/helpers.spec.ts, packages/db-p2p/docs/storage.md
difficulty: medium
----

# Complete: `meta.ranges` coverage is open-ended above the earliest committed rev

## What shipped

Each storage node records which past revisions of a block it can locally rebuild, in `meta.ranges`.
`getBlock(rev)` ("state as of global rev N") is served by a **descending walk**: highest committed
rev ≤ N, then materialize. The fix makes every coverage-claim site advertise the **open-ended span
`[E, +∞)`** anchored at the block's earliest held rev E — stored as the single-element `[E]` (absent
upper bound = open-ended). Once the node holds the chain from E, every read at rev ≥ E resolves down
to the highest committed rev ≤ target (at worst the latest, which is materialized). Only revs **below
E** are genuine gaps that miss `inRanges` and (correctly) trigger restore.

Code lives in commit `07c310c` (the fix-stage commit carried the implementation and tests); the
implement-stage commit `1af6974` was the handoff move only. Sites: `setLatest`, `saveReplica`,
`saveDeletion`, `recover` all claim `[prevRev ?? <thisRev>]`; `savePendingTransaction` still seeds
`[]`.

## Review findings

Adversarial pass over the fix diff, `mergeRanges`/`inRanges` semantics, every touched file, and the
files the change should have touched (docs, sibling readers of `meta.ranges`).

### Correctness — checked, no defects

- **All 4 coverage sites + pend seed** (`block-storage.ts:53,90,116,155,213`): open-ended anchor at
  earliest held rev is sound. Traced first-commit anchor (`prevRev` undefined → anchor at this rev),
  later-commit merge into the existing `[E, +∞)`, and `recover` redoing a lost `setLatest` — all
  collapse to a single open-ended range.
- **`mergeRanges` under the single-element `[E]` open-ended form** (`helpers.ts:3`): verified two
  open-ended ranges never coexist (the lower-anchored one consumes the higher via the sorted
  "`last[1] === undefined` consumes followers" rule), and a **sub-E** bounded range produced by a
  restore stays correctly separate below the open-ended anchor. Well-covered by `helpers.spec.ts`.
- **Sub-E restore** (`genuine gap` test): restoring rev 4 under `[[5]]` merges to `[4, +∞)` — honest,
  because E moves down to the newly-held rev. Not an over-claim.
- **Reads above latest**: descending walk resolves to the latest materialization; the public-API
  regression (block unchanged at the collection tip) is guarded at `block-storage.spec.ts:176`.
- **No downstream bounded-upper-end assumption**: grep of `.ranges` / `RevisionRange` across
  `packages/` — only `db-p2p` consumes ranges, and `docs/storage.md:98-104` already documents
  `endRev?` absent = open. Nothing assumed a closed upper bound. Deviation from the originating
  ticket's bounded `[E, L+1)` candidate is confirmed **correct** — bounded fails the collection-tip
  read (rev above the block's own latest).

### Minor — fixed inline this pass

- **Stale bounded-model doc comments** (two sites) described the coverage as the bounded span
  `[E, L+1)` — the candidate model that was *not* shipped — contradicting the actual open-ended code
  and the very tests below them. Corrected to open-ended `[E, +∞)`:
  - `block-storage.spec.ts` header docstring ("EVERY rev in [E, L+1) is serveable" → "EVERY rev ≥ E …
    OPEN-ENDED span [E, +inf)").
  - `savePendingTransaction` comment (`block-storage.ts:57`, "contiguous span from the prior latest
    through the new rev" → open-ended anchored at E).
  Behavior-neutral; build + tests unaffected.

### Tripwire — recorded, not a ticket

- **Replica staleness vs. reconstructability** (parked inline at `block-storage.ts` in the
  `saveReplica`/`saveDeletion` comments). Those two now advertise open-ended coverage for a replica
  the node may hold staler than the collection's true latest; a read above the replica's rev serves
  the replica (reconstructable-honest) rather than refetching fresher data. Fine now — `ranges`
  records what the node can locally rebuild, which is exactly true, and restore is unwired
  (`st-recoverblock-no-production-caller`). **If** replica freshness ever needs enforcing on reads,
  that is a cache-invalidation / refetch concern, not a `ranges` change. Knowledge parked at the code
  site; this bullet is the index.

### Major — none

No major findings; no new tickets filed.

### Validation

- `yarn build` (tsc) in `packages/db-p2p`: **clean, exit 0**.
- `yarn test` in `packages/db-p2p`: **1154 passing, 36 pending, 0 failing** (~53s), including the four
  regression tests (intermediate sparse read, collection-tip public-API read, sub-E genuine gap,
  contiguous-span assertion) and the `mergeRanges` open-ended suite.

## Sibling context (not blockers)

- `st-recoverblock-no-production-caller` (`fix/`) wires a real `restoreCallback`. Until it lands,
  mis-claimed `ranges` fail loudly rather than silently repair — so honest coverage matters now. This
  fix makes `inRanges` true for all reconstructable revs (≥ E), false only for genuine sub-E gaps.
- `st-commit-contiguity-guard-premise` (`blocked/`) is the write side (commit accepting
  non-contiguous bases). This ticket is read-side coverage; "gap" means the same on both: a rev
  strictly **below** the earliest held materialization.
