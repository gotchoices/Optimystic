description: A freshly *admitted* registration record is not gossiped at admission time — it only enters the per-coord gossip delta queue on its first renewal touch (≤ ttl/3 ≈ 30 s). If the accepting primary crashes inside that window the record has no replica, so the participant is lost until it re-registers. Close the durability window by replicating an accepted record at accept time (not just on the first touch).
prereq:
files:
  - packages/db-core/src/cohort-topic/member-engine.ts (accept() persists the record via store.put but never calls a gossip hook)
  - packages/db-core/src/cohort-topic/registration/renewal.ts (RenewalGossip.touch/evicted — the only current producers of gossip record deltas)
  - packages/db-p2p/src/cohort-topic/host.ts (createCoordEngine wires gossip.touch → pending.touch; gossipRound drains the queue)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (createPendingDeltas / buildCohortGossip)
----

# Replicate an accepted cohort record at admission time, not only on first renewal touch

## Problem

The gossip-cadence work (gap 5) wired per-touch replication: the renewal cohort side's
`gossip.touch`/`gossip.evicted` hooks append registration-record deltas to a per-coord queue that the
host's periodic driver drains into one signed `CohortGossipV1` per round. That covers records that have
been **renewed** at least once.

It does **not** cover a record between **admission and its first renewal**. `CohortMemberEngine.accept`
(`member-engine.ts`) persists the new record with `store.put(record)` but fires no gossip hook. The
record therefore first enters the replication delta queue on its first cohort-side renewal touch, which
the participant sends every `ttl/3` (≈ 30 s for the 90 s Core TTL). The per-round gossip frame a resident
topic emits in the interim carries only the topic **summary** (`directParticipants` count, rates), never
the record itself (`primary`/`backups`/`participantId`/`appState`) — so no sibling can take over as
primary for it.

Consequence: if the accepting primary crashes (or its slot rotates away) inside that ~30 s window, no
cohort member holds a replica of the just-admitted record. The participant's registration silently
vanishes until it notices the dead primary and re-registers. This defeats the point of cohort
replication for exactly the records most likely to be in flight during churn.

## Expected behavior

An accepted registration record should be replicated to the cohort promptly after admission — at the
next gossip round at the latest — independent of the first renewal touch. A primary crash immediately
after `accepted` should leave a replica from which `backups[0]` (or a re-lookup) can recover the record.

## Notes / shape (for the implementer, not prescriptive)

- The natural seam is an admission-time gossip hook symmetric to the renewal `touch` hook: have
  `accept()` enqueue the freshly-`put` record the same way `touchAndServe` does. `member-engine.ts`
  does not currently take a `RenewalGossip`-style dependency, so this likely means threading the same
  per-coord delta queue (or a small `onAdmit(rec)` port) into the member engine and wiring it in
  `createCoordEngine` (host.ts) alongside the existing `gossip.touch`/`gossip.evicted` wiring.
- Keep it a queue append (drained by the existing round), not a synchronous broadcast — admission must
  not block on a gossip round, and last-writer-wins by `lastPing` already dedupes an admit-then-touch in
  the same round.
- Cover with a test that a record is present in a sibling's store after a single gossip round following
  `accepted`, with **no** intervening renewal — the gap the current two-node test deliberately steps
  around by using a re-attach touch.

## Review provenance

Filed from the review of `cohort-topic-gossip-cadence` (gap 1 in that ticket's "Known gaps"). The
gossip-cadence ticket's stated scope was the renewal `touch`/`evicted` hooks; admission-time replication
is a db-core member-engine change outside that scope, hence this follow-on.
