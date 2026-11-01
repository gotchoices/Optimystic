description: Pass `NodeOptions.linkRoundTripMs` to FRET as `FretConfig.linkRoundTripMs`, so FRET's maintenance pings, snapshot fetches and tick budgets follow the declared link as Optimystic's own deadlines do. Until then a cohort member whose ping takes over 2 s is marked `dead` by FRET while its connection is up, and is left out of every cohort, so each side of a two-member strand commits alone.
files: packages/db-p2p/src/libp2p-node-base.ts (the `fretService({...})` call ~1235, beside `dialTimeoutMs`), packages/db-p2p/package.json (p2p-fret range), docs/internals.md or the doc that lists derived deadlines
----
# FRET receives the declared link round trip

Requested by Sereus (`tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md` in that repo, GitHub gotchoices/sereus#48). Waits on FRET ticket `link-round-trip-derives-maintenance-deadlines` (in `../Fret`) landing in a released `p2p-fret`; that cross-repo dependency is not a `prereq:` the runner can track, so check the FRET release before implementing.

## Released: `p2p-fret` 1.3.0 (2026-11-01)

FRET 1.3.0 carries `FretConfig.linkRoundTripMs` (the portal already resolves `../Fret` at 1.3.0; the declared ranges in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json` are still `^1.2.1` — raise both to `^1.3.0`). From its release notes:

- Derived from R, each floored at the old constant: maintenance ping and announce 2·R (floor 2 s), neighbour-snapshot fetch 3·R (floor 1 s), stabilization phase 1 (floor 3 s), whole tick (floor 5 s), outbound maybeAct route budget 2 hops · 2·R (floor 5 s). Undeclared, every deadline is unchanged.
- Validation: positive, finite, at most ≈ 306 million ms; the constructor throws otherwise. That ceiling is above Optimystic's own, so any value Optimystic accepts FRET accepts.
- Not derived on FRET's side: `dialTimeoutMs` (already set separately here), the leave fan-out budgets, the inbound reply close budget, and the library functions' defaults (`RPC_TIMEOUT_MS`, `rpcRequest`, `readFramed`, `sendMaybeAct`). FRET's notes point out that Optimystic's cohort-topic frame reads use FRET's default `timeoutMs` today; decide in this ticket whether those reads pass a timeout derived from `linkRoundTripMs` (in scope if small, else a backlog item).

## Change

- Raise the `p2p-fret` range to the release that adds `FretConfig.linkRoundTripMs`.
- In `createLibp2pNodeBase`, pass `linkRoundTripMs: options.linkRoundTripMs` to `fretService` when it is set, beside the existing `dialTimeoutMs`.
- Document the FRET budgets among the deadlines derived from `linkRoundTripMs`.

## Edge cases

- `linkRoundTripMs` unset: FRET keeps its constants (its default).
- The substrate simulator builds FRET too (`packages/substrate-simulator`); decide whether it passes a round trip.

## Confirming

Sereus's `strand-workload-on-a-phone-link` scenario counts FRET contact strikes (`change: contact strike <n>`) and `commit:solo-cohort`; with a 1 500 ms one-way delay and no event-loop load, strikes against the other strand member should stop.
