description: Every request between two machines opens a new stream, and opening one costs a full network round trip before the request is even sent — over a relay, about half of every request's time. Keep one already-opened stream ready per peer and protocol while traffic is flowing, so the next request skips that round trip.
architecture: docs/internals.md#commit-path-distributed-consensus
files: packages/db-p2p/src/network/prepared-streams.ts (new), packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts, packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts, packages/db-p2p/test/util/delay-proxy.ts, docs/debugging.md, docs/transactions.md, docs/internals.md
----

# A request reuses a pre-negotiated stream

GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29), question 1. Split out of plan ticket `feat-fewer-relay-round-trips-per-write-and-read`; the other two questions are plan ticket `feat-fewer-consensus-calls-per-write` and backlog `feat-a-cohort-consult-batches-blocks-per-peer`.

## Why

Every request this package makes to another machine goes through `ProtocolClient.processMessage` (`packages/db-p2p/src/protocol-client.ts`) → `Libp2pKeyPeerNetwork.connect` → `openProtocolStream` (`packages/db-p2p/src/network/open-protocol-stream.ts`), opens a fresh stream, sends one request, reads one reply and closes the stream. All five callers subclass `ProtocolClient`: the repo, cluster, sync, block-transfer and dispute clients.

Opening a stream costs one full link round trip even on a connection that is already open. multistream-select (the protocol negotiation libp2p runs on every new stream) writes the proposal and then waits for the remote's echo before the stream is handed back. `@libp2p/multistream-select` 7.0.28's `select()` awaits that echo unconditionally — the `negotiateFully: false` option we pass is ignored (read in `dist/src/select.js`; pinned by `stream-open-costs-a-round-trip.spec.ts`). The multiplexer (yamux) costs nothing extra: its new-stream flag rides on the first data frame. So the whole penalty is the negotiation.

Measured by the reporter on 1.12.1: a one-row insert on a two-member group is 4 `/cluster` requests, and `dial:ok` on an already-open connection took 146–767 ms between phones, about half of every request. Removing the negotiation from the request path takes a write from 8 relay round trips to 4 without touching consensus.

Getting libp2p to negotiate lazily (send the proposal and the first request together) is not available: lazy select was removed from multistream-select 7, and restoring it is an upstream change we do not control. This ticket does the in-repo equivalent instead.

## Design: one prepared stream per (peer, protocol)

A **prepared stream** is a stream whose protocol negotiation has already completed, held idle for the next request to that peer on that protocol. The answering side needs no change: all five request/response handlers (`RepoService`, `ClusterService`, `SyncService`, `BlockTransferService`, `DisputeService`) `for await` the first frame of a stream and return after one reply, so a held stream simply waits for its one request, and a stream closed with no request ends their loop without a frame and without an error (checked for all five).

### `PreparedStreams` (`packages/db-p2p/src/network/prepared-streams.ts`, new)

```ts
export interface PreparedStreamsInit {
	/** The protocol ids that get a prepared stream. Any other protocol passes straight through. */
	protocols: readonly string[];
	/** How long a prepared stream may sit unused before it is closed; default PREPARED_STREAM_IDLE_MS. */
	idleMs?: number;
	/** Hedge and dead-connection delays for the background open — the node's LinkDeadlines. */
	deadlines?: StreamOpenDeadlines;
	log?: StreamOpenLog;
}

export const PREPARED_STREAM_IDLE_MS = 30_000;

export class PreparedStreams {
	constructor(node: Libp2p, init: PreparedStreamsInit);
	/** A ready stream for (peer, protocol), removed from the pool, or undefined. Never waits, never dials. */
	take(peer: PeerId, protocol: string): Stream | undefined;
	/** Make sure one stream for (peer, protocol) is ready or being prepared. Fire-and-forget. */
	replenish(peer: PeerId, protocol: string): void;
	/** Close every held stream, cancel every background open, clear every timer. Idempotent. */
	close(): void;
}

/** True for a stream `take` handed out, so `processMessage` can apply the retry rule below. */
export function isPreparedStream(stream: Stream): boolean;
```

