description: FRET's per-dial budget (`FretConfig.dialTimeoutMs`, new in the next FRET release, default 10 s) is not passed by `createLibp2pNodeBase`, so an embedder on slow relayed links (Sereus: 21.5 s) cannot raise it. Pass the node's resolved libp2p `dialTimeout` to FRET, so FRET's maintenance redial follows the same deadline as every other dial the node makes.
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/connection-timeouts-node-wiring.spec.ts, packages/db-p2p/package.json, packages/substrate-simulator/package.json
----

# FRET's dial budget comes from the node's dial timeout

Reported from Sereus (was `fix/fret-dial-timeout-not-passed-through`). FRET main (`maintenance-redial-off-the-tick`, unreleased) moves the maintenance redial off the stabilization tick and bounds each dial by `FretConfig.dialTimeoutMs` (default 10 s). Because FRET always dials with an abort signal, libp2p's own `connectionManager.dialTimeout` never applies to FRET's dials, so this is the only whole-dial limit FRET's redial has. Sereus's `joiner-first-commit-over-slow-relay` restart arms need a relayed redial of about 9 s on a link it budgets at 21.5 s.

## Decision

No new option. Derive FRET's `dialTimeoutMs` from the dial timeout the node already resolves for libp2p:

```ts
const libp2pDialTimeoutMs = options.connectionManager?.dialTimeout ?? linkDeadlines.libp2pDialTimeoutMs;
```

Use that one value both for `connectionManager.dialTimeout` and for `fretService({ …, dialTimeoutMs })`, so the two cannot drift. Why: Sereus already sets `connectionManager.dialTimeout` from its declared link (and `linkRoundTripMs` derives it otherwise), so FRET follows with no embedder change; an undeclared node gets `libp2pDialTimeoutMs`, which floors at 10 s, FRET's own default, so nothing changes for it. Sereus said it accepts either form.

Document it on `NodeOptions.connectionManager` (the `dialTimeout` bullet): it also bounds each dial FRET's maintenance redial makes, because FRET's dials carry a signal and libp2p's limit would not otherwise reach them.

## Version floor

`p2p-fret` resolves through `portal:../Fret/packages/fret` here, so the field type-checks against FRET main now. The published floor (`^1.0.2` in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`) must be raised to the FRET release that has `dialTimeoutMs`, which the maintainer is publishing now. If that version is on npm when this runs (`npm view p2p-fret version`), raise both floors to it and run `yarn lint:deps`; otherwise leave the floors and say so in the review handoff, so the release step raises them. An older FRET ignores the extra field, so the code is safe either way.

## Edge cases & interactions

- `connectionManager.dialTimeout` explicitly set → FRET gets exactly that (verified by test).
- Only `linkRoundTripMs` set → FRET gets the derived `libp2pDialTimeoutMs` (by inspection: same variable).
- Nothing set → 10 s, unchanged behaviour (by inspection).
- FRET throws at construction on a non-positive or non-finite value; `connectionManager.dialTimeout` reaches libp2p unvalidated today. Check whether a value libp2p accepts (e.g. `0`) would now throw from FRET; if so, decide whether that is the right outcome and document it at the option.
- Sereus links `../optimystic` dist: rebuild (`yarn build`) when done so its stale-build guard passes.

## TODO

- Hoist the resolved dial timeout to one `const` in `createLibp2pNodeBase` and pass it to both libp2p and `fretService`.
- Extend `connection-timeouts-node-wiring.spec.ts` with one case: a node built with `connectionManager.dialTimeout` has FRET configured with the same value (read it off the started node's FRET service; do not mock FRET).
- Update the `NodeOptions.connectionManager` doc comment.
- Raise the `p2p-fret` floors if the release is on npm (see above).
- `yarn build`, then db-p2p tests.
