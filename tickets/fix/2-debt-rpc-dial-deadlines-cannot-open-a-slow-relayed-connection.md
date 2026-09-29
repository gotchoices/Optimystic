description: db-p2p's own RPC dial deadlines (3 s) cannot open a relayed connection above about 375 ms one-way, and no node option raises them. The same deadline also bounds stream negotiation on an already-open connection, so on a 3 s round-trip link every cohort consult aborts at 3 s.
files:
  - packages/db-p2p/src/rpc-deadline.ts (`DEFAULT_DIAL_TIMEOUT_MS`, `withRpcDeadlineDefaults`)
  - packages/db-p2p/src/network/open-protocol-stream.ts (the connection-reuse path: "chosen.newStream([protocol], streamOptions)")
  - packages/db-p2p/src/sync/client.ts (`SyncClient.requestBlock`)
  - packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`'s `requestBlock` call, which passes no deadline options; the "pushDialTimeoutMs ?? 3000" defaults)
  - packages/db-p2p/src/cluster/spread-on-churn.ts and the other `pushDialTimeoutMs` consumers
source: sereus gardener, follow-up to optimystic #22 (measurement: sereus `relayed-dial-cost-by-latency`); negotiation measurement from sereus-ec (sereus tickets/blocked/report-request-dial-deadline-cuts-cohort-consults-on-open-connections-to-optimystic.md)
----
# RPC dial deadlines fail every slow relayed link

Opening a relayed connection costs about eight one-way link delays (sereus measured 26 ms at no delay,
7.3 s at 900 ms one-way, 12.1 s at 1500 ms one-way). `NodeOptions.connectionManager` now lets a
deployment raise libp2p's own `dialTimeout` and `inboundUpgradeTimeout`, but those apply only to dials
without a caller signal. Our RPC clients pass their own: `DEFAULT_DIAL_TIMEOUT_MS = 3000` in
`rpc-deadline.ts` and several `pushDialTimeoutMs ?? 3000` defaults. At 3 s a relayed connection cannot
open above about 375 ms one-way, so on any relayed link those RPCs fail at the dial.

Sereus supports relayed links up to a 3 s round trip (maintainer decision).

## The dial deadline also bounds an already-open connection

An earlier draft of this ticket assumed an open connection short-circuits the dial deadline. It does
not. `SyncClient.requestBlock` applies `withRpcDeadlineDefaults`, so the 3 s dial deadline becomes the
dial-phase abort signal in `ProtocolClient`. `openProtocolStream` forwards that signal into
`newStream([protocol], { signal })` on the connection-reuse path, and multistream-select inside
`newStream` costs one link round trip. At a 3 s round trip the negotiation never finishes inside 3 s,
however long the connection has been open.

The read-repair consult hits this on every call: `clusterLatestCallback` in `libp2p-node-base.ts` calls
`requestBlock` with no deadline options, and its own race against `cohortQueryTimeoutMs` never gets a
chance to fire.

Measured by sereus on 2026-09-29: two relay-only nodes, 1500 ms one-way delay, sereus
`strand-reattach-first-sync-measure` fresh-join arm.

| per-peer cohort read deadline (`cohortQueryTimeoutMs`) | declined reads (`cluster-fetch:peers-silent` → no-quorum) |
| --- | --- |
| 5000 ms | 39 |
| 7000 ms | 32 |

On the joiner, consecutive declined reads were 3.00–3.02 s apart in both runs, and neither 5000 nor
7000 ever fired. On that link a node never corroborates a block with its cohort through read repair;
joins complete only because sereus's backfill pushes the blocks.

No `NodeOptions` field reaches this deadline: `underReplicationDrain.pushDialTimeoutMs` covers pushes
only, and `connectionManager.dialTimeout` is overridden by the caller's signal.

## To decide

- One node-level link-latency declaration from which every dial deadline derives, or a per-deadline
  override? A single declaration (e.g. `declaredLinkRoundTripMs`) matches how sereus states its
  requirement and keeps the deadlines from drifting apart. Sereus would derive either from its declared
  link round trip.
- Stream negotiation on a reused connection needs its own bound, or none. Either stop forwarding the
  dial signal into `newStream` on the reuse path (the response deadline still bounds the request), or
  give negotiation a separate bound derived from the link round trip. Sereus is unblocked by either
  this or the node-level knob above.
- Whether `clusterLatestCallback` should pass `cohortQueryTimeoutMs` down as the request's deadline, so
  the configured per-peer budget is the one that actually applies.

## TODO

- Reproduce on a latency-injected mesh: an open connection at ≥ 1.5 s one-way, a `requestBlock` with
  default options aborting at 3 s.
- Output implement ticket(s).
