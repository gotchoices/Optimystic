# Cohort-topic traffic signal — doc updates (complete)

description: locked the per-(topic, cohort) traffic signal design in docs/cohort-topic.md — `CohortGossipV1` schema extended with `arrivalsPerMin` / `queriesPerMin` per topic and envelope-level `windowSeconds`; §Topic traffic signal gained four clarifications (combined-rate rationale, responder's gossip-derived view, exact-integer wire note, epoch-reset semantics); `RegisterReplyV1.topicTraffic` comment sharpened to spell out which `result` values carry it. No cohort-topic source code exists yet; this was a doc-only design lock.
files:
  - docs/cohort-topic.md
  - docs/matchmaking.md (small arithmetic fix in worked example — see Review findings)
----

## Summary of landed work

All design edits are confined to `docs/cohort-topic.md`:

- **`CohortGossipV1.topicSummaries[]`** entries now carry `arrivalsPerMin` and `queriesPerMin` as exact integers over `windowSeconds`. `windowSeconds` was hoisted to envelope level since it's cohort-wide.
- **§Topic traffic signal** gained four short clarifying paragraphs below the `TopicTrafficV1` code block: combined-rate rationale (with forward link to matchmaking.md §Hang-out vs. continue); responder's gossip-derived view (worst-case one-round staleness, no recompute at reply time); exact-integer wire format (contrasted with the log-bucketed load barometer); epoch-reset semantics (counters zero on `cohortEpoch` change; matchmaking's edge-case rule tolerates a single zero).
- **`RegisterReplyV1.topicTraffic` comment** updated from *"present on accepted; also returned on promoted"* to the more explicit *"present on accepted and promoted; absent on no_state, unwilling_member, unwilling_cohort"*. No schema change.

One small consistency fix landed in `docs/matchmaking.md` during review (see findings).

## Review findings

### Checked

- **Doc diff for internal consistency.** Read end-to-end. The new `CohortGossipV1.topicSummaries` rate fields are a superset of the participant-facing `TopicTrafficV1` subset — the cohort-internal envelope carries `tier` and `promoted` flags that the reply omits, which is correct (participants compute tier from their own walk position and read `Promoted` from the `result` field). `windowSeconds` appears both at gossip envelope level and inside `TopicTrafficV1`; the redundancy is intentional and documented in the implement-stage ticket (reply is participant-facing and self-contained for forward compat). The four prose clarifications do not contradict each other or the surrounding sections.

- **Cross-reference targets.**
  - `[matchmaking.md §Hang-out vs. continue](matchmaking.md#hang-out-vs-continue)` — resolves to `docs/matchmaking.md:198`. ✓
  - `[Membership rotation and primary handoff](#membership-rotation-and-primary-handoff)` — resolves to `docs/cohort-topic.md:303`. ✓
  - "§Cohort gossip below" — `docs/cohort-topic.md:563`. ✓
  - "§Capacity barometer" — `docs/cohort-topic.md:198`. ✓
  - "§Primary and backup sharding" — `docs/cohort-topic.md:290`. ✓

- **Matchmaking sibling doc consistency** (`docs/matchmaking.md` lines 186–345). The formulas at 226–227 (`expectedNewMatches`, `contentionFactor`) use plain numeric arithmetic, which matches the resolved "exact integers on the wire — consumer formulas are numeric" decision. The walk-reply table at 184–190 correctly reflects that only `Accepted` and `Promoted` carry `topicTraffic` (the table notes both rows; the unwilling/no-state rows correctly omit it). `QueryReplyV1.topicTraffic` at line 345 is annotated `// see cohort-topic.md` and stays in sync.

- **Repo-wide search for stale references** to the schema (`grep -nE 'CohortGossipV1|topicSummaries|windowSeconds|topicTraffic|arrivalsPerMin|queriesPerMin'` over `docs/`). Only the cohort-topic and matchmaking files reference these names; both are consistent post-edit.

- **Test/lint runs.** Not meaningful for this ticket — the cohort-topic layer has no implementation code (`packages/` has no cohort-topic subpackage), so there's nothing to type-check or unit-test against. The doc has no link-checker or markdownlint config in this repo. Skipped accordingly.

### Found and fixed inline (minor)

