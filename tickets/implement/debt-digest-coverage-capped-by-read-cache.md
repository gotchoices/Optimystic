description: When a save touches more records than the local memory cache holds, the system can only describe the most recent hundred or so of them, and every record it fails to describe quietly loses the ability to be copied onto new machines. Fix it by remembering each record's starting content at the moment it is changed, so a save can always describe everything it changed.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/src/transform/base-pins.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/collection/collection.ts, packages/db-core/test/digest-cache-coverage.spec.ts, packages/db-core/test/digest.spec.ts
difficulty: hard
----

# Pin each updated block's base when the update is staged

## Background in one paragraph

When a change is committed, the committing node may declare, per block, the content digest that
block should hold once the commit lands (`CommitRequest.blockDigests` in `src/network/struct.ts`).
Cohort members re-materialize the block and vote reject if they disagree, and — the part that
matters here — the committing members retain a durable `BlockCommitProof` **only** for a block that
was declared. A block with no proof is refused by every push receiver running the default
`requirePushCertificate: true`. It stays readable, pullable, and repairable by corroboration while
two or more holders remain, but it can never **gain** a holder by push, so churn-driven
re-replication silently stops maintaining its replication factor. Declaring is optional and skipping
it never fails a commit, which is why the shortfall is invisible.

## The defect

`computeBlockContentDigests` (`src/transform/digest.ts`) describes a commit without loading anything
from the network: for each touched block it calls `Tracker.peekMaterialized`, which **peeks the read
cache right then** for the block's base. A `Collection` builds exactly one read cache — a
`CacheSource` LRU at the default capacity of 128 blocks (`collection.ts` `probeHeader`).

The digest pass runs at **sync time**, after every `act()` has already run. So a transaction that
touches more blocks than the cache holds has evicted its own early bases before it ever tries to
describe them. Measured through the production path in
`test/digest-cache-coverage.spec.ts`: with N update-carrying blocks the declared count is 32 at
N=32, then **126 at N=128, 200, 256 and 512 alike** (126 = the 128 slots less the collection header
and the log tail). Coverage does not thin out, it **caps** — it is `min(N, 126) / N`, decaying as
1/N, so an arbitrarily large commit declares an arbitrarily small fraction of itself.

The base is available at exactly one moment: **when the update is staged**, immediately after the
caller read the block. Capture it there and declarability stops being a function of cache residency.

## The design: a transaction-scoped base-pin store on the Tracker

A **pin** is the committed base content of one block, captured the first time an update is staged
for it, and held until the tracker's transforms are discarded. The digest pass materializes from the
pin instead of re-peeking the cache.

The base does **not** go into `Transforms`. It rides in a side table keyed by block id, shared by
reference between the trackers of one transaction. This is the decisive tradeoff against the
"carry the base inside the staged updates" shape the plan sketched: `Transforms` crosses the
pend/commit wire, and putting base content in it would bloat every pend by the full pre-image of
every updated block. A side table keeps `copyTransforms`, `blockIdsForTransforms`, the wire path and
`blockDigestsField` **byte-identical**.

### New: `src/transform/base-pins.ts`

```ts
/** The committed base of one block, captured at the moment an update for it was staged. */
export type PinnedBase = {
  /** Cloned base content. Callers MUST clone again before applying a transform — applyTransform
   *  mutates, and the same pin is re-used by every retry attempt's digest pass. */
  block: IBlock;
  /** Committed revision of that base (CacheSource.getCachedRevision at pin time). */
  rev: number;
  /** Source drift generation at pin time (CacheSource.getGeneration). A pin whose generation no
   *  longer matches the source's is STALE and must not be used. */
  gen: number;
};

/** Per-transaction map of block id -> PinnedBase. Owned by a Tracker, shared by reference across
 *  the trackers of one transaction (the collection's live tracker and each per-attempt snapshot). */
export class BasePins {
  get(id: BlockId): PinnedBase | undefined
  set(id: BlockId, pin: PinnedBase): void
  delete(id: BlockId): void
  /** Drop every pin whose id is not in `keep`. Called from Tracker.reset. */
  retainOnly(keep: Iterable<BlockId>): void
  /** Copy every entry of `other` in, overwriting. Called from Atomic.commit. */
  adopt(other: BasePins): void
  readonly size: number
}
```

### `Tracker` changes (`src/transform/tracker.ts`)