Rules:

- **Depth one.** At most one ready stream and at most one background open in flight per (peer, protocol) key. A burst of concurrent requests to one peer takes the one ready stream and opens the rest fresh — no worse than today.
- **Only on demand.** `replenish` is called by `connect` after it has handed out a stream for an eligible protocol, whether that stream was taken or freshly opened. Nothing is prepared for a peer this node has not just sent a request to: no warming on connection open or identify — the reporter's phones already spend 15–19 % of their JS loop on idle background streams.
- **Never dials.** The background open uses `openProtocolStream` with a new `allowDial: false` option (below), so it only ever uses a connection that is already open. A peer with no open connection gets no prepared stream, and the next request dials as today.
- **Idle expiry.** A ready stream that is not taken within `idleMs` is closed gracefully (`stream.close()`, not `abort` — the answering handler then sees an empty stream and returns quietly), and is NOT replaced. So a burst of activity costs one extra stream open and one empty stream at its end, and an idle peer costs nothing. The timer is unref'd (`unrefTimer` in `packages/db-p2p/src/unref-timer.ts`).
- **Eviction.** A ready stream is dropped from the pool the moment it closes for any reason (listen for the stream's `close` event): its connection was aborted (including by `open-stream:connection-dead` condemnation), the remote closed it, the relay circuit hit its cap.
- **What `take` refuses.** The stream is handed out only if it is still fully open in both directions (`status`, `writeStatus` and `remoteWriteStatus` — the remote has not half-closed it), its connection is still `open`, it is younger than `idleMs`, and it is not on a limited (relayed) connection while a direct open connection to the same peer now exists (after a DCUtR upgrade the direct one is what `openProtocolStream` would pick; `isLimitedConnection` there). A refused stream is closed and `take` returns `undefined`. Find a stream's connection by `node.getConnections(peer).find(c => c.streams.includes(stream))` at prepare time and keep it with the entry.
- **No self.** `replenish` for this node's own peer id is a no-op (libp2p never dials self; nothing calls it today, but the guard is free).
- **Background-open failures are quiet.** One debug line (`prepared-stream:open-failed peer protocol reason`) and no retry until the next `replenish`.
- **Logs.** `prepared-stream:expired` (idle close) at debug, per key. No per-take line — `processMessage`'s `dial:ok` carries it (below).

Why depth one and 30 s: a write is a short sequence of requests to the same one or two peers (pend promise round, pend commit round, commit promise round, commit commit round), each request's own round trip is long enough for the replacement's negotiation to finish behind it, so every request after the first in a sequence finds a ready stream. The read path's cohort consult recurs once per read-repair window (10 s default), and a reactivity watch ticks at 20–30 s, so 30 s keeps those warm without holding streams for peers that went quiet.

### `openProtocolStream` gains `allowDial`

`OpenProtocolStreamOptions.allowDial?: boolean`, default `true`. `false` leaves the fresh-dial path out of `orderedPaths`, so the race runs over open connections only (keeping the hedge and the dead-connection condemnation, which matter below). With no open connection there are then no paths at all, and `StreamOpenRace.run` must reject at once with a typed error (`NoOpenConnectionError`, with a `.code`) — today `orderedPaths` always ends in a dial path, so an empty list would leave the promise unsettled forever.

### `Libp2pKeyPeerNetwork.connect`

```ts
const prepared = this.preparedStreams?.take(peerId, protocol);
if (prepared) { this.preparedStreams!.replenish(peerId, protocol); return prepared; }
const stream = await openProtocolStream(/* as today */);
this.preparedStreams?.replenish(peerId, protocol);
return stream;
```

The caller's signal is honoured as today: an already-aborted signal must still reject before anything is touched, so check it before `take`. The pool is optional so every other construction of `Libp2pKeyPeerNetwork` (tests, embedders) behaves exactly as today. Its constructor already takes nine positional arguments; add the pool however reads best (a trailing optional argument is acceptable; do not reshuffle the existing ones in this ticket).

### Wiring (`createLibp2pNodeBase`)

Build one `PreparedStreams` per node beside the key network, with `protocols` = this node's repo, cluster, sync and block-transfer protocol ids (built from `protocolPrefix`, the same strings the four services register), `deadlines` = the node's `linkDeadlines`, and the key network's peer-id-suffixed stream-open logger. Dispute is left out: it is rare and off by default, so a prepared stream for it would almost always expire unused. Cohort-topic, reactivity and FRET open their own streams and are untouched. Close the pool in a node stop wrapper installed immediately after it is built (the pattern the rest of `createLibp2pNodeBase` follows, so startup rollback unwinds it).

### `processMessage`: one re-send when a prepared stream fails before replying

A prepared stream was negotiated up to `idleMs` before this request; the connection under it can have died in between without either side noticing — the half-open connection of GitHub #32 (`half-open-connection-does-not-strand-a-peer.spec.ts`). Today a fresh open on such a connection hedges to the next connection after 250 ms. A request sent on a prepared stream cannot hedge (that would send the request twice on purpose), but it does not hang either: `connect`'s `replenish` starts a background open, which picks the same best connection, stays pending there, and condemns it after the dead-connection delay; aborting the connection resets the request's stream.

So: when the stream came from the pool (`isPreparedStream`) and the exchange fails **before the first response byte**, for any reason other than this request's own response deadline or the caller's abort, `processMessage` re-sends the request ONCE on a stream from a new `connect` call, within the same caller signal and response deadline. A failure after a response byte, or of the re-send, propagates as today. The re-send can deliver a request twice if the remote did receive it before failing (a remote whose event loop stalled past the dead-connection delay looks dead too). All four eligible protocols already tolerate re-delivery — the batch retries in `NetworkTransactor` re-send requests today, cluster records merge idempotently and consensus execution is deduplicated by message hash, and pend/commit of an action at its own revision are no-ops (`isOwnRevision`) — so this adds no new shape. If that turns out not to hold for some operation, the retry is the place to narrow, not the pool.

Log it: `dial:ok` gains `prepared=true|false`, and the re-send logs `prepared:resend peer protocol reason` before its own `dial` line.

### Deadlines stay as they are

`resolveLinkDeadlines` sizes the dial deadline and `cohortQueryTimeoutMs` for two round trips per request. Keep them: the first request to a peer after an idle spell, every concurrent request beyond the first, and every request on a fresh connection still pays the negotiation.

## Edge cases & interactions

- **No open connection.** `replenish` does nothing useful (background open rejects with `NoOpenConnectionError`, logged at debug); the next request dials as today. Verify by inspection and by the empty-path rejection in `StreamOpenRace`.
- **Connection condemned or aborted while a stream is held.** The `close` event evicts it; `take` also re-checks connection status. Inspection.
- **Connection goes half-open between preparation and use.** Covered by the re-send rule; **test** below.
- **Remote half-closes or closes a held stream** (a remote that adds an idle timeout later, a restart). `take` refuses it on `remoteWriteStatus`; if the close crosses the request on the wire, the re-send covers it. Inspection.
- **DCUtR upgrade while a stream is held on the relayed connection.** `take` refuses it in favour of a fresh open on the direct connection. Inspection.
- **Relay circuit caps** (`Limit { data: 128 KiB, duration: 2 min }` on a stock relay). A held stream carries a few bytes of negotiation; when the circuit resets, eviction handles it. Inspection.
- **Caller signal already aborted.** Rejects before `take`, as `openProtocolStream` does today. Inspection.
- **Concurrent requests to one key.** Depth one: the first takes, the rest open fresh, each calls `replenish`, and the in-flight flag keeps it to one background open. Inspection.
- **Node stop.** `close()` closes held streams and cancels in-flight background opens (`AbortController` per open, aborted on close); a background open that completes after `close()` closes its stream. Inspection.
- **Inbound stream authorization** (`authorizeInboundStream`, `packages/db-p2p/src/inbound-authorization.ts`) is decided once per stream, at open. A held stream was authorized up to `idleMs` before the request it carries, so revoking a peer takes effect on its prepared streams only when they expire. This is not a new exposure — any peer could already open a stream and hold it — but it is now routine for honest peers, so say so in the Inbound Stream Authorization section of `docs/internals.md`.
- **Network membership predicate.** A peer the predicate stops admitting stops being chosen, so no request takes its prepared streams and they expire. Inspection.
- **Stream limits.** Each held stream counts against the answering node's per-connection `maxInboundStreams` (32, 16 for dispute) and this node's `maxOutboundStreams` (64). One per protocol is well inside both. Inspection.
- **React Native / browser.** The new module imports only types and the pure helpers `open-protocol-stream.ts` already uses (`unref-timer.ts`, `logger.ts`, `rpc-deadline.ts`); it is reachable from `src/rn.ts` through `libp2p-key-network.ts`. `yarn check:rn` covers it.
- **Single-site rule.** `test/dial-options-single-site.spec.ts` fails the build if a file other than `open-protocol-stream.ts` calls `newStream` / `dialProtocol`; the pool must open through `openProtocolStream`, never directly.

## Tests

Default to none beyond these two, both on real sockets through the existing delay proxy (`test/util/delay-proxy.ts`):

- In `stream-open-costs-a-round-trip.spec.ts`, a third case: with a `PreparedStreams` for the echo protocol in the test's `connect`, the first request still takes at least two round trips, and a second sequential request takes at least one and **less than two**. Keep the two existing cases unchanged — they pin the libp2p premise, and the docblock should say the pool is the in-repo answer to it.
- In `half-open-connection-does-not-strand-a-peer.spec.ts`, if its harness can hold a prepared stream on the connection it turns half-open without new scaffolding: a request that takes that stream still gets its reply (through the re-send), within the dead-connection delay plus one request. If the harness cannot do this cheaply, say so in the review handoff instead of building new scaffolding.

Run `yarn test` and `yarn test:integration` in `packages/db-p2p` (the integration specs drive real meshes through `connect`), and `yarn check:rn` from the root.

## Docs

- `docs/debugging.md`: the `protocol-client` row (`dial:ok … prepared=`, `prepared:resend`), a `prepared-stream` row, the `open-protocol-stream` row's "a request that met such a connection was already answered…" sentence, and the `silent` row's "every one of these requests is a fresh stream… costs two" (now: the first request in a spell, and each concurrent one beyond the first).
- `docs/transactions.md` § *When to raise `cohortQueryTimeoutMs`*: same correction; the advice to size for two round trips stands, because the first consult after a quiet spell still pays both.
- `docs/internals.md`: the authorization note above. Grep the docs for "fresh stream" for any other statement that every request negotiates.
- The `open-protocol-stream.ts` docblock's NOTE on `negotiateFully` and `Libp2pKeyPeerNetwork.connect`'s comment: point at the pool as what actually removes the round trip.

## TODO

- Add `allowDial` and the empty-path rejection (`NoOpenConnectionError`) to `openProtocolStream`.
- Write `PreparedStreams` and `isPreparedStream` in `packages/db-p2p/src/network/prepared-streams.ts`.
- Route `Libp2pKeyPeerNetwork.connect` through the pool when one is supplied.
- Add the prepared-stream re-send and the `prepared=` log field to `ProtocolClient.processMessage`.
- Build, wire and stop the pool in `createLibp2pNodeBase` for the repo, cluster, sync and block-transfer protocols.
- Add the two tests; run `packages/db-p2p` `yarn test` and `yarn test:integration`, and root `yarn check:rn`.
- Update the docs listed above; run `yarn lint:docs`.
- In the review handoff, ask for the reporter's `message-latency.mjs` re-measure on a relayed pair: expect `dial:ok` near 0 ms with `prepared=true` on every request after the first of a write.
