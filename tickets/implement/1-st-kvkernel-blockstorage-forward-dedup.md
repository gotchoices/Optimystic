description: Two block-save methods (one for storing a replica, one for storing a deletion tombstone) are ~90% the same code; fold them into a single helper so the logic lives in one place.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts
difficulty: medium
----

# Collapse `saveReplica` / `saveDeletion` into one forward-write helper

`BlockStorage.saveReplica` (`block-storage.ts:155-211`) and `BlockStorage.saveDeletion`
(`block-storage.ts:213-262`) are ~90% identical. Both:

1. acquire the **same** latch (`BlockStorage.saveReplica:<blockId>` — deliberately shared so the
   two are mutually exclusive on a block; keep this),
2. read metadata and apply the **monotonic guard** (an equal-or-newer `latest.rev` already held ⇒
   return it, do not downgrade / rewrite),
3. build a one-revision `BlockArchive` and call `saveRestored`,
4. seed metadata when absent (`{ latest: undefined, ranges: [] }`), advance `latest`, then
   `meta.ranges.unshift([prevRev ?? rev])` + `mergeRanges` and `saveMetadata`,
5. return `meta.latest`, with a `log(...)`.

They differ **only** in the archive revision body and the derivation of `(rev, actionId)`:

- **replica**: `rev = source?.rev ?? 1`; `actionId = source?.actionId ?? hashString(...)`
  (deterministic fallback — never random/time-based, so a re-push stays idempotent); revision
  body `{ action: { actionId, rev, transform: { insert: block } }, block }` (materialized block
  present).
- **deletion**: `rev`/`actionId` from the required `source`; revision body
  `{ action: { actionId, rev, transform: { delete: true } } }` (no materialized block — a forward
  tombstone; `saveRestored` skips materialization when `block` is absent, and `materializeBlock`
  resolves the reverse-apply to an absent block, read back as `undefined`).

This is a pure db-p2p refactor with **no** dependency on the kernel work — it can land in
parallel. It exists as its own ticket only because it is a distinct, self-contained change in a
different method group than the kernel.

## Design

Extract one private method, e.g.:

```ts
private async saveForwardRevision(
	rev: number,
	actionId: ActionId,
	body: { action: ActionTransform; block?: IBlock },   // block present ⇒ replica; absent ⇒ tombstone
	logLabel: 'replica' | 'deletion',
): Promise<ActionRev>
```

that performs steps 1–5 (latch, monotonic guard, `saveRestored` of a one-revision archive with
`range: [rev, rev + 1]`, metadata seed/advance/merge, return). `saveReplica` and `saveDeletion`
become thin wrappers that compute `(rev, actionId)` and the revision body, then delegate. Keep the
public signatures and return values byte-for-byte identical. Preserve the two distinct `log`
lines' information (skip vs save; blockId/rev/actionId) — the `logLabel` selects the message.

## Edge cases & interactions

- **Shared latch must remain shared.** Both wrappers must pass through the **same**
  `BlockStorage.saveReplica:<blockId>` lock id (not a per-method lock), or the monotonic guard
  stops being sound against a concurrent replica+deletion on one block. Assert this in a test that
  interleaves a `saveReplica` and a `saveDeletion` on the same block.
- **Monotonic guard parity.** An equal-or-newer held `latest.rev` must still short-circuit and
  return the held `latest` **without** rewriting metadata (no `latest` downgrade, no `ranges`
  churn) — for both replica and deletion. Test: pre-seed `latest.rev = 5`, then a `saveReplica`
  at `rev 3` and a `saveDeletion` at `rev 3` each return the held rev-5 `latest` and leave
  metadata untouched.
- **`ranges` seeding stays honest.** The helper must keep the seed as `{ ranges: [] }` and the
  open-ended anchor `unshift([prevRev ?? rev])` + `mergeRanges` — **not** `[[0]]` (guards against
  reintroducing `st-pend-seeds-open-ended-ranges`, in `complete/`). Test: first replica on a fresh
  block seeds `ranges` anchored at `rev` (open-ended), not `[[0, …]]`.
- **Deletion tombstone read-back.** After `saveDeletion(source)`, `getBlock()` at that rev must
  return `undefined` (absent), not throw. Preserve the no-materialized-block archive body exactly.
- **Idempotent replica id.** The deterministic `hashString` fallback for a source-less replica
  must be unchanged — re-pushing the same block resolves to the same `(rev, actionId)`. Do not
  move the hash call outside the wrapper in a way that changes its inputs.
- **Interaction with the kernel ticket.** None at the type level — this touches `BlockStorage`
  (above `IRawStorage`), which the kernel does not change. If both land, the kernel's conformance
  suite's `BlockStorage` parity slice exercises this helper for free; no merge coupling.

## TODO

- Extract `saveForwardRevision`; rewrite `saveReplica`/`saveDeletion` as wrappers.
- Add/extend `db-p2p` tests: shared-latch mutual exclusion, monotonic guard for both paths,
  fresh-block `ranges` anchor (not `[[0]]`), deletion read-back `undefined`, idempotent replica id.
- `yarn test:db-p2p 2>&1 | tee /tmp/fwd-dedup.log`; typecheck.
