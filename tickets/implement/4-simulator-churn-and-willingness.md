description: Simulator churn generator, primary/backup failover, re-registration jitter, partition heal, and per-member willingness back-off under load (shared state).
prereq: simulator-cohort-topic-tree
files:
  - docs/cohort-topic.md
effort: high
----

# Simulator churn generator, failover, and willingness back-off model

Churn and willingness are implemented **together** because they share per-member state: churn drives load and failover, and willingness gates admission under that load. This answers the GROUNDING willingness-back-off, partition-heal-latency, and willingness-gossip-lag timing questions. Builds on `simulator-cohort-topic-tree` (willingness vectors, load barometer, promotion) and the event clock (arrival/departure timing, TTL cycles, gossip latency).

This ticket is a sibling of `simulator-participant-walk` at the same sequence; both depend only on the tree and are independent of each other (the walk owns the lookup path + anti-flood hop instrumentation; this owns the population dynamics + willingness state). The metrics/scenario ticket composes both.

## Churn generator (cohort-topic.md §Failure modes ~L274–282, §Anti-flood ~L390)

- Configurable churn rate (% of population per minute) and per-hop latency jitter, all drawn from the seeded RNG.
- Peer arrival → placed on the ring (FRET store update via `simulator-fret-cohort-model`), triggers cohort (re)assembly event.
- Peer departure (clean or crash) → removed; cohorts holding its registrations detect via TTL.

```ts
interface ChurnConfig {
	churnPctPerMin: number;
	latencyJitterMs: number;
	partitionEvents?: PartitionSpec[];   // optional injected partitions + heals
}
```

## TTL / renewal / failover (cohort-topic.md §TTL and renewal, §Membership rotation and primary handoff)

- Participant pings primary every `ttl/3`. Three consecutive failures → promote `backups[0]` via re-attach.
- Primary failure → `backups[0]`; participant learns of the move via `RenewReplyV1.primary_moved` and repoints within the `ttl/3` renewal window.
- Membership rotation refreshes `cohortEpoch`; deterministic primary/backup via `hash(participantId ‖ cohortEpoch) mod k`. Handoff: compute new assignment, exchange inventory, pull records, dual-serve until ack.
- Cohort-side eviction when `now − lastPing > ttl`. Edge TTL 60s / Core 90s defaults.

GROUNDING-resolved behaviours to model: backup failover refreshes the `cohortEpoch` hint on the **next ping** (not eagerly); previous primary serves until the new primary acks.

## Partition heal

A network partition splits a cohort into two disjoint memberships; on heal they merge. Model deterministic primary re-assignment via `hash(participantId ‖ cohortEpoch) mod k` so both sides converge to the same assignment in ~one gossip round. Measure heal latency and whether subscribers repoint within `ttl/3`.

## Willingness back-off (cohort-topic.md §Willingness ~L170, §Capacity barometer ~L198)

- Per-member, per-tier willingness bits (4-bit T0..T3) with Edge (T0+T1) / Core (all) profiles, from the tree ticket — this ticket drives them under churn-induced load.
- Under a burst pushing the load barometer to `bucket_overload` (6), `UnwillingCohort` with `retryAfter` staggers re-registration. Model an exponential back-off curve and measure that it minimizes repeated rejections while still admitting promptly when capacity frees.
- Willingness-gossip staleness ~1 heartbeat: a member may have just become unwilling while a sibling still gossips it as willing. Model the staleness and exercise the edge case (seeker routed to a stale-willing backup gets `UnwillingMember`, then retries/back-off).

## Doc sync

- `docs/cohort-topic.md` §Failure modes: add a "Recovery time bounds" forward note (backup-promotion window, partition-heal convergence) to be filled with measured latencies by `fold-simulator-findings-into-design-docs`.
- `docs/cohort-topic.md` §Willingness: forward note that the back-off curve is simulator-validated.

## TODO

### Phase 1 — churn + TTL
- Implement the churn generator (arrival/departure scheduled events, churn %, latency jitter) over the seeded RNG and the FRET store from `simulator-fret-cohort-model`.
- Implement TTL renewal (ping at `ttl/3`), three-failure backup promotion, and cohort-side stale eviction, with Edge/Core TTL defaults.

### Phase 2 — failover + partition
- Implement deterministic primary/backup via `hash(participantId ‖ cohortEpoch) mod k`, membership-rotation handoff (dual-serve until ack), and `primary_moved` repointing.
- Implement partition split/heal with deterministic primary re-assignment and `cohortEpoch` refresh.

### Phase 3 — willingness back-off + doc sync
- Drive per-member willingness under churn load; implement exponential `UnwillingCohort` back-off and ~1-heartbeat willingness-gossip staleness.
- Add the *Done when* tests; add the forward-note edits to `docs/cohort-topic.md` §Failure modes and §Willingness.

## Done when

- `yarn build` green; ES modules, no `any`, tabs.
- `yarn test` passes, including:
  - **Backup promotion within window:** a primary failure promotes `backups[0]` and the participant repoints within the `ttl/3` renewal window.
  - **Partition heal convergence:** after a heal, both memberships converge to the same deterministic primary assignment in ~one gossip round; subscribers detect the move via `primary_moved`.
  - **Willingness gating, no cascade:** under a load burst, `UnwillingCohort` gating drops accepted/sec to a capacity-matched level without a cascading load increase.
  - **Back-off curve:** the exponential back-off minimizes repeated rejections per participant while still admitting promptly once capacity frees (assert rejection-count and time-to-admit bounds).
  - **Gossip-lag edge case:** a routed-to-stale-willing backup returns `UnwillingMember` and the participant recovers via retry/back-off.
