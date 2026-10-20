description: Make a transaction that writes several collections — a table and its indexes, or several tables — send all of them to the other machines in one reservation request and one commit request, so a one-row insert into a table with five indexes costs the other machine of a two-machine group three cluster requests instead of twenty-four.
prereq: a-coordinator-runs-an-actions-collections-as-one-record
architecture: docs/internals.md#one-commit-round-when-one-coordinator-covers-every-block
files: packages/db-core/src/transactor/transactor.ts (`ITransactor`), packages/db-core/src/transactor/network-transactor.ts (`pend`, `commitInOneRound`, `soleCommitCoordinator`, `sendCommit`, `consolidateCoordinators`, `owedCancels`, `txnCoordinatorsFor`), packages/db-core/src/transaction/coordinator.ts (`pendPhase`, `pendCollection`, `commitPhase`, `commitCollection`, the `sole = collectionTransforms.size === 1` rule), packages/db-core/src/network/struct.ts (`PendRequest.soleReservation` doc), packages/db-core/src/testing/test-transactor.ts (wrapper at the `getLineage` forward), packages/quereus-plugin-optimystic/test/two-node-write-request-count.spec.ts, docs/internals.md, docs/correctness.md, packages/db-p2p/docs/cluster.md
----
**Blocked: specification is silent on mixed-version groups. Unblocked by the maintainer choosing one of the options below; the gardener then moves this ticket back to `implement/` with the choice written in.**

## Decision needed: what a machine on an older build does with a combined request

Today's `RepoService` dispatches on `operations[0]` alone (`processStream` in `packages/db-p2p/src/repo/service.ts`), and the previous ticket sends a batch as several ordinary `pend` (or `commit`) operations in one message. So once THIS ticket sends batches, a coordinator on 1.16 or earlier pends and commits only the first collection (the table) and reports success; the index and UNIQUE trees never land, and nothing errors. An older cohort member applying a batched consensus record likewise handles it as one collection. A rolling upgrade across a user's phone and backup is the ordinary moment a group runs mixed builds, and `docs/internals.md` already treats mixed versions as real for base-less pends. AGENTS.md says not to worry about backwards compatibility yet, which settles refusals but not silent loss.

Options:

