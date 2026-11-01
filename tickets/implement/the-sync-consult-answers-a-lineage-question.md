description: Lets one machine ask another, over the existing block-repair protocol, whether the other's copy of a block was built from a given earlier version, and wires that question into both repair paths so the fork check the previous ticket added runs on a real network.
prereq: repair-asks-a-lone-ahead-claimant-for-its-lineage
files: packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/client.ts (read only), packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/solo-ahead.ts, packages/db-p2p/test/mesh-reconcile-quorum.spec.ts, packages/db-p2p/test/sync-deadlines.spec.ts, docs/internals.md, docs/debugging.md
difficulty: medium
----

# The sync consult answers a lineage question

## What this supplies

`repair-asks-a-lone-ahead-claimant-for-its-lineage` added the rule and an injectable `BlockLineageAsk` to both repair paths, absent in production. This ticket supplies the production callback: a request on the sync protocol, the block-repair wire both paths already use, answered from the serving node's own storage.

## Why the sync protocol, not the repo protocol

`NetworkTransactor.getLineage` already asks `lineageOf` over the repo protocol (`RepoClient.get` with `BlockGets.lineageOf`). That request lands in the far node's `CoordinatorRepo.get`, which may start that node's own cohort consult inside its read-repair window, redirect, or be refused by the responsibility check; the question repair wants is "what do YOU hold", which is the sync protocol's contract: `serveConsultAnswer` and `serveBlockArchive` in `packages/db-p2p/src/storage/block-archive.ts` read the repo with `skipClusterFetch` and never consult anyone. The served repo (`createServedRepoProxy` in `packages/db-p2p/src/repo/served-repo-proxy.ts`) routes `get` through the coordinator, and `CoordinatorRepo.get` already carries `lineageOf` through to the local `StorageRepo.get`, whose `answerLineage` fills `GetBlockResult.lineage` from this node's own records. So the lineage answer is one `repo.get({ blockIds: [blockId], lineageOf: target }, { skipClusterFetch: true })` on the serving side, with no new storage path.

## The wire

- `SyncRequest.lineageOf?: Record<BlockId, ActionRev>` in `packages/db-p2p/src/sync/protocol.ts`: per asked block, the pair the asker wants judged. Optional, so a peer on an older build ignores it and answers as before. It may ride with or without `held`; `blockIds` lists the blocks as a consult does.
- `SyncBlockAnswer.lineage?: BlockLineage`: the serving node's own answer for that block, present exactly when the request asked. Absent reads as `unknown` on the asker, which is what the helper already does with a silent claimant.
- `SyncService` (`packages/db-p2p/src/sync/service.ts`): a request carrying `lineageOf` is answered in `answers` like a consult (route it with the consult branch: `held` or `lineageOf` present → `answerConsult`), and `buildConsultAnswer` adds the lineage from a new `serveLineageAnswer(repo, blockId, target)` in `block-archive.ts`, one function so a self answer and a remote answer use the same read. A serve fault reads as no lineage, logged, never as a lost claim.
- Client: `SyncClient.requestBlock` takes a `SyncRequest`, so nothing changes there.

## The callback

In `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`), beside `clusterLatestCallback`: `blockLineageCallback(peerIdStr, blockId, target)` builds a `SyncClient` for the peer, sends `{ blockId, blockIds: [blockId], rev: undefined, lineageOf: { [blockId]: target } }` under `withinRequestBudget` with `cohortQueryTimeoutMs`, and returns `response.answers?.[blockId]?.lineage ?? 'unknown'`. A self ask (the peer is this node) reads the local `storageRepo.get` with `lineageOf` directly, as the consult's self short-circuit does, though neither path should ever ask self (self is excluded from the claim set). Dial failures and timeouts reject, and the helper counts a rejection as `unknown`. Pass it to `coordinatorRepoFactory` as the option the previous ticket added, and to `createReconcileBlock` as `askLineage`.

## Docs

