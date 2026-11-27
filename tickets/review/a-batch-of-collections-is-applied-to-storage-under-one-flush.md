description: A write that covers several collections at once now waits for the disk twice instead of twice per collection, so such writes should be several times faster on slow disks and phones. Review the change for correctness around durability, change notifications and crash recovery.
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/storage-repo.ts (`applyInOneGroup`, `LocalApplyGroup`, `ILocalApply`, `pendInGroup`, `commitInGroup`, `runPostFlush`, `endGroup`, `ApplyGroupState`), packages/db-p2p/src/repo/coordinator-repo.ts (`applyPendsInOrder`, `pendEachInOrder`, `applyCommitsInOrder`, `commitEachInOrder`, `applyCommitsAfterConsensus`, `commitEachAfterConsensus`), packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusPends`, `pendEachInOrder`, `applyConsensusPend`, `applyConsensusCommits`, `commitEachInOrder`, `applyCommitToStorage`), packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/docs/storage.md, docs/internals.md
----

# A batch of collections is applied to storage under one flush

## What was built

`StorageRepo` gained one public method and one exported type, and the four apply loops that walk a consensus record's operations now run inside it.

**`StorageRepo.applyInOneGroup(apply, body)`** runs `body` as one write group. The `body` is handed a `LocalApplyGroup` — a `pend(request, options?)` and a `commit(request, options?, proof?)` — and each call it makes takes and releases that request's own block latches exactly as a lone `pend` / `commit` does. When `body` settles the group flushes **once**, with `apply.syncWithinMs` as its window, and then each request's post-flush steps run in request order: a pend's group note and HLC `stored` mark, a commit's collection change events.

`StorageRepo.pend` and `StorageRepo.commit` are now groups of one through the same method, so a lone apply and a batched one share one implementation. `pend`'s validation (which can call the caller's hook, so it must stay outside any latch hold) runs inside the group but before the request's latches, as before.

`ILocalApply.applyInOneGroup` is **optional**, and all four callers probe for it: a plain `IRepo` test double has no group and then each request flushes on its own, exactly as before. That probe is the one member of `ILocalApply` that must be probed rather than cast to, and the interface's doc comment now says so.

Callers: `CoordinatorRepo.applyPendsInOrder`, `CoordinatorRepo.applyCommitsInOrder` (its solo commit), `CoordinatorRepo.applyCommitsAfterConsensus` (its fallback commit after consensus ran without its member), and `ClusterMember.applyConsensusPends` / `applyConsensusCommits` (through `applyCommitToStorage`). Each loop's body was lifted into a small `*EachInOrder` / `*AfterConsensus` helper that takes the one-request apply as a function, so the loop is literally the same code on both the group and the no-group path. No loop's control flow changed: the coordinator still stops at the first refusal; the member still applies every operation and handles each one's divergence, behind-reconcile and durable verdict itself.

## What a reviewer should check first

These are the places where the change is a judgment call rather than a mechanical lift. Each is flagged honestly; none is known to be wrong.

- **The member's pend-refusal retention moved to before the flush.** `ClusterMember.applyConsensusPend` calls `retainPendRefusal` / `retirePendRefusal` right after storage answers. That used to be after that request's own flush; it is now inside the group, before the group's flush. Retaining a refusal earlier is the conservative direction (this member vetoes the action's commit sooner). *Retiring* one earlier is the direction worth weighing: between the pend landing and the group's flush, a commit-round promise vote could find the veto already lifted on a write that is not yet durable. Judged inert — a flush that rejects latches the store, so the member can apply nothing further and its commit of that action throws a genuine fault, which `handleConsensus` rolls back and rethrows, so it can never report the revision as held. If a reviewer disagrees, the fix is a post-flush hook on `LocalApplyGroup` for caller-level steps, which this change deliberately did not add.
- **`durableCommitVerdict` is read inside the group.** It reads this process's own writes before the group's flush. Correct for a verdict that is *retained*, not announced: `retainCommitVerdicts` — and with it `reportBlockHolders` and `reportCohortCommitApplied` — runs after `applyInOneGroup` returns, so after the flush, and the record's answer leaves only then. Verify by inspection that nothing else in the member reads a retained verdict before `applyConsensusCommits` returns.
- **`endGroup` lost its `flush` parameter.** Once `pend` and `commit` left it, every remaining caller (`cancel`, `recoverBlock`, `saveReplicatedBlock`, `deleteReleasedBlock`, a `get` that took a write latch) was strict, so the parameter was dead and is gone; `endGroup` now flushes strictly, always. Its doc comment says so and points at `applyInOneGroup` as the one group that may carry a window.
- **A validation-refused pend still flushes nothing.** A lone pend the hook rejects used to answer before any group existed. `ApplyGroupState.wrote` preserves that: the group flushes only once some apply reached its request's latches. This is `endGroup`'s `wrote` rule, restated for a group of several.
- **The ticket's caller list was off by one name.** It named `CoordinatorRepo.applyCommitsInOrder` as the coordinator's fallback commit path; that method is actually only `commitSolo`'s, and the fallback is `applyCommitsAfterConsensus`. All three coordinator loops were converted, since the 35-collection case the ticket measures goes through the fallback.
- **No re-measurement.** The flush counts are pinned by a test, but the wall-clock claim in the source ticket (about 2.1 s for a 35-collection party founding, two thirds of it in flushes) was Sereus's measurement and was **not** re-measured here. Nobody has timed the improvement.

## Edge cases, as resolved

- **Durability before acknowledgement.** Nothing a request reports as landed is acted on before the group's flush: change events, pend-group notes and the record's answer all follow it. Confirmed by inspection of each caller — none sends anything between a `group.commit` and the end of the group.
- **One group, one window.** The coordinator's solo paths pass no window (strict); the member and the coordinator's fallback pass the cohort's `syncWindowFor(record)`. Every operation of a record already got the same value, so sharing one is not a change. A commit's `proof` stays per-request, handed to `group.commit`'s third argument.
- **Latches.** Each request takes and releases its own latches in sequence; none is held across requests, so no new lock ordering appears. The window in which a concurrent reader can see a not-yet-durable write widens from one apply to the record's whole apply — the same *visible before durable* argument, now noted in `storage.md` §6 and in `pendUnderLatches`'s latch comment (a group body is caller code running *between* holds, never inside one).
- **A request that throws mid-group.** The group flushes strictly (`flushBehindFault`), runs the post-flush steps of the requests that landed before the throw, then rethrows. A step that throws in the fault arm is logged rather than masking the fault; on the normal path a step's throw is the caller's answer, as a lone commit's emission throw was. Covered by a test.
- **A refused request mid-group.** A refusal is a returned result that writes nothing needing undoing; the coordinator stops its loop, the member continues, and the group flushes whatever the earlier requests wrote.
- **The change hold.** For a batched commit every collection has landed by the time the first event fires, so each event's hold finds the action's other pend groups already closed and releases at once — the same wakes with no hold and no storage read. The hold still does its work where collections travel as separate records. The existing hold cases in `storage-repo.spec.ts` and `action-change-hold.spec.ts` pass unchanged.
- **Commit certificate capture.** `applyConsensusCommits` still captures the cert before the first commit; emission now happens later, not sooner, so the cert is still retained when the change bridge resolves it. `change-bridge.spec.ts` passes.
- **The behind-reconcile.** `reconcileDivergentCommit` lands its block through `saveReplicatedBlock`, which runs its own strict write group and flush *inside* the record's group. That flush covers the group's earlier writes (rule 4), so it hastens their sync. Left as it is per the ticket, with a `NOTE:` at `applyCommitToStorage`.
- **`served-repo-proxy.ts` is not on these paths** — confirmed. It takes a plain `IRepo` and the coordinator and member hold the `StorageRepo` itself (`this.storageRepo`, cast through `localApply()`).
- **Invariant P, tail-first, `whenDurable`, `markExecutedOnceDurable`** — untouched. The first two are properties of one `commitUnderLatches` call; the last two wait on the store, not on a particular flush.

## Tests

Two cases added to the `every write group ends with one flush` describe block in `packages/db-p2p/test/storage-repo.spec.ts`, over the existing `makeTracedStore` double (a `MemoryRawStorage` whose `flush` appends to a trace):

| Test | What it verifies |
|---|---|
| `a record of three collections pends and commits under one flush each, announcing after the commit group flush` | Three pends of one action in one group produce exactly one flush; three commits in one group produce exactly one flush, and all three collections' change events fire **after** it, in request order. This is the ticket's whole claim — 2 flushes for a 3-collection record instead of 6 — and it also pins that the change hold releases at once rather than holding. |
| `a group whose second commit throws flushes once and still announces the first collection` | The fault arm: a group whose second commit throws the missing-pend error flushes once (strictly) and still emits for the collection that landed before the throw, then rethrows — the Option A emission guarantee across a group. |

Nothing else was given a new test: the callers' semantics are unchanged and are already covered by the coordinator, member and change-hold suites, which were run and pass.

## Commands run

```
# packages/db-p2p
yarn build                                                      # exit 0
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  test/storage-repo.spec.ts test/coordinator-repo-batch.spec.ts \
  test/cluster-member-batch-record.spec.ts test/action-change-hold.spec.ts \
  test/coordinator-repo-commit-divergence.spec.ts test/coordinator-repo-pend-divergence.spec.ts \
  test/cluster-consensus-divergence.spec.ts test/cluster-repo.spec.ts \
  test/coordinator-repo-integration.spec.ts test/coordinator-repo-write-durability.spec.ts \
  test/coordinator-repo-solo-commit-proof.spec.ts test/cluster-commit-digest.spec.ts \
  test/durability-window.spec.ts test/member-missed-commit-heals-at-commit.spec.ts \
  test/cohort-topic/change-bridge.spec.ts test/reactivity/collection-watch.spec.ts \
  test/pend-validation.spec.ts --reporter min                   # 421 passing

