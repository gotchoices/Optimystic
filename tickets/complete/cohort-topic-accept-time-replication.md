description: Make a freshly-admitted topic registration start replicating to sibling nodes immediately, instead of waiting up to ~30s for the participant's first renewal — so a crash right after admission no longer silently loses the registration.
files:
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts
  - packages/db-core/test/cohort-topic/member-engine.spec.ts
  - docs/cohort-topic.md
----

## What was built

Closed the durability window between a participant's `accept` and its first renewal touch (~30 s for the 90 s Core TTL). Previously a freshly-admitted record was never queued for gossip until the participant's first `touchAndServe`; if the accepting primary crashed in that window the registration was silently lost.

- **`member-engine.ts`** — added `onAdmit?: (rec: RegistrationRecord) => void` to `CohortMemberEngineDeps`; called in `accept()` immediately after `store.put(record)`, symmetric to the renewal `gossip.touch` hook.
- **`host.ts`** — wired `onAdmit: (rec) => pending.touch(rec)` into `createCoordEngine`'s engine, feeding the same per-coord `pending` delta queue the renewal side uses (last-writer-wins by `lastPing`).
- Tests: a no-renewal two-node replication test in `gossip-cadence.spec.ts`; two `onAdmit` unit tests (fires on `accepted`, not on `unwilling_cohort`) in `member-engine.spec.ts`.

## Review findings

### Reviewed (fresh-eyes pass over the implement diff `68e6ac3`)

- **Producer placement / SPP.** `onAdmit` fires only in the local `accept()` path. Audited every `store.put` site in `packages/db-core/src/cohort-topic` (`member-engine.ts:253`, `gossip/bus.ts:192`, `registration/handoff.ts:124`, `registration/renewal.ts:314,346`). The gossip-ingestion put (`bus.ts:192`) correctly does **not** call `onAdmit`, so a replicated record does not re-enqueue itself — no gossip storm / amplification loop. Renewal and handoff paths are untouched and unaffected. ✅
- **Last-writer-wins claim.** Verified against `cohort-gossip-driver.ts:62-70`: `pending.touch` keeps the record with the newest `lastPing` and a live touch deletes a pending eviction. The JSDoc/comments' "admit-then-touch in the same round dedupes" claim is accurate. Edge cases walked: admit-then-touch (newer `lastPing` wins), evict-then-admit (admit's touch supersedes the eviction), admit-then-evict same round (eviction supersedes via `evicted()` deleting the record). All handled by existing queue semantics. ✅
- **Type safety / build.** Hook is optional, `void`-returning; `tsc` build is clean for both `db-core` and `db-p2p`. ✅
- **Error handling / resource cleanup.** `onAdmit` is a synchronous queue append after the record is durable locally; it cannot reject the register path and adds no new resources to clean up. ✅
- **Tests.** `db-core` 880 passing (incl. 2 new unit tests); `db-p2p` 849 passing, 29 pending (incl. the new no-renewal replication test). The logged `parent unreachable` line during the db-p2p run is an expected in-test error from `host-antidos-coldstart.spec.ts` (cold-start failure path), not a failure. The implementer's note that the pre-existing `'a gossip round drains a touched record'` test still holds was confirmed by the green run. ✅

### Found & fixed inline (minor)

- **Stale doc — `docs/cohort-topic.md` §Cadence (host driver), ~L1148-1156.** The prose still described the *old* behavior: "A freshly *admitted* record first replicates on its next renewal touch (the per-touch path), **not at admission time**," and the delta-drain sentence listed only the renewal `touch`/`evicted` hooks. This is exactly the behavior the ticket reversed. Updated to: deltas are drained from the admission `onAdmit` *and* renewal `touch`/`evicted` hooks, and an admitted record is enqueued at admission time and replicates on the next gossip round without waiting for the first renewal — closing the `accept`→first-touch window. No other doc passage framed this window as a known gap.

### Observed, not actioned (not blocking)

- **Unit-test coverage breadth.** The new `member-engine.spec.ts` tests cover the `accepted` (fires) and `unwilling_cohort` (no-fire) branches. They do not separately assert no-fire for `unwilling_member` or the anti-DoS guard rejections (`no_state`). This is low-value: `onAdmit` is structurally inside `accept()`, reachable only past `runGuards` and a willingness `accepted` outcome, and the `unwilling_cohort` test already proves the gating. Not worth additional tests.

### Major findings → new tickets

None. The change is well-scoped, correct, and symmetric with the existing renewal producer. No `fix/`/`plan/`/`backlog/` tickets filed.

## Validation summary

- `cd packages/db-core && yarn build && yarn test` — 880 passing.
- `cd packages/db-p2p && yarn build && yarn test` — 849 passing, 29 pending.
- Root `lint` is an `echo` stub (not configured); `tsc` build is the type-check and is clean for both packages.
