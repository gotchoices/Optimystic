description: Add the server side of "who can do this job?" — let a peer answer a matchmaking query over a real network connection by reading the providers its cohort already holds and signing the reply.
prereq:
files:
  - packages/db-p2p/src/matchmaking/query-handler.ts
  - packages/db-p2p/src/matchmaking/query-transport.ts (new)
  - packages/db-p2p/src/matchmaking/protocols.ts (new)
  - packages/db-p2p/src/matchmaking/index.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/cohort-topic/stream-util.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
difficulty: hard
----

# Matchmaking `QueryV1` RPC — cohort serve side over real libp2p

## Why this exists

This is the **server half** of the seeker query transport (the seeker/client half is the prereq-linked
follow-on `matchmaking-query-rpc-seeker-walk`). The real-libp2p e2e tier
(`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`) confirmed a provider can register on a
real cohort and the record replicates over `/cohort-gossip`, but **no production RPC lets a remote peer read
that provider set**: `handleMatchmakingQuery` (`matchmaking/query-handler.ts`) is a pure, fully-injected
function with no production dialer or socket handler. The mock harness
(`src/testing/matchmaking-mesh-harness.ts` `queryCohort`) calls it in-process; production has nothing.

This ticket lands the standalone `QueryV1` → `QueryReplyV1` RPC handler on a live node, reading from the
cohort engine's already-replicated registration store. It is independently testable (dial the protocol
directly, assert the reply) without the seeker walk client.

## Design (resolved)

### Layering: own protocol family, registered at the composition root — not inside `host.ts`

The ticket's parenthetical suggested registering the handler "in `host.ts`". **Do not.** `host.ts` is the
generic cohort-topic substrate; matchmaking sits *above* it and `handleMatchmakingQuery` depends on
`decodeMatchAppPayload` (a matchmaking concern). Wiring the handler into `host.ts` would invert the layering
(cohort-topic → matchmaking). Instead mirror the **reactivity** precedent exactly: reactivity registers its
own protocol family (`DEFAULT_REACTIVITY_PROTOCOLS`) in the `cohortEnabled` block of `libp2p-node-base.ts`,
using only the host's *public* surface (`host.registry.findServing`, `host.service.verifier()`, etc.).

- New `packages/db-p2p/src/matchmaking/protocols.ts`:
  ```ts
  export const MATCHMAKING_BASE = "/optimystic/matchmaking/1.0.0" as const;
  export const PROTOCOL_MATCHMAKING_QUERY = `${MATCHMAKING_BASE}/query` as const;
  export interface MatchmakingProtocols { readonly query: string; }
  export const DEFAULT_MATCHMAKING_PROTOCOLS: MatchmakingProtocols = { query: PROTOCOL_MATCHMAKING_QUERY };
  export function makeMatchmakingProtocols(networkName = "default"): MatchmakingProtocols { ... }
  ```
  Use the **network-agnostic** default in node-base (the host itself is registered network-agnostic — see
  node-base `createCohortTopicHost` call passes no `protocols`, and the integration test dials
  `DEFAULT_COHORT_TOPIC_PROTOCOLS.gossip` directly). Reactivity does the same with
  `DEFAULT_REACTIVITY_PROTOCOLS`.

### Expose the cohort's live traffic snapshot on `CoordEngine` (the one host.ts change)