# also run and passing, earlier in the session
  test/cluster-pend-staleness.spec.ts test/cluster-commit-staleness.spec.ts
  test/concurrent-two-member-writes-do-not-tear.spec.ts test/cluster-slot-hold.spec.ts
  test/cluster-pend-held-vote.spec.ts test/a-silent-member-does-not-hold-up-a-write.spec.ts
  test/cluster-abandonment-e2e.spec.ts test/cluster-invalidation.spec.ts
  test/mid-ddl-crash.spec.ts test/rebalance-committed-holders.spec.ts
  test/commit-durability-quorum.spec.ts test/invalidation.spec.ts test/cascade.spec.ts

# repo root
yarn lint:docs                                                  # 49 documents, all citations resolve
```

No full `yarn test` (review's job, per `tickets/rules/testing.md`). No root `yarn typecheck`: neither Quereus plugin was touched, and db-p2p's only API change is additive (`applyInOneGroup`, `LocalApplyGroup`) — the one signature edit, `commit`'s unused second parameter back to `_options`, is a rename. No `yarn lint:deps`: no manifest changed and no import was added.

## Docs updated

- `packages/db-p2p/docs/storage.md` §6, *Who calls `flush()`*: the `StorageRepo` bullet now splits `endGroup` (strict bookkeeping groups) from `applyInOneGroup`, and a new paragraph, *One group may span several applies of one consensus record*, states the mechanism, the four callers, the optional-and-probed seam, and the nested reconcile flush. *Which groups carry a window* gains the one-group-one-window sentence; *Visible before durable* gains the widened span.
- `docs/internals.md`: the §Commit Path sentence now reads one flush per consensus record's pends and per its commits; the §Change Notification diagram's `storage.flush()` and `emitCollectionChanges()` lines say the same; the change-hold cost paragraph records that a one-record action's holds release at once.
