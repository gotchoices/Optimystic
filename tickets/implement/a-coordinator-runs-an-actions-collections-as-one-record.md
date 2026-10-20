description: Give the coordinating machine a way to take several collections' reservations, or several collections' commits, of one transaction in a single request and run them as one consensus vote, and carry that request over the network protocol. Nothing in the transaction layer uses it yet; the next ticket does.
prereq: a-consensus-record-carries-several-collections-of-one-action
architecture: docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block
files: packages/db-core/src/network/i-repo.ts (`IRepo`), packages/db-p2p/src/repo/coordinator-repo.ts (`pend`, `pendThroughCluster`, `pendSolo`, `classifyStaleRejection`, `answerBlocksHeld`, `clearStuckReservations`, `commit`, `commitThroughCluster`, `commitSolo`, `latePendRefusalFor`, `confirmCommitRivalAgainstLocal`, `classifyCommitStaleRejection`, `tolerateLocalCommitDivergence`, `acknowledgeCommit`, `verifyResponsibility`), packages/db-p2p/src/repo/service.ts (`deriveBlockKey`, the dispatch reading `operations[0]`, `checkRedirect`), packages/db-p2p/src/repo/client.ts (`processRepoMessage`, `extractCorrelationId`, `coordinatedBlockId`), packages/db-p2p/src/libp2p-node-base.ts (`createServedRepoProxy`), packages/db-p2p/src/testing/mesh-harness.ts (`repoAsReachedBy`, `wrapRepo`), docs/internals.md (§Inbound Stream Authorization, "executes `operations[0]` only")
----
# A coordinator runs an action's collections as one record

