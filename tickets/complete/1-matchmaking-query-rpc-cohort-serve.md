description: Reviewed and completed the server-side feature that lets one peer answer another peer's "who can do this job?" matchmaking question over a real network connection, returning the providers its group already knows about.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/matchmaking/protocols.ts
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/matchmaking/index.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/matchmaking/query-transport.spec.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - docs/matchmaking.md
----

# Complete: Matchmaking `QueryV1` RPC — cohort serve side over real libp2p

## What landed

The **server half** of the seeker query transport: a standalone `QueryV1` → `QueryReplyV1` RPC on a live
node (`/optimystic/matchmaking/1.0.0/query`), reading from the cohort engine's already-replicated
registration store and answering with the cohort's locally-held provider/seeker registrations.

- `cohort-topic/host.ts` — one new non-mutating read accessor `topicTraffic(topicId)` on the public
  `CoordEngine` interface, delegating to `traffic.snapshot(topicId)`. No matchmaking dependency enters the
  substrate.
- `matchmaking/protocols.ts` (new) — the matchmaking protocol family, mirroring the cohort-topic /
  reactivity precedents.
- `matchmaking/query-transport.ts` (new) — `createMatchmakingQueryHandler` (testable callback) +
  `registerMatchmakingQueryHandler` (the `node.handle` wrapper). Resolves the serving tier-0 engine off the
  live `CoordRegistry` (`findServing ?? findByCoord`, never `forCoord`), builds the reply via the pure
  `handleMatchmakingQuery`, and rides `handleRequestResponse`.
- `libp2p-node-base.ts` — wiring at the composition root inside `cohortEnabled`, reusing the reactivity
  addressing + a node-peer-key signer; teardown `unhandle` added.
- Tests — gated real-socket §5b in `substrate-real-libp2p.integration.spec.ts`, plus (added in review)
  `test/matchmaking/query-transport.spec.ts`.

## Review findings

### Checked

- **No-engine → no-reply DoS guard (correctness hinge).** Confirmed `registry.findServing` and
  `findByCoord` (`host.ts:1110`/`1121`) are pure lookups that never construct an engine; only `forCoord`
  constructs, and the serve path never calls it. Hardened by a unit test whose stub registry throws if
  `forCoord` is ever reached — the no-engine test passes, proving no instantiation.
- **Verbatim query pass-through.** The handler passes the decoded `query` straight to
  `handleMatchmakingQuery`/`evaluateQuery` with no re-clamp; `decodeQueryV1` already bounds `limit` to
  `QUERY_LIMIT_MAX` (256). Unit-tested via `limit=1` truncation and `includeSeekers`/`includeProviders`
  selection.
- **`topicTraffic` purity / layering.** Confirmed `traffic.snapshot` (`db-core/.../traffic.ts:123`) is
  non-mutating — it reads frozen `lastPublished` counts + siblings' gossiped summaries +
  `store.directParticipants`, mutating nothing. The new accessor is a one-line pure delegate; the
  `TopicTrafficV1` import was correctly added; no matchmaking symbol leaks into the substrate.
- **Wiring.** `reactivityAddressing = createTierAddressing(createRingHash())` is byte-identical at
  `coord0`; all symbols (`nodePrivateKey`, `signPeer`, `bytesToB64url`, `host.registry`) are in scope; the
  handler is registered inside `cohortEnabled` after reactivity and `unhandle`d in the existing teardown
  wrapper.
- **Gate seam.** `handleRequestResponse` passes `connection.remotePeer`, so the optional `gate` fires on
  the connection-verified `from`, **not** the self-asserted `query.requesterId`. Unit-tested explicitly
  (gate sees `remote-peer`, never the spoofed `requesterId: 'liar'`).
- **Signature image stability.** The reply is signed inside the pure handler over
  `queryReplySigningPayload(unsigned)`; the transport encodes the returned shape verbatim with no
  reordering after signing. Confirmed.
- **Protocols.** `protocols.ts` mirrors the reactivity/cohort-topic family verbatim (base, `query`,
  `DEFAULT_*`, `make*Protocols`, `*ProtocolList`).
- **Build + tests.** `db-core` build clean; `db-p2p` build exit 0; full `db-p2p` unit suite **1001
  passing, 31 pending, 0 failing** (was 992 — the +9 are the new transport spec). The
  `cohort-topic cold-start: parent unreachable` console line is the documented expected logger output of a
  passing antidos-coldstart test, not a failure.

