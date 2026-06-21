description: Review the new client side of matchmaking "who can do this job?" — the code that lets a peer search the network for service providers over real connections, plus the end-to-end test proving two separate nodes can find a match.
prereq: matchmaking-query-rpc-cohort-serve
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/test/matchmaking/query-transport-client.spec.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-p2p/src/testing/matchmaking-mesh-harness.ts
  - docs/matchmaking.md
difficulty: medium
----

# Review: matchmaking `QueryV1` RPC — seeker walk client over real libp2p

## What landed

The **client half** of the matchmaking seeker query transport, the production analogue of the in-process
mock harness. All new code is in `matchmaking/query-transport.ts` (which previously held only the serve
half); the matchmaking `index.ts` already wildcard-exports it, so no barrel change was needed.

### `createLibp2pMatchmakingTransport(deps): Libp2pMatchmakingTransport`

Returns the four seams `SeekerWalkClient` / `MatchmakingSeekerSession` consume over a live node:

- **`walkTransport(topicId)`** — a real-socket `SeekerWalkTransport`:
  - `register(treeTier)` builds a signed seeker `RegisterV1` (op-tier `Tier.T2`, `ttl ~10s`) and dials the
    FRET-routed primary's cohort-topic `/register` (`requestResponse`), decoding the `RegisterReplyV1` →
    `SeekerProbeReply` (pass `result`; copy `topicTraffic`/`targetTier` on accepted/promoted). **Tier-0 is a
    `bootstrap: true` T2 register and carries a self-vouch reputation endorsement** (the seeker peer-key-signs
    its own `bootstrapBoundImage` as referee, attached BEFORE the final `registerSigningPayload` sign) — the
    single most important detail, since a configured production node refuses an unvouched T2 bootstrap and the
    walk would never reach `accepted`. Tier-`d>0` is `bootstrap: false` (a plain walk step → `no_state`).
  - `query(treeTier)` encodes a `QueryV1` (`includeProviders: true`, `signature: 'AA'`, `limit:
    QUERY_LIMIT_MAX`), dials the **tier-0** primary's matchmaking `/query`, and decodes the reply. On a no-frame
    reply (the serve handler returns nothing for a topic it doesn't serve) or any dial/decode failure it
    resolves a **benign empty `QueryReplyV1`** (`providers: []`, zeroed traffic) so the walk continues instead
    of throwing. (The walk only ever reaches `query()` at the root in this milestone; `query` targets tier-0
    because the serve handler is tier-0-only — matching the mock harness.)
  - `renew()` / `withdraw()` are documented **no-ops** (mirror the mock harness): the seeker's query does not
    depend on its own seeker record, and the brief record TTL-expires. A real renew (a `RenewV1` ping) is a
    follow-on for long real hang-outs in multi-tier topologies.
- **`queryCohort(q)`** — one-shot: resolve `coord0(q.topicId)`'s primary, dial `/query`, decode (same empty
  fallback).
- **`estimateDMax(topicId)`** — `makeDMaxComputer({ estimator: new FretSizeEstimator(fret), F }).dMax()`. At
  small N the estimate is ~0, so the walk registers + queries at the root.
- **`verifyEntry`** — `verifyPeerSig(participantId, payload, sig)` (re-validates each forwarded
  `registrationSig` seeker-side).

Edge handling worth a reviewer's eye:
- **`node.services.fret` is a wrapper** that keeps the size-estimate engine behind a lazy `ensure()`. The
  factory auto-unwraps it (`resolveFretEngine`) so callers can pass `services.fret` directly. *This was the
  one bug found during implement — `getNetworkSizeEstimate is not a function` on the wrapper — fixed by the
  unwrap.* Worth confirming the unwrap is the right contract (vs. requiring callers to pre-resolve).
- **Self-routed primary**: if `assembleCohort(coord, k)[0] === selfPeerId`, libp2p can't dial self. Handled
  via an optional `selfServe` hook; absent ⇒ **throws a clear error** (loud, not a silent hang). The e2e
  seeker is deliberately remote, so this never fires there — it is covered only by the new unit test.

### `createLibp2pMatchmakingSeekerSession(deps): MatchmakingSeekerSession`

