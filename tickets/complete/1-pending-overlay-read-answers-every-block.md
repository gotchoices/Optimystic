description: A storage read that names one unfinished change used to fail outright, including for blocks that change never touched. Now each block gets its own answer: the unfinished change laid over it where this machine holds it, and the block's ordinary saved content everywhere else.
prereq:
architecture: docs/internals.md#key-invariants
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/collection/action.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md, docs/transactions.md
----

# A read naming a pending change answers every block, never fails the batch

## What landed

- `StorageRepo.get` (`packages/db-p2p/src/storage/storage-repo.ts`): the "Pending action <id> not found" throw is gone. With `context.actionId` set, the overlay answer is given only for a block where this node holds a pending record of that action; every other block (never touched, promoted by this same read, cancelled, swept) gets the plain answer for the same context. The old "record missing but `unavailable` set" arm was folded into the plain path's `!blockRev` branch, which returns the identical `{ state: {}, unavailable }`. The site carries an accepted-tradeoff `NOTE:` on "any peer may name any pending action", with its revisit condition.
- `TestTransactor.get` (`packages/db-core/src/testing/test-transactor.ts`): same per-block rule; the overlay is applied over the base at the context's pin.
- `ActionContext.actionId` doc comment states the per-block rule and points at blocked `repo-pending-overlay-has-no-producer`.
- One sentence each in `docs/internals.md` (three-answer bullet) and `docs/transactions.md` (not-yet-committed bullet).
- Test: `a context naming a pending action answers each block on its own: overlay where held, plain read elsewhere` replaces the test whose premise was the defect.

## Review findings

Read the diff of `ticket(implement): pending-overlay-read-answers-every-block` before the handoff.

- **Correctness — `StorageRepo.get`:** checked that dropping the "missing record + `unavailable`" arm changes no answer. `unavailable` is set only by (a) a promotion decline over no committed revision, where the record is still held so the overlay branch answers, or (b) a `MissingBaseRevisionError` from a base-independent record, where either `blockRev` is undefined (plain `!blockRev` branch returns the same flagged empty state) or `getBlock` throws and the earlier per-block catch answers. No change found. The plain answer's `state.pendings` comes from `listPendingTransactions`, so it cannot name an action whose record was not found; a pend landing between the two reads is a harmless race with an unlatched read. Nothing else in `packages/*/src` reads `context.actionId` (`CoordinatorRepo`, `NetworkTransactor` forward it verbatim), and the remaining "Pending action … not found" throws are on the commit path, unaffected.
- **Correctness — `TestTransactor.get`:** verified by inspection (no dedicated test, as the ticket says). `applyTransformSafe` clones the base and any insert, so overlaying over the base returned by `latestMaterializedAt` does not alias stored state. The `committed` branch still overlays over `latestRev`, not the pin — pre-existing behaviour, left alone. Also pre-existing and outside this diff: a pinned read of a block deleted at or below the pin walks down past the tombstone to older content, in both the plain and overlay paths.
- **DRY / simplification — fixed inline:** `TestTransactor.get` resolved "committed content at the pin, or the latest" four separate ways (new overlay base, `committed` fall-through pinned and unpinned, plain pinned, plain unpinned). Extracted `committedAt(blockState, pin)` and collapsed the `committed` / pinned / unpinned branches into one `else` (the `committed` loop runs over `context?.committed ?? []`, then falls back to `committedAt`). Behaviour unchanged; db-core suite re-run.
- **Tests:** the new spec case pins both not-held shapes (promoted by this read, never touched) and the batch not failing, at the lowest layer that reproduces the old throw — kept. The removed test asserted the defect — correct to remove. No test added for the refactor (no behaviour change) or for `TestTransactor` (test double; the field has no producer).
- **Security:** any peer past the inbound-stream gate can name any pending action and read its transform. Recorded at the site as an accepted-tradeoff `NOTE:` by the implementer, with a stated revisit condition; the reasoning (ids already listed in `state.pendings`, `pend` under the `'r'` policy already returns rival transforms, authorization is node-level) holds. Nothing to file.
- **Docs:** read `docs/internals.md` and `docs/transactions.md` sentences and the blocked ticket `repo-pending-overlay-has-no-producer`, which already describes this behaviour as shipped. `yarn lint:docs` passes. No other doc describes the old throw.
- **Error handling / resource cleanup / performance / type safety:** no new error paths; the per-block `getPendingTransaction` lookup existed before. No findings.
- **Major findings / tickets filed:** none. **Tripwires added:** none — no conditional concern found beyond the already-recorded accepted tradeoff.

Validation: `yarn lint` (exit 0), `yarn lint:docs` (all resolve), `yarn workspace @optimystic/db-core test` — 1866 passing; `yarn workspace @optimystic/db-p2p test` — 3239 passing, 68 pending, 0 failing (both rebuilt first).
