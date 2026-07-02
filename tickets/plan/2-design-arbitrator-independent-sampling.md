description: When a dispute needs independent referees, the system picks the nodes sitting right next to the disputed data — which are exactly the nodes an attacker who captured that data already controls. Pick referees from an unpredictable spread across the whole network instead, so they are genuinely independent.
prereq:
files:
  - packages/db-p2p/src/dispute/arbitrator-selection.ts (selectArbitrators ~10-28)
  - docs/correctness.md (§7.1 Sybil vector; dispute/arbitration sections)
difficulty: medium
----

`dispute/arbitrator-selection.ts:10-28` selects arbitrators as ring positions K+1…2K by XOR distance to the block ID — i.e. the peers immediately adjacent to the (possibly already-captured) cluster. This defeats the point of independent arbitration: an attacker who can place node IDs near a block to capture its cluster (the Sybil vector `correctness.md` §7.1 openly admits) captures the next concentric ring just as cheaply. Geometric widening only buys independence if each wider ring samples a *more representative* population; concentric XOR-neighbors walk straight through the attacker's owned region first.

## Expected behavior

Escalation audiences must be sampled from an unpredictable, non-local population so each round draws from the whole keyspace rather than the attacker's neighborhood. A concrete approach: derive pseudo-random ring coordinates from `hash(blockId ‖ escalation-round ‖ epoch)` and select the arbitrators nearest those coordinates, so the audience for each round is spread across the keyspace and cannot be predicted (and pre-captured) ahead of time.

The selection must remain deterministic and independently verifiable — every honest node, given the same block, round, and epoch, must compute the same arbitrator set, so the choice cannot be gamed by the disputing parties.

This is a component of the larger dispute-escalation redesign (design-dispute-synchronous-escalation), which should consume this selection function; keeping it a separate, focused change keeps each ticket to one agent run.

## Edge cases & interactions

- **Determinism vs. unpredictability** — the set must be reproducible by all honest verifiers yet not precomputable far enough ahead to let an attacker migrate IDs into position; the epoch/round inputs must be pinned to something the attacker cannot freely advance.
- **Round progression** — each escalation round must sample a *distinct* population; define how round number widens or re-randomizes the audience.
- **Small networks** — when the keyspace is sparsely populated, define fallback behavior so selection still yields enough distinct, live arbitrators.
- **Interaction with membership agreement** (design-cluster-membership-agreement) — the epoch used as a selection input should be the agreed membership epoch, not a locally-derived one.
- **Liveness** — sampled arbitrators may be offline; define how unavailable picks are replaced without letting the disputing parties steer the replacement.
