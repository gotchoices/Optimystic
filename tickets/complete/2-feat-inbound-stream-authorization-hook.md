---
description: Applications embedding this library can now supply a single check that decides which peers are allowed to send database requests to their node; without one, nothing changes. A peer that fails the check is cut off before its request is read.
files: packages/db-p2p/src/inbound-authorization.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/test/inbound-stream-authorization.spec.ts, packages/db-p2p/test/inbound-stream-authorization-node-wiring.spec.ts, docs/internals.md, docs/architecture.md, packages/db-p2p/docs/repo.md, packages/db-p2p/readme.md
---

# Complete: optional inbound-stream authorization hook on the four database services

Implemented in `0919e55`; reviewed and amended in this pass.

## What shipped

An optional, embedder-supplied predicate that decides whether a remote peer may open one of the
four Optimystic database protocols on this node, consulted as the first statement of each inbound
handler — before any frame is decoded and before any operation executes.

```ts
export type AuthorizeInboundStream =
	(remotePeerId: string, protocol: string) => Promise<boolean> | boolean;
```

One node-level option, `createLibp2pNode({ authorizeInboundStream, authorizeInboundStreamTimeoutMs })`,
folded into a single `inboundAuthorization` slice in `libp2p-node-base.ts` and spread into all four
service factory inits. Each service also accepts it in its own init (all four inits extend
`InboundStreamAuthorizationInit`) so they stay independently testable.

| Service | Gate call site |
|---|---|
| repo | `packages/db-p2p/src/repo/service.ts:287` |
| cluster | `packages/db-p2p/src/cluster/service.ts:224` |
| sync | `packages/db-p2p/src/sync/service.ts:84` |
| block-transfer | `packages/db-p2p/src/cluster/block-transfer-service.ts:134` |

Semantics: absent predicate → the original code path, no await and no allocation
(`createInboundStreamAuthorization` returns `undefined` and every handler guards on the field).
Supplied predicate → fail closed: only a literal `true` allows; `false`, a synchronous throw, a
rejection, a predicate that does not settle inside the deadline (default 5 s), and an inbound
connection with no resolvable remote peer id all deny. Denial aborts the stream with a typed
`UnauthorizedInboundStreamError` (`code === 'ERR_INBOUND_STREAM_UNAUTHORIZED'`) and writes no
protocol-level error frame — the remote sees a stream reset, indistinguishable from a transport
fault, while the denying node logs peer id, protocol and reason.

Two questions the implement pass answered rather than assumed, both confirmed in review:

- **No protocol multiplexes several operations onto one stream** — every handler's generator
  `return`s after the first response, so per-stream authorization is per-operation.
- **Self-dials never reach these handlers** — libp2p refuses to dial self, and every internal
  caller short-circuits self before dialling. A predicate that only knows remote members will not
  deny its own node.

## Review findings

### Checked and clean

- **The gate itself** (`inbound-authorization.ts`). `Promise.race` subscribes to the predicate
  promise, so a predicate that rejects *after* the deadline fires does not become an unhandled
  rejection. The deadline timer is always cleared in `finally`. A synchronous predicate skips the
  timer entirely. `typeof verdict === 'boolean'` plus the `decision === true` comparison means no
  truthy non-boolean can be read as consent.
- **Fail-closed is real, not asserted.** Every denial test checks the underlying repo/cluster mock
  executed nothing *and* that no response byte was written — not merely that an error surfaced.
- **Handler-signature widening.** `SyncService.handleSyncRequest` and the `BlockTransferService`
  registrar callback now take libp2p's second positional argument. Verified against
  `@libp2p/interface@3.1.0`'s `StreamHandler`: `(stream: Stream, connection: Connection)`. Correct.
- **Wiring has one site.** `repoService`/`clusterService`/`syncService`/`blockTransferService` are
  constructed in exactly one place outside tests (`libp2p-node-base.ts`), and all three node
  factories (`libp2p-node.ts`, `libp2p-node-rn.ts`, browser) pass `NodeOptions` through whole, so
  no factory can silently miss the option.
- **Is the database surface actually closed?** Audited every `registrar.handle` / `node.handle` in
  `packages/db-p2p/src`. The reactivity (`notify-transport`, `push-state-gossip`) and cohort-topic
  handlers touch no repo, so they are not a bypass. `dispute` is the one exception — see below.
- **Full workspace `yarn lint` and `yarn test` pass** (root, exit 0; `packages/db-p2p`
  1421 passing / 41 pending / 0 failing).

### Minor — fixed in this pass

- **`BlockTransferService` denials went to a different log sink than the other three.** It had no
  injectable component logger, so its authorization diagnostics landed on the module-level
  `debug` logger while repo/cluster/sync used `components.logger.forComponent(...).error`. For a
  security control that is exactly the "secured three surfaces, missed the fourth" shape the design
  was built to avoid. Added an optional `logger` to `BlockTransferServiceComponents`, threaded
  `components.logger` from the node factory, and removed the spec's exclusion — the "throw is
  logged" and "denial is logged" assertions now cover all four services.
- **The docs listed the ungated protocols and omitted `dispute`.** `docs/internals.md` § Scope and
  the `NodeOptions.authorizeInboundStream` doc comment both enumerated the surfaces this hook does
  *not* cover and left `dispute` out, which reads as coverage. Both now name it explicitly.
