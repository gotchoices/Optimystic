description: When a write fails because too few machines in its group answered, the writer now gets a distinct error carrying the counts (how many approved, how many were needed, which machines were silent), on its own machine and across the network, instead of a plain message it would have to parse.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/network/promise-shortfall-error.ts, packages/db-core/src/network/index.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/util/node-count-mesh.ts, packages/db-p2p/test/transaction-node-count-sweep.spec.ts, packages/db-p2p/test/member-leaves-and-returns.spec.ts, packages/db-p2p/test/mesh-sanity.spec.ts, packages/db-p2p/test/mesh-harness-restart-and-delivery-hook.spec.ts, docs/internals.md, docs/correctness.md, tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text.md
----

Part of stage 1 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages) — the "Cohort unreachable, nothing sent" row. Siblings still to land: `signed-validity-marker-on-reject-votes`, `offline-sync-typed-validity-rejection`, `offline-sync-commit-failure-classifier` (which adds the db-core predicate, rewrites the offline-sync paragraph, and marks the stage implemented).

## What was built

The promise-round shortfall — the cohort's approvals fell short with no `conflict`/`held` vote and too few rejections for a rejection, i.e. members were silent — is now a typed, returned refusal, following the `ExpiredFailure` precedent exactly.

- **db-core types** (`packages/db-core/src/network/struct.ts`): `PromiseShortfall` (`approvals`, `rejections`, `peerCount`, `needed`, `silentPeers`), `ShortfallFailure` (`success: false`, `conflict: false`, `shortfall`, siblings' fields typed `never`), added to `WriteFailure`. `StaleFailure` and `ExpiredFailure` gained `shortfall?: never`.
- **Predicate** `isShortfallFailure` beside `isExpiryFailure` (`stale-failure.ts`); `isConflictFailure` now answers false for a shortfall explicitly.
- **Error** `PromiseShortfallError` (`promise-shortfall-error.ts`, exported from the root barrel) with the count fields and `toFailure()`. Its message is byte-identical to the old text: `Failed to get super-majority: a/n approvals (needed k, r rejections)`.
- **Producer**: `ClusterCoordinator.executeTransaction` throws `PromiseShortfallError` at the generic shortfall branch; `silentPeers` = cohort peers (`peers` passed to the round) with no entry in the merged record's `promises`. The wire-text NOTE was rewritten to point consumers at the type.
- **Pend returns it**: `CoordinatorRepo.pendThroughCluster`'s catch returns `error.toFailure()` beside the expiry arm, ahead of the stale classifier — with an accepted-tradeoff `NOTE:` about losing the coordinator re-pick.
- **Commit still throws it**: `CoordinatorRepo.commitThroughCluster`'s catch rethrows it, with the `NOTE:` the plan asked for (returning it would turn a tolerated torn sweep into a refused write with its log tail left behind).
- **Writers**: `refusalFrom` precedence is expiry > shortfall > stale (doc updated). `Collection.syncAttempts` throws `PromiseShortfallError` by name, no retry. `TransactionCoordinator`: `pendRefusalError` maps it, `pendFailure` carries it as `shortfall`, `CoordinationResult` gained the field, `commitOnceLatched` throws it by name (so `commit()` surfaces it); `execute()` reports its message as the failed result's `error` (no code change needed there — it is no longer a stale loss).
- **Docs**: `docs/internals.md` (expiry bullet's "super-majority shortfall a writer retries" fixed; "Pend retryability is an explicit field" bullet now covers both non-retryable refusals), `docs/correctness.md` (names `PromiseShortfallError`). Backlog `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`: appended that it landed as planned and that no test here reads the `Some peers did not complete:` sentence any more.

## Behaviour to verify

- **Local writer, silent member** (2 or 3 machines, one away): `Tree.replace` / `Collection.sync` rejects with `PromiseShortfallError` at the top level (not an aggregate's `cause`), first attempt, counts on the fields, the away machine in `silentPeers`. Pinned by `transaction-node-count-sweep.spec.ts` and `member-leaves-and-returns.spec.ts` through `expectPromiseShortfall`.
- **Coordinator answer**: `coordinatorRepo.pend` with a silent member *returns* `{ success:false, conflict:false, reason:<sentence>, shortfall:{…} }` rather than throwing — pinned by `mesh-sanity.spec.ts` ("promise phase failure with default threshold…") and the two `mesh-harness-restart-and-delivery-hook.spec.ts` cases.
- **Remote writer**: the same object crosses `RepoService`/`RepoClient` as JSON (plain numbers and strings). By inspection only.
- **Cancel still runs**: `NetworkTransactor.pend` cancels on any non-success batch, returned or thrown. By inspection.
- **Batched multi-collection pend**: a returned shortfall from `pendMany` answers the whole batch; `TransactionCoordinator.pendTogether` does not fall back to per-collection pends on a returned refusal. By inspection.
- **Refusal latency** observed on the in-process mesh: ~940 ms for a 2- or 3-member cohort with one member away (mostly the transactor's cancel loop, as the member-leaves spec already notes).

## Tests changed (none added)

- `util/node-count-mesh.ts` `expectPromiseShortfall`: asserts `instanceOf(PromiseShortfallError)`, reads the fields, returns db-core's `PromiseShortfall` (with `silentPeers` sorted); still asserts the message equals the old sentence (downstream contract). The local `PromiseShortfall` interface was removed in favour of db-core's.
- `transaction-node-count-sweep.spec.ts`, `member-leaves-and-returns.spec.ts`: expected objects now `{ approvals, rejections, peerCount, needed, silentPeers: [<away peer>] }`.
- `mesh-sanity.spec.ts`, `mesh-harness-restart-and-delivery-hook.spec.ts` (two cases): read the returned refusal instead of catching a throw; they now pin the coordinator-level returned shape, including `silentPeers`.

## Validation run

`yarn build` clean; `yarn lint`, `yarn lint:docs`, `yarn typecheck` clean. db-core 1919 passing; db-p2p 3529 passing / 74 pending; quereus-plugin-optimystic 1064 passing / 14 pending. Integration specs (`yarn test:integration`) not run.

## Known gaps and things for the reviewer to weigh

- **`TransactionCoordinator`'s shortfall arm is not exercised by any test** (no spec drives a multi-collection or coordinator commit into a silent cohort). It mirrors the expiry arm line for line; by inspection.
- **`refusalFrom`'s new precedence has no dedicated test** (expiry precedence has none either). By inspection.
- **`docs/offline-sync.md` is now half stale**: its "Two of these rows need typed errors… reaches the writer as plain text" paragraph and the "Cohort unreachable" row do not yet name `PromiseShortfallError`. Left alone deliberately — `offline-sync-commit-failure-classifier` rewrites both.
- **Mixed versions**: a writer on an older build receiving `ShortfallFailure` sees a reason-only non-conflict refusal and retries it with backoff up to its budget (about 21 s by default) before failing, where it used to fail at once. A coordinator on an older build keeps throwing, which a new writer sees as before (aggregate / stream reset). No gate.
- **Downstream text matcher (sereus `control-write-retry`)**: the sentence is unchanged, but on a refused pend a local writer now receives it as the top-level `PromiseShortfallError`, no longer as the `cause` of a `Some peers did not complete:` aggregate; a remote writer now receives it at all (it used to see a reset stream). A matcher that only looks inside that aggregate stops firing. A commit-phase shortfall arrives as before.
- **No coordinator re-pick for a pend shortfall** (accepted tradeoff, `NOTE:` in `pendThroughCluster`).
- **Wire shape trusted** (`NOTE:` in the `PromiseShortfallError` constructor, same as `TransactionExpiredError`): a malformed `shortfall` from a hostile coordinator throws a TypeError instead; either ends the write.
