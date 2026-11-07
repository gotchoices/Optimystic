description: The network location where a collection's change notifications are announced is recalculated with a fresh hash every time it is needed, even though it depends only on the collection's current last log block, so idle machines (phones especially, where the hash runs in plain JavaScript) keep repeating identical work. Remember each answer instead.
architecture: docs/reactivity.md#origination-point
files: packages/db-core/src/utility/expiring-lru-map.ts (`ExpiringLruMap`), packages/db-core/src/reactivity/topic-anchor.ts (`reactivityRootCoord`), packages/db-core/src/cohort-topic/addressing.ts (`HashTierAddressing.rootCoord`, `createTierAddressing`), packages/db-core/src/reactivity/verify.ts, packages/db-p2p/src/libp2p-node-base.ts (the `reactivityRootCoord` callers), packages/db-p2p/src/cohort-topic/host.ts (`rootGroupMembers`), packages/db-core/test/cohort-topic/addressing.spec.ts, docs/cohort-topic.md
difficulty: easy
----

GitHub [#57](https://github.com/gotchoices/Optimystic/issues/57).

## What was built

- **`ExpiringLruMap`** (`packages/db-core/src/utility/expiring-lru-map.ts`): an `LruMap` whose entries also expire `idleMs` after last use, judged on lookup, so no timer and no teardown. Clock injectable.
- **`HashTierAddressing.rootCoord` is cached** per instance, keyed by the base64url of the root key's bytes, bounded at `ROOT_COORD_CACHE_SIZE` (512) entries and `ROOT_COORD_IDLE_MS` (10 min) after last use. Both constants carry the reason for their value. Each call returns a copy (`slice()`), so no caller can corrupt the cached coordinate; I did not audit the callers for writes, since the copy makes that unnecessary. `createTierAddressing` and the constructor take an optional `{ now }`.
- **`reactivityRootCoord` reuses one addressing per ring hash**: a module-level default when no hash is given, and a `WeakMap` keyed by the hash object otherwise. `verify.ts` passes its own hash, so a module-level default alone would not have helped it.
- Docs: one sentence in `docs/cohort-topic.md` at the `rootCoord` implementation note. Release note under Unreleased.

## Tests

- `addressing.spec.ts` "rootCoord remembers a root until it goes unused for the idle bound": a counting hash and an injected clock; a lookup at exactly the bound (with a fresh array of the same bytes) is served from the cache, one past it is recomputed, and every answer equals `H(key)`.
- The size cap is `LruMap`'s behaviour, verified by inspection, not tested.
- db-core: 2060 passing. db-p2p not run separately; the release gate's `yarn check` covers it, including the `topic-bytes-encoding` spec that pins `reactivityRootCoord` against the key network.

## Known gaps

- No measurement of the saving, on Node or a phone.
- `coord0`, `coordD`, `coord` and `routeKey` remain uncached, as the ticket scoped. `coord(0, …, rootKey)` with a root key goes through `hash.H` directly, not through the cache; the reported hot callers all use `rootCoord`.
- A `HashTierAddressing` constructed fresh per call elsewhere (e.g. test harnesses) gains nothing, which is fine.
