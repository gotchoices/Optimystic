# Matchmaking per-tier patience splitting strategies

description: Today's hang-out decision uses `patience_per_tier_fraction = 1.0` — a seeker spends its full remaining patience at the accepting tier before considering escalation. More sophisticated strategies (binary split, exponential decay, adaptive based on observed `topicTraffic`) may give better borderline-regime behavior. Defer until borderline-regime cost is measured.
files:
  - docs/matchmaking.md (§Hang-out vs. continue — Patience budgeting, Configuration `patience_per_tier_fraction`)
----

Background: the current default lets a seeker spend its whole patience budget at the first accepting tier. For borderline topics this risks wasting the budget at a deep, thin shard when the root would have answered immediately. Reducing `patience_per_tier_fraction` to, say, 0.5 makes the seeker check the upper tier sooner, at the cost of an extra register hop and possibly two query rounds instead of one.

Design questions for the plan stage:

- Strategies to compare: fixed fraction, binary split, exponential decay, traffic-adaptive (e.g., split proportionally to `directParticipants` ratio between tiers).
- Whether the choice belongs in the seeker's task-level configuration or as a global default.
- Measurement: needs the matchmaking package to exist first so the borderline-regime cost is observable.
