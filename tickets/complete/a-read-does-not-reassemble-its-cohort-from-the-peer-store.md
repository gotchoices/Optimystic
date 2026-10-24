description: Every block read used to re-read, from the networking library, the stored record of each machine that might be responsible for the block, which made reads several times slower once one other machine was connected. Each peer's record is now kept and re-read only when the networking library says it changed.
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/network/peer-record-cache.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/network/prepared-streams.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/internals.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/repo.md
----
# A read does not reassemble its cohort from the peer store

GitHub [#45](https://github.com/gotchoices/Optimystic/issues/45) and [#40](https://github.com/gotchoices/Optimystic/issues/40).

## What landed

Every cohort assembly (every `findCoordinator(read)`, every `findCluster`, and the bootstrap and absent-member helpers) classified each member of FRET's over-fetch band by calling libp2p's `peerStore.get` — a read lock, a protobuf decode and an address stringify per peer, per lookup. It now reads through `PeerRecordCache` (`packages/db-p2p/src/network/peer-record-cache.ts`):

- One entry per peer: its record (protocols and addresses) or a remembered absence (`NotFoundError`, or no peerStore at all). Any other read failure is logged (`peer-record:read-failed`) and not remembered.
- An entry is dropped on libp2p's `peer:update`, `peer:identify`, `connection:open` and `connection:close` for the peer, and after 60 s (`PEER_RECORD_TTL_MS`), which bounds what libp2p reports by no event (address ageing, deletion, expiry). Bound 1024 entries (LRU).
- Concurrent lookups share one `peerStore.get` per peer; a read in flight when the peer is invalidated answers its waiting callers but is never stored and no later caller joins it.
- `Libp2pKeyPeerNetwork` builds one cache; the three `getPeerStore*ByPeer` helpers and `ServingCohort.protocolsByPeer` are gone. `recordPeerAddresses` invalidates before merging. The self-relay check before a cold dial (`assertNotSelfRelayOnly`) stays uncached and now logs a failed read instead of swallowing it.
- The membership predicate, FRET's band and the remembered serving verdicts are still evaluated on every lookup; assembled cohorts are deliberately not cached (NOTE at `assembleServingCohort`).

Docs: `docs/internals.md` §Network Membership Predicate, `packages/db-p2p/docs/cluster.md`, `packages/db-p2p/docs/repo.md`.

Tests: describe "peerStore records are read once per change, not once per lookup" in `packages/db-p2p/test/libp2p-key-network.spec.ts` (stable view reads each peer once; a reported change re-reads and reclassifies; a predicate change applies with no read; an in-flight read superseded by `peer:update` is not kept). The mock libp2p now dispatches events, and the unknown→serves flip test flips the store and dispatches `peer:update` the way identify's write does.

## Review findings

Read the implement diff (`ticket(implement): a-read-does-not-reassemble-its-cohort-from-the-peer-store`) before the handoff.

**Correctness of invalidation against real libp2p (checked, sound).** Read `@libp2p/peer-store` 3.x as installed: `save`/`patch`/`merge` take the peer's write lock, write, then dispatch `peer:update` synchronously while still holding the lock, and only when the record changed — creation counts as changed (`existingPeer == null`), so a remembered absence is dropped the moment libp2p creates the record. `get` throws `NotFoundError` (name checked) for unknown and expired peers. libp2p's own `dispatchEvent` re-dispatches component events on the node, so the cache's node-level listeners hear them. Walked every ordering of a read against a write: a read that loaded before the write is either stored and then deleted by the `peer:update`, or still pending and marked superseded; a read queued behind the write lock is marked superseded by the event fired under that lock (one wasted read, never a stale entry). `recordPeerAddresses` calls `peerStore.merge` synchronously after invalidating, so the write lock is queued before any later read. `peer:update` is not emitted for self (libp2p emits `self:peer:update`), which is fine since self is never read through the cache. `delete` emits nothing — covered by the TTL, as the handoff said.

**The handoff's staleness windows.** (1) a merge made directly on libp2p by `ClusterService`/`ClusterClient` is visible once its write completes — the same moment an uncached read would see it; (2) a deleted or aged-out record served up to 60 s. Downstream of `findCluster` nothing needs better: an address libp2p aged out costs at most one failed dial on the existing retry/exclude path, and a deleted peer's serving verdict would be kept by `rememberedServing` anyway. No change.

**Edge cases checked by reading:** TTL expiry deletes on read and re-fetches; a superseded read finishing late does not delete a newer pending read (identity check in `finally`); a non-NotFound failure is logged, not stored, and the peer is absent from that call's map — which every consumer already treats as `unknown` (and `heardFromBootstrapPeer` treats as serving, fail closed, as before); duplicate ids in one call are harmless. No new tests added for these: each is a two-line branch and none was found wrong.

**Tests.** The four new cases each pin a distinct, documented behaviour (read count, change re-read, predicate read live, in-flight supersession); the handoff reports the last fails with the guard removed. Kept all four; none restates the implementation or verifies a mock of a repo-owned module.

**Docs.** Read every file the change touched plus the comments in `libp2p-key-network.ts` that mention the peerStore (`isSelectable`'s NOTE, `heardFromBootstrapPeer`, the cold-dial NOTE) — all still accurate. `yarn lint:docs` clean.

**Tripwire added:** `PEER_RECORD_MAX_ENTRIES` in `peer-record-cache.ts` — `servingPeersOutside` reads a record for every peer in the ever-growing `rememberedServing` on each solo write, so past 1024 such peers the LRU would thrash; parked as a `NOTE:` at the constant.

**Hygiene.** `libp2p-key-network.ts` shrank from 1910 to 1862 lines (`wc -l`); `peer-record-cache.ts` is ~190 lines with a single purpose. Listeners are never removed, matching the class's other listeners (the node outlives the key network). The second key network the Quereus collection-factory fallback can build gets its own cache — harmless duplication, not filed.

**Not done, and why:** the optional before/after timing with two loopback peers was not run here either; the speed-up rests on #45's measurement. `publishableAddrsForPeer` (redirect resolvers) still reads the peerStore once per redirect — out of scope, not hot.

**Runs:** `yarn test -- --grep "Libp2pKeyPeerNetwork"` in `packages/db-p2p` (130 passing), eslint over `peer-record-cache.ts` and `libp2p-key-network.ts` (clean), `yarn workspace @optimystic/db-p2p build`, `yarn lint:docs`. The implementer's full runs (`yarn workspace @optimystic/db-p2p test` 3526 passing, `yarn test:integration`, `yarn check:rn`) were not repeated: the only change in this pass is a comment.
