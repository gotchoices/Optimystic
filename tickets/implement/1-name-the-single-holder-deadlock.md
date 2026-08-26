----
description: When a piece of data exists on only one machine, no other machine can ever get a copy of it, and today the software says nothing about that — its "this can never work" warning stays silent, and its startup advice tells operators that four or more machines are safe when that is not true for one-copy data. Make the software say what is actually happening.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, tickets/complete/1-repair-deadlock-is-never-named.md
difficulty: medium
----

# Say "only one machine has this" instead of "not enough peers answered"

From `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). This is the
diagnostics-and-operator-text half, deliberately split out because it is sound on its own and
depends on no decision. The behavioural fix is the sibling ticket
`replicate-owned-blocks-when-the-cohort-grows`; the two are independent and may land in either order.

## What was measured

Reproduced end-to-end in `packages/db-p2p` against a real `CoordinatorRepo` + `createReconcileBlock`
over in-process storage (harness copied from `test/coordinator-repo-read-repair-content.spec.ts`,
extended to three peers). Node A holds the block at rev 1; reader B holds nothing; node C holds
nothing and **answers so** — an affirmative "I hold nothing", not silence.

| configuration | outcome |
|---|---|
| 2-peer cohort, `assumedClusterSize: 2` | B acquires the block (control — repair works) |
| 3-peer cohort, honest `assumedClusterSize: 3` | `cluster-fetch:no-quorum`, B never acquires, across 5 consecutive reads |
| 3-peer cohort, unconfigured (`clusterSize: 10`) | same |

Arithmetic sweep of `corroboratorCapacity` → `quorumSize` with exactly one claim:

```
repairSize=2  nonSelfCohort=1  capacity=1  required=1  accepted=true
repairSize=2  nonSelfCohort=2  capacity=2  required=2  accepted=false
repairSize=2  nonSelfCohort=3  capacity=3  required=2  accepted=false
repairSize=3  nonSelfCohort=1  capacity=2  required=2  accepted=false   <-- note
repairSize=3  nonSelfCohort=3  capacity=3  required=2  accepted=false
repairSize=10 nonSelfCohort=3  capacity=9  required=2  accepted=false
```

The marked row is worth calling out: an operator who declares the **truth** for a three-machine
deployment (`assumedClusterSize: 3`) gets a floor of two even when only one peer is visible. Only a
declaration of exactly two ever relaxes anything.

## The three things the node says wrongly today

### 1. The "can never converge" signal stays silent for exactly this case

`CoordinatorRepo.reportRepairDeadlock` (`coordinator-repo.ts:1022`) is the once-per-block
`cluster-fetch:repair-deadlock` line shipped by `complete/1-repair-deadlock-is-never-named`. In the
3-peer repro above it **did not fire** (measured: `repair-deadlock logged: false`, over five reads),
so the operator sees only `cluster-fetch:no-quorum { responders: 1, required: 2 }` — the line that
cannot distinguish permanent from transient, which is the exact complaint that ticket existed to fix.

Why it stays silent: its decisive test is

```ts
const requiredEvenIfAllAnswered = quorumSize(cohortPeers, this.simpleMajorityThreshold, capacity);
if (cohortPeers >= requiredEvenIfAllAnswered) return;   // "transient — a peer just doesn't hold it yet"
```

With `cohortPeers = 2` and `required = 2` the cohort *could* supply the quorum, so the decline is
classified as transient. That classification rests on an assumption that is false here: **that a peer
which answered "I hold nothing" can later come to hold it.** The only two mechanisms that would make
it a holder — `CoordinatorRepo.queryClusterForLatest` and `createReconcileBlock` — consume this very
decision, so they are deadlocked too. Every peer answered, every non-holder answered absent, and no
later pass changes anything.

The condition to add is narrow and fully determined by data already in hand at the call site:

- `silentCount === 0` (everybody answered), **and**
- exactly one distinct `(rev, actionId)` group exists, with exactly one supporter, **and**
- every other cohort peer answered absent — i.e. `claims.length === 1 && answered === cohortPeers`.

That is "this block has one copy in this cohort", and it is permanent. Note the existing "nobody
claimed anything → not a deadlock" early-return must stay: an agreed absence is still an answer.

### 2. The startup advisory's fault-tolerance model ignores how many machines hold the block

`resolveClusterPolicy` (`cluster-policy.ts:184-213`) emits `repair-fault-tolerance` and tells the
operator that three machines is the minimum and that "four machines is the first size with any
margin". Both statements are true only for a block that **already has two or more holders**. For a
singly-held block, three machines repair no better than two and no machine count helps at all. An
operator reading this at four or more machines believes they are in the clear.

The text needs to distinguish the two quantities it currently conflates — how many machines the
deployment runs, and how many of them hold a given block — and say plainly that data written while
the deployment was smaller can be stranded regardless of how large it later grows.

### 3. The decline logs report responders without saying what kind of answer they were

`cluster-fetch:no-quorum` (`coordinator-repo.ts:953`) reports `responders` and `required`;
`reconcile:no-rev-quorum` (`reconcile-block.ts:175`) reports the same shape. Neither distinguishes
the three populations the node already separates internally: peers that **claimed** the block, peers
that answered **absent**, and peers that were **silent**. "1 of 2 responded" and "1 holder, 1
confirmed non-holder, 0 silent" call for completely different operator actions.

`claims.length`, `answered`, `silent.length` and `nonSelfCount` are all in scope at both sites.

### 4. The completed ticket's summary table encodes the same wrong assumption

`complete/1-repair-deadlock-is-never-named` contains a machine-count table whose row reads
"4+ machines: yes, survives one unreachable peer". That is the operator-facing claim this ticket
corrects, and the strings it describes are the ones being changed here. Update it so a reader of the
archive is not sent back to the wrong model. (Editing a `complete/` ticket is unusual; do it — it is
documentation of shipped operator-facing text, and leaving it contradicting the shipped strings is
worse.)

## Scope boundary — read this before widening

This ticket changes **no** repair decision. `corroboratorCapacity`, `quorumSize` and `selectQuorumRev`
keep their current arithmetic exactly. Two prior passes over `corroboratorCapacity`
(`complete/corroboration-floor-uses-assumed-cluster-size`,
`complete/corroboration-floor-defaults-to-two-for-large-meshes`) explain why the `max()` is there; a
change that reverts either one is not in scope here and is not a fix. If the diagnostic work tempts
you to relax the floor, stop — see `blocked/repair-floor-defends-a-door-the-push-path-leaves-open`.

## TODO

- Reproduce first. Copy the harness from `test/coordinator-repo-read-repair-content.spec.ts` into a
  new spec, extend `makeClusterPeers` to three peers (holder A, reader B, affirmative non-holder C),
  and assert the current behaviour: `cluster-fetch:no-quorum` fires, `cluster-fetch:repair-deadlock`
  does not, and B never acquires the block. Keep the 2-peer control alongside it.
- Add the sole-uncontested-claim classification to `reportRepairDeadlock`, keeping the existing
  silent-peer and nobody-claimed early returns. Give it its own wording — the operator's action for
  "only one machine has this copy" is not "run more machines", it is "get a second copy made", so
  the message must not repeat the `assumedClusterSize` advice verbatim.
- Assert the new line fires once per block (not once per pass) in the 3-peer repro, and assert it
  does **not** fire when a peer is silent, when nobody claimed, or when two peers disagree.
- Add holder/absent/silent counts to `cluster-fetch:no-quorum` and `reconcile:no-rev-quorum`.
- Rewrite the `repair-fault-tolerance` advisory so its fault-tolerance claim is scoped to blocks with
  two or more holders, and so it names the stranded-founding-data case explicitly. Update
  `test/cluster-policy.spec.ts` to pin the new wording's load-bearing parts.
- Correct the machine-count table in `complete/1-repair-deadlock-is-never-named.md`.
- Sweep the operator-facing docs that repeat the machine-count model — grep `docs/transactions.md`,
  `docs/internals.md`, `packages/db-p2p/docs/cluster.md` and `packages/reference-peer/README.md` for
  the three-machines-minimum / four-machines-margin claims and fix them the same way.
- `yarn build` then `yarn test` from `packages/db-p2p`, and `yarn lint` from root.
