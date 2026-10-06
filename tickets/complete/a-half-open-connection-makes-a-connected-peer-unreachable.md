description: When this node holds two connections to a peer and the first is dead on the far side but still listed as open here, every request to that peer used to wait out its deadline on the dead one even though the second connection worked. Opening a stream now falls back across the other connections and a fresh dial, and a connection that has proven dead is closed, so one dead connection cannot cut a node off from a peer it is connected to.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts, packages/db-p2p/test/link-deadlines.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/readme.md, docs/debugging.md
difficulty: hard
repro: verified
----

# A half-open connection makes a connected peer unreachable — complete

GitHub: [#32](https://github.com/gotchoices/Optimystic/issues/32). Landed in `ticket(implement): a-half-open-connection-makes-a-connected-peer-unreachable`; this review pass added three small changes on top.

## What landed

`openProtocolStream` in `packages/db-p2p/src/network/open-protocol-stream.ts` opens a stream as a race over an ordered list of paths: every open connection to the peer (direct before relayed, newest first within each group), then a fresh dial forced to open a new connection. A path that has not opened within the hedge delay is hedged with the next path without being cancelled; a path that fails outright advances at once; the first stream to open wins, a fresh dial still in flight is cancelled, and a stream a losing path opens later is closed. A connection whose open stays pending for the whole dead-connection delay is aborted and reported once as `open-stream:connection-dead`. The caller's signal rejects the call with its own reason and cancels a fresh dial, but an open on an existing connection runs on its own timer to the dead-connection delay, because a caller's deadline is no evidence that the connection is dead.

The two delays are part of `LinkDeadlines` (`StreamOpenDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`): the hedge is one and a half round trips with a 250 ms floor, the dead-connection delay is the RPC dial deadline. `createLibp2pNodeBase` threads the node's deadlines into the key network, the cohort-topic host and the reactivity transports; the Quereus collection factory's foreign-node fallback passes the node's when it carries them.

## Review findings

**Read first:** the implement commit's diff, with fresh eyes, then the handoff. Every file the change touched was read, plus the ones it should have touched (the db-p2p readme's deadline table, `docs/debugging.md`, the deadline section of `packages/db-p2p/docs/cluster.md`, the cohort-query section of `docs/transactions.md`) and the libp2p 3.3.11 sources the design rests on: `connection.newStream` falls back to its own negotiation timeout only when no signal is passed, so always passing one is what keeps the judgment here; `force: true` is read by both the connection manager and the dial queue, so a forced dial does open a new connection; a dial's signal reaches the per-address dial through `anySignal`, so cancelling a fresh dial in flight does end it.

**Race logic, checked by reading.** Every ordering of settle events was walked: a path failing while a later one is pending changes nothing and the later one's hedge still advances; the latest path failing with paths left starts the next at once; the last path failing with an earlier connection still pending waits for that connection's condemnation and then fails with the first path's error; the caller aborting clears the hedge so the race stops widening, cancels only the dial path, and leaves the connection attempts to their own condemnation timers; a hedge timer can never fire after `finish` because `finish` clears it, and `startNext` after `finish` returns before starting anything. `attempts.push` runs before the first `await` in `attempt`, so the hedge arming in `startNext` sees the right count. Condemnation clears on settle and never fires for a winner. No defect found.

**Minor, fixed in this pass:**

- The db-p2p readme's table of deadlines derived from `linkRoundTripMs` ("Slow relayed links: declare the round trip, and every deadline follows") did not list the two new delays, and its sentence on what an explicit `rpcDeadlines.dialTimeoutMs` carries along omitted the dead-connection delay. Both now say so; the 3 s worked example names the 4.5 s hedge and the 33 s dead-connection delay.
- `packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts` picked the live connection on `a` with an expression comparing `a`'s connection ids and remote addresses against `b`'s, which are different objects on the two nodes; it was always true for the first connection in the list and so worked by accident of ordering. It now picks the older of `a`'s two connections by `timeline.open`, which is what the precondition asserts anyway.

**Tripwire, recorded at the site:** `NOTE:` at the dial path of `StreamOpenRace.open` in `packages/db-p2p/src/network/open-protocol-stream.ts`. On an undeclared link whose round trip exceeds the 250 ms hedge floor, a peer with one healthy connection reaches the forced-dial path on every request (stream negotiation costs one round trip), so each request starts and then cancels a fresh dial, a new relay circuit for a relayed peer. It is bounded (a second connection that completes is hedged onto ahead of the dial next time, so connections do not accumulate) and the remedy is the standing rule to declare `linkRoundTripMs`; the note names the change to make if undeclared mid-latency links turn out to be common.

**Considered and left alone:**

- The slow-link residual the implement ticket recorded (a cohort consult that meets a dead connection first can still miss once, at 3.5 of its 3 round trips) is real, documented at the derivation in `packages/db-p2p/src/rpc-deadline.ts`, and self-healing: the dead connection is aborted within the dial deadline and the next consult succeeds. No ticket.
- An open on an existing connection outliving its caller costs the far side at most one stream opened and closed, bounded by the dead-connection delay. Documented on `OpenProtocolStreamOptions.signal`.
- The eighth positional parameter of `Libp2pKeyPeerNetwork`: the options-bag conversion was weighed by the implementer against 98 construction sites in one spec and deferred with a revisit point (a ninth parameter). Accepted; the NOTE above the constructor carries it.
- The implementer's tests were reviewed as code under review. The stub spec's fallback cases each pin one branch of the race (hedge, condemnation once per connection, fail-fast on a reset, ordering, forced dial, caller abort, first-path error, condemnation before failure, late-stream discard, slow-but-live winner) and the real-network spec pins both shapes of the field failure; none restates the implementation or verifies a mock for its own sake, so none was cut and none added. The two timing assertions the handoff flagged (hedge paid, post-condemnation open under the hedge) are generous on this machine (the real-network spec runs in about 4 s; the stub spec's delays are 40 ms and 120 ms against 2 ms tolerances on lower bounds only) and are left as they are.
- Matchmaking's query transport still opens under the undeclared delays, as the handoff said; it is host-constructed and the change is two lines when a host needs it. Not a defect: the defaults are what every deadline falls back to.

**Major findings:** none. Nothing here rose to the filing bar; no ticket filed.

**Pre-existing failures:** none seen.

## Validation

| command | result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p test` | 3238 passing, 68 pending, 0 failing (2 m) |
| `yarn lint`, `yarn lint:docs` | pass (47 documents, 270 anchored citations, all resolve) |
| `tsc --noEmit` in `packages/db-p2p` | pass |

Not rerun here: `yarn workspace @optimystic/quereus-plugin-optimystic test`, `yarn typecheck`, `yarn check:rn` (the implement pass ran them; this pass changed a readme, a db-p2p spec and a comment), and `yarn test:integration` (env-gated).
