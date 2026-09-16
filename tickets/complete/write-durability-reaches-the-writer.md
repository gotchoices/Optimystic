description: An app that saves a change can now find out whether the whole group of machines is holding it or only the machine that wrote it, so it can show the change as pending instead of saved. The answer now travels from the storage layer all the way up to the save call.
files: packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/transaction/coordinator.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/index-staging-patch.ts, packages/db-core/test/write-durability-reaches-the-writer.spec.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-p2p/test/util/two-machine-lifecycle.ts, packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts, docs/optimystic.md, docs/internals.md
----

# What landed

The transactor already answered a commit with a `WriteDurability` (prereq `commit-result-carries-durability-class`). Nothing above it passed that on, so a writer could not tell a write the whole group holds from one only its own machine holds. Now the answer reaches the writer:

- `TransactorSource.transact` returns the whole `CommitResult` instead of collapsing success to `undefined`. Callers that want the old boolean read `result.success`.
- `Collection.sync`, `syncInternal`, `syncAttempts` and `updateAndSync` return `WriteDurability | undefined`. `undefined` means **nothing was written** — nothing was staged, so there was no pend and no commit and no class to fabricate. A write that never lands still throws `SyncRetryExhaustedError`; it never returns a class.
- `ICollection.sync` and `ICollection.updateAndSync` widened to match (`Collection` is the only implementer).
- `Tree.replace`, `Tree.sync` and `Diary.append` forward the value without interpreting it, `torn` list included.
- `TransactionCoordinator.commit` still returns nothing and carries a `NOTE:` saying so, pointing at `backlog/feat-multi-collection-commit-reports-durability`.
- `DirtyTree.sync()` in the quereus bridge widened to `Promise<unknown>` — a structural interface a real `Tree` had stopped satisfying.

No behaviour changed: the same writes succeed, the same are refused, the same retries happen. Only return values widened.

# Review findings

## What was checked

The implement diff was read first, before the handoff summary: the `transact` refactor against the pre-change control flow, the whole `syncAttempts` retry loop, every widened signature and its call sites, the eight commit-success construction sites in the repo, the new unit suite, the two-machine test helper, the phase-5 integration assertion, and both touched docs against the code they describe. Lint, doc-citation lint, build, typecheck and every test suite were run after the fixes below, plus the lifecycle integration spec four times to reach both of its branches.

## Fixed in this pass (minor)

