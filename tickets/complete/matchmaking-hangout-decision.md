# Matchmaking seeker hang-out decision

description: Doc-only pass on `docs/matchmaking.md` covering the matchmaking-side seeker hang-out decision. Adds five seeker-side config defaults, an §Edge cases subsection, §Test expectations subsection (doc-as-spec — no matchmaking package exists yet), an §Out of scope subsection, explicit `requery_interval_ms` wiring in the decision rule, and an "Adversarial cohort traffic reporting" paragraph in §Failure modes. Resolves the four plan-stage TODOs inline and files four backlog stubs for deferred follow-ups.
prereq: cohort-topic-traffic-signal
files:
  - docs/matchmaking.md (§Configuration, §Hang-out vs. continue, §Failure modes)
  - tickets/backlog/matchmaking-contention-from-seeker-pool.md
  - tickets/backlog/matchmaking-cohort-push-on-arrival.md
  - tickets/backlog/matchmaking-per-tier-patience-splitting.md
  - tickets/backlog/matchmaking-query-rate-limit.md
----

## Summary

All changes land in `docs/matchmaking.md`:

- §Configuration gains five seeker-side rows (`patience_default_ms`, `patience_per_tier_fraction`, `filter_accept_ratio_initial`, `contention_factor_cap`, `requery_interval_ms`) plus a follow-on paragraph noting they're application-level (no wire impact) and that no `QueryV1` per-peer rate ceiling exists today.
- §Decision rule's vague "re-query periodically" replaced with explicit "re-query at `requery_interval_ms` (default 1 s; see §Configuration)".
- §Decision rule's `contentionFactor` formula updated to apply `contention_factor_cap` via `min(...)` so the cap is visible at the point of use (see Review findings).
- New §Edge cases subsection covers `topicTraffic` absent on reply, `arrivalsPerMin = 0` after epoch rotation, `UnwillingCohort` before traffic computed, pathological filter, and competing seekers.
- New §Test expectations subsection lists eight bullet-form test names as doc-as-spec.
- New §Out of scope (for this section) subsection cross-links the deferred cohort-push refinement.
- New §Adversarial cohort traffic reporting first subsection of §Failure modes addresses over-reporting bound by `patienceMs`, under-reporting bound by one hop per tier, cohort-gossip cross-check via reputation, and the no-threshold-signature decision.

Four backlog stubs filed:
- `matchmaking-contention-from-seeker-pool` — use `Σ wantCount` in lieu of `meanWantCount × queriesPerMin`.
- `matchmaking-cohort-push-on-arrival` — replace polling with push.
- `matchmaking-per-tier-patience-splitting` — strategies beyond `patience_per_tier_fraction = 1.0`.
- `matchmaking-query-rate-limit` — per-peer `QueryV1` ceiling.

No code changes. No `cohort-topic.md` changes.

## Review findings

**What was checked:**

- *Original-requirement coverage.* All five edits prescribed by the plan (five config rows, `requery_interval_ms` wiring, §Edge cases, adversarial paragraph, §Test expectations) are present. All four plan-stage TODOs are resolved as planned (#1 deferred to backlog stub, #2 inline note in §Configuration, #3 §Test expectations subsection, #4 §Adversarial cohort traffic reporting). All four backlog stubs are filed with `description:` + `files:` + design questions.
- *Internal cross-refs in §Hang-out vs. continue.* Decision inputs → Decision rule (formulas consume inputs by name); Decision rule → Edge cases (Edge case #2's "issue one `QueryV1` first" matches step 1 of the decision rule); Edge cases → Test expectations (each of the five edge cases has a matching test bullet); Test expectations → Out of scope (polling-cadence bullet echoes the push-channel deferral). Consistent.
- *Cross-doc consistency with `cohort-topic.md`.* Edge case #2 cross-links to `cohort-topic.md` §Topic traffic signal — the prereq's paragraph at line 242 already asserts "matchmaking's edge-case rule does not withdraw on a single zero reading without first issuing a query to confirm", and Edge case #2 in `matchmaking.md` now literally implements that rule. The "wished-for cross-reference" the prereq's review flagged is now resolved.
- *Worked-example arithmetic.* Untouched. `contentionFactor ≈ 1.13` (computed value) ≤ `contention_factor_cap = 4.0`, so the new `min(...)` clamp does not alter the example output. Threshold `≈ 9.05` still matches.
- *Backlog stubs format.* Each follows the ticket template (`description:`, `files:`, prose body, design-questions list). No premature implementation work in the stubs.
- *Configuration table additions.* The five new rows are appended after `seeker_renew_grace` as planned. The paragraph after the table correctly identifies "the last five rows" as seeker-side and application-level.
- *§Failure modes placement.* §Adversarial cohort traffic reporting is the first subsection of §Failure modes (matchmaking-specific), which is the right home — it is a property of the reply, not of the registration.
- *Lint/build/test.* None run. No source code exists for matchmaking; no test suite exercises these docs; no build target depends on them. `.pre-existing-error.md` not filed (no test run produced failures to triage).

**Minor findings — fixed inline in this pass:**

- *Wrong directional reference.* §Adversarial cohort traffic reporting said "see the `QueryReplyV1` note above" but the only matching not-threshold note (`signature: string // cohort primary's reply signature; not threshold` at line 386 + the prose at line 407) lives **below** in §Wire formats. Changed to "see the `QueryReplyV1` note in §Wire formats below" (`docs/matchmaking.md:305`).
- *`contention_factor_cap` was documented but not visible in the formula.* §Configuration introduced the cap, but the `contentionFactor ≈ 1 + ...` formula at line 227 did not show clamping — an implementer reading just the formula would miss the cap. Updated to `contentionFactor ≈ min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1), contention_factor_cap)`. Worked-example math unaffected (unclamped value 1.13 already ≤ cap of 4.0).

**Major findings:** None.

**Items considered and deliberately left alone:**

- *"Out of scope (for this section)" as a unique subsection heading.* No other top-level section in `matchmaking.md` uses an internal "Out of scope" subsection. The plan asked for it explicitly at this location, and the cross-link from the cohort-push backlog stub points back to it. Reasonable as-is; a future global "Future work" appendix could absorb it.
- *`windowSeconds` referenced without redefinition in Edge case #2.* It is a cohort-topic concept defined in `cohort-topic.md` §Topic traffic signal. The cross-link is provided; duplicating the definition would risk drift.
- *`filterAcceptRatio` decay formula left unspecified.* Edge case #4 and Test bullet 8 both reference decay, but the doc keeps the input "starts at 1.0 and can be refined from observed query yields" without prescribing a formula. Intentional — the matchmaking package's choice of EMA / window / smoothing is implementation detail.
- *`cohort-topic.md:242` cross-link uses a line-number reference.* Fragile if `cohort-topic.md` shifts, but provides useful precision; the anchor portion (`#topic-traffic-signal`) survives line renumbering. Left as-is.
- *No `cohort-topic.md` edits.* The plan scoped the implementer out of cross-doc edits, and the cross-link from Edge case #2 is sufficient to satisfy the prereq review's outstanding "wished-for" matchmaking-side anchor.

**Test plan handoff:** No tests run because no test target exists. When the matchmaking package lands, each of the eight bullets in §Test expectations becomes a concrete unit/integration test. The §Edge cases enumeration is the matching coverage target.
