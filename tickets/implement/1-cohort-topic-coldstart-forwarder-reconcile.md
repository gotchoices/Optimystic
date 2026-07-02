description: When a node runs out of room and drops a topic it was hosting, it keeps quietly serving that topic anyway and stops counting it against its capacity limit — so the limit no longer bounds memory or the number of topics the node actually serves. Wire the drop so hosting state is torn down with the slot.
prereq:
files:
  - packages/db-core/src/cohort-topic/coldstart.ts             # add ColdStartManager.remove(topicId)
  - packages/db-core/src/cohort-topic/traffic.ts               # add TrafficCounters.forget(topicId)
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts  # add TopicBudgetConfig.onEvict; fire on eviction
  - packages/db-core/src/cohort-topic/member-engine.ts         # serves() / admit() cold path (context; no change expected)
  - packages/db-p2p/src/cohort-topic/host.ts                   # wire onEvict → coldStart.remove + traffic.forget (~1675/1709/1737)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts   # RED→GREEN reproduction through the engine
  - packages/db-core/test/cohort-topic/antidos.spec.ts         # unit coverage for onEvict callback
  - packages/db-core/test/cohort-topic/coldstart.spec.ts       # unit coverage for remove()
  - packages/db-core/test/cohort-topic/traffic.spec.ts         # unit coverage for forget()
difficulty: medium
----

# Reconcile the cold-start forwarder set with the topic budget on eviction

## Plain-language summary

A cohort member caps how many topics it will host forwarder state for (`topics_max`, default 2048).
When that cap is full and a new topic needs room, the budget **evicts** the coldest hosted topic to
free a slot. The bug: eviction frees the *budget slot* but never tears down the *forwarder* for the
evicted topic. The node's "do I serve this topic?" check answers `true` off the leftover forwarder, so
the node keeps serving a topic it has no budget slot for — and registers for it take the hot path and
never re-consult the budget again. The budget stops bounding both memory (the forwarder map grows
without limit) and the set of topics actually served.

## Root cause (verified by reading the code)

Two collaborators must agree and don't:

- **The forwarder set** — `TrackingColdStartManager.forwarders` (`coldstart.ts:176`), a `Map` that is
  written by `instantiate()` and has **no removal API**. It only ever grows.
- **The topic budget** — `LruTopicBudget.residents` (`topic-budget.ts:66`), which `admit()`
  (`topic-budget.ts:89-110`) evicts from when full.

"Does this cohort serve the topic?" is answered in two byte-identical places:

```
// member-engine.ts:400-402
private serves(topicId) {
  return this.deps.coldStart.get(topicId) !== undefined || this.deps.store.directParticipants(topicId) > 0;
}
// host.ts:1883-1884  servesTopic: same expression
```

The register decision pipeline (`member-engine.ts:154-196`):

1. Hot path — if `serves(topicId)`, admit directly (`admitOrDecline`), which on `accept` calls
   `topicBudget.touch(...)`. **`touch` is a no-op for a non-resident topic** (`topic-budget.ts:115-117`).
2. Cold path — only reached when `!serves(topicId)`; this is the **only** path that calls
   `topicBudget.admit()` (confirmed: `admit()` has exactly one caller in the cohort-topic code,
   `member-engine.ts:190`).

So once `admit()` evicts topic X's budget slot while X's forwarder survives:

- `serves(X)` stays `true` (via `coldStart.get(X)`).
- Every subsequent register for X takes the **hot path**, so `admit()` is never called for X again;
  its only budget interaction is `touch()`, which no-ops because X is no longer resident.
- X is served forever with **no** budget slot. The budget bounds neither the forwarder map (unbounded)
  nor the served-topic set.

