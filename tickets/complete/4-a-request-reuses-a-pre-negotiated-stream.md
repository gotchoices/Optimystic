description: Every request between two machines used to open a new stream, which costs a full network round trip before the request is even sent. Each node now keeps one already-opened stream ready per peer and protocol while traffic is flowing, so the next request skips that round trip. Reviewed; one fix made so a request the other machine already received and failed on is not run there a second time.
architecture: docs/internals.md#commit-path-distributed-consensus
files: packages/db-p2p/src/network/prepared-streams.ts, packages/db-p2p/src/network/open-protocol-stream.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/test/stream-open-costs-a-round-trip.spec.ts, packages/db-p2p/test/half-open-connection-does-not-strand-a-peer.spec.ts, docs/debugging.md, docs/transactions.md, docs/internals.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/readme.md
----

# A request reuses a pre-negotiated stream

GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29), question 1. Siblings: plan ticket `feat-fewer-consensus-calls-per-write`, backlog `feat-a-cohort-consult-batches-blocks-per-peer`.

## What shipped

Opening a libp2p protocol stream costs one link round trip even on an open connection (multistream-select waits for the remote's echo; `@libp2p/multistream-select` 7 ignores `negotiateFully: false`). Every request was one request on one fresh stream, so it paid two round trips.

- `PreparedStreams` (`packages/db-p2p/src/network/prepared-streams.ts`) holds at most one negotiated stream, and at most one background open, per (peer, protocol), for the repo, cluster, sync and block-transfer protocols. Replenished only after a request (`Libp2pKeyPeerNetwork.connect`), never dials (`openProtocolStream`'s new `allowDial: false`, which rejects with `NoOpenConnectionError` when no connection is open), expires after 30 s unused, evicted on close or remote half-close, and re-checked at `take` (open both ways, connection open, not idle, not relayed when a direct connection now exists).
- `ProtocolClient.processMessage` split into `openRequestStream` and `exchange`. A request on a prepared stream that fails before any reply byte is re-sent once on a new stream, inside what is left of the response deadline — except on its own response timeout, the caller's abort, or (added in review) a reset from the remote.
- One pool per node in `createLibp2pNodeBase`, closed by a stop wrapper installed immediately after construction. `dial:ok` logs `prepared=true|false`; the re-send logs `prepared:resend`; the pool logs under `prepared-stream`.
- Docs updated: `docs/debugging.md`, `docs/transactions.md`, `docs/internals.md` (authorization is decided at stream open, so a revoked peer's held streams stay usable until they expire), `packages/db-p2p/docs/cluster.md`, `packages/db-p2p/readme.md`, the `cohortQueryTimeoutMs` docblock in db-core.

## Review findings

Read the `ticket(implement): a-request-reuses-a-pre-negotiated-stream` diff first, then the handoff.

**Fixed in this pass**

- **A request the remote received and failed on was run a second time.** All four services (`RepoService`, `ClusterService`, `SyncService`, `BlockTransferService`) reset the stream when handling a request throws — e.g. `ResponsibilityRefusalError` on a write, a refused redirect lookup, a cluster member refusing a record, an inbound-authorization denial. `mayResend` treated that reset like a dead connection and re-sent, so the remote executed the failing operation twice (and logged the error twice) on every such failure over a prepared stream. Verified: the new test below saw 3 deliveries for 2 requests without the fix. Fix: `ProtocolClient.mayResend` returns false when `stream.status === 'reset'` — only a remote reset produces that status in libp2p 3 (`AbstractMessageStream.onRemoteReset`), whereas the failure the re-send exists for, a dead connection condemned by the replacement open, aborts the stream from this side. Docblocks in `protocol-client.ts` and `prepared-streams.ts` and the `protocol-client` row of `docs/debugging.md` updated to state the rule.
- **Test added:** `half-open-connection-does-not-strand-a-peer.spec.ts`, "when the remote resets a request it received on a prepared stream / is not sent a second time" — asserts a stream was prepared (so the case is not vacuous) and that two requests produce exactly two deliveries. Confirmed failing without the fix, passing with it.

**Checked, no change needed**

- Answering side: each service's handler reads the first frame and returns; a held stream closed with no request ends the `for await` with no frame and closes quietly (read `RepoService.handleIncomingStream`; the other three share the shape). Per-protocol `maxInboundStreams` (32) is far above the pool's depth of one per peer. libp2p's stream inactivity timeout (120 s, `AbstractMessageStream` and yamux config) is above the 30 s idle expiry, so a held stream is never torn down by the transport first.
- Only caller of `IPeerNetwork.connect` is `ProtocolClient.openRequestStream`, so a pooled stream is always used for exactly one request/response.
- Resource cleanup: idle timers are unref'd and cleared on release; `opening` entries are deleted on settle; `close()` aborts in-flight opens and a late open after close is discarded; the stop wrapper is installed right after construction so startup rollback unwinds it.
- Remaining re-send cases (a local abort or transport close before any reply byte) can still deliver a request twice if the remote had received it. That is the design's stated premise (batch retries already re-send); not re-verified per operation, and now limited to failures where the remote did not answer at all.
- Tests kept as written: the implementer's two cases each pin a named behaviour (a request after the first pays one round trip; a request on a prepared stream over a connection that went half-open is still answered through the re-send). Nothing restates the implementation or verifies a mock.

**Tripwires / declined**

- `Libp2pKeyPeerNetwork` constructor now has ten positional parameters; the implementer rewrote the existing `NOTE:` to "before an eleventh parameter in any case". Left as that tripwire — it serves no current-release anchor, so no ticket.
- Minor duplication left: `failureReason` in `prepared-streams.ts` and `errorLabel` in `protocol-client.ts` both truncate an error message at 200 characters. Not merged because `protocol-client.ts` imports `prepared-streams.ts`, and the two differ (one prefers the error code); two short private helpers do not justify a shared module.
- The "request issued in the same instant as the previous reply misses the prepared stream" race is documented in the round-trip spec; whether it matters in the field is what the re-measure below will show.

**Validation**

- `packages/db-p2p`: `yarn build` clean; `yarn test` 3288 passing / 70 pending; `yarn test:integration` 50 passing / 2 pending.
- `packages/quereus-plugin-optimystic`: `yarn test` 1001 passing / 14 pending (the implementer had run only its integration suite).
- `yarn lint:docs` clean; `eslint` clean on the touched files; `tsc --noEmit` clean for db-p2p. `yarn check:rn` not re-run — this pass added no imports.

## Follow-up for a human

Ask the reporter of #29 to re-run `message-latency.mjs` on a relayed pair with `DEBUG=optimystic:db-p2p:protocol-client*`. Expected: `dial:ok` near 0 ms with `prepared=true` on every request after the first of a write (the first after a quiet spell still shows `prepared=false`), and a write dropping from about 8 relay round trips to about 4.
