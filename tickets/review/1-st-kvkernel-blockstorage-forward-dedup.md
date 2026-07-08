description: A code-review pass over a refactor that folded two near-identical block-save methods (store-a-replica and store-a-deletion-marker) into one shared helper.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/test/block-storage.spec.ts
difficulty: medium
----

# Review: collapse `saveReplica` / `saveDeletion` into one forward-write helper

## What changed

`BlockStorage.saveReplica` and `BlockStorage.saveDeletion` were ~90% identical. They are now
thin wrappers over a new private `saveForwardRevision(rev, actionId, body, logLabel)` that owns
the shared steps: acquire the block's metadata latch, apply the monotonic guard, `saveRestored`
a one-revision archive, seed/advance/merge metadata, return `meta.latest`.

The wrappers still compute the caller-specific bits and delegate:

- **`saveReplica(block, source?)`** — `rev = source?.rev ?? 1`; `actionId = source?.actionId ??
  await hashString(\`${blockId}:${JSON.stringify(block)}\`)` (deterministic, idempotent fallback);
  body `{ action: { actionId, rev, transform: { insert: block } }, block }` (materialized block present).
- **`saveDeletion(source)`** — `rev`/`actionId` from the required `source`; body
  `{ action: { actionId, rev, transform: { delete: true } } }` (no materialized block — a forward tombstone).

Public signatures and return values are unchanged. The two `log` lines are preserved via the
`logLabel` param (`'%s:skip …'` / `'%s:save …'` with `logLabel` = `'replica' | 'deletion'`).

### Files

- `packages/db-p2p/src/storage/block-storage.ts` — `saveReplica` (now ~L155), `saveDeletion`
  (~L167), new `saveForwardRevision` (~L189). Added `ActionTransform` to the db-core type import.
- `packages/db-p2p/test/block-storage.spec.ts` — 6 new tests appended (see below).

## What the reviewer should verify

The dedup is mechanical, but the shared helper concentrates several invariants that were
previously duplicated. Confirm each still holds — treat the tests below as a floor, not proof.

- **Shared latch is still shared.** `saveForwardRevision` uses lock id
  `BlockStorage.saveReplica:<blockId>` for BOTH callers (NOT a per-method key). If this ever
  drifts to a per-method lock, the monotonic guard stops being sound against a concurrent
  replica+deletion on one block. Covered by *"saveReplica and saveDeletion are mutually exclusive
  on one block (shared latch)"* — a `LatchProbeStorage` subclass widens the `getMetadata` window
  and asserts zero concurrent reads. **Note the test's mechanism:** it counts `getMetadata` calls
  in flight (self-balanced inc/dec inside the override) rather than pairing get/save — the earlier
  depth-counter approach leaked on the guard-skip path (a guard skip reads metadata but never
  writes it). If you extend this probe, keep the counter self-balanced or the guard-skip path will
  produce a false positive.
- **Monotonic guard parity.** An equal-or-newer held `latest.rev` short-circuits and returns the
  held `latest` WITHOUT rewriting metadata, for both paths. Covered by the two *"monotonic guard:
  a lower-rev {replica,deletion} …"* tests (pre-seed rev 5, call at rev 3, assert `deep.equal`
  on before/after metadata). The before/after `deep.equal` is the real assertion — it catches any
  stray `ranges` churn or `latest` downgrade on the skip path.
- **`ranges` seeding stays honest.** Helper seeds `{ ranges: [] }` and anchors
  `unshift([prevRev ?? rev])` + `mergeRanges` — NOT `[[0]]` (guards against reintroducing
  `st-pend-seeds-open-ended-ranges`, in `complete/`). Covered by *"fresh replica seeds open-ended
  ranges anchored at rev (not [[0]])"* — asserts `[[1]]`, explicitly not `[[0]]` or `[[1,2]]`.
- **Deletion tombstone read-back.** After a `saveReplica` at rev 1 then `saveDeletion` at rev 2,
  `getBlock()` returns `undefined` (absent, not thrown) and `getBlock(1)` still serves the live
  block. Covered by *"deletion tombstone reads back as undefined"*. The absent-block resolution
  relies on `materializeBlock` reverse-applying `{ delete: true }` to `undefined` and returning
  early — confirm that early-return still precedes the `saveMaterializedBlock` in that method.
- **Idempotent replica id.** Source-less `saveReplica(block)` called twice returns the same
  `(rev, actionId)`; the id equals `hashString(\`${blockId}:${JSON.stringify(block)}\`)`. Covered
  by *"source-less replica derives rev=1 and a deterministic (idempotent) actionId"*. Check the
  hash call was not hoisted in a way that changes its inputs — the wrapper still computes it from
  `blockId` + the exact block JSON.

## Test / validation commands

From `packages/db-p2p`:

```
yarn test                 # full db-p2p suite: 1266 passing, 36 pending (40s)
npx tsc --noEmit          # typecheck: exit 0 (checks src + tests; the test runner strips types)
```

Focused run for just this file (spec reporter shows the 6 new tests):

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/block-storage.spec.ts" --reporter spec
```

Note there is no `yarn test:db-p2p` script (the ticket named one that doesn't exist); the db-p2p
suite is `yarn test` inside `packages/db-p2p`, or `yarn test` at the repo root for all workspaces.

## Known gaps / honest notes

- **Latch test is timing-shaped, not a proof.** The shared-latch test relies on a 5ms `setTimeout`
  gap to open the interleave window; it demonstrates mutual exclusion under the current event-loop
  behavior but is not a formal guarantee. It reliably distinguishes shared-vs-per-method latch as
  written (ran green, ~50ms). If it ever flakes, the gap widening — not the production code — is
  the place to look first.
- **Tombstone-on-fresh-block is untested.** The read-back test deletes a block that was first
  written as a replica (the real use case). `saveDeletion` on a block with NO prior materialization
  is not exercised here; `materializeBlock` would throw "Failed to find materialized block" for a
  read at that rev (a genuine-truncation throw, unchanged by this refactor). Flag only — not a
  regression this ticket introduces.
- **No interaction with the kernel tickets.** This touches `BlockStorage` (above `IRawStorage`),
  which the `st-kvkernel-*` tickets do not change. No merge coupling; can land independently.

## Review findings

(reviewer fills this in)
