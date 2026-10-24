description: Every block read rebuilds the list of machines responsible for the block by reading each candidate's stored record from the networking library, which makes reads several times slower as soon as one other machine is connected and costs a phone about 15% of its processing time. Remember those answers and refresh them only when the network changes.
files: packages/db-p2p/src/libp2p-key-network.ts (`findCluster`, `membershipOf`, `servingCohortAt`, peerStore reads), packages/db-p2p/src/repo/coordinator-repo.ts (`get`, responsibility cache), packages/db-p2p/src/peer-address-book.ts (`publishableAddrsForPeer`)
----
# A read does not reassemble its cohort from the peer store

GitHub [#45](https://github.com/gotchoices/Optimystic/issues/45) and [#40](https://github.com/gotchoices/Optimystic/issues/40) (kjeib). Read both in full (`gh issue view 45`, `gh issue view 40`). Both carry profiles, numbers and repros, and #45 has a causal check showing that caching removes the penalty.

- #45: every block read reassembles its serving cohort, reading each candidate's peerStore record. Item usage counts go from 118–130 ms solo to 240–279 ms with one connected peer (1.18.0). The penalty starts with the first connected peer.
- #40: on a Galaxy S7, about 15% of the JS thread is libp2p peerStore work: `pbToPeer` re-parsing multiaddrs on each `peerStore.get` (from the peerStore reads in `libp2p-key-network`), and `toPeerPB` sorting on each `merge` (from libp2p's per-stream `newStream` / `onIncomingStream`).

## Expected

- A read of a block this node holds, with an unchanged network view, does no peerStore reads in cohort assembly. Read latency with one or two connected peers stays close to solo.
- Cache what cohort assembly needs per peer (protocols or serving verdict, publishable addresses), the assembled cohort per routing key, or both. Invalidate on whatever can change the answer: `peer:update`, `peer:identify`, connection open and close, FRET membership changes, and the `isNetworkMember` predicate, which docs/internals.md §Network Membership Predicate says is read live, so its verdict must not be cached past a change. Every existing membership rule keeps its meaning.
- The per-stream `merge` cost (#40's second source) belongs to libp2p and to stream reuse. Note how far `PreparedStreams` already reduces it and whether more reuse is warranted, but don't patch libp2p here.

## Test

A spec counting peerStore reads across repeated reads and `findCluster` calls with a stable view (none after the first), and showing that a membership change is seen on the next lookup.
