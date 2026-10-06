description: When this node holds two connections to a peer and the first is dead on the far side but still listed as open here, every request to that peer used to wait out its deadline on the dead one even though the second connection worked. Opening a stream now falls back across the other connections and a fresh dial, and a connection that has proven dead is closed, so one dead connection cannot cut a node off from a peer it is connected to.
files: packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts, packages/db-p2p/src/reactivity/notify-transport.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts, packages/db-p2p/test/link-deadlines.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/debugging.md
difficulty: hard
repro: verified
----

# A half-open connection makes a connected peer unreachable — implemented

GitHub: [#32](https://github.com/gotchoices/Optimystic/issues/32). The implement ticket's analysis stands; this is what landed, what to look at, and where the edges are.

## What changed

**`openProtocolStream` (`packages/db-p2p/src/network/open-protocol-stream.ts`) is now a race over an ordered list of paths.** The paths are every open connection to the peer — direct before limited, newest first within each group — and then a fresh dial. The rules, each in its own small method of a module-private `StreamOpenRace`:

- *Hedge.* The first path starts at once. When the latest path started has not opened within the hedge delay, the next path starts as well, without cancelling anything. A path that fails outright advances to the next at once when it was the latest path started (the hedge timer was guarding it against slowness and there is nothing left to guard); an earlier path failing while a later one is pending changes nothing, since the later one already is the hedge.
- *First wins.* The first stream to open resolves the call. A fresh dial still in flight is then cancelled (nothing is learned by letting it finish). A stream a losing path opens later is closed.
- *Condemn.* A connection whose open has stayed pending for the whole dead-connection delay is aborted with `DeadConnectionError` (`connection.abort`, not `close`) and reported once as `open-stream:connection-dead`. The timer runs per attempt, on the attempt's own signal, so an open on an existing connection keeps running after the caller has its answer or has given up. "Once per connection" rests on libp2p moving `connection.status` off `open` synchronously inside `abort` (checked against `AbstractMessageStream.abort` in `@libp2p/utils`), so a second race that armed its own timer on the same connection finds it no longer open and stays quiet.
- *Failure.* When the caller's signal fires first the call rejects with the caller's reason (the existing `throwIfAborted` contract, plus a listener for a later abort). Otherwise it rejects only once every path has failed, with the first path's error — the preferred connection's when there was one, so a condemned preferred connection surfaces as `DeadConnectionError` and a cold-path refusal from `beforeDial` surfaces as itself.

`dialProtocol` is now called with `force: true`, which `DialProtocolOptions` carries to the connection manager; without it libp2p hands back an existing connection, likely the one every connection path is already waiting on. The single `newStream` call and single `dialProtocol` call are intact, so `test/dial-options-single-site.spec.ts` passes unchanged.

**Two delays join `LinkDeadlines` (`packages/db-p2p/src/rpc-deadline.ts`)**, as the `StreamOpenDeadlines` type that `LinkDeadlines` now includes: `hedgeDelayMs = max(250, 1.5 × linkRoundTripMs)` and `deadConnectionDelayMs = dialTimeoutMs` (so it follows an explicit `rpcDeadlines.dialTimeoutMs`, as the transfer budget does). `UNDECLARED_STREAM_OPEN_DEADLINES` is exported for callers built without a node. The round-trip comment at the derivation records the slow-link residual the ticket asked for: a cohort consult that meets a dead connection first spends 1.5 round trips on the hedge, 1 negotiating and 1 on the request, 3.5 of its 3, so that one consult can still miss; the dead connection is aborted within the dial deadline and the next consult succeeds.

**`Libp2pKeyPeerNetwork` takes an eighth constructor parameter**, `streamOpen?: StreamOpenDeadlines`, defaulting to the undeclared values. The options-bag conversion was weighed and deferred again: `test/libp2p-key-network.spec.ts` has 98 construction sites, and an optional trailing parameter touches none of them. The NOTE above the constructor now says so and names a ninth parameter as the point to convert. `createLibp2pNodeBase` passes the node's `linkDeadlines`; the Quereus collection-factory's foreign-node fallback passes `libp2pNode.linkDeadlines` when the injected node carries it. `connect` also hands the helper a peer-id-suffixed `open-protocol-stream` logger.

**The cohort-topic helpers (`requestResponse`, `sendOneWay` in `stream-util.ts`) take an optional trailing `streamOpen`**, threaded from `CohortTopicHostOptions.streamOpen` into the topic router, the membership source, the gossip transport and the `/sign` dial, and into the reactivity notify transport and recover dialer; `createLibp2pNodeBase` supplies `linkDeadlines` to all of them. Matchmaking's query transport (host-built, outside node-base) keeps the undeclared defaults.

**Docs:** the `open-stream:connection-dead` row in `docs/debugging.md` (§Networking and routing), the `openProtocolStream` module docblock, and the `connect` docblock.

## Behaviour changes a reviewer should weigh

- **An open on an existing connection is no longer cancelled by the caller's signal.** Previously the caller's signal went straight to `newStream`. Now each attempt runs under its own controller; the caller's abort rejects the call and cancels a fresh dial, but an open on an existing connection runs on to the dead-connection delay. The cost of that evidence is at most one stream negotiation the far side sees and we then close, bounded by the delay. The two spec cases that pinned the old forwarding were rewritten to pin this (`open-protocol-stream.spec.ts` option construction; `libp2p-key-network.spec.ts` `connect()`).
- **A signal is always passed to `newStream`.** With none, libp2p runs its own negotiation timeout, which would judge the connection on a deadline this module does not control. The "omits `signal` entirely" case became "always hands the stream open a signal of its own".
- **`beforeDial` can now run on a node that holds connections**, once the hedge reaches the dial path. So `assertNotSelfRelayOnly`'s one `peerStore.get` is paid on a warm path whenever every connection is slow or dead. Its refusal fails only the dial path.
- **Newest first within a group.** The reporter's shape (the dead connection is the older one) is now answered by ordering alone, with no hedge; the dead connection is never attempted there, so it is left to libp2p's monitor. The hedge is what covers the other shape, where the re-dial itself is the dead one, and the real-network spec has a case for each.
- **Timers.** The hedge timer is an ordinary request-scoped timer (like `ProtocolClient`'s dial timer) and is cleared on any settle. The condemnation timer is `unref`'d, because it deliberately outlives the request that armed it and a process on its way out owes a dead connection nothing.
- **On a declared slow link a live connection whose negotiation takes longer than the dial deadline is judged dead.** Documented at `StreamOpenDeadlines.deadConnectionDelayMs`; the remedy is declaring the round trip, which is the existing rule for every deadline.

## Tests

Each test beside what it verifies.

`packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts` (real libp2p over loopback WebSockets, the ported reporter spec; ~4 s in all, the second scenario being new):

- *dead connection is the older one:* precondition (two `open` connections, a stream on the live one echoes), and `connect()` reaches the peer twice in a row.
- *dead connection is the newer one:* precondition (both `open`, the dead one newer by `timeline.open`); `connect()` picks the dead one first and echoes over the live one after the hedge delay (asserted as elapsed ≥ 245 ms); and within the dead-connection delay (1 s here) the dead connection is gone from `a.getConnections(b)`, the live one remains `open`, and the next `connect()` echoes in under the hedge delay. `b` never listens, so no fresh dial can succeed in either scenario.

`packages/db-p2p/test/open-protocol-stream.spec.ts` (stubs; new describe *fallback across connections, then a fresh dial*, delays 40 ms hedge / 120 ms dead):

- hedges onto the next connection when the first open stays pending, and aborts nothing yet (and the dial is not reached).
- aborts a connection whose open stays pending for the dead-connection delay, once, and reports it once — two concurrent opens on the same dead connection.
- moves on at once when the first connection rejects, instead of waiting out the hedge (hedge set to 5 s to make waiting unambiguous).
- tries direct connections before limited ones, and the newest first within each (three hung connections, order observed, all three condemned).
- dials fresh, forcing a new connection, once every open connection has been tried — `force: true`, `runOnLimitedConnection: true`, `beforeDial` runs only when the dial path is reached.
- rejects with the caller's reason when the caller gives up with every path pending, and still condemns the dead connection afterwards — the dial's signal carries the caller's reason, the connection's does not.
- rejects with the first connection's error once every path has failed.
- waits for a pending connection to be condemned before failing, and then fails with its death (`DeadConnectionError` after ≥ the dead-connection delay).
- closes a stream a losing path opens late.
- lets a merely slow connection win when it answers first.
- in *option construction*: always hands the open a signal; runs a reuse-path open under its own signal, never the caller's; dials with `force`. In *cancellation*: cancels a fresh dial with the caller's reason. The entry-point sweep's reuse cases now also assert no fresh dial happened.

`packages/db-p2p/test/link-deadlines.spec.ts`: the enumerated `UNDECLARED` object and the 3 s case carry the two new fields; the explicit-dial case asserts `deadConnectionDelayMs` follows it. The "fast round trip changes nothing" case moved from 250 ms to 100 ms, because at 250 ms the hedge (375) is above its floor.

`packages/db-p2p/test/libp2p-key-network.spec.ts`: the `connect()` case that pinned signal forwarding now pins the opposite (the caller aborting does not abort the connection's open).

No test was added per derived constant.

## Validation

| command | result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p test` | 3237 passing, 68 pending, 1 failing before the key-network case was rewritten; that spec then 115 passing |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` (after `yarn build`) | 1001 passing, 14 pending; smoke ok |
| `yarn typecheck`, `yarn check:rn`, `yarn lint`, `yarn lint:docs` | all pass |

Not run: `yarn test:integration` (env-gated real TCP meshes) and the long-test tiers. `db-core` is untouched.

## Known gaps and things to probe

- **Timing assertions.** The unit spec asserts elapsed times against 40 ms and 120 ms delays with a 2 ms tolerance on the lower bounds and generous upper bounds; the real-network spec asserts the hedge was paid (≥ 245 ms) and that the post-condemnation open is under 250 ms. A heavily loaded CI machine could trip the upper bounds; widen before weakening.
- **Evidence is only gathered on the path a request takes.** A dead connection that ordering never picks (the reporter's own shape, now that newest-first applies) is left to libp2p's connection monitor. Nothing sweeps idle connections.
- **The condemnation needs `connection.abort` to move `status` synchronously.** True of `@libp2p/utils`' `AbstractMessageStream`, on which every multiaddr connection here is built; a transport whose `abort` is asynchronous would log the line once per concurrent race rather than once per connection (the abort itself is idempotent).
- **Matchmaking's query transport still opens under the undeclared delays**; it is constructed by hosts, not by node-base. Threading `streamOpen` there is a two-line change when a host needs it.
- **`packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts` is regenerated by the plugin's build** from the installed, portal-linked Quereus, which is at 4.20.2 while the committed stamp says 4.20.1. The build I ran rewrote it; I restored the committed value so this ticket's commit stays on topic. The drift itself is a release-housekeeping item for a human.
- `ProtocolClient.processMessage` needed no change: its dial deadline aborts with `DialTimeoutError`, which is the caller's reason the open rejects with, and `test/stream-open-costs-a-round-trip.spec.ts` still sees `DialTimeoutError` on a link slower than the deadline.