- **No doc connected this hook to the existing `connectionGater` option.** They are the two ways an
  embedder refuses a peer and they operate at different layers. Added a sentence to
  `docs/internals.md` and the `NodeOptions` comment stating the relationship: the gater decides
  whether to talk to a peer at all, this hook decides whether an already-connected peer may touch
  the database.
- **The protocol-id inventory an external peer-builder reads said nothing about the gate.**
  `packages/db-p2p/docs/repo.md` § Protocol id conventions is where someone building a foreign peer
  looks up the exact strings; a gated node resets their database dials while `identify` and `ping`
  keep working, which reads as a protocol-id mismatch. Added a paragraph naming the four gated ids
  and that symptom.
- **Test gap: nothing showed what a *dialing client* ends up with.** The per-service cases drive
  handlers with a scripted mock stream, which proves the server executes nothing but says nothing
  about the caller. Added two tests running a real `BlockTransferClient` against a real
  `BlockTransferService` over a linked duplex pair: an authorized pull still round-trips the block
  intact with the gate installed (the gate does not disturb the framing), and a denied pull rejects
  the caller promptly rather than hanging until its response deadline. `packages/db-p2p` went
  40 → 44 authorization tests.

### Checked, deliberately not changed

- **Denial logging is debug-namespaced.** `@libp2p/logger`'s `.error` is `debug('<name>:error')`, so
  denials are invisible without `DEBUG=optimystic:*`. The implement handoff flagged this as "worth a
  decision". Leaving it: it is the uniform convention for every error in this package, and an
  embedder that wants denial telemetry already owns the predicate and can record its own refusals.
  The narrow residue — timeout and unidentifiable-remote denials, which the predicate never sees —
  is not worth diverging the package's logging convention for. Revisit if an embedder asks.
- **The 5 s default deadline is unmeasured.** Still true, still documented, still overridable per
  node. No measurement to replace it with until an embedder's predicate is wired.
- **`authorizeInboundStreamTimeoutMs: 0` / negative / `NaN` is not validated.** `?? DEFAULT` only
  catches `undefined`, so a nonsense value yields a near-zero deadline that denies every async
  predicate. That is fail-closed and logged with the deadline in the message, so it is loud rather
  than silent; adding a clamp would mask the embedder's typo instead of surfacing it.
- **`index.ts` re-exports `InboundStreamAuthorization` and `createInboundStreamAuthorization`**,
  which are implementation detail rather than embedder API. Harmless and additive; narrowing it
  would mean breaking `index.ts`'s uniform `export *` convention for one module.
- **No test drives concurrent inbound streams against the gate.** The gate holds no per-peer or
  per-stream state — each call constructs its own timer and verdict — so there is nothing to race.
  Reasoning, not a test, as the handoff said; the new real-client round trip narrows the untested
  gap enough that a concurrency harness is not worth its flakiness.

### Major — new ticket filed

- **The `dispute` protocol is an ungated fifth surface of the same shape.**
  `packages/db-p2p/src/dispute/service.ts` is structurally identical to `cluster/service.ts` — same
  registrar registration, same one-request-per-stream handler — and answering it makes this node
  produce a *signed vote* on a challenge. Any peer that can connect can still ask for one after the
  database surfaces are closed. Whether to gate it is a scope decision (a legitimate dispute report
  may come from a peer the embedder never admitted), so it is filed rather than folded in:
  `tickets/backlog/feat-authorize-dispute-protocol-streams.md`.

### Tripwires recorded

- **Denial is stateless and unthrottled.** A refused peer can reopen streams as fast as libp2p's
  per-connection `maxInboundStreams` allows, and nothing records the refusal. Fine while the
  predicate is an in-memory lookup; if a denied peer ever shows up as load the fix is upstream of
  this module (feed denials into `PeerReputationService`, or refuse at the connection level with
  `connectionGater`). Parked as a `NOTE:` in the `inbound-authorization.ts` module doc.

### Test failures

- One **intermittent** failure surfaced on the first full `packages/db-p2p` run, on a clean tree
  before any review edit: `test/mesh-sanity.spec.ts:143`, "a lone uncorroborated holder must not
  repair a reader". It passed on three subsequent full runs and always passes in isolation. It is
  read-repair corroboration behavior from the `5571181` / `d31be12` chain, which landed *after* this
  ticket's commit, and `mesh-sanity.spec.ts` configures no predicate so no gate object is
  constructed on that path. Recorded in `tickets/.pre-existing-error.md` for the triage pass.
  Nothing was skipped, disabled, or loosened.

## Known limitations carried forward

- **Scope is the four database protocols.** The `dispute`, reactivity, matchmaking, cohort-topic and
  libp2p built-in protocols are not gated. Now stated in all three docs; the dispute half is ticketed.
- **A denied peer cannot tell "refused" from "network hiccup".** Deliberate, and the honest cost of
  not confirming membership state to an untrusted party. If a legitimate-but-not-yet-enrolled peer
  ever needs to back off intelligently, that needs a protocol-level error frame across three wire
  contracts — a separate, larger change.

## Downstream

The Sereus side can wire `(remotePeerId) => this.isAuthorizedMember(remotePeerId)` into its control-
network node. Its parked ticket is `control-repo-protocol-stream-authz-optimystic` in that repo's
`blocked/`; both answers it was waiting on are above.
