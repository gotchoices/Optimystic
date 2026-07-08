description: Build one shared storage core so the four block-storage backends stop being copy-pasted clones, and add a single test suite that proves all four still behave identically.
prereq:
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/testing/index.ts, packages/db-p2p/src/storage/block-storage.ts
difficulty: hard
----

# Shared ordered-KV storage kernel: `KvRawStorage` + `RawStoreDriver` + conformance suite

## Background — what is actually duplicated (and what isn't)

Four packages implement `IRawStorage` (`packages/db-p2p/src/storage/i-raw-storage.ts`):
LevelDB/React-Native (`db-p2p-storage-rn`), NativeScript SQLite (`db-p2p-storage-ns`),
IndexedDB/web (`db-p2p-storage-web`), filesystem (`db-p2p-storage-fs`), plus the in-memory
`MemoryRawStorage` in `db-p2p` itself. The originating plan ticket described these as
"~150-line near-clones over one key-value primitive." That is **half right**, and the
correction is the whole design:

- They **do** share: JSON (de)serialization of the same four value types
  (`BlockMetadata`, `Transform`/`ActionTransforms`, `IBlock`, and the `ActionId` string);
  the `listRevisions` ascending/descending bound computation; the "put block, or delete when
  block is absent" branch in `saveMaterializedBlock`; the get-then-parse-or-`undefined`
  pattern; and — critically — four **near-identical copies of the same test spec**
  (`test/*-storage.spec.ts` in each package).
- They **do not** share a storage topology. LevelDB is a single ordered byte-keyspace
  (tag-prefixed keys, see `db-p2p-storage-rn/src/keys.ts`). SQLite is five relational tables.
  IndexedDB is five object stores with compound array keys. fs is a directory tree, one file
  per item. **Forcing all four onto one flat byte-KV** (adopting `LevelDBLike` as the kernel
  surface, as the plan floated) would require a **breaking on-disk format change for SQLite
  and IndexedDB**, would lose SQLite's queryable columns, and **cannot work for fs at all**
  (see the atomicity note below). So we do **not** do that.

### The seam we picked

The genuinely-shared logic lives **above** the storage primitive, in value-serialization and
call orchestration — **not** in the key/topology layer. So the kernel is a **typed
multi-store driver**: each backend exposes the five logical stores over its *native*
mechanism (LevelDB tag-ranges / 5 SQLite tables / 5 IndexedDB stores / 5 fs subdirs), speaking
**bytes** for values, and `KvRawStorage` layers the shared serialization + orchestration on top.

```
   BlockStorage (unchanged)
        │  IRawStorage
   ┌────▼──────────────────────────────────────┐
   │ KvRawStorage  implements IRawStorage       │   ← ONE shared body, in db-p2p
   │  · JSON/string codec (all 4 value types)   │
   │  · listRevisions lo/hi/reverse → range     │
   │  · saveMaterializedBlock put-or-delete     │
   │  · promotePendingTransaction → driver.promote
   │  · getApproximateBytesUsed/listBlockIds → passthrough
   └────┬───────────────────────────────────────┘
        │  RawStoreDriver  (bytes-valued, per-store)
   ┌────┴───────┬───────────┬────────────┬───────────┐
 LevelDB      SQLite     IndexedDB       fs        Memory
 (rn)          (ns)        (web)        (fs)       (db-p2p)
```

### Why promote is a driver primitive, not a generic batch (the fs-atomicity contract)

The **only** operation in the whole storage layer that needs cross-key atomicity is
`promotePendingTransaction`: it moves one item from the `pending` store to the `transactions`
store, and a crash must leave exactly one of the two states, never both/neither
(see `st-recoverblock-no-production-caller`, now in `complete/`). Every other write is a single
`put` (`setLatest` is one `saveMetadata`; `saveRestored` issues independent puts with no
atomicity claim today).

Because promote is the sole atomic op, the kernel does **not** define a general
"atomic batch" — which fs could not honor (its atomic-write contract from
`st-filestorage-non-atomic-write-corruption`, now in `complete/`, gives per-file atomicity via
temp-file+rename, not multi-file transactions). Instead `RawStoreDriver.promote(blockId,
actionId)` is a first-class primitive each backend satisfies with its **native** atomic
mechanism: LevelDB `batch().put().delete().write()`, SQLite `db.transaction(...)`, IndexedDB one
`readwrite` transaction, and **fs a single `rename(pend→actions)`** — which is atomic precisely
because it is one rename. This is the resolution the plan asked for: the kernel never assumes an
atomicity fs cannot deliver, and fs is a **first-class driver, not an excluded special case**.