Second of three tickets for GitHub [#42](https://github.com/gotchoices/Optimystic/issues/42) (see `a-consensus-record-carries-several-collections-of-one-action` for the problem and the overall plan). After the first ticket a cohort member handles a consensus record whose message carries several pend operations, or several commit operations, of one action (a **batch**: one kind, one action id, disjoint blocks — `batchShapeFault` in `packages/db-p2p/src/cluster/record-operations.ts`). This ticket lets a writer hand such a set to a coordinator in one request and has the coordinator run it as one record.

## The interface

Two optional methods on `IRepo` (`packages/db-core/src/network/i-repo.ts`):

```ts
/** Pend every request as ONE consensus record. The requests are one action's (same action id),
 *  name disjoint blocks, and are answered together: success only if every one was accepted. */
pendMany?(requests: readonly PendRequest[], options?: MessageOptions): Promise<PendResult>;
/** Commit every request as ONE consensus record, same rules as pendMany. */
commitMany?(requests: readonly RepoCommitRequest[], options?: MessageOptions): Promise<CommitResult>;
```

Optional, like `ITransactor.getLineage` and `queryClusterNominees`: only coordinator-tier repos implement them (`CoordinatorRepo`, `RepoClient`, the node's served-repo proxy, the mesh harness's per-node repo). `StorageRepo` does not — members apply a batch one operation at a time through the existing single-request methods. The writer (next ticket) sends one request per member per phase only to a repo that has them, and otherwise falls back to today's one request per collection.

**One answer for the whole set**, not one per request. A record has one consensus outcome, the members' verdicts are folded per record (previous ticket), and the durability gate counts members holding everything; a per-request answer would claim a precision the evidence does not have. What that costs is recorded under *Edge cases*: a refused set whose first collection did land on a majority is reported as refused and finished by the writer's existing refresh path. `PendSuccess.blockIds` is the union of every request's blocks.

## CoordinatorRepo

Make the list the primitive and the single request a list of one, so there is one code path: `pend(request)` calls the same internals as `pendMany([request])`, and `commit(request)` the same as `commitMany([request])`. Refuse a list that fails `batchShapeFault`, or is empty, with a thrown error naming the reason (a writer bug, not a verdict). Then, site by site:

- **Responsibility** (`verifyResponsibility`): over the union of every request's blocks; refuses naming every offending block, as today.
- **Pend, cluster path** (`pendThroughCluster`): one `RepoMessage` with one `pend` operation per request, in the order given; `coordinatingBlockIds` is `options.coordinatingBlockIds` or the union, and the cohort is resolved for its first block, as today. The local-verdict arms read the member's folded verdict and need no change; `answerWithCohortRefusal` is already per record. When the local member did not execute, the fallback local apply runs each request in order and stops at the first refusal, which is the answer.
- **Pend refusals.** `ConflictRaceLostError` and expiry are already whole-record. `classifyStaleRejection`: the rejection is a confirmed loss when ANY request's blocks show `latest.rev >= that request's own rev` (each request has its own revision — collections are counted separately), and `staleAt` is the highest across requests (`highestStaleAt`). `answerBlocksHeld`: over the union. `clearStuckReservations` on success: over the union.
- **Pend, solo path** (`pendSolo`): apply each request to storage in order; stop at the first refusal and return it. The earlier requests' pending records stay; the writer's pend-failure path cancels the whole action (`NetworkTransactor.pend` already does this for a refused pend), so no cancel here.
- **Commit, cluster path** (`commitThroughCluster`): one `RepoMessage` with one `commit` operation per request; consensus runs on the cohort of the first request's `blockIds[0]` (its log tail — every request lists its tail first), exactly as a single commit does today. The other collections' blocks commit on that cohort: the same approximation a multi-block commit already makes (backlog `debt-sender-side-coordinating-block-binding-is-unchecked`), and identical whenever the cohorts coincide, which they always do in a group small enough that every machine is in every cohort.
- **Durability gate**: unchanged, because each member's reported verdict is the fold — a member counts as holding the record only when it holds every request's revision.
- **Local-commit fallback and divergence** (`tolerateLocalCommitDivergence`): run each request in order; the tolerated shapes are judged per request; any non-tolerated refusal is the answer.
- **Rival confirmation** (`confirmCommitRivalAgainstLocal`, `classifyCommitStaleRejection`): a rival confirmed on any request's blocks makes the answer a stale loss (highest `staleAt`); `'own-durable'` only when every request is own-durable.
- **Late pend refusals** (`latePendRefusalFor`): take once for the action over the union of every request's blocks (`takeLatePendRefusals(actionId, union)`), so a refusal reported for any collection answers the set.
- **Acknowledgement** (`acknowledgeCommit`): the under-replication ledger and the holder evidence are per block, so record them per request; the answer is one `CommitSuccess` with the cohort's durability (the requests ran on one cohort, so one answer describes them).
- **Commit, solo path** (`commitSolo`): each request in order, stop at the first refusal; one `soloCohortDurability` answer.

## The wire

- **`RepoService`** (`packages/db-p2p/src/repo/service.ts`) dispatches on `operations[0]` alone today, so a multi-operation message silently drops everything after the first. A message of more than one operation: refuse it (abort the stream with the reason logged, as other malformed requests are) when `batchShapeFault` says so; otherwise call `pendMany` / `commitMany` on the coordinator repo. The redirect check and `deriveBlockKey` use the message's coordinating block — `coordinatingBlockIds[0]` when present, else the first operation's first block — which is the block `CoordinatorRepo` resolves the cohort for. A one-operation message is handled exactly as today.
- **`RepoClient`**: implement `pendMany` / `commitMany` by sending every operation in one message through `processRepoMessage`; `extractCorrelationId` and `coordinatedBlockId` read the first operation, which is correct for a batch (one action id; the first block is the coordinating one). The redirect hop resends the whole message.
- **Proxies**: `createServedRepoProxy` in `packages/db-p2p/src/libp2p-node-base.ts` and `repoAsReachedBy` in `packages/db-p2p/src/testing/mesh-harness.ts` forward both methods to the coordinated repo; check every `wrapRepo` wrapper in the mesh harness forwards them too (a wrapper that drops an optional method makes the writer fall back silently, which hides the change from the mesh specs).
- **Docs**: the parenthesis in docs/internals.md §Inbound Stream Authorization ("the handler executes `operations[0]` only") becomes: a repo message carries one operation, or a batch of one action's pends or commits run as one consensus record; still one request per stream, so per-stream and per-request authorization stay equivalent.

## Edge cases & interactions

- **One request**: byte-identical message and identical behaviour to today. Covered by every existing coordinator spec, which now runs through the list path.
- **Empty list, mixed kinds, two action ids, a block in two requests**: thrown by `CoordinatorRepo`, refused by `RepoService`. Inspection (one function).
- **A refused set whose first collection landed on a majority** (the cohort decided to commit, member 2 held collection A and refused collection B): answered refused for the whole set. The writer retains every collection's attempt and its refresh between attempts finishes A from its own log entry (`Collection.completeOwnEntry`) and re-pends B — the path a refused single-collection commit already takes. The cost is one refresh round in that rare shape; recorded as an accepted tradeoff `NOTE:` at the one-answer site in `commitThroughCluster`.
- **Pend refused for one collection by a rival that committed a newer revision on that collection only**: a `StaleFailure` with `conflict: true` and that collection's `staleAt`. Test below.
- **Solo cohort, second request refused**: the first stays pended until the writer's cancel; verified by inspection against `NetworkTransactor.pend`'s cancel-on-failure.
- **Responsibility refusal of one collection's block**: the whole set is refused as `ResponsibilityRefusalError`; the writer re-picks, as for a single request.
- **Expiration**: one expiration for the message; an expiry vote refuses the whole set with `ExpiredFailure`.
- **Message size**: one message carries every collection's transforms (and, in session mode, each request's copy of the validation payload). No new bound is needed — the per-stream frame limit applies, and a SQL write's collections are a handful — but leave a `NOTE:` at `RepoClient.pendMany` that a very wide transaction would hit the repo protocol's frame limit, and that the writer should then split.
- **A coordinator on an older build** reads only the first operation. Mixed builds are out of scope (AGENTS.md); leave a `NOTE:` at `RepoClient.pendMany` saying an older coordinator drops the later operations and answers as if they were not sent, which a mixed-version rollout would have to gate.

## Tests

One new spec in `packages/db-p2p/test/` on a two-member mesh (`createMesh`), through `CoordinatorRepo` directly:

- `pendMany` of two collections' requests where a rival has already committed a newer revision on the second collection's tail returns `{ success: false, conflict: true }` with `staleAt` naming that collection's tail and revision — pins the across-requests classification, the one piece of new branching logic here.

The happy path (both collections pended and committed as one record, three requests to the other member) is pinned end to end by the SQL spec the next ticket re-pins; do not duplicate it here.

## TODO

- Add `pendMany?` / `commitMany?` to `IRepo` with the contract above.
- Refactor `CoordinatorRepo`'s pend and commit internals to take a list; `pend` / `commit` delegate with a list of one; apply the site-by-site rules above; add the two `NOTE:`s.
- Teach `RepoService` to refuse or dispatch a multi-operation message; implement the two methods on `RepoClient`.
- Forward both methods through `createServedRepoProxy`, `repoAsReachedBy` and every `wrapRepo` wrapper.
- Update docs/internals.md §Inbound Stream Authorization.
- Write the spec above; run `yarn workspace @optimystic/db-p2p test`, `yarn typecheck` and `yarn lint:docs`.
