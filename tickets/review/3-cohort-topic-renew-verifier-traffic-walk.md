description: Review four small cohort-topic fixes — a renewal now carries the registration's correlation id, three attacker-influenced lookup maps are now size-capped, a per-registration traffic scan is now indexed, and the walk's sibling-retry no longer skips the best candidate.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts                 # (a) AcceptedWalkOutcome.correlationId; (d) tried-member Set
  - packages/db-core/src/cohort-topic/service.ts              # (a) threads correlationId into the renewal
  - packages/db-core/src/cohort-topic/registration/renewal.ts # (a) correlationId stamped per renew (unchanged; consumes threaded id)
  - packages/db-core/src/cohort-topic/membership/verifier.ts  # (b) byCoord/lastFetchAt/staleGapStrikes → LruMap + maxCoords guard
  - packages/db-core/src/cohort-topic/gossip/view.ts          # (c) merge-time topic index (indexTopics)
  - packages/db-core/src/cohort-topic/traffic.ts              # (c) snapshot uses the index, not .find
  - packages/db-core/src/utility/lru-map.ts                   # (b) reused cap helper (unchanged)
  - packages/db-core/test/cohort-topic/walk.spec.ts           # (a),(d) tests
  - packages/db-core/test/cohort-topic/service.spec.ts        # (a) test
  - packages/db-core/test/cohort-topic/traffic.spec.ts        # (c) test
  - packages/db-core/test/cohort-topic/membership.spec.ts     # (b) tests
difficulty: medium
----

# Review: four assorted cohort-topic fixes

Four independent low-severity defects in the participant/cohort substrate were fixed in one change.
Build (`tsc`) and the full db-core test suite are green: **1118 passing, 0 failing** (adds 6 new tests).
Treat the tests as a floor, not a finish line — the areas to poke are called out per defect and in
"Known gaps / where to look hard" below.

## What changed, per defect

### (a) Renew now carries the accepted register's correlation id (was a fresh unrelated nonce)

- `walk.ts`: `AcceptedWalkOutcome` gained `readonly correlationId: string`; the `"accepted"` branch
  populates it from `reg.correlationId` — the frame the cohort just admitted (`walk.ts`, accepted case).
- `service.ts`: `handleFromOutcome` → `startRenewal(req, hint, correlationId)` threads that id into
  `createRenewalParticipant({ …, correlationId })`. The old `freshCorrelationId()` call there is gone and
  the stale defending comment is replaced with one citing the wire contract. `freshCorrelationId()` is
  **still used** for the per-probe register correlation id in `messageFactory` — left intact.
- **Direction chosen:** the *prescribed* one (code-to-match-docs). `docs/cohort-topic.md` §Wire already
  documents RenewV1 `correlationId // matches original RegisterV1` (~line 1402), so the docs were already
  correct — the code was the deviation. **No docs edit was needed.** The lighter "reconcile docs to the
  nonce" alternative was declined per the source ticket's explicit preference; the tradeoff is that a
  future renew replay guard now *can* correlate a renew to its registration.
- **Latent-only today:** nothing reads renew `correlationId` on the cohort side (verified: written at
  `renewal.ts:231`, wire-validated only). This makes the wire contract honest ahead of that guard landing.

### (b) The three verifier per-coord maps are now LRU-capped

- `verifier.ts`: `byCoord`, `lastFetchAt`, `staleGapStrikes` changed from plain `Map` to
  `LruMap<K,V>` (`../../utility/lru-map.js`), each capped independently at `maxCoords`.
- New dep `MembershipVerifierDeps.maxCoords?` (default `DEFAULT_MEMBERSHIP_VERIFIER_MAX_COORDS = 100_000`,
  the same ballpark as `DEFAULT_REPLAY_GUARD_MAX_KEYS`) with the sibling positive-integer `RangeError`
  guard in the constructor.
- Maps are capped **independently** (no cross-map coherence) — a documented, harmless staleness: a stale
  `lastFetchAt` permits at most one extra refetch; a stale strike count is itself bounded.

### (c) Traffic snapshot is now O(members + summaries), not O(members × summaries)

- `gossip/view.ts`: `MapCohortView.merge` derives a `topicIndex` (`topicId(b64) → summary`) via the new
  `indexTopics` helper and stores it on the `MemberContribution` (new optional `topicIndex?` field).
  **First-occurrence-wins** on a duplicate `topicId`, exactly matching the `Array.find` it replaces.
