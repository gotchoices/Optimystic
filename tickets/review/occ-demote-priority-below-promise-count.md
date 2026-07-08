description: Verify the fix that stops two conflicting transactions from both committing — the race tie-break now lets the transaction that is further along always win, and only uses fairness-priority to settle genuine ties.
prereq:
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (resolveRace ~1465; recordPriority ~1550; hasConflict ~1406; handleCommitNeeded ~1011; getTransactionPhase ~736)
  - packages/db-p2p/test/cluster-repo.spec.ts (priority-aged race resolution suite ~826)
  - docs/correctness.md (Theorem 9 ~265; Case 2 ~80)
difficulty: hard
----

## What changed

`resolveRace` in `cluster-repo.ts` had priority as the **first** comparison key (ticket 4.6,
`implement-occ-priority-aging`). That let a higher-priority transaction displace a conflicting rival
that had **already reached a promise supermajority**, so both could commit (split-brain) — the commit
path (`handleCommitNeeded`) has **no** conflict re-check, so `resolveRace` is the only arbiter.

The fix demotes priority to a tie-break that runs **after** the promise count. New order:

```
(1) more promises wins          — never displaces a more-progressed transaction (safety)
(2) equal counts → higher aged priority wins   — fairness tie-break
(3) still tied → higher message hash wins
```

This restores the pre-4.6 monotonicity guarantee: once transaction X holds a promise supermajority,
no conflicting rival Y (which necessarily has fewer promises) can displace it, and by quorum
intersection the honest member that promised X rejects Y. One winner.

### Files touched

- `packages/db-p2p/src/cluster/cluster-repo.ts` — reordered the three comparison keys in
  `resolveRace` (~1508); removed the `WARNING:` block and the "Priority is FIRST" rationale;
  rewrote the doc comment to describe promises-first with the restored safety argument
  (quorum-intersection) and priority-as-equal-count-tie-break; added the residual-fairness tripwire
  as a `NOTE:` in the doc comment.
- `packages/db-p2p/test/cluster-repo.spec.ts` — `priority-aged race resolution` suite:
  - repurposed the old *"higher priority wins even against MORE promises"* test into a **monotonicity
    guard** (*"a rival with MORE promises wins even against higher aged priority"*) asserting the
    more-progressed transaction is kept;
  - added a new **adversarial monotonicity** test: X with three promises (supermajority) + priority 0
    vs Y with one promise + `MaxPriority` → `resolveRace(X,Y)==='keep-existing'` and mirror. This is
    the regression guard; it would have **failed** under the old priority-first order (old code:
    `resolveRace(X,Y)` returns `accept-incoming` because Y's priority is higher);
  - rewrote the **livelock guarantee** test: fresh rivals now carry an **equal** (0) promise count, so
    priority-as-tie-break gives the deterministic aged win from priority 1 onward (regardless of the
    hash). The old test relied on fresh rivals carrying 2 promises, which now inverts.
  - the remaining four tests (`~872` capped-out hash fallback, `~888` mixed-version, multi-collection
    carrier read, integrity-in-transit) already race **equal (0/0)** promise counts, so priority/hash
    still decides — expectations unchanged, confirmed passing.
- `docs/correctness.md` — Theorem 9 (~271): order updated to promises-first; safety argument
  re-derived honestly with quorum-intersection reasoning; explicitly records that the earlier
  priority-first revision was a real regression and residual-fairness note added. Case 2 (~80): the
  ordering restatement already listed promises-first (so was not itself the safety bug) but omitted
  priority — updated to the full three-key order for consistency.

## How to validate

- Targeted suite: `cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter spec --grep "priority-aged race resolution"` → 7 passing.
- Full package suite: `yarn workspace @optimystic/db-p2p test` → **1215 passing, 36 pending** (green).
- Typecheck: `cd packages/db-p2p && npx tsc --noEmit` → exit 0.

### Use cases the tests pin down

1. **Safety / monotonicity (the bug):** a transaction that already holds a promise supermajority is
   never displaced by a higher-priority rival with fewer promises. → adversarial monotonicity test.
2. **Fairness still works:** two fresh rivals at **equal** promise counts (the actual
   concurrent-starvation case) — the aged one deterministically wins by priority once its priority
   clears 0. → livelock guarantee test.
3. **Determinism / symmetry:** capped-out ties fall back to the hash tiebreak, order-independent;
   mixed-version (priority present vs absent) is deterministic. → unchanged tests, re-confirmed.

## Reviewer notes — honest gaps

- **Tripwire (parked, do not file):** under promises-first an aged transaction can still lose to a
  fresh rival that **legitimately** gathered even one more promise. This is the monotonicity
  behaviour we *want* (never displace progress), not the pure-coin-flip starvation aging targets —
  so it is not a bug. Recorded as a `NOTE:` in the `resolveRace` doc comment
  (`cluster-repo.ts` ~1487) and in Theorem 9's *Aged priority* paragraph. Deeper fairness against a
  genuinely-more-progressed rival, if ever wanted, belongs to the existing backlog follow-up
  `feat-occ-priority-reservation` (reserve/defer at pend time), not the race tie-break.
- **Multi-member promise→commit composition test: DEFERRED.** The ticket flagged this as
  "stronger, if the harness supports multi-member wiring cheaply." It does not, cheaply: the test
  harness centers on a single `ClusterMember`, and the default `superMajorityThreshold` is 1.0
  (unanimity) — so driving X to a supermajority immediately triggers commit → consensus → execution
  and clears X from `activeTransactions`, which makes a clean single-member "X quorum-reached, then Y
  arrives and is rejected" scenario awkward and potentially misleading. The `resolveRace`-level
  adversarial guard is the required minimum per the ticket, and it is sufficient because
  `resolveRace` is provably the *only* arbiter on the commit path (no conflict re-check downstream) —
  that is exactly the safety argument. A reviewer wanting belt-and-suspenders could add a
  multi-`ClusterMember` integration test with a sub-unanimous threshold; noted as out-of-scope here.
- **Theorem 9's "safety intact" claim now rests specifically on the promises-first ordering.** The
  re-derived proof depends on: (a) the commit path having no conflict re-check, and (b) quorum
  intersection. If either premise changes (e.g. a future HLC/crdt-sync redesign of this path, or a
  commit-time conflict guard), re-check the argument.
