description: A node reading a stored block "as of" a moment in time crashed whenever that block was not the one changed at that moment — a very common case. The fix makes each block advertise that it can rebuild every revision from its first stored one onward, so those reads serve the correct prior state instead of throwing.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/helpers.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/test/block-storage.spec.ts
difficulty: medium
----

# `meta.ranges` coverage must be open-ended above the earliest committed rev

## Status: fix implemented and validated in the working tree

The fix, its tests, and the reasoning are already written and passing (`yarn test` in
`packages/db-p2p`: 1154 passing, 0 failing; `yarn build` clean). This ticket exists so the
implement stage can confirm the build/tests and produce the review handoff. The remaining TODOs at
the bottom are verification + handoff, not fresh implementation. **Read the "What changed and why"
section before touching anything** — the correction here differs from the candidate fix proposed in
the originating `st-ranges-sparse-coverage-breaks-historical-reads` ticket.

## The bug (recap)

`meta.ranges` records which revisions a storage node can locally reconstruct. `getBlock(rev)` means
"the block's state **as of** global rev N" and is served by `materializeBlock`'s **descending walk**
(`block-storage.ts`): it finds the highest committed rev **≤ N** and materialises it. `ensureRevision`
gates that serve on `inRanges(rev, meta.ranges)`; when the rev is not in range it calls
`restoreBlock`, which (with no `restoreCallback` wired in production) throws:

```
Error: Block <id> revision <n> not found during restore attempt.
```

The prior fix (`st-pend-seeds-open-ended-ranges`) made every committed revision claim only its own
single point `[rev, rev+1)`. Because a block is modified at a **sparse** subset of global revs, that
made `inRanges` false for any global rev between/above a block's modified revs — so a normal read of
a block **not** touched by the latest commit (b-tree siblings, header blocks — extremely common)
requested a rev above that block's last-modified rev and threw.

## What changed and why — the candidate fix was insufficient

The originating ticket proposed a **bounded contiguous span** `[E, L+1)` (E = earliest committed
rev, L = latest). **That does not fix the public-API reproduction**, and validation proved it: block
B inserted at rev 1, only sibling A modified at rev 2, then `repo.get({ blockIds:[B], context:{ rev:
2 }})`. B's latest is L=1, so `[E, L+1) = [1, 2)` does **not** contain rev 2 — the read still throws.
Reading a block *above* its own latest rev is legitimate and common (any cross-block read at the
collection tip after a later commit touched only siblings).

The correct model is **open-ended**: coverage is `[E, +∞)`. A descending walk from **any** target
rev ≥ E resolves to the highest committed rev ≤ target (at worst the latest, which is materialised),
so every rev ≥ E is serveable locally. Only revs **below E** are genuine gaps that should miss
`inRanges` and trigger restore. This is *not* a return to the old buggy `[[0]]` seed: `[[0]]` claimed
coverage from rev 0 (including the un-held revs below E, and before any commit exists). The fix
anchors the open-ended span at the block's **earliest held rev E**, and only after a revision is
actually committed/held. `RevisionRange` (`struct.ts`) already encodes open-ended as an undefined /
absent upper bound — an open range is stored as the single-element `[E]` (matching the old `[[0]]`
precedent), and `mergeRanges` + `inRanges` already handle `range[1] === undefined`.

### Sites changed (all in `block-storage.ts`)

- **`setLatest`** — captures `prevRev = meta.latest?.rev` before overwriting, then claims open-ended
  `[prevRev ?? latest.rev]`. First commit anchors the span at E = L; later commits merge into the
  existing `[E, +∞)`.
- **`saveReplica`** / **`saveDeletion`** — same open-ended claim `[prevRev ?? rev]` (prevRev < rev by
  the monotonic guard). Documented inline that a *stale replica* serving stale data for reads above
  its rev is a **replication-lag** concern, separate from what the node can locally *reconstruct*
  (which is exactly what `ranges` records). See tripwire below.
- **`recover`** — claims open-ended `[currentRev + 1]`; joins the prior `[E, currentRev+1)` into one
  `[E, +∞)`.
- **`savePendingTransaction`** — comment updated only; a fresh pend still seeds `[]` (nothing held).

### Tests (`test/block-storage.spec.ts`)

- Reversed the old `'non-contiguous commits stay disjoint (the gap survives)'` (it pinned the buggy
  point-range behaviour) → `'sparse commits extend one contiguous span'`, asserting `[[1]]`.
- Updated `'commit …'` and `'recover …'` assertions from `[[1,2]]` → `[[1]]`.
- Added `'getBlock(intermediateRev) between sparse commits serves the prior materialization (no
  throw)'` — reads rev 2 between commits at 1 and 3 with **no** restoreCallback.
- Added `'StorageRepo.get for a block unchanged at the collection tip serves its prior state'` — the
  public-API regression guard (block B read above its latest).
- Added `'genuine gap below the earliest reconstructible rev still misses inRanges'` — a block whose
  only commit is rev 5, read at rev 4, must still fire restore (proves the fix does not over-claim
  below E).

## Tripwire (already parked inline; index it in review findings)

`saveReplica`/`saveDeletion` now advertise open-ended coverage for a **replica** the node may hold
staler than the collection's true latest. Reading above the replica's rev serves the replica's rev
(reconstructable-honest) rather than triggering a restore/refetch of fresher data — a freshness vs.
reconstructability distinction. This is fine now (restore is unwired anyway — see
`st-recoverblock-no-production-caller`) and is documented in the `saveReplica` comment. **If**
replica freshness ever needs enforcing on reads, that is a cache-invalidation / refetch concern, not
a `ranges` change. Not a ticket — recorded here and at the code site.

## Interaction with siblings (context, not blockers)

- `st-recoverblock-no-production-caller` (`fix/`) wires a real `restoreCallback`. Until it lands, an
  over- or under-claiming `ranges` both fail loudly rather than silently repairing — so honest
  coverage matters now. This fix makes `inRanges` honest: true for all reconstructable revs (≥ E),
  false only for genuine sub-E gaps.
- `st-commit-contiguity-guard-premise` (`blocked/`) concerns commit *accepting* non-contiguous
  bases (write side). This ticket is read-side coverage. Cross-check that "gap" means the same on
  both: here a gap is strictly a rev **below** the earliest held materialization.

## TODO (implement stage: verify + hand off)

- Re-run `yarn test` in `packages/db-p2p` and confirm green (currently 1154 passing / 0 failing).
- Re-run `yarn build` in `packages/db-p2p` and confirm clean.
- Skim the four changed sites in `block-storage.ts` for comment/behaviour consistency (all four now
  claim open-ended anchored at the earliest held rev).
- Produce the `review/` handoff. In `## Review findings`, index the replica-staleness tripwire
  (parked in the `saveReplica` comment) and note the deviation from the originating ticket's
  candidate fix (open-ended `[E, +∞)`, not bounded `[E, L+1)`), so the reviewer checks that call.
