description: Reading a frequently-updated block gets slower and slower during a long session because each read rebuilds the block by replaying every change ever made to it; cache the built result so reads stay fast.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/helpers.ts, packages/db-core/src/collection/collection.ts, packages/db-core/test/cache-source.spec.ts
difficulty: medium
---

## Problem (reproduced)

`Tracker.tryGet` (packages/db-core/src/transform/tracker.ts:14-35), on the `updates` path,
re-fetches the block from its source and replays **all** accumulated operations on every read:

```ts
const block = await this.source.tryGet(id);   // source clones the whole block
if (block) {
  const ops = this.transforms.updates?.[id] ?? [];
  ops.forEach(op => applyOperation(block!, op)); // O(ops); each op deep-clones its payload
}
return block;
```

A hot block that is updated once per operation (the collection header, the log tail) accumulates
an unbounded op list in a long-lived tracker, so each read is O(number of ops). Reading it once per
operation over a session is O(ops²), and tree descent multiplies the constant on every level.

Reproduced with a throwaway bench (already removed) against a bare `Tracker` over an in-memory
source: **100 ops → 0.34 ms/read, 2000 ops → 5.14 ms/read (15× cost for 20× ops)** — read cost is
linear in the accumulated op count, exactly as predicted.

## Root cause

The transformed block is recomputed from scratch every read even though neither the source block nor
the op list changed between most reads. Nothing memoizes the materialized (source + all-ops) result.

Note `insert`ed blocks do **not** have this problem: `update()` bakes ops into the inserted object
in place (tracker.ts:56-58) and `tryGet` returns a single clone of it (tracker.ts:23-24) — O(1) per
read. The regression is confined to the `updates`-over-source path.

## The staleness hazard (read this before choosing a design)

The tracker's `source` is **not immutable during the tracker's life.** In `Collection`
(packages/db-core/src/collection/collection.ts) the same `sourceCache` that a live tracker reads
through is mutated externally:

- `updateInternal` calls `this.sourceCache.clear(entry.blockIds)` and the invalidations
  `this.sourceCache.clear(revertedBlockIds)` (collection.ts:153, 166).
- `syncInternal` / `applyCommittedToCache` call `this.sourceCache.transformCache(...)`
  (collection.ts:334, 246).

So any cache of "source block + ops" can go stale if the underlying source content for that id
changes. Whatever caches the materialized block **must** be invalidated when either (a) the tracker's
own ops for that id change — handled internally — or (b) the source content for that id changes.

Analysis of the current `Collection` flows shows that whenever `sourceCache` changes for an
**op-carrying** block, `this.tracker` is also reset (a conflict on an op-carrying block sets
`anyConflicts`, and `replayActions`/`reset` clears the tracker; a successful sync resets too). That
argument makes a memo *happen* to be correct today — but it is a whole-program invariant that is easy
to break later. **Do not rely on it alone.** Make correctness local by having the source expose a
per-id generation the tracker can check (below). Plain/immutable sources (tests) opt out and keep the
current replay behavior.

## Chosen fix: per-id transformed-block memo in `Tracker`, guarded by a source generation

Cache the materialized block per id inside the tracker; keep it fresh incrementally on write; clear
it whenever the id's ops change; re-materialize when the source's generation for that id advances.
Reads become O(block size) (the unavoidable defensive clone) instead of O(block size + ops).

### `CacheSource` — expose a per-id generation (packages/db-core/src/transform/cache-source.ts)

Add a monotonically increasing counter per block id, bumped whenever the id's cached content changes,
and a getter:

```ts
private generations = new Map<BlockId, number>();
private bump(id: BlockId) { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); }
getGeneration(id: BlockId): number { return this.generations.get(id) ?? 0; }
```

Call `bump(id)` at every content-changing site:
- `tryGet` miss-load `this.cache.set(id, block)` (line 27),
- `clear(id)` for each cleared id, and `clear()` (bump all currently-cached ids, or a global epoch),
- `transformCache`: on each `delete`, each `inserts` `set`, and after each `applyOperation` on a
  cached block.

Over-bumping is safe (it only forces a re-materialize); under-bumping is a correctness bug, so err
toward bumping. A benign LRU evict+reload bumping the generation is acceptable.

Update `packages/db-core/test/cache-source.spec.ts` with a couple of assertions that `getGeneration`
advances on load / transformCache and is stable across pure cache hits.

### `Tracker` — memoize on the updates path (packages/db-core/src/transform/tracker.ts)

