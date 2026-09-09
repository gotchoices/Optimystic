description: When two writers race for the same version of a block, a refusal spotted by a non-coordinating node never travels back to the node running the losing transaction, so it commits the losing write and ends up holding a version nobody else has. Make every cohort member's refusal reach the coordinator, and stop a member from co-signing the commit of a write it already refused.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/cluster/structs.ts, packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts, packages/db-p2p/test/cluster-consensus-divergence.spec.ts, packages/db-p2p/docs/cluster.md, docs/correctness.md
difficulty: hard
repro: verified
----

# Cohort pend refusal must reach the coordinator

Continuation of fix ticket `a-coordinator-commits-a-rival-its-own-member-refused` (research done there; this ticket carries the design). Trace evidence: downstream run in `../sereus` (`control-write-degraded-cohort-member.integration.ts`, run 3, `DEBUG='optimystic:db-p2p:*'`), block `14YGUoeu…` rev 7 — one verified observation, well captured.

## The bug, in one paragraph

Two actions raced for revision 7 of one block. Member A promised the loser `D_Y9Wz5` (coordinated by C) at 26.068; the winner `BF_B3k3` pended on A at 26.076; when D's pend consensus later applied on A, A's storage refused it (`consensus-pend-diverged { hasPending: true }`, `cluster-repo.ts:1910`) and retained the refusal — but the refusal stayed on A. C's `pend-cluster-complete` verdict is computed from C's own member only (`localVerdict: 'success'`), so the writer was told the pend won. The commit round is deliberately blind, so A co-signed D's commit (2/2 signatures), C committed D at rev 7 locally, A answered `commit:stale`. C is forked at rev 7 and every later write it makes to that block is refused.

## Research findings (settled — do not re-derive)

- **The design question the fix ticket posed is answered.** The completed ticket `1-consensus-pend-refusal-commit-tier` lists exactly this as a deliberate residual: "Only the coordinating node's own member verdict is threaded back, at both stages. A non-coordinating member's refusal stays invisible when the coordinator's own member applied the rival successfully." The same assumption is written into the pending-rival abstain comment at `cluster-repo.ts` ~:1463-1465 ("the coordinator returning the retained apply verdict (getExecutedPendResult) catches that residual") and into the commit-staleness residual doc at ~:1548-1559 ("the coordinating node's own member retains that refusal"). The observed trace is that residual biting in the wild: the refusing member was not the coordinator. The design changes; the trace is not a misread.
- **Why the promise round could not catch it:** A promised D before the rival existed on A (26.068 vs 26.076). The `validatePendOperations` pending-rival reject only fires when the rival's storage pending record already exists at promise time. The race window is promise-vote → consensus-apply, and only the apply-time verdict sees it.
- **A cheap return channel exists — no new round-trip needed.** A member executes consensus synchronously inside `processUpdate` (`await this.handleConsensus(currentRecord)` at `cluster-repo.ts:600`) before returning its response record, and the refusal is already retained in `executedPendResults` at that moment. On the coordinator side, `broadcastMergedRecord` is awaited before `executeClusterTransaction` resolves (`cluster-coordinator.ts:791`) — but it currently discards the response records (`cluster-coordinator.ts:815-831`). The verdict is in the coordinator's hands today and thrown away.
- **The wire tolerates an optional advisory field.** The cluster protocol sends and returns the whole `ClusterRecord` verbatim (`cluster/client.ts`, `cluster/service.ts`). `messageHash`/`promiseHash`/`commitHash` cover `message`, `promises`, and the membership digest only — `ClusterRecord` already carries unsigned advisory fields (`disputed`, `networkSizeHint`, …), so a new optional field breaks no signature verification and old peers simply never set it. `mergeRecords` (`cluster-repo.ts:675`) returns `{ ...existing, promises, commits }`, so the new field needs an explicit union-merge there.
- **Second hole, independently sufficient for the fork:** the commit round is deliberately blind (`getTransactionPhase` signs whenever promise approvals reach super-majority — documented "do not move it" at ~:1642-1645), and the commit-promise checks (`validateCommitRevisions`, `validateCommitOperations`) both abstain for a member that holds no pend of the committing action. So A — which had explicitly refused D's pend apply minutes of milliseconds earlier — still co-signed D's commit. `validateCommitRevisions` would have rejected only if the rival's commit had already *applied* on A at D's commit-promise time; the signed-but-not-yet-applied window is documented as the common case on a fast cohort.

