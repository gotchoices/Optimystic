description: One machine can now ask another, over the existing block-repair protocol, whether its copy of a block was built from a given earlier version, and both repair paths use that answer, so a machine that forked while alone no longer replaces the group's version on a real network.
prereq: repair-asks-a-lone-ahead-claimant-for-its-lineage
files: packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/repo/stated-holdings.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/network/i-repo.ts, packages/db-p2p/test/sync-lineage-question.spec.ts, packages/db-p2p/test/mesh-reconcile-quorum.spec.ts, docs/internals.md, docs/debugging.md, .release-notes.pending.md
----

# The sync consult answers a lineage question

`repair-asks-a-lone-ahead-claimant-for-its-lineage` gave both block-repair paths an optional way to ask a lone machine, whose self-signed revision sits one above the pair the rest of the cohort backs, whether its own history contains the group's pair (`askLineage` on `ReconcileBlockDeps`, `blockLineageCallback` on the coordinator). Nothing supplied it. This ticket supplies it over the sync protocol.

- **Wire** (`packages/db-p2p/src/sync/protocol.ts`): `SyncRequest.lineageOf?: Record<BlockId, ActionRev>` and `SyncBlockAnswer.lineage?: BlockLineage`, both optional. An older peer ignores the field; the asker reads its answer as `unknown`, which leaves repair choosing as before.
- **Server** (`SyncService.answerConsult` in `packages/db-p2p/src/sync/service.ts`): a request carrying `held` or `lineageOf` is answered per block in `answers`. The claim/archive is served only when `held` is present, so a lineage-only question never ships the fork's bytes back. The lineage is served when `lineageOf` names that block with a usable `(rev, actionId)` (`isActionRev`, now exported from `stated-holdings.ts`); a serve fault is logged and leaves `lineage` out.
- **The read** (`serveLineageAnswer` in `packages/db-p2p/src/storage/block-archive.ts`): one cluster-skipping `repo.get` with `BlockGets.lineageOf`, shared by the sync service, a node's self ask, and the mesh harness. `lineageFromSyncResponse` is the asker's projection. `withoutContent` now keeps a lineage answer beside a size-reduced archive.
- **Production callback** (`blockLineageCallback` in `packages/db-p2p/src/libp2p-node-base.ts`): one `SyncClient` request under the consult's per-peer budget, handed to both repair paths.
- **Mesh harness** (`makeAskLineage` in `packages/db-p2p/src/testing/mesh-harness.ts`): mirrors the production callback, so every mesh-tier test runs with the question answered.

Accepted deviation from the plan: a lineage-only request gets no archive (the plan routed it through the consult branch, which would have shipped up to 7.5 MiB of fork content for nothing). The `SyncBlockAnswer.archive` doc states the consequence: "no archive means holds nothing" holds only for a request that carried `held`.

## Review findings

Read the `ticket(implement): the-sync-consult-answers-a-lineage-question` diff before the handoff.

**Correctness — checked, no defect found.**
- Server routing: a lineage-only request reaches `answerConsult`; a block in `blockIds` but not in `lineageOf` gets `{}`; a malformed or prototype-key entry fails `isActionRev` and is skipped. The target is copied field by field before it reaches storage.
- The served repo proxy forwards `get` to `CoordinatorRepo`, whose `skipClusterFetch` branch returns `StorageRepo.get`'s local result, and `StorageRepo.get` answers `lineageOf` per entry (`answerLineage`) — so a peer answers from its own records, as the docs claim. No context is sent, so the read cannot trigger a read-driven promotion.
- `withoutContent` spread order keeps `lineage` and overwrites `archive`/`contentOmitted` as intended.
- A rejection of the callback (dial failure, budget expiry) is counted as `silent` by `settleSoloAhead`, leaving the verdict `unknown` — never a throw out of either repair path.
- The read path deadlines the ask twice with the same budget (the coordinator's `withDeadline` and the callback's `withinRequestBudget`). Redundant but harmless; the callback's own budget is what bounds the commit-path reconcile's ask.
- `RepoService.answerGet` builds its options server-side, so a remote peer cannot set `skipClusterFetch` over the repo protocol.

**Type safety — fixed inline.** The diff added a fourth `{ skipClusterFetch: true } as any`. Added `skipClusterFetch?: boolean` (documented as never sent) to `MessageOptions` in `packages/db-core/src/network/i-repo.ts` and removed the casts at all four production sites: `serveLineageAnswer` and `serveConsultAnswer`'s read in `block-archive.ts`, the harness's archive read, and `CoordinatorRepo.get`'s read of the option. Test-file casts left as they are.

**Tests — kept as written.** `sync-lineage-question.spec.ts` pins the wire contract through the real handler (lineage-only request answered, no archive served; non-asking consult carries no lineage; older-peer form projects to `unknown`). The two mesh tests pin the end-to-end behaviour of the read path for both verdicts, and the implementer mutation-checked them. None restates the implementation or verifies a mock. No test added: the review found no defect to reproduce.

**Known gaps, accepted.** The production `blockLineageCallback` closure has no test of its own (it is composed from tested pieces and is a near copy of `fetchArchiveFromPeer`'s request shape). The combined `held` + `lineageOf` form is unused and untested. No integration spec seeds the fork shape, so `yarn test:integration` would not reach the callback; not run.

**Docs — read every touched file and the ones that should have been touched.** `docs/internals.md` (*One-peer proofs*, *On the repair wires*, the certified-claim log lines), `docs/debugging.md` (no-quorum table row and the new fork-declined/solo-ahead section), and `.release-notes.pending.md` (new unreleased entry; the historical "Known limitations" bullet restored with a pointer forward) all match the code. `yarn lint:docs` resolves everything. `MessageOptions` has no prose doc to update.

**Resource cleanup, performance, size.** No new long-lived state; one extra request per lone claimant only in the fork shape, with the existing `NOTE:` on `serveLineageAnswer` naming the remedy if it shows in traces. No tripwire added, no ticket filed.

**Validation.** Rebuilt db-core and db-p2p; `yarn test` in db-p2p: 3633 passing, 75 pending, 0 failing. eslint over every changed source and spec file: clean. `yarn lint:docs`: all resolve. The `MessageOptions` change only adds an optional field, so the quereus plugin suites (1204 passing at implement) were not re-run.