`handleMatchmakingQuery` needs a `topicTraffic: TopicTrafficV1`. The cohort engine already computes this:
`createTrafficCounters(...).snapshot(topicId)` is a **non-mutating** gossip-derived read (own last-published
counts + siblings' last-gossiped summaries + `directParticipants` from the store). It is currently internal.
Add a read accessor to the `CoordEngine` interface and its implementation in
`createCoordEngine` (`host.ts`):

```ts
/** This cohort's current gossip-derived traffic barometer for `topicId` (the matchmaking QueryV1 reply
 *  attaches it; the seeker hang-out decision consumes it). Non-mutating; lags <= one gossip round. */
topicTraffic(topicId: Uint8Array): TopicTrafficV1;
```
Implement as `(topicId) => traffic.snapshot(topicId)`. This is an in-layer change (cohort-topic exposing
its own existing state); it introduces **no** matchmaking dependency in `host.ts`. `records(topicId)` and
`cohort()` are already exposed.

### Serve handler (`matchmaking/query-transport.ts`, new)

`registerMatchmakingQueryHandler(node, protocol, deps)` using the existing
`stream-util.handleRequestResponse` (read one bounded frame → reply one frame). `deps`:

- `registry: CoordRegistry` (from `host.registry`)
- `addressing: ReturnType<typeof createTierAddressing>` (build one from `createTierAddressing(new RingHash())`
  — byte-identical to the host's internal one and to the reactivity wiring's `reactivityAddressing`)
- `sign: (payload: Uint8Array) => Promise<string>` — the node peer-key signer
  (`async p => bytesToB64url(await signPeer(nodePrivateKey, p))`, the same pattern node-base already has the
  key for).
- `maxBytes`

Handler body:
1. `const query = decodeQueryV1(frame, maxBytes)` (db-core `decodeQueryV1` = `validateQueryV1(decodeCohortMessage(...))`).
2. `const topicId = b64urlToBytes(query.topicId)`.
3. Resolve the serving tier-0 engine: `const coord0 = addressing.coord0(topicId);
   const engine = registry.findServing(topicId, 0) ?? registry.findByCoord(coord0);`
   - **Matchmaking serves a single tier-0 cohort** (the cohort-topic single-tier-0 milestone; a *serving*
     tier-`d>=1` query is gated on the promotion follow-ons, mock-tier-tagged-unimplemented exactly as the
     walk is). `findServing(topicId, 0)` keys on `treeTier === 0 && servesTopic(topicId)`, which is true on
     the routed primary once it has admitted/replicated a registration. `findByCoord(coord0)` is the
     fallback for an instantiated-but-currently-recordless engine.
4. If `engine === undefined` → **return `undefined`** (no reply frame; do **not** instantiate an engine on
   an inbound query — that would be a DoS amplifier). The client maps a no-reply to a benign empty result
   (specified in the seeker ticket).
5. Else build the reply via the pure handler:
   ```ts
   const reply = await handleMatchmakingQuery(query, {
     records: engine.records(topicId),
     topicTraffic: engine.topicTraffic(topicId),
     cohortEpoch: engine.cohort().cohortEpoch,
     sign,
     log,
   });
   return encodeQueryReplyV1(reply, maxBytes);
   ```
   `handleMatchmakingQuery` already: decodes each record's `appState` via `decodeMatchAppPayload` (skipping
   undecodable records with a log, never failing the reply), classifies provider vs seeker, runs the pure
   db-core `evaluateQuery` (capability filter + `limit` truncation + entry building, forwarding each
   provider's `registrationSig`), and single-member-signs the canonical `queryReplySigningPayload` with the
   node key.

**Per-coord scoping** is preserved: the reply is built from exactly the `coord_0(topicId)` engine's store,
nothing cross-coord — matching how the register handler recomputes a served coord per frame.

**Re-validation contract (the spec'd acceptance):** the *seeker* re-validates each returned entry's
`registrationSig` (`verifyProviderEntry`); the cohort serve side does **not** need to re-verify, but a forged
shard entry that somehow landed in the store is already dropped seeker-side. The serve handler must NOT
fabricate or alter `registrationSig` — it forwards `rec` fields verbatim through `evaluateQuery`. (A test in
the seeker ticket asserts a forged entry is dropped end-to-end.)

### Node-base wiring (`libp2p-node-base.ts`, inside `if (cohortEnabled)`)

After the host is constructed (it already has `nodePrivateKey`, `fret`, and builds a `reactivityAddressing`
via `createTierAddressing(createRingHash())`), register the query handler. Reuse the existing
`reactivityAddressing` (or build a `matchmakingAddressing` the same way) and the node key signer pattern
already present for reactivity. Mirror the reactivity registration site (around node-base:836-942). Nothing
else (the seeker session is exposed via the prereq follow-on's client-transport factory).

### Anti-DoS coordination

`tickets/backlog/matchmaking-query-rate-limit` owns the per-peer query rate gate. **Do not duplicate it
here.** Leave a single clearly-marked seam in the serve handler (e.g. an optional
`gate?: (from: PeerId, topicId: Uint8Array) => boolean` dep that defaults to allow) so the rate-limit ticket
slots a limiter in without reshaping the handler. The dialing peer is available as `from` in the
`handleRequestResponse` callback — gate on **`from`** (the connection's verified `remotePeer`), not on the
self-asserted `query.requesterId`. Note this in a comment.

## TODO

- Add `topicTraffic(topicId): TopicTrafficV1` to the `CoordEngine` interface and its `createCoordEngine`
  implementation (`host.ts`), delegating to the internal `traffic.snapshot`. Confirm `TopicTrafficV1` is
  already imported in `host.ts` (it is, via the db-core type imports — add if not).
- Create `matchmaking/protocols.ts` (`DEFAULT_MATCHMAKING_PROTOCOLS` + `makeMatchmakingProtocols`).
- Create `matchmaking/query-transport.ts` with `registerMatchmakingQueryHandler(node, protocol, deps)` and a
  typed `MatchmakingQueryServeDeps`. Export both from `matchmaking/index.ts`.
- Wire the handler registration into the `cohortEnabled` block of `libp2p-node-base.ts`, mirroring the
  reactivity registration. Leave the rate-limit gate seam (default-allow) commented for
  `matchmaking-query-rate-limit`.
- Add a gated integration test to `substrate-real-libp2p.integration.spec.ts` (a NEW `it`, sibling to the
  provider-replication test §5): a provider registers + replicates on a real cohort, then a remote node
  **dials `DEFAULT_MATCHMAKING_PROTOCOLS.query`** on the routed primary with an encoded `QueryV1` and asserts
  the decoded `QueryReplyV1` carries the provider entry with a forwardable `registrationSig` and a present
  `topicTraffic`. (Use `requestResponse(remote.node, primary.peerId, protocol, encodeQueryV1(q), maxBytes)`;
  build `q` like the mock harness `queryCohort` does — `includeProviders: true`, `signature: 'AA'`.)
- `yarn build` (db-p2p) and `yarn test` (db-p2p, unit) must stay green. The new coverage is env-gated; run it
  once with `OPTIMYSTIC_INTEGRATION=1 yarn test:integration 2>&1 | tee /tmp/mm-serve.log` to confirm, but the
  default `yarn test` is the gating validation (real-FRET stabilization at small N can be timing-sensitive —
  if the gated run is flaky, document it in the review handoff rather than chasing it).

## Edge cases & interactions

- **No serving engine on the dialed node** (seeker dialed a non-primary / pre-replication): return no reply
  frame; never instantiate a `CoordEngine` from a query (DoS). The seeker side treats this as an empty
  advisory result.
- **Engine present but holds zero records** (cold probe): `handleMatchmakingQuery` returns a valid signed
  reply with no `providers`/`seekers` array — correct (advisory empty).
- **Undecodable `appState` record in the store** (a non-matchmaking record sharing the cohort): already
  skipped-with-log inside `handleMatchmakingQuery`; the reply still succeeds. Cover with a record whose
  `appState` is non-matchmaking bytes.
- **`includeSeekers` / capability `filter` / `limit` truncation:** delegated to the pure `evaluateQuery`;
  the serve handler must pass `query` through unchanged (don't re-clamp `limit` — `validateQueryV1` already
  bounds it to `QUERY_LIMIT_MAX`).
- **Signature image stability:** the reply is signed over `queryReplySigningPayload` (epoch + truncated flag
  + traffic tuple + ordered participant ids). Do not reorder providers after signing; `handleMatchmakingQuery`
  signs the final `unsigned` shape, so encode it verbatim.
- **Self-dial:** not exercised on the serve side (a node never dials its own `/query`); the seeker ticket
  owns the self-routed-primary short-circuit.
- **`maxBytes`:** use the host's frame ceiling (`DEFAULT_STREAM_MAX_BYTES`) consistently on encode/decode so
  a large provider set frames identically to the cohort-topic family.
- **Concurrent gossip round vs. query:** `traffic.snapshot` and `store.listByTopic` are synchronous reads
  over the same in-memory state the gossip round mutates; a query interleaved with a `gossipRound` sees a
  consistent point-in-time store (no await between read and use). No locking needed, but do not hold the
  records array across an await before signing (build the reply from a single synchronous read, which
  `handleMatchmakingQuery` does).