### Found and fixed inline (minor)

- **Error-handling divergence from the reactivity precedent (`query-transport.ts`).** The handler wrapped
  only `decodeQueryV1` in try/catch; the post-decode steps (`handleMatchmakingQuery` → async `sign`,
  `encodeQueryReplyV1` → throws on an oversize reply) could throw and propagate, making
  `handleRequestResponse` **abort the stream** instead of producing the documented clean no-reply. The doc
  comment claimed "It never throws out of the stream handler" — which was false. The reactivity
  `recover-transport.ts` serve handler wraps its *whole* body. **Fixed:** wrapped the entire handler body
  in one try/catch (intentional no-replies — gate reject, no engine — stay as explicit `return undefined`
  inside; only true throws hit the catch, which logs + returns `undefined`). Updated the function-header
  doc to match. Regression-covered by the new "drops to no reply when the reply build fails" unit test
  (a rejecting signer now yields a clean no-reply).
- **Stale docs (`docs/matchmaking.md`).** §Real-libp2p e2e coverage and the §Seeker query implementation
  note still said "seeker query RPC deferred" and "a production node registers no `QueryV1` RPC handler" —
  both now false. **Fixed:** rewrote both to state the serve side is live (test 5b), document the
  `/query` protocol + the no-reply DoS guard, and re-scope the remaining deferral to the **outbound**
  seeker walk client (`matchmaking-query-rpc-seeker-walk`).
- **Test gap on the non-happy branches (implementer-flagged).** Added
  `test/matchmaking/query-transport.spec.ts` (9 tests against a stub registry/engine + real addressing):
  serving happy path, no-engine→no-reply + never-instantiate, gate-on-`from`-not-`requesterId`,
  cold-probe empty-but-signed reply, undecodable-`appState` skip, `limit` pass-through,
  `includeSeekers`/`includeProviders` selection, malformed-frame drop, and sign-failure→no-reply. These
  cover the cold-probe-empty and undecodable-appState cases the gated §5b could not cheaply reach.

### Found, filed as follow-on (major)

- **`topicTraffic.queriesPerMin` is structurally always 0.** `TrafficCounters.recordQuery` has **no**
  production caller anywhere in the repo, so every served `topicTraffic` reports zero query rate — the
  serve RPC attaches a barometer whose query-rate axis is dead. Pre-existing (not introduced here), but the
  matchmaking query RPC is the natural place to bump it, and the seeker hang-out decision
  (`docs/matchmaking.md` §Hang-out vs. continue) consumes that axis. `CoordEngine` exposes no `recordQuery`
  seam and this ticket scoped `topicTraffic` strictly read-only, so fixing it needs a new mutating seam —
  out of scope here. Filed `tickets/backlog/matchmaking-query-accounting-seam.md` (to coordinate with
  `matchmaking-query-rate-limit`, which already touches the per-peer inbound query path).

### Not re-run (with reason)

- The **gated integration test** (`OPTIMYSTIC_INTEGRATION=1`, §5b) was not re-run in this pass. It is
  timing-sensitive at small N (documented in the suite header), the implementer validated it once on the
  implement run, and my edits do not alter §5b's exercised happy path — the error-handling change is a
  strictly broader catch with identical happy-path behavior, plus a new unit file and doc edits. The
  ticket designates the default `yarn test` unit suite as the gating validation, which is green.

### Empty categories

- **No security findings** beyond the already-tracked unauthenticated-query rate-limit posture
  (`matchmaking-query-rate-limit`): the no-engine guard holds, the gate keys on the verified peer, and the
  serve side forwards `registrationSig` verbatim (re-validated seeker-side) without fabricating or altering
  it.
- **No new pre-existing test failures** surfaced; no `tickets/.pre-existing-error.md` written.

## Follow-on tickets

- `matchmaking-query-rpc-seeker-walk` — the outbound seeker walk client (the only remaining real-socket
  deferral; the serve RPC it queries is now live).
- `matchmaking-query-accounting-seam` (backlog, newly filed) — make `topicTraffic.queriesPerMin` real.
- `matchmaking-query-rate-limit` (backlog, pre-existing) — wires the default-allow `gate` seam.
