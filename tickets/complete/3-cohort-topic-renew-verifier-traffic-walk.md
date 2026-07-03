description: Four small cohort-topic fixes were reviewed and accepted — renewals now carry the registration's id, three attacker-influenced maps are memory-capped, a per-registration traffic scan is now indexed, and the sibling-retry no longer skips the best candidate.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts
  - packages/db-core/src/cohort-topic/service.ts
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/src/cohort-topic/gossip/view.ts
  - packages/db-core/src/cohort-topic/traffic.ts
  - packages/db-core/src/utility/lru-map.ts
  - packages/db-core/test/cohort-topic/walk.spec.ts
  - packages/db-core/test/cohort-topic/service.spec.ts
  - packages/db-core/test/cohort-topic/traffic.spec.ts
  - packages/db-core/test/cohort-topic/membership.spec.ts
  - docs/cohort-topic.md   # review added: verifier per-coord map cap now documented
difficulty: medium
----

# Complete: four assorted cohort-topic fixes (reviewed)

Adversarial review of the implement-stage change (commit `3883514`). Four independent low-severity
defects in the participant/cohort substrate, fixed in one change. **Accepted** — the implementation is
correct on all four; review added one documentation fix (below). Build green; `1118 passing, 0 failing`.

## What the change did (as reviewed)

- **(a) Renew echoes the accepted register's `correlationId`.** `AcceptedWalkOutcome` gained
  `correlationId`, populated from the admitted probe's frame (`walk.ts`); `service.startRenewal` threads
  it into the renewal instead of minting a fresh nonce. Matches the wire contract (`docs §Wire`, RenewV1
  "matches original RegisterV1"). Latent today — nothing reads renew `correlationId` on the cohort side.
- **(b) Verifier per-coord maps are LRU-capped.** `byCoord`, `lastFetchAt`, `staleGapStrikes` are now
  `LruMap` capped at `maxCoords` (default 100 000), bounding memory under a verify-miss flood against
  attacker-chosen coords. Constructor guards `maxCoords` as a positive integer (RangeError).
- **(c) Traffic snapshot is O(members + summaries).** `MapCohortView.merge` derives a per-member
  `topicId → summary` index (`indexTopics`, first-occurrence-wins); `traffic.snapshot` reads it O(1),
  falling back to the `.find` scan only for a contribution not built through `merge`.
- **(d) Sibling-retry consumes each fresh candidate list from its best (index-0) member.** The positional
  `candidates[memberAttempts % len]` counter is replaced by a tried-member `Set`; each `unwilling_member`
  reply dials the first untried candidate. The retry cap now gates on `triedMembers.size`.

## Review findings

**Verdict: accept.** No major findings; no new tickets filed. One minor doc fix applied in this pass.

### Checked — correctness

- **(a) No replay-guard collision.** Confirmed the cohort's `handleRenew` (`member-engine.ts:243`)
  delegates to `renewal.onRenew` and **never** consults the register `CorrelationReplayGuard` (that guard
  is register-path only, `member-engine.ts:404`). So a renew reusing the register's `correlationId`
  cannot be dropped as a replay of the register. The `AcceptedWalkOutcome.correlationId` field is
  constructed only at `walk.ts:217`; the similarly-named `willingness.ts:198` `{ kind: "accepted" }` is a
  different type — no compile fan-out. `service.lookup` builds no renewal, so the unused accepted id on
  that path is harmless (as the handoff noted).
- **(b) LRU eviction semantics correct.** `LruMap.get`/`set` refresh recency; `verifyMessage`'s cache
  read refreshes hot coords so a real cohort's coord is not evicted under normal load. The verifier's
  positive-integer guard is stricter than `LruMap`'s own `>= 1` check and runs first. Stored strike/clock
  values are always `>= 1`/wall-clock, so `LruMap.get`'s `value !== undefined` test never misfires on a
  falsy `0`. Independent (non-coherent) caps confirmed harmless — no code path assumes the three maps
  stay in sync; the only `delete` (`staleGapStrikes` on verify) is per-map.
