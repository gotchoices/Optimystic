description: A node decides which other machines store data by reading the protocol list it keeps for each one, but that list also picks up a protocol whenever the other machine merely sends a request on it. So a machine that only reads and writes (and holds nothing) is mistaken for a storage machine by every server it talks to; the list should only count what a machine said about itself when it introduced itself.
architecture: docs/internals.md#network-membership-predicate
files: packages/db-p2p/src/network/protocol-merge-throttle.ts (`isProtocolOnlyMerge`, the merge wrapper pattern to copy), packages/db-p2p/src/libp2p-key-network.ts (`servesThisNetwork`, `membershipOf`, `rememberVerdict`), packages/db-p2p/src/libp2p-node-base.ts (the `throttleProtocolMerges` install before `node.start()`; `preparedStreamProtocols`), packages/db-p2p/test/libp2p-merges-protocol-per-stream.spec.ts, docs/internals.md (§Network Membership Predicate, §Third-Party Address Learning), tickets/blocked/libp2p-carries-the-per-stream-merge-fix.md
difficulty: medium
----

# A peer is judged serving only by its own identify

## The defect

`Libp2pKeyPeerNetwork.membershipOf` classifies a remote peer as serving this network when its libp2p peerStore protocol list names `<prefix>/cluster/1.0.0` or `<prefix>/repo/1.0.0`. That list has two writers:

- **identify** (and identify-push), which `patch`es the list with the peer's own complete protocol list (`@libp2p/identify/dist/src/utils.js`, `peerStore.patch`), on every connection open (`identifyOnConnectionOpen`);
- **every negotiated stream, on both ends**: libp2p 3.3.11 calls `peerStore.merge(remotePeer, { protocols: [protocol] })` in `Connection.newStream` AND in `onIncomingStream` (`libp2p/dist/src/connection.js`), the latter before the handler is even looked up.

The second writer is a lie on the receiving end: a peer that *dials* this node's `repo` protocol gets `repo` added to *its own* record here. So a machine that holds no blocks but reads and writes through a server — exactly the client-only node the next ticket adds — is classified `serves` by every server it sends a request to, and its verdict is remembered (`rememberedServing`) and persisted. It then lands in that server's cohorts for keys near it on the ring, and every write coordinated there waits on a member that refuses the `cluster` protocol at negotiation: the 84–105 s per write GitHub sereus#63 measured with one unresponsive browser in a cohort. Identify on the client's next connection would correct the list, but the client's next request re-merges it.

The same path is the "by opening a stream" route by which a stranger gets itself counted as a member (docs/internals.md §Network Membership Predicate); this closes that route for honest and dishonest dialers alike. The "by advertising them" route (a peer lists the protocols in its own identify) stays the membership predicate's job.

Verified by reading libp2p 3.3.11's `connection.js` (both `merge` sites) and `@libp2p/identify`'s `consumeIdentifyMessage` (`patch`, then `peer:identify` for both identify and push). `repro: static` for the end-to-end symptom; the client-node ticket's integration test reproduces it end to end.

## The fix

Drop the per-stream merge of this network's two storage-classification protocols into a REMOTE peer's record. Identify's `patch` is then the only way a peer's record comes to name `cluster` or `repo`, which is the peer's own statement about itself.

