description: Review the matchmaking arrival-push spec (doc-as-spec). Verify the cohort-primary→seeker push channel is fully specified, internally consistent, and correctly subordinated to the polling baseline (push = pure optimization). No code exists for this subsystem; the deliverable is the matchmaking.md spec sections only.
files:
  - docs/matchmaking.md (§Seeker query ~L96; §Hang-out vs. continue → Decision rule ~L222; §Replacing the poll with a push ~L313; §Arrival push on provider arrival ~L319; §Failure modes → "Arrival push missed…" ~L390; §Wire formats → Seeker payload ~L432, Arrival push ~L496; §Configuration ~L549; §Test expectations ~L287)
  - docs/cohort-topic.md (§Application policies item 4 ~L648 — one-line cross-ref only)
  - docs/reactivity.md (§Propagation — precedent, NOT edited)
----

# Review: matchmaking cohort-push on provider arrival

## What this is

A **doc-as-spec** change. The matchmaking subsystem has **no code** (confirmed: zero references to `SeekerAppPayloadV1` / `ArrivalPushV1` / `match-seeker` across `src`/`packages`). The implement deliverable is therefore the spec text in `docs/matchmaking.md` (plus a one-line navigation cross-ref in `docs/cohort-topic.md`). There is no build or test to run — the repo has no docs linter and the package test suites are unrelated to markdown. The doc-as-spec test bullets in §Test expectations are the *floor*: they become real unit/integration tests only when the matchmaking package eventually lands.

## The change in one paragraph

Today a hanging-out seeker re-issues `QueryV1` every `requery_interval_ms` (1 s) — up to ~10 polls per match. This spec adds an opt-in (`pushOnArrival`) cohort-side push: the seeker's **assigned cohort-topic primary** sends `ArrivalPushV1` over a new app protocol (`/optimystic/matchmaking/1.0.0/arrival-push`) when a *fresh* matchable provider lands. The push is a **pure optimization** — correctness is guaranteed by a sparse safety poll (`push_safety_poll_ms`, 5 s) plus one mandatory final `QueryV1` before `patienceMs` drains. Fan-out is FCFS by `attachedAt`, bounded by the arriving provider's `capacityBudget`. Arrivals are coalesced per-seeker over `push_coalesce_ms` (250 ms). The folded `topicTraffic` in each push keeps the seeker's hang-out/promotion logic informed without an extra RPC.

## Edits made (verify each landed and is consistent)

- **§Seeker query (~L96)** — added `pushOnArrival?: boolean` to the inline `SeekerAppPayloadV1`; added a sentence on TTL-renewal while waiting for pushes.
- **§Hang-out vs. continue → Decision rule step 2 (~L222)** — split the hang-out tail into a **push path** (wait for `ArrivalPushV1`; safety poll + final poll) vs. **poll path** (legacy `requery_interval_ms`).
- **§Replacing the poll with a push (~L313)** — replaces the old "### Out of scope" subsection (which deferred this exact work); now a forward cross-link to the new section.
- **§Arrival push on provider arrival (~L319, NEW top-level section)** — push channel, fairness (FCFS/`capacityBudget`), coalescing, folded `topicTraffic`, optimization-only failure mode, and an Edge-cases-&-interactions list (12 cases).
- **§Failure modes → "Arrival push missed or primary fails mid-coalesce" (~L390)** — soft/transient/non-gossiped buffer, no replay, withholding/forging bounded as the adversarial-traffic entry.
- **§Wire formats** — `pushOnArrival` on the canonical `SeekerAppPayloadV1`; new "### Arrival push" subsection with the protocol ID, `ArrivalPushV1`, `ArrivalPushAckV1`.
- **§Configuration** — added `push_coalesce_ms` (250) and `push_safety_poll_ms` (5 000); reframed `requery_interval_ms` as the **non-push** cadence; rewrote the "~10 queries per match" prose to cover the push path (`patienceMs / push_safety_poll_ms + 1` ≈ 3, or 0 in the common case) and flagged `push_coalesce_ms` as the one cohort-side knob.
- **§Test expectations** — appended 10 arrival-push doc-as-spec bullets.
- **cohort-topic.md §Application policies item 4** — one-line cross-ref confirming the push is gossip-driven and needs no substrate protocol change.

