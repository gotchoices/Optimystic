----
description: Applications embedding this library can now supply a single check that decides which peers are allowed to send database requests to their node; without one, nothing changes. A peer that fails the check is cut off before its request is read.
files: packages/db-p2p/src/inbound-authorization.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/test/inbound-stream-authorization.spec.ts, packages/db-p2p/test/inbound-stream-authorization-node-wiring.spec.ts, docs/internals.md, docs/architecture.md, packages/db-p2p/readme.md
----

# Review: optional inbound-stream authorization hook on the four database services

## What was built

A new module, `packages/db-p2p/src/inbound-authorization.ts`, holding the whole seam:

```ts
export type AuthorizeInboundStream =
	(remotePeerId: string, protocol: string) => Promise<boolean> | boolean;

export interface InboundStreamAuthorizationInit {
	authorizeInboundStream?: AuthorizeInboundStream;
	authorizeInboundStreamTimeoutMs?: number;   // default DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS = 5_000
}

export class InboundStreamAuthorization {
	/** true ⇒ denied and the stream was aborted; the caller must return without decoding. */
	deny(stream, remotePeerId: string | undefined): Promise<boolean>;
}

export function createInboundStreamAuthorization(init, protocol, log): InboundStreamAuthorization | undefined;
```

`createInboundStreamAuthorization` returns **`undefined`** when the embedder supplied no predicate.
That is deliberate and load-bearing: each service stores `InboundStreamAuthorization | undefined` and
its handler guards on the field (`if (this.authorization && await this.authorization.deny(...)) return`),
so the absent-predicate case does not even reach an `await` — it is the original code path, not an
always-allow gate.

Wired into all four services' inits (each extends `InboundStreamAuthorizationInit`) and consulted as
the first statement of each inbound handler, before any decode:

| Service | Gate call site |
|---|---|
| repo | `packages/db-p2p/src/repo/service.ts:287` |
| cluster | `packages/db-p2p/src/cluster/service.ts:224` |
| sync | `packages/db-p2p/src/sync/service.ts:84` |
| block-transfer | `packages/db-p2p/src/cluster/block-transfer-service.ts:126` |

Node-level: `NodeOptions.authorizeInboundStream` / `NodeOptions.authorizeInboundStreamTimeoutMs`
(`libp2p-node-base.ts`) are folded once into a single `inboundAuthorization` slice and spread into all
four service factory inits. Spreading one object rather than repeating two option reads per service is
what makes "secured three surfaces, missed the fourth" structurally hard.

