description: libp2p rewrites what a node knows about the other machine on every network stream, on both ends, even when nothing changed; on a phone that cost a noticeable share of the processor (GitHub #40). We capped it with a stopgap wrapper and sent the real fix upstream. Unblocked when a libp2p release includes libp2p/js-libp2p#3692; the stopgap is then deleted.
architecture: docs/internals.md#third-party-address-learning
files: packages/db-p2p/src/network/protocol-merge-throttle.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/protocol-merge-throttle.spec.ts, packages/db-p2p/test/libp2p-merges-protocol-per-stream.spec.ts, packages/db-p2p/src/network/prepared-streams.ts, packages/db-p2p/package.json, packages/quereus-plugin-optimystic/package.json, packages/substrate-simulator/package.json, docs/internals.md, docs/debugging.md
difficulty: easy
----

**Blocked: a dependency outside this repository.** Unblocks when a published `libp2p` release contains [libp2p/js-libp2p#3692](https://github.com/libp2p/js-libp2p/pull/3692) ("fix: stop rewriting the peer record on every stream"). As of 2026-10-31 the PR is open and unmerged; we depend on `libp2p` `^3.3.11`.

# libp2p carries the per-stream merge fix

## The problem

libp2p 3.3.11 merges each stream's protocol into the remote peer's peer-store record on every stream it opens or accepts (`Connection.newStream` and `onIncomingStream` in `libp2p/dist/src/connection.js`). The peer store decodes, rebuilds and rewrites the record even when the protocol is already listed. On a Galaxy S7 that was about 7% of the JavaScript thread (GitHub [#40](https://github.com/gotchoices/Optimystic/issues/40)); the connection monitor's ping alone costs six such rewrites a minute per connection.

## The upstream fix (the recommended path)

#3692 merges each protocol into the peer record once per connection rather than once per stream. That is the whole change this repository needs from upstream. Nothing else is proposed.

## The stopgap in place

`throttleProtocolMerges` in `packages/db-p2p/src/network/protocol-merge-throttle.ts`, installed by `createLibp2pNodeBase` before `node.start()`, wraps `node.peerStore.merge` and `delete`: a merge into a remote peer's record whose data is exactly one protocol reaches the store at most once a minute per peer and protocol; every other merge, and every merge into this node's own record, passes through. Its cost: a protocol that identify removes from a record can be put back by a later stream up to a minute late rather than at once. Landed by the completed ticket `protocol-merge-throttle`; described in `docs/internals.md` §Third-Party Address Learning.

`packages/db-p2p/test/libp2p-merges-protocol-per-stream.spec.ts` pins the libp2p behaviour on two real loopback nodes. It is expected to **fail** on the first libp2p release that carries #3692 — that failure is the signal to do the work below.

If upstream never takes the fix, the stopgap stays; it is self-contained and costs one map lookup per stream.

## Work here once it lands

- Raise `libp2p` in `packages/db-p2p`, `packages/quereus-plugin-optimystic` and `packages/substrate-simulator` package manifests to the release; run `yarn lint:deps` (the `@libp2p/interface` minor may move with it — see `scripts/shared-majors.cjs`).
- Delete `protocol-merge-throttle.ts`, its spec, and its install call in `createLibp2pNodeBase`.
- Delete or invert `libp2p-merges-protocol-per-stream.spec.ts`: either remove it, or keep it asserting the record is written once per connection, if that premise is worth guarding.
- Remove the throttle paragraph from `docs/internals.md` §Third-Party Address Learning (and its "only other code in front of the peerStore's writes" aside), the row in `docs/debugging.md`, and the throttle sentence in the `PreparedStreams` doc comment in `packages/db-p2p/src/network/prepared-streams.ts`.
- Optionally re-measure on a phone that the per-stream rewrite is gone.