- `traffic.ts`: `snapshot` reads `contribution.topicIndex.get(topicB64)` (O(1)) instead of
  `.find`, falling back to the scan only for a contribution not built through `merge`. Writers pay the
  O(summaries) index cost once per gossip round; readers no longer pay it per reply.

### (d) Walk sibling-retry consumes each fresh candidate list from its best (index-0) member

- `walk.ts`: the positional `candidates[memberAttempts % candidates.length]` counter is replaced by a
  `Set<string>` of tried base64url member ids. Each `unwilling_member` reply dials the first candidate
  **not** in the set; the set resets on `no_state` and `promoted` (spatial moves), exactly where
  `memberAttempts` reset before. The retry cap now gates on `triedMembers.size >= maxMemberRetries`, and
  "no untried candidate / cap spent" falls through to the same temporal back-off as before.

## How to validate / use cases exercised

Run: `cd packages/db-core && yarn build && yarn test 2>&1 | tee /tmp/db-core-test.log`
(test invocation: `mocha "test/**/*.spec.ts"` via `register.mjs`).

New/behavioral tests added (per defect):
- **(a)** `walk.spec.ts` — accepted outcome surfaces the accepted probe's `correlationId`.
  `service.spec.ts` — a renew ping's `RenewV1.correlationId` equals the register's (decoded off both wires).
- **(b)** `membership.spec.ts` — `maxCoords` rejects `0 / -1 / 2.5 / NaN` (RangeError); and a behavioral
  cap test: a self-published (trust-locked) coord is evicted from `byCoord` under a burst of 4 distinct
  attacker coords at `maxCoords: 4`, forcing a re-TOFU source hit (observed via a per-coord source's
  call counter). `LruMap`'s own eviction mechanics are already unit-tested in `test/lru-map.spec.ts`.
- **(c)** `traffic.spec.ts` — snapshot over a member gossiping the same `topicId` twice keeps the FIRST
  summary (index equivalence with `.find`); asserts `merge` actually populated `topicIndex`.
- **(d)** `walk.spec.ts` — three successive `unwilling_member` replies with FRESH lists dial each list's
  index-0 member (A1/B1/C1, not A1/B2/C3); the retry cap still terminates with a back-off; a repeated
  lone sibling is dialed exactly once (not re-dialed).

## Known gaps / where to look hard (tests are a floor)

- **(b) map-cap coverage is partial by design.** Only `byCoord` eviction is asserted behaviorally;
  `lastFetchAt` and `staleGapStrikes` share the identical `LruMap`+`maxCoords` mechanism (unit-tested in
  `lru-map.spec.ts`) so they are covered *transitively*, not directly. If you want belt-and-suspenders,
  add a direct cap assertion for the aux maps — but there is no public `size` accessor on the verifier, so
  that would need either a test-only hook or another indirect observable. Reviewer's call whether the
  transitive coverage is enough.
- **(c) "does not call `.find` per member" is not asserted** — the win is internal and there is no public
  seam to observe it without a spy. Coverage asserts *correctness/equivalence* (including the duplicate
  edge) and that the index is built, not the absence of the scan. Consider whether that is sufficient.
- **(a)** worth confirming the accepted id also flows correctly on the **probe/lookup** path (it is
  produced there too but unused, since `lookup` builds no renewal) — no behavioral risk, but a reviewer
  eyeball on `service.lookup` → `hintFromReply` is cheap.

## Tripwires recorded (knowledge, NOT tickets — do not file)

Two conditional concerns were parked as `// NOTE:` at their code sites, per the source ticket's guidance:

1. **Verifier trust-lock eviction is best-effort under memory pressure** — `verifier.ts`, at the
   `byCoord`/LruMap cap site. Under an attacker-coord flood the LRU can evict this node's own
   `cache()`-published *trusted* cert, re-opening that coord to TOFU on next sight. Mirrors the documented
   replay-guard cap tradeoff; acceptable.
2. **A future renew replay guard must key by `(correlationId, timestamp-window)`** — `service.ts`, at the
   renewal `correlationId` site. Every periodic renew for one registration shares the *single* register
   correlation id (as it always did), so a guard that "drops any repeated correlationId" would reject the
   2nd+ legitimate renew.

Both are `NOTE:`-tagged for greppability. Neither is a queued task.

## Pre-existing state

No `tickets/.pre-existing-error.md` written — the suite was green before and after. The one hint-level
lint the editor surfaces (`RingCoord` unused import in `service.ts:25`) is **pre-existing** and untouched
by this change; the `tsc` build does not fail on it.
