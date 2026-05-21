# Matchmaking seeker hang-out decision — doc edits

description: Doc-only implement pass. The prereq (`cohort-topic-traffic-signal`) already landed the substrate schema, the walk-reply table changes, the full §Hang-out vs. continue section (decision rule + worked example), and `topicTraffic` on `QueryReplyV1`. This ticket finishes the remaining matchmaking-side gaps: five new config defaults, an explicit "Edge cases" subsection, the `requery_interval_ms` mechanic, an adversarial-reporting note, a test-expectations sketch, and resolution of the four plan-stage TODOs.
prereq: cohort-topic-traffic-signal
files:
  - docs/matchmaking.md (§Configuration, §Hang-out vs. continue, §Anti-DoS-or-equivalent failure-modes pass)
----

## Scope (what is and isn't done)

**Already landed in the prereq** (do not redo):

- `docs/cohort-topic.md` §Topic traffic signal + `TopicTrafficV1` schema + cohort-gossip wire fields + epoch-reset paragraph.
- `docs/matchmaking.md` lines 184–194: walk-reply table with `topicTraffic` on `Accepted` and `Promoted`.
- `docs/matchmaking.md` lines 198–266: §Hang-out vs. continue — Decision inputs, Decision rule, Patience budgeting, Why this works, Worked example. Arithmetic in the worked example is correct (`contentionFactor ≈ 1.13`, threshold `≈ 9.05`).
- `docs/matchmaking.md` line 345: `topicTraffic: TopicTrafficV1` on `QueryReplyV1`.

**This ticket adds** (all in `docs/matchmaking.md`):

1. Five new rows in the §Configuration defaults table.
2. A new §Edge cases subsection inside §Hang-out vs. continue.
3. A short clarification in the decision rule text wiring in `requery_interval_ms` (replacing the current vague "periodically").
4. An adversarial-`topicTraffic`-reporting paragraph in §Anti-DoS or §Failure modes (placement choice below).
5. A short "Test expectations" subsection sketching the borderline scenarios — this is doc-as-spec since no matchmaking source exists yet; when the package lands, these become real tests.

No source code changes; no test runs (nothing to run against). No `cohort-topic.md` edits — its surface is final per the prereq's review.

## Edit 1 — §Configuration defaults additions

Append five rows to the existing defaults table (currently at `docs/matchmaking.md` ~line 393), in this order:

| Parameter | Default | Description |
|---|---|---|
| `patience_default_ms` | 10 000 | Fallback `patienceMs` when the caller does not specify per-task |
| `patience_per_tier_fraction` | 1.0 | Fraction of remaining patience spent at one tier before considering escalation; 1.0 means "spend it all here before walking" |
| `filter_accept_ratio_initial` | 1.0 | Starting estimate for `filterAcceptRatio`, refined per walk from observed query yields |
| `contention_factor_cap` | 4.0 | Upper bound on the contention multiplier; protects against pathological `queriesPerMin / arrivalsPerMin` ratios |
| `requery_interval_ms` | 1 000 | How often a hanging-out seeker re-issues `QueryV1` against its cohort |

