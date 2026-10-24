description: Every block read rebuilds the list of machines responsible for the block by re-reading each candidate's stored record from the networking library, which makes reads several times slower once one other machine is connected and costs a phone about 15% of its processing time. Keep a copy of each peer's record and re-read it only when the networking library says it changed.
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/libp2p-key-network.ts (`getPeerStoreRecordsByPeer`, `getPeerStoreProtocolsByPeer`, `getPeerStoreAddrsByPeer`, `assertNotSelfRelayOnly`, `recordPeerAddresses`, `assembleServingCohortOnce`, `selfReadVerdict`, `setupConnectionTracking`), packages/db-p2p/src/network/peer-record-cache.ts (new), packages/db-p2p/src/network/prepared-streams.ts (NOTE only), packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-core/src/utility/lru-map.ts (reuse), docs/internals.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/repo.md
----
# A read does not reassemble its cohort from the peer store

GitHub [#45](https://github.com/gotchoices/Optimystic/issues/45) and [#40](https://github.com/gotchoices/Optimystic/issues/40) (kjeib). Both carry profiles and repros; #45 has a causal check (an experimental per-peer record cache alone brought a two-peer read back to about the solo cost: 164–189 ms against 121–150 ms solo, from 329–384 ms uncached).

## What happens now

Every `NetworkTransactor.get` asks `Libp2pKeyPeerNetwork.findCoordinator(key, { intent: 'read' })`, whose first tier, `selfReadVerdict`, calls `assembleServingCohort`. On the scoped path (every production node has a `protocolPrefix`) `assembleServingCohortOnce` calls `getPeerStoreRecordsByPeer` for every non-self member of the FRET over-fetch band: one `peerStore.get` per peer — a mortice read lock, a protobuf decode, `multiaddr.toString()` per address — on every read. A SQL query reading ~960 blocks pays it ~960 times per band member. `findCluster` (cohort consults, commits), `filterByMembership` (connected fallback), `servingPeersOutside` (solo writes) and the bootstrap helpers read the peerStore the same way. Solo nodes are unaffected (empty band); the penalty starts with the first connected peer.

Libp2p 3.3.11 / `@libp2p/peer-store` 12.0.28 facts this design rests on (verified in `node_modules`):

- `PersistentPeerStore.save`, `patch` and `merge` dispatch `peer:update` on the libp2p event bus whenever the stored record actually changed (`#emitIfUpdated`), including when a record is first created. Identify writes through `patch`, so a completed identify that changes protocols or addresses emits `peer:update`; it then dispatches `peer:identify`.
- Two changes emit nothing: `delete` (no event), and address ageing — `pbToPeer` drops addresses older than `maxAddressAge` (1 h) at load time, and `load` deletes a peer past `maxPeerAge` (6 h).
- A `get` takes the peer's read lock, so a `get` issued after a `merge` started waits for that merge's write.

## Design (decided)

Cache **per-peer peerStore records**, not assembled cohorts.

A per-routing-key cohort cache was rejected: FRET raises no event this class hears when it admits or drops a ring member (see the comment on `BOOTSTRAP_RECHECK_MS`), so such a cache could only be bounded by a TTL, and a TTL means a membership change is not seen on the next lookup — the hazard behind GitHub #20. The per-peer cache leaves every input that is cheap and live exactly as it is: FRET's `assembleCohort` is still called per lookup, the membership predicate (`isNetworkMember`) is still asked per peer per lookup through `membershipOf`/`refusedMembership`, `rememberedServing` and the bootstrap contact state are still read live, and connected addresses still come from `getConnections()` per call. Only the peerStore record — the expensive, async, lock-taking read — is remembered, and it is dropped whenever libp2p says it changed. Every existing membership rule keeps its meaning because `membershipOf` still receives the same protocol list it would have read.

### `PeerRecordCache` (new, `packages/db-p2p/src/network/peer-record-cache.ts`)

Small, single-purpose, cross-platform (this module is reachable from the React Native entry through `libp2p-key-network.ts`, so type-only or pure imports, like `prepared-streams.ts`).

```ts
/** One peerStore record as the key network reads it. Shared with callers: never mutate. */
export interface PeerStoreRecord { readonly protocols: readonly string[]; readonly addrs: readonly string[] }

export class PeerRecordCache {
	constructor(libp2p: Pick<Libp2p, 'peerStore' | 'addEventListener'>, options?: { ttlMs?: number; maxEntries?: number })
	/** Records for `ids`; a peer the peerStore does not hold, or failed to read, is absent from the map. */
	records(ids: readonly string[]): Promise<Record<string, PeerStoreRecord>>
	/** Drop one peer's entry now (the key network calls this from `recordPeerAddresses`). */
	invalidate(peerId: string): void
}
```

Rules:

- **Entry**: per peer id string, either a record or a cached *absence* (`peerStore.get` threw `NotFoundError` — a band member FRET restored from persisted state with no peerStore record yet is the routine case, and re-reading it per lookup is exactly the cost being removed). Any other thrown error is **not** cached and the peer is left absent from that call's map (today's behaviour: logged nowhere, treated as unknown; keep it, but log the non-NotFound failure once per occurrence under the key network's logger so a persistently failing store is visible — AGENTS.md: don't eat exceptions).
- **Invalidation by event**, per peer: `peer:update` (`detail.peer.id`), `peer:identify` (`detail.peerId`), `connection:open` and `connection:close` (`detail.remotePeer`). The last two change no record by themselves but are rare, and dropping on them bounds staleness across a reconnect for free. `peer:update` alone carries the new record (`detail.peer`) — do not populate from it; just drop the entry, so there is one code path that builds a record (from `peerStore.get`), and the next read re-reads.
- **Invalidation by age**: `ttlMs`, default 60 s (`PEER_RECORD_TTL_MS`). Covers the changes libp2p reports by no event (address ageing, peer expiry, `delete`). Well under the 1 h address age, so a cached record never publishes an address libp2p itself has already aged out for longer than a minute.
- **Bound**: `maxEntries`, default 1024, using db-core's `LruMap`. The set is peers FRET hands out plus bootstrap peers, so this is a guard, not a working limit.
- **In-flight reads**: concurrent `records` calls for one peer share one `peerStore.get` (a per-peer pending promise). Each peer carries an **epoch** bumped on every invalidation; a read stores its result only if the peer's epoch is unchanged since that read started, and a caller joins a pending read only if it was started under the current epoch. Without this, a `peer:update` landing while a pre-update read is in flight would be overwritten by that read and the stale record served until the TTL.
- Returned objects are the cached ones; the type is `readonly` so callers cannot mutate a shared record.