This is the residency mismatch that the completed ticket
`cohort-topic-topic-budget-eviction-leak` explicitly left open (its review noted "a never-demoted
tier-0 forwarder keeps `servesTopic` `true` even after the budget slot is released"). That ticket fixed
the *slot* leak (down-touch on drain); this ticket fixes the *forwarder* leak.

## Why eviction is the only path that needs a teardown hook

Walked every path that changes serving state:

- **Budget eviction (the live defect).** Fix here. See below.
- **TTL drain — no separate hook needed.** `sweepStale` (`member-engine.ts:258-283`) plus the gossip
  sibling-drain callback (`host.ts:1522-1526`) already down-`touch` the budget to `0` when a topic's
  last participant leaves. The forwarder stays resident, but so does the budget slot (now count 0), so
  the two ledgers still **agree**. A re-register for a drained-but-resident topic takes the hot path,
  `accept()` up-touches the still-resident slot back to 1 — correct, no drift. The forwarder is only
  ever removed when the budget later *evicts* that cold slot, which the eviction hook now covers. A
  drained-but-resident forwarder is therefore not drift; do **not** add a drain-time forwarder removal.
- **Demotion — no live teardown path today; do NOT hook it.** `demote()` / `applyDemotionNotice()`
  (`promotion.ts:336-361`, `240-250`) only reset the `promoted` / `promotedAt` / `lowLoadSince` flags —
  i.e. they stop the `Promoted(d+1)` bounce. They perform **no** teardown of local serving state: the
  forwarder and the direct-participant records stay, and the cohort keeps serving the topic at tier `d`.
  There is currently no demotion path that "stops the node serving a topic," so there is nothing to
  reconcile. Record a tripwire (below) for when demotion is later made to actually collapse local tier
  state — at that point it must reassign/drain records **first**, then remove the forwarder + release the
  budget slot + forget the traffic window, in that order (removing the forwarder while records remain
  would re-introduce the exact off-budget drift this ticket fixes).

## Why removing the forwarder on eviction is safe (no residual serving)

`admit()` only ever evicts a **zero-participant** resident — `coldestEvictable()`
(`topic-budget.ts:126-139`) skips any resident whose `participantCount > 0`. The budget's
`participantCount` is reconciled from `store.directParticipants(...)` on every mutation (up-touch in
`accept()`, down-touch on drain/withdraw/sweep), so an evictable topic's store count is also `0`.
Therefore, after removing the evicted topic's forwarder, `serves()` evaluates
`coldStart.get(X) === undefined && store.directParticipants(X) === 0` → **false**, cleanly, with no
orphaned records. A follow-up register for X now takes the cold path and re-enters `topicBudget.admit`.

## The fix (recommended: eviction callback)

Chosen over "derive `serves()` from the budget" because the budget is **optional** (`topicBudget?` — many
unit/mock flows and the key-less interim run without one), and budget residency is not a 1:1 mirror of
the forwarder set (root tier-0 forwarders, store-only participants). An eviction callback is localized
and mirrors the `onRecordsEvicted` reconciliation pattern the eviction-leak ticket already established.

**db-core surface additions:**

```ts
// coldstart.ts — ColdStartManager
/** Drop the forwarder for `topicId` (budget eviction / teardown). Idempotent; no-op if absent. */
remove(topicId: Uint8Array): void;

// traffic.ts — TrafficCounters
/** Drop all local windowed counts + last-published summary for `topicId` (topic no longer served). */
forget(topicId: Uint8Array): void;

// topic-budget.ts — TopicBudgetConfig
/**
 * Called with the evicted topic's id just before its slot is freed in `admit()`, so the caller can
 * tear down the now-unbacked forwarder + traffic window. Fires only for a genuine eviction (a
 * zero-participant victim), never for a plain admit or a refusal. Absent → no teardown hook.
 */
onEvict?: (topicId: Uint8Array) => void;
```

- `topic-budget.ts`: `ResidentState` currently keys by `bytesKey` string only. Capture the original
  `Uint8Array topicId` on `admit()` so `onEvict` can be handed real bytes. In the eviction branch
  (`topic-budget.ts:101-108`), read the victim's stored bytes, fire `onEvict(victimBytes)`, then delete +
  insert the new topic. Fire **before** the delete so the callback sees a coherent state.
- `traffic.ts`: `forget` deletes the topic's entry from both `windows` and `lastPublished`. (The
  gossip-derived `snapshot` sibling contributions age out on their own; nothing else to clear.)