1. **Accept it.** Leave the `NOTE:` the previous ticket's plan called for, and the release notes say: upgrade every machine of a group together, or index writes may silently not land.
2. **Fail loudly.** Carry a batch as its own operation kinds (`pendMany` / `commitMany` holding a request list) instead of repeated `pend` / `commit` operations. An older `RepoService` matches no branch for an unknown kind and answers nothing, so the writer gets an error rather than a partial save; writes fail on mixed groups until all are upgraded. About the same amount of code as today's plan.
3. **Send a batch only where every party understands it (gardener's recommendation).** Advertise the capability as a new protocol version (a repo and a cluster protocol id beside the 1.0.0 ones), have the writer send `pendMany` / `commitMany` only to a coordinator that advertises it, and have the coordinator run one batched record only when every member of the cohort advertises the cluster version; otherwise fall back to today's one request per collection. Mixed groups keep working at today's cost; the saving arrives when the whole group is upgraded. More work, mostly here and in the coordinator's record construction.

What happens if nothing is decided: this ticket stays here and #42's request count does not change; the first two tickets are inert without it.

# A transaction pends and commits its collections together

Third of three tickets for GitHub [#42](https://github.com/gotchoices/Optimystic/issues/42). The first two let a cohort member and a coordinator handle one action's pends, or commits, for several collections as ONE consensus record (`IRepo.pendMany` / `IRepo.commitMany`, one answer for the whole set). This ticket makes the writer use them.

## Measured today

- #42: one-row insert into a table with 0–5 indexes → 4, 8, 12, 16, 20, 24 `cluster` requests to the other member of a two-member group.
- sereus (comment on #42): a joiner's seat and peer binding (several tables, UNIQUE trees) 27 + 18 `/cluster` streams (2026-09-17, 1.12); 20 `cluster` requests from the joiner in the settle window after a join (2026-10-19, `f22a8cb7`).

Why: `TransactionCoordinator.pendPhase` and `commitPhase` (`packages/db-core/src/transaction/coordinator.ts`) fan out one `transactor.pend` and one `transactor.commit` per collection, each its own consensus record — a promise round and a decision, four requests per collection — and `soleReservation` is set only when `collectionTransforms.size === 1`, so the two-member deferral that makes a one-collection write cost three is off. Both SQL commit routes reach this code: session mode, and legacy mode's `commitBatchLegacy` (`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`), which builds a per-commit `TransactionCoordinator` over the trees it pushes.

#42's other two suggestions: suggestion 3 (a partial index's predicate is ignored on write) is filed as backlog `bug-optimystic-partial-index-stores-rows-its-predicate-excludes`. Suggestion 2 (derive non-unique indexes locally instead of replicating them) was not filed: its motivation was the per-collection request cost this chain removes, and what is left — the index's bytes and storage — is a design question nobody has asked for yet.

## The writer's interface

Two optional methods on `ITransactor` (`packages/db-core/src/transactor/transactor.ts`), beside `getLineage?` and `queryClusterNominees?`:

```ts
/** Pend every request (one action's, disjoint blocks) as ONE request to one coordinator, answered
 *  together. `undefined`: they could not go as one — nothing of them is left pended by this call,
 *  and the caller pends them its usual way. */
pendMany?(requests: readonly PendRequest[]): Promise<PendResult | undefined>;
/** Commit every request as ONE request to one coordinator, answered together. `undefined`: they
 *  could not go as one, or the one request threw; the caller commits them its usual way. */
commitMany?(requests: readonly CommitRequest[]): Promise<CommitResult | undefined>;
```

`undefined` is the same contract `NetworkTransactor.commitInOneRound` already has for its one-round commit: an "it did not apply, fall back" answer, never a verdict. `TestTransactor` and the reference peer's transactor do not implement them, so every existing test over those keeps today's per-collection path; a forwarding wrapper (the one in `packages/db-core/src/testing/test-transactor.ts` that forwards `getLineage`, and any test wrapper of `ITransactor` that forwards optional methods) forwards these too.

## NetworkTransactor

**`pendMany`**:
- Compute the union of every request's blocks. Discharge owed cancels for the union first (`owedCancels.beforePend`, as `pend` does).
- Find whether ONE coordinator covers the union — the same greedy cover `consolidateCoordinators` computes for `pend` — and whether that coordinator's repo has `pendMany`. If not, return `undefined` before sending anything.
- Send every request whole, in one call, with `coordinatingBlockIds` = the union and one expiration (`now + timeoutMs`). The requests carry `soleReservation` exactly as given.
- **Answered success**: seed the per-transaction coordinator cache (`txnCoordinatorsFor`) with that peer for every block, record the coordinator hint as `pend` does, and return it.
- **Answered refusal**: cancel the union (awaited, its failure logged and never replacing the verdict — the same rule as `pend`'s failure path) and return the refusal rebuilt through `refusalFrom`.
- **Threw**: cancel the union the same way, log, and return `undefined`, so the caller pends the collections one by one — those per-collection pends retry onto other coordinators through `processBatches`, which this one request could not. An undischarged cancel is still owed and goes out ahead of those pends (`owedCancels`).

**`commitMany`**:
- Each request's block list is its tail followed by its other blocks, as `commitInOneRound` builds it. Find the one coordinator covering every block — `soleCommitCoordinator` over the union, which prefers what `pendMany` cached — and check its repo has `commitMany`; else `undefined`.
- Build each `RepoCommitRequest` through the one place commit requests are built (`sendCommit`'s builder; each request's `blockDigests` already names only its own blocks) and send them in one call.
- **Answered**: success → `{ success: true, durability: mergeDurability([answer]) }`; refusal → `refusalFrom([answer])`.
- **Threw**: log and return `undefined`. The caller's per-collection commits re-send everything; whatever the thrown request landed is this action's own revision, which storage treats as already done (`isOwnRevision`) — the reasoning `commitInOneRound` documents for its fallback.

## TransactionCoordinator

Split `pendCollection` into building a collection's `PendRequest` and sending it, and `commitCollection` into building a `CommitRequest` (block digests from the tracker) and sending it with its transient retries, so both paths build requests one way.

**Pend phase.** With two or more collections and `transactor.pendMany` present: build every collection's request with `soleReservation: true` and call `pendMany`.
- **Success** → every collection is pended, with its own blocks (`blockIdsForTransforms` of its transforms) in `pendedBlockIds`.
- **Refusal** → the same classification a per-collection refusal gets today, applied once: an expiry is `expired`; a conflict (`isConflictFailure`) is a clean stale loss; anything else is hard. Nothing is left pended (`pendMany` cancelled), so `pendedBlockIds` is empty.
- **`undefined`** → today's fan-out, with requests REBUILT without the mark (`sole` false for two or more collections, as now). Never re-send the marked requests through `pend`: each is whole on its own, so `NetworkTransactor.pend` would keep the mark, and a per-collection pend that a member refuses late could then surface after a sibling collection's commit landed — the tear the mark exists to prevent.
- **Throw** (a transactor other than `NetworkTransactor`) → a hard failure, like a thrown `pend`; cancel every collection's blocks through `cancelPhase`, since what was pended is unknown.

One collection: unchanged (`pend`, marked).

**Commit phase.** With two or more collections and `transactor.commitMany` present: build every collection's request and call `commitMany`.
- **Success** → every collection committed, each with `withBlockRevs(durability, itsBlockIds, itsRev)`.
- **Refusal** → every collection failed: expiry → `expired`; anything else → stale, matching how `commitCollection` maps every returned commit refusal today (see the `NOTE:` there). Every collection's attempt is then retained by `commitOnceLatched`, and the refresh between attempts finishes any collection whose log entry did land (`Collection.completeOwnEntry`) — the path a refused one-collection commit already takes.
- **`undefined`, or a throw** → today's per-collection `commitCollection` fan-out.

**The residual this leaves**, stated in the docs below: a batched pend whose decision was deferred, followed by a commit that could not go as one (`commitMany` threw, so the collections commit separately), is back in today's documented multi-collection residual — a member that refuses one collection's pend late can do so after a sibling collection's commit landed, which the coordinator's forward recovery or `CoordinatorPartialCommitError` reports. It is reached only through a thrown commit request. Leave a `NOTE:` at the commit-phase fallback naming it.

## Request count

Expected on the two-member mesh, legacy and session alike: **three** requests to the other member for any number of collections — the pend record's promise round; the commit record's promise round, carrying the deferred pend decision ahead of it; and the commit decision. (In a two-member group the other member signs its commit while answering the promise round and the coordinating member's own commit signature completes the majority, so no separate commit round runs — see docs/internals.md §Both consensus rounds carry the coordinator's own member's vote.) If a case measures differently, find what the extra request is before pinning a number.

## Docs

- docs/internals.md §One commit round when one coordinator covers every block: the "A write spanning several collections costs 4 per collection" sentence becomes the batched path and its three requests; add a paragraph on `pendMany` / `commitMany` (one record per phase when one coordinator covers every collection's blocks; per collection otherwise), and update the closing sentence of the deferral paragraph in §Both consensus rounds carry the coordinator's own member's vote ("why a write spanning several collections does not get it").
- docs/correctness.md §2 Definitions (the long pend-verdict paragraph): the mark now also covers a set of pends sent as one request whose commit goes as one request; the reason it is safe (the member refuses the one commit record — `a-consensus-record-carries-several-collections-of-one-action`, *Why the deferral is safe for a batch*); and the residual above. In the same file, §7.3's "Multi-collection transactions incur sequential PEND overhead (one round-trip per collection)" becomes one round when one coordinator covers every collection, one per collection otherwise; and check the §Eventual visibility bullet ("The COMMIT phase lands each collection independently") — collections in one record are decided together, but each member still applies them one at a time, so visibility stays eventual; say that.
- `PendRequest.soleReservation` doc (`packages/db-core/src/network/struct.ts`): the writer's word that this pend, together with the other pends sent with it in one request, is the action's whole reservation, and that the action's commit goes as one request to the same coordinator; set by `TransactorSource.transact`, and by `TransactionCoordinator` for a one-collection transaction or every request of a `pendMany`.
- packages/db-p2p/docs/cluster.md, at the deferral paragraph that cites `PendRequest.soleReservation`: same change.
- The header comment of `two-node-write-request-count.spec.ts`: rewrite for the new numbers.

## Edge cases & interactions

- **One collection**: untouched; still `pend` with the mark and `commit`'s one round. Pinned by the spec's existing three-request cases.
- **Transactor without the methods** (`TestTransactor`, reference peer): today's fan-out exactly. Every existing multi-collection coordinator spec covers it.
- **Blocks needing more than one coordinator** (a group wider than one cohort): `pendMany` returns `undefined` before sending; fan-out unmarked. No mesh fixture forces two coordinators today (backlog `debt-no-mesh-fixture-forces-two-coordinator-batches`); verified by inspection.
- **`pendMany` threw**: union cancelled, then the unmarked fan-out at the same action id; an undischarged cancel goes out first via `owedCancels`. Inspection.
- **A later attempt with fewer collections** (a partial landing retried forward, or a refresh that finished some collections): the attempt sees only what is still staged; one collection goes through `pend`, two or more through `pendMany` again.
- **`execute` (session statements)** and **`commit`** both reach `coordinateTransaction`, so both get the change. Inspection.
- **Validation payload**: each request still carries its own copy of `validation` (session mode); unchanged per request, larger per message. No checker runs in production today (backlog `feat-no-deployment-validates-transactions-at-pend`).
- **GATHER phase** (`gatherPhase`, `superclusterNominees`): unchanged.
- **Durability report**: every collection in a batched commit gets the same cohort answer, each stamped with its own `blockRevs`; `TransactionDurability.overall` is unchanged in meaning.
- **A batched commit is never torn**: it is one record with no sweep, so `durability.torn` stays empty on that path.

## Tests

Re-pin `packages/quereus-plugin-optimystic/test/two-node-write-request-count.spec.ts`:

- `session mode: an insert into a table with an index costs four per collection it writes` → three, renamed to say the collections travel together.
- Add `legacy mode: an insert into a table with five indexes costs three` — the shape #42 measured at 24, through `commitBatchLegacy`.

The two existing no-index cases stay as they are. No other new tests: the fallbacks are the paths every existing multi-collection spec already runs.

## TODO

- Add `pendMany?` / `commitMany?` to `ITransactor`; forward them in `test-transactor.ts`'s wrapper and any other forwarding `ITransactor` wrapper.
- Implement both on `NetworkTransactor` as above.
- Split the request builders out of `pendCollection` / `commitCollection`; route `pendPhase` / `commitPhase` through the batched methods with the fallbacks above; add the residual `NOTE:`.
- Update the `soleReservation` doc and the docs listed above.
- Re-pin the request-count spec; run `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/db-p2p test`, `yarn workspace @optimystic/quereus-plugin-optimystic test` (after `yarn build` — the plugin's specs import its `dist/`), `yarn typecheck` and `yarn lint:docs`.
