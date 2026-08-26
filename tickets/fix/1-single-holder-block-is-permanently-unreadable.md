description: Data written while a deployment was still one machine can never be read by any machine that joins later. The repair rule demands two independent peers vouch for a copy, a single copy can only produce one voucher, and the only mechanisms that would create a second copy are gated behind the same rule — so the deployment's founding records stay unreadable forever.
prereq:
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/test/reconcile-block.spec.ts
difficulty: hard
repro: verified
----

# A singly-held block can never gain a second holder, so early data is permanently unreadable

Upstream report: [gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15),
from the reporter of #11/#13/#14. Independent of all three — their repros use no relays, no NAT and
no libp2p sockets. Both repros are inlined in full in the issue and run against a plain
`npm install @optimystic/db-p2p@0.24.2`.

## Confirmed here, not taken on report

Ran their arithmetic case against **our own build** of `dist/src/cluster/quorum-restore.js` at
0.24.2 — one honest claim from the sole holder, `repairCorroborationClusterSize = 2`, simple
majority 0.51:

```
nonSelfCohort=1  capacity=1  required=1  accepted=true
nonSelfCohort=2  capacity=2  required=2  accepted=false
nonSelfCohort=3  capacity=3  required=2  accepted=false
nonSelfCohort=8  capacity=8  required=2  accepted=false
CORROBORATION_FLOOR = 2
```

Identical evidence, accepted at a cohort view of two and declined at three. That is the whole
defect in one table.

## What is actually wrong

`corroboratorCapacity(cohortPeerCount, repairCorroborationClusterSize)` returns
`max(cohortPeerCount, repairCorroborationClusterSize - 1)` (`quorum-restore.ts:87`). It caps the
corroboration floor, and it exists so that a genuinely tiny cohort is not asked for more
corroborators than it could ever supply.

It keys that relaxation on **cohort size**. What actually bounds corroboration is **how many peers
hold the block**. A cohort of nine with one holder can supply exactly one claim, the same as a
cohort of two — but only the cohort of two gets the relaxation.

The consequence is not just a declined read. Both paths that could create a second holder —
read-repair acquisition (`CoordinatorRepo.queryClusterForLatest`) and `createReconcileBlock`
(`reconcile-block.ts`) — consume the same quorum decision. So a block with one holder cannot gain a
second, and cannot be read by anyone who is not that holder. The reporter held the state open for
90 s across nine re-reads; it never healed, and the rebalance path failed on 10 of 11 singly-held
blocks while the one block with two holders pulled fine.

**This is what growth produces.** Anything committed while the cohort was one node has one holder;
the cohort that later derives for that key has three. A deployment's earliest data — schema,
genesis, founding records, exactly what every later joiner must read to participate — is the data
that goes unreadable. Their downstream case is a party's founding write in `cadre-core`, which
necessarily happens while the founder is the only node.

The symptom is also actively misleading: it arrives as *"it broke when the network got healthier"*,
because widening a joiner's cohort view from two to three is what crosses the cliff. In their n=4
topology, adding a second relay reservation was enough to trigger it.

## It contradicts what we tell operators

`resolveClusterPolicy` (`cluster-policy.ts:184-213`) computes
`minimumSelfHealingDeployment = CORROBORATION_FLOOR + 1 = 3` and warns that a deployment running
fewer machines than that can never supply the floor. Our current text already goes further than the
version they quoted — it says that at exactly three "the reader has two peers and needs both, so one
unreachable peer leaves the copy permanently unrepairable".

That is still the wrong quantity. At three machines the floor is satisfiable only for blocks that
**already** have two holders; for a singly-held block, three machines repair no better than two, and
no number of machines helps. An operator reading that warning at four or more machines believes they
are in the clear.

## The safety tension — do not skip this

The floor is not arbitrary. `quorum-restore.ts` says so at the top: both paths previously trusted a
single peer's self-reported "latest", so one lying peer could steer restoration, and the module's
own NOTE records that the quorum is corroboration-of-a-claim and **not** Sybil-resistant.
`corroboratorCapacity`'s doc comment explains why it takes the `max` of the two quantities:
cohort views are unauthenticated, so a partition or an attacker with routing influence must not be
able to talk the requirement down to a single voter.

Naively re-keying the relaxation on "how many peers claimed to hold it" hands exactly that lever
back: an attacker who is the sole claimant for a block nobody holds would be believed. Today the
reader gets no data; under a naive relaxation it gets the attacker's data. **That is a real
regression, and a fix that trades it away silently is worse than the bug.**

Note what the contested case does, though, because it narrows the problem: with two disagreeing
claims each group has one supporter, the requirement is two, and *both* decline. So the case in
question is specifically a **sole, uncontested claim, with every other cohort member having
affirmatively answered "I hold nothing"** — an answer, not silence.

## Directions worth weighing (research, then decide — do not assume one)

- **Distinguish "no second holder exists" from "a second holder did not answer."** The evidence
  needed is already on the wire at decision time: non-holders answer affirmatively. Whether an
  affirmative absence is trustworthy enough to relax the floor is the crux — spell out the attack it
  admits before choosing it.
- **Corroborate structurally rather than socially.** A reader usually reaches a block id through a
  parent it already holds (a collection header naming the block and its revision). A lone claim that
  matches an independently-held parent pointer is corroborated by evidence the attacker does not
  control. Check whether the read path has that parent in hand at the decision point.
- **Verify the claim instead of counting claimants** — `debt-read-repair-commit-cert-verification`
  in `backlog/` is exactly this, and #15 has been recorded there as new evidence. It removes the need
  for a second peer entirely, but it is `difficulty: hard` and its own prerequisite (cohort-membership
  anchoring) is not built. If the analysis lands here, say so plainly and chain rather than
  half-building it.
- **Make the second holder instead of relaxing the read.** Replication-on-cohort-growth would remove
  the singly-held state rather than learning to trust it — but note the acquiring node faces the same
  trust decision, so this is not automatically a way around the tension.
- **At minimum, and regardless of which lands: stop telling operators they are safe.** The
  `assumed-cluster-size-unset` warning's model is wrong about holders, and the `cluster-fetch:no-quorum`
  log line reports `responders` and `required` without saying that no number of cohort members can
  change the outcome for a singly-held block.

## What the fix stage must produce

A reproduction in this repo (their arithmetic case is three lines against `quorum-restore`; the
end-to-end case drives `@optimystic/db-p2p/testing` and `CoordinatorRepo` with no sockets), a
decision on the safety question with the admitted attack stated explicitly, and implement ticket(s)
sized to one agent run each. If the defensible answer is "the safe fix requires commit-cert
verification", that is a legitimate outcome — chain it, and land whatever narrow, safe improvement
stands on its own (at minimum the operator-facing warning and the diagnostic).

Do not paper over it with a config knob: `clusterPolicy.assumedClusterSize` cannot express "this
block has one holder", and the reporter's three-machine deployment has no workaround at all.

## Prior art in this repo — read before starting

- `complete/1-repair-deadlock-is-never-named` shipped the diagnostics for this area (a once-per-block
  "can never converge" signal plus a startup advisory). Its summary table reads "4+ machines: yes,
  survives one unreachable peer" — which encodes the same wrong assumption this ticket is about, since
  it silently presumes the block already has two holders. That table and the strings it describes are
  part of the fix's surface, not just background.
- `complete/corroboration-floor-uses-assumed-cluster-size` and
  `complete/corroboration-floor-defaults-to-two-for-large-meshes` are the two prior passes over
  `corroboratorCapacity`. Read both before changing it — between them they explain why the `max` is
  there, and a fix that reverts either one is not a fix.