- **`docs/optimystic.md` called a method that does not exist.** The new "Was it really saved?" snippet — and the pre-existing Sync snippet directly above it — wrote `await users.updateAndSync()`, but `users` is a `Tree`, and `Tree` exposes `sync()`, not `updateAndSync()` (that is `Collection`'s name, which `Tree.sync` calls internally). A reader copying the durability example got a `TypeError`. Both snippets now use `users.sync()`, and the prose above names both methods so the layering stays clear. This was the one thing actually wrong in the new documentation; the rest of both additions was checked line by line against `DurabilityQuorum`, `isFullyDurable` and the commit path, and is accurate.
- **A second structural interface still declared the old `sync(): Promise<void>`.** The ticket's audit found `DirtyTree` and widened it, but missed `LiveIndexManager.getIndexTree` in `packages/quereus-plugin-optimystic/test/index-staging-patch.ts`, which describes the same object the same way. It survives only because `liveIndexManager` reaches it through an `as unknown as` cast, so no compiler check was ever going to flag the drift — the description was simply wrong about what the object returns. Widened to `Promise<unknown>` with the same rationale as `DirtyTree`, and the comment now says why the cast hides it.
- **The `const staleFailure = attempt;` alias** in the refusal branch, which the implementer explicitly left to the reviewer's call, is gone. The `if (!attempt.success)` guard one line above already narrows and already says the branch is a refusal; a second name for the same value inside a thirty-line branch bought nothing.

## Checked and found sound — no action

- **The `transact` refactor is exactly behaviour-preserving.** Moving `return commitResult` out of the failure branch looks like a control-flow change but is not: the old success path fell through the `if` to the function's implicit `return undefined`, which was the old success value. The pend-failure early return and the `catch` path that attaches a failed cancel to the real cause are untouched.
- **The "undefined means nothing was written" contract cannot be broken by a forgetful success.** `CommitSuccess.durability` is required by the type, and all eight commit-success construction sites in `packages/*/src` populate it; the two on the client side (`NetworkTransactor`) build it locally from cohort reports rather than trusting the wire, so a deserialized success cannot arrive classless. Within `syncAttempts` the only exits are `return durability` and a throw, and the success branch always assigns — so `undefined` really does mean the loop never ran.
- **`ICollection` has exactly one implementer** (`Collection`), re-verified rather than taken from the handoff. No `sync`/`updateAndSync` is passed anywhere as a function reference, so TypeScript's void-return assignability rule had nothing to silently absorb.
- **`isFullyDurable` and `mergeDurability` are exported from the db-core package root**, so the doc snippet's import and the db-p2p test helper's import are both real.

## The multi-batch fold — the implementer's flagged deviation, resolved as written

`syncAttempts` can in principle commit more than one batch in one sync, and the implementer folded the batches weakest-wins with `mergeDurability` rather than reporting the last one, flagging it as going past the ticket's letter and asking for a second opinion. Two things settle it:

**It is unreachable today, by code, not by assumption.** The loop re-tests `hasUnsyncedChanges()`, which is `pending.length > 0 || tracker.transforms non-empty`. On the success branch `this.pending` is sliced empty — `act()` and `syncInternal` take the same collection latch, so nothing can have been added meanwhile — and `replayActions()` then resets `this.tracker` *unconditionally* before re-staging an empty pending queue. Both disjuncts are false, so there is no second iteration and `mergeDurability` is never called. That matches the implementer's suspicion and the loop's own comment; it could not be pinned by a test without faking the loop, and it does not need one.

**Weakest-wins is the right choice for when it does become reachable.** The one semantic worry about folding across batches is `torn`: `mergeDurability` unions the abandoned-block lists, so a block an early batch abandoned would still be reported torn even if a later batch had re-committed it. That case cannot arise — an abandoned block's transform was cancelled and the pending action that produced it is already consumed, so per `WriteDurability.torn`'s own contract only the writer re-driving the action puts it back. The union is therefore accurate, not over-pessimistic. Last-success-wins, the simpler alternative, would show a write as saved when an earlier batch only reached the writer. Left as written.

## Tripwires

**None recorded, and that is a finding rather than a silence.** The only conditional concern in the diff was the multi-batch fold, and it turned out to be both dormant and correct, so there is nothing a future reader needs warning about; the existing comment at the fold already explains why it folds rather than overwrites. No other site in the diff has an "fine now, breaks if X" shape — the change is a widening of return types along a single path.

## New tickets

**None filed.** The two gaps the handoff names already have open homes on the board: the multi-collection path that reports no class is `backlog/feat-multi-collection-commit-reports-durability` (which the new `NOTE:` at `TransactionCoordinator.commit` points at), and the reason a multi-cohort shape is hard to reach in-process is `backlog/debt-no-mesh-fixture-forces-two-coordinator-batches`. Nothing found here is a new instance of either, and nothing found here is a defect needing its own ticket.

## Considered and not filed

- **`undefined` doing double duty as "nothing was written"** means the natural `if (d && !isFullyDurable(d))` treats an empty sync as saved. That is the intended reading — nothing was staged, so there is nothing to show as pending — and the ticket specified this shape. Changing it (a sentinel, or throwing) is an API decision, not a fix, and the contract is documented at four code sites plus the user-facing doc.
- **`unrouted` is never exercised through the collection API.** The collection layer is a pass-through of an opaque value, and the unit suite proves that pass-through with arbitrary stamped classes, so exercising one more class would pin nothing new.
- **A real mesh-produced `majority` or `full` arriving at `Collection.sync` is still unproven above the transactor.** The prereq ticket covers the transactor level; above it the value is returned by identity. The remaining link is a fixture problem already on the board.

## Test coverage observation

Phase 5's new durability assertion runs only when the lone survivor's write is *admitted* — admission itself is still under design, which is why the assertion is conditional, and that is right. But it means the assertion is load-dependent, not run on every pass: on this machine 1 of 4 runs took the acknowledged branch (the other 3 were refused with "Failed to get super-majority: 1/2 approvals"), where the handoff saw 7 of 8. Recorded so nobody reads a green phase 5 as proof the class was checked on that run. The acknowledged run did report `local` with `isFullyDurable` false, as claimed.

# Validation

All run after the fixes above.

- `yarn lint` clean. `yarn lint:docs` — 46 documents, 118 anchored citations, 623 file mentions, 345 links, all resolve.
- `yarn build` and `yarn typecheck` clean across every workspace.
- `yarn workspace @optimystic/db-core test` — 1695 passing.
- `yarn workspace @optimystic/db-p2p test` — 2769 passing, 62 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 950 passing, 13 pending, smoke ok.
- `yarn test:harness` — 51 passing.
- `small-deployment-lifecycle.integration.spec.ts` run four times — 6 passing each; one run took the acknowledged branch and exercised the new assertion, three took the refusal branch and skipped it as designed.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

# Downstream evidence carried over from the handoff

Recorded by the session tending the sereus repository, not by this ticket. sereus links `../optimystic` and typechecks against its built output; it rebuilt optimystic at `c56c2bd4` and its own typecheck came back green across every workspace — so the widening, `DirtyTree.sync()`'s move to `Promise<unknown>` included, cost one real dependent monorepo nothing at the type level. Its integration suite at the same commit ran 301 tests with 2 failures, neither attributable to this change: one is a sereus-side timing guard tripped by optimystic's *earlier* schema-batching work, and the other is a network-timing scenario now filed downstream for its own investigation as `backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`. That second one enters `Collection.updateInternal`, which writers also run, so it is neither exonerating nor implicating here — it needs its own before/after measurement, which nobody has taken.