## Design — two arms, both in this ticket

### Arm 1: cohort apply verdicts travel back on the broadcast response

- New optional advisory field on `ClusterRecord` (db-core `structs.ts`), e.g. `applyOutcomes?: { [peerId: string]: { pend?: 'refused-conflict' } }` — or carry the conflict-shaped `PendResult` itself so the coordinator can hand the writer real `pending`/`missing` lists. Keep it minimal: only conflict-shaped pend refusals (`pending`- or `missing`-carrying, per `isConflictFailure`) need to travel; successes and bare-reason faults are omitted (bare-reason faults stay tolerated local divergence, mirroring the existing local-verdict arm at `coordinator-repo.ts:2008-2019`).
- Member side: in the `Consensus` branch of `processUpdate`, after `handleConsensus`, read own retained verdict (`getExecutedPendResult(messageHash)`) and, when conflict-shaped, set own entry on the returned record. Never sign it; it is advisory.
- Coordinator side: `broadcastMergedRecord` collects the field from each response; `executeClusterTransaction` returns the aggregate (e.g. `remotePendRefusals`) alongside `localPendResult`.
- `CoordinatorRepo.pendThroughCluster`: if the local verdict OR any cohort member's returned verdict is conflict-shaped, return it as the retryable conflict (local verdict wins when both exist). The writer then cancels the partial pend and rebases — the fork never reaches a commit round.
- `mergeRecords`: union the field per peerId (first-seen wins per peer is fine; a peer only ever writes its own entry).
- Trust note for the doc: the field is unsigned and can only *downgrade* a reported success into a retryable conflict. A malicious member could already force worse (signed reject/conflict votes), so this adds no new attack surface beyond retry pressure; fail-toward-retry is the correct OCC direction.
- Known residual (document, do not chase): a member that only reaches consensus via the scheduled commit-retry timer (`retryCommits`) applies after `executeClusterTransaction` has returned — its refusal arrives too late for the writer's answer. Arm 2 is the backstop for that path.

### Arm 2: a member that refused an action's pend must not co-sign its commit

- Member retains pend-apply refusals keyed by **actionId** as well (today `executedPendResults` is keyed by messageHash only; the commit is a different message, so the commit-promise check cannot find the refusal). Same TTL/pruning/rollback discipline as the existing retention maps — the rollback in the `handleConsensus` catch must clear it too.
- New commit-promise check beside `validateCommitRevisions`: reject a commit when (a) this member retains a pend-apply refusal for `commit.actionId`, AND (b) current local storage still corroborates it — a rival pending still holds the commit's blocks, or a rival committed at `commit.rev`. Condition (b) is what keeps this from regressing the lagging-member/cohort-drift tolerance: a member that merely *missed* the pend retains no refusal and abstains exactly as today, and a member whose refusal's rival has since been cancelled abstains too instead of vetoing a commit the rest of the cohort holds fine. Signed prose reason, same style as the existing rejects.
- Coordinator effect: with a 2-member cohort one reject makes super-majority impossible → `ValidatorRejectionError` → the existing commit classifiers run. When the coordinator cannot confirm locally (C's own storage holds the loser pended cleanly — the trace's shape), the rejection propagates as a throw and db-core retries — but every retry meets the same reject, so the commit **never assembles consensus and the fork never happens**; the write fails loudly instead of silently forking. That is the acceptance bar for this arm, not a clean conflict answer.
- In the observed trace, arm 2 alone would have prevented the fork (A refused D's pend before D's commit round began); arm 1 alone would have prevented the commit round from ever running. Both land because each covers the other's residual.

## Deterministic reproduction (write this first, as the failing test)

