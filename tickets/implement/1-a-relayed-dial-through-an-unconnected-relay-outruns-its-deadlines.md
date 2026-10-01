description: When a node dials a peer through a relay it is not already connected to, it first has to open the connection to that relay, and on a slow link that extra work does not fit in the time limits we derive from the declared round trip. Sereus says this is its normal case, so the limits must be sized for it.
architecture: packages/db-p2p/readme.md
files:
  - packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `LinkDeadlines`, `CONNECTION_ROUND_TRIPS`, `DIAL_ROUND_TRIPS`, the `NOTE:` above them, `MAX_LINK_ROUND_TRIP_MS` doc)
  - packages/db-p2p/src/libp2p-node-base.ts (inline `connectionManager` block in `createLibp2pNodeBase`; `NodeOptions.connectionManager` and `NodeOptions.linkRoundTripMs` docs)
  - packages/db-p2p/test/link-deadlines.spec.ts
  - packages/db-p2p/test/util/delay-proxy.ts (reuse as is)
  - new: packages/db-p2p/test/cold-relayed-dial-fits-the-address-limit.spec.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`NetworkTransactor` `timeoutMs` and `abortOrCancelTimeoutMs`, and their `NOTE:`s)
  - packages/quereus-plugin-optimystic/README.md (only if it states the transaction budget)
  - packages/db-p2p/readme.md (*Slow relayed links* paragraph and deadline table)
  - packages/db-p2p/docs/cluster.md (*Declaring the link instead*: "about four more")
repro: verified
----
# A relayed dial through an unconnected relay outruns its deadlines

## The defect

`resolveLinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts` sizes libp2p's per-address limit (`addressDialTimeoutMs`, 5 round trips) and the RPC dial deadline (`dialTimeoutMs`, 6 round trips) for a relayed dial whose connection to the relay is already open. When it is not open, the circuit transport opens it from inside the same per-address limit (checked in the review of `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout`). Sereus says this is the normal case: an invitation lists every circuit address the inviter has, a joiner usually dials through the inviter's relay, and it is often not connected to that relay.

## Reproduction (measured in the fix stage)

A throwaway spec built three plain libp2p 3.3.11 nodes on loopback: a circuit-relay server, a target holding a reservation on it, and a dialer. Each node reached the relay through its own `listenDelayProxy` (`packages/db-p2p/test/util/delay-proxy.ts`), so the dialer→relay leg and the relay→target leg had separate one-way delays. `r` below is the end-to-end relayed round trip, `2 × (d1 + d2)`, which is what `linkRoundTripMs` declares ("relayed hops included"). Each row is three runs, all within 0.1 r of each other:

| dialer→relay one-way | relay→target one-way | `r` | warm (relay connection already open) | cold (no relay connection) |
|---|---|---|---|---|
| 100 ms | 100 ms | 400 ms | 4.4 r | 5.5 r |
| 200 ms | 1 ms | 402 ms | 4.4 r | 6.6 r |
| 1 ms | 200 ms | 402 ms | 4.4 r | 4.6 r |

So the warm case matches the 4 round trips the current multiples assume (with 0.6 r to spare under the per-address 5), and the cold case exceeds 5 r whenever the dialer's leg to the relay carries a real share of the round trip. Worst case is the dialer's leg carrying all of it: 6.6 r.

The proxy delays bytes only, not the TCP handshake, so the cold figures understate a real network by the socket setup on the dialer→relay leg: one leg round trip for TCP, one more for a WebSocket upgrade, and one more for TLS 1.3 under `wss`. Bounding that leg by `r` (it is one hop of the relayed path, so its round trip is at most the declared value; an overestimate, but the only number we have) gives a worst-case cold open of about 7.6 r over TCP, 8.6 r over WebSocket, and 9.6 r over `wss`.

## Decisions taken in the fix stage

