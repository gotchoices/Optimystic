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
- `coord0`, `coordD` and `routeKey` remain uncached, as the ticket scoped.
- A `HashTierAddressing` constructed fresh per call elsewhere (e.g. test harnesses) gains nothing, which is fine.

## Review findings

- **Read:** the implement diff (`ticket(implement): reactivity-root-coordinate-is-hashed-once-per-tail`), every `rootCoord` and `reactivityRootCoord` caller in db-core and db-p2p.
- **Fixed inline:** `coord(0, …, rootKey)` hashed the root key directly, bypassing the cache, so a root-placed register frame's coordinate was recomputed each time. It now delegates to `rootCoord`, which also keeps the two derivations from drifting.
- **Correctness:** answers are byte-identical to `H(key)` (test, plus the db-p2p `topic-bytes-encoding` spec under `yarn check`). A cache never serves across ring hashes: one cache per addressing, one addressing per hash object. Returned arrays are copies, so a caller writing into a coordinate cannot corrupt it.
- **Resource bounds:** size 512 and 10 min idle, both named constants with reasons; expiry on lookup, so no timer to leak. An expired entry that is never looked up again stays until LRU-evicted, which is bounded by the size cap; acceptable at 512 × ~32 bytes.
- **Type safety / lint:** eslint clean on the touched files; no `any`.
- **Tests:** the one expiry test meets the bar (real branching). No other tests owed: the size cap is `LruMap`'s own, and a hash-count test for the plain hit would only restate the cache.
- **Docs:** `docs/cohort-topic.md` implementation note and the release note are current. Nothing in `docs/reactivity.md` describes the cost, so nothing there needed changing.
- **Not done:** no measurement of the saving, recorded in the release note.
