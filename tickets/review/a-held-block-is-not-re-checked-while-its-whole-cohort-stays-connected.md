description: When two or three machines share a collection and every change to it needs all of them to agree, a machine that has stayed connected to the others can no longer have missed a change, so it now stops asking them "anything newer?" every ten seconds while it reads unchanged data. It still re-checks after any disconnect, while a change it agreed to is unresolved, and at least every five minutes. Review the implementation.
prereq: a-node-reports-whether-a-cohort-has-stayed-connected
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/quiet-cohort.ts (new), packages/db-p2p/src/repo/coordinator-repo.ts (`FreshnessStamp`, `ReadRepairDemand`, `readRepairDemand`, `readRepairBlock`, `startHeldBlockConsult`, `markBlocksSeen`, `connectedCohortBeforeConsult`, `quietSpanStartedBy`, `quietCohortStillVouches`, `livePendingClaims`, `fetchBlockFromCluster`), packages/db-p2p/src/cluster/cluster-policy.ts (`DEFAULT_READ_REPAIR_QUIET_WINDOW_MS`, `resolveReadRepairQuietWindowMs`), packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.readRepairQuietWindowMs`), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md, docs/reactivity.md, packages/db-p2p/docs/cluster.md
----

GitHub [#56](https://github.com/gotchoices/Optimystic/issues/56). Design from plan ticket `a-quiet-watched-collection-is-read-without-consulting-its-cohort`; the rule and its soundness argument are now written up in docs/transactions.md § Lazy read-repair window, paragraph *A held block whose whole cohort has stayed connected is not re-checked*.

## What was built

- **The rule** (a "quiet span"). In `'lazy'` mode, a held block whose window has *expired* is served from the local copy with no consult while: (1) its last consult heard from every other cohort member and found nothing ahead; (2) every commit in the cohort needs every member's promise (≥ 2 members, `cohortCanMissAPend` false — two or three at 0.75); (3) `IKeyNetwork.connectedCohort` reports the same members on the same connection runs as just before that consult; (4) this node holds no live pending record for the block. Capped at `readRepairQuietWindowMs` (default 300 000) after the consult that started it; the reads it answers do not refresh the stamp.
- **Pure decision** in `packages/db-p2p/src/repo/quiet-cohort.ts`: `QuietCohort` (an alias of `ConnectedCohort`), `cohortCommitsNeedEveryMember` (the stamp-time predicate), `quietCohortFor` (snapshot vs consulted cohort, plus the predicate), `quietCohortHolds` (read-time).
- **Recording** (`fetchBlockFromCluster`): a `connectedCohort` snapshot is taken after the empty-cohort and solo-self exits and before `queryClusterForLatest` — only when the span is enabled and the cohort size passes the predicate, so four-plus cohorts pay nothing. `FreshnessStamp.quiet` is set only at the local-current exit, a converged acquisition with `rev === corroborated.rev`, and the `cohort-too-small` arming with `nothing-ahead`, through `quietSpanStartedBy` (no silent peer; no claim ahead; snapshot equals the consulted set). Every other `markBlocksSeen` caller writes no `quiet`, which ends a span.
- **Reading** (`readRepairBlock`): `shouldReadRepair` became `readRepairDemand`, returning `'unstamped' | 'expired' | 'sampled' | 'always'`. Only `'expired'` on the `windowOnly` path (lazy, no floor demand, after the `skipWindowConsult` branch) consults the span. `awaitWindowConsults` is skipped the same way, because the check sits before the background/blocking split.
- **Knob**: `clusterPolicy.readRepairQuietWindowMs`, resolved by `resolveReadRepairQuietWindowMs` (default 300 000; `0` = off; anything outside a finite `[0, MAX_READ_REPAIR_WINDOW_MS]` throws). `CoordinatorRepo` applies the same resolver to its `cfg`, and sets its effective value to 0 unless the mode is `'lazy'`, the value is above `readRepairWindowMs`, and the key network has `connectedCohort`.
- **Logs**: `cluster-tx:read-repair-quiet` (`blockId`, `localRev`, `ageMs`, `members` = count) once per stamp, through a `quietLogged` flag on the stamp. Failure lines `cluster-fetch:quiet-check-failed` and `cluster-fetch:connected-cohort-failed` both leave the read consulting as it would without a span.
- **NOTEs** at `quietCohortStillVouches`: the late-decision residual (a promise approved without holding the pend), the partner-view residual, and the per-read cost. The accepted-tradeoff NOTE at the local-current exit now names the quiet span as the signal it waited for, and says the single-voter arming decision stands.

## Deviations from the plan — please scrutinise

- **The consult round's synchronous join.** The ticket put an `await` (fresh `connectedCohort` plus the pending read) ahead of the background consult, but `readRepairBlock` must join its read's `ConsultRound` before its first await: `get` closes the round as soon as every pass has started, and a later `round.join()` throws. So a quiet candidate now takes its seat first (`reserved = round?.join()`), and then either readies it unused (span holds), hands it to the blocking consult, or hands it to `startHeldBlockConsult`, which readies it when no pass starts (`running` / `deferred`). If any path leaked an unreadied seat, every other block of that read would hang behind it. `quietCohortStillVouches` catches everything for that reason. The lapse tests below exercise the hand-over on the mesh, where a round exists; **no test covers a multi-block read in which one block's span holds and another consults** (by inspection only).
- **"Nothing ahead" is stricter than the ticket stated**: a claim at this node's revision under a *different* action also blocks the span (a fork at one revision; the window's cadence learns nothing from it either, but the span should not paper over it).
- **Abandoned pending records** (`isAbandonedClaim`: applied alone, by a writer in an earlier run of this node's process) do not block the span. Such a record can never commit. `pendingClaimsOf` and the new check now share `livePendingClaims`.

## Tests (`packages/db-p2p/test/coordinator-repo-read-repair.spec.ts`, describe *a held block whose whole cohort stays connected*, on the mesh harness with the coordinator's `now` seam)

- *ten reads of an unchanged block 15 s apart consult once, and say so once* — the #56 reproduction (two members; before: 10 consult requests to the partner), plus the once-per-stamp log.
- *consults again once the span lapses*: *when a member's connection breaks* (`mesh.reconnect`), *while this node holds a pending record for the block*, *once readRepairQuietWindowMs has passed since the consult*, *never, in a cohort of four* (3 reads → 3 consults). These are the branches of the rule.
- *a consult with a silent member starts no span, even when it finds this node current* — three members, one silent, the other's certified claim settles currency (asserts `cluster-fetch:local-current` so the arm is not vacuous).

The shared fixture now declares the block's digest on its commit, so each member keeps the cohort's proof, which is what the silent arm needs. Mutation checks run by hand: removing the silent guard, the pending check, or the run comparison each failed exactly one of the six. No resolver test was added; `resolveReadRepairWindowMs` has none to mirror.

## Validation run

`yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` from root; `yarn test` in db-p2p (3653 passing), db-core (2060), and quereus-plugin-optimystic (1381). No integration spec mentions read repair, so `yarn test:integration` was not run.

## Known gaps

- Not tested: the `cohort-too-small` and converged-acquisition recording exits, the sample-rate exclusion, the floor exclusion, and the concurrent-read cases. All were checked by inspection only, as the plan allowed.
- Per-read cost: one `connectedCohort` assembly and one metadata read per expired read of each quiet block, plus one extra assembly per consult in two- and three-member cohorts. The tripwire is the NOTE at `quietCohortStillVouches`; it was not measured on a device.
- `members` on the log line is a count, not the peer list.

## Handoff note for the maintainer, to pass to Sereus

`strandClusterPolicy` does not forward `readRepairMode`, `readRepairWindowMs` or the new `readRepairQuietWindowMs`. The extension works with nothing forwarded (defaults apply), but a strand that wants a different cap, or the old behaviour (`0`), needs them forwarded. Separately, a strand that declares its size (`repairCorroborationClusterSize` from its membership records) also gets commit stamps. This rule does not need them and does not conflict with them: a commit stamp carries no quiet cohort, so it ends a span, and the next expired read consults once and starts a new one.