- **Size for the cold path everywhere; do not count the relay leg separately.** libp2p takes one `addressDialTimeout` for every address, so the per-address limit must cover the cold path whatever the RPC layer does. Checking for a relay connection before each RPC dial would add a branch that parses circuit addresses and still cannot know which of several listed addresses libp2p will try. The cost of a longer limit is only that a dial that is going to fail fails later. An undeclared node keeps every floor, so LAN deployments are unchanged. On a declared slow link, a dead coordinator is re-picked later, which is why the plugin's overall transaction budget has to move with the dial (below).
- **No admission allowance.** Sereus answered this: its gates (relay and target, up to 2000 ms each) are its own cost, and it will compute totals and pass explicit values. Two of those values (`connectionManager.addressDialTimeout` and `connectionManager.dialTimeout`) are already overridable. The third, the RPC dial deadline, is `fix/1.5-the-rpc-dial-deadline-cannot-be-set-per-node`, which waits on this ticket and adapts to the shape it leaves `LinkDeadlines` in. Do not add a per-gate knob here.
- **Keep the floors.** Undeclared must still resolve to exactly the current constants.

## Recommended multiples

- **Cold connection open: 10 round trips.** Measured worst case 6.6 r, plus the WebSocket socket setup (8.6 r), plus margin. `wss` with TLS 1.3 (9.6 r) still fits. Used for:
  - `addressDialTimeoutMs = max(6000, 10 r)`;
  - libp2p's `connectionManager.dialTimeout`, `max(10000, 10 r)`. That deadline governs every dial that carries no signal of its own, including a cold relayed one, so it can never be shorter than the per-address limit.
- **RPC dial: 11 round trips**, the cold open plus one for stream negotiation (`test/stream-open-costs-a-round-trip.spec.ts`). The margin is already in the 10.
- **Inbound upgrade stays at 5 round trips** (`max(10000, 5 r)`). The listener's timer runs only over its own upgrade: the relay's upgrade of the dialer's direct connection, or the target's upgrade of the relayed connection after the circuit stop. Neither includes the dialer's relay open.

This splits today's `connectionTimeoutMs`, which feeds both libp2p `dialTimeout` and `inboundUpgradeTimeout`, into two fields: suggested names `inboundUpgradeTimeoutMs` and `libp2pDialTimeoutMs`, or similar. Pick names that do not collide with the RPC `dialTimeoutMs`. Ticket 1.5 wants a "matching `connectionManager.dialTimeout`", which this split gives it.

At the supported 3 s round trip these give: per-address limit 30 s, libp2p dial 30 s, RPC dial 33 s, transfer `max(30000, dial)` = 33 s, inbound upgrade 15 s, response 10 s, cohort query 9 s.

`MAX_LINK_ROUND_TRIP_MS` needs no change: the largest derived delay is still the reconcile pass bound (`5 × 3 r = 15 r`), above 11 r. Update its doc, which mentions "the dial deadline's six round trips".

## Read path: no change to the budget, but a sentence to correct

`cohortQueryTimeoutMs` (3 r) runs under `withinRequestBudget`, independent of the dial deadlines, so this change does not touch it. The `packages/db-p2p/docs/cluster.md` sentence "a request that has to open a relayed connection first (about four more) does not fit, and that is safe" understates the cold case (about 7 to 10 more). Correct the number.

While correcting it, record this as a tripwire `NOTE:`. When that budget aborts, it also aborts the connection open the request started. In libp2p 3.3.11's `dial-queue.js`, a dial runs under the first caller's signal, and later callers join that dial without extending it. So a node whose only traffic to a peer is read-path requests never opens a cold relayed connection to that peer. Some other path with a longer deadline has to open it: consensus, sync repair, or FRET's own dials. Fine while those paths exist. If a read-only node ever has to reach a peer that nothing else dials, the read budget has to cover a cold open. Put the `NOTE:` at the `withinRequestBudget` call in the cohort consult, or in that `cluster.md` paragraph if there is no single site.

## The plugin's transaction budget has to follow the dial

`collection-factory.ts` builds the plugin's `NetworkTransactor` with a fixed `timeoutMs: 30_000`. Its `NOTE:` says that budget fits a 3 s round trip only narrowly, and that a cold relayed connection does not fit. Cold is now the normal case. With an 11 r dial (33 s at 3 s), one cold dial to the coordinator already uses more than the whole budget, and a dead coordinator could not be re-picked at all. Derive the budget from the dial deadline with the 30 s floor kept, so an undeclared node is unchanged.

Recommendation: `Math.max(30_000, 3 * dialTimeoutMs)`. That covers the client's cold dial to the coordinator, the coordinator's own cold dial to a cohort member during the pend round, and the remaining warm round trips of pend and commit. At 3 s it is 99 s. The cost: a writer that dies holds its pending records for up to that long, since the expiration it sends derives from this budget. Verify that against `NetworkTransactor` before settling the multiple.