Add state and use `applyOperations` (already in helpers.ts) for the batch replay:

```ts
private materialized = new Map<BlockId, { block: T; gen: number }>();
private sourceGeneration(id: BlockId): number | undefined {
  const src = this.source as { getGeneration?: (id: BlockId) => number };
  return typeof src.getGeneration === 'function' ? src.getGeneration(id) : undefined;
}
```

`tryGet` updates branch (replaces tracker.ts:29-34):

```ts
const gen = this.sourceGeneration(id);
const memo = this.materialized.get(id);
if (memo && (gen === undefined || memo.gen === gen)) {
  return structuredClone(memo.block);           // O(block size), no replay
}
const block = await this.source.tryGet(id);
if (block) {
  const ops = this.transforms.updates?.[id] ?? [];
  if (ops.length > 0) {
    applyOperations(block, ops);
    // Memoize only when the source can tell us if it later changes. Without a generation
    // signal we cannot detect source drift, so fall back to the always-replay behavior.
    if (gen !== undefined) this.materialized.set(id, { block, gen });
    return structuredClone(block);              // clone so callers can't mutate the memo
  }
}
return block;                                    // no-ops path unchanged (source already cloned)
```

Keep the memo fresh / invalidate it at the mutation sites:
- `update` (tracker.ts:55-63): after pushing the op, if `this.materialized.has(blockId)`, apply the
  single op to the memoized block (`applyOperation(memo.block, op)`) and refresh `memo.gen` to the
  current `sourceGeneration(blockId)` — O(1), no full replay. (The memo already reflects source +
  prior ops, so applying the new op keeps it equal to the full ops list.)
- `insert` (tracker.ts:45-53): `this.materialized.delete(block.header.id)` (now served from inserts).
- `delete` (tracker.ts:65-70): `this.materialized.delete(blockId)`.
- `reset` (tracker.ts:72-76): `this.materialized.clear()`.

### Why this is correct

- Result identity: memo == `source + updates[id]` materialization == what the current replay produces;
  the defensive `structuredClone` on return preserves caller isolation. No observable change.
- Source drift: the generation guard forces re-materialize when `sourceCache` content for the id
  changed (clear / transformCache), so external cache mutation can't serve a stale memo.
- No-ops reads are never memoized, so plain source reads keep current semantics and the `insert` and
  `delete` precedence paths (tracker.ts:23-28) are untouched.
- Memory: one materialized block per op-carrying id — same order as `transforms.updates` already
  holds — and cleared on every `reset` (i.e. each sync). Bounded.

### Rejected alternative

Op-list compaction on write (materialize into a shadow cache once ops pass a threshold) has the
**same** source-staleness exposure as the memo but adds a threshold to tune and still needs the base
block to fold splice ops. The incremental memo makes reads O(1) with no threshold, so prefer it.
Pure op-level compaction (dropping superseded ops without the base) is unsafe for splice ops and is
out of scope.

## Regression test

Add `packages/db-core/test/tracker-read-perf.spec.ts`. Drive a `Tracker` over an in-memory source
(mirror the helpers in cache-source.spec.ts), apply many ops to one block, and assert read cost does
**not** scale with op count. Timing-based ratios are flaky in CI, so prefer a **counting** assertion:
wrap the source's `tryGet` (and/or count `applyOperation` invocations) and assert that N repeated
reads after K ops perform a bounded, op-count-independent amount of work (e.g. source is hit at most
once per distinct id after warmup; total op-applications across R reads is O(K), not O(K·R)). Include
one correctness case: a read after an external source change (bump the fake source's generation and
change its content) returns the new content, proving the guard invalidates the memo.

## TODO

- Add per-id generation tracking + `getGeneration` to `CacheSource`; bump at every content-changing
  site (miss-load, clear, transformCache delete/insert/update). Over-bump rather than under-bump.
- Add `getGeneration` assertions to `packages/db-core/test/cache-source.spec.ts`.
- Add the `materialized` memo to `Tracker`: read-path memo with generation guard; incremental refresh
  in `update`; invalidate in `insert`/`delete`/`reset`. Import/use `applyOperations`.
- Add `packages/db-core/test/tracker-read-perf.spec.ts` (counting-based scaling assertion + one
  source-drift correctness case).
- Run `yarn test` in packages/db-core (stream with `| tee`) and `yarn build` (tsc); confirm green.
- Sanity-check the `Collection` read paths (act/update/sync) still behave — the existing collection
  and network-transactor specs exercise them.
