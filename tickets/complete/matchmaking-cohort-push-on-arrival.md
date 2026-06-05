description: COMPLETE — Reviewed the matchmaking arrival-push spec (doc-as-spec). Verified the cohort-primary→seeker push channel is fully specified, internally consistent, and correctly subordinated to the polling baseline (push = pure optimization). Fixed four internal-consistency findings inline in docs/matchmaking.md. No code exists for this subsystem; deliverable is spec text only.
files:
  - docs/matchmaking.md (§Seeker query; §Decision rule; §Arrival push on provider arrival; §Failure modes; §Wire formats; §Configuration; §Test expectations)
  - docs/cohort-topic.md (§Application policies item 4 — cross-ref only, unchanged this stage)
  - docs/reactivity.md (§Propagation — precedent, not edited)
----

# Review (complete): matchmaking cohort-push on provider arrival

## What this was

A **doc-as-spec** change adding an opt-in (`pushOnArrival`) cohort-primary→seeker push
channel to matchmaking: when a *fresh* matchable provider lands at a cohort, the
seeker's assigned primary sends `ArrivalPushV1` over a new app protocol
(`/optimystic/matchmaking/1.0.0/arrival-push`). The push is a **pure optimization** —
correctness is guaranteed by a sparse safety poll (`push_safety_poll_ms`) plus a
mandatory final `QueryV1` before `patienceMs` drains. Fan-out is FCFS by `attachedAt`,
bounded by the provider's `capacityBudget`; arrivals are coalesced per-seeker over
`push_coalesce_ms`; the folded `topicTraffic` keeps the seeker's hang-out logic informed.

There is no matchmaking code (verified independently this stage: `find_references` over
`ArrivalPushV1|SeekerAppPayloadV1|pushOnArrival|arrival-push|match-seeker` → zero
matches). The deliverable is the markdown spec only.

## Review findings

### Verification performed (and result)

- **Implement diff read first, fresh eyes** (`git show c57fba1`) before the handoff summary.
- **Cross-doc anchors** — verified every referenced header exists in `cohort-topic.md`
  (`#topic-traffic-signal`, `#registration-record`, `#membership-rotation-and-primary-handoff`,
  `#protocol-ids`, `#application-policies`) and `reactivity.md` (`#propagation`). All resolve.
- **Internal anchors** — listed all matchmaking headers; every `(#…)` target used by the new
  text resolves (`#arrival-push-on-provider-arrival`, `#arrival-push-missed-or-primary-fails-mid-coalesce`,
  `#decision-rule`, `#provider-self-throttling`, `#adversarial-cohort-traffic-reporting`). No dangling refs.
- **Removed-anchor sweep** — no doc references the deleted "out of scope" anchor.
- **No-code claim** — independently confirmed via code search (above).
- **Protocol-ID convention** — `/optimystic/matchmaking/1.0.0/arrival-push` matches the
  cohort-topic.md §Protocol IDs "own subsystem prefix" rule.
- **Optimization-only invariant** — walked every failure path (offline seeker, failover
  mid-coalesce, dropped RPC, withholding primary, forged push, final-poll-with-push-in-flight);
  all degrade to the safety/final poll, none worse than the legacy poll baseline. Sound.
- **Configuration math** — push path `patienceMs/push_safety_poll_ms + 1 ≈ 3` (incl. final
  poll) vs. test-bullet `≈ 2` (sparse cadence, excl. final poll): checked, the two counts are
  measuring different things and each is correctly scoped/labelled. Left as-is (intentional, clear).

### Findings fixed inline (minor)

1. **Fan-out set must be push-opted seekers (most significant).** The fairness rule selected
   the `min(capacityBudget, |matching local seekers|)` longest-waiting *matching* seekers, but
   only `pushOnArrival` seekers can receive a push. As written, if the longest-waiting matching
   seekers were poll-path, the rule would select them and send **zero** pushes while push-opted
   seekers waited. Restricted the notify set and the fan-out count to **matching local
   push-opted seekers**; added a test bullet (*Poll-path seekers are not push targets*).

2. **`capacityBudget` "bounded above by `cap_promote`" was wrong.** `capacityBudget` is
   provider-chosen concurrency; nothing ties it to the cohort-size ceiling. Rewrote: the
   *fan-out* is bounded by the matching-seeker count, which cannot exceed the `cap_promote (~64)`
   participant ceiling.

3. **`unknown_seeker` ack was not implementable from the wire type.** The edge case + test
   bullet tie `ArrivalPushAckV1{ unknown_seeker }` to the seeker having re-registered under a
   "new `correlationId`", but `ArrivalPushV1` carried no field identifying the bound registration
   (only the cohort's `cohortEpoch`). Added `correlationId: string` to `ArrivalPushV1` (echoes
   the targeted seeker registration) and updated the §Edge-cases prose to compare against it.

4. **Push/poll de-duplication was unspecified.** The same fresh provider can surface in both an
   `ArrivalPushV1` and a later safety/final `QueryV1`; without dedup the seeker would
   double-count toward `wantCount` or double-dial. Added a sentence (dedup by `participantId`,
   which also makes post-failover re-pushes harmless) plus a test bullet (*Push/poll overlap deduped*).

### Findings filed as new tickets (major)

None. All findings were localized doc-consistency issues fixed in this pass.

### Empty categories (explicit)

- **Lint** — none run: the repo has no markdown/docs linter (confirmed). Nothing to lint.
- **Tests** — none run: doc-as-spec change; the §Test-expectations bullets are prose floors that
  become executable tests only when the matchmaking package lands. No executable test touches
  these docs. Not applicable, not skipped-in-error.
- **Build** — N/A for a markdown-only change.

## Known gaps / deferrals (carried forward, acceptable)

- **No code executes.** All "tests" remain prose. Executable verification belongs to the future
  implement tickets that build the matchmaking runtime (`11.5-matchmaking-query-filter-hangout`,
  `13-matchmaking-e2e-mock-tier`). The fan-out-set fix (finding 1) and dedup requirement (finding 4)
  are now captured as test bullets so they land as real tests there.
- **`primary(participantId, cohortMembers)` slot hash** is referenced as "the standard"
  assignment; its definition lives in cohort-topic's sharding section (intentionally not duplicated).
- **`correlationId` on the seeker payload** is owned by the cohort-topic registration envelope,
  not surfaced as a distinct field on `SeekerAppPayloadV1`. The new `ArrivalPushV1.correlationId`
  echoes that envelope value; no new identity field was invented at the seeker-payload level.
- **No `QueryV1` rate ceiling** added (out of scope per the matchmaking backlog). The push
  strictly *reduces* query load, so the change is better-than-baseline regardless.

## End
