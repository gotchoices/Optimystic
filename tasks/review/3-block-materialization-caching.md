description: LRU-bounded CacheSource to prevent unbounded memory growth
----

## Summary

Added an LRU eviction policy to `CacheSource` to bound memory usage and prevent unbounded growth in long-lived sessions. Previously, `CacheSource` used a plain `Map` that grew forever as new blocks were accessed.

## Changes

### New: `LruMap<K, V>` utility (`packages/db-core/src/utility/lru-map.ts`)
- Simple LRU map backed by JavaScript `Map` insertion-order semantics
- Refreshes entries on `get()` and `set()` (delete + re-insert)
- Evicts oldest (first) entry when `size >= maxSize`
- Exported from `packages/db-core/src/index.ts`

### Updated: `CacheSource` (`packages/db-core/src/transform/cache-source.ts`)
- Replaced `Map<BlockId, T>` with `LruMap<BlockId, T>`
- Constructor now accepts optional `maxSize` parameter (default: 128)
- All existing semantics preserved (structuredClone on hit, transformCache, clear)

## Testing

### New: `packages/db-core/test/lru-map.spec.ts`
- Store/retrieve, missing keys, size tracking
- Eviction on capacity, refresh on get/set
- Delete, clear, iteration
- maxSize=1 edge case, invalid maxSize

### New: `packages/db-core/test/cache-source.spec.ts`
- Cache hit/miss behavior, clone isolation
- Absent block handling (not cached)
- `clear()` with specific blockIds and full clear
- `transformCache()` for deletes, inserts, updates, no-op on uncached
- LRU eviction at various cache sizes
- LRU refresh on access
- Delegation of generateId/createBlockHeader

### Validation
- `db-core`: 244 tests passing
- `db-p2p`: 133 tests passing
- Build: clean

## Usage

```typescript
// Default (128 entries)
const cache = new CacheSource(source);

// Custom size
const cache = new CacheSource(source, 256);
```

No API changes for existing consumers — the `maxSize` parameter is optional with a sensible default.
