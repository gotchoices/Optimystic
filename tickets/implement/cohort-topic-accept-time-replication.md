description: When a participant first registers with a cohort, its record is not copied to the other cohort members until the participant's first renewal (~30 s later). If the member that accepted the registration crashes in that window, the registration is lost and the participant disappears until it re-registers. Close that window by copying the record to the cohort right after it is admitted.
prereq:
files:
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-core/src/cohort-topic/registration/renewal.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts
  - packages/db-core/test/cohort-topic/member-engine.spec.ts
difficulty: easy
----

# Replicate an accepted cohort record at admission time, not only on first renewal touch

## Problem (confirmed)

`CohortMemberEngine.accept` (`member-engine.ts`, ~L221-259) persists a freshly-admitted registration
record with `this.deps.store.put(record)` but fires **no** gossip hook. The only producers of
registration-record gossip deltas are the renewal cohort side's `gossip.touch` / `gossip.evicted` hooks
(`renewal.ts`, `touchAndServe` → `pending.touch(rec)`, wired in `host.ts createCoordEngine`). So a record
first enters the per-coord `pending` delta queue on its **first renewal touch**, which the participant
sends every `ttl/3` (≈ 30 s for the 90 s Core TTL).

Between `accepted` and that first touch, the per-round `CohortGossipV1` a resident topic emits carries
only the topic **summary** (`directParticipants` count, rates via `toCohortTopicSummary`) — never the
record itself (`primary`/`backups`/`participantId`/`appState`). No sibling holds a replica, so if the
accepting primary crashes (or its slot rotates away) inside that ~30 s window the registration silently
vanishes until the participant notices the dead primary and re-registers.

