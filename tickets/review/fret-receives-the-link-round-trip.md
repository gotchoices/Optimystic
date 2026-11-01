description: The node now hands its declared link round trip to FRET, so FRET's liveness pings and other upkeep wait as long as a slow link needs instead of marking a live cohort member dead after 2 seconds.
architecture: packages/db-p2p/README.md
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/package.json, packages/substrate-simulator/package.json, packages/db-p2p/README.md, yarn.lock
----
# FRET receives the declared link round trip — review handoff

Requested by Sereus (gotchoices/sereus#48): on a link whose round trip is over 2 s, FRET's constant 2 s maintenance ping struck and then marked `dead` a peer whose connection was up, `findCluster` dropped it, and each member of a two-member group committed alone (`commit:solo-cohort`).

## What changed

- `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`), `fret:` factory: passes `linkRoundTripMs: options.linkRoundTripMs` to `fretService({...})` beside `dialTimeoutMs`. Passed as-is (possibly `undefined`, which FRET treats as undeclared). Not validated again: `resolveLinkDeadlines` runs earlier in the same function and throws on a bad value, and Optimystic's `MAX_LINK_ROUND_TRIP_MS` is below FRET's, so any value that gets this far is one FRET accepts.
- `NodeOptions.linkRoundTripMs` doc comment now lists FRET's maintenance deadlines among what is derived.
- `p2p-fret` raised to `^1.3.0` in db-p2p and substrate-simulator; `yarn.lock` updated. The simulator needs no code change (it never builds `fretService`).
- README "Slow relayed links": new table row for FRET's deadlines (ping/announce `max(2000, 2r)`, snapshot `max(1000, 3r)`, phase 1 `max(3000, 5r)`, tick `max(5000, 7r)`, route `max(5000, 4r)`), checked against `resolveMaintenanceDeadlines` in `../Fret/packages/fret/src/service/maintenance-deadlines.ts`; the 3 s worked example now gives FRET's figures too (6 s, 9 s, 15 s, 21 s, 12 s).

## Validation

- `yarn install`, `yarn lint:deps`, `yarn build`, `yarn lint:docs`: clean.
- `yarn workspace @optimystic/db-p2p test`: 3633 passing, 75 pending, 0 failing.
- No new test, as the plan decided: this is one option passed to a constructor, and FRET's own tests cover how the deadlines are derived. Do not extend `connection-timeouts-node-wiring.spec.ts`'s private-config reading to this field.

## For the reviewer

- Check that the order in `createLibp2pNodeBase` still runs `resolveLinkDeadlines` before the FRET factory, so a bad value fails with Optimystic's message.
- Mixed nodes: a node that does not declare the value still times its own pings with the 2 s constant and still strikes a slow peer. The README's "declare it on every node" rule already covers this.
- Not changed here: Optimystic's own cohort-topic reply reads (`readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts`) still use FRET's 5 s `readFramed` default. That is backlog `feat-cohort-topic-reply-reads-follow-the-declared-link`.

## Not run

- Sereus's `strand-workload-on-a-phone-link` scenario (1500 ms one-way delay, `linkRoundTripMs` declared; strikes against the other strand member should stop). It runs in the Sereus repository and was not run here.
