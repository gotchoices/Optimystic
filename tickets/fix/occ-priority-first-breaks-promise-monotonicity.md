description: Making a repeatedly-losing transaction win races by "priority" can let two conflicting transactions both commit — a split-brain risk — because priority now outranks how close a rival already is to committing.
prereq:
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (resolveRace order; hasConflict; handleCommitNeeded; validatePendOperations; getTransactionPhase)
  - packages/db-core/src/transaction/transaction.ts (Transaction.priority; MaxPriority; clampPriority)
  - docs/correctness.md (Theorem 9 — "safety intact" claim depends on the fix)
  - packages/db-p2p/test/cluster-repo.spec.ts (add adversarial promise→commit concurrency test)
difficulty: hard
----

## The problem

Ticket 4.6 ("implement-occ-priority-aging", now in `complete/`) added an **aged advisory
priority** to transactions and made a cluster member's `resolveRace` consult it **first** — ahead
of the promise count:

```
new order:  (1) higher priority   (2) more promises   (3) higher message hash
old order:                        (1) more promises   (2) higher message hash
```

Placing priority *before* the promise count removes a safety property the old ordering provided.

### Why the old "more promises wins" ordering was load-bearing for safety

In this consensus protocol a member commits a transaction purely on **promise supermajority**:

- `handleCommitNeeded` (cluster-repo.ts ~1011) signs a commit whenever a record shows
  `approvedPromises >= superMajority`. **It does not re-check for a conflicting transaction.**
- `validatePendOperations` (~972) rejects a pend only for a *stale committed revision* or a custom
  validator — it does **not** reject a second, still-*pending* conflicting transaction on the same
  block.
- So among two concurrently-pending conflicting transactions, `hasConflict` → `resolveRace` is the
  **only** arbiter. It is a safety mechanism, not merely a liveness optimization.

The pre-4.6 ordering gave a monotonicity guarantee: **once transaction X reaches a promise
supermajority, no conflicting rival Y can also reach one.** Every member holding X at that promise
count will reject a fresher Y (Y has fewer promises → `keep-existing`). By quorum intersection, any
Y-supermajority overlaps X's supermajority in ≥1 member, and that member rejects Y — so Y never
commits. One winner. Safe.

### How priority-first breaks it

Priority ignores promise count. A high-priority Y beats X in `resolveRace` **even after X has
reached a promise supermajority and is committing.** Concretely:

1. Fresh transaction X (priority 0) gathers a promise supermajority on members {1,2,3} and its
   coordinator proceeds toward commit. (X is the "winner" that a starved rival keeps losing to.)
2. The starved, now-aged transaction Y (priority ≥ 1, conflicting, same block) arrives at members
   1, 2, 3. `resolveRace(X, Y)`: Y's priority > X's priority → `accept-incoming` →
   `clearTransaction(X)` → each member promises Y.
3. Y now holds promises from {1,2,3} → reaches supermajority → commits.
4. X's commit-phase record (carrying the {1,2,3} promises it already collected) is re-delivered to
   members 1–3. `getTransactionPhase` sees `approvedPromises >= superMajority` and **no conflict
   check on the commit path** → each member also signs commit for X.
5. **Both X and Y commit.** Two conflicting transactions on the same block reach consensus →
   double commit / member-state divergence (split brain). Different members may apply X-then-Y vs
   Y-then-X, and the storage-level stale no-op that swallows the second commit does so in
   member-local order, so members can converge to *different* final states.

`clearTransaction(X)` does not save this: it only clears local `activeTransactions`; X's promise
signatures are already propagating, and the commit path has no conflict guard to stop X finishing.

This is **reachable in the feature's intended use case**, not a corner case — the whole point of
aging is for a starved transaction to overtake a rival that is currently winning (i.e. one that has
already gathered promises). It is dormant only while no transaction ever ages above 0.

The 4.6 tests all pass, but they test `resolveRace` in isolation and the two retry loops in
isolation. **No test exercises the promise→commit interaction**, which is exactly where the
regression lives. `docs/correctness.md` Theorem 9's "safety intact / fairness-only" claim rests on
this untested composition and is currently **wrong** as written.

## What to investigate / decide

1. **Reproduce.** Add an adversarial `cluster-repo.spec.ts` (or multi-member harness) test: X
   reaches a promise supermajority, then a higher-priority conflicting Y is introduced; assert that
   **at most one** of X/Y can reach a commit supermajority. This should currently fail.

2. **Fix the ordering.** Strong candidate: demote priority to **after** the promise count —
   `(1) more promises  (2) higher priority  (3) higher message hash`. This preserves the
   monotonicity guarantee (a more-progressed transaction is never displaced) while still using
   priority to break genuine ties. Note that the observed starvation happened precisely at
   *equal* promise counts (two fresh rivals, 0 promises each, coin-flipping on the hash), so
   priority-as-a-tie-break-after-promises still solves the stated concurrent-starvation problem in
   the common case. Confirm this is sufficient, or:

3. **Alternatively / additionally**, add a conflict guard on the commit path (a member refuses to
   sign a commit for a transaction it has aborted in favour of a conflicting winner), or reject a
   second conflicting pend at promise time. These are heavier and interact with recovery — weigh
   against option 2.

4. **Update `docs/correctness.md` Theorem 9** to match whatever ordering lands, and re-derive the
   safety argument honestly.

Output implement ticket(s) once the ordering decision is made.
