description: Specify the cohort-side arrival-push channel for matchmaking — replace the hanging-out seeker's `requery_interval_ms` polling with a push from the seeker's assigned cohort primary when a fresh matchable provider lands. Doc-as-spec change to matchmaking.md; the subsystem has no code yet, so the deliverable is the spec sections (wire format, fairness/coalescing rules, fallback semantics, edge cases, doc-as-spec test bullets).
files:
  - docs/matchmaking.md (§Hang-out vs. continue — Decision rule ~L220, Out of scope ~L295; §Failure modes ~L301; §Wire formats ~L329; §Configuration ~L429; §Test expectations ~L282)
  - docs/cohort-topic.md (§Application policies ~L641–652 — already authorizes app state on the gossip channel; cross-ref only, likely no edit)
  - docs/reactivity.md (precedent: §Propagation, §Slow-subscriber backpressure — primary-delivers-to-direct-participant pattern; read, don't edit)
----

# Matchmaking cohort-push on provider arrival

Today a hanging-out seeker re-issues `QueryV1` every `requery_interval_ms` (default 1 s) until `wantCount` is met or `patienceMs` drains — up to ~10 redundant queries per match. This ticket specifies a **push from the seeker's assigned cohort primary** that fires when a fresh matchable provider lands at the cohort, eliminating the poll loop. The push is a **pure optimization over the polling baseline**: correctness never depends on it.

## Design (resolved)

The four plan-stage design questions are settled below. No open option is left to the implementer.

### 1. Push channel — app-level RPC on the seeker's existing cohort primary

The push is delivered by the **seeker's assigned cohort-topic primary** (the member computed by the standard `primary(participantId, cohortMembers)` slot hash — seekers are `directParticipants` and already get a primary), over a **new matchmaking application protocol**, addressed to the seeker's `contactHint`. This is the exact shape reactivity uses to fan `NotificationV1` to direct subscribers (reactivity.md §Propagation): the layer supplies cohort identity + primary/backup assignment; the app supplies the delivery RPC.

**Not** intra-cohort gossip: seekers are external participants, not cohort members, so gossip never reaches them. **Not** a wholly new transport: it reuses the primary the seeker already holds.

Trigger source: provider registrations are replicated to every cohort member via standard cohort gossip (cohort-topic.md:272). The seeker's primary therefore observes a newly-added provider `RegistrationRecord` for this topic within ≤ one gossip round — no new cohort-topic mechanism is required. cohort-topic.md §Application policies (L649) already authorizes applications to drive per-registration behavior off the existing gossip channel, so **cohort-topic.md needs no protocol change** (add a one-line cross-ref only if it aids navigation).

New protocol ID (matchmaking-app, under its own prefix per cohort-topic.md:443):

```
/optimystic/matchmaking/1.0.0/arrival-push
```

### 2. Fairness — FCFS by `attachedAt`, fan-out bounded by `capacityBudget`

On a fresh matchable arrival, the primary notifies the **`min(provider.capacityBudget, |matching local seekers|)` longest-waiting** matching seekers (smallest `attachedAt` first; `attachedAt` is already held per seeker, see `SeekerEntryV1`). Rationale:

- The push is advisory — the cohort allocates nothing; seekers dial the provider directly and the provider enforces its own `capacityBudget`. So fan-out only needs to fill the provider's real slots, not broadcast.
- `capacityBudget` is the natural fan-out bound: a provider admitting *c* concurrent tasks justifies notifying *c* racers. Notifying more only manufactures losing dials; notifying fewer under-fills the provider. No new config — `capacityBudget` (already in `ProviderAppPayloadV1`) is the cap, itself bounded above by `cap_promote (~64)` local seekers.
- FCFS-by-`attachedAt` gives a **deterministic, defensible** winner (longest-waiting), unlike broadcast-and-race (which favors low-latency seekers arbitrarily) or random sample (nondeterministic).

Skip the push entirely when `provider.capacityBudget == 0` — a "listed but full" provider (matchmaking.md:90) is not a new matchable slot.

### 3. Coalescing — per-seeker batch over a short window

The primary accumulates fresh matchable arrivals per target seeker and flushes **one** `ArrivalPushV1` carrying the batch, rather than one push per (arrival × seeker). Flush triggers: a `push_coalesce_ms` timer (default 250 ms) **or** the batch reaching the seeker's outstanding need (`wantCount − currentMatchesAlreadyPushed`). This collapses an arrival burst to ≤ one push per seeker per window.

### 4. Failure mode — push is optimization-only; safety poll + final poll guarantee correctness

A missed push (seeker briefly offline, primary failover mid-coalesce-window, dropped RPC) must never make the seeker worse than the polling baseline. Degraded-but-correct behavior:

- A push-aware hanging-out seeker replaces the 1 s `requery_interval_ms` loop with a **sparse safety poll** every `push_safety_poll_ms` (default 5 s), **plus one mandatory final `QueryV1` immediately before `patienceMs` drains** (catches any provider whose push was lost right at expiry).
- The coalescing buffer is **soft, transient, non-gossiped** state. On primary failover the unflushed batch is simply lost; the safety/final poll covers it. Do **not** add a replay buffer — that is reactivity's concern because reactivity must not lose committed revisions; matchmaking arrivals are advisory and re-discoverable by query.
- **No push/no-push handshake is needed.** Because the safety poll is always present, a seeker that receives no pushes (cohort predates push support, or all pushes were lost) degrades silently to the sparse-poll cadence. Detection is unnecessary.

`requery_interval_ms` is retained for the non-push path (a seeker that does not set `pushOnArrival`).

## Wire-format additions (matchmaking.md §Wire formats)

Add `pushOnArrival` to the seeker payload:

```
interface SeekerAppPayloadV1 {
  kind:           "match-seeker"
  wantCount:      number
  filter?:        CapabilityFilter
  contactHint:    string
  pushOnArrival?: boolean        // NEW — opt into arrival pushes; default false (poll path)
  signature:      string
}
```

New push RPC payloads:

```
interface ArrivalPushV1 {
  v:            1
  topicId:      string
  cohortEpoch:  string
  providers:    ProviderEntryV1[]   // fresh, filter-matched, coalesced batch
  topicTraffic: TopicTrafficV1      // current snapshot — lets the seeker re-run its
                                    //   hang-out math and observe childCohortCount>0
                                    //   (promotion → descend) without a separate poll
  signature:    string             // cohort primary's single-member sig — advisory,
                                   //   same trust model as QueryReplyV1; the seeker
                                   //   re-validates each ProviderEntryV1.registrationSig
}

interface ArrivalPushAckV1 {
  v:      1
  result: "ok" | "unknown_seeker"  // unknown_seeker: primary moved / seeker re-registered;
                                   //   primary drops the binding and stops pushing
}
```

Folding `topicTraffic` into the push means a hanging-out seeker re-evaluates hang-out-vs-continue (and sees promotion via `childCohortCount`) on every push, so the structural-change handling that the poll loop got for free is preserved.

Add the protocol ID to matchmaking.md's FRET-integration / protocol list:

```
/optimystic/matchmaking/1.0.0/arrival-push   — cohort-primary → seeker arrival notification
```

## Configuration additions (matchmaking.md §Configuration)

| Parameter | Default | Description |
|---|---|---|
| `push_coalesce_ms` | 250 | Window the seeker's primary batches fresh matchable arrivals before flushing one `ArrivalPushV1` |
| `push_safety_poll_ms` | 5 000 | Sparse fallback `QueryV1` cadence for a push-aware hanging-out seeker (replaces the 1 s `requery_interval_ms` on the push path) |

`requery_interval_ms` (1 000) stays, now documented as the **non-push** poll cadence. Fan-out uses `provider.capacityBudget` directly — no new fan-out config. Update the §Configuration prose that currently bounds "at most ~10 queries per match": with push enabled a hanging-out seeker issues at most `patienceMs / push_safety_poll_ms + 1` queries (≈ 3 at defaults), and zero in the common case where the first push satisfies `wantCount`.

## Decision-rule edit (matchmaking.md §Hang-out vs. continue → Decision rule, step 2)

Rewrite step 2's tail so that, when hanging out with `pushOnArrival` set, the seeker keeps its registration alive via TTL renewals and **waits for `ArrivalPushV1`**, issuing a `QueryV1` only every `push_safety_poll_ms` and once more just before `patienceMs` drains — instead of polling at `requery_interval_ms`. Keep the existing `requery_interval_ms` wording as the push-disabled branch.

Remove/replace the §Out of scope note (matchmaking.md:295–297) that defers this work — it is now specified here. Update the cross-link near matchmaking.md:295 accordingly.

## Edge cases & interactions

The implementer must cover each; the reviewer will check each.

- **Renewal vs. fresh arrival.** Only a *fresh* provider registration (a `participantId` not previously held for this topic at this cohort) triggers a push. A renewal of an already-known provider must not — seekers already saw it. `arrivalsPerMin` combines fresh+renewals (cohort-topic.md:234), so the trigger keys off the record set transitioning from absent→present, not off the arrivals counter.
- **`capacityBudget == 0` arrival.** Skip push (listed-but-full provider is not a new slot).
- **Filter miss.** A fresh arrival that fails a seeker's `filter` produces no push to that seeker; fan-out counts only matching seekers.
- **`minBudget` filter vs. fan-out.** A seeker whose `filter.minBudget` exceeds the arriving provider's `capacityBudget` is not a match — excluded from both the matching-set and the FCFS fan-out count.
- **Burst exceeding remaining need.** Several providers arrive within one coalesce window; the batched push carries all, and the seeker dials up to its outstanding `wantCount`.
- **Primary failover during the coalesce window.** Unflushed batch is lost (transient, non-gossiped); the safety/final poll recovers it. No replay buffer.
- **`cohortEpoch` change / primary handoff.** The seeker's primary may move (cohort-topic.md §Membership rotation). The old primary stops pushing; the new primary begins pushing future arrivals; the seeker rebinds on its next renewal. In-flight arrivals during the gap are covered by the safety poll. A push that arrives at a seeker that has since re-registered is `ArrivalPushAckV1{ unknown_seeker }` → primary drops the binding.
- **Promotion while hanging out.** After the cohort promotes, fresh providers are redirected to tier `d+1` and stop landing here, so pushes cease. The seeker observes `childCohortCount > 0` via the `topicTraffic` on its last push (or via a safety poll) and re-runs the descend decision per existing rules. This is pre-existing polling behavior, not push-specific — but the folded `topicTraffic` keeps the seeker informed without extra RPCs.
- **`arrivalsPerMin = 0` right after epoch rotation.** Counters reset on rotation (cohort-topic.md:242); pushes are driven by record-set deltas, not the counter, so push delivery is unaffected by the stale-zero window. The existing edge-case rule (do not withdraw on a single zero reading) is unchanged.
- **Final-poll boundary.** A provider that arrives in the last `push_coalesce_ms` before `patienceMs` expiry may not be pushed in time; the mandatory final `QueryV1` is what guarantees it is still seen. Verify the final poll fires even when a push is in flight.
- **Contention-signal interaction (beneficial).** Pushes are not `QueryV1`s, so they do not inflate `queriesPerMin`. As seekers adopt `pushOnArrival`, `queriesPerMin` falls, which lowers `contentionFactor` (matchmaking.md:228) for everyone — the hang-out threshold relaxes as polling load disappears. Note this in the prose; no code beyond not counting pushes as queries.
- **Adversarial primary.** The push carries a single-member (primary) signature, not a threshold sig — same posture as `QueryReplyV1` (matchmaking.md:407). A malicious primary can withhold pushes (seeker degrades to safety poll — no worse than baseline) or push junk providers (seeker re-validates each `registrationSig` and discards forgeries). Bounded; document under §Failure modes.

## Failure-modes addition (matchmaking.md §Failure modes)

Add an entry **"Arrival push missed or primary fails mid-coalesce"**: states that the seeker's safety poll + mandatory final poll make the push a pure optimization, that the coalescing buffer is soft transient state with no replay, and that a withholding/forging primary is bounded exactly as the adversarial-traffic-reporting entry already describes.

## Test expectations (doc-as-spec — matchmaking.md §Test expectations)

Append bullets in the existing doc-as-spec style (each becomes a unit/integration test when the package lands):

- *Fresh arrival pushes to longest waiters.* One fresh matchable provider with `capacityBudget = 2` and 5 matching local seekers → exactly the 2 smallest-`attachedAt` seekers receive an `ArrivalPushV1`.
- *Renewal does not push.* A renewal of an already-held provider produces no `ArrivalPushV1`.
- *`capacityBudget = 0` does not push.* A fresh arrival with budget 0 produces no push.
- *Coalescing.* Three providers arriving within `push_coalesce_ms` yield one `ArrivalPushV1` of length 3 per selected seeker, not three pushes.
- *Filter miss excluded.* A fresh provider failing a seeker's `filter` (incl. `minBudget`) does not push to that seeker and does not count toward fan-out.
- *Missed push, final poll recovers.* With pushes suppressed (simulated drop), the hanging-out seeker still returns the provider via the mandatory final `QueryV1` before `patienceMs` drains.
- *Sparse safety-poll cadence.* A push-aware seeker that gets no pushes issues ≈ `patienceMs / push_safety_poll_ms` queries (≈ 2 at defaults), not `patienceMs / requery_interval_ms` (≈ 10).
- *Promotion observed via folded topicTraffic.* After the cohort promotes, the seeker's next push (or safety poll) reports `childCohortCount > 0` and the seeker enters the descend branch.
- *Push forgery rejected.* An `ArrivalPushV1` whose entries carry an invalid `registrationSig` is discarded; the seeker does not dial the forged provider.
- *Stale push acked `unknown_seeker`.* A push to a seeker that has re-registered (new `correlationId`/epoch) returns `ArrivalPushAckV1{ unknown_seeker }` and the primary drops the binding.

## TODO

- Read docs/reactivity.md §Propagation + §Slow-subscriber backpressure to mirror the primary-delivers-to-direct-participant pattern (do not copy the replay buffer — matchmaking does not need it).
- Edit docs/matchmaking.md §Wire formats: add `pushOnArrival` to `SeekerAppPayloadV1`; add `ArrivalPushV1` / `ArrivalPushAckV1`; add the `/optimystic/matchmaking/1.0.0/arrival-push` protocol ID.
- Edit §Hang-out vs. continue → Decision rule step 2: push-wait branch vs. legacy poll branch.
- Replace §Out of scope (L295–297) and its cross-link (the design now lives in-doc).
- Edit §Configuration: add `push_coalesce_ms`, `push_safety_poll_ms`; reframe `requery_interval_ms` as the non-push cadence; update the "~10 queries per match" prose.
- Edit §Failure modes: add the "Arrival push missed / primary fails mid-coalesce" entry.
- Edit §Test expectations: append the bullets above.
- Confirm docs/cohort-topic.md needs no protocol change (gossip-driven, app-level); add a one-line cross-ref under §Application policies only if it aids navigation.
- Verify internal anchors/line-reference cross-links still resolve after edits.