- Constructor gains a third optional parameter: `pins: BasePins = new BasePins()`, exposed as
  `public readonly pins`. Every existing `new Tracker(...)` call site keeps compiling unchanged.

- New probe, alongside the existing `sourceGeneration` duck-type:

  ```ts
  /** The committed base for `id` as this tracker's source can report it, plus that source's
   *  revision and drift generation. Duck-typed on the source (CacheSource supplies all three),
   *  and CHAINED when the source is itself a Tracker — the Atomic case — so an Atomic staged over
   *  a Collection's tracker pins from the collection's read cache instead of finding nothing.
   *  Returns undefined unless ALL THREE are available, which keeps drift-blind sources (test
   *  doubles) on exactly today's behaviour. Recency-neutral: uses CacheSource.peek. */
  protected probeBase(id: BlockId): PinnedBase | undefined
  ```

  TypeScript permits reading a `protected` member off another instance of the declaring class, so
  the chained branch (`this.source instanceof Tracker` -> `this.source.probeBase(id)`) type-checks
  from inside `Tracker`.

- `update(blockId, op)`: on the non-inserted branch, after appending the op, pin the base —
  **only when there is no fresh pin already**:

  ```ts
  const existing = this.pins.get(blockId);
  if (!existing || existing.gen !== this.sourceGeneration(blockId)) {
    const pin = this.probeBase(blockId);
    if (pin) this.pins.set(blockId, pin);
  }
  ```

  So a block updated 50 times pays one base clone, not 50. A generation change (an external commit
  folded into the cache) re-pins against the new base — which is right, because that is the base the
  member will apply the whole op list to.

- `insert(blockId)`: `this.pins.delete(id)` — an insert makes the result base-independent.
- `delete(blockId)`: `this.pins.delete(id)` — a delete materializes to nothing.
- `reset(newTransform)`: `this.pins.retainOnly(Object.keys(newTransform.updates ?? {}))`.
  This is the single reclamation point, and it is why **no new call sites are needed in
  `coordinator.ts`**: every transaction boundary there already calls `tracker.reset()` (empty ->
  pins cleared) or `tracker.reset(transforms)` (rollback -> pins kept for still-staged ids).

- `peekMaterialized(id)`: after the insert/delete branches, prefer a **fresh** pin, else fall
  through to today's live `peek`/`getCachedRevision` path unchanged:

  ```ts
  const pin = this.pins.get(id);
  if (pin && pin.gen === this.sourceGeneration(id)) {
    const block = applyTransform(structuredClone(pin.block), transform);
    return block ? { block, baseRev: pin.rev } : undefined;
  }
  // ...existing src.peek / src.getCachedRevision path...
  ```

  **The freshness check is correctness-critical, not an optimisation.** A stale pin would declare a
  digest the member disagrees with, turning a blind-but-passing vote into a REJECT. An inaccurate
  declaration is strictly worse than no declaration; when in doubt, omit.

  The `structuredClone` on use is also required, not defensive: `applyTransform` mutates, and
  `syncAttempts` re-runs the digest pass on every retry attempt against the same pins.

### `Atomic` changes (`src/transform/atomic.ts`)

`Collection.internalTransact` runs handlers against `new Atomic(this.tracker)` — an `Atomic` is a
`Tracker` whose source is the collection's tracker — and flushes with `applyTransformToStore` at
`commit()`. Without this leg, a single `act(...)` carrying more actions than the cache capacity
still loses coverage, because the flush (and therefore the pinning) happens only after every read in
the batch has already run.

Two things:
- `probeBase`'s chained branch lets `Atomic.update` reach the collection's `CacheSource` through the
  parent tracker, so it pins at the right instant.
- `Atomic.commit()` adopts its pins into the parent **before** resetting:

  ```ts
  commit() {
    if (this.store instanceof Tracker) this.store.pins.adopt(this.pins);
    const transform = this.reset();
    applyTransformToStore(transform, this.store);
  }
  ```

  Adopt-overwrites is deliberate: the atomic's pin is the later observation of the same base chain,
  and the use-time freshness check re-validates it anyway. Do **not** give the Atomic the parent's
  pin store directly — `Atomic.commit`'s own `reset()` would then wipe the parent's pins a line
  before flushing into it.

### `Collection` changes (`src/collection/collection.ts`)

One line in `syncAttempts` (~line 948): the per-attempt snapshot tracker must **share** the live
tracker's pin store, or the whole fix does nothing on the sync path (the snapshot inherits transforms
by copy and never calls `update()` for the data blocks).

