description: A node's list of topics it forwards for during startup only ever grows and is never reconciled with the topic-hosting budget, so an evicted topic keeps being served for free and the budget stops bounding either memory or the number of topics actually served.
prereq:
files:
  - packages/db-core/src/cohort-topic/coldstart.ts            # ~166-199 — TrackingColdStartManager, no removal API
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts # ~100-109 — admit()/eviction
  - packages/db-core/src/cohort-topic/member-engine.ts        # ~400-402 — serves() consults forwarder residency
difficulty: medium
----

# Topic budget and cold-start forwarders never reconcile

## The problem

`TrackingColdStartManager` (`coldstart.ts:166-199`) has **no removal API** — its forwarders map only
ever grows. Neither topic-budget eviction, nor demotion, nor TTL drain deletes an entry. The two ledgers
that must agree — the topic budget (bounds served topics) and the forwarder set (records which topics are
served) — drift apart permanently.

Concretely: when `topicBudget.admit()` evicts a cold victim to make room, the victim's forwarder stays
resident, so `serves()` still answers `true` for the evicted topic. Registers for that topic then take
the hot path and **bypass `topicBudget.admit` forever** — the budget no longer bounds either memory (the
forwarder map is unbounded) or the set of topics actually served.

This is adjacent to, but distinct from, complete ticket `cohort-topic-topic-budget-eviction-leak`
(which released budget *slots* on drain and explicitly noted `servesTopic` stays `true` after a slot is
released). That residency mismatch is the live defect here.

## Expected behavior

The forwarder/traffic-window residency and the budget must stay reconciled. Either:

- Give `TopicBudget` an eviction callback that tears down the evicted victim's cold-start forwarder and
  traffic window (so `serves()` flips to `false` and registers re-enter the budget path), or
- Derive `serves()` residency from the budget itself, so there is a single source of truth.

Cover demotion and TTL-drain paths too, not just budget eviction — any path that stops the node serving a
topic must also drop its forwarder entry.

## Repro sketch

- Fill the budget so `admit()` evicts a cold topic.
- Register for the evicted topic → observe it still takes the hot path (`serves()` true) and never
  re-consults the budget; observe the forwarder map never shrinks.
- With the fix, the evicted topic's forwarder is gone, and a re-register goes through `topicBudget.admit`.
