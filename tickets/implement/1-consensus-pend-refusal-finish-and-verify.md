description: Finish the fix for writers being told their write succeeded when every machine refused to store it — the core code change has landed and compiles; what remains is one coordinator classification hook, the regression tests, and the verification runs.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (DONE — verdict retention, promise-phase pending check, NOTE update; see "Already landed" below)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (DONE — threads localPendResult out of executeClusterTransaction)
  - packages/db-p2p/src/repo/coordinator-repo.ts (pend returns real verdict — DONE; classifyPendingConflictRejection — REMAINING)
  - packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts (model for the new unit spec)
  - packages/db-p2p/src/testing/mesh-harness.ts:492-520 (buildNetworkTransactors — for the mesh-tier regression test)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (the reproducer, "should handle concurrent writes from multiple nodes")
  - tickets/.logs/1-consensus-pend-refusal.repro.log (this run's captured repro trace)
difficulty: hard
----

# Finish: pend refusal must reach the writer as a conflict (continuation)

This continues `1-consensus-pend-refusal-is-reported-to-the-writer-as-success` (original ticket —
read its full diagnosis if anything below is unclear; this ticket replaces it). The prior run
reproduced the bug, landed the core fix, and confirmed the tree compiles, but hit its token budget
before wiring one coordinator hook and before writing tests. Do **not** re-derive the diagnosis —
resume from "Remaining work".

## Reproduced this run (2026-08-31, before any edits)

After a full `yarn build`, the reproducer failed exactly as the original ticket predicted:

```
cd packages/reference-peer
DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-p2p:coordinator*' \
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
  --reporter spec --timeout 60000 --grep "concurrent writes"
```

Three acknowledged writes; convergence timeout after 30s. Trace kept at
`tickets/.logs/1-consensus-pend-refusal.repro.log` (pruned after ~14 days). Two losers this run,
and **they lost through two different refusal shapes, both acknowledged as success**:

- action `yYQ8Vt6…`: `consensus-pend-diverged { hasMissing: false, hasPending: true }` ×3 members,
  then `pend-cluster-complete { localExecuted: true }` — the shape the original ticket documented.
- action `WRpEKnD…`: `consensus-pend-diverged { hasMissing: true, hasPending: false }` ×3 members,
  then `pend-cluster-complete { localExecuted: true }` — a **second** shape: the pend applied after
  the winner's commit had already advanced the block, so storage refused with `missing`.

## Deliberate deviation from the original ticket — record this in the review handoff

The original ticket suggested tolerating a `missing`-carrying pend refusal as local divergence
(by analogy with the commit path). **The evidence above shows that is wrong for pends**: the
`hasMissing` loser was equally acknowledged-and-lost, on all three members. The reasoning: for a
*pend*, a `missing` refusal means `latest.rev >= request.rev` — the requested revision is already
committed, so the pend can never commit; there is no "this member is merely behind" case (a behind
member saves the pend fine). Unlike commit-consensus, pend-consensus confers no durability. So the
landed code returns **both** `pending`- and `missing`-carrying refusals to the writer as retryable
conflicts (via `isConflictFailure`), and tolerates only a bare-reason refusal (no pending, no
missing — e.g. a local validation-hook fault). The reviewer should weigh this deviation explicitly.

## Already landed (compiles: `yarn build` in db-p2p passes; NOT yet run against any test)

- `cluster-repo.ts` — `executedPendResults: Map<messageHash, PendResult>` retained in
  `applyConsensusOperation`'s pend branch; exposed as `getExecutedPendResult()`; rolled back in
  `handleConsensus`'s catch; pruned alongside `executedTransactions` (same TTL loop); cleared in
  `dispose()`.
- `cluster-repo.ts` — `validatePendOperations` now does one `storageRepo.get` per pend op
  (previously only when `rev !== undefined`) and **rejects a pend whose blocks are held by a
  different unresolved pending action** (reads `state.pendings` from the same get; self-excluded;
  unavailable blocks abstain; plain-prose signed reason `pending conflict: block … held by
  unresolved action(s) …`). This is arm A: the durable storage pending record is the reservation
  that spans the pend→commit window the in-memory table clears too early.
- `cluster-repo.ts` — the tripped NOTE at the commit-signing branch of `getTransactionPhase`
  updated to record the observed lost update, the cure, and the residual.
- `cluster-coordinator.ts` — `localCluster` gains optional `getExecutedPendResult`;
  `executeClusterTransaction` returns `localPendResult` when `localExecuted`.
- `coordinator-repo.ts` — `pend` no longer hardcodes `success: true` on `localExecuted`: it returns
  the retained verdict verbatim when it is a success or an `isConflictFailure`, logs and tolerates a
  bare-reason local fault, and keeps the old fabricated-success shape only when no verdict was
  retained (older member / restart / TTL). `isConflictFailure` imported from db-core.

## Remaining work

- **Wire the arm-A rejection into a retryable answer.** A pend rejected at the promise phase by the
  new pending-conflict check surfaces as `ValidatorRejectionError`, and
  `CoordinatorRepo.classifyStaleRejection` only confirms *committed* staleness — so today that
  rejection escapes as a THROW, not a `{ success: false, conflict: true }`. Add a sibling
  `classifyPendingConflictRejection(error, request, blockIds)`: on `ValidatorRejectionError`,
  re-read `this.storageRepo.get({ blockIds })` locally; if any block's `state.pendings` contains an
  actionId ≠ `request.actionId`, return `{ success: false, conflict: true, pending: [{ blockId,
  actionId }...], reason }` (`ActionPending[]` — the type allows omitted `transform`). Unconfirmed →
  `undefined` (the rejection stays a throw; same conservative posture as the stale classifier, and
  never consult the signed reject text). Call it in `pend`'s catch after `classifyStaleRejection`:
  `const stale = await this.classifyStaleRejection(…) ?? await this.classifyPendingConflictRejection(…)`.
- **Unit spec** `packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts`, modeled directly on
  `coordinator-repo-commit-divergence.spec.ts` (stub `coordinator` the same way, now returning
  `localPendResult`): (1) retained refusal with `pending` ⇒ caller sees `success:false` +
  `isConflictFailure` true; (2) retained refusal with `missing` ⇒ same; (3) retained bare-reason
  refusal ⇒ `success:true` (tolerated); (4) retained success ⇒ returned verbatim; (5) no retained
  verdict ⇒ `success:true` fallback; (6) `ValidatorRejectionError` + local storage showing a rival
  pending ⇒ classified `conflict:true` (the new classifier); (7) `ValidatorRejectionError` with no
  local confirmation ⇒ still throws.
- **Mesh-tier regression test** in `packages/db-p2p/test/` using `buildNetworkTransactors`
  (`src/testing/mesh-harness.ts:514`): N nodes concurrently `Diary.createOrOpen(name)` then
  `append`, assert every fulfilled append is present after convergence and any rejected one reported
  a conflict. Seconds, not the reference-peer 34s.
- **Check `cancel`/`commit` `localExecuted` uses for the fabricated-success shape** and say in the
  handoff: prior analysis (carry into handoff, verify): `cancel` returns void — nothing to
  fabricate; `commit`'s `{ success: true }` at `coordinator-repo.ts` rests on commit-consensus being
  authoritative (Theorem 9) and genuine faults rolling back the executed marker — justified for
  commits, and the repro's "commit that landed nothing" was downstream of the lying pend, which is
  now fixed. State this reasoning; do not thread commit results.
- **Run the reproducer** (command above) and confirm the concurrent-writes test passes; then
  `yarn check` from root (lint + build + typecheck + test + test:integration). Watch specifically
  for suites that stub `IRepo.get` — `validatePendOperations` now calls `get` on every pend vote
  (not just rev-carrying ones), and a mock whose `get` throws or returns nothing could newly reject
  pends in existing cluster-member specs.
- **Verify the index-fork link** (original ticket's "Corrections" arm): re-run the downstream index
  reproducer with the fix applied, or capture a run where two actions both reach
  `storage-repo commit … rev=1` on disjoint member subsets; record the result either way.
- **Review handoff** into `review/`: state whether the general (non-creation) concurrent-write race
  is closed or narrowed and on what evidence; flag the residual honestly — only the COORDINATOR's
  own member's verdict is threaded back, so a refusal confined to remote members alone can still be
  acknowledged (arm A's promise-phase votes narrow exactly that window); include the `missing`-shape
  deviation above.

## Constraints (unchanged from the original — binding)

- No timeout widening; the failing test stays as-is in shape and strength; keep the per-instance
  `Collection` latch key; `advanceContext`'s no-lower guard stays; acknowledged means durable;
  wire format / storage format / signed reasons stay unchanged (all satisfied by the landed code —
  keep it that way); what to do once two lineages exist stays parked in partition-healing.
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits the custom-validator guard
  in the same method — expect a textual conflict there for whoever lands second.
