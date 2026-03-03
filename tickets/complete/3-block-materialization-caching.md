description: LRU-bounded CacheSource to prevent unbounded memory growth
----

## What was built

Added LRU eviction policy to `CacheSource` via a new `LruMap<K, V>` utility, bounding cache memory in long-lived sessions.

### Key files
- `packages/db-core/src/utility/lru-map.ts` — Generic LRU map using JS Map insertion-order semantics
- `packages/db-core/src/transform/cache-source.ts` — CacheSource now backed by LruMap (default 128 entries)
- `packages/db-core/test/lru-map.spec.ts` — 13 tests covering CRUD, eviction, refresh, edge cases
- `packages/db-core/test/cache-source.spec.ts` — 16 tests covering cache behavior, clone isolation, transformCache, LRU eviction, delegation

## Testing notes

- db-core: 252 passing
- db-p2p: 170 passing
- Build: clean
- Backward-compatible: sole consumer (`collection.ts`) uses default maxSize

## Review notes

- Code is clean, minimal, SRP-compliant
- LruMap is O(1) for all operations via Map delete+re-insert refresh pattern
- structuredClone on cache hits prevents corruption — verified by test
- Absent blocks are not negatively cached — correct for this use case
- Updated stale note in `docs/system-review.md` (was "No LRU eviction")

## Usage

```typescript
const cache = new CacheSource(source);       // default 128 entries
const cache = new CacheSource(source, 256);  // custom size
```
