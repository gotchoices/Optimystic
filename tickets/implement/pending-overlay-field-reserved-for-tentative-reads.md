description: The request field that lets a read see one unfinished change stays in place but unused, and its comments are rewritten to say what it is reserved for, the rule its future user must follow, and why the old "remember pending changes seen while reading" idea was dropped. No behaviour changes.
prereq:
architecture: docs/correctness.md#theorem-3-multi-collection-atomicity-of-intent-eventual-reported-visibility
files: packages/db-core/src/collection/action.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-p2p/src/storage/storage-repo.ts, docs/internals.md, tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md
difficulty: easy
review: skip
----

# Reserve `ActionContext.actionId` for tentative reads; retire the `tryGet` TODO

## Decision being applied

Maintainer decision, 2026-10-07: the pending-overlay field (`ActionContext.actionId` in `packages/db-core/src/collection/action.ts`) keeps its storage-side behaviour and gets **no producer now**. Nothing should set it, and no early-abort check is wanted. The reasoning, settled in plan:

- No client code reads between a pend and its commit: `TransactorSource.transact` (used by `Collection.sync`) and `TransactionCoordinator.coordinateTransaction` (`pendPhase` then `commitPhase`) send the commit as soon as the pend returns, and `TransactionSession` pends only at `commit()`. A producer would mean adding a round trip.
- The validator (`TransactionValidator.validate`) re-executes against committed state and stages the transaction's own earlier statements locally; it never needs the overlay.
- The only failure the overlay could reveal that is *certain* is "the block's latest revision is at or past ours under another action", and a plain read's `state.latest` says the same. Every overlay-only signal (our pending record missing on the asked machine, the overlay materializing nothing or different bytes) describes one cohort member being behind, which cannot justify an abort because a commit needs a majority, not that member.

The one design on the board with a genuine reader of a pending change is long-lived pend (`tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md`): "a read that observes a tentative (pended, not committed) revision makes the observing transaction tentative too". That ticket becomes the field's future producer.

This is comment, doc and ticket text only. No code path, wire format, stored data or test changes.

## Changes

**1. The doc comment on `ActionContext.actionId`** (`packages/db-core/src/collection/action.ts`). Keep the first two sentences (what a repo does with it). Replace the trailing "No production code sets it today — see the blocked ticket `repo-pending-overlay-has-no-producer`." with text to this effect:

> No production code sets it. It is reserved for *tentative reads* in long-lived pend (backlog `feat-long-lived-pend-completes-as-members-appear`), where a read that observes a pended-but-uncommitted revision makes the reading transaction tentative too. It is deliberately not used for early abort: the only certain abort signal — a latest revision at or past the pended one under another action — is already on a plain read's `state.latest`. Whoever sets it must keep the overlay answer out of every cache as committed content: mark it `mayRetain: false` through `TransactorSource.describeServed`, and record no read dependency for it. The content is no committed revision, and the answer's `materialized` revision names the base under the overlay, not the content (see "Staged Edits Keep Their Base" in `docs/internals.md`).

Keep the tabbed JSDoc style of the surrounding block.

**2. The `TODO` in `TransactorSource.tryGet`** (`packages/db-core/src/transactor/transactor-source.ts`, the "if the state reports that there is a pending action, record this so that we are sure to update before syncing" comment and the commented-out `//state.pendings` line under it). Delete both and put a `NOTE:` tripwire in their place, to this effect:

> NOTE: rival pendings in `state.pendings` are deliberately not remembered for a refresh before the next pend. It would save one doomed pend round only when the rival commits in between; the hint goes stale on a cache hit (which never re-reads), stuck records would trigger refreshes for nothing (backlog `debt-unpromotable-pending-records-need-a-sweep`), and while the rival is still pending a refresh changes nothing and the pend is refused `held` anyway. Revisit if lost pend rounds after a rival commit show up in measurements.

**3. The overlay comment in `StorageRepo.get`** (`packages/db-p2p/src/storage/storage-repo.ts`, the paragraph beginning "The named pending action (`context.actionId`) is overlaid"). Its last sentence points at `tickets/blocked/repo-pending-overlay-has-no-producer`, which no longer exists. Replace it with: "No production code sets `actionId`; it is reserved for tentative reads — see the doc comment on `ActionContext.actionId`." Leave the accepted-tradeoff `NOTE:` below it untouched.

**4. `docs/internals.md`**, the sentence "The overlay is per block: a read naming a pending action (`ActionContext.actionId`) gets that action laid over …" in the three-answers bullet. Append one sentence: nothing in production names a pending action today; the field is reserved for tentative reads in long-lived pend, and an overlay answer must never be kept by a read cache as committed content. Run `yarn lint:docs` afterwards.

**5. The long-lived-pend backlog ticket** (`tickets/backlog/feat-long-lived-pend-completes-as-members-appear.md`). Append a short section (e.g. "## Reading a tentative revision") saying: the repo already serves a read through one named pending action (`ActionContext.actionId`, overlay in `StorageRepo.get`, mirrored by `TestTransactor.get`); this feature is that field's first producer; and the producer must follow the cache rule from change 1 (`mayRetain: false` via `describeServed`, no read dependency, `materialized` names the base). Do not edit its header.

## Edge cases & interactions

- **No behaviour change.** Every edit is a comment, doc or ticket body. Verify by inspection that the diff touches no executable line beyond removing the commented-out `//state.pendings`; `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-p2p build` must still pass. No tests are run or added for this.
- **Doc citations.** `docs/internals.md` is checked by `yarn lint:docs`: any backticked path must exist and any anchored symbol must be present in the named file. Cite `ActionContext.actionId` with `packages/db-core/src/collection/action.ts` only if writing it as an anchored citation; no line numbers.
- **Stale ticket references.** After the edit, `git grep -n "repo-pending-overlay-has-no-producer" -- ':!tickets'` must return nothing.
- **Existing overlay tests stay as they are.** The per-block overlay behaviour from `pending-overlay-read-answers-every-block` is the contract the future producer relies on; do not remove or loosen it.

## TODO

- Rewrite the `ActionContext.actionId` doc comment (change 1).
- Replace the `tryGet` TODO and commented-out line with the `NOTE:` tripwire (change 2).
- Update the overlay comment's ticket pointer in `StorageRepo.get` (change 3).
- Append the reservation sentence in `docs/internals.md` and run `yarn lint:docs` (change 4).
- Append the producer section to the long-lived-pend backlog ticket (change 5).
- Build db-core and db-p2p; confirm the stale-reference grep is empty.