### Three wins beyond DRY (state these honestly — the LOC saving alone is modest)

1. **One conformance suite replaces four copied spec files.** Behavior parity across backends
   becomes a single maintained target instead of four drifting copies.
2. **The clone-on-store / clone-on-read pitfall dissolves structurally.** `MemoryRawStorage`
   today must `structuredClone` on every get/put or callers corrupt stored state (see its
   `@pitfall` comments and `docs/internals.md` "Storage Returns References"). In `KvRawStorage`
   values cross the driver boundary as `Uint8Array` produced by `JSON`-encode and consumed by
   `JSON`-decode, so every read yields a fresh object and every write stores an independent
   copy **by construction** — the in-memory driver stores byte copies, no `structuredClone`
   discipline required. This is a correctness upgrade, not just cleanup
   (`st-storage-assorted-cleanliness-bugs`, in `complete/`).
3. **A single write path to hang a future byte counter on.** The capacity/sweep work
   (`st-storage-sweep-archival-and-capacity-estimate`, sibling in `plan/`) may want an
   incremental byte counter instead of the current full scans. `KvRawStorage`'s put/delete
   methods are the one place to maintain it. **Do not build the counter here** — leave the
   write path a single choke point and add a `NOTE:` marking the seam.

## Interface to implement

Add `packages/db-p2p/src/storage/raw-store-driver.ts`:

```ts
import type { BlockId, ActionId } from "@optimystic/db-core";

/**
 * Bytes-valued, per-logical-store driver surface. Each backend implements the
 * five block-storage stores (metadata, revisions, pending, transactions,
 * materialized) over its native mechanism. `KvRawStorage` layers all JSON
 * serialization and orchestration on top — drivers never (de)serialize values
 * and never see BlockMetadata/Transform/IBlock types.
 */
export interface RawStoreDriver {
	// metadata store — keyed by blockId
	getMetadata(blockId: BlockId): Promise<Uint8Array | undefined>;
	putMetadata(blockId: BlockId, value: Uint8Array): Promise<void>;

	// revisions store — keyed by (blockId, rev), ORDERED BY rev
	getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined>;
	putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void>;
	/**
	 * Yield [rev, value] for every present rev in [lo, hi] (both inclusive),
	 * ascending when reverse=false, descending when reverse=true. The driver
	 * MUST drain any native cursor into memory before yielding — a native
	 * iterator must not stay open across the consumer's awaits (see
	 * "Iteration semantics" below).
	 */
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]>;

	// pending store — keyed by (blockId, actionId)
	getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;
	deletePending(blockId: BlockId, actionId: ActionId): Promise<void>;
	listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId>;

	// transactions store — keyed by (blockId, actionId)
	getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;

	// materialized store — keyed by (blockId, actionId)
	getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;
	deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void>;

	/**
	 * Atomically move pending(blockId,actionId) → transactions(blockId,actionId):
	 * write the transactions entry and remove the pending entry as one indivisible
	 * step (batch / DB transaction / rename). Throw
	 * `Pending action <id> not found for block <id>` when no pending entry exists.
	 * This is the ONLY cross-key atomic operation the kernel requires.
	 */
	promote(blockId: BlockId, actionId: ActionId): Promise<void>;

	/** Optional — enumerate block ids with durable metadata (startup seed). Passed through by the kernel. */
	listBlockIds?(): AsyncIterable<BlockId>;
	/** Optional — best cheap byte estimate. Passed through by the kernel. */
	approximateBytesUsed?(): Promise<number>;
	/** Optional — release the underlying handle. */
	close?(): Promise<void>;
}
```

Add `packages/db-p2p/src/storage/kv-raw-storage.ts`: `KvRawStorage implements IRawStorage`,
constructed with a `RawStoreDriver`. It owns:

