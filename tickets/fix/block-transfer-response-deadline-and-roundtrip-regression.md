description: A peer that accepts a connection but then never answers can make the block-copy request wait forever, which during node churn can stall the whole re-replication process; also there is no fast automated test that proves block copying works over a real network.
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/test/spread-on-churn.spec.ts
difficulty: medium
----

# Fix: block-transfer push needs a response deadline + a default-suite round-trip regression test

## Background

`SpreadOnChurnMonitor` was wired into the live node (ticket
`optimystic-spread-on-churn-monitor-wiring`). During that review the block-transfer **receive**
path was found completely broken over real libp2p and fixed (wrong stream-handler signature +
a read-to-end deadlock — see that ticket's `## Review findings`). The end-to-end churn
re-replication integration test now passes. Two robustness/coverage gaps remain.

## Gap 1 — no response deadline on the push (potential unbounded stall)

`SpreadOnChurnMonitor.performSpread` pushes to each expansion target **sequentially**:

```ts
const response = await client.pushBlocks([blockId], [blockData], 'replication', blockMeta)
```

`BlockTransferClient.pushBlocks` → `ProtocolClient.processMessage` bounds only the **dial**
(via `options.dialTimeoutMs` → an `AbortController` passed to `peerNetwork.connect`). The
**response read** phase (`first(() => source)`, `protocol-client.ts:121`) honors **no** timeout
and **no** abort signal. So a peer that dials OK but then never writes a response makes
`pushBlocks` hang indefinitely; because `performSpread` awaits each push in series, one such peer
stalls the **entire** spread pass (all later blocks/targets, and the trackedBlocks self-prune,
never progress). Churn — slow/dying peers — is exactly when spread fires, so this is a real
production hazard, not a corner case. (It was the symptom that made the e2e test hang for 90s
before the receive-path fix; the fix removed the *happy-path* hang but not the *unresponsive-peer*
hang.)

Decide between two implementations (the first is more general and benefits every protocol client):

- **Preferred:** make `processMessage` honor `options.signal` (and/or a new `responseTimeoutMs`)
  during the response-read phase too — race the `first(...)` read against the abort signal /
  deadline and `stream.abort()` on expiry. Then have `performSpread` pass a bounded
  `dialTimeoutMs` + response deadline.
- **Contained alternative:** wrap each `pushBlocks` call in `performSpread` with a
  `Promise.race` against a timeout (config-driven, e.g. a new `SpreadOnChurnConfig.pushTimeoutMs`,
  default ~10s). Note the caveat: a raced-out `processMessage` promise keeps running in the
  background until its stream settles/closes — acceptable as a safety net but inferior to a real
  signal-aware abort.

A failed/timed-out push must surface as a `failed` target (existing `catch` branch already does
`failed.push(targetId)`), never a `succeeded` one.

## Gap 2 — no default-suite regression test for the block-transfer round-trip

The block-transfer **receive handler** (`block-transfer-service.ts` `handleRequest`) was rewritten
to a single continuous duplex pipe. The only thing now exercising that real-stream round-trip is
the **env-gated** churn integration test (`OPTIMYSTIC_INTEGRATION=1`,
`real-libp2p.integration.spec.ts`). The default `yarn test` run does **not** cover it — the
existing `block-transfer-push-persist.spec.ts` calls `handlePush`/`handlePull` **directly**, never
through `registrar.handle` + a stream. A future regression in the handler's stream framing would
pass the default suite silently.

Add a regression test that drives a real (or faithfully-mocked-duplex) request→response round trip
through the registered handler — both a `pull` and a `push` — asserting the client receives the
response (and, for `push`, that `saveReplicatedBlock` ran). Mirror how cluster/repo service stream
handlers are tested if such a harness exists; otherwise a lightweight in-memory duplex-stream pair
is sufficient. The same harness naturally covers Gap 1's unresponsive-peer case (a handler that
never yields → the client's deadline fires).

## Acceptance

- An expansion peer that dials OK but never responds cannot stall `performSpread` beyond a bounded
  deadline; the push is recorded as failed and the loop continues to the next target/block.
- `yarn test` (no env gate) covers a block-transfer request→response round trip through the
  registered stream handler, and a no-response-peer case that asserts the deadline fires.
- `yarn build` + `yarn test` pass; the env-gated churn integration test still passes.