- **One source for the protocol ids.** Export one function naming the protocols a serving peer is recognised by (for example `storageServingProtocols(protocolPrefix)` beside the other protocol-id builders, or in a small `network/storage-protocols.ts`), and use it in `Libp2pKeyPeerNetwork.servesThisNetwork` and in the new filter, so the two cannot name different ids. `preparedStreamProtocols` in `libp2p-node-base.ts` may build its two ids from it too.
- **The filter.** A wrapper over `node.peerStore.merge`, installed in `createLibp2pNodeBase` before `node.start()` next to `throttleProtocolMerges`, in its own module (not inside `protocol-merge-throttle.ts`: the throttle is deleted when libp2p ships #3692, and this filter must outlive it). A merge into a peer other than self whose data matches `isProtocolOnlyMerge` and whose one protocol is a storage-serving id resolves without recording the protocol. Every other merge passes through unchanged — identify's, address merges, other protocols, and every merge into self's record (libp2p's registrar records this node's own handled protocols in the same one-protocol shape; holding that back would stop identify advertising the node's own services). libp2p ignores the value the merge resolves to (as the throttle's doc says), but return a real `Peer`: `peerStore.get(id)`, falling back to the pass-through merge with the protocol removed when the record does not exist yet. Order relative to the throttle does not matter for correctness; install the filter so a dropped merge does not also cost the throttle's bookkeeping.
- **Both ends are filtered**, because the wrapper cannot tell `newStream` from `onIncomingStream`. The dialer-side merge was true (the remote accepted the protocol) but adds nothing identify does not already record on connection open.

## What it costs

- A serving peer whose identify on a connection FAILED used to be rescued into `serves` by the storage streams exchanged with it; it now reads like any peer whose identify failed — `unknown` when its list is empty, `foreign` (and its remembered verdict cleared) when other streams left a partial list. That is the case the existing `NOTE:` in `membershipOf` already describes; extend that note by one sentence saying stream merges no longer contribute.
- Peers on builds without this filter keep classifying a client by its streams. An embedder with clients on such a network keeps a membership predicate (`isNetworkMember`) refusing them until every serving machine runs this build. Say so in the docs paragraph below.

## Edge cases & interactions

- **Self record** — merges into this node's own record pass through (by inspection; the same rule the throttle already follows).
- **First contact by stream before identify** — a peer with no record yet: the filter still returns a `Peer` without recording the protocol; the peer reads `unknown` until identify lands (by inspection).
- **A switched machine** — a peer that served and now does not (same peer id): its stale record names the storage protocols until its next connection's identify patches them away, and its remembered verdict is cleared then (`rememberVerdict(false)`) and the clearing persisted. Until it reconnects it reads like any offline serving peer. Nothing to build; state it in docs.
- **Throttle removal** — `tickets/blocked/libp2p-carries-the-per-stream-merge-fix.md` deletes the throttle and its pin spec; the plan pass already added an arm there saying the filter stays and its merge-shape pin moves into a spec of its own. If this ticket's module or function names differ from that arm's, update the arm.
- **FRET** — FRET classifies ring members by its own protocols through the same peerStore; those are not storage protocols and are unaffected.

## Tests

- One spec at the lowest layer that shows the class: two real libp2p nodes over loopback, as `libp2p-merges-protocol-per-stream.spec.ts` builds them. The listener has the filter installed for a prefix; the dialer registers NO storage handlers and opens streams on the listener's `<prefix>/repo/1.0.0`. Expect: the listener's record for the dialer never lists the repo protocol; the dialer's own record of the listener lists it only if the listener's identify did (it does, when the listener registers the handler). Also assert a merge into self of a storage protocol still reaches the store. Without the filter the first assertion fails — that is the reproduction.
- Extend the header of `libp2p-merges-protocol-per-stream.spec.ts` to say the storage-claim filter depends on the same merge shape (`isProtocolOnlyMerge`), so a shape change must re-aim both.
- No key-network spec changes are expected: its doubles write peerStore lists directly. Run the full `db-p2p` suite and `yarn test:integration` from root; an integration spec that leaned on stream merges to classify a peer would surface here — fix the spec's premise, not the filter.

## TODO

- Add the shared storage-serving protocol id builder and use it in `servesThisNetwork` (and `preparedStreamProtocols` if it reads better).
- Add the filter module and install it in `createLibp2pNodeBase` beside `throttleProtocolMerges`, with the reasoning above in its header comment.
- Extend the `NOTE:` in `membershipOf` (identify failure) by the one sentence above.
- The reproduction spec; the header note in `libp2p-merges-protocol-per-stream.spec.ts`.
- docs/internals.md §Network Membership Predicate: the "By opening a stream on one" bullet now says this node drops that merge, so the route is closed and only advertising remains; add one paragraph on mixed versions. §Third-Party Address Learning: one sentence after the throttle paragraph naming the filter and that it is not part of the throttle's removal.
- `yarn lint:docs` and the db-p2p build, test, and integration runs.
