description: Peer-discovery (FRET) can now talk directly between two nodes that only reach each other through a relay; the relay-topology acceptance test that used to randomly skip now passes reliably.
prereq:
files:
  - C:/projects/Fret/packages/fret/src/rpc/protocols.ts            (UPSTREAM — new openRpcStream + isLimitedConnection helper)
  - C:/projects/Fret/packages/fret/src/rpc/neighbors.ts           (UPSTREAM — fetch/announce use openRpcStream, requireExisting)
  - C:/projects/Fret/packages/fret/src/rpc/ping.ts                (UPSTREAM — sendPing uses openRpcStream)
  - C:/projects/Fret/packages/fret/src/rpc/maybe-act.ts           (UPSTREAM — sendMaybeAct uses openRpcStream)
  - C:/projects/Fret/packages/fret/src/rpc/leave.ts               (UPSTREAM — sendLeave uses openRpcStream)
  - C:/projects/Fret/packages/fret/package.json                   (UPSTREAM — 0.5.0 -> 0.5.1)
  - package.json                                                   (root resolutions — added p2p-fret portal entry)
  - packages/db-p2p/package.json                                  (p2p-fret ^0.5.0 -> ^0.5.1)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts  (stabilization precondition rewritten)
----

# Complete: FRET wire RPCs over circuit-relay (limited) connections

## Summary of shipped work

Cross-repo change. The substantive fix is **upstream** in the sibling Fret
checkout (`C:/projects/Fret`, package `p2p-fret`, commit `f46c82e`, version
`0.5.0 → 0.5.1`): all four FRET wire RPCs (`neighbors`, `ping`, `maybeAct`,
`leave`) now open their libp2p stream via a new shared `openRpcStream` helper in
`rpc/protocols.ts` that prefers a DIRECT open connection, falls back to a limited
(circuit-relay) one, and opens with `{ runOnLimitedConnection: true,
negotiateFully: false }`. Without that flag libp2p rejected the stream over a
relay-only link, so direct A↔B FRET gossip failed on every relay-only topology.

