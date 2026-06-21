description: Review the new server-side feature that lets one peer answer another peer's "who can do this job?" matchmaking question over a real network connection, returning the providers its group already knows about.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/matchmaking/protocols.ts
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/matchmaking/index.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
difficulty: hard
----

# Review: Matchmaking `QueryV1` RPC — cohort serve side over real libp2p

## What landed (implement summary)

The **server half** of the seeker query transport. Before this change, `handleMatchmakingQuery`
(`matchmaking/query-handler.ts`) was a pure, fully-injected function with no production socket handler — the
mock harness called it in-process, production had nothing. This ticket lands a standalone `QueryV1` →
`QueryReplyV1` RPC on a live node, reading from the cohort engine's already-replicated registration store.

Five changes, all matching the resolved design in the source ticket:

1. **`host.ts` — one new read accessor.** Added `topicTraffic(topicId): TopicTrafficV1` to the `CoordEngine`
   interface and its `createCoordEngine` impl, delegating to the engine's internal
   `traffic.snapshot(topicId)` (non-mutating; own last-published counts + siblings' gossiped summaries +
   live `store.directParticipants`). Added the `TopicTrafficV1` type import (it was **not** already
   imported, contrary to the ticket's parenthetical — verify the import line). This is the only `host.ts`
   change and it exposes cohort-topic's own existing state — **no** matchmaking dependency is introduced
   into the substrate.

2. **`matchmaking/protocols.ts` (new).** `MATCHMAKING_BASE = "/optimystic/matchmaking/1.0.0"`,
   `PROTOCOL_MATCHMAKING_QUERY = .../query`, `DEFAULT_MATCHMAKING_PROTOCOLS`, `makeMatchmakingProtocols`,
   `matchmakingProtocolList`. Mirrors the cohort-topic / reactivity protocol-family precedents verbatim.

3. **`matchmaking/query-transport.ts` (new).** `createMatchmakingQueryHandler(deps)` (the testable callback)
   + `registerMatchmakingQueryHandler(node, protocol, deps)` (the `node.handle` wrapper, via the existing
   `stream-util.handleRequestResponse`). `MatchmakingQueryServeDeps = { registry, addressing, sign, gate?,
   maxBytes? }`. Handler flow: `decodeQueryV1` (bounded) → optional `gate` → resolve serving tier-0 engine
   via `registry.findServing(topicId, 0) ?? registry.findByCoord(coord_0(topicId))` → if none, **no reply**
   → else build the reply through the pure `handleMatchmakingQuery` and `encodeQueryReplyV1`. Mirrors the
   reactivity `recover-transport.ts` structure (create-handler + register).

4. **`libp2p-node-base.ts` — wiring.** Inside the `cohortEnabled` block, after the reactivity wiring,
   registers the handler over `DEFAULT_MATCHMAKING_PROTOCOLS.query`, reusing the existing
   `reactivityAddressing` (`createTierAddressing(createRingHash())` — byte-identical at the tier-0 coord) and
   a node-peer-key signer (`bytesToB64url(await signPeer(nodePrivateKey, payload))`). Added
   `node.unhandle(matchmakingProtocolList(...))` to the existing teardown wrapper. Exports added to
   `matchmaking/index.ts`.

5. **Integration test (new `it`, §5b).** `substrate-real-libp2p.integration.spec.ts`: a provider registers
   with a real matchmaking app payload on the routed primary's real cohort, a **remote** node dials
   `DEFAULT_MATCHMAKING_PROTOCOLS.query` over a real socket, and the decoded `QueryReplyV1` is asserted to
   carry the provider entry, a **forwardable `registrationSig`** (re-validated end-to-end with
   `verifyProviderEntry` + `verifyPeerSig`), and a present `topicTraffic`. Also asserts the **no-reply**
   (0-byte frame) path for an unserved topic. The previously-skipped "seeker walk converges" test had its
   note updated — its remaining gap is the *outbound* seeker walk client, not the serve RPC.

## Validation done

- `yarn build` — **green** for both `db-core` and `db-p2p` (tsc, no errors).
- `yarn test` (db-p2p unit, the gating validation) — **992 passing, 31 pending**. (The
  `cohort-topic cold-start: parent registration ... Error: parent unreachable` line in the output is an
  expected in-test logger message from a passing cold-start test, not a failure.)
- `OPTIMYSTIC_INTEGRATION=1 ... --grep "matchmaking QueryV1 RPC"` — **1 passing** over real TCP/libp2p +
  real FRET stabilization (the new §5b). Ran scoped to keep wall-time down; the `before` boots the full
  N-node mesh.

No `tickets/.pre-existing-error.md` was written — nothing surfaced that wasn't mine.

## Use cases / what to scrutinize during review

**Primary happy path (covered by §5b):** provider registers → record (with decodable matchmaking `appState`)
lands + replicates → remote dials `/query` → reply carries the provider entry with a `registrationSig` the
seeker re-validates, plus the cohort's `topicTraffic` snapshot and a non-empty single-member reply signature.

**Edge cases to confirm the reviewer agrees are handled (per the source ticket's matrix):**
- **No serving engine on the dialed node** (non-primary / pre-replication): returns **no reply frame**; the
  handler must **never** instantiate a `CoordEngine` from an inbound query (DoS amplifier). Asserted in §5b
  via the unserved-topic 0-byte-frame check. *Worth a careful read of the `findServing ?? findByCoord` line
  — confirm neither path can create an engine.*
- **Engine present, zero records** (cold probe): `handleMatchmakingQuery` returns a valid signed reply with
  no providers/seekers arrays. Not directly asserted in §5b (the engine always has the provider by then) —
  **a candidate for a reviewer-added inline assertion** (dial `/query` before the provider registers, or on
  an engine instantiated but record-free).
- **Undecodable `appState`** (a non-matchmaking record sharing the cohort): skipped-with-log inside
  `handleMatchmakingQuery`, reply still succeeds. **Not exercised by §5b** — the reactivity subscriber path
  produces such records, so a mixed-cohort assertion is a reasonable reviewer add (flagged as a test gap).
- **`limit` / `filter` / `includeSeekers`:** delegated unchanged to the pure `evaluateQuery`; the handler
  must pass `query` through verbatim (no re-clamp — `validateQueryV1` already bounds `limit` to
  `QUERY_LIMIT_MAX`). Confirm the handler does not mutate `query`.
- **Signature image stability:** the reply is signed over `queryReplySigningPayload` by the pure handler;
  the transport encodes the returned shape verbatim (no reordering after signing). Confirm.
- **Gate seam:** `gate?: (from, topicId) => boolean` defaults to allow; it gates on the connection's verified
  `from` (`handleRequestResponse` passes `connection.remotePeer`), **not** the self-asserted
  `query.requesterId`. Left unwired in node-base for `tickets/backlog/matchmaking-query-rate-limit`. Confirm
  the comment + the `from`-not-`requesterId` choice.

## Known gaps / honest flags (treat the tests as a floor)

- **Outbound seeker walk is the follow-on**, `matchmaking-query-rpc-seeker-walk`. This ticket only lands the
  serve side; the only production *client* of `/query` today is the gated test's direct dial. The
  seeker-walk-converges integration test stays `it.skip` (re-pointed to the seeker slug).
- **`queriesPerMin` is not incremented by this RPC.** `traffic.recordArrival` is wired (the register path),
  but `recordQuery` has **no production caller** anywhere in the repo — a pre-existing db-core posture, not
  introduced here. The matchmaking query RPC is the natural place to bump it, but `CoordEngine` exposes no
  `recordQuery` seam and the ticket scopes `topicTraffic` strictly as a *non-mutating* read. So a hot-query
  topic's `topicTraffic.queriesPerMin` will read 0 until a query-accounting seam lands. Worth a backlog note
  if the hang-out decision proves to need real query rates (coordinate with the rate-limit ticket, which
  already touches the per-peer query path).
- **Test coverage is thin on the non-happy branches** (cold-probe-empty-reply, undecodable-appState-skip) —
  see the edge-case list above. The unit-testable `createMatchmakingQueryHandler` was added precisely so
  these can be covered without a live stack; no such unit spec was added in this ticket (the gated e2e was
  the ticket's required coverage). A `test/matchmaking/query-transport.spec.ts` exercising those branches
  against a stub registry is the obvious reviewer/follow-up add.
- **Real-FRET small-N timing.** §5b passed cleanly on this run, but the suite header already documents that
  real-FRET stabilization at small N is timing-sensitive; the default `yarn test` (not the gated tier) is
  the gating validation, as the ticket specified.

## Suggested review focus order

1. `query-transport.ts` — the no-engine-no-instantiate guard and the verbatim `query` pass-through (the two
   correctness hinges).
2. `host.ts` — that `topicTraffic` is a pure delegate to `traffic.snapshot` and introduces no layering
   inversion / no await between read and sign.
3. `libp2p-node-base.ts` — the addressing reuse (byte-identical at coord_0) and teardown `unhandle`.
4. The edge-case test gaps above — decide minor-fix-inline (add the cold-probe + undecodable assertions)
   vs. spin a small follow-on for `query-transport.spec.ts`.
