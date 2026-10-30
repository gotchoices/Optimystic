description: Every request this node sends to another machine opens a new network stream, and the networking library does bookkeeping on both machines for each stream it opens; a phone spends a noticeable share of its processor on that. Letting one stream carry several requests in turn would remove most of that cost.
architecture: docs/internals.md#inbound-stream-authorization
files: packages/db-p2p/src/network/prepared-streams.ts, packages/db-p2p/src/protocol-client.ts (`ProtocolClient.processMessage`), packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/inbound-authorization.ts
tradeoffs: It changes the wire behaviour of all four database protocols on both ends, needs a mixed-version story, and weakens the "one request per stream" property the inbound authorization gate and the prepared-stream re-send rule both lean on — while the cost it removes may instead disappear upstream if libp2p stops re-recording an already-known protocol on every stream.
----
# A stream carries more than one request

GitHub [#40](https://github.com/gotchoices/Optimystic/issues/40) (second source). libp2p 3.3.11 `Connection.newStream` and `Connection.onIncomingStream` call `peerStore.merge(remotePeer, { protocols: [protocol] })` on every stream, whether or not the protocol is already recorded. Each merge loads the peer's record and re-sorts its protocols and addresses by string (`toPeerPB`, `localeCompare` over `multiaddr.toString()`). On a Galaxy S7 that was about 7% of the JS thread in #40's profile. Every request this package makes is one request on one stream, so every request pays it on both ends.

`PreparedStreams` (`packages/db-p2p/src/network/prepared-streams.ts`) negotiates the next stream ahead of the request that uses it, which takes the open and its merge off the request's latency, but it does not reduce the count: still one stream, so one merge, per request per end.

What this would be: a requester may send its next request to the same peer on a stream whose previous request has been answered, and each handler keeps reading frames until the stream closes instead of returning after one reply. The result is one merge per stream lifetime rather than per request.

Things a design must settle:

- **Authorization timing.** `authorizeInboundStream` is asked once per stream; today that equals once per request. With reuse, a revoked peer could keep sending requests on a held stream for as long as it stays open. The doc already accepts this for one request per prepared stream (§Inbound Stream Authorization); a long-lived stream widens it. Either re-ask per request, or bound stream lifetime.
- **The prepared-stream re-send rule.** `processMessage` re-sends once when a prepared stream fails before any reply byte; with several requests per stream, which request a failure belongs to must stay unambiguous.
- **Mixed versions.** A handler on an older build returns after one reply and closes; a requester must detect that and fall back to a fresh stream, not treat it as a failure.
- **Whether it is still worth doing.** If libp2p skips the merge when the protocol is already recorded (an upstream change, not filed), the per-stream cost this targets mostly goes away, and the remaining gains (negotiation round trip, framing) are already partly taken by `PreparedStreams`.
