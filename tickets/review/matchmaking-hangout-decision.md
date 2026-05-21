# Matchmaking seeker hang-out decision — review handoff

description: Doc-only implement pass on `docs/matchmaking.md`. Adds five seeker-side config defaults, an §Edge cases subsection, an §Out of scope subsection, a §Test expectations subsection (doc-as-spec — no matchmaking package exists yet), an explicit `requery_interval_ms` wiring in the decision rule, and an "Adversarial cohort traffic reporting" paragraph under §Failure modes. Resolves the four plan-stage TODOs inline and files four backlog stubs for deferred follow-ups.
prereq: cohort-topic-traffic-signal
files:
  - docs/matchmaking.md (§Configuration, §Hang-out vs. continue, §Failure modes)
  - tickets/backlog/matchmaking-contention-from-seeker-pool.md (new)
  - tickets/backlog/matchmaking-cohort-push-on-arrival.md (new)
  - tickets/backlog/matchmaking-per-tier-patience-splitting.md (new)
  - tickets/backlog/matchmaking-query-rate-limit.md (new)
----

## Summary of landed work

All in `docs/matchmaking.md`:

1. **§Configuration defaults** (around line 393): five new rows appended after `seeker_renew_grace` — `patience_default_ms` (10 000), `patience_per_tier_fraction` (1.0), `filter_accept_ratio_initial` (1.0), `contention_factor_cap` (4.0), `requery_interval_ms` (1 000). The prose immediately following the table was tightened to spell out that these five are seeker-side application-level (no wire impact) and to note inline that no `QueryV1` per-peer rate ceiling exists today (this is the resolution of plan TODO #2, with rate-limit work routed to a new backlog stub).

2. **§Decision rule** (line 229): the parenthetical "re-query periodically (or wait for cohort-pushed updates if the application uses them)" was replaced with the explicit "re-query at `requery_interval_ms` (default 1 s; see §Configuration)". The cohort-push aside was relocated to a new §Out of scope (for this section) subsection at the end of §Hang-out vs. continue.

3. **§Edge cases** (new, between §Worked example and §Failure modes): five numbered cases — `topicTraffic` absent on reply (walk one tier without hanging out), `arrivalsPerMin = 0` after epoch rotation (query before withdrawing — cross-linked to `cohort-topic.md:242` which the prereq's review explicitly called out as the expected matchmaking-side anchor), `UnwillingCohort` before traffic computed (substrate back-off, decision rule not entered), pathological filter (`filterAcceptRatio` decays, seeker walks to root), competing seekers (`contentionFactor` rises, capped by `contention_factor_cap = 4.0`).

4. **§Test expectations** (new, after §Edge cases): eight bullet-form test names with expected outcomes, framed as doc-as-spec — no matchmaking package exists yet, so these are placeholders that become real unit/integration tests when the package lands.

5. **§Out of scope (for this section)** (new, last subsection of §Hang-out vs. continue): one-paragraph forward-looking note on the cohort-push refinement, cross-linked to `tickets/backlog/matchmaking-cohort-push-on-arrival.md`.

6. **§Failure modes — Adversarial cohort traffic reporting** (new, first subsection of §Failure modes): four bullets — over-reporting bounded by `patienceMs` (preserves anti-flood since walks only go root-ward), under-reporting bounded by one hop per tier, cross-check via cohort gossip routed through the reputation subsystem, and the explicit "no threshold signature on the reply" decision with rationale (this is the resolution of plan TODO #4).

Plus four backlog stubs filed:
- `matchmaking-contention-from-seeker-pool` — use `Σ wantCount` from `QueryV1{includeSeekers: true}` in lieu of `meanWantCount × queriesPerMin`. Resolution of plan TODO #1.
- `matchmaking-cohort-push-on-arrival` — replace polling `requery_interval_ms` with cohort push.
- `matchmaking-per-tier-patience-splitting` — strategies beyond `patience_per_tier_fraction = 1.0`.
- `matchmaking-query-rate-limit` — per-peer `QueryV1` ceiling parallel to `register_rate_per_peer`.

No code changes. No `cohort-topic.md` changes (its surface is final per the prereq's review).

## What I checked

- **Cross-doc consistency.** The new Edge case #2 explicitly cross-links to the epoch-reset paragraph the prereq landed at `cohort-topic.md:242`; that paragraph claims "matchmaking's edge-case rule does not withdraw on a single zero reading without first issuing a query to confirm" — Edge case #2 here delivers exactly that rule. The two docs are now in sync (and resolve the "wished-for cross-reference" the cohort-topic-traffic-signal review flagged at the end of its findings).
- **Worked-example arithmetic.** Untouched by this ticket; was already correct (`contentionFactor ≈ 1.13`, threshold `≈ 9.05`) thanks to the inline fix the prereq's review applied.
- **Internal cross-refs inside §Hang-out vs. continue.** Decision inputs → Decision rule (formulas use the inputs named in inputs); Decision rule → Edge cases (Edge case #2 wires back to "issue one `QueryV1` first" and matches Decision rule step 1); Edge cases → Test expectations (each edge case has at least one bullet in test expectations: "Stale `arrivalsPerMin = 0`", "`topicTraffic` missing on reply", "Filter accept ratio decays"); Test expectations → Out of scope (push-channel mention echoes the polling-cadence test bullet). Pass.
- **Cap is referenced consistently.** `contention_factor_cap = 4.0` is named in §Configuration and referenced from Edge case #5. See "known gaps" below for the one place it could be tighter.
- **Backlog stubs.** Each has a `files:` hint pointing back to the matchmaking doc sections that will need updates when the stub is picked up. Each is one paragraph plus a short "design questions" list — no implementation work done in the stub.

## Known gaps (reviewer please decide)

These are the kinds of things the reviewer should look at — not bugs I shipped, but choices a reviewer might want tightened:

- **The `contentionFactor` formula at line 227 doesn't apply the cap.** The unclamped form `1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1)` is what's shown, and §Configuration introduces `contention_factor_cap = 4.0` as "Upper bound on the contention multiplier". A careful implementer would clamp `contentionFactor = min(unclamped, contention_factor_cap)`, and the doc body should arguably show that explicitly. I did not edit the formula because the ticket scoped me to additions/wirings; the reviewer may want to add `min(…, contention_factor_cap)` to the formula at line 227 or add a one-line clarification after the formula. The worked example's `1.13` is well below the cap, so no example-level math changes either way.
- **"Out of scope (for this section)" as a subsection heading.** No other top-level section in `matchmaking.md` uses an internal "Out of scope" subsection — the doc has a top-level §Goals and non-goals, but not per-section out-of-scope notes. The ticket asked for it explicitly. If the reviewer prefers a different placement (e.g., a footnote on the Decision rule or an entry in a global "Future work" appendix), this would be a small relocation.
- **`windowSeconds` in Edge case #2** is referenced without redefinition. It's a cohort-topic concept (defined in `cohort-topic.md` §Topic traffic signal). The cross-link is provided, but a matchmaking-first reader hits an undefined term. Trade-off vs. duplication; left as a cross-link.
- **Edge case #4 ("Filter that matches almost nothing") and Test bullet 8 ("Filter accept ratio decays across walk")** both reference `filterAcceptRatio` decay, but the Decision rule prose only says it "starts at 1.0 and can be refined from observed query yields" — no concrete decay formula is given. The reviewer may want a one-line "e.g., EMA over recent yields with α ≈ 0.3" or may prefer to defer that to implementation. I leaned toward not over-specifying.
- **Test expectations are doc-as-spec.** When the matchmaking package lands, each of the eight bullets needs to be converted to a real test. I noted this in the section header. If the reviewer wants concrete test-file paths or fixture sketches in the doc, that's an additional level of detail I did not commit to.
- **No `cohort-topic.md` edits.** The ticket scoped me out, but the prereq's review note at the very end ("Matchmaking's 'do not withdraw on single zero' sentence … matchmaking.md §Hang-out vs. continue does support this in spirit … but doesn't literally use the phrase") now does literally hold via Edge case #2. No cohort-topic edit needed; flagging only so the reviewer can confirm the cross-link is sufficient.

## Use cases for validation

No tests can be run (no matchmaking source package exists). Validation is by reading the doc:

1. **Read §Hang-out vs. continue end-to-end as a first-time reader.** Confirm the flow is: inputs → rule → patience → why → worked example → edge cases → test expectations → out of scope. Each subsection should make the next one's framing obvious.
2. **Reader who only cares about the formula** should be able to land on §Decision rule, read the two formulas, and see exactly how `requery_interval_ms`, `patience_per_tier_fraction`, and `contention_factor_cap` participate (or be told to look elsewhere if they don't, which is the case for the latter two — they tune the surrounding loop, not the formula itself).
3. **Reader auditing the security posture** should be able to land on §Failure modes — Adversarial cohort traffic reporting and follow the chain to the reputation subsystem cross-link without leaving `matchmaking.md`.
4. **Reader looking up a config knob** should find each of the five new defaults in the table and find at least one prose paragraph (in §Hang-out vs. continue or §Failure modes) that names the knob and explains its role.
5. **A future implementer** should be able to take §Test expectations and §Edge cases together as a near-complete test plan for the matchmaking seeker — every named edge case has a matching test bullet.

## Anti-pre-existing-failure caveat

No tests run (none exist). No build run (no matchmaking source code). No `.pre-existing-error.md` filed.