`abortOrCancelTimeoutMs: Math.max(5_000, dialTimeoutMs)` follows the dial automatically. Re-read its `NOTE:`: with the dial at 11 r it now covers one cold dial, not two. Update the round-trip numbers in both `NOTE:`s. The reference peer (`packages/reference-peer/src/cli.ts`) reads `node.linkDeadlines.dialTimeoutMs` for its transactor. Check whether it pins an overall budget the same way, and treat it the same.

## Tests

- `link-deadlines.spec.ts`: update the 3 s case and the undeclared object for the new and renamed fields. Keep the "transfer never below dial" and ceiling cases, and add the new libp2p dial field to the ceiling's `Math.max`. Add no case per field.
- New `cold-relayed-dial-fits-the-address-limit.spec.ts`, the reproduction. Use three plain libp2p nodes (relay server with `applyDefaultLimit: false`, target with a reservation, dialer), wired as in the table above, with the whole round trip on the dialer's leg (dialer→relay one-way about 150 ms, relay→target about 1 ms). Assert that a dial from a dialer **not** connected to the relay succeeds with `connectionManager.addressDialTimeout` set to the cold multiple × `r` and a generous caller signal. It fails at today's 5 (6.6 r measured), so it reproduces the defect.
  - Get the multiple through the public function rather than a new export: `resolveLinkDeadlines(MAX_LINK_ROUND_TRIP_MS).addressDialTimeoutMs / MAX_LINK_ROUND_TRIP_MS`, which is exact. A small declared value cannot be used, because the 6000 ms floor would hide the multiple.
  - Measured cost: one cold dial is about 2 s at `r` ≈ 300 ms, plus a few hundred ms of setup and reservation. That is the same order as `address-dial-timeout-cuts-off-a-signalled-dial.spec.ts`, which is in the default suite, so keep this one ungated too. If it proves slow or flaky under load, gate it on `RUN_LONG_TESTS=1` and say so in the spec header, the way the other relay specs do.
  - Wait for the target's circuit address to appear before dialing. The fix-stage script polled `target.getMultiaddrs()` for `p2p-circuit`.
  - Spec header: state that this pins the libp2p cost behind the cold multiple, give the measured figures, and say that the proxy does not delay the socket handshake (so the real cost is higher, which the multiple's margin covers).

## TODO

- In `rpc-deadline.ts`, split `connectionTimeoutMs` into an inbound-upgrade field (5 r, floor 10000) and a libp2p-dial field (10 r, floor 10000). Raise `addressDialTimeoutMs` to 10 r and `dialTimeoutMs` to 11 r. Replace the `NOTE:` above the multiples with the cold-path accounting. Update the round-trip list in the doc above the constants and the `MAX_LINK_ROUND_TRIP_MS` doc.
- In `createLibp2pNodeBase`, wire `inboundUpgradeTimeout` and `dialTimeout` to their own fields. Explicit `options.connectionManager.*` still wins.
- Update the `NodeOptions.connectionManager` and `NodeOptions.linkRoundTripMs` docs. The round-trip doc should say that the dialer→relay leg is bounded by the declared value, an overestimate taken because it is the only number available.
- Update `link-deadlines.spec.ts`, and add the cold-relay spec described above.
- Plugin: derive `NetworkTransactor` `timeoutMs` from the dial deadline with the 30 s floor, then update both `NOTE:`s. Check the reference peer for the same pattern.
- Docs: the db-p2p readme *Slow relayed links* paragraph and table (warm 4 r, cold up to about 10 r, the new rows), and the `cluster.md` "about four more" sentence plus the read-path tripwire.
- Run `yarn build`, then from `packages/db-p2p` run `yarn test -- --grep "resolveLinkDeadlines|cold relayed|addressDialTimeout|stream"`, then the full db-p2p and plugin suites, `yarn lint`, `yarn lint:docs` and `yarn typecheck`.

## After release

Ship this with `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout` and `the-rpc-dial-deadline-cannot-be-set-per-node` if possible. Tell sereus-ec the version and the new multiples (cold open 10 r, RPC dial 11 r), and that application admission time is not modelled: it adds its gates on top through the explicit overrides.
