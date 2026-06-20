description: Review the admission-time gossip replication fix: onAdmit hook added to CohortMemberEngineDeps, wired in host.ts, tested with a no-renewal two-node replication test and focused unit tests.
files:
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts
  - packages/db-core/test/cohort-topic/member-engine.spec.ts
----

## What was built

Closed the durability window between a participant's `accept` and its first renewal touch (~30 s for the 90 s Core TTL). Previously, a freshly-admitted record was never queued for gossip until the participant's first `touchAndServe` call; if the accepting primary crashed in that window, the registration was silently lost.

### Changes

**`packages/db-core/src/cohort-topic/member-engine.ts`**
- Added `onAdmit?: (rec: RegistrationRecord) => void` to `CohortMemberEngineDeps` with JSDoc explaining the symmetry with the renewal `gossip.touch` hook.
- In `accept()`, called `this.deps.onAdmit?.(record)` immediately after `this.deps.store.put(record)` — before `traffic.recordArrival` / `topicBudget.touch` / `firePromotion` so the replication enqueue is the first thing that happens once the record is durable locally.

**`packages/db-p2p/src/cohort-topic/host.ts`**
- In `createCoordEngine`'s `createCohortMemberEngine` call (~L1068), wired `onAdmit: (rec): void => pending.touch(rec)` alongside the existing `onNotice`. Same `pending` queue the renewal-side `gossip.touch` feeds into; last-writer-wins by `lastPing` deduplicates an admit-then-touch landing in the same round.

### Tests

**`packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts`**
Added `'an admitted record replicates to a sibling in one gossip round with no intervening renewal touch'` inside `'cohort-topic: two-node replication via a gossip round'`. The test:
1. Seeds A's view with B's willingness so the 2-of-2 quorum is met.
2. `handleRegister` on A — **no** `handleRenew` / `signedReattach`.
3. Runs `eA.gossipRound(now)`, asserts `g?.records?.length === 1`.
4. Delivers the frame to B and asserts `eB.holds(TOPIC, participant.bytes) === true` after `delay(30)`.

**`packages/db-core/test/cohort-topic/member-engine.spec.ts`**
Added `'cohort-topic / member-engine: onAdmit fires on accept'` describe block with two unit tests:
1. `onAdmit` fires with the correct `participantId` on `accepted`.
2. `onAdmit` is NOT called when willingness returns `unwilling_cohort`.

### Test run results

- `cd packages/db-core && yarn test` — **880 passing** (includes 2 new onAdmit unit tests)
- `cd packages/db-p2p && yarn test` — **849 passing, 29 pending** (includes 1 new no-renewal replication test)

Note: db-core must be built (`yarn build`) before running db-p2p tests since db-p2p resolves `@optimystic/db-core` from `dist/`.

## Use cases for validation

1. **Two-node admit-without-renewal replication** — the new `gossip-cadence.spec.ts` test: register on A, skip renewal, gossip round, verify B holds the record.
2. **Existing renewal-path test still passes** — the existing `'a touched record + willingness propagate'` test verifies the renewal `gossip.touch` producer is still intact alongside the new `onAdmit` producer.
3. **Unit isolation** — the new `member-engine.spec.ts` tests verify the hook fires/doesn't fire without any db-p2p gossip machinery.

## Known gaps / reviewer notes

- The `onAdmit` hook is a queue append (same `pending.touch` the renewal side uses), so it is subject to the same last-writer-wins semantics: an admit-then-touch in the same gossip round keeps only the newer `lastPing`. This is intentional and symmetric — no special-casing needed.
- No wire change: `toGossipRecord` already serializes `appState`, so admitted records gossip full state. No new types or serialization changes.
- The existing `'a gossip round drains a touched record'` test in `host gossip round` still requires a `handleRenew` call to put a delta in the queue — that test predates this fix and now the admit itself would also queue a delta. The test flow (register + reattach) still works because admit queues the record first, then the reattach's touch supersedes it (last-writer-wins). The test's `g!.records!.length === 1` assertion still holds since both touch the same participant.
