description: The node now hands its declared link round trip to FRET, so FRET's liveness pings and other upkeep wait as long as a slow link needs instead of marking a live cohort member dead after 2 seconds.
architecture: packages/db-p2p/README.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json, packages/substrate-simulator/package.json, packages/db-p2p/README.md, docs/transactions.md, yarn.lock
----
# FRET receives the declared link round trip

Requested by Sereus (gotchoices/sereus#48): on a link whose round trip is over 2 s, FRET's constant 2 s maintenance ping struck and then marked `dead` a peer whose connection was up, `findCluster` dropped it, and each member of a two-member group committed alone (`commit:solo-cohort`).

## What shipped

- `createLibp2pNodeBase` passes `linkRoundTripMs: options.linkRoundTripMs` to `fretService({...})` beside `dialTimeoutMs`. Undefined keeps FRET's constants. `resolveLinkDeadlines` runs earlier in the same function and throws on a bad value with Optimystic's message; Optimystic's `MAX_LINK_ROUND_TRIP_MS` is below FRET's, so every value reaching FRET is one it accepts.
- `NodeOptions.linkRoundTripMs` doc comment lists FRET's maintenance deadlines among what is derived.
- `p2p-fret` raised to `^1.3.0` in db-p2p and substrate-simulator (simulator needs no code change).
- db-p2p README "Slow relayed links": table row for FRET's derived deadlines and the 3 s worked example.

## Review findings

- **Diff read first** (`ticket(implement): fret-receives-the-link-round-trip`): one option passed through, a doc comment, two manifest bumps, lockfile descriptor changes, README rows. Nothing else touched.
- **Ordering**: `resolveLinkDeadlines` (line ~867) runs before the FRET factory (~1248), so an invalid value fails with Optimystic's message before FRET sees it. Optimystic's validation (finite, > 0, ≤ its ceiling) is the same shape as FRET's `requireLinkRoundTripMs`, and FRET's ceiling is the larger one. Confirmed.
- **README figures checked against FRET source**: floors are `MAINTENANCE_RPC_TIMEOUT_MS` 2000, `MAINTENANCE_SNAPSHOT_TIMEOUT_MS` 1000, `STABILIZE_PHASE_ONE_BUDGET_MS` 3000, `STABILIZE_TICK_BUDGET_MS` 5000, `RPC_TIMEOUT_MS` 5000; formulas in `resolveMaintenanceDeadlines` (phase 1 = ping + snapshot, tick = phase 1 + ping, route = 4 r) match the table, and the 3 s example (6/9/15/21/12 s) is correct.
- **Lockfile**: the root resolves `p2p-fret` by `portal:../Fret/packages/fret` (version 1.3.0 there), so the lock change is only the two workspace descriptors. Correct.
- **Docs**: `docs/transactions.md` §cohortQueryTimeoutMs listed what `linkRoundTripMs` derives and omitted FRET — fixed inline. Searched `docs/`, `packages/db-p2p/docs/` and the readme for any claim of a fixed 2 s FRET ping; none. The README's citation of `../Fret/...` is a sibling-checkout path, which the citation rules exempt and which marks it as outside this repo.
- **Tests**: no test added or cut. The change is one constructor option; FRET's own tests cover the derivation. Agreed with the plan not to extend `connection-timeouts-node-wiring.spec.ts`'s private-config reading.
- **Mixed nodes** (one declares, one does not): the undeclared node still strikes a slow peer at 2 s. Already covered by the README's "declare it on every node" rule; no new tripwire needed.
- **Resource cleanup / error handling / types**: nothing new — no new resources, errors or types.
- **Out of scope, already filed**: cohort-topic reply reads still use FRET's 5 s `readFramed` default — backlog `feat-cohort-topic-reply-reads-follow-the-declared-link`.
- **Validation run**: `yarn lint:docs`, `yarn lint:deps` clean; `yarn workspace @optimystic/db-p2p test` 3633 passing, 75 pending, 0 failing.
- **Not run**: Sereus's `strand-workload-on-a-phone-link` scenario (lives in the Sereus repo).