### Wiring in `Libp2pKeyPeerNetwork`

- Construct one `PeerRecordCache` in the constructor beside `setupConnectionTracking` / `setupSelfAddressTracking` (same lifetime: the class never removes its listeners today).
- Replace the bodies of `getPeerStoreRecordsByPeer` and `getPeerStoreProtocolsByPeer`, and the use of `getPeerStoreAddrsByPeer` in `findCluster`'s unscoped backfill, with reads through the cache — collapse the three helpers into one cached reader plus thin projections, DRY. Keep `getPeerStoreAddrsByPeer`'s "omit peers with no addresses" shape at the call site that needs it.
- **`assertNotSelfRelayOnly` keeps an uncached `peerStore.get`.** It runs once per cold dial, not per read, and it must see addresses a redirect merged an instant earlier: `RepoClient`/`ClusterClient` call `recordPeerAddresses` and dial immediately, the merge emits `peer:update` only after its write lands, and a cached pre-merge record could read "every address routes through us" and refuse a dial the new address would have made. The uncached `get` queues behind the merge's write lock, which is what makes it correct today. Leave its existing NOTE in place and add one line saying why it deliberately bypasses the cache.
- `recordPeerAddresses` calls `cache.invalidate(peerId)` before `mergePeerAddresses`, so a lookup in the window before the merge's `peer:update` does not keep serving the pre-merge entry for a peer this node was just taught about. (Merges made directly on libp2p by `ClusterService`/`ClusterClient` via `mergeRecordPeerAddresses` are covered by their `peer:update`; the gap until it fires is the same order as a store read racing the write, acceptable.)
- Update the NOTEs this resolves: on `selfReadVerdict` (the "memoize 'self is in this key's cohort'" NOTE), on `assembleServingCohort` ("If peerStore reads per lookup ever show in a profile, memoize the per-peer membership verdict…"), on `servingPeersOutside`, and the `filterByMembership` doc ("the filter re-reads the peerStore on every retry attempt" — now: re-reads a peer's record whenever libp2p reports it changed, which is what identify completing does). Replace the `selfReadVerdict` NOTE with a tripwire stating what a read still pays per lookup: `hashKey`, FRET `assembleCohort`, the membership classification, and `shouldAllowSelfCoordination` (FRET `detectPartition` / `getNetworkSizeEstimate`). Record there that #45 measured caching FRET's size estimate as a *behaviour change*, not a pure saving (a stale estimate flips the guard's answer and sends reads remote), so it must not be memoized naively; if `windowGaps` ever dominates a profile, the remedy belongs in FRET.

### Per-stream `merge` (#40's second source) — note only, no code

libp2p 3.3.11 `Connection.newStream` and `onIncomingStream` call `peerStore.merge(remotePeer, { protocols: [protocol] })` on every stream. `PreparedStreams` moves the requester's stream open — and that merge — off the request's critical path into a background open, but it does not reduce the count: still one stream, so one merge, per request on each end. Fewer merges needs either a stream carrying more than one request (a change to all four request/response protocols; parked as backlog `feat-a-stream-carries-more-than-one-request`) or libp2p skipping a merge whose protocol is already recorded (upstream). Add a `NOTE:` to the module doc of `packages/db-p2p/src/network/prepared-streams.ts` saying exactly this, naming the backlog slug. With the cache, those merges also stop costing this repo anything indirectly: an unchanged merge emits no `peer:update`, so it does not invalidate cached records.

## Edge cases & interactions

- **Stable view, repeated reads** — after the first lookup, `findCoordinator(read)` and `findCluster` for the same or other keys issue zero `peerStore.get` calls. *Test.*
- **Identify completing mid-retry** (`findCoordinator`'s 500 ms retry window, the bootstrap contact wait in `assembleServingCohortAt` / `identifiedBootstrapPeerJoiningRing`, `unheardBootstrapPeers`) — identify's `patch` emits `peer:update` and then `peer:identify`, both drop the entry, the next attempt re-reads. The `joiner()` fixture in `libp2p-key-network.spec.ts` mutates `world.protocols` with a no-op `addEventListener`; give it a dispatching event target and have each case that changes `world.protocols` emit `peer:update` for the partner, which is what libp2p does. Those cases then verify this interaction unchanged.
- **Membership predicate change with no event** — `isNetworkMember` flips to refuse a cached `serves` peer: the next lookup excludes it with no peerStore read, because `refusedMembership` is evaluated before the cached protocols in `membershipOf`. And flipping back re-admits it on the next lookup. *Test.*
- **FRET ring change** — a peer newly in the band is read once on first sight; a peer leaving the band simply stops being asked (its entry ages out). *Test (folded into the stable-view case: add a band member, expect exactly one read).*
- **`peer:update` while a read is in flight** — the epoch guard. *Test* with a `peerStore.get` the case resolves by hand: start a lookup, emit `peer:update` with changed protocols, resolve the old read, then a second lookup must re-read and see the new protocols.
- **Concurrent lookups** — two lookups over the same band share one `get` per peer. By inspection.
- **peerStore failure** — a non-NotFound throw is not cached; the next lookup retries the read. Covered by the existing `connect()` "peerStore read itself fails" case for the uncached path; for the cache, by inspection.
- **Address ageing / deletion** — bounded by the 60 s TTL. By inspection (constant + comment citing `MAX_ADDRESS_AGE`).
- **`rememberedServing` and persistence** — unchanged: `membershipOf` still calls `rememberVerdict` with whatever list it is handed; a cached list produces the same verdict the store would have. The restart path (`initFromPersistedState`, empty peerStore → absence cached → `rememberedServing` decides) is unchanged; a peer that reconnects identifies, emits `peer:update`, and its absence entry is dropped. By inspection, plus the existing restart specs.
- **Redirect then dial** — `assertNotSelfRelayOnly` stays uncached (see design); existing `connect()` specs cover it.
- **Self** is never read from the peerStore (excluded from every reader today); keep it so. `self:peer:update` is not subscribed.
- **Mocks without `addEventListener` or `peerStore`** — several specs build a libp2p double with no `peerStore` (the "no peerStore at all" case): `records` must return `{}` exactly as today. Doubles whose `addEventListener` is a no-op get a cache that only ages out; any such spec that mutates its peerStore between lookups and expects the change must emit `peer:update` — fix those fixtures, do not weaken assertions.

## Test

One describe block in `packages/db-p2p/test/libp2p-key-network.spec.ts` (extend `createMockLibp2p` with a `dispatch(event, detail)` helper over the listener map it already keeps, and a peerStore double that counts `get` calls per peer). Expected outputs:

- Band of self + two serving peers: first `findCluster(KEY)` → 2 reads; then three `findCoordinator(KEY, { intent: 'read' })` and a `findCluster` of a different key with the same band → 0 more reads. Add a third peer to FRET's band → next lookup → exactly 1 more read.
- `dispatch('peer:update', { peer: { id: A } })` after changing A's stored protocols to another network's → next `findCluster` reads A once and omits it from the cohort.
- Predicate refuses B (no event) → next `findCluster` omits B with 0 reads.
- The in-flight case above.

Run `yarn workspace @optimystic/db-p2p test` and `yarn test:integration` from the root (the integration specs exercise real identify and FRET cohort assembly, so they are the check that event-driven invalidation matches real libp2p). Then `yarn build` / `yarn lint:docs`.

Optional measurement for the handoff: `packages/db-p2p/test/bench-findcluster.mjs` builds a solo node only; if cheap, report the per-call cost of `findCoordinator(read)` with two connected loopback peers before and after. Not required.

## Docs

- `docs/internals.md` §Network Membership Predicate: after the paragraph on how `membershipOf` classifies from the peerStore protocol list, add that the protocol lists and addresses the key network reads are kept per peer (`PeerRecordCache` in `packages/db-p2p/src/network/peer-record-cache.ts`) and dropped on `peer:update`, `peer:identify`, connection open/close, or after a minute, while the predicate, FRET's band and the remembered verdicts are read per lookup — so the "Read live" bullet stays true, and say so there.
- `packages/db-p2p/docs/cluster.md` (Network-Membership Scoping bullet): "The membership filter re-reads the peerStore on every retry attempt" → re-reads a peer's record whenever libp2p reports it changed, which identify completing does.
- `packages/db-p2p/docs/repo.md` §Peer classification: one sentence that classification uses the cached record, refreshed when identify lands.

## TODO

- Add `packages/db-p2p/src/network/peer-record-cache.ts` (`PeerRecordCache`, `PeerStoreRecord`, `PEER_RECORD_TTL_MS`) per the rules above.
- Wire it into `Libp2pKeyPeerNetwork`: construct it, route `getPeerStoreRecordsByPeer` / `getPeerStoreProtocolsByPeer` / the unscoped backfill through it (one reader), make `ServingCohort.peerStoreRecords` use the readonly type, invalidate in `recordPeerAddresses`, keep `assertNotSelfRelayOnly` uncached with a one-line why.
- Rewrite the NOTEs on `selfReadVerdict`, `assembleServingCohort`, `servingPeersOutside`, `filterByMembership` as described (the `selfReadVerdict` one becomes the remaining-cost tripwire, including #45's warning about FRET's size estimate).
- Add the per-stream `merge` NOTE to `prepared-streams.ts`.
- Fix test fixtures that mutate a fake peerStore between lookups to dispatch `peer:update`; add the describe block above.
- Update `docs/internals.md`, `packages/db-p2p/docs/cluster.md`, `packages/db-p2p/docs/repo.md`.
- Run db-p2p tests, `yarn test:integration`, `yarn build`, `yarn lint:docs`.
