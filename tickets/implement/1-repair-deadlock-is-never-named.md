----
description: When a group of machines is too small — or too poorly connected — to double-check each other's copy of a record, the repair that would fix a stale copy quietly declines, over and over, forever. Nothing ever says "this will not fix itself"; the advice printed at startup is also wrong about how many machines you need.
prereq:
files: packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/cluster-policy.spec.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/internals.md
difficulty: medium
----

# A repair that can never converge must say so, once, in words

## Where this came from

Filed out of `fix/stale-read-returned-as-authoritative-when-repair-cannot-converge`. That ticket
carried two arms. The first — *a present-but-stale block served as authoritative* — **was already
fixed** before the ticket was written (`coordinator-serves-stale-data-as-if-confirmed`, reviewed
2026-08-12); re-verified during this investigation, see that ticket's findings. This is what is
left: the repair still cannot converge, and **nothing tells anybody that.**

The field symptom that started it: one node logged 1821 `cluster-fetch:no-quorum` lines and 954
`read-repair-triggered` in a single boot, applied 2 repairs, and reported no error of any kind.
Twelve days of investigation went into re-deriving, from those logs, a fact the node already knew
at the moment of each decline.

## The rule nobody states

Read-repair accepts a peer's claimed revision only when a **quorum of distinct corroborating
peers** agree on the exact `(rev, actionId)` pair. `quorumSize` (in `quorum-restore.ts`) floors
that at `CORROBORATION_FLOOR` (2), and relaxes the floor only as far as `corroboratorCapacity` —
`max(cohortPeersOtherThanMe, repairCorroborationClusterSize - 1)`.

Sweeping that arithmetic over real cohort sizes (measured by calling `resolveClusterPolicy`,
`corroboratorCapacity` and `quorumSize` directly; `clusterSize` set to the node count, with and
without a declared `assumedClusterSize`):

```
nodes | declared | peers who answered | capacity | corroborators needed | converges?
  2   |    -     |         1          |    1     |          1           |  yes
  3   |    3     |         1          |    2     |          2           |  NO
  3   |    3     |         2          |    2     |          2           |  yes
  4   |    4     |         1          |    3     |          2           |  NO
  4   |    4     |         2          |    3     |          2           |  yes
  5   |    5     |         2          |    4     |          2           |  yes
```

Stated plainly, and true for every configuration tried:

- **A cohort of 3 or more needs two cohort peers besides the reader to answer.** Fewer than two
  answering means the repair declines, whatever `assumedClusterSize` says.
- **A three-machine deployment therefore has zero fault tolerance for repair.** Both of the
  reader's two peers must be reachable *from that reader*. One unreachable peer — even one that is
  perfectly healthy and reachable from everybody else — makes that reader's copy permanently
  unrepairable.
- A cohort of exactly 2 is the one size whose floor relaxes to a single corroborator, and only
  when the deployment's size is declared. **Left undeclared, `repairCorroborationClusterSize`
  falls back to `clusterSize` (default 10), so capacity is 9, the floor stays 2, and a two-machine
  deployment can never repair anything at all.**

None of this is wrong as a safety property — relaxing the floor because peers went *silent* is
exactly the lever an attacker would pull, and the code argues that case carefully at
`corroboratorCapacity` and at the no-quorum return in `queryClusterForLatest`. **Do not relax it
here.** The real fix is proof rather than headcount (see *Not this ticket* below). What this ticket
changes is that the condition becomes **legible**.

## Arm A — name the provable configuration deadlock at the repair site

`CoordinatorRepo.queryClusterForLatest` already computes everything needed to tell a transient
apart from a permanent one, and throws it away:

- `silent` — cohort peers that did not answer.
- `claims` — the peers that did.
- the quorum it needed.

When **`silent.length === 0`** and the quorum still fails *for want of voters* (`claims.length > 0`
but below the required count, and no two claims disagree), then **every cohort member that exists
answered, and there were still not enough of them.** No peer was silenced, so no attacker induced
this: it is a property of the deployment's size and configuration, and it will hold on every
subsequent pass until the configuration or the machine count changes.

That deserves its own name, emitted once per block rather than folded into the `no-quorum` line
that fires on every pass. It should carry the numbers (`cohortPeers`, `answered`, `required`,
`repairCorroborationClusterSize`) and the remedy (`clusterPolicy.assumedClusterSize`, or an honest
`clusterSize`), and it should say the word *permanent*.

Note the distinction that keeps this honest: with peers silent, the same shortfall is **not**
provably permanent — the silent peer may come back, and the reader cannot tell an unreachable peer
from a withholding one. Those passes keep the existing `no-quorum` line. Only the all-answered
shortfall is provable.

Rate-limiting: the existing per-block freshness state is the natural home — a block with a recorded
entry in `unsettledAheadClaims` is exactly a block whose last repair failed to converge. Hang the
"already said this" bit off that rather than introducing a fourth per-block map;
`backlog/debt-freshness-state-scattered-across-coordinator-repo` already objects to how many there
are.

## Arm B — the startup advisory oversells three machines, and stays quiet when it shouldn't

