description: Simulator participant walk-toward-root engine with anti-flood instrumentation — counts hops, validates the five anti-flood claims, detects cold-start and re-registration storms.
prereq: simulator-cohort-topic-tree
files:
  - docs/cohort-topic.md
effort: high
----

# Simulator participant walk-toward-root engine and anti-flood instrumentation

Simulates the cohort-topic lookup walk and instruments it to **quantitatively validate the five anti-flood claims** from `docs/cohort-topic.md` §Anti-flood properties (~L385–395). This answers the GROUNDING cold-start / jitter / hop-count timing questions. Builds on `simulator-cohort-topic-tree` (tree state, promotion, willingness) and the event clock (per-hop latency, jitter scheduling).

## The walk (cohort-topic.md §Tree growth and lookup ~L105–144)

A participant walks **toward the root** from `d_max`:

```
d = d_max
loop:
  C = coord_d(self, topicId)
  reply = probe(C)            // one RPC, latency from LatencyModel
  switch reply:
    Accepted          → done (record hops, latency)
    NoState           → d -= 1 (walk inward toward root)
    Promoted(d+1)     → d += 1 (single-direction redirect outward; only outward move allowed)
    UnwillingMember   → retry sibling / back off per retryAfter
    UnwillingCohort   → wait retryAfter; on retry, RESTART at d_max (not same coord)
  if d < 0 → register at root with bootstrap:true (cold-root)
```

Single-direction semantics: the only outward move is following a `Promoted` redirect; the walk otherwise moves strictly inward. Inward-retry after `UnwillingCohort` restarts at `d_max` (decorrelates retry traffic across the ring).

## Instrumentation

```ts
interface WalkTrace {
	participant: PeerRef;
	topicId: TopicId;
	hops: number;                 // RPC count for this walk
	latency: VTime;               // total virtual time
	startCoord: RingCoord;        // coord_{d_max}(self, topicId)
	outcome: 'accepted' | 'cold-root' | 'gave-up';
	redirects: number;            // Promoted follows
	backoffs: number;             // Unwilling* waits
}
```

Per-walk traces feed the metrics engine for hop CDFs and accepted/sec rate curves.

## The five anti-flood claims to validate quantitatively

1. **Cold-start storm avoidance.** All participants probe `d_max` *first*, not the root. In the sparse regime each participant's `coord_{d_max}` differs (different peer-ID prefix), so walks fan across the ring rather than colliding at one coord. Measure: distinct `startCoord` count across a burst; root inbound rate stays within capacity.
2. **Re-registration storm bound.** After a cohort failure, attached participants stagger re-registration with jitter over `T_rejoin_jitter` (30s). The jitter window is set so inbound rate at the recovering/replacement cohort does **not** exceed `cap_promote / T_rejoin_jitter`. Measure: peak accepted/sec under a synchronized failure-burst stays ≤ that bound. (The churn ticket drives the failures; this ticket owns the jitter-spreading + measurement.)
3. **No speculative outward probe** except via `Promoted`. Verify no walk ever probes a deeper tier without having received a `Promoted` redirect.
4. **Inward retry restarts at `d_max`.** Verify `UnwillingCohort` retries start at `d_max`, never re-hit the same coord immediately.
5. **Promotion-flap prevention.** The sticky promotion window (from the tree ticket) prevents a just-promoted cohort from flapping under burst; verify accepted/sec under a burst stays ≤ the promotion cap.

## Bootstrap / cold-root

A walk that reaches `d < 0` registers at the root with `bootstrap:true`, instantiating the root forwarder if absent (subject to quorum willingness, modeled in the tree ticket).

## Doc sync

- `docs/cohort-topic.md` §Anti-flood properties: add a per-claim forward note that each is simulator-validated; the measured evidence lands in `fold-simulator-findings-into-design-docs`.

## TODO

### Phase 1 — walk engine
- Implement the walk loop over `TopicCohortState` probes, handling `Accepted`/`NoState`/`Promoted`/`UnwillingMember`/`UnwillingCohort`, single-direction semantics, and cold-root bootstrap.
- Route each probe as a scheduled event using the `LatencyModel`; record `WalkTrace`.

### Phase 2 — anti-flood instrumentation
- Add `T_rejoin_jitter` spreading for re-registration (jittered scheduleAfter draws from the seeded RNG).
- Instrument distinct-startCoord fan-out, accepted/sec curves, redirect/backoff counts.

### Phase 3 — claim validation + doc sync
- Encode the five claims as assertions (tests below).
- Add the per-claim forward note to `docs/cohort-topic.md` §Anti-flood properties.

## Done when

- `yarn build` green; ES modules, no `any`, tabs.
- `yarn test` passes, including:
  - **Sparse fan-out:** in a sparse-regime burst, walks start at distinct `coord_{d_max}` and fan across the ring (assert distinct-start count ≈ participant count).
  - **Hop count O(log N):** p50 and p95 hops grow as O(log N) across N ∈ {100, 1k, 10k, 100k} (hot regime resolves in 1–2 RPCs without touching the root).
  - **Burst bound:** under a synchronized arrival/failure burst, peak accepted/sec ≤ `cap_promote / T_rejoin_jitter` (claim 2) and ≤ promotion cap (claim 5).
  - **No speculative outward probe:** assert every outward move is preceded by a `Promoted` reply.
  - **Inward retry:** assert every post-`UnwillingCohort` retry restarts at `d_max`.
