description: A storage read that names one unfinished change used to fail outright, including for blocks that change never touched. Now each block gets its own answer: the unfinished change laid over it where this machine holds it, and the block's ordinary saved content everywhere else.
prereq:
architecture: docs/internals.md#key-invariants
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/collection/action.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md, docs/transactions.md
----

# A read naming a pending change answers every block, never fails the batch

## What changed

- `StorageRepo.get` (`packages/db-p2p/src/storage/storage-repo.ts`): the "Pending action <id> not found" throw is gone. When `context.actionId` is set, the overlay answer (unchanged) is given only for a block where this node holds a pending record of that action; every other block falls through to the plain-read path with the same context. The old "record missing but `unavailable` set" arm was dropped: the plain path's `!blockRev` branch returns exactly `{ state: {}, unavailable }` for the only shape that reaches it (a base-independent record deleted by `refuseMissingBase` over no committed revision — an insert over an unmaterializable `latest` throws in `getBlock` and returns earlier). If a committed base *were* present there, the plain answer now serves it unflagged with full `state.pendings`, which is the ticket's stated rule. The long comment at the old throw site was rewritten to state the per-block rule and carries an accepted-tradeoff `NOTE:` on "any peer may name any pending action" with the revisit condition (per-reader read authorization, or signed pends binding an action id to its author).
- `TestTransactor.get` (`packages/db-core/src/testing/test-transactor.ts`): the overlay branch now applies only when the block holds the named pending, and overlays over the base at the context's pin (`latestMaterializedAt` when `context.rev` is set) instead of always `latestRev`. A not-held block falls through to the existing `committed` / pinned / latest resolution instead of `block: undefined`.
- `ActionContext.actionId` doc comment (`packages/db-core/src/collection/action.ts`) states the per-block rule and that no producer sets it (points at blocked `repo-pending-overlay-has-no-producer`).
- Docs: one sentence each in `docs/internals.md` (the "A block read has three answers" bullet) and `docs/transactions.md` (the "not yet committed is not indeterminate" bullet). `yarn lint:docs` passes.

## Tests

- Removed `a context naming a pending this repo NEVER had still throws` — its premise was the defect.
- Added `a context naming a pending action answers each block on its own: overlay where held, plain read elsewhere` (storage-repo.spec.ts, `get` describe): commits `Y` at rev 1, pends insert `X` under `p1`, reads `[X, Y]` with `{ actionId: 'p1', rev: 1, committed: [{ p1, 1 }] }`. Asserts the call resolves, `X` is the inserted content with `materialized = { p1, 1 }` and `state.pendings` not containing `p1`, `Y` is `v1` at rev 1. Covers both not-held shapes (promoted by this read, never touched) and the batch not failing. Not re-run against the pre-change code; the plan-stage probe confirmed the throw for this shape.
- Existing overlay cases (`DECLINE on the context's OWN actionId`, pending DELETE tombstone, pending UPDATE over no base, mixed batch with wedged sibling, pending-only insert) still pass unchanged.

Runs: `yarn workspace @optimystic/db-core test` — 1866 passing. `yarn workspace @optimystic/db-p2p test` — 3239 passing, 68 pending, 0 failing (db-core and db-p2p rebuilt first).

## For the reviewer

- `TestTransactor` change has no dedicated test (ticket says it needs none); verify by inspection. Its `committed` branch, now reached also when `actionId` is set but not held, applies the first *pending* named in `committed` over `latestRev` (not over the pin) — pre-existing behaviour, untouched.
- Concurrent commit promoting the record between `getPendingTransaction` and the answer: overlay applies the already-read transform (unchanged from before).
- `CoordinatorRepo.get` was checked by inspection only: a plain answer for a not-held block is the shape it already handles.
