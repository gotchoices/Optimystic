description: Design synchronous block-then-escalate for validity disputes — a transaction any cluster member rejects on validity does not commit until widening rounds of independent arbitration settle it — as docs/right-is-right.md promises. Needs careful design; expected to split into several prereq-chained tickets.
prereq:
files:
  - docs/right-is-right.md (§Current Implementation; §Open Design Questions; §Durable Invalidation; §Read-Dependency Cascade)
  - docs/correctness.md (Theorems 7, 8, 10 — the cost/liveness model that assumes this mechanism)
  - docs/architecture.md (§Status & Evolution — lists this as partially implemented)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (the commit path a synchronous block changes)
  - packages/db-p2p/src/dispute/dispute-service.ts (the post-commit dispute service; single round, unwired initiation)
  - packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/cascade.ts (durable reversal machinery)
----

# Design synchronous block-then-escalate for validity disputes

## Decision (maintainer, 2026-10-04)

"We should definitely build this. Needs careful design." Build **synchronous block-then-escalate**
(World A below) as `docs/right-is-right.md` promises, rather than adopting optimistic commit + durable
reversal as the design of record. The durable-reversal machinery is not discarded: invalidity
*discovered after* commit still needs it, so the design must say how the two coexist (World C's split
is the natural shape — pre-commit disagreement blocks, post-commit discovery reverses — and should be
evaluated explicitly).

## Background

The predecessor plan ticket `design-dispute-synchronous-escalation` split into a cheap honesty pass
(`annotate-correctness-theorems-status`, annotating what ships today) and this expensive half.

**What the docs promise (World A).** A transaction any cluster member rejects on validity does not
commit. The dissenting members elect a leader, who recruits independent arbitrators across the
network; if they split, the argument escalates to a wider, freshly sampled audience until one side
wins. Only then does the transaction commit (approvers win) or fail (rejecters win), invisible to
everyone meanwhile. This is the `f < N/2` guarantee of Theorems 8 and 10: an invalid transaction is
never visible, even briefly.

**What ships today (World B, largely).** Commit at super-majority, flagged when a minority disagreed;
if later proven invalid, a durable audit-preserving reversal (`InvalidationEntry`) is appended and
dependents are re-evaluated (`invalidation.ts`, `cascade.ts`, client notification path) — unit-tested,
end-to-end origination/emit wiring still pending (`right-is-right.md` §Durable Invalidation "Wiring
status"). `disputeEnabled` defaults to `false`, the dispute service runs a single round (round counter
hard-wired to 0), and initiation is never triggered in production.

## What the design must settle

1. **Latency cost.** Every transaction that hits any validity disagreement pays multiple round trips
   before commit, on a path that is one round today. Quantify it, bound it, and decide how the commit
   path waits (block in `ClusterCoordinator`, or return a "disputed, pending" state the writer polls),
   including timeouts and what the writer observes.
2. **Default posture.** The guarantee is only real if the mechanism is on; decide the default and the
   migration from `disputeEnabled: false`.
3. **Commit-path change.** Where in `cluster-coordinator.ts` the block happens relative to the promise
   and commit rounds, and how pending records, reservations (`held` votes), and the writer's retry
   (`Collection.syncAttempts`, `TransactionCoordinator`) behave while a dispute is open.
4. **Escalation loop.** Multi-round widening: per-round fan-out, unanimity vs super-majority per
   round, arbitrator sampling, and **termination** when widening reaches the whole network unresolved
   (reject, leave pending to expiry, or degenerate to whole-network consensus) — this fixes the
   liveness bound in Theorem 7.
5. **Ejection durability and rejoin.** How a losing side's ejection is stored so a peer cannot simply
   rejoin, and the legitimate rejoin path (`right-is-right.md` §Open Design Questions).
6. **Interaction with the existing post-commit dispute service and durable invalidation.** Which
   disagreements block and which reverse; no double handling of one transaction; reuse of the
   dispute protocol, certificates and reputation penalties.
7. **Correctness.** Make Theorems 8 and 10 (and 7) the spec the build is checked against; update
   `docs/correctness.md` and `docs/right-is-right.md` once the design is fixed.

## Output

A design recorded in `docs/right-is-right.md` (resolving its §Open Design Questions), then a set of
`prereq:`-chained implement tickets each sized to one agent run (likely: commit-path block + disputed
state; multi-round escalation loop; termination/liveness; ejection durability/rejoin; enablement and
docs/theorem reconciliation). Any question the docs cannot settle goes to `blocked/` with proposed text.