Two handler signatures had to widen to see the remote peer: `SyncService.handleSyncRequest` and the
`BlockTransferService` registrar callback now take libp2p's second positional argument
(`(stream, connection)` — confirmed against `@libp2p/interface`'s `StreamHandler`). `sync/service.ts`
also had `const actualStream = stream.stream ?? stream` hoisted out of the two places it was computed.

## Semantics implemented

- **Absent predicate → today's behavior exactly.** No check, no await, no allocation.
- **Fail closed.** Only a literal `true` allows. `false`, a synchronous throw, a rejected promise, a
  predicate that does not settle inside the timeout, *and* an inbound connection with no resolvable
  remote peer id all deny. There is no path from a failed check to executing the operation.
- **Errors are logged, never swallowed** — a throwing predicate logs `authorization predicate threw …`
  and every denial logs `inbound stream denied peer=… protocol=… reason=…`.
- **Denial surface (decision, applied to all four).** The stream is **aborted** with an
  `UnauthorizedInboundStreamError` (`code === 'ERR_INBOUND_STREAM_UNAUTHORIZED'`); no protocol-level
  error response is written. Reasons: (a) the four protocols have four different response shapes and no
  common error frame — only `cluster` has one (`__clusterError`), so a "protocol-level error" would mean
  changing three wire contracts and three client decoders; (b) telling an unauthorized peer *why* it was
  refused confirms membership state to exactly the party the embedder decided not to trust.
  **What the caller observes: a stream reset**, i.e. remotely indistinguishable from a transport fault —
  this is the honest cost of the choice and is documented as such. It is fully distinguishable on the
  *denying* node: logged with peer id/protocol/reason, and the abort reason is the typed, coded error.
- **Slow predicate**: bounded, default 5 s, expiry denies. A synchronous (non-promise) predicate skips
  the timer entirely.
- **Peer id encoding**: `connection.remotePeer.toString()` — libp2p base58btc/CIDv1 (`12D3KooW…`).
  Asserted twice: in unit tests against a generated `PeerId`, and end-to-end through real libp2p in the
  node-wiring spec.

## The two questions the ticket asked rather than assumed

**1. Does any of these protocols multiplex several logical operations onto one stream? No.**
All four are strictly one request → one response per stream; each handler's generator `return`s after
the first response, so a second frame a peer queued is never read or parsed:

- `packages/db-p2p/src/repo/service.ts:275-283` (`// One request per stream …` then `return`)
- `packages/db-p2p/src/cluster/service.ts:212-216`
- `packages/db-p2p/src/sync/service.ts:113-114`
- `packages/db-p2p/src/cluster/block-transfer-service.ts:152` (`return; // one request → one response per stream`)

So **per-stream authorization is exactly per-operation authorization**; the embedder's assumption holds.
Two caveats worth passing downstream, neither of which breaks that assumption:

- `RepoMessage.operations` is an *array*, but the handler executes `operations[0]` only
  (`repo/service.ts:254`). One operation per stream regardless of what the peer sends.
- A single operation may still name many block ids (`commit`/`pend` block lists, `pull`/`push`
  `blockIds`). The gate is a peer-level admission check, not a per-block ACL.

**2. Do self-dials / loopback / in-process short-circuits reach these inbound handlers? No.**
An embedder predicate that only knows about remote members will never deny its own node. Two
independent reasons:

- libp2p refuses to dial self at three layers, so a self-dial never produces an inbound stream:
  `node_modules/libp2p/dist/src/connection-manager/index.js:294` (`Can not dial self`),
  `…/connection-manager/dial-queue.js:261` (`Tried to dial self`), `…/upgrader.js:184`.
- Every internal caller short-circuits self *before* dialling anyway, so the local path is a direct
  in-process call that never touches a protocol handler:
  `packages/db-p2p/src/repo/cluster-coordinator.ts:113` (and `:452`, `:554`, `:740` — `isLocal` →
  `localCluster.update(...)` instead of a `ClusterClient` dial),
  `packages/db-p2p/src/libp2p-node-base.ts:812` (`clusterLatestCallback` reads `storageRepo` directly)
  and `:726` (`fetchArchiveFromPeer` returns undefined for self),
  `packages/db-p2p/src/storage/restoration-coordinator.ts:58,82`,
  `packages/db-p2p/src/cluster/spread-on-churn.ts:218`,
  `packages/db-p2p/src/cluster/reconcile-block.ts:129`.

## Testing

New: `packages/db-p2p/test/inbound-stream-authorization.spec.ts` (38 tests). The four services are
table-driven through one `ServiceCase` shape so every semantic is asserted against **all four**, not
against whichever was convenient. Per service: no predicate / `true` / `false` / throws / rejects /
never settles / unidentifiable remote / truthy-non-boolean verdict. Every denial assertion checks the
**underlying repo or cluster mock executed nothing** (`executions() === 0`) *and* that no response was
written — not merely that an error surfaced. Denial aborts are matched against
`UnauthorizedInboundStreamError` + its code + the protocol name, so a decode fault cannot be mistaken
for a denial. Logging is asserted for repo/cluster/sync (see gap below).

New: `packages/db-p2p/test/inbound-stream-authorization-node-wiring.spec.ts` (2 tests). Two real libp2p
nodes over loopback TCP: B dials A once per protocol, and A's single node-level predicate must be
consulted for **each of the four protocol ids, asserted individually** (the failure message names which
surface was missed) with B's `PeerId.toString()`. A precondition asserts A actually serves all four
protocols first, so a missing observation is a missing *gate*, not a missing handler. Second test: a
node with no option still registers all four protocols. Runs in ~250 ms.

Existing tests construct these services without the option and are unaffected — `inbound-message-caps`,
`cluster-error-propagation`, `block-transfer-*` all still pass, including the ones that invoke the
sync/block-transfer handlers with the stream only and no connection argument.

```
packages/db-p2p  before: 1361 passing, 41 pending, 0 failing
packages/db-p2p  after:  1401 passing, 41 pending, 0 failing   (= 1361 + 38 + 2)
root yarn lint:  exit 0
root yarn build: exit 0
```

## Known gaps — treat these as the starting point, not the finish line

- **`BlockTransferService` has no injectable component logger.** Its authorization diagnostics go to the
  module-level `optimystic:db-p2p:block-transfer-service` debug logger, unlike the other three which use
  `components.logger.forComponent(...).error`. Consequence: the "throw is logged" assertion covers three
  of four services; block-transfer's *denial* is asserted but its *log line* is not. Fixing this means
  adding `logger` to `BlockTransferServiceComponents` and threading it in `libp2p-node-base.ts` — small,
  but it changes a component interface, so it was left out of this change deliberately.
- **All denial logging is debug-namespaced.** `@libp2p/logger`'s `.error` is `debug('<name>:error')`, so
  denials are invisible without `DEBUG=optimystic:*,libp2p:*` — the same as every other error in these
  services, but arguably wrong for a security control. Worth a decision, not silently inherited.
- **Remote observability.** By design a denied peer sees only a stream reset. If the embedder ever wants
  a legitimate-but-currently-unauthorized peer (mid-enrollment, say) to be able to tell "refused" from
  "network hiccup" and back off accordingly, that needs a protocol-level error frame and is a separate,
  larger change across three wire contracts.
- **Scope is the four database protocols only.** The same node also registers reactivity, matchmaking,
  cohort-topic and dispute protocols plus the libp2p built-ins; none is gated by this option. Documented
  in `NodeOptions.authorizeInboundStream` and `docs/internals.md`, but the downstream embedder should
  read it as "this closes the database surface", not "this closes the node".
- **The 5 s default timeout is a guess.** No measurement backs it. An embedder whose predicate genuinely
  needs longer gets silent (well, logged) denials. It is overridable per node; the default may want
  revisiting once the Sereus side is wired.
- **No test drives a real *authorized* operation end-to-end over libp2p** (predicate returns `true`, real
  repo `get` completes across two nodes). The allow path is covered at the unit level for all four
  services and the node-level spec covers the deny path over real sockets; a real allow-path round trip
  would be strictly stronger.
- **No coverage of predicate behavior under concurrent inbound streams** (e.g. 32 simultaneous streams on
  one connection, `maxInboundStreams`). The gate is stateless per stream so there is nothing shared to
  race, but that is reasoning, not a test.

## Downstream

The Sereus side can now wire `(remotePeerId) => this.isAuthorizedMember(remotePeerId)` into its control-
network node only. Its parked ticket is `control-repo-protocol-stream-authz-optimystic` in that repo's
`blocked/`. Both answers it was waiting on are in "The two questions" above.