Also tighten the existing prose immediately following the table to note that these five are consumed only by the seeker; the cohort layer is unaware of them (so they're application-level, not protocol-level — no wire impact).

## Edit 2 — explicit `requery_interval_ms` wiring

In the existing §Decision rule (around line 229), replace the parenthetical *"re-query periodically (or wait for cohort-pushed updates if the application uses them)"* with an explicit reference: *"re-query at `requery_interval_ms` (default 1 s; see §Configuration)"*. Keep the cohort-push aside as a forward-looking note in §Out of scope at the bottom of the section.

## Edit 3 — new §Edge cases subsection

Insert a new third-level subsection between the existing §Worked example and the §Failure modes top-level section (i.e. as the last subsection of §Hang-out vs. continue). Content covers exactly the five cases the plan ticket enumerates:

1. **`topicTraffic` absent on reply.** The substrate guarantees `topicTraffic` on `Accepted` and `Promoted`. If a reply omits it (older peer or protocol mismatch), the seeker treats the cohort as zero-rate and walks one tier toward the root without hanging out. Cross-link to `cohort-topic.md` §Topic traffic signal for the per-result presence matrix.

2. **`arrivalsPerMin = 0` immediately after cohort epoch change.** Counters reset on rotation (see `cohort-topic.md:242`). The first ~`windowSeconds` of a new epoch under-reports. A seeker tolerates this by **not withdrawing on a single zero reading** — it issues one `QueryV1` first and only escalates if the query also yields below threshold. This matches the assurance the prereq added to `cohort-topic.md`.

3. **`UnwillingCohort` returned before `topicTraffic` is computed.** Standard substrate back-off path; the hang-out decision is not entered because the registration itself was refused. Cross-link to the walk-reply table row.

4. **Filter that matches almost nothing.** `filterAcceptRatio` falls toward zero as queries return non-matching providers; `expectedNewMatches` collapses; the seeker walks all the way to the root. Acceptable cost — pathological filters are inherently expensive, and the root's aggregated pool gives them their best shot.

5. **Many seekers competing simultaneously.** `queriesPerMin` rises, pushing the contention factor up, pushing more seekers to escalate toward the root, which is where aggregation lives. Capped at `contention_factor_cap = 4.0` so a runaway query rate can't pin every seeker to the root indefinitely. Self-balancing.

## Edit 4 — adversarial `topicTraffic` reporting

Add a paragraph to **§Failure modes (matchmaking-specific)** (around line 270) — not §Anti-DoS, since this is a property of the reply rather than the registration. Heading: "Adversarial cohort traffic reporting". Content covers:

- The `RegisterReplyV1` / `QueryReplyV1` carrying `topicTraffic` is signed by the cohort *primary* only (single-member, not threshold — already noted at line 367 for `QueryReplyV1`). A malicious primary could over- or under-report.
- **Over-reporting** (claim a hot tier so the seeker hangs out): bounded by the seeker's `patienceMs`. Worst-case outcome is wasted patience plus one extra `register → walk` hop after timeout. No spatial flood: the decision rule only walks **toward the root**, never speculatively outward, so the substrate's anti-flood guarantee is preserved.
- **Under-reporting** (claim a cold tier so the seeker escalates): also bounded — one extra hop per affected seeker, ending at the root, where aggregated truth is hardest to fake (the root sees the union and has its own gossip).
- **Cross-check via cohort gossip.** Other cohort members can detect a primary whose reported rate diverges from the gossip-derived view that drives their own replies. Detection routes through the reputation subsystem (out of scope here; see [architecture.md](architecture.md) §Reputation).
- **No threshold-signing the reply.** Reasonable for now: the cost of a threshold signature on every registration/query reply is high, and the worst-case adversarial outcome above is bounded. A future ticket may revisit if observed abuse warrants it. (This is the resolution of the plan TODO on attestation.)

## Edit 5 — test expectations sketch

Add a "Test expectations" subsection at the end of §Hang-out vs. continue (after §Edge cases). This is the resolution of plan TODO #3 — since no matchmaking package exists, these are spec-level test names with their expected outcomes. When the package lands, each becomes a concrete unit/integration test.

Cases to enumerate (one short bullet per case, expected behavior in parens):

- *Hot topic, deep tier suffices.* (Seeker stops at first `Accepted`; no walk past tier of first match.)
- *Cold topic, walks to root.* (Seeker traverses every tier; `wantCount` met at `d = 0`.)
- *Borderline topic, hangs out for full patience.* (Seeker stays at tier, queries `≈ patienceMs / requery_interval_ms` times, returns partial if still under-met when patience drains.)
- *Patience drains correctly across walked tiers.* (Each escalation hop deducts elapsed; final hang-out budget = original minus all hops' elapsed time.)
- *Seeker withdraws cleanly on escalation.* (Outgoing `RenewV1 TTL=0` is sent before re-registering at `d − 1`; cohort gossips the eviction within one round.)
- *Stale `arrivalsPerMin = 0` after epoch rotation.* (Seeker queries before escalating; if query yields ≥ `wantCount`, no walk; otherwise walks normally on the next reading.)
- *`topicTraffic` missing on reply.* (Seeker walks one tier toward the root without hanging out.)
- *Filter accept ratio decays across walk.* (After two cohorts each return only ~10% matchable providers, `filterAcceptRatio` is ~0.1; subsequent `expectedNewMatches` reflects this.)

## Resolution of plan-stage TODOs

The plan ticket's TODO list is resolved as follows:

1. **Contention factor from `QueryV1{includeSeekers: true}` vs. `meanWantCount` constant.** Resolve: keep `meanWantCount` as a constant (default 3) for the initial design. The seekers-in-reply variant is a tractable refinement — capture as a new `tickets/backlog/matchmaking-contention-from-seeker-pool.md` (single short ticket; the plan body already describes the trade-off, so no new design work needed pre-implementation).

2. **Re-query rate acceptable cohort load.** Resolve inline: at default `requery_interval_ms = 1000` over default `patience_default_ms = 10000`, a hanging-out seeker issues ≤ 10 queries per match. Current `QueryV1` has no documented per-peer rate limit (only `register_rate_per_peer = 4/min` covers `RegisterV1`). The implement edit should add a parenthetical note in §Configuration calling out that query-rate limiting is out of scope here and may be added when adversarial behavior is observed.

3. **Test sketch.** Resolved by Edit 5 above.

4. **Adversarial `topicTraffic` vector.** Resolved by Edit 4 above. Conclusion: the bounded worst-case (patience waste + one extra hop) does not warrant threshold-signing the reply at this stage; cross-link to the reputation subsystem for the detection path.

## Out-of-scope follow-ups (file as backlog tickets)

- `matchmaking-contention-from-seeker-pool` — backlog. Use `QueryV1{includeSeekers: true}` to derive `Σ wantCount` of currently-registered seekers in lieu of `meanWantCount × queriesPerMin`. Trade-off: richer reply, more accurate contention term, slightly larger response.
- `matchmaking-cohort-push-on-arrival` — backlog. Replace the polling `requery_interval_ms` with a push notification from the cohort to a hanging-out seeker when a new matchable provider arrives. Needs design of the push channel and back-pressure; defer until polling shows observable cost.
- `matchmaking-per-tier-patience-splitting` — backlog. Strategies more sophisticated than `patience_per_tier_fraction = 1.0` (binary split, exponential decay). Defer until borderline-regime behavior is measured.
- `matchmaking-query-rate-limit` — backlog. Decide whether `QueryV1` needs a per-peer rate ceiling parallel to `register_rate_per_peer`, and if so its default value.

(File these as separate `tickets/backlog/*.md` stubs in the implement pass — each is one short paragraph plus a `files:` hint to `docs/matchmaking.md`.)

## Anti-pre-existing-failure caveat

No tests exist for matchmaking or cohort-topic. No build runs for these layers. If unrelated repo-wide test runs surface failures, follow the `.pre-existing-error.md` flagging procedure — but no tests are expected to be run for this doc-only ticket.

## TODO

- Apply Edit 1 (five config rows) to `docs/matchmaking.md` §Configuration defaults.
- Apply Edit 2 (`requery_interval_ms` wiring) to existing §Decision rule prose.
- Apply Edit 3 (new §Edge cases subsection) inserted after §Worked example.
- Apply Edit 4 (adversarial reporting paragraph) in §Failure modes (matchmaking-specific).
- Apply Edit 5 (Test expectations subsection) at end of §Hang-out vs. continue.
- File the four backlog stubs listed under "Out-of-scope follow-ups".
- Cross-check that no edit contradicts `docs/cohort-topic.md` §Topic traffic signal (paragraph at line 242 in particular).
- Final read-through: verify §Hang-out vs. continue's internal cross-refs (Decision inputs ↔ Decision rule ↔ Edge cases ↔ Test expectations) are consistent.
