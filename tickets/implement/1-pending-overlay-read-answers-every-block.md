description: A storage read that asks to see one particular unfinished change can make the whole read fail, including for blocks that change never touched. Change it so each block gets its own answer: the unfinished change laid over the block where this machine holds it, and the block's ordinary saved content everywhere else.
prereq:
architecture: docs/internals.md#key-invariants
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/collection/action.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md, docs/transactions.md
difficulty: easy
----

# A read naming a pending change answers every block, never fails the batch

## Background

A block write happens in two steps: the change is first stored as **pending** on each machine of the block's cohort, then **committed** as a numbered revision. A read request can name one pending change through `ActionContext.actionId` (`packages/db-core/src/collection/action.ts`), asking the storage side to lay that change over the committed content it holds. `StorageRepo.get` (`packages/db-p2p/src/storage/storage-repo.ts`) and its in-memory double `TestTransactor.get` (`packages/db-core/src/testing/test-transactor.ts`) both honour the field. No production code sets it yet; whether and where something should is the open question in `tickets/blocked/repo-pending-overlay-has-no-producer.md`. This ticket does not depend on that answer: the field stays on the wire whichever way it goes, any peer that passes the inbound-stream gate can set it, and the way the storage side answers it today is wrong.

## What is wrong

`StorageRepo.get`, in its "Include pending action if requested" branch, treats the named action as a claim that must hold on **every** block of the batch. When this node holds no pending record of the named action for a block, it throws `Pending action <id> not found`. That throw is not per block. It rejects the whole `Promise.all`, so healthy sibling blocks in the same request fail with it.

There are two ways to reach it.

- **The action never touched this block.** A reader that wants to see its own unfinished change reads more blocks than the change wrote: the header, the blocks a B-tree walk passes through, unrelated leaves. Under today's rule, the first block the change did not write fails the whole read. So any future producer of the field would break on its first multi-block read. The test double has the same defect from the other side: it answers `block: undefined` for a block the action did not touch, which hides committed content that exists.
- **The request contradicts itself.** The same action is listed in `context.committed` (so the reader claims it is committed) and named as `context.actionId` (so the reader also asks for it as pending). The read-driven promotion earlier in `get` promotes the record, which moves it out of the pending store, and then the overlay branch throws because the record is gone. If the promotion had been *refused*, the existing `unavailable !== undefined` arm would have answered gracefully, so the two halves of one contradiction land differently. The plan-stage probe confirmed the throw: pend an insert, then read with the action named in both places.

## The rule

**The named action is laid over a block if this node holds a pending record of it for that block. Every other block is answered exactly as a plain read with the same context would answer it.**

So, per block:

| this node holds a pending record of `context.actionId` for the block | answer |
| --- | --- |
| yes | the existing overlay answer, unchanged: `applyTransform` over the base at the pin, `state.pendings: [actionId]`, `materialized` = the committed base when there is one, and the existing `unavailable` clauses for an overlay that materializes nothing |
| no (never touched it, already promoted, promoted by this very read, cancelled, swept) | the plain-read answer: committed content at the pin, `materialized`, `state.latest`, the full `state.pendings` list, and the `unavailable` flag the promotion or the materialization set |

A caller can tell which answer it got: the overlay answer's `state.pendings` names the action, and the plain answer's never does, because the record is not held. That is also the meaning `NetworkTransactor.getStatus` already reads off `state.pendings`.

The self-contradictory request therefore needs no special case. Once the promotion has moved the record, the block is "not held", and the plain answer serves the committed content, which now includes the action.

The existing "no record, but `unavailable` set" arm also stops being a special case. When the promotion refused a base-independent record and `refuseMissingBase` deleted it, the plain path already returns `{ state: {}, unavailable }` (the `!blockRev` branch), or the content it does hold. The implementer must confirm the collapse is behaviour-preserving for the test `a promotion DECLINE on the context's OWN actionId returns a flagged entry with the record kept, never a throw` and the `unmaterializable` cases near it. If any differs, keep the arm and say why.

## Who may name whose pending change

The field arrives from remote peers unvalidated, and an overlay read shows the named action's uncommitted transform to whoever names it. **Decision: no per-asker restriction.** Record it as an accepted-tradeoff `NOTE:` at the overlay branch. The reasons, for the note:

