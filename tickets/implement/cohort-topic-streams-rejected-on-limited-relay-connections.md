description: Cohort members reachable only through a relay (NAT'd/mobile peers) were unreachable for cohort-topic messages because the stream helpers never opted in to sending data over a relayed connection; the fix and a test are already written here and just need a build/test double-check and handoff to review.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/test/cohort-topic/stream-util.spec.ts
prereq:
----
## Root cause (already diagnosed and fixed)

`packages/db-p2p/src/cohort-topic/stream-util.ts` opens protocol streams via `Connection.newStream(...)` (reused connection) or `node.dialProtocol(...)` (fresh dial) but never passed `runOnLimitedConnection: true`. libp2p refuses to open a stream over a *limited* (circuit-relay) connection without that flag — every other dial path in this repo already sets it (`libp2p-key-network.ts:542-546,552`, FRET's `protocols.ts`). Cohort-topic was the one subsystem that forgot it, so any member reachable only through a relay could hold a perfectly good relayed connection and still get every stream rejected.

## Fix already applied

Both `requestResponse` and `sendOneWay` in `stream-util.ts` now pass `{ runOnLimitedConnection: true }` on both the `Connection.newStream(...)` reuse path and the `node.dialProtocol(...)` fresh-dial path — mirroring `libp2p-key-network.ts:542-552`.

## Tests already added

`packages/db-p2p/test/cohort-topic/stream-util.spec.ts` — 3 unit tests mocking a libp2p node/connection, asserting `runOnLimitedConnection: true` is present in the options object on all four call sites (2 helpers × 2 paths each). Confirmed the assertions fail without the fix and pass with it.

Full `db-p2p` suite already run clean: `yarn test` → 1766 passing, 0 failing, 44 pending (pre-existing skips, unrelated). `tsc --noEmit` also clean.

## TODO for this stage

- Re-verify `yarn test` (in `packages/db-p2p`) still passes cleanly at HEAD before handoff — nothing else should have touched this area, but confirm.
- Write the `review/` handoff. Known gaps to flag honestly for the reviewer:
  - No integration test actually dials a cohort-topic protocol across a real `circuit-relay-v2` connection end-to-end (the original ticket's suggested repro). The unit tests instead assert the call-site contract (options object shape) directly — narrower but deterministic and fast. Worth noting as a possible follow-up if the reviewer wants full relay-dial integration coverage (check whether reusable relay-test scaffolding already exists elsewhere in the repo before writing new harness code).
  - The original ticket suggested "a lint or shared stream-options constant so the next dial site cannot forget it." Not done — out of scope for a minimal bug fix, and no other dial sites currently exist in this file. Consider flagging as a candidate `debt-` ticket for future dial-site additions.
