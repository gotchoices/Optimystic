description: Every block read used to re-read, from the networking library, the stored record of each machine that might be responsible for the block, which made reads several times slower once one other machine was connected. Each peer's record is now kept and re-read only when the networking library says it changed; review that the cached copy can never hide a change that matters.
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/network/peer-record-cache.ts (new), packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/network/prepared-streams.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/internals.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/repo.md
----
# A read does not reassemble its cohort from the peer store — review handoff

GitHub [#45](https://github.com/gotchoices/Optimystic/issues/45) and [#40](https://github.com/gotchoices/Optimystic/issues/40).

## What changed

Every cohort assembly (so every `findCoordinator(read)`, every `findCluster`, and the bootstrap/absent-member helpers) classified each member of FRET's over-fetch band by calling `peerStore.get` — a read lock, a protobuf decode and an address stringify per peer, per lookup. It now reads through one per-peer cache.

**`PeerRecordCache`** (`packages/db-p2p/src/network/peer-record-cache.ts`):

- Entry per peer id: the record (`PeerStoreRecord`, `readonly protocols` / `readonly addrs`) or a cached *absence* (`peerStore.get` threw `NotFoundError`, or the node has no peerStore — test doubles). Any other thrown error is logged (`peer-record:read-failed`) under the key network's logger, not cached, and the peer is absent from that call's map.
- Dropped on `peer:update` (`detail.peer.id`), `peer:identify` (`detail.peerId`), `connection:open` / `connection:close` (`detail.remotePeer`). No event populates; the only builder is `readPeerStoreRecord` (exported, also used uncached by the dial check).
- TTL `PEER_RECORD_TTL_MS` = 60 s (covers address ageing, delete, expiry — no event), bound `PEER_RECORD_MAX_ENTRIES` = 1024 via db-core `LruMap`.
- Concurrent `records()` calls share one `peerStore.get` per peer. The ticket asked for a per-peer *epoch*; it is implemented as the identity of the pending read instead: `invalidate` marks the in-flight read `superseded` and removes it from the pending map, so its answer goes to the callers already waiting but is never stored and no later caller joins it. Same guarantee, no per-peer counter map that would grow with every peer ever seen. A superseded read finishing late does not delete a newer pending read (identity check in `finally`).

**`Libp2pKeyPeerNetwork`** (`packages/db-p2p/src/libp2p-key-network.ts`):

- One cache built in the constructor (same lifetime as the class's other listeners, never removed).
- `getPeerStoreRecordsByPeer`, `getPeerStoreProtocolsByPeer`, `getPeerStoreAddrsByPeer` are gone; every site reads `peerRecords.records(...)` and projects `.protocols` / `.addrs` inline. `ServingCohort.protocolsByPeer` is gone too: `filterByMembership` now takes the assembly's `peerStoreRecords` directly, so the final scope check still classifies from the same records as the assembly.
- `findCluster`'s unscoped backfill reads through the cache; the "omit peers with no addresses" shape turned out to be needed by no caller (every use was `?? []`), so it was dropped rather than kept.
- `assertNotSelfRelayOnly` stays uncached (new private `heldAddrs`, which now logs a failed read instead of swallowing it — behaviour unchanged: a failed read still dials). One-line why next to the existing NOTE.
- `recordPeerAddresses` invalidates before merging.
- NOTEs rewritten: `selfReadVerdict` (now the remaining-cost tripwire, including #45's warning not to memoize FRET's size estimate), `assembleServingCohort` (records cached; cohorts deliberately not, with the #20 reason and revisit condition), `servingPeersOutside`, `filterByMembership` doc, and two smaller comments that said "re-reads the peerStore".
- `membershipOf` takes `readonly string[]`; `validMultiaddrStrings`, `unionPublishableAddrs` and `classifySelfDialability` in `peer-address-book.ts` were widened to `readonly string[]` (none mutate).

**`prepared-streams.ts`**: module-doc `NOTE:` that libp2p's per-stream `peerStore.merge` count is unchanged by the pool, naming backlog `feat-a-stream-carries-more-than-one-request`, and that an unchanged merge emits no `peer:update`.

**Docs**: `docs/internals.md` §Network Membership Predicate (new paragraph on the record cache; the "Read live" bullet says why it still holds), `packages/db-p2p/docs/cluster.md` (membership filter wording), `packages/db-p2p/docs/repo.md` §Peer classification.

## Tests

Added, in `packages/db-p2p/test/libp2p-key-network.spec.ts`, describe "peerStore records are read once per change, not once per lookup" (a band of self + serving peers, a peerStore double counting `get` per peer):

- *a stable view reads each band member once, and a newly-banded peer once on first sight* — first `findCluster` = 2 reads; 3× `findCoordinator(read)` + `findCluster` of another key = 0 more; adding a third band member = exactly 1 more.
- *re-reads a peer libp2p reports changed, and classifies it by the new record* — `peer:update` after A's stored protocols move to another network → A read once more and dropped from the cohort; B not re-read.
- *applies a membership predicate change on the next lookup with no read and no event* — refuse B → omitted, re-admit → back, zero extra reads.
- *does not keep a read that was in flight when libp2p reported the peer changed* — held `get`, `peer:update` mid-read, release: the in-flight lookup gets the old answer, the next lookup re-reads and sees the new one. Confirmed this fails with the `superseded` guard removed, and that the change/flip cases fail with the `peer:update` listener removed.

Fixtures changed (no assertion weakened):

- `createMockLibp2p` returns a `DispatchingLibp2p` with `dispatch(event, detail)`; the listener plumbing is shared with the `joiner()` fixture via `mockEvents()`; `peerUpdated(peerId)` builds libp2p's `peer:update` detail.
- *findCoordinator selects a peer once it flips from unknown to serves within the retry window* used a read-count threshold to flip the store; it now flips on attempt 1's assembly and dispatches `peer:update`, as identify's write does. It failed without that change, as expected.
- `joiner()` (bootstrap contact): `world.protocols` is an accessor whose setter dispatches `peer:update` for the partner. None of those cases needed it to pass (the partner is never read before its protocols change), but the fixture now models libp2p.

Runs: `yarn workspace @optimystic/db-p2p test` (3526 passing, 73 pending, 0 failing), `yarn test:integration` (50 + 1060 passing, 0 failing), `yarn build`, `yarn lint:docs`, eslint over the touched files, `yarn check:rn` (passes) — all green.

## For the reviewer — known gaps and things to poke at

- **Not measured.** The ticket's optional before/after timing with two loopback peers was not run; the speed-up rests on #45's experiment, not on a number from this change.
- **By inspection only**: the TTL expiry path, concurrent lookups sharing one `get`, a non-NotFound failure not being cached, and address ageing being bounded by the TTL.
- **Staleness windows that remain**: (1) a merge made directly on libp2p by `ClusterService`/`ClusterClient` (`mergeRecordPeerAddresses`) is visible only once its `peer:update` fires, the same order as a store read racing the write; (2) a peer libp2p `delete`s, or whose addresses age out, can be served from the cache for up to 60 s. Check that no decision downstream of `findCluster` needs better than that.
- **Out of scope, still uncached**: `publishableAddrsForPeer` in `peer-address-book.ts` (the redirect resolvers in `libp2p-node-base.ts`, `ClusterService`, `RepoService`) still calls `peerStore.get` itself — once per redirect, not per read.
- **Two key networks on one node** (the Quereus collection-factory fallback) each get their own cache and listeners; harmless, but noted.
- **The mock event shape**: listeners receive `{ type, detail }`. Real libp2p passes a `CustomEvent`; the cache reads only `.detail`.
- Integration specs exercise real identify and FRET assembly, so they are the check that event-driven invalidation matches real libp2p; they passed, but no integration spec targets the cache specifically.
