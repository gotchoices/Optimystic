description: A node reading a stored block "as of" a past moment used to crash whenever that block was not the one changed at that moment — a very common case. The fix makes each block advertise that it can rebuild every revision from its first stored one onward, so those reads serve the correct prior state instead of throwing.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/helpers.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/test/block-storage.spec.ts
difficulty: medium
----

# Review: `meta.ranges` coverage is open-ended above the earliest committed rev

## What this fix does (plain language)

Each storage node tracks which past revisions of a block it can rebuild locally, in a list called
`meta.ranges`. A read `getBlock(rev)` means "give me this block's state **as of** global revision N".
It is served by a **descending walk**: find the highest committed revision **≤ N** and materialize it.

The bug: a block is only modified at a *sparse* subset of global revs. The prior fix claimed each
committed rev covered only its own single point `[rev, rev+1)`. So reading a block at any global rev
between or above its own modified revs — which happens constantly, because sibling b-tree nodes and
header blocks are untouched by most commits — missed `inRanges`, hit the (unwired) restore path, and
threw:

```
Error: Block <id> revision <n> not found during restore attempt.
```

The fix: once a node holds the chain from a block's **earliest committed rev E**, every rev ≥ E is
serveable (the descending walk lands on the highest committed rev ≤ target, at worst the latest,
which is materialized). So coverage is the **open-ended span `[E, +∞)`**, stored as the single-element
`[E]` (undefined upper bound = open-ended, already handled by `mergeRanges`/`inRanges`). Only revs
**below E** are genuine gaps that miss `inRanges` and (correctly) trigger restore.

## Validation status (confirmed this run)

- `yarn build` (tsc) in `packages/db-p2p`: **clean, exit 0**.
- `yarn test` in `packages/db-p2p`: **1154 passing, 36 pending, 0 failing** (45s).

## Where to look

All four coverage-claim sites are in `packages/db-p2p/src/storage/block-storage.ts`, and all four now
claim open-ended coverage anchored at the earliest held rev (`[prevRev ?? <thisRev>]`):

- **`setLatest`** (`block-storage.ts:90`) — captures `prevRev = meta.latest?.rev` before overwriting,
  claims `[prevRev ?? latest.rev]`. First commit anchors at E = L; later commits merge into `[E, +∞)`.
- **`saveReplica`** (`block-storage.ts:155`) — `[prevRev ?? rev]`, prevRev < rev by the monotonic guard.
- **`saveDeletion`** (`block-storage.ts:213`) — same open-ended claim `[prevRev ?? rev]`.
- **`recover`** (`block-storage.ts:116`) — claims `[currentRev + 1]`; joins prior `[E, currentRev+1)`
  into one `[E, +∞)`.
- **`savePendingTransaction`** (`block-storage.ts:53`) — unchanged behaviour: a fresh pend still seeds
  `[]` (nothing held); comment only.

Supporting: `mergeRanges` (`helpers.ts:3`) folds `[E]` into the existing span and lets an open-ended
range consume all followers; `inRanges` (`block-storage.ts:360`) treats `range[1] === undefined` as
open-ended; `RevisionRange` (`struct.ts:3`) is `[startRev, endRev?]` with absent `endRev` = open-ended.

## Use cases the reviewer should exercise (tests are the floor, not the ceiling)

The four regression tests live in `packages/db-p2p/test/block-storage.spec.ts`:

- **`getBlock(intermediateRev) between sparse commits …`** (`:150`) — commits at rev 1 and 3, reads
  rev 2 with **no** restoreCallback; must serve rev-1 materialization, not throw.
- **`StorageRepo.get for a block unchanged at the collection tip …`** (`:176`) — the **public-API
  regression guard**. Blocks A and B inserted at rev 1; only A modified at rev 2; `repo.get` of B at
  rev 2 must serve B's rev-1 state. This is the reproduction the originating ticket's candidate fix
  did **not** satisfy (see below).
- **`genuine gap below the earliest reconstructible rev …`** (`:210`) — a block whose only commit is
  rev 5, read at rev 4, must still miss `inRanges` and fire restore. Proves the fix does **not**
  over-claim below E.
- **`sparse commits extend one contiguous span …`** (`:123`) — asserts coverage stays `[[1]]` across
  a sparse commit.

Worth probing beyond these:
- **Multiple disjoint would-be gaps then a read in each** — confirm the open-ended span collapses them
  all (there should never be more than one range once E is anchored, absent a sub-E restore).
- **`saveReplica`/`saveDeletion` seeding metadata from absent** (prevRev undefined) then a read above
  the seeded rev — confirms the first-write anchor at `rev` behaves.
- **`recover` after several lost `setLatest` calls** — confirm the merged result is a single `[E, +∞)`,
  not fragments.

## Deviation from the originating ticket — REVIEWER, CHECK THIS CALL

The originating `st-ranges-sparse-coverage-breaks-historical-reads` ticket proposed a **bounded
contiguous span `[E, L+1)`** (E = earliest, L = latest). That is **insufficient** and validation
proved it: block B inserted at rev 1, only sibling A modified at rev 2, then `repo.get(B, rev 2)`. B's
latest is L=1, so `[E, L+1) = [1, 2)` does **not** contain rev 2 — the read still throws. Reading a
block *above* its own latest rev is legitimate and common (any cross-block read at the collection tip
after a later commit touched only siblings). The correct model is **open-ended `[E, +∞)`**, which this
fix implements. Reviewer should confirm the open-ended choice is sound and that nothing downstream
assumed a bounded upper end on `meta.ranges`.

## Review findings

- **Tripwire — replica staleness vs. reconstructability (parked inline at `block-storage.ts:197`,
  in the `saveReplica` comment; same concern applies to `saveDeletion:250`).** `saveReplica`/
  `saveDeletion` now advertise open-ended coverage for a **replica** the node may hold staler than the
  collection's true latest. A read above the replica's rev serves the replica's rev
  (reconstructable-honest) instead of triggering a restore/refetch of fresher data — a *freshness* vs.
  *reconstructability* distinction. Fine now: `ranges` records what the node can locally rebuild, which
  is exactly true here, and restore is unwired anyway (`st-recoverblock-no-production-caller`). **If**
  replica freshness ever needs enforcing on reads, that is a cache-invalidation / refetch concern, not
  a `ranges` change. Not a ticket — knowledge parked at the code site and indexed here.
- **Deviation from candidate fix — flagged above.** This fix ships open-ended `[E, +∞)`, not the
  originating ticket's bounded `[E, L+1)`. Reviewer should verify the open-ended semantics against any
  code that reads `meta.ranges` expecting a closed upper bound (none found in this package; confirm).

## Sibling context (not blockers)

- `st-recoverblock-no-production-caller` (`fix/`) wires a real `restoreCallback`. Until it lands, an
  over- or under-claiming `ranges` both fail loudly rather than silently repairing — so honest
  coverage matters now. This fix makes `inRanges` true for all reconstructable revs (≥ E), false only
  for genuine sub-E gaps.
- `st-commit-contiguity-guard-premise` (`blocked/`) is the write side (commit accepting
  non-contiguous bases). This ticket is read-side coverage. "Gap" means the same on both: strictly a
  rev **below** the earliest held materialization.
