description: A node now gives FRET's routing-table redial the same whole-dial deadline it gives libp2p, so a host on slow relayed links that raises the node's dial timeout (Sereus: 21.5 s) raises FRET's too, with no new option. The node also refuses an unusable dial timeout when it is built.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/test/connection-timeouts-node-wiring.spec.ts, packages/db-p2p/test/link-deadlines.spec.ts, packages/db-p2p/readme.md, tickets/backlog/debt-require-the-fret-release-that-takes-a-dial-budget.md
----

# FRET's dial budget comes from the node's dial timeout

Reported from Sereus. FRET main (unreleased) bounds each maintenance redial (a connection FRET opens on its own to a routing-table peer it is not connected to) by `FretConfig.dialTimeoutMs`, default 10 s. FRET always dials with an abort signal, so libp2p's `connectionManager.dialTimeout` never applies to those dials. Before this change `createLibp2pNodeBase` never passed `dialTimeoutMs`.

## What landed

- `resolveLibp2pDialTimeoutMs(declared, deadlines)` in `packages/db-p2p/src/rpc-deadline.ts` returns `NodeOptions.connectionManager.dialTimeout` when set, and `LinkDeadlines.libp2pDialTimeoutMs` otherwise (10 s, or ten declared round trips).
- `createLibp2pNodeBase` resolves it once, before acquiring any storage, and passes the same constant to libp2p's `connectionManager.dialTimeout` and to `fretService({ …, dialTimeoutMs })`.
- A declared `connectionManager.dialTimeout` must now be a finite number above 0 and no more than 2^31 − 1, or node construction throws. libp2p alone would accept `0` and fail every signal-less dial at once. FRET refuses `0`, but only at `node.start()` and under a name the host never set. The other two `connectionManager` fields still reach libp2p unchecked.
- The `NodeOptions.connectionManager` doc comment and the deadline table and validation paragraph in `packages/db-p2p/readme.md` describe both points.
- With nothing declared, FRET gets 10 s, the same as its own default, so default behaviour does not change.

## Review findings

Read the implement diff (`ticket(implement): fret-dial-timeout-from-the-node-dial-timeout`) first, then the handoff, then the FRET side (`../Fret/packages/fret/src/service/fret-service.ts`).

- **Correctness of the wiring.** Checked. FRET reads `cfg.dialTimeoutMs` in exactly one place, the `deadline(...)` around the redial's `node.dial`. That matches the "maintenance redial" wording in the code and the docs. The announce fan-out dials under FRET's fixed 2 s RPC budget, which this value does not touch; FRET's own NOTE covers that. libp2p and FRET read one constant, so the two values cannot drift. No defects found.
- **Validation.** Checked. FRET's `requirePositiveMs` has no upper bound, so the 2^31 − 1 ceiling enforced here is the only guard against Node's timer overflow on FRET's side. No caller in this repository declares `connectionManager.dialTimeout` apart from the two specs, so the new validation cannot break an existing caller. Leaving the other two `connectionManager` fields unvalidated is a deliberate choice: they do not reach FRET, and libp2p handles them itself. That is recorded in the readme, so I filed no ticket.
- **Overlapping backlog ticket (fixed).** `tickets/backlog/feat-fret-maintenance-dials-get-a-relay-sized-budget.md` asked for this same wiring, waiting on the FRET release. That half is now done. I replaced it with `tickets/backlog/debt-require-the-fret-release-that-takes-a-dial-budget.md`, which carries only what is left (next bullet).
- **Version floor (ticketed).** `p2p-fret` is still `^1.0.2` in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`. FRET has not published a release with `dialTimeoutMs`: `v1.0.2` is its newest tag, and its `maintenance-redial-off-the-tick` work comes after it. The handoff left the floor raise as a "release step" with no durable record outside this ticket, and `docs/releasing.md` has no step for sibling-repository floors. The backlog ticket above is that record. The wider class of problem (what a fresh install resolves versus what the lockfile tests) is already `debt-tests-run-on-locked-versions-a-fresh-install-does-not-get`, so I added nothing there.
- **Tests.** I kept the node-level wiring test. It reads FRET's private `inner.cfg` through a structural cast, which is fragile, but if FRET renames those fields the test fails rather than passing silently. A public accessor would belong in the FRET repository. I cut the `resolveLibp2pDialTimeoutMs` throw cases from five to two: `0` (the decision this ticket made) and 2^31 (this field's own ceiling). The `-1`, NaN and Infinity cases only exercised `validDeclaredMs`, which the `rpcDeadlines` cases in the same spec already cover.
- **Docs.** I read the `NodeOptions.connectionManager` and `bootstrapContactTimeoutMs` doc comments, `packages/db-p2p/readme.md` (deadline table and validation paragraph), and searched `docs/` and the package docs for `dialTimeout`. All are accurate. Nothing under `docs/` describes FRET's dial budget, so nothing else needed an edit.
- **Resource cleanup and error handling.** Not affected. Validation happens before any storage is acquired, so a throw leaves nothing to release.
- **Tripwires.** None added.

## Validation

- `npx tsc --noEmit` in db-p2p: clean. `yarn lint`: clean. `yarn lint:docs`: all citations resolve.
- `yarn test` in db-p2p: 3310 passing, 70 pending, 0 failing (3313 before; the difference is the three trimmed cases).
- `yarn test:integration` was not run. This change touches no integration path beyond the FRET config value, and that value defaults to the same 10 s.
