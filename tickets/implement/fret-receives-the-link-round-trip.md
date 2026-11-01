description: Hand the node's declared link round trip to FRET, so FRET's liveness pings and other upkeep wait as long as a slow link needs. Without it a cohort member whose ping takes over 2 seconds is marked dead while its connection is up, drops out of every cohort, and each side of a two-member group commits alone.
architecture: packages/db-p2p/README.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json, packages/substrate-simulator/package.json, packages/db-p2p/README.md, yarn.lock
difficulty: easy
----
# FRET receives the declared link round trip

Requested by Sereus (`tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md` in that repository, GitHub gotchoices/sereus#48).

## Background

`NodeOptions.linkRoundTripMs` is the slowest round trip between any two nodes; every deadline Optimystic applies is derived from it (`resolveLinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`), and the README's "Slow relayed links" table lists them. FRET — the ring-membership service the node builds in `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`, the `fret:` factory calling `fretService({...})`) — keeps its own constant deadlines: a 2 s maintenance ping. On a link whose round trip exceeds 2 s, FRET strikes and then marks `dead` a peer whose connection is up, `findCluster` drops it, and each member of a two-member group commits alone (`commit:solo-cohort`).

`p2p-fret` 1.3.0 (released 2026-11-01; the root manifest already resolves `../Fret/packages/fret` at 1.3.0 through `portal:`) adds `FretConfig.linkRoundTripMs`. With R declared, FRET derives, each floored at the constant it replaces: maintenance ping and announce `max(2 s, 2R)`, neighbour-snapshot fetch `max(1 s, 3R)`, stabilization phase 1 (floor 3 s), whole tick (floor 5 s), outbound maybe-act route budget `max(5 s, 2 hops × 2R)` (`resolveMaintenanceDeadlines` in `../Fret/packages/fret/src/service/maintenance-deadlines.ts`). Undeclared, every deadline is unchanged. FRET's constructor throws for a value that is not positive, finite and at most about 306 million ms; Optimystic's own ceiling, `MAX_LINK_ROUND_TRIP_MS` (about 47 million ms), is lower and is enforced first by `resolveLinkDeadlines` at node construction, so any value that reaches FRET is one FRET accepts.

Not derived on FRET's side, and not touched here: `dialTimeoutMs` (already passed, from `libp2pDialTimeoutMs`), the leave fan-out budgets, the inbound reply close budget, and the defaults of FRET's library functions (`RPC_TIMEOUT_MS`, `rpcRequest`, `readFramed`, `sendMaybeAct`).

## Decisions

- **Pass the option through when set.** `linkRoundTripMs: options.linkRoundTripMs` beside `dialTimeoutMs` in the `fretService({...})` call, spread conditionally (or passed as `undefined` — FRET treats `undefined` as undeclared; either is fine, match the surrounding style). No re-validation: `resolveLinkDeadlines(options.linkRoundTripMs, …)` already ran earlier in `createLibp2pNodeBase` and throws on a bad value.
- **The substrate simulator needs nothing.** It imports FRET's pure pieces (`DigitreeStore`, `assembleCohort`, `hashKey`, `estimateSizeAndConfidence`) and never builds `fretService`, so it has no deadlines to set. Its declared range still moves to `^1.3.0`, because `scripts/shared-majors.cjs` / `yarn.config.cjs` guard shared ranges — run `yarn lint:deps` to confirm whether `p2p-fret` is on the shared list; if it is, the two ranges must match.
- **Optimystic's own cohort-topic reply reads stay on FRET's 5 s default in this ticket.** `readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts` calls FRET's `readFramed` with its default timeout, and the host's server-side budgets (the cold-quorum wait in `packages/db-p2p/src/cohort-topic/cold-quorum-wait.ts`, the "keep it well under 5 s" note in `packages/db-p2p/src/cohort-topic/host.ts`) are tuned against that 5 s. Deriving only the reader would leave the server budgets out of step, so it is a coordinated change of its own: filed as backlog `feat-cohort-topic-reply-reads-follow-the-declared-link`. It does not affect Sereus's failure, which is FRET's own pings.
- **No new test.** The change is one option passed to a constructor — wiring, checked by inspection. FRET's derivation has its own tests in the FRET repository. (`packages/db-p2p/test/connection-timeouts-node-wiring.spec.ts` reads FRET's private config to pin `dialTimeoutMs`; do not extend that pattern to this field.)

## Edge cases & interactions

- `linkRoundTripMs` unset: FRET receives nothing (or `undefined`) and keeps its constants. Verified by inspection.
- `linkRoundTripMs` invalid (zero, negative, non-finite, above `MAX_LINK_ROUND_TRIP_MS`): `resolveLinkDeadlines` throws before the FRET factory runs, with Optimystic's message, not FRET's. Verified by inspection of the order in `createLibp2pNodeBase`.
- `connectionManager.dialTimeout` declared alongside `linkRoundTripMs`: FRET's `dialTimeoutMs` still comes from `libp2pDialTimeoutMs` (the override wins), and the maintenance deadlines from R. Independent fields; nothing to reconcile.
- FRET's `routeMs` (outbound maybe-act route budget) grows with R; cohort-topic registration through `RouteAndMaybeAct` goes through FRET's routing, so a slow link now gets a longer route budget there too. Intended.
- Mixed nodes, one declaring R and one not: each FRET instance times its own outbound pings; the undeclared one still strikes the slow peer. Same "declare it on every node" rule the README already states.
- Lockfile: the portal resolution already points at 1.3.0; after raising the ranges run `yarn install` so `yarn.lock` records the new range, then `yarn lint:deps`.
- Build freshness: `p2p-fret` is portal-linked, so the test guard (`test-harness/build-freshness.mjs`) checks `../Fret/packages/fret`'s build; if it reports stale, rebuild there as the message says.

## Confirming (out of band)

Sereus's `strand-workload-on-a-phone-link` scenario counts FRET contact strikes (`change: contact strike <n>`) and `commit:solo-cohort`; with a 1500 ms one-way delay, no event-loop load and `linkRoundTripMs` declared, strikes against the other strand member should stop. This runs in the Sereus repository, not here; note in the review handoff that it was not run.

## TODO

- Raise `p2p-fret` to `^1.3.0` in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`; `yarn install`; `yarn lint:deps`.
- In `createLibp2pNodeBase`'s `fret:` factory, pass `linkRoundTripMs: options.linkRoundTripMs` beside `dialTimeoutMs`, with a one-line comment that FRET derives its maintenance ping, snapshot, tick and route budgets from it.
- Update the `NodeOptions.linkRoundTripMs` doc comment in `libp2p-node-base.ts` to name FRET's maintenance deadlines among what is derived.
- In `packages/db-p2p/README.md` "Slow relayed links", add a table row for FRET's maintenance deadlines (`max(2000, 2 × r)` ping and announce, `max(1000, 3 × r)` neighbour snapshot, stabilization phase 1 `max(3000, 5 × r)` — ping plus snapshot — and whole tick `max(5000, 7 × r)` — phase 1 plus a ping, route budget `max(5000, 4 × r)`), with the reason (a ping that outlives its deadline is a strike, and strikes mark a live peer dead). Cite FRET's file as `../Fret/packages/fret/src/service/maintenance-deadlines.ts` (sibling-checkout paths are exempt from `lint:docs`). Add the 3 s-round-trip figures to the worked-example sentence below the table.
- `yarn build`, then `yarn workspace @optimystic/db-p2p test` (and `yarn lint:docs`).
