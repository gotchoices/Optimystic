description: A node now gives FRET's routing-table redial the same whole-dial deadline it gives libp2p, so a host on slow relayed links that raises the node's dial timeout (Sereus: 21.5 s) raises FRET's too, with no new option. Review the wiring, the new validation of that option, and the still-unraised FRET version floor.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/test/connection-timeouts-node-wiring.spec.ts, packages/db-p2p/test/link-deadlines.spec.ts, packages/db-p2p/readme.md, packages/db-p2p/package.json, packages/substrate-simulator/package.json
----

# FRET's dial budget comes from the node's dial timeout

Reported from Sereus. FRET main (unreleased) bounds each maintenance redial (a connection FRET opens on its own to a routing-table peer it is not connected to) by `FretConfig.dialTimeoutMs`, default 10 s. FRET always dials with an abort signal, so libp2p's `connectionManager.dialTimeout` never applies to those dials; `dialTimeoutMs` is their only whole-dial limit. Before this change `createLibp2pNodeBase` never passed it, so a host on slow relayed links could not raise it.

## What changed

- `resolveLibp2pDialTimeoutMs(declared, deadlines)` in `packages/db-p2p/src/rpc-deadline.ts` resolves the node's whole-dial deadline: `NodeOptions.connectionManager.dialTimeout` when set, else `LinkDeadlines.libp2pDialTimeoutMs` (10 s, or ten declared round trips). It sits beside `resolveBootstrapContactTimeoutMs` and follows the same shape.
- `createLibp2pNodeBase` resolves that once, at the top beside `linkDeadlines`, before any storage is acquired. It passes the one `libp2pDialTimeoutMs` constant both to libp2p's `connectionManager.dialTimeout` and to `fretService({ …, dialTimeoutMs })`, so the two cannot drift.
- `NodeOptions.connectionManager`'s `dialTimeout` bullet, and the deadline table and validation paragraph in `packages/db-p2p/readme.md`, now say the value also bounds FRET's redial, and say it is validated.

## Decision taken on the `0` edge case

The ticket asked whether a value libp2p accepts would now throw from FRET. It would:

- libp2p takes `0`, and arms `AbortSignal.timeout(0)` on every signal-less dial (`dial-queue.js`), which fails each dial at once. Negative, NaN and Infinity throw inside `AbortSignal.timeout`. Values above 2^31 − 1 fire after about 1 ms in Node's timers.
- FRET's constructor refuses any non-positive or non-finite `dialTimeoutMs`. It runs lazily at `node.start()` (`Libp2pFretService.ensure`), not at `createLibp2p`, and its error names `dialTimeoutMs`, an option the host never set.

So `connectionManager.dialTimeout` is now **validated up front**: a value that is not a finite number above zero, or is above 2^31 − 1, throws at node construction with `connectionManager.dialTimeout must be a finite number…`. A `0` there never meant anything usable: every signal-less dial would have failed. Throwing early names the option the host actually set, and leaves nothing to release. The other two `connectionManager` fields (`inboundUpgradeTimeout`, `addressDialTimeout`) still reach libp2p unchecked; they do not reach FRET, so I left them alone. A reviewer may want those validated too, for consistency. That would be a separate change.

## Version floor — NOT raised

`npm view p2p-fret version` returns `1.0.2`, which is the current floor. The FRET release with `dialTimeoutMs` is not on npm yet, so `^1.0.2` stays in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`. **The release step must raise both floors to the FRET version that ships `dialTimeoutMs`, then run `yarn lint:deps`.** Here `p2p-fret` resolves through `portal:../Fret/packages/fret`, so the field type-checks against FRET main now. A published install of FRET 1.0.2 ignores the extra field: the code works, but the redial stays at 10 s until the floor is raised.

## Tests

- `connection-timeouts-node-wiring.spec.ts` › "gives FRET's maintenance redial the same dialTimeout": a real node built with `connectionManager.dialTimeout: 21_500` has FRET's resolved `dialTimeoutMs` equal to 21 500. FRET exposes no accessor for its config, so the helper `fretDialTimeoutMs` reads the private `inner.cfg` of the started `Libp2pFretService`, through a structural cast from `unknown`. If FRET renames those private fields, the helper returns `undefined` and the test fails; it cannot pass by accident. FRET's own default (10 000) also differs from the value tested. A public accessor in FRET would remove the private read; that belongs in the FRET repo.
- `link-deadlines.spec.ts` › `resolveLibp2pDialTimeoutMs`: undeclared yields the derived value and a declared value passes through exactly; `0`, `-1`, NaN, Infinity and 2^31 each throw, naming `connectionManager.dialTimeout`. This pins the decision above.
- Not tested, verified by reading the code: only `linkRoundTripMs` set → FRET gets the derived `libp2pDialTimeoutMs`; nothing set → 10 s, unchanged. Both use the same constant as the tested path.

## Validation run

- `yarn build` (root): clean. The Sereus stale-build guard reads `dist`, so the build is current.
- `npx tsc --noEmit` in db-p2p (covers `src` and `test`): clean. `yarn lint`: clean. `yarn lint:docs`: all citations resolve.
- `yarn test` in db-p2p: 3313 passing, 70 pending, 0 failing.
- `yarn test:integration` was not run. Nothing here changes integration paths beyond the FRET config value, which defaults to the same 10 s.
