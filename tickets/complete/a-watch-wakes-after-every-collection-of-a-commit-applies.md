description: When another machine's write reaches this machine, apps watching the table were woken as soon as the table's own data arrived, before the table's indexes had caught up, and nothing woke them again; a lookup through an index at that moment missed the new row. Storage now holds the table's wake on this machine until every other part of the same write that this machine is due to store has arrived.
architecture: docs/internals.md#change-notification-reactive-wake
files: packages/db-p2p/src/storage/action-change-hold.ts (`ActionChangeHold`), packages/db-p2p/src/storage/storage-repo.ts (`emitCollectionChanges`, `closeAbandonedGroups`, `notePendGroup`, `noteCancelled`, `armHoldTimer`, `pendUnderLatches`, `StorageRepoOptions.changeHoldMs`, `DEFAULT_CHANGE_HOLD_MS`), packages/db-core/src/transactor/change-notifier.ts (`IBlockChangeNotifier.onCollectionChange` doc), packages/db-p2p/src/testing/mesh-harness.ts (`BuildTransactorOptions.notifyLocalChanges`, `selfFirstReads`, `MeshOptions.changeHoldMs`, `MeshFailureConfig.onClusterDelivery`), packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (`startMockMesh`, `MockMeshOptions`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`ensureChangeSubscription` doc), packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/action-change-hold.spec.ts, packages/quereus-plugin-optimystic/test/two-node-index-wake-consistency.spec.ts, docs/internals.md, docs/architecture.md
difficulty: hard
----
# A watch wakes after every collection of a commit applies

GitHub [#47](https://github.com/gotchoices/Optimystic/issues/47). Landed by `ticket(implement): a-watch-wakes-after-every-collection-of-a-commit-applies`, reviewed here.

## What shipped

A SQL table and each of its indexes are separate collections, and a transaction writing a row commits each as its own consensus record under one action id, so a member applies them as separate storage commits. Storage now tracks, per action, the **pend groups** this node saved (the blocks one `pend` call wrote a pending record for, one collection's reservation) and holds an action's per-collection change events while another of its groups is still open. A group closes when a block of it lands here (commit, read-driven promotion, replica), when the writer's `cancel` names its blocks, or when a check after another collection landed finds none of its blocks still holding the pending record. Held events fire in the order held, ahead of the releasing call's own events, bounded by `changeHoldMs` (default 10 s, `0` disables) through one unref'd timer per action. The catch-all feed is never held. The bookkeeping is pure state in `ActionChangeHold` (capped at 4096 actions, evicting the oldest with its events released; event-less entries older than five minutes aged out on the next pend); the storage reads and the timer stay in `StorageRepo`.

Harness additions, each opt-in and off by default: `notifyLocalChanges` (a mesh node's transactor hears its own storage), `selfFirstReads` (a mesh node answers read-intent coordinator lookups with itself when in the cohort), `MeshOptions.changeHoldMs`, and an awaitable `onClusterDelivery`. The plugin's `startMockMesh` passes all four through.

## Review findings

**Read first:** the implement commit's diff in full, then the handoff. Lint, doc-citation lint, typecheck, the db-p2p suite (3533 passing, 74 pending) and the plugin suite (1056 passing, 14 pending, smoke ok) all pass after the review edits below; the new two-node spec passed on two further standalone runs.

**Checked by reading and running the code:**

- Happy path: two collections pended under one action, first commit held, second commit releases both in order; the catch-all fires per call. Single-collection commits take the no-read path and keep their prior event order, confirmed by the pre-existing change-notification cases in `storage-repo.spec.ts` passing unchanged.
- Edge cases walked through: a refused commit with empty `collectionBlocks` (the reads close the groups whose records the refusal dropped, so held events release); a pend re-delivered or retried under the same action id (overlap extends the group, so a stale record from an earlier attempt is closed when the retry's blocks land); a group whose records were dropped silently by the unpromotable sweep (closed by the read after the next landing, or aged out); a `get` promotion of two collections at different revisions (two `emitCollectionChanges` calls, the second group's record already gone, so both fire); a timer that released before the last collection landed (that collection fires alone, the documented tripwire).
- Concurrency: `release` takes the held list and forgets the action in one synchronous step, so two calls racing after the awaited read cannot both fire the same events; `closeGroup` after the await finds its group by identity and is a no-op if the action was released meanwhile. Listeners are invoked after the state mutation, so a re-entrant storage call sees consistent state.
- Resource cleanup: timers are cancelled on release, eviction and firing, and the only entries that linger are open groups that never close, which `ageOut` drops. The repo has no stop hook and needs none: the timers are unref'd, and a listener run after teardown is a logged no-op downstream.
- Error paths: an unreadable pending record keeps its group open rather than waking early, and the timer bounds it; a throwing commit emits nothing, as before.
- Interactions: in a two-member cohort the deferred pend decisions ride ahead of the commit request to the remote member, so both pend groups exist there before either commit applies, which is what the hold relies on. The local transactor and the plugin's per-commit coordinator take the same path, and the local Quereus commit still wakes its own watchers precisely.
- Cost: the existence read uses `getPendingTransaction` directly; `pendingClaimOf` reads the same record first and then the metadata, so it is not the cheaper read.

**Minor, fixed in this pass:**

- Three `this.changeHold!` non-null assertions in `storage-repo.ts`. The hold is now passed to `closeAbandonedGroups`, `armHoldTimer` and `releaseHeld` from the one site that already narrowed it.
- `IBlockChangeNotifier.onCollectionChange` still said listeners run "in commit order" without qualification; a held event can now fire after the event of a later commit, and the doc says so.
- `docs/architecture.md` described the primitive as firing when a commit's critical section completes, which is no longer the whole story for a multi-collection transaction; it now carries a one-clause qualification and links the internals section.

**Major findings:** none. The implementation matches the plan ticket point for point, and nothing reached the filing bar.

**Tripwires recorded (conditional, not tickets):**

- `closeAbandonedGroups` in `packages/db-p2p/src/storage/storage-repo.ts`: a commit this node refused as a behind divergence drops its records, so the refused collection's group reads as abandoned and the held events release before the reconcile lands that collection. Needs cohort drift on a watched member. The remedy, if seen, is to keep the refused group open for the reconcile.
- Already recorded by the implementer and confirmed appropriate: the late-delivered pend residual at `notePendGroup`, and the release-then-late-landing tripwire at `armHoldTimer`.

**Tests reviewed:** the three storage-repo cases pin the hold, the cancel release and the timer bound, each a distinct contract; the three pure-state cases pin the overlap rule, the capacity eviction and the age-out, which storage never reaches in a short test. All kept. The two-node control case (hold disabled, gap observed) is kept deliberately: without it a harness regression that let node 1's lookup be served by node 0 would make the main case pass vacuously. No test was cut and none added.

**Docs:** `docs/internals.md` §Change Notification and §Reactive Watch Bridge read correctly against the code; `docs/architecture.md` corrected as above; `docs/debugging.md` has no reactivity section to extend. Not run: `yarn test:integration` (env-gated, real sockets) and `yarn check:rn`; the new module uses only `Map`, `Set` and arrays.

**Known gaps carried forward:** `changeHoldMs` is reachable only through `StorageRepoOptions` (no node-level knob, per the plan); the network-watch path is unchanged and tracked by backlog `feat-a-network-watch-wake-sees-the-whole-commit`; the catch-all's dependence on an action-id certificate lookup is backlog `bug-a-commit-cert-is-looked-up-by-action-alone`.
