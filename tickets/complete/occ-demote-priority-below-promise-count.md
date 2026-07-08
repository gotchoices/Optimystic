description: Verified the fix that stops two conflicting transactions from both committing — race tie-break now lets the more-progressed transaction always win and only uses fairness-priority to settle genuine ties.
prereq:
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (resolveRace ~1510; recordPriority ~1544; hasConflict ~1406; handleCommitNeeded ~1011)
  - packages/db-p2p/test/cluster-repo.spec.ts (priority-aged race resolution suite ~828)
  - docs/correctness.md (Theorem 9 ~272; Case 2 ~80)
difficulty: hard
----

## What was reviewed

Implement commit `143bce8` reordered the three comparison keys in `resolveRace`
(`cluster-repo.ts`) from priority-first back to promises-first, plus the matching test-suite and
`docs/correctness.md` updates. This is the safety fix for the split-brain regression introduced by
ticket `implement-occ-priority-aging` and identified by `occ-priority-first-breaks-promise-monotonicity`.

New order:
```
(1) more promises wins          — never displaces a more-progressed transaction (safety)
(2) equal counts → higher aged priority wins   — fairness tie-break
(3) still tied → higher message hash wins
```

## Review findings

**Correctness / safety (the core claim) — CONFIRMED, no defects.**
- Read the implement diff with fresh eyes before the handoff. The reorder is exactly the promises-first
  ordering. Verified `resolveRace` is the *only* arbiter on the commit path: it is called from one site
  only (`hasConflict`, `cluster-repo.ts:1442`), and `handleCommitNeeded` (`~1011`) signs on
  `approvedPromises >= superMajority` with **no** conflict re-check — confirmed by reading the method.
  So the safety argument (once X holds a promise supermajority, no conflicting Y can also reach one, by
  strict promise-count comparison + quorum intersection) holds.
- `resolveRace` remains a total, deterministic order: promises (integer) → priority (clamped integer)
  → `messageHash` strict `>`. Distinct conflicting records always have distinct hashes (equal-hash
  records are skipped at `hasConflict:1418`), so `>` never yields a tie — order-independent across
  members. No asymmetry bug.

**Stale-reference sweep — CONFIRMED clean in authoritative sources.**
- Grepped all of `docs/`, `packages/db-p2p/src`, `packages/db-core/src` for lingering priority-first
  ordering statements. Only remaining mentions are the intentional "earlier revision was a regression"
  notes. `recordPriority` is used only inside `resolveRace` — no other ordering site to update.
- Two non-authoritative artifacts describe a simplified/stale rule and were left as-is (out of scope,
  pre-existing): `docs/partition-healing.md:365` (forward-looking CRDT redesign note, says "most
  promises, then highest hash" — a correct simplification, omits the tie-break priority) and
  `docs/review.html:187` (generated review artifact with a stale `cluster-repo.ts:1142-1156` line ref
  that predates this diff).

**Test coverage — adequate, verified.**
- Ran the targeted `priority-aged race resolution` suite → 7 passing. Confirmed the adversarial
  monotonicity test is a genuine regression guard: under the old priority-first order
  `resolveRace(x, y)` with x=(3 promises, prio 0), y=(1 promise, MaxPriority) returns `accept-incoming`
  (fails the `keep-existing` assertion). Confirmed the rewritten livelock test now races **equal (0/0)**
  promise counts so the priority tie-break is what it actually exercises. Ancillary tests
  (capped-out hash fallback, multi-collection carrier, mixed-version, integrity-in-transit) all race
  equal promise counts, so priority/hash still decide — expectations remain valid.

**Minor findings:** none — nothing fixed inline.

**Major findings (new tickets):** none.

**Tripwires (conditional, parked — not filed):**
- *Residual fairness under promises-first* — an aged transaction still loses to a rival that
  *legitimately* gathered even one more promise. This is the intended monotonicity behaviour (never
  displace progress), not the pure coin-flip starvation aging targets. Already parked by the
  implementer as a `NOTE:` in the `resolveRace` doc comment (`cluster-repo.ts:1487`) and in Theorem 9's
  *Aged priority* paragraph. Deeper fairness, if ever wanted, belongs to backlog
  `feat-occ-priority-reservation`, not this tie-break. Confirmed the NOTE is present and accurate.
- *Theorem 9 safety now rests specifically on promises-first + no commit-time conflict re-check +
  quorum intersection* — if a future HLC/crdt-sync redesign adds a commit-time conflict guard or
  changes the commit path, re-derive the argument. Recorded in Theorem 9's proof sketch by the
  implementer; confirmed present.

## Deferred / accepted gaps (reviewed and agreed)

- **Multi-member promise→commit composition integration test — DEFERRED (accepted).** The harness
  centers on a single `ClusterMember` with `superMajorityThreshold` = 1.0, so driving X to a
  supermajority immediately triggers commit and clears X from `activeTransactions`, making a clean
  "X quorum-reached, then Y arrives" single-member scenario misleading. The `resolveRace`-level
  adversarial guard is sufficient because `resolveRace` is provably the only commit-path arbiter (no
  downstream conflict re-check) — that *is* the safety argument. A belt-and-suspenders multi-member
  integration test with a sub-unanimous threshold remains valid future hardening but is not required
  here. Agreed with the implementer's reasoning.

## Validation run during review

- Targeted suite (`--grep "priority-aged race resolution"`) → **7 passing**.
- Full package suite (`yarn workspace @optimystic/db-p2p test`) → **1215 passing, 36 pending** (green).
- Typecheck (`npx tsc --noEmit` in `packages/db-p2p`) → exit 0.
- Lint (`npx eslint` on both touched files) → exit 0.
- No pre-existing failures surfaced.

## Verdict

Fix is correct, well-scoped, and honestly documented. Restores the pre-4.6 promise-count monotonicity
that keeps two conflicting transactions from both committing. No inline fixes needed, no follow-up
tickets filed. Complete.