optimystic consumes it via a yarn-berry `portal:` resolution
(`p2p-fret → portal:../Fret/packages/fret` in root `package.json`, mirroring the
existing `@quereus/quereus` portal), bumps the `db-p2p` spec to `^0.5.1`, and
rewrites the relay acceptance spec's stabilization precondition to gate on actual
FRET convergence (both nodes' rings hold both peers) instead of a lottery-prone
`assembleCohort(probe, 2)` proxy that caused bimodal `this.skip()`.

## Review findings

### Reviewed
- **Implement diff** (`79dbeac`) read first, then the handoff. Upstream Fret
  diff (`f46c82e`) read directly from the sibling checkout.
- **Upstream RPC fix** (`rpc/protocols.ts`): `openRpcStream` and
  `isLimitedConnection` logic, and all five call sites
  (`neighbors` ×2 with `requireExisting:true`; `ping`/`maybeAct`/`leave` with
  dial fallback). Logic is correct, well-commented, and mirrors the in-repo
  `Libp2pKeyPeerNetwork.connect()` precedent.
- **Consumption boundary**: confirmed the portal symlink resolves
  (`packages/db-p2p/node_modules/p2p-fret -> /c/projects/Fret/packages/fret`,
  hoisted to the workspace per `nmHoistingLimits: workspaces`), the served
  `dist` contains the fix, and reports version `0.5.1`. `substrate-simulator`
  (which declares its own `portal:` dep to the same path) stays consistent with
  the new root resolution.
- **`yarn.lock` churn**: the incidental `@libp2p/interface ^3.2.4→^3.1.0` and
  `@quereus/quereus ^4.2.0→^4.2.1` entries are benign — they sync the lockfile
  to spec values **already present** in the respective package.json files
  (verified), not changes introduced by this ticket.
- **Spec precondition rewrite**: confirmed `exportTable()` returns the ring
  entries including self (`fret-service.ts` → `digitree-store.exportEntries` →
  `store.list()`), so the new gate effectively asserts bidirectional A↔B
  convergence (the self-checks are harmless no-ops). The downstream 24-block
  keyspace search loop still absorbs per-probe cohort variance, so the real
  `pend`/`commit` assertions are reached every run. The change from `this.skip()`
  to `expect(...)` is justified: convergence is reliable, making this a
  meaningful regression guard rather than a false-negative.
- **No-break check**: the removed `import { hashKey }` was the spec's only use;
  `hashKey` remains exported and is still used across `db-p2p/src` (rebalance,
  spread-on-churn, key-network, network-manager) — unaffected.

### Found & fixed inline (minor)
- The spec's `fretOf` type cast still declared `assembleCohort(...)` after the
  rewrite stopped calling it (only `exportTable()` is used now). Removed the dead
  member from the inline type for clarity. Rebuilt + re-ran the spec after the
  edit — both green.

### Found & filed as follow-up (major)
- **The RPC fix has zero automated coverage.** The upstream fix commit added no
  test, and the acceptance spec does **not** exercise the fix — this 3-node
  topology converges via `peer:connect` regardless of whether the direct A↔B RPC
  works (confirmed by the implementer; the fix's only validation was temporary
  instrumentation that was removed). A regression here would not turn anything
  red. Filed `tickets/backlog/fret-limited-connection-rpc-regression-test.md`
  proposing either a Fret-level unit test of `openRpcStream`/`isLimitedConnection`
  (preferred) or a db-p2p integration test with a transitively-only-reachable
  peer.

### Noted, not actioned
- **Cross-repo durability (operational, human/CI — not new engineering).** The
  fix lives in a sibling checkout reached via `portal:`; `db-p2p` declares
  `^0.5.1`, which is **not published to npm**. A fresh `yarn install` therefore
  requires the Fret sibling at the expected relative path. This is consistent
  with the repo's existing `@quereus/quereus` portal practice and is masked by
  the root resolution. Durable resolution = publish `p2p-fret@0.5.1` and drop the
  portal back to the plain version. Left as the documented human/CI step; no
  ticket filed (it's a release action, not engineering work).
- **Second skip retained.** `if (!blockId) this.skip()` (no probed keyspace
  places B in A's cohort over 24 tries, ~(1/3)^24) is left as-is — it is not the
  FRET-stabilization skip this ticket targeted. TypeScript flags the following
  `return` as unreachable (mocha's `this.skip()` throws); this is pre-existing,
  warning-only, build exits 0 — left untouched to avoid scope creep.
- **Secret in tree (pre-existing, out of scope):** `.yarnrc.yml` contains a
  committed `npmAuthToken`. Predates this ticket and is unrelated to the diff;
  flagging for awareness only.

### Validation performed
- `yarn workspace @optimystic/db-p2p build` → clean (exit 0), before and after
  the inline edit.
- db-p2p unit suite (`yarn test`) → **1045 passing, 36 pending, 0 failing**
  (~35s). The 36 pending are env-gated integration specs; the "parent
  unreachable" line is expected console output from a passing error-path test.
- Acceptance spec (`OPTIMYSTIC_INTEGRATION=1`, single file) → **passing on every
  run** (3× during review + 1× post-edit), ~270–310 ms each, **0 pending** (a
  skip would report pending), reaching the real `pend` super-majority + `commit`
  consensus assertions every time.
- Root `lint` is a no-op in this repo (`echo 'Lint not configured...'`) — nothing
  to run.
- Upstream Fret suite was reported green by the implementer (232 passing); not
  re-run here (upstream repo, out of optimystic's test scope).

### No pre-existing failures
No unrelated/pre-existing test failures surfaced; `tickets/.pre-existing-error.md`
not written.

## Out of scope / follow-ups
- Publish `p2p-fret@0.5.1`; replace the `portal:` resolution with the published
  version (human/CI).
- Dedicated regression test for the limited-connection RPC path — filed as
  `tickets/backlog/fret-limited-connection-rpc-regression-test.md`.
- Rate-limiting FRET gossip over relayed links to avoid relay-reservation cap
  pressure — future concern; not observed.