**db-p2p wiring (`host.ts`):** `traffic` (1675) and `coldStart` (1709) are both declared before
`topicBudget` (1737), so wire the callback directly at the `createTopicBudget` call — no forward-const
trick needed:

```ts
const topicBudget = createTopicBudget({
  ...ctx.antiDos.topicBudget,
  onEvict: (topicId: Uint8Array): void => {
    coldStart.remove(topicId);
    traffic.forget(topicId);
  },
});
```

Confirm `createTopicBudget` / `TopicBudgetConfig` spread merges cleanly with the existing
`ctx.antiDos.topicBudget` (which today is just `{ topicsMax? }`).

## Tests

- **RED→GREEN through the engine** (`member-engine.spec.ts`): construct an engine with a small
  `topicsMax` budget wired with `onEvict → coldStart.remove + traffic.forget`, plus a real
  `coldStart` + `traffic`. Cold-start-instantiate up to `topicsMax` zero-participant topics, then
  register one more to force an eviction. Assert: (a) the evicted topic's forwarder is gone
  (`coldStart.get(evicted) === undefined`), (b) `serves(evicted)` is now false — a register for it
  re-enters the cold path / `topicBudget.admit` (spy or observe `admit` called again), (c) the
  forwarder map size stays bounded by `topicsMax`. Confirm this test FAILS before the fix.
- **`antidos.spec.ts`**: unit-test that `admit()` fires `onEvict` exactly once with the evicted
  topic's bytes on a full-budget eviction, and does **not** fire it on a plain admit, an already-resident
  re-admit, or a refusal (full-of-populated-topics).
- **`coldstart.spec.ts`**: `remove()` drops the entry (`get` → undefined afterward) and is idempotent /
  safe on an absent topic.
- **`traffic.spec.ts`**: `forget()` clears windowed + last-published counts (a subsequent `published`
  returns zeros; `snapshot` no longer includes the forgotten local contribution).

## Tripwire to record (not a ticket)

Add a `NOTE:` comment at the demotion teardown site (`promotion.ts` `demote()` and the host
`demotionTick` / `applyDemotionNotice` wrappers, whichever the implementer judges the truest single
site) capturing: *demotion currently resets only the promoted-bounce flags and does not stop local
serving; if/when demotion is made to actually collapse the tier, it must reassign or drain the topic's
records first, then `coldStart.remove` + release the budget slot + `traffic.forget` — removing the
forwarder while records remain re-creates the off-budget-serving drift fixed in this ticket.* Mention
this in the review handoff's findings index.

There is also a narrow, pre-existing interleaving (independent of this fix): a register that awaits
`willingness.evaluate` between its `admit()` and `accept()` could, in principle, have its freshly-admitted
count-0 topic evicted by a concurrent register — but the fresh topic carries the highest `seq`, so
`coldestEvictable()` picks it last. Not reachable in practice; note only if the implementer touches that
region.

## TODO

- [ ] `coldstart.ts`: add `remove(topicId)` to `ColdStartManager` interface + `TrackingColdStartManager`.
- [ ] `traffic.ts`: add `forget(topicId)` to `TrafficCounters` interface + `WindowedTrafficCounters`.
- [ ] `topic-budget.ts`: add `onEvict?` to `TopicBudgetConfig`; store original `topicId` bytes in
      `ResidentState`; fire `onEvict(victimBytes)` before the delete in `admit()`'s eviction branch.
- [ ] `host.ts`: wire `onEvict → coldStart.remove + traffic.forget` at the `createTopicBudget` call.
- [ ] Add the RED→GREEN engine reproduction test; confirm it fails pre-fix, passes post-fix.
- [ ] Add unit coverage for `onEvict` (antidos), `remove` (coldstart), `forget` (traffic).
- [ ] Add the demotion tripwire `NOTE:` comment.
- [ ] `yarn build:db-core && yarn build:db-p2p`; `yarn test` in db-core and db-p2p — stream with `tee`.
      Report pass counts in the review handoff.