Thin convenience that wires the transport into `MatchmakingSeekerSessionDeps` so the public session layer is
driveable on a live node. **`sweepPorts` is intentionally left unbound** (the multi-cohort sweep needs the
promoted-tree aggregate-count RPC — a separate follow-on), so a live session is **walk-only**, the correct
single-tier-0 behavior.

## Use cases / how to validate

- **Build**: `cd packages/db-p2p && yarn build` → green (`tsc` exit 0).
- **Default unit suite** (`yarn test`): the new `test/matchmaking/query-transport-client.spec.ts` (8 tests)
  exercises the I/O-free branches the gated e2e cannot reach: `estimateDMax` wiring (F=16, clamp-to-0),
  `verifyEntry` round-trip + tamper rejection, empty-reply on no-primary, **self-primary throw** + `selfServe`
  routing (query AND register), `no_state` on a cold cohort, and the **tier-0 self-vouch bootstrap frame**
  shape (the test asserts `register(0)` produces a `bootstrap: true`, `tier: 2`, evidence-bearing frame).
  > NOTE: two default-suite tests fail intermittently under load — `mesh-lifecycle.spec.ts:118` (withdraw;
  > passes 3/3 alone) and `mesh-sweep.spec.ts` (30s timeout; passes alone ~20s). Both are **pre-existing,
  > orthogonal flakiness** (see `tickets/.pre-existing-error.md`) — `query-transport.ts` is not imported by the
  > mesh tests and the new unit file runs after them alphabetically.
- **Gated real-socket e2e** (`OPTIMYSTIC_INTEGRATION=1 yarn test:integration`): the flipped §5c
  (`substrate-real-libp2p.integration.spec.ts`), "a seeker hang-out walk queries real cohorts over real
  sockets and converges to a match (forged entries dropped)", **passes** (both full-suite and `--grep
  "converges to a match"`). It stands up a 4-node real-TCP mesh, seeds willingness, registers a genuine
  provider AND a **forged** provider (app-payload `registrationSig` over the wrong topic), then runs a real
  remote seeker walk to convergence and asserts: the genuine provider is matched; the forged one is **dropped
  by `verifyProviderEntry`** even though a raw `/query` shows the cohort served it (the advisory-trust
  contract end-to-end).

## Honest gaps / things to scrutinize

- **`createLibp2pMatchmakingSeekerSession` has no test.** It is type-checked + exported + compiled, but
  constructing it needs a live node, and the e2e drives the lower-level `SeekerWalkClient` + transport
  directly. A reviewer may want a session-level e2e (drive `session.walk(...)`), or accept the
  transport-level coverage as the floor.
- **File placement deviation**: the ticket's `files:` listed `module.ts`, but I put both new functions in
  `query-transport.ts` (next to the transport) to keep `module.ts` a pure db-core composition (so
  `module.spec.ts` stays decoupled from p2p-fret/libp2p). `module.ts` is unchanged. Confirm this is acceptable
  or move the session convenience into `module.ts`.
- **e2e drives the walk at `dMax: 0`** (the documented single-tier-0 milestone). `estimateDMax` is called and
  asserted shallow (`≤ 3`) but is not used to *drive* `dMax`, to avoid a self-dial flake at tier ≥ 1 (the e2e
  seeker doesn't wire `selfServe`, so a FRET-routed self-primary at a higher tier would throw). A reviewer
  could instead wire `selfServe` from the seeker's own host and drive from the real estimate to exercise the
  multi-tier walk-down — left as a hardening follow-on.
- **node-base is NOT changed** (per the ticket, optional): the serve handler is registered by the prereq; the
  client transport is constructed by callers. Consider whether to expose a `createLibp2pMatchmakingSeekerSession`
  factory off the node for app convenience.
- **`renew`/`withdraw` no-ops**: fine for the single-tier-0 milestone; a multi-tier walk with a long hang-out
  + escalation past the root would want a real `RenewV1` keep-alive (the seeker record would otherwise
  TTL-expire mid-walk). Follow-on.
- The hang-out *decision math* and the multi-cohort sweep stay mock-tier-/simulator-validated; this ticket
  only adds the real-socket walk transport. `docs/matchmaking.md` §Real-libp2p e2e coverage was updated to
  reflect the walk is now confirmed and the sweep remains the deferred piece.
