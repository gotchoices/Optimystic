description: The client side of matchmaking "who can do this job?" — a peer can now search the network for service providers over real connections — was reviewed, verified end-to-end, and accepted.
prereq: matchmaking-query-rpc-cohort-serve
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/test/matchmaking/query-transport-client.spec.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - docs/matchmaking.md
difficulty: medium
----

# Review complete: matchmaking `QueryV1` RPC — seeker walk client over real libp2p

The client half of the matchmaking seeker query transport (`createLibp2pMatchmakingTransport` /
`createLibp2pMatchmakingSeekerSession` in `query-transport.ts`) plus the gated real-socket §5c e2e.
The implementation is correct and well-factored; it matches the in-process mock harness's contract and
the prereq serve handler. **Accepted** with one minor coverage gap fixed inline and one deferred-scope
follow-on filed to backlog. No defects found.

## What landed (as built)

- `createLibp2pMatchmakingTransport(deps)` → the four seams `SeekerWalkClient` / `MatchmakingSeekerSession`
  consume over a live node: a real-socket `SeekerWalkTransport` (`register`/`query`/`renew`/`withdraw`),
  one-shot `queryCohort`, `estimateDMax`, and `verifyEntry`. Tier-0 register carries a self-vouch
  reputation endorsement so a configured production node admits the bootstrap; `query` targets tier-0
  (serve handler is tier-0-only); a no-frame / dial / decode failure maps to a benign empty reply; a
  self-routed primary throws loudly unless a `selfServe` hook is supplied.
- `createLibp2pMatchmakingSeekerSession(deps)` → wires the transport into the public session layer,
  walk-only (`sweepPorts` left unbound).

## Review findings

### Verification run (all green)
- **Build / type-check:** `yarn build` (`tsc`) exit 0 — the type gate (no separate lint is configured;
  root `lint` is a stub).
- **New unit suite:** `test/matchmaking/query-transport-client.spec.ts` — **9 passing** (8 original + 1
  added this pass, see below).
- **Full matchmaking suite:** `test/matchmaking/**/*.spec.ts` — **94 passing, 3 pending**, no regressions.
- **Gated real-socket e2e:** `OPTIMYSTIC_INTEGRATION=1 … --grep "converges to a match"` — **1 passing**
  (423 ms). Confirms a remote seeker walks real cohorts over real TCP, converges to the genuine provider,
  and drops a forged forwarded entry seeker-side (`verifyProviderEntry`) even though the raw `/query`
  served it — the advisory-trust contract end-to-end.

### Aspects scrutinized
- **Correctness / contract fidelity:** Confirmed `walkTransport.register` routes to the tier-`d` primary
  (`addressing.coord(d, seekerBytes, topicId)`) while `query` routes to tier-0 — consistent with the
  serve handler's tier-0-only scope and the mock harness. The tier-0 self-vouch evidence is attached to
  the register body *before* the final `registerSigningPayload` sign (so the participant signature covers
  it); `bootstrapBoundImage` binds `(topicId, tier, participantCoord, timestamp)`, matching what the
  cohort verifies. The self-vouch admission path is genuinely exercised over real sockets in §5c (the
  seeker's register is the production `buildSeekerRegister`, not a test helper), so the "configured node
  refuses an unvouched T2 bootstrap" risk is covered, not just asserted.
- **Error handling / resilience:** `dialQuery`'s catch-all → empty reply is intentional (keeps the walk
  progressing) and matches the §5b 0-byte no-reply contract; the self-primary throw is loud, not a silent
  hang. No unhandled-rejection or swallowed-throw defects found.
- **Type safety:** No `any` leakage in the new surface; the `FretService` wrapper unwrap (`resolveFretEngine`)
  is the documented, narrowest contract and mirrors node-base's `resolveFretEngine`.
- **Layering / DRY / modular:** Placing both client functions in `query-transport.ts` (rather than the
  ticket's suggested `module.ts`) is acceptable — `query-transport.ts` → `module.ts` is a clean one-way
  import (no cycle), and it keeps `module.ts` a pure db-core composition decoupled from p2p-fret/libp2p.
  `module.ts` is unchanged. Accepted as-is.
- **Resource cleanup:** Streams are owned by the shared `requestResponse`/`handleRequestResponse` helpers
  (unchanged); no new sockets/timers are leaked. The walk's only timer is the injected `sleep`.
- **Docs:** Re-read every touched file against `docs/matchmaking.md`. The §Seeker query note and
  §Real-libp2p e2e coverage now accurately describe the walk as live and the multi-cohort sweep as the
  one remaining deferred piece. No stale "outbound walk client deferred" references remain (the other
  `it.skip` / "deferred" mentions in the spec + docs belong to unrelated subsystems — reactivity rotation,
  FRET-routed participant walk).

### Minor — fixed inline this pass
- **`createLibp2pMatchmakingSeekerSession` had no test** (flagged honestly in the handoff). Added an
  I/O-free interaction test to `query-transport-client.spec.ts` that constructs the session via the
  factory and drives `session.query(...)` through the bound transport's `queryCohort` (no-primary FRET
  stub → benign empty reply), asserting the wiring and the resolved topic id. Closes the gap without
  needing a live node. Build + the 9-test suite green.

### Major — filed to backlog (deferred scope, not a defect)
- **Real-libp2p multi-cohort sweep ports** → `tickets/backlog/matchmaking-real-libp2p-sweep-ports.md`.
  The documented remaining piece (`sweepPorts` unbound; hot-topic walk→sweep escalation has no real-socket
  binding) was previously untracked by any active ticket. It is gated on the promoted-tree
  `AggregateCountV1` RPC (cohort-topic promotion follow-ons not yet done), so it is a future concern, not
  presently-actionable — hence backlog. The ticket also folds in the two smaller deferred-hardening items
  from the handoff (a real `RenewV1` keep-alive on the walk; the multi-tier walk-down driven by the real
  `d_max` estimate + `selfServe`).

### Empty categories (explicit)
- **No correctness, security, type-safety, resource-leak, or regression defects found** in the landed
  code. The implementation is faithful to the mock harness and the serve-side prereq, and the gated e2e
  proves the security-critical advisory-trust drop end-to-end.
