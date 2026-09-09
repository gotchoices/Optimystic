----
description: When two writers race for the same version of a block, the node running the transaction only ever hears the verdict of its own local copy. If a different node was the one that spotted the conflict, the refusal never reaches it and it commits the losing write anyway, leaving itself holding a version nobody else has.
prereq: a-commit-over-a-gapped-base-forks-the-block
files: packages/db-p2p/src/cluster/cluster-repo.ts
repro: verified
difficulty: hard
----

# A coordinator commits a rival action its own cohort refused

## What happens

Two actions take the same revision of one block. One of them lands. The other should be refused —
and it *is* refused, by the member that saw the winner first. But that refusal never reaches the node
coordinating the losing transaction, which reports its own local verdict as success and commits.
That coordinator ends up holding a revision no one else has, and every subsequent write it makes to
that block is rejected.

## The single observation

Run 3 of the downstream reproduction (`../sereus`,
`control-write-degraded-cohort-member.integration.ts`, `DEBUG='optimystic:db-p2p:*'`). Block
`14YGUoeu…`, revision 7, contested by two actions:

- `BF_B3k3`, cohort {B, A} — landed on both.
- `D_Y9Wz5`, cohort {C, A}, coordinated by **C**.

The sequence:

1. A promised `D_Y9Wz5` at 26.068.
2. `BF_B3k3` pended on A at 26.076 — A now holds the winner.
3. A's local pend of `D_Y9Wz5` was refused: `consensus-pend-diverged { hasPending: true }`
   (`cluster-repo.ts:1905`). The refusal was retained in `executedPendResults`.
4. **It never reached C.** C's `pend-cluster-complete` reports `localExecuted: true,
   localVerdict: 'success'` — read from C's *own* member only.
5. The commit round is blind: 2/2 signatures. C commits `D_Y9Wz5` at revision 7. A answers
   `commit:stale`.

C is now forked at revision 7. Its own `registerSelf` loops on rejection until the suite's boot gate
times out — which is the `7 skipped` shape that
`../sereus/tickets/blocked/control-write-hears-zero-approvals-from-healthy-trio.md` currently
attributes to `control-peer-row-refresh-invisible-to-third-node`.

## Why the documented backstop does not fire

The doc at `cluster-repo.ts` ~:1553-1560 describes the protection against exactly this race, and it
assumes **the coordinating node's own member** is the one that refuses the rival. Here C's member
never saw the winner — A did — so C had nothing to refuse and nothing to report.

The gap is that a member's refusal is recorded locally and consulted locally, but the pend round's
completion verdict for the coordinator is computed from the coordinator's own member rather than from
the cohort's answers.

## What a fix has to establish

- Whether a member's pend refusal is expected to travel back to the coordinator at all today, or
  whether the design intends the coordinator's own member to be authoritative. If the latter, the
  race above is outside what the design admits and the design is what needs changing.
- Whether the commit round can be made non-blind — 2/2 signatures were collected for a record one
  cohort member had already refused.

This is filed after `a-commit-over-a-gapped-base-forks-the-block` because that ticket's commit-tier
guard would make **this** fork self-limiting too: C's later writes over its forked revision would be
refused at apply time and routed into reconciliation rather than accumulating. Fix the invariant
first, then decide how much of this race still needs its own remedy.

## Caveat on the evidence

**One observation.** Seen once, in one run, with full debug capture. The prior rate is unknown and no
attempt has been made to reproduce it deliberately. Treat the sequence above as a well-documented
single trace, not a measured rate — and do not fold it into the gapped-base ticket, whose evidence is
much stronger.

## TODO

- Attempt a deliberate reproduction: two actions racing one revision with the winner landing on a
  member that is not the loser's coordinator.
- Establish which of the two designs above is intended before changing behaviour.
- Re-check whether the downstream boot-gate timeout (`Timeout waiting for C self-publishes its
  CadrePeer record`) still occurs once the gapped-base guard lands.
