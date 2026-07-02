description: A cohort node that hit its topic limit and dropped a topic used to keep serving it anyway, so the limit stopped bounding memory or the number of topics served. The drop now tears down the serving state with the slot; this reviews and completes that fix.
prereq:
files:
  - packages/db-core/src/cohort-topic/coldstart.ts             # ColdStartManager.remove(topicId)
  - packages/db-core/src/cohort-topic/traffic.ts               # TrafficCounters.forget(topicId)
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts  # TopicBudgetConfig.onEvict; fires before slot delete
  - packages/db-p2p/src/cohort-topic/host.ts                   # wires onEvict → coldStart.remove + traffic.forget (~1743)
  - packages/db-core/src/cohort-topic/member-engine.ts         # cold path admit/instantiate + touch invariant
  - packages/db-core/src/cohort-topic/promotion.ts             # demotion tripwire NOTE at demote() (~344)
  - docs/cohort-topic.md                                       # §Anti-DoS topic-budget bullet updated (~947)
difficulty: medium
----

# Complete: reconcile the cold-start forwarder set with the topic budget on eviction

## What shipped

A cohort member caps how many topics it holds forwarder state for (`topics_max`, default 2048). When the
cap is full and a new topic needs room, the budget evicts the coldest zero-participant resident. Before
this fix, eviction freed the *budget slot* but never tore down the *forwarder* — so `servesTopic()`
answered `true` off the leftover forwarder, the node served a topic with no budget slot forever, and the
forwarder map grew without bound.

The fix adds three db-core surface additions plus one db-p2p wiring:

- **`ColdStartManager.remove(topicId)`** (`coldstart.ts`) — drops the forwarder entry; idempotent.
- **`TrafficCounters.forget(topicId)`** (`traffic.ts`) — clears the topic's local windowed events + last-
  published summary; idempotent. Siblings' gossiped contributions age out on their own (intended).
- **`TopicBudgetConfig.onEvict?(topicId)`** (`topic-budget.ts`) — fired with the evicted topic's real
  bytes just before its slot is deleted, and only for a genuine eviction (a zero-participant victim).
- **host wiring** (`host.ts` ~1743) — `onEvict: (id) => { coldStart.remove(id); traffic.forget(id); }`.

## Review findings

Reviewed the full implement diff (`9099b88`) with fresh eyes before the handoff summary, then verified
the surrounding source the diff did not show.

**What was checked:**

- **Correctness of the eviction hook.** Read `topic-budget.ts` in full. `onEvict` fires at line 120,
  synchronously, *before* `residents.delete(victim)` (line 121), only after `coldestEvictable()` returns
  a victim — so it never fires on a plain admit, an already-resident re-admit, or a refusal. The wired
  callback does only two map deletes (`coldStart.remove` + `traffic.forget`), so it cannot throw and does
  not re-enter the budget. Confirmed correct.
- **The core safety invariant** — "evicting the forwarder can't strand live records." Eviction only ever
  picks a `participantCount === 0` resident (`coldestEvictable()` skips populated ones). Traced the
  budget's `participantCount` back to `store.directParticipants`: `member-engine.ts` calls
  `topicBudget.touch(topicId, store.directParticipants(topicId))` **synchronously right after**
  `store.put` in `accept()` (line 338) and on the hot path, plus on the gossip/sweep cadence (lines 253,
  279). So a budget count of 0 corresponds to `directParticipants === 0` at every synchronous point — the
  reverse (count 0 while records exist) cannot arise, because every accept touches. The only lag is TTL
  expiry, which moves the *safe* direction (budget still reads high → not yet evictable). The handoff's
  safety reasoning holds; removing the forwarder on eviction never tears down a topic with live records.
- **`servesTopic` reconciliation.** Confirmed both engine (`member-engine.ts:401`) and host
  (`host.ts:1896`) compute serving as `directParticipants > 0 || coldStart.get(...) !== undefined`. After
  eviction removes the forwarder for a zero-participant topic, serving flips cleanly to false and a
  re-register re-enters the cold path and re-runs `topicBudget.admit` — asserted by the engine test.
- **Host wiring order / closure capture.** `traffic` is declared at `host.ts:1675`, `coldStart` at 1709,
  `topicBudget` at 1743 — both captured instances are live before the closure is built. Confirmed.
- **The engine test premise is real, not fictional.** The RED→GREEN test declines willingness to keep
  residents at participantCount 0. Verified this matches the production cold path exactly
  (`handleRegister`: `admit` → `instantiate` → `admitOrDecline`); a declined register instantiates the
  forwarder and takes a budget slot but adds no store participant — a genuine evictable resident.
- **No other leak sites.** `createTopicBudget` has exactly one production caller (`host.ts:1743`), now
  wired. No other construction path lacks the teardown hook.
- **Tests run.** db-core: `yarn build:db-core` + `yarn test` → **1054 passing, 0 failing**. db-p2p:
  `yarn build:db-p2p` + `yarn test` → **1097 passing, 36 pending, 0 failing**. Both match the handoff's
  reported counts. New unit + engine coverage (12 tests) inspected and sound.
- **Lint.** No lint is configured in this repo — the root `lint` script is a placeholder
  (`echo 'Lint not configured for all packages'`) and neither `db-core` nor `db-p2p` defines its own.
  Nothing to run; TypeScript builds are clean (exit 0).

**What was found and done:**

- **Minor — stale doc, FIXED inline.** `docs/cohort-topic.md` §Anti-DoS topic-budget bullet (~line 947)
  described eviction as only freeing the slot ("topics with zero recent registrations are dropped first")
  and never mentioned the forwarder/traffic teardown this fix adds — exactly the gap that was the bug.
  Updated the bullet to state that eviction also tears down the cold-start forwarder + traffic window via
  the `onEvict` hook, so the served-topic set stays bounded.
- **Coverage-depth gap → backlog `debt-` ticket.** No full-host test drives a real eviction end-to-end at
  the db-p2p layer (the `host.ts` wiring is type-checked; the identical closure is fully tested at the
  db-core engine layer). The implementer also flagged that the engine test uses willingness-decline rather
  than an accept→drain→evict lifecycle. Both are integration-depth coverage, not defects — folded into
  `tickets/backlog/debt-cohort-topic-host-eviction-teardown-test.md`.
- **Tripwire — demotion teardown (already recorded by the implementer, confirmed).** The `NOTE:` at
  `promotion.ts` `demote()` (~344) correctly warns that demotion today resets only the promoted-bounce
  clocks and does not stop serving; if demotion is ever made to collapse the tier, it must reassign/drain
  records first, then `coldStart.remove` + release the budget slot + `traffic.forget`, in that order.
  Verified the note is accurate and parked at the truest single site. No ticket (conditional on future
  work) — left as-is.
- **Correctness bugs: none.** No security, resource-cleanup, type-safety, or error-handling defects found.
  The `forget()`-clears-only-local behavior is intended, documented, and asserted (not a leak). The
  "freshly-admitted count-0 topic evicted by a concurrent register" case the handoff noted is not
  reachable: the fresh topic is touched to its real count synchronously in `accept()` before any await, so
  it never sits at count 0 with live records.

## Follow-ups

- `tickets/backlog/debt-cohort-topic-host-eviction-teardown-test.md` — host-layer end-to-end eviction
  test + accept→drain→evict lifecycle coverage.