```ts
const tracker = new Tracker(this.sourceCache, snapshot, this.tracker.pins);
```

`createReadTracker` (~line 702) keeps the default — a **fresh, private** pin store. It is a read
view that stages nothing and must not write into the live transaction's pins.

## What this does and does not fix

Fixed: any caller that reads a block and then updates it — every real caller, and the B-tree write
path specifically — declares 100% of its update-carrying blocks regardless of transaction size.

Still undeclared, correctly:
- deletes and delete-last-wins ids (materialize to nothing);
- a blind update to a block this node never read and that is not cached (there is genuinely nothing
  to declare, and a commit must never pay a network read to describe itself);
- **read-far-then-update**: a block read, then evicted by 128+ other reads, and only then updated.
  Pre-existing behaviour, unchanged by this work. `digest.spec.ts`'s `LRU-evicted base: omitted even
  though a stale cached revision lingers` pins exactly this and must keep passing. Record it as a
  `NOTE:` tripwire at the pin site in `tracker.ts` — if a workload ever reads a large batch before
  writing any of it, the closure is to pin on read for ids that later get updated, which costs
  retention proportional to reads rather than to writes.

## Edge cases & interactions

- **Delete-only / tombstone commit**: omitted, and `blockDigestsField` still omits the key entirely
  so the canonical-JSON preimage is byte-identical to a pre-field commit.
- **update-then-delete**: pin dropped by `delete`; id omitted (delete-last-wins).
- **update-then-insert** (both staged on one id, reachable because `insert` clears a staged delete
  but not staged updates): pin dropped by `insert`; result stays base-independent, `baseRev` absent.
- **Stale pin**: generation advanced between pin and use (`sourceCache.clear` on refresh,
  `transformCache` on a fold). Must fall through to the live peek, never declare from the pin.
- **Drift-blind source** (no `getGeneration`, or no `peek`/`getCachedRevision`): pins nothing;
  behaviour byte-identical to today. Every existing `digest.spec.ts` fixture must still pass.
- **Retry loop**: `syncAttempts` recomputes digests every attempt from the same pins — the use-time
  clone is what keeps attempt 2 from materializing against a base attempt 1 already mutated.
- **Snapshot-tracker sharing**: without the shared store the sync path is unfixed. Assert it with a
  test that goes through `Collection.act`/`sync`, not through the Tracker directly.
- **Coordinator rollback**: `collection.tracker.reset(structuredClone(transforms))` (coordinator.ts
  ~line 518) must keep pins for the restored ids; the several bare `reset()` sites must clear them.
  A failed collection's rollback must not disturb another collection's pins — they are separate
  stores, one per collection tracker; confirm no shared-store aliasing sneaks in.
- **`restorePending`**: same shape as coordinator rollback; pins survive for still-staged ids.
- **Unreplayable staged op**: must still degrade to "undeclared" via `peekOrSkip`, not throw out of
  `sync()` before the pend. The pin path replays through the same `applyTransform`, so a splice
  against a shrunk array now throws from a *pinned* base too — verify the catch still covers it.
- **Recency/memo neutrality**: `peekMaterialized` must stay recency- and memo-neutral, and the new
  pin capture in `update()` must be too (`CacheSource.peek` uses `LruMap.peek`). Pinning must not
  reshape eviction order — if it did, the pressure test would pass for the wrong reason.
- **Memory**: one base clone per update-carrying block, held from first update until the next
  `reset()`. Peak is proportional to the transaction's own write footprint — the same set of blocks
  whose ids and ops the commit request already carries — and is reclaimed at every transaction
  boundary. State the shape in a `NOTE:` at `BasePins`.
- **No wire change**: `Transforms`, `CommitRequest`, `BlockContentDigests` and `blockDigestsField`
  are untouched. A commit that declares nothing must still serialize exactly as before.

## Tests

Reproduce first. Before changing any `src/` file, switch the coverage spec's `update` module to
read-then-write and confirm the cap still appears (expect ~126 declared at 2x). That is what proves
the rewritten guard is a real guard rather than a test that was always going to pass. Note the
observed number in the review handoff. Do not leave a skipped or failing test behind.

`test/digest-cache-coverage.spec.ts` (rewrite):
- `update` module becomes read-then-write — `await store.tryGet(id)` then `store.update(id, op)` —
  which is what every production caller does; say so in the file header.
- keep the small (32-block) control unchanged.
- `declares every block it touches`: at 2x and 4x cache capacity, `updatedDeclared` deep-equals
  `updatedTouched`. Replaces `pins today's gap` and `the declared count saturates at the cache
  capacity` — retire both, and rewrite the file header (it currently asserts the cap as the
  contract) and the `CacheCapacity` NOTE about the un-pinned 126 table.
- new: `a blind update to a block this node never read stays undeclared` — the honest carve-out,
  using the old blind `update` module at 2x, asserting the undeclared ids are exactly the ones that
  were never read and that nothing was fetched to find out.
- new: `one act() carrying more actions than the cache capacity declares them all` — exercises the
  `Atomic.commit` pin adoption leg specifically (a single `act(...spread)` call).
- watch wall-clock: 4x is 512 blocks with a read each. Keep the suite well under the 10-minute idle
  timeout; if the 4x case is slow, drop to 3x rather than raising the mocha timeout past 120s.

`test/digest.spec.ts` (add):
- pin survives eviction: read `a` on a size-1 cache, update `a`, read `b` (evicts `a`), then assert
  the digest still declares `a` with `baseRev` 7 and a hash equal to
  `canonicalBlockHash(applyTransform(base, transform))`.
- stale pin is never used: pin `a`, then bump the generation (`cache.clear(['a'])`, and separately
  `cache.transformCache(...)`), and assert the result is omitted or recomputed from the live base —
  never the stale pinned value.
- one probe per id: 50 `update` calls on one id clone the base once (spy the source's `peek`).
- `insert` after `update` drops the pin (no `baseRev`); `delete` drops the pin (omitted).
- `reset()` empties the pin store; `reset(transforms)` retains exactly the ids still in `updates`.
- a source lacking `getGeneration` pins nothing and produces today's results.
- the existing idempotence test (two digest passes agree) must still pass, and the pin store must be
  unchanged after a digest pass.

Then: full `db-core` suite plus `tsc --noEmit` across the workspace (the Tracker constructor is
public API for `db-p2p` and the Quereus plugin).

## Comment/NOTE updates

- `src/transform/digest.ts`: the accepted-tradeoff `NOTE:` carrying the measurement table describes
  a contract that no longer holds. Rewrite it as the new contract — declarability follows what the
  transaction read and staged, not cache residency — and state the two remaining legitimate
  omissions (delete, never-read base) plus the read-far-then-update tripwire.
- `src/network/struct.ts`: **verified — its `NOTE:` does not cite the measurement.** It is an
  accepted tradeoff about keeping `blockDigests` optional, and its stated reasons (delete-only
  commits declare nothing, a lagging member abstains, the migration cost of required-but-nullable)
  all survive this change. The plan ticket said it needed rewriting; it does not. Leave it alone.
- `src/transform/tracker.ts`: `NOTE:` tripwires for the read-far-then-update residual gap and for
  the pin store's memory shape.

## TODO

Phase 1 — reproduce
- Switch the coverage spec's `update` module to read-then-write; run it against unmodified `src/`
  and record the declared count at 2x. Confirm the cap is still ~126.

Phase 2 — pin store and Tracker
- Add `src/transform/base-pins.ts` with `PinnedBase` and `BasePins` (`get`/`set`/`delete`/
  `retainOnly`/`adopt`/`size`) and the memory `NOTE:`.
- Add `pins` (third constructor param, `public readonly`) and `probeBase` to `Tracker`, with the
  Tracker-source chaining branch.
- Pin in `update` (fresh-pin guard); drop in `insert` and `delete`; prune in `reset`.
- Prefer a fresh pin in `peekMaterialized`, cloning on use; keep the live-peek fallback intact.
- Add the two `NOTE:` tripwires.

Phase 3 — Atomic and Collection wiring
- `Atomic.commit()` adopts its pins into the parent tracker before `reset()`.
- `syncAttempts` builds the snapshot tracker with `this.tracker.pins`.
- Confirm `createReadTracker` keeps a private store, and that no coordinator site needs a new call.

Phase 4 — tests and comments
- Rewrite `test/digest-cache-coverage.spec.ts` per the list above, including the new carve-out and
  single-`act()` cases and the header rewrite.
- Add the `test/digest.spec.ts` cases above.
- Rewrite the `digest.ts` NOTE; leave `struct.ts` alone.
- Run the full `db-core` suite and `tsc --noEmit`; report the 2x/4x declared counts and the coverage
  spec's wall-clock in the review handoff.
