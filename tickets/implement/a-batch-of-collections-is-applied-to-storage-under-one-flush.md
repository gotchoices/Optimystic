description: When one write covers several collections (a table and its indexes, or many new empty collections at once), each machine still waits for its disk once per collection, twice per write. Applying all of a write's collections to local storage and then waiting for the disk once makes such writes several times faster on slow disks and phones.
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/storage-repo.ts (`StorageRepo.pend`, `StorageRepo.commit`, `endGroup`, `groupFlush`, `ILocalApply`, `StorageApplyOptions`, `notePendGroup`, `emitCollectionChanges`), packages/db-p2p/src/repo/coordinator-repo.ts (`applyPendsInOrder`, `applyCommitsInOrder`, `localApply`), packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusPends`, `applyConsensusPend`, `applyConsensusCommits`, `applyCommitToStorage`, `localApply`), packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/docs/storage.md, docs/internals.md
----

# A batch of collections is applied to storage under one flush

## Why

A write that spans several collections already travels as one consensus record: one pend record and one commit record, carrying one operation per collection (`IRepo.pendMany` / `commitMany`, see docs/internals.md §One commit round when one coordinator covers every block). But every machine that applies such a record applies it one collection at a time, and each application is its own write group with its own flush:

- The coordinating node's solo path and its fallback path loop over the batch in `CoordinatorRepo.applyPendsInOrder` and `CoordinatorRepo.applyCommitsInOrder`, calling `StorageRepo.pend` / `StorageRepo.commit` per request.
- Each cluster member loops the same way in `ClusterMember.applyConsensusPends` and `ClusterMember.applyConsensusCommits`.
- `StorageRepo.pend` and `StorageRepo.commit` each wrap their work in `endGroup`, which calls `this.storage.flush(...)` when the work is done.

So a write over N collections costs each machine 2N flushes, where the record structure would allow 2. The flushes dominate on slow storage. Sereus measured founding a party (35 empty collections, each still committed separately today) at about 2.1 s on a desktop file store, two thirds of it in `endGroup` flushes: 37 pend flushes at 405 ms and 37 commit flushes at 1,030 ms (filed from Sereus as the ticket now in backlog as `feat-batched-commit-over-a-named-set-of-collections`). Every SQL transaction that writes a table with indexes pays the same per-collection cost.

Two flushes per write (one after the pend, one after the commit) are the write-order invariant and stay. The per-collection repetition inside each record is not part of any invariant.

## The change

Give `StorageRepo` a way to run several pends, or several commits, of ONE consensus record inside one write group, and have the four loops above use it.

Shape (the implementer may refine names, not the semantics):

```ts
/** One write group spanning several local applies: one flush at the end, change events after it. */
export interface LocalApplyGroup {
	pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
	commit(request: CommitRequest, options?: MessageOptions, proof?: BlockCommitProof): Promise<CommitResult>;
}

