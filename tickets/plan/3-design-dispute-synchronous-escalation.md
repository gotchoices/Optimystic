description: The docs promise that any disagreement over a transaction's validity blocks it and triggers a widening, repeated arbitration; in reality the transaction commits anyway on a super-majority, the dispute machinery is off by default, and even when on it votes once, after the fact. Build the promised block-then-escalate mechanism, or state plainly that what ships is weaker.
prereq: design-cluster-membership-agreement, arbitrator-independent-sampling
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (executeTransaction ~299-332; record.disputed)
  - packages/db-p2p/src/dispute/types.ts (disputeEnabled default false ~124)
  - packages/db-p2p/src/dispute/dispute-service.ts (single-round arbitration ~160-222)
  - docs/correctness.md (Theorems 8, 10 — Adaptive-BFT cost model)
  - docs/architecture.md (§Status target-vs-current annotation pattern)
difficulty: hard
----

The docs promise that "any validity disagreement blocks the transaction and triggers cascading geometric escalation." The code does close to the opposite:

- On a minority rejection, `ClusterCoordinator.executeTransaction` **commits anyway** at 75% super-majority and merely sets `record.disputed = true` (`cluster-coordinator.ts:299-332`). Nothing is blocked.
- The dispute service defaults to `disputeEnabled: false` (`dispute/types.ts:124`).
- Even when enabled, `dispute-service.ts:160-222` selects **one** ring of arbitrators, votes **once**, and resolves — no recursion, no geometric widening — and it runs **after** commit.

So the Adaptive-BFT cost model (Theorems 8, 10) describes a mechanism that is not implemented. The real guarantee today is "Byzantine-*detectable* within a cluster that has an honest super-majority" — strictly weaker than the advertised f < N/2 tolerance.

## Expected behavior

Two tracks, both wanted:

- **Short term (do regardless):** annotate `correctness.md` theorem-by-theorem with target-vs-current status, the way `architecture.md` §Status already does, so the formal claims are not read as descriptions of the shipping system. This is cheap and prevents over-reading while the long-term work lands.
- **Long term:** implement the synchronous, cascading escalation the docs promise — a validity disagreement blocks visibility of the transaction and triggers repeated, widening arbitration rounds until resolution, rather than committing first and arbitrating once afterward.

The escalation must build on the two prereqs: it inherits the agreed cluster membership (design-cluster-membership-agreement — the cascade is meaningless if the base set is unagreed) and draws each round's arbitrators from the independent, unpredictable sampling function (design-arbitrator-independent-sampling) rather than concentric neighbors.

## Edge cases & interactions

- **Block-before-commit vs. commit-then-dispute** — moving arbitration ahead of commit changes the liveness/latency profile; define what "blocked" means for readers and how long a disputed transaction stays invisible.
- **Termination of the cascade** — geometric widening must terminate (bounded rounds or keyspace exhaustion) with a defined final outcome; specify what happens when widening reaches the whole network without resolution.
- **Default on/off** — `disputeEnabled` defaulting to false means the guarantee is off in practice; decide and justify the shipping default.
- **Cost model reconciliation** — Theorems 8 and 10 must either be implemented-to or downgraded; do not leave them describing an unbuilt mechanism.
- **Honest-super-majority assumption** — be explicit about the tolerance the finished mechanism actually provides versus the advertised f < N/2.
- **Partial rollback** — if a disputed transaction that already committed must be undone, coordinate with the invalidation/reversal machinery so the reversal is itself authenticated.