- **There is nothing to check authorship against.** The repo protocol carries no proof that the asker wrote the action. A single-collection pend is unsigned (only a validated multi-collection pend carries a client signature), so "only its own action" cannot be enforced, only pretended.
- **The ids are not secret.** Every plain read lists the pending action ids on the block (`state.pendings`).
- **The content is already disclosed.** `StorageRepo.pend` under the `'r'` policy already returns rival pending transforms to its caller.
- **There is no per-reader confidentiality anywhere.** Authorization in this system is the node-level inbound-stream gate (`authorizeInboundStream`, see *Inbound Stream Authorization* in `docs/internals.md`). Any peer past the gate can read every committed block.

The note's revisit condition: per-reader read authorization, or signed pends that bind an action id to its author.

The overlay answer is read-only and unlatched, as today. Nothing here writes.

## Edge cases & interactions

- **Mixed batch.** The action is held on some blocks of one request and not on others. Each block gets its own row of the table, and no block's answer depends on another's. Verified by the test below.
- **Promoted by this read.** The action is in `context.committed`, ahead of this node's `latest`, and the promotion promotes it inside the latch. The plain answer then serves it at the pin, with `materialized` naming the action when `context.rev` is at or above its revision. Verified by the test below.
- **Promotion declined, record kept** (an update-only record whose base is not reached here). The record is still held, so this is the overlay row, unchanged from today. Covered by the existing test.
- **Promotion refused, record deleted.** This is the `unavailable` collapse above. Covered by the existing tests, which must stay green.
- **Concurrent commit promotes the record between `getPendingTransaction` and the answer.** The transform object already read is applied. The answer is the overlay as of just before the promotion, which is no worse than a plain read racing a commit. Verified by inspection.
- **`CoordinatorRepo.get`** forwards the storage answer and drives read repair off `state.latest`. Its consult trigger keys off `entry.block === undefined` (see the `flagUnconfirmedAbsence` doc). A plain answer for a not-held block is exactly what that code already handles. Verified by inspection.
- **`TestTransactor`.** Its overlay branch must follow the same rule: for a block without a pending of the action, fall through to its standard committed resolution instead of `block = undefined`. While there, apply the overlay over the base at the context's pin (`latestMaterializedAt(blockState, context.rev)` when `context.rev` is set), as `StorageRepo` does, rather than always over `latestRev`. Verified by inspection. The double has no spec of its own for this, and does not need one.

## Tests

Two changes in `packages/db-p2p/test/storage-repo.spec.ts`, in the describe holding the pending-overlay cases:

- Replace `a context naming a pending this repo NEVER had still throws`. Its premise, that a not-held action is a caller-contract violation, is the defect.
- Add the reproduction as a single test. Commit block `Y` (`a1`, rev 1, content `v1`). Pend an insert of block `X` under `p1` (policy `'c'`). Read `[X, Y]` with context `{ actionId: 'p1', rev: 1, committed: [{ actionId: 'p1', rev: 1 }] }`. Expected:
  - the call resolves; today it rejects with `Pending action p1 not found`;
  - `X` is served with its inserted content, `materialized` is `{ actionId: 'p1', rev: 1 }`, and `state.pendings` does not contain `p1`;
  - `Y` is served with `v1` and `materialized.rev === 1`.

  This one test covers both "not held" shapes (promoted by this read, never touched) and the batch not failing.

No other new tests.

## TODO

- In `StorageRepo.get`, replace the throw with a fall-through to the plain-read path for a block whose pending record of `context.actionId` is not held. Drop or keep the `unavailable` arm per the confirmation above.
- Rewrite the long comment at the old throw site. It currently cites `tickets/blocked/repo-pending-overlay-has-no-producer`. State the per-block rule instead, add the accepted-tradeoff `NOTE:` on who may name whose action, and keep the `blocked/` citation only as the pointer for "no producer yet".
- Do the same for the comment on the overlay answer ("Tolerated on this branch alone: … no production code sets `actionId`").
- In `TestTransactor.get`, make the overlay branch follow the rule (fall through for not-held blocks; overlay over the pinned base).
- Widen the doc comment on `ActionContext.actionId` in `action.ts`. Say what a repo does with the field (overlay where it holds the record, plain answer elsewhere), that no producer sets it today, and point at the blocked ticket.
- Make the test changes above. Run `yarn workspace @optimystic/db-p2p test` and `yarn workspace @optimystic/db-core test`. Rebuild db-core first, because the build-freshness guard refuses a stale build.
- Docs:
  - `docs/internals.md`: in the "A block read has three answers" bullet, where it says a pending-only insert "read with a context is served from its pending overlay", add one sentence giving the per-block rule.
  - `docs/transactions.md`: in the "A block that has been written but not yet committed is not "indeterminate"" bullet, add the same sentence.
  - Run `yarn lint:docs`.