export interface ILocalApply {
	pend(...): Promise<PendResult>;      // unchanged
	commit(...): Promise<CommitResult>;  // unchanged
	/**
	 * Run `body` as one write group: every pend or commit it makes through `group` writes under
	 * that request's own block latches exactly as a lone call does, but the group flushes once,
	 * with `flush`'s window, after `body` settles; the post-flush steps of every request that
	 * succeeded (the pend group note, the HLC `stored` mark, the collection change events) run
	 * after that flush, in request order.
	 */
	applyInOneGroup?<T>(apply: Pick<StorageApplyOptions, 'syncWithinMs'>, body: (group: LocalApplyGroup) => Promise<T>): Promise<T>;
}
```

A callback, not a `pendMany(requests)` on storage, because the four callers' loops differ and must keep their semantics unchanged: the coordinator stops at the first refusal, while the member applies every commit operation and handles each one's divergence and behind-reconcile itself (`applyCommitToStorage`). With a group handle each loop keeps its own control flow and only the flush and the deferred post-flush steps move.

Implementation outline inside `StorageRepo`:

- Factor `pend` into: validation (`checkPendValidation`, unchanged, outside any latch), the latched body (`pendUnderLatches`, unchanged), and the post-flush steps (`notePendGroup`, `pendHlcs.stored`). Same for `commit`: latched body (`commitUnderLatches`) and post-flush step (`emitCollectionChanges`). The lone `pend` / `commit` become a group of one, so there is one code path.
- The group collects post-flush steps as it goes. On normal completion of `body`: flush with the group's options, then run the collected steps in order, then return `body`'s result. When `body` throws: flush strictly (as `flushBehindFault` does today), run the collected steps of the requests that completed before the throw (the Option A emission guarantee — a block that durably committed still emits), then rethrow.
- Pend validation runs inside the group but before the request's latches, as today.
- `whenDurable`, the durable executed marker (`markExecutedOnceDurable`) and every caller of it are unchanged: they already wait on the store, not on a particular flush.

Callers:

- `CoordinatorRepo.applyPendsInOrder` / `applyCommitsInOrder`: when `localApply().applyInOneGroup` exists, run the existing loop inside it; otherwise the existing per-request loop (a plain `IRepo` test double has no group).
- `ClusterMember.applyConsensusPends` / `applyConsensusCommits`: the same. `applyCommitToStorage` takes the group's `commit` instead of `localApply().commit`. The behind-reconcile it triggers goes through `saveReplicatedBlock`, which runs its own write group and flush; leave that as it is (it is the rare path, and nesting it in the outer group buys nothing).

## Edge cases & interactions

- **Durability before acknowledgement.** Nothing a request in the group reports as landed may be acted on before the group's flush: no change event, no pend-group note, no answer to the writer. The caller's `await` on `applyInOneGroup` is what returns the record's answer, so the answer still comes after the flush. Verify by inspection of each caller: none of them sends anything between a group's `commit` and the end of the group. The member's `durableCommitVerdict` reads storage inside the group, after the request's latches are released; it reads this process's writes, which is correct for a verdict that is retained, not announced, until the record answer goes out.
- **Strict vs. windowed flush.** One group, one flush option. The coordinator's solo path is strict; the member and the coordinator's fallback pass the cohort's window (`syncWindowFor(record)`). The record decides the window today and every operation in it already gets the same value, so nothing changes.
- **Latches.** Each request still takes and releases its own block latches in sequence; the latches are never held across requests, so no new lock ordering is introduced. Between a request's latch release and the group's flush, a concurrent reader can see a write that is not yet durable — exactly the window a lone `pend` or `commit` has today between `pendUnderLatches` returning and `endGroup`'s flush. No new exposure.
- **A request that throws mid-group.** The coordinator's loop does not catch, so the throw ends `body`; the member catches a missing-pend throw inside `applyCommitToStorage` and continues. In both cases the group's fault handling flushes strictly and still emits for every request that landed, matching what `endGroup` does for a lone call today.
- **A refused request mid-group.** A refusal is a returned result, not a throw, and writes nothing that needs undoing; the coordinator stops its loop, the member continues. Either way the group flushes whatever the earlier requests wrote, as today's per-request flushes did.
- **The change hold** (docs/internals.md §Change Notification, "A collection's wake waits for the action's other collections pending here"). Pend groups are noted after the group's flush instead of after each request's, which is still before any commit of the action can reach this node (the commit record follows the pend record's answer). For a batched commit, all collections land before any emits, so the hold finds the action's other groups already closed and releases at once: the same wake, with no hold. Verify by the existing hold cases in `packages/db-p2p/test/storage-repo.spec.ts` still passing.
- **Commit certificate capture.** `ClusterMember.applyConsensusCommits` captures the certificate before the first commit; emission now happens later, so the certificate is still retained when the change bridge resolves it. Verify by inspection.
- **Invariant P and tail-first.** Both are properties of one `commitUnderLatches` call and are untouched. Across collections there is no ordering promise today beyond request order, and request order is kept.
- **A decorator that narrows to `IRepo`.** `applyInOneGroup` is optional on purpose; a repo without it keeps one flush per request. `served-repo-proxy.ts` is not on these paths (callers hold the `StorageRepo` itself) — confirm, and say so in the handoff.
- **`ILocalApply` doc comment** says callers cast rather than probe; the new method is the one member they must probe for. Update that comment.

## Tests

One spec in `packages/db-p2p/test/storage-repo.spec.ts`: over a raw store that counts `flush` calls, a group of three pends and then a group of three commits of one action make two flushes in total, and the three collections' change events fire after the commit group's flush, not before. Extend an existing counting double if one exists. A second case for the fault arm: a group whose second commit throws still emits for the first collection and flushes once. Nothing else needs a new test; the existing coordinator, member and change-hold suites cover the callers' semantics.

## Docs

- packages/db-p2p/docs/storage.md §6: a write group may span several applies of one consensus record; state the deferral of post-flush steps.
- docs/internals.md: the sentence under §Commit Path saying "Each storage apply (`StorageRepo.pend` / `commit`) ends with one flush of the node's store" becomes one flush per consensus record's pends, and per its commits. The §Change Notification diagram's `storage.flush()` line likewise.

## TODO

- Factor `StorageRepo.pend` / `commit` into latched body + post-flush steps; implement `applyInOneGroup` with the fault arm; make the lone calls a group of one.
- Add `LocalApplyGroup` and optional `applyInOneGroup` to `ILocalApply`; update its doc comment.
- Use the group in `CoordinatorRepo.applyPendsInOrder` / `applyCommitsInOrder` and `ClusterMember.applyConsensusPends` / `applyConsensusCommits` (through `applyCommitToStorage`), falling back to the per-request loop when absent.
- Add the flush-count and fault-arm cases to `storage-repo.spec.ts`.
- Update the two docs; `yarn lint:docs`.
- Build db-p2p; run `storage-repo.spec.ts`, the coordinator-repo and cluster-member specs by file, and the change-hold cases.