- **`docs/matchmaking.md:263` worked-example arithmetic was stale.** The text said *"Contention factor ≈ 1.4. Threshold `8 × 1.4 = 11.2`"* but the formula immediately above (`1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1)`) with the inputs `queriesPerMin=4, meanWantCount=3, arrivalsPerMin=90` yields `1 + 12/90 ≈ 1.13`, not 1.4. The conclusion (`21 ≥ threshold` → hang out) was unchanged, but the multiplier and product were both wrong. This was pre-existing, but the resolved "exact integers feed numeric formulas" decision in this ticket made the discrepancy more glaring; the matchmaking ticket plan I authored (`plan/matchmaking-hangout-decision.md`) already used the correct `≈ 1.13`. Fixed inline by replacing with the explicit formula expansion: *"`contentionFactor ≈ 1 + (4 × 3 / 90) ≈ 1.13`. Threshold `8 × 1.13 ≈ 9.05`; have `6 + 15 = 21`. Hang out."*

### Found and routed to a new ticket (major)

- **The implement commit `c78f85a` landed three unrelated source-file edits** that the ticket explicitly disclaimed as out-of-scope (the ticket said *"No code changes anywhere"* and *"No source files, schemas, or tests were touched"*):
  - `packages/db-p2p/src/libp2p-node-base.ts` — added `relayServerInit?: CircuitRelayServerInit` option and threaded it into `circuitRelayServer(...)`.
  - `packages/db-p2p/src/protocol-client.ts` — enhanced `dial:fail` log with error `code` and a 200-char-truncated `message`.
  - `packages/reference-peer/src/cli.ts` — passes `{ reservations: { applyDefaultLimit: false } }` when relay is enabled, prints a banner about disabled circuit-relay limits.
  
  These changes appear legitimate (the JSDoc explains a real upstream `@libp2p/circuit-relay-v2` default-limit footgun that breaks long-lived service↔browser circuits), but they bypassed the normal plan/implement/review flow — no design ticket exists for them (`git log --all --grep="circuit-relay\|relay limits\|relayServerInit"` returns empty), and the cohort-topic-traffic-signal slug is misleading for future blame / bisect. Did **not** revert (the changes look intentional and useful), but filed `tickets/fix/circuit-relay-trusted-limits-followup.md` to drive a proper review pass over the trust assumption ("reference-peer trusted"), the dial-log secret-leak check, and an exercise of the web-e2e circuits the change was apparently motivated by.

### Other notes (no action)

- **Empty categories.** Tests/lint not run (no runnable target for this layer; doc-only). No security review needed (advisory signal, no auth/crypto changes, layer explicitly notes admission/routing/promotion don't depend on it). No performance review needed (wire fields are two exact integers in intra-cohort gossip; the implement ticket's own analysis covers why bucketing would buy nothing).

- **`windowSeconds` redundancy on the wire.** Appears twice (envelope of `CohortGossipV1` and inside `TopicTrafficV1`). Intentional per the implement ticket's "forward compat" rationale — the reply is participant-facing and shouldn't require knowledge of the gossip envelope schema. Left as-is.

- **Matchmaking's "do not withdraw on single zero" sentence.** The new epoch-reset paragraph in cohort-topic.md (line 242) claims matchmaking tolerates the post-rotation zero via this rule. matchmaking.md §Hang-out vs. continue does support this in spirit (the decision rule queries before withdrawing), but doesn't literally use the phrase. Acceptable; if a future reviewer pushes back, a one-sentence addition to matchmaking.md §Hang-out vs. continue would close the gap. Out of scope here.

- **`childCohortCount` on demoted cohorts.** Unchanged by this ticket. The existing comment *"0 if not promoted"* could be argued to be ambiguous for a cohort that was promoted-then-demoted. The substrate's demotion flow (§Promotion and demotion lifecycle) resets forwarder state including child links, so the comment is correct in spirit. No edit needed.

## What's next

- The sibling plan ticket `plan/matchmaking-hangout-decision.md` (created in the plan stage of this work) can now proceed; its prereq `cohort-topic-traffic-signal` is satisfied by the design lock landed here.
- The new `fix/circuit-relay-trusted-limits-followup.md` will drive code review of the unintended source-file changes that shipped under this ticket's slug.