- **Codec.** A small internal module (`storage/raw-store-codec.ts`) with `encodeJson`/`decodeJson`
  (via `TextEncoder`/`TextDecoder` + `JSON`) for `BlockMetadata`, `Transform`, `IBlock`, and
  `encodeActionId`/`decodeActionId` for the `ActionId` string. `getX` decodes-or-returns-`undefined`
  on a driver miss; `saveX` encodes then calls the driver put.
- **`listRevisions(blockId, startRev, endRev)`** → compute `ascending = startRev <= endRev`,
  `lo`/`hi`, then delegate to `driver.rangeRevisions(blockId, lo, hi, !ascending)`, mapping
  `[rev, bytes]` → `{ rev, actionId: decodeActionId(bytes) }`. Preserve exact ordering semantics
  of every existing backend (both bounds inclusive; empty revs skipped).
- **`saveMaterializedBlock(blockId, actionId, block?)`** → `block` present ⇒
  `driver.putMaterialized(encodeJson(block))`; absent ⇒ `driver.deleteMaterialized(...)`.
- **`promotePendingTransaction`** → `driver.promote(...)` (no local read-then-write; the driver
  owns atomicity).
- **`getApproximateBytesUsed`/`listBlockIds`** → passthrough to the optional driver methods
  (omit / return per `IRawStorage`'s optional contract when the driver lacks them).
- `// NOTE:` on the put/delete choke point marking where the future incremental byte counter
  (`st-storage-sweep-archival-and-capacity-estimate`) would hook in — do not implement it.

**Refold `MemoryRawStorage` onto the kernel.** Replace the hand-rolled clone-everywhere class in
`packages/db-p2p/src/storage/memory-storage.ts` with an in-memory `RawStoreDriver`
(`storage/memory-store-driver.ts`) storing `Uint8Array` values in `Map`s, and keep
`MemoryRawStorage` as a thin `export class MemoryRawStorage extends KvRawStorage` (or a factory)
so existing imports (`from '@optimystic/db-p2p'`) keep working. Because values are bytes, the
driver stores copies inherently — delete the `structuredClone` calls and update the `@pitfall`
comments to explain the invariant is now structural. **Preserve `listBlockIds` semantics** (yield
the metadata-store ids; snapshot before yielding).

Export `KvRawStorage`, `RawStoreDriver`, and the memory driver from
`packages/db-p2p/src/index.ts`. Keep `MemoryRawStorage`'s export name stable.

## The conformance suite (the highest-value artifact)

Add `packages/db-p2p/src/testing/raw-storage-conformance.ts` exporting a function the four driver
packages call from their own `test/`:

```ts
export function runRawStorageConformance(
	name: string,
	makeStorage: () => Promise<{ storage: IRawStorage; cleanup: () => Promise<void> }>
): void   // registers a `describe(name, ...)` block of it()s
```

Export it from `packages/db-p2p/src/testing/index.ts`. It must cover, at minimum, the union of
what the four existing `test/*-storage.spec.ts` files assert **plus** the behaviors the plan
called out as parity-critical:

- metadata / revision / pending / transaction / materialized round-trips and `undefined`-on-miss;
- `listRevisions` ascending **and** descending, inclusive bounds, sparse revs skipped, scoped to
  one `blockId` (a second block's revs must not leak in);
- `listPendingTransactions` scoped to one block; `deletePendingTransaction` removes it;
- `saveMaterializedBlock(block=undefined)` deletes; a subsequent get returns `undefined`;
- **`promotePendingTransaction` is atomic and correct**: after promote, `getTransaction` returns
  the transform and `getPendingTransaction` returns `undefined`; promoting a **missing** pending
  throws the exact `Pending action … not found…` message; promoting is idempotent-safe against
  the monotonic paths (drive it through `BlockStorage` promote once);
- **clone-on-store / clone-on-read**: mutate an object after `saveMetadata`/`saveMaterializedBlock`
  and after a get — stored/other-returned copies must be unaffected (this is the pitfall the byte
  boundary now guarantees; the suite must assert it so a driver that shortcuts the byte copy is
  caught);
- `listBlockIds` yields exactly the blocks with metadata (when the driver implements it);
- a **`BlockStorage`-level parity slice**: run a small pend → promote → `setLatest` → `getBlock`
  sequence and a `saveReplica`/`saveDeletion` sequence through `BlockStorage` on top of the
  driver, asserting `meta.ranges` seeds as `[]`-plus-merge (open-ended `[E, +inf)`), **never**
  `[[0]]` (guards against reintroducing `st-pend-seeds-open-ended-ranges`), and that `getBlock`
  of a tombstoned rev reads back `undefined`.

Run the suite against the **in-memory driver** inside `db-p2p`'s own `test/` as part of this
ticket, so the kernel is proven end-to-end here before any real driver exists.

## Edge cases & interactions

- **Iteration semantics (drain-before-yield).** Every current backend drains its native
  cursor/iterator into an array before yielding to the consumer, because a live LevelDB iterator
  / IndexedDB transaction / SQLite cursor must not straddle the consumer's `await`s (IndexedDB
  auto-commits idle transactions; SQLite would hold the mutex slot; LevelDB pins native
  resources). The kernel encodes this as a **contract on `rangeRevisions`/`listPendingActionIds`**
  ("driver MUST drain before yielding") rather than a shared implementation, since the drain is
  backend-specific. State it in the interface doc comment; the conformance suite exercises it by
  interleaving other awaits between yielded revs.
- **Promote atomicity & crash windows.** The pend→promote→`setLatest` sequence and its recovery
  (`recover()` in `block-storage.ts`) live unchanged in `BlockStorage` above the kernel. The
  kernel must not alter the ordering: `promotePendingTransaction` performs the atomic move and
  nothing else; `setLatest` remains a separate single `saveMetadata`. Preserve the exact "throw
  if pending missing" behavior in the driver contract (used by retry-commit).
- **`meta.ranges` seeding invariant.** `KvRawStorage` is value-transparent — it must round-trip
  `BlockMetadata` (including open-ended ranges `[E]` with `undefined` upper bound) byte-exactly.
  `JSON.stringify([5])` → `"[5]"` round-trips to `[5]` (a one-element `RevisionRange`), so the
  open-ended encoding survives; the conformance suite asserts a metadata round-trip that includes
  a one-element range. Do not "normalize" ranges anywhere in the codec.
- **Empty / boundary states.** get on an empty store → `undefined`; `listRevisions` over an empty
  range → no yields; `listBlockIds` on an empty store → no yields; promote on empty pending →
  the thrown error. Cover each.
- **`getApproximateBytesUsed` stays per-driver.** It is genuinely backend-specific (LevelDB full
  scan / SQLite `PRAGMA page_count` / IndexedDB `navigator.storage.estimate` / fs directory walk /
  memory sum) and is a passthrough, **not** shared logic. `// NOTE:` this so a later reader
  doesn't try to unify it. (Its future replacement by an incremental counter is the sweep
  ticket's call, hung off the kernel write path.)
- **Type hygiene.** Drivers speak only `Uint8Array`/`BlockId`/`ActionId`/`number` — no
  `BlockMetadata`/`Transform`/`IBlock` leak below the kernel, and no `any` (AGENTS.md). Prefix
  unused args with `_`.

## TODO

- Add `RawStoreDriver` interface (`storage/raw-store-driver.ts`) with the surface above and full
  doc comments (drain contract, promote atomicity contract, optional methods).
- Add `storage/raw-store-codec.ts` (encode/decode for the four value types + ActionId).
- Add `KvRawStorage` (`storage/kv-raw-storage.ts`) implementing `IRawStorage` over a driver;
  `NOTE:` the byte-counter seam on the put/delete path.
- Add in-memory `RawStoreDriver` (`storage/memory-store-driver.ts`); refold `MemoryRawStorage`
  onto `KvRawStorage`; drop `structuredClone` and rewrite the `@pitfall` comments to note the
  invariant is now structural; preserve `listBlockIds`/`getApproximateBytesUsed` behavior.
- Export the new symbols from `src/index.ts` (keep `MemoryRawStorage` name stable).
- Add `runRawStorageConformance` in `src/testing/raw-storage-conformance.ts`; export from
  `src/testing/index.ts`.
- Add a `db-p2p` `test/` spec running the suite against the in-memory driver + the `BlockStorage`
  parity slice. Run `yarn test:db-p2p 2>&1 | tee /tmp/kvcore.log`; typecheck the package.
- Update `docs/internals.md` "Storage Returns References" pitfall entry to record that the byte
  boundary now makes clone-on-store/read structural for kernel-backed stores.