- **(c) Index equivalence.** `indexTopics` first-occurrence-wins exactly matches the replaced
  `Array.find`. Confirmed the production merge path (`bus.mergeView` → `memberView.merge`) always routes
  through `merge`, which populates `topicIndex`; the `.find` fallback fires only for out-of-band
  contributions (tests). No other consumer of `topicSummaries` needed the index (only
  `traffic.snapshot` scanned per-member-per-reply).
- **(d) Retry bound preserved.** Tried-set grows by at most one distinct member per dial and gates at
  `>= maxMemberRetries`, so at most `maxMemberRetries` distinct dials — no regression vs the old counter,
  and strictly fewer dials when a cohort re-offers the same list. `triedMembers.clear()` on
  `no_state`/`promoted` mirrors the old `memberAttempts = 0` reset exactly.

### Checked — tests (a floor, exercised beyond happy path)

The 6 new tests are non-vacuous and cover the fix behaviors, edge cases, and one regression each:
duplicate-topicId first-wins (c); index-0 consumption across three fresh lists + retry-cap termination +
lone-sibling-dialed-once (d); RangeError on `0/-1/2.5/NaN` maxCoords + behavioral `byCoord` eviction under
a cap=4 flood forcing a re-TOFU source hit (b); wire-decoded correlationId equality register↔renew (a).
Accepted the handoff's documented partial coverage: `lastFetchAt`/`staleGapStrikes` are covered
**transitively** (same `LruMap`+`maxCoords` mechanism, unit-tested in `lru-map.spec.ts`) with no public
`size` seam to assert directly; the "no `.find` per member" win (c) is internal with no public seam. Both
are acceptable — correctness/equivalence is asserted, and adding indirect observables would need
test-only hooks not worth the surface. **No test gap rises to a ticket.**

### Found & fixed inline (minor) — documentation

- **`docs/cohort-topic.md` did not reflect (b).** The §Membership-snapshots verifier note described the
  cache but predated the new memory bound. Added one sentence documenting that the three per-coord caches
  are `LruMap`-capped at `maxCoords` (default 100 000, replay-guard ballpark) and evict LRU under an
  attacker-coord flood, cross-referencing the best-effort-trust-lock `NOTE:` in `verifier.ts`. The (a)
  wire contract was **already** correct in docs (§Wire RenewV1, line ~1402) — the code was the deviation,
  now aligned; no docs edit needed there.

### Tripwires (knowledge, not tickets — recorded at their code sites by the implementer, verified present)

1. **Verifier trust-lock eviction is best-effort under memory pressure** — `verifier.ts`, at the
   `byCoord`/LruMap cap comment. Under an attacker-coord flood the LRU can evict this node's own
   self-published *trusted* cert, re-opening that coord to TOFU on next sight. Mirrors the replay-guard
   cap tradeoff; safety-preserving (a former-member re-TOFU, never a forgery accept). Now also mentioned
   in the docs edit above.
2. **A future renew replay guard must key by `(correlationId, timestamp-window)`** — `service.ts`, at the
   renewal `correlationId` site. Every periodic renew for one registration shares the single register
   `correlationId`, so a guard that "drops any repeated correlationId" would reject the 2nd+ legitimate
   renew. Both are `NOTE:`-tagged for greppability.

### Empty categories (explicit)

- **No major findings** → no new fix/plan/backlog tickets. The four fixes are self-contained, correct,
  and the only behavioral changes are the intended ones.
- **No new tripwires** beyond the two the implementer already parked (verified in-tree).
- **No pre-existing test failures** — suite was `1118 passing, 0 failing` before and after; no
  `tickets/.pre-existing-error.md` written. The editor's hint-level `RingCoord` unused-import in
  `service.ts:25` is pre-existing, outside this diff, and does not fail `tsc`; left untouched.

## Validation run

`cd packages/db-core && yarn build && yarn test` → build clean; `1118 passing (15s), 0 failing`. The
review's only change was to `docs/cohort-topic.md` (no code touched, so the green suite still holds).