The fix ticket's TODO asks for a deliberate repro; it was designed but not yet executed — build it as phase 1 and watch it fail before touching production code. All harness pieces exist:

- Real `ClusterMember` over real `StorageRepo`/`MemoryRawStorage` driven to consensus: `cluster-consensus-divergence.spec.ts` (key pairs, signing helpers, record builders).
- Real `ClusterCoordinator` with mock per-peer clients: `cluster-coordinator.spec.ts`.
- Glue: coordinator C with `localCluster` = C's real member; `createClusterClient` returns a wrapper over A's real member's `update`. Cohort {C, A}, `clusterSize: 2` config with thresholds making 2/2 the promise super-majority.
- The race injection: the client wrapper for A lets the promise-phase `update` pass through, then — before delivering any later-phase update — seeds the rival pend directly into A's storage (`storageRepo.pend` with a different actionId, same block/rev), simulating the winner's consensus landing in the promise→apply window. A's real apply then refuses with `pending` (the exact observed `consensus-pend-diverged { hasPending: true }` shape) while C's apply succeeds.
- Failing assertion today: `CoordinatorRepo.pend` resolves `success: true`. After arm 1: `success: false` with `isConflictFailure(result) === true`.
- A second test for arm 2: same harness, but suppress the broadcast response channel (or drive the commit as its own cluster transaction after the poisoned pend) and assert the commit round can no longer assemble consensus — the member that refused the pend votes reject at commit-promise.

Unit-level coverage to add alongside: extend the seam-mock tests in `coordinator-repo-pend-divergence.spec.ts` with the remote-refusal aggregate, mirroring the existing local-verdict cases.

## Verification notes

- Existing suites that pin adjacent behavior and must stay green: `coordinator-repo-pend-divergence.spec.ts`, `cluster-consensus-divergence.spec.ts` (rollback/tolerance cases), `coordinator-repo-commit-divergence.spec.ts` (lagging-member commit tolerance — the arm 2 corroboration condition exists to protect exactly this), `cluster-commit-staleness.spec.ts`, `coordinator-repo-stale-classification.spec.ts`.
- Update the residual prose this ticket obsoletes: the pending-rival abstain comment (`cluster-repo.ts` ~:1463), the commit-staleness residual block (~:1548-1559), the `1-consensus-pend-refusal-commit-tier` residual is archived history (leave it), `packages/db-p2p/docs/cluster.md` promise/commit-phase sections, and the `docs/correctness.md` commit-revision-staleness definition.
- Downstream re-check (out-of-band, do not run here): the fix ticket asked whether `../sereus`'s boot-gate timeout ("Timeout waiting for C self-publishes its CadrePeer record" — the `7 skipped` shape) still occurs now that the gapped-base guard has landed, and again after this ticket lands. That is a sereus integration run a human or downstream agent should do; record the ask in the review handoff rather than chasing it from this repo.

## TODO

Phase 1 — reproduce
- Build the deterministic two-real-member repro described above; confirm it fails (pend reported success while A retained a conflict-shaped refusal).

Phase 2 — arm 1 (verdict channel)
- Add the optional advisory field to `ClusterRecord` in db-core; member sets own conflict-shaped pend verdict on the consensus response; union-merge in `mergeRecords`.
- Collect responses in `broadcastMergedRecord`; aggregate into `executeClusterTransaction`'s result; consume in `pendThroughCluster` beside the local-verdict arm.
- Repro test from phase 1 goes green; add the seam-mock unit cases.

Phase 3 — arm 2 (commit-promise guard)
- Retain pend-apply refusals keyed by actionId (TTL, prune, rollback with the executed marker).
- Commit-promise reject when retained refusal + current storage corroboration; signed prose reason.
- Arm 2 test: the poisoned commit round can no longer assemble consensus; the lagging-member tolerance specs stay green.

Phase 4 — docs and handoff
- Update the four residual-prose sites listed under verification notes.
- Build, typecheck, full db-p2p + db-core test runs in foreground (tee into `tickets/.logs/` only if grepping is needed).
- Review handoff: note the one-observation evidence base, the retry-timer late-apply residual, and the downstream sereus re-check ask.