`resolveClusterPolicy` (`cluster-policy.ts`) logs `assumed-cluster-size-unset` at construction. Two
problems, both measurable against the table above:

1. **Its arithmetic is right and its conclusion is wrong.** It computes
   `minimumSelfHealingDeployment = CORROBORATION_FLOOR + 1 = 3` and tells the operator that a
   deployment of three or more machines "can ignore this". Three machines is the minimum that can
   *ever* repair, not a size at which repair is safe: at exactly three, both peers must be
   reachable from the reader on every pass. The message should say what the requirement actually
   is — two reachable cohort peers besides the reader — and that three machines leaves no margin.

2. **It never fires when `assumedClusterSize` IS declared.** A declared `assumedClusterSize: 3`
   has precisely the same zero tolerance as an undeclared one; declaring a number does not conjure
   a third peer. The existing comment defends the silence on the grounds that a declaration is an
   explicit assertion this function cannot contradict — true for *whether the number is honest*,
   but the fragility of a three-machine cohort follows from the number itself, not from whether it
   is accurate. Widen the condition so a resolved `repairCorroborationClusterSize <= 3` advises
   either way, with wording appropriate to each case.

Keep it one advisory per node construction, as now.

## Not this ticket

- **Relaxing the corroboration floor in any form.** Every variant considered during the
  investigation reduces to "trust fewer voters because the others did not answer", which is the
  attack the floor exists to stop. Including the tempting one — using `answered` instead of the
  cohort size as the capacity — since a routing-level attacker who shrinks a reader's cohort view
  to `[reader, attacker]` produces `answered === 1` with nobody silent, and would be believed.
- **The actual convergence fix.** Corroboration counts voters because it has no way to *prove* a
  revision committed. The cohort does produce that proof — a commit certificate — and it is not
  carried anywhere a repairing node can read it. That work is
  `backlog/debt-read-repair-commit-cert-verification`, to which this investigation appended an
  availability arm and a severity upgrade. Its own prerequisite
  (`backlog/feat-cluster-membership-threshold-cert-anchoring`) is not built, so it is not
  promotable yet — which is exactly why making the deadlock legible is worth landing on its own.
- **Carrying the deadlock into the error the reader sees.** `BlockPossiblyStaleError` currently
  tells a caller its data may be stale and implies a retry might help; when the coordinator knows
  the repair is deadlocked-as-configured, "retry" is wrong advice. Genuinely worth doing, but it
  needs a new field on `GetBlockResult` and a matching change to the error and its documented
  contract — a wider surface than this ticket, and better designed once Arm A has established
  where the condition is detected. Leave a `NOTE:` at the Arm A site pointing at it rather than
  widening scope here.

## Done means

An operator running two or three machines learns from the node's own output that repair cannot
self-heal, and what to set — instead of from a thousand identical debug lines and a fortnight of
log archaeology.

## TODO

Phase 1 — pin the rule in a test before changing anything

- Add a spec to `packages/db-p2p/test/quorum-restore.spec.ts` asserting the fault-tolerance rule
  directly: for cohorts of 2..6, with and without a declared `assumedClusterSize`, assert the
  number of answering peers required. This is the guard that stops the table above from drifting
  silently; state it as "corroborators required", not as a restatement of the formula.

Phase 2 — Arm A, the repair-site deadlock condition

- In `CoordinatorRepo.queryClusterForLatest`, at the `!selected` return, distinguish the
  provably-permanent shortfall (`silent.length === 0`, at least one claim, claims below the
  required count, no two claims disagreeing) from the ordinary one.
- Emit a distinct named log for it — once per block — carrying `cohortPeers`, `answered`,
  `required`, `repairCorroborationClusterSize`, and the remedy in words. Keep the existing
  `cluster-fetch:no-quorum` line for every other decline.
- Hang the once-per-block suppression off the existing `unsettledAheadClaims` entry rather than a
  new map; if that turns out not to fit, say why in the handoff rather than adding a fourth map
  quietly.
- Add a `NOTE:` at the site pointing at the deferred reader-facing error (see *Not this ticket*).
- Specs in `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts`: the deadlock line fires
  once for an all-answered shortfall; it does **not** fire when a peer was silent; it does not fire
  when the decline was a genuine disagreement between two claims; it does not repeat across passes
  for the same block.

Phase 3 — Arm B, the startup advisory

- Rewrite the `assumed-cluster-size-unset` message to state the real requirement (two reachable
  cohort peers besides the reader) and that a three-machine deployment has no margin.
- Widen the trigger so a resolved `repairCorroborationClusterSize <= 3` advises whether or not
  `assumedClusterSize` was declared, with wording that fits each case; keep it once per node
  construction.
- Rename the log tag if `assumed-cluster-size-unset` no longer describes when it fires.
- Update `packages/db-p2p/test/cluster-policy.spec.ts` for the widened trigger and the new wording.

Phase 4 — documentation and gate

- Update the repair/corroboration section of `docs/internals.md` with the fault-tolerance rule and
  the two new signals. Check any neighbouring statement that implies three machines self-heal.
- `yarn lint`, `yarn build`, `yarn test` from the repo root, all green. `yarn test:integration`
  exceeds the runner's idle limit — skip it and say so in the handoff.