## Validation already done

- **Internal anchors:** every `(#…)` link in matchmaking.md was checked against the header list — all 16 resolve (`#arrival-push-on-provider-arrival`, `#arrival-push-missed-or-primary-fails-mid-coalesce`, `#decision-rule`, `#provider-self-throttling`, `#hang-out-vs-continue`, `#adversarial-cohort-traffic-reporting`).
- **Cross-doc anchors:** `cohort-topic.md#{topic-traffic-signal,registration-record,application-policies,membership-rotation-and-primary-handoff,protocol-ids}` and `reactivity.md#propagation` all verified against those files' headers. The new `cohort-topic.md → matchmaking.md#arrival-push-on-provider-arrival` back-link resolves.
- **No dangling refs** to the removed "out of scope" anchor anywhere in `docs/`.

## What a reviewer should scrutinize (treat my tests as a floor)

1. **Optimization-only invariant.** The whole design rests on "a missed push never makes the seeker worse than polling." Check every failure path (offline seeker, failover mid-coalesce, dropped RPC, withholding primary, forged push) actually degrades to the safety/final poll and never to a worse-than-baseline state. The final-poll-fires-even-with-push-in-flight case (§Edge cases, §Test expectations) is the subtle one.
2. **Fan-out math.** `min(provider.capacityBudget, |matching local seekers|)` longest-waiting. Confirm the `capacityBudget == 0` skip, the `minBudget` filter exclusion from *both* the matching set and the fan-out count, and the `cap_promote (~64)` upper bound are mutually consistent and don't double-count.
3. **Fresh vs. renewal trigger.** The spec insists the trigger keys off the *record set* transitioning absent→present, **not** off `arrivalsPerMin` (which folds in renewals). Verify the prose nowhere accidentally implies the counter drives the push.
4. **Coalesce flush condition.** `push_coalesce_ms` timer OR batch reaching `wantCount − already-pushed`. Check this can't under- or over-deliver vs. the seeker's actual outstanding need across multiple pushes in one patience window.
5. **`ArrivalPushAckV1{ unknown_seeker }` semantics.** The stale-push edge case says the primary "drops the binding." Confirm the wire type + the §Edge cases + the §Test-expectations bullet agree on the trigger (seeker re-registered with new `correlationId`/epoch) and the consequence.
6. **Configuration prose numbers.** The §Configuration prose says push path ≈ 3 queries (incl. final poll); the §Test-expectations bullet says ≈ 2 (sparse cadence, excl. final poll). This is intentional (different counts) but is a likely reviewer flag — confirm the wording makes the distinction clear rather than contradictory.

## Known gaps / deferrals (honest)

- **No code, so nothing executes.** All "tests" are prose bullets. If the reviewer wants executable verification, that's a future implement ticket when the matchmaking package is created (see the existing `11.5-matchmaking-query-filter-hangout` / `13-matchmaking-e2e-mock-tier` implement tickets that build the runtime).
- **`primary(participantId, cohortMembers)` slot hash** is referenced as "the standard" assignment but its exact definition lives in cohort-topic's sharding section, not restated here. Intentional (don't duplicate the substrate spec) but verify the reference is unambiguous.
- **`correlationId`** is named in the stale-push edge case and a test bullet as part of the seeker's identity-on-re-register, but the seeker payload in §Wire formats doesn't surface a `correlationId` field (it lives in the cohort-topic registration envelope, per `ProviderAppPayloadV1.signature` "…over … correlationId"). A reviewer may want this made explicit; left as-is to avoid inventing a field the substrate already owns.
- **No `QueryV1` rate ceiling** is added (out of scope, per existing backlog note) — the push *reduces* query load, so this is strictly better than baseline, but the spec doesn't add the ceiling the backlog still wants.
