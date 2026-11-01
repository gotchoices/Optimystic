description: One machine can now ask another, over the existing block-repair protocol, whether its copy of a block was built from a given earlier version, and both repair paths use that answer, so a machine that forked while alone no longer replaces the group's version on a real network.
prereq: repair-asks-a-lone-ahead-claimant-for-its-lineage
files: packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/repo/stated-holdings.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/sync-lineage-question.spec.ts, packages/db-p2p/test/mesh-reconcile-quorum.spec.ts, docs/internals.md, docs/debugging.md, .release-notes.pending.md
----

# The sync consult answers a lineage question — review

## What changed

`repair-asks-a-lone-ahead-claimant-for-its-lineage` gave both repair paths an optional `BlockLineageAsk` (`askLineage` on `ReconcileBlockDeps`, `blockLineageCallback` on the coordinator) that nothing supplied. This ticket supplies it over the sync protocol.

- **Wire** (`packages/db-p2p/src/sync/protocol.ts`): `SyncRequest.lineageOf?: Record<BlockId, ActionRev>` and `SyncBlockAnswer.lineage?: BlockLineage`, both optional. Docs on `blockIds`, `answers` and `SyncBlockAnswer.archive` updated for the new form.
- **Server** (`packages/db-p2p/src/sync/service.ts`): a request carrying `held` or `lineageOf` goes to `answerConsult`. Per block, the claim/archive is served only when `held` is present; the lineage is served when `lineageOf` names that block with a usable `(rev, actionId)` (checked by `isActionRev`, now exported from `packages/db-p2p/src/repo/stated-holdings.ts`, the existing wire guard). A serve fault is logged and leaves `lineage` out.
- **The read** (`packages/db-p2p/src/storage/block-archive.ts`): `serveLineageAnswer(repo, blockId, target)` = one `repo.get({ blockIds, lineageOf }, { skipClusterFetch: true })`, answering `'unknown'` when the repo leaves `lineage` out. Used by the sync service and by a node's self ask. `lineageFromSyncResponse` is the asker's projection (no `answers`, or no `lineage` → `'unknown'`). The tripwire `NOTE:` (send `lineageOf = held` on the first consult if the second round shows in traces) sits on `serveLineageAnswer`. `withoutContent` now spreads the answer first, so a lineage answer riding with a `held` consult survives the size reduction.
- **Production callback** (`packages/db-p2p/src/libp2p-node-base.ts`): `blockLineageCallback`, defined beside `fetchArchiveFromPeer` (it must exist before `createReconcileBlock`), sends `{ blockId, blockIds: [blockId], rev: undefined, lineageOf: { [blockId]: target } }` under `withinRequestBudget` with `cohortQueryTimeoutMs`; a self ask reads `storageRepo` through `serveLineageAnswer`. Passed to `createReconcileBlock` as `askLineage` and to the coordinator factory as `blockLineageCallback`. Its comment cites the existing cold-relay `NOTE:` in `clusterLatestCallback` rather than repeating it.
- **Mesh harness** (`packages/db-p2p/src/testing/mesh-harness.ts`): `makeAskLineage` mirrors the production callback (same `serveLineageAnswer` read, silent peers and stopped instances reject) and is wired into both repair paths of every mesh node, so every mesh-tier test now runs with the question answered, as production does.

## Deviation from the ticket, for the reviewer to weigh

The ticket said to answer a `lineageOf` request "like a consult", routed through the consult branch. With no `held`, `serveConsultAnswer` treats the asker as holding nothing and ships the whole block, and the lone claimant is by definition ahead, so every lineage question would have carried the fork's full bytes (up to 7.5 MiB) back for nothing. A request carrying only `lineageOf` now gets answers with `lineage` and no archive. The cost: "an answer without an archive means the peer holds nothing" is now true only for a request that carried `held`, which `SyncBlockAnswer.archive`'s doc says. No consumer reads the archive of a lineage-only answer.

## Tests added

- `packages/db-p2p/test/sync-lineage-question.spec.ts` — a real `SyncClient` against a real `SyncService` over a `StorageRepo`, through the registered handler and `makeLinkedPair`:
  - a lineage-only request is answered `contains` for the held pair and `excludes` for another action at the held revision, with no archive served;
  - a consult without `lineageOf` carries no `lineage`, and the single-archive form (what a server on an older build sends back) projects to `unknown`.
- `packages/db-p2p/test/mesh-reconcile-quorum.spec.ts`, describe *mesh repair asks a lone ahead machine for its lineage* — three members, `readRepairMode: 'paranoid'`, fork seeded through real pend/commit (`landForkRevision`): group holds `(5, cohort-5)` under a 3-signer proof; the lone node holds rev 5 and an update-only `(6, solo-fork)` under a 1-signer proof.
  - lone rev 5 is `solo-5` → the reader keeps `(5, cohort-5)` and logs `cluster-fetch:fork-declined` once;
  - lone rev 5 is `cohort-5` → `cluster-fetch:solo-ahead` with `verdict: 'same-lineage'`, and the reader acquires `(6, solo-fork)` with the lone node's bytes.
  - Mutation-checked: with the harness callback forced to answer `unknown`, both fail.

The `sync-deadlines.spec.ts` the ticket pointed at tests storage sync deadlines, not the sync protocol, so the service-level test is a new file.

## Validation

- `yarn workspace @optimystic/db-p2p build` and `yarn test` in db-p2p: 3633 passing, 75 pending, 0 failing.
- `yarn test` in quereus-plugin-optimystic (it uses the mesh harness): 1204 passing, 14 pending, 0 failing.
- eslint over every changed source and spec file: clean. `yarn lint:docs`: all resolve.
- Not run: `yarn test:integration`, `yarn check`, `yarn typecheck`. No integration spec seeds the fork shape, so the integration tier would not reach the new callback anyway.

## Known gaps

- **The production `blockLineageCallback` closure has no test of its own.** It is composed from pieces that are tested (the client↔service round trip with `lineageOf`, `lineageFromSyncResponse`, `serveLineageAnswer`, the settle round), and the type checker covers its wiring into both factories; the mesh tests run the harness's mirror, not this closure.
- **The combined form (`held` and `lineageOf` together) is untested.** It is unused; the `withoutContent` spread is what keeps it correct under the size budget.
- A malformed `lineageOf` entry from a peer gets no `lineage`, which the asker reads as `unknown`; untested, and harmless since only the asker reads it.
- Request size: one pair per block adds a few dozen bytes to a request decoded under `MAX_CONTROL_MESSAGE_BYTES`. By inspection.

## Docs

- `docs/internals.md`: the *One-peer proofs* sentence no longer says the callback is absent; *On the repair wires* has a paragraph on the lineage question as the third thing the sync protocol carries; the *Certified-claim log lines* list adds `fork-declined` and `solo-ahead` for both prefixes as informational.
- `docs/debugging.md`: the no-quorum table's "holders disagree" row points at `cluster-fetch:fork-declined`, and a new section reads both lines and every `verdict`/`answers` value.
- `.release-notes.pending.md`: new entry *A machine that forked while alone no longer replaces the group's version* in the unreleased-since-v1.22.0 section, with mixed-version behaviour. The previous review had rewritten a "Known limitations" bullet under the old *Unreleased — since v0.25.1* section to describe this ticket's prereq; that bullet is restored to its historical meaning with a "closed since v1.22.0" pointer to the new entry.