- `docs/internals.md`, *On the repair wires* under *Durable commit proof*: add the lineage question as the third thing the wires carry, and in the *Certified-claim log lines* list add `cluster-fetch:fork-declined` / `reconcile:fork-declined` (informational, a lone machine's fork losing to the group it left, not an incident) and `cluster-fetch:solo-ahead` / `reconcile:solo-ahead`.
- `docs/debugging.md`: the `cluster-fetch` log-line table gets the two new lines, with the verdict field explained, and the row that discusses `holders` disagreeing points at `fork-declined` as the line that says a disagreement was settled by lineage.
- Run `yarn lint:docs`.

## Edge cases & interactions

- **Mixed versions.** An older serving peer ignores `lineageOf`; with no `held` either it answers the single-archive form, which has no `answers`, so the callback returns `unknown`. With `held` present it answers `answers` without `lineage`, also `unknown`. Both read as "could not say", the default of the previous ticket. Pin the first in the service-level test by sending the request to a service that predates the field, or by asserting on `answers` absent → `unknown` in the callback's projection.
- **The question rides with a consult.** A request carrying both `held` and `lineageOf` for the same block gets both the claim and the lineage in one answer. Not used by this ticket, but it must not break: `fitConsultContent` only touches archives, and the lineage field rides outside the archive. Tripwire `NOTE:` at `serveLineageAnswer`: if the second round ever shows in traces, send `lineageOf = held` on the first consult, which answers the question for free whenever the asker already holds the group's pair (the ordinary group-member read), and keep the second round for a reader that is behind or holds nothing.
- **Request size cap.** The sync request is decoded under `MAX_CONTROL_MESSAGE_BYTES`; one pair per block adds a few dozen bytes, nothing to re-budget. By inspection.
- **The served repo proxy's `get` goes through the coordinator.** With `skipClusterFetch` the coordinator reads local storage and forwards `lineageOf`; confirm by reading the `skipClusterFetch` branch of `CoordinatorRepo.get` around the `lineageOf` carry-through, and pin it in the service-level test (a `StorageRepo` with a known revision index answers `excludes` for a pair naming another action at a held revision).
- **A peer that holds nothing of the block** answers `behind` from `lineageOf`; the helper treats it as `unknown`. No special case here.
- **Cold relayed connection.** The consult's `NOTE:` about the request budget not covering a cold relayed open applies to this request too; a claimant reachable only through a relay nothing else has dialed reads as `unknown`. Same accepted limit, same remedy; cite the existing note rather than repeating it.

## Tests

- One service-level test (in `packages/db-p2p/test/sync-deadlines.spec.ts`'s harness or a sibling that already stands up `SyncService` over a `StorageRepo`): a request carrying `lineageOf` is answered with the storage's own verdict, `excludes` for a held revision under another action, `contains` for the held pair; and a request without the field gets an answer without `lineage`.
- End to end, in `packages/db-p2p/test/mesh-reconcile-quorum.spec.ts` if its harness can seed storage directly: three members, two holding `(5, cohort)`, one holding `(5, solo-5)` then `(6, solo-fork)` with a minted one-peer proof, no partition machinery (the fork is seeded, not produced by a partition); a read on a group member keeps `(5, cohort)` and logs `cluster-fetch:fork-declined`; the same seed with the lone node's revision 5 being `cohort` (it really built on the group's pair) acquires `(6, solo-fork)`. If seeding a fork through the harness costs more than a short fixture, drop this test and say so in the handoff; the rule is pinned at the selector and the reconcile path by the previous ticket, and the wire branch by the service-level test.

## TODO

- Add the two optional wire fields with their doc comments.
- Add `serveLineageAnswer` in `block-archive.ts`; route and answer it in `SyncService`.
- Add `blockLineageCallback` in `libp2p-node-base.ts`; pass it to the coordinator repo factory and the reconcile deps.
- Service-level test; mesh test if cheap.
- Docs and `yarn lint:docs`.
- `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/db-p2p test`.