**Reproduction is already latent in the test suite.** The two-node replication test
`gossip-cadence.spec.ts` ("a touched record + willingness propagate from node A to node B in one gossip
round", ~L346) only converges because it issues an explicit `signedReattach` (L362) to force a cohort-side
`gossip.touch` *before* the round. Delete that `handleRenew(reattach)` line and B never receives the
record — that is exactly the gap. The new test below asserts replication with **no** intervening renewal.

## Fix

Add an admission-time gossip hook symmetric to the renewal `touch` hook.

**db-core (`member-engine.ts`):**
- Add an optional port to `CohortMemberEngineDeps`:
  ```ts
  /**
   * Sink for a freshly-admitted registration record (the `accept` path), symmetric to the renewal
   * `gossip.touch` hook. db-p2p wires this to the same per-coord gossip delta queue the renewal side
   * appends to, so an admitted record is replicated to the cohort at the next gossip round — closing the
   * durability window between admission and the participant's first renewal touch (§Registration record).
   * A queue append, not a synchronous broadcast: admission must not block on a round, and last-writer-wins
   * by `lastPing` dedupes an admit-then-touch landing in the same round. Absent → no admission-time
   * replication (unit/mock flows that don't exercise gossip).
   */
  readonly onAdmit?: (rec: RegistrationRecord) => void;
  ```
  (`RegistrationRecord` is already imported in this file.)
- In `accept()`, immediately after `this.deps.store.put(record);`, call `this.deps.onAdmit?.(record);`.
  Place it before the `traffic.recordArrival` / `topicBudget.touch` / `firePromotion` lines so the
  replication enqueue is the first thing that happens once the record is durable locally; ordering vs.
  those is immaterial (they touch different state). Keep the existing reply assembly unchanged.

**db-p2p (`host.ts`, `createCoordEngine`):** in the `createCohortMemberEngine({ … })` call (~L1046-1069),
wire the new port to the existing per-coord `pending` queue, next to the existing `onNotice`:
  ```ts
  // Admission-time replication, batched to the same gossip round as renewal touches: enqueue the
  // just-admitted record so siblings hold a replica before the participant's first renewal (closes the
  // accept→first-touch durability window). Same queue + last-writer-wins as the renewal `gossip.touch`.
  onAdmit: (rec): void => pending.touch(rec),
  ```
  No change is needed in `renewal.ts` itself — it already feeds `pending.touch`; this just adds a second
  producer for the same queue. (`renewal.ts` is listed only because it is the reference shape for the hook
  and worth reading to confirm the symmetry — the `RenewalGossip.touch` JSDoc and `touchAndServe`.)

`toGossipRecord` (`gossip/records.ts`) already serializes `appState`, so the admitted record gossips full
state — a sibling that adopts it can serve as primary. No wire/type change.

## Tests

**db-p2p `gossip-cadence.spec.ts` — primary coverage.** Add a test in the existing
`'cohort-topic: two-node replication via a gossip round'` describe (it already has the `twoNodeCohort()`
helper, `signedRegister`, `deliverGossip`, real-clock `now` pattern). The test must:
- seed A's view with B's willingness (`signedGossip(b.member, …, { willingnessBits: 'f' })`) so the 2-of-2
  willingness quorum is met and A can admit (mirror the existing test's setup, ~L355);
- `handleRegister` a `signedRegister` at real-clock `now` and assert `accepted`;
- **NOT** call `handleRenew`/`signedReattach` — that is the whole point;
- run `eA.gossipRound(now)`, assert `g?.records?.length === 1` (the admitted record was drained from the
  queue with no renewal), deliver the frame to B via `deliverGossip`, and assert
  `eB.holds(TOPIC, participant.bytes) === true` after a `delay(30)`.
- Leave the existing reattach-based test in place — it still validates the renewal-touch producer.

**db-core `member-engine.spec.ts` — focused unit (optional but preferred).** The existing file only
composes the `sweepStale` seam (willingness/promotion/etc. are `unused(...)` proxies). Add a small,
separate composition that exercises the admit path: a willingness stub returning `{ kind: 'accepted' }`,
a promotion stub whose `onParticipantCountChange` resolves `undefined`, a real `traffic`
(`createTrafficCounters`) or a minimal stub, a real `coldStart` (or a stub whose `get` returns the
forwarder so `serves()` is true / use the `bootstrap`+`quorumWilling` cold path), and an `onAdmit` spy.
Call `handleRegister` with a minimal valid `RegisterV1` and assert the spy fired once with a record whose
`participantId` matches. Keep it isolated from the `sweepStale` test's `unused(...)` engine — do not make
that engine depend on the admit stack. If composing the full admit stack proves heavier than the value it
adds, the db-p2p two-node test is sufficient coverage; document the skip in the review handoff rather than
forcing a brittle stub.

## Validation

- `cd packages/db-core && yarn test` (or from root `yarn test:db-core`) — stream with `2>&1 | tee`.
- `cd packages/db-p2p && yarn test` (root `yarn test:db-p2p`). To iterate fast:
  `yarn test -- --grep "two-node replication"` from `packages/db-p2p`.
- Type-check is part of the ts-node test run (no separate tsc step in these packages).

## Review provenance

Filed from the review of `cohort-topic-gossip-cadence` (gap 1 in that ticket's "Known gaps"): the
gossip-cadence ticket's scope was the renewal `touch`/`evicted` hooks; admission-time replication is a
db-core member-engine change outside that scope, hence this follow-on.

## TODO

- [ ] Add optional `onAdmit?: (rec: RegistrationRecord) => void` to `CohortMemberEngineDeps`
      (`member-engine.ts`), with JSDoc noting symmetry with the renewal `touch` hook + last-writer-wins dedup.
- [ ] Call `this.deps.onAdmit?.(record)` in `accept()` right after `store.put(record)`.
- [ ] Wire `onAdmit: (rec) => pending.touch(rec)` in `createCoordEngine` (`host.ts`) alongside `onNotice`.
- [ ] Add the no-renewal two-node replication test to `gossip-cadence.spec.ts`.
- [ ] (Preferred) Add a focused `onAdmit`-fires-on-accept unit test to `member-engine.spec.ts`, or
      document the skip if the admit-stack composition is disproportionately heavy.
- [ ] `yarn test:db-core` + `yarn test:db-p2p` green (stream with `tee`).
