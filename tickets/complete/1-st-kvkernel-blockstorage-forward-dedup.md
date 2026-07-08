description: Reviewed and accepted a refactor that folded two near-identical block-save methods (store-a-replica and store-a-deletion-marker) into one shared helper.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/block-storage.spec.ts
difficulty: medium
----

# Complete: collapse `saveReplica` / `saveDeletion` into one forward-write helper

## What changed

`BlockStorage.saveReplica` and `BlockStorage.saveDeletion` were ~90% identical. They are now
thin wrappers over a new private `saveForwardRevision(rev, actionId, body, logLabel)` that owns
the shared steps: acquire the block's metadata latch, apply the monotonic guard, `saveRestored`
a one-revision archive, seed/advance/merge metadata, return `meta.latest`. Public signatures and
return values are unchanged. See the implement commit `27c81e9` for the full diff.

## Review findings

Adversarial pass over commit `27c81e9`. Validation: `npx tsc --noEmit` exit 0; the focused
`block-storage.spec.ts` run is 14/14 green; full `packages/db-p2p` suite **1266 passing, 36
pending** (matches the implementer's claim). No pre-existing failures surfaced, so no
`.pre-existing-error.md` was written.

### Checked — behavior preservation (the core risk of a dedup)
- **Byte-for-byte equivalence.** The two old bodies collapse into the helper with the ONLY
  differences folded into `body` + `logLabel`: same lock id (`BlockStorage.saveReplica:<blockId>`,
  shared — not per-method), same monotonic guard (`meta.latest.rev >= rev`), same
  `unshift([prevRev ?? rev])` anchor + `mergeRanges`, same `range: [rev, rev+1]`. Log lines resolve
  to the identical `replica:…` / `deletion:…` strings via `%s`. No behavior drift.
- **Shared latch is genuinely shared and the probe test is sound.** `saveForwardRevision` issues
  exactly one `getMetadata` per op (neither `saveRestored` nor `saveMetadata` reads metadata), so
  the test's self-balanced in-flight counter is a valid shared-vs-per-method discriminator — a
  per-method latch would let the two 5ms read windows overlap and trip `overlaps`.
- **Guard-skip return.** `meta.latest` is guaranteed defined by the guard's `meta?.latest &&`
  short-circuit; the `Promise<ActionRev>` return is safe on the skip path.
- **Callers unaffected.** `invalidation.ts` (saveReplica + saveDeletion) and `storage-repo.ts`
  (saveReplica) use the unchanged public signatures; `invalidation.spec.ts` exercises both and is
  green in the full suite.
- **Untested-but-equivalent path.** `saveReplica` on a pending-only block (meta present,
  `latest` undefined): guard skipped, `prevRev` undefined, existing `[]` ranges preserved, anchors
  `[rev]` — logic identical to pre-refactor, so the absence of a dedicated test is not a regression.

### Checked — the invariants the ticket flagged
- Monotonic guard parity (before/after `deep.equal` on the skip path) — covered, verified.
- `ranges` seeding anchored at rev, not `[[0]]` — covered (`[[1]]` asserted), verified.
- Deletion tombstone reads back as `undefined` — covered; the `materializeBlock` early-return
  (lines 316–322) still precedes `saveMaterializedBlock` (line 323). That code is OUTSIDE this
  diff (pre-existing tombstone handling); the new read-back test now exercises it and it holds.
- Idempotent source-less replica id (`hashString(\`${blockId}:${JSON.stringify(block)}\`)`) —
  covered, verified; the hash inputs were not altered by the wrapper.

### Findings by disposition
- **Minor (fixed inline):** none — nothing warranted an inline fix.
- **Major (new tickets):** none — the refactor is clean and behavior-preserving.
- **Tripwire (parked, not filed):** deleted-block reads re-walk `listRevisions` and re-apply the
  `{ delete: true }` transform on EVERY `getBlock()` at the tombstone rev — the `undefined`
  materialization is never cached (the early-return at `materializeBlock:316` fires before the
  `saveMaterializedBlock` at `:323`). This is **pre-existing** (that method is untouched by this
  ticket) and only matters if deleted blocks become hot-read; deleted blocks are not typically
  hot. Recorded here as an observation only — no code comment added, since the site is outside
  this ticket's diff and doing so would be scope creep. Revisit only if tombstone reads ever show
  up as slow.

### Known gaps (accepted, from the implementer — re-confirmed honest)
- The shared-latch test is timing-shaped (5ms `setTimeout` gap), not a formal proof; it reliably
  distinguishes shared-vs-per-method as written. If it ever flakes, widen the gap — not the code.
- `saveDeletion` on a block with NO prior materialization is not exercised (would throw the
  genuine-truncation "Failed to find materialized block"); unchanged by this refactor.
- No coupling with the `st-kvkernel-*` tickets — this sits above `IRawStorage`; lands independently.

## Outcome

Accepted as-is. No inline fixes, no follow-up tickets. The dedup is mechanical and
behavior-preserving; tests, typecheck, and the full suite pass.

## End
