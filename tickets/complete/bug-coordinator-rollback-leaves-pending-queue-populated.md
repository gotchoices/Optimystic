description: Cancelling a transaction used to rewind the in-memory data but forget to throw away the list of changes it was going to write, so the next transaction recorded the cancelled changes in the permanent history. The cancel now rewinds both halves together.
files:
  - packages/db-core/src/transaction/coordinator.ts (implement: `stampData` type, `applyActions` capture, `rollback` doc + restore loop + mid-replay refresh; review: `CollectionSnapshot` type alias at 5 sites, new `NOTE:` at the commit finalize loop)
  - packages/db-core/src/transaction/session.ts (review: stale `rollback()` doc comment corrected)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (new — 9 cases)
  - packages/db-core/src/collection/collection.ts (unchanged — `CollectionSnapshot`, `snapshotPending`/`restorePending`)
----

# What landed

A `Collection` stages every change in two places: the tracker transforms (what in-memory
reads see) and the pending action queue (the ordered list a commit records into the
collection's permanent action log). `TransactionCoordinator.rollback` restored only the
transforms, so a cancelled transaction's actions stayed queued and the next transaction
to commit on that collection wrote them into *its* permanent log entry, still tagged with
the cancelled transaction's id.

The fix widens the coordinator's per-transaction rollback snapshot from `Transforms` to
the `CollectionSnapshot` pair the collection already models as one value —
`Collection.snapshotPending()` / `restorePending()`, which the commit path was already
using correctly. Half-restored staged state is no longer representable in that map, so
the class is closed by the type rather than by a guard.

Sites: the `stampData.preSnapshot` type, the `applyActions` first-call capture, the
`rollback` restore loop, and the `rollback` mid-replay refresh (so a survivor replayed
later in the loop carries its queue forward and the next rollback does not re-open the
hole).

Review added two small corrections on top and one `NOTE:` — see below.

# Review findings

## What was checked

The implement diff was read first, without the handoff summary. Then: the four changed
sites in `coordinator.ts` and their surrounding commit/execute paths; `Collection`'s
`snapshotPending`/`restorePending`/`getPendingActions`/`clearPendingActions` and every
assignment to `Collection.pending`; the new 379-line spec case by case; the delegating
`TransactionSession.rollback`; every `rollback` caller across the workspace; the
`docs/` files that mention rollback or pending mechanics (`transactions.md`,
`internals.md`); and the open board for tickets already claiming these sites.

The implementer's five "known gaps" were each probed rather than taken on trust.

Commands run from `packages/db-core`, all passing:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min   → 1584 passing, 0 failing
npx tsc --noEmit -p tsconfig.json                                                                  → clean
```

From the repo root: `yarn typecheck` clean, `yarn lint:docs` clean (45 documents, 71
citations, 307 links all resolve), `npx eslint` clean on all three changed paths. No
pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

**Independent bite check.** Rather than trusting the handoff's claim, the restore loop was
reverted to `tracker.reset(structuredClone(snapshot.transforms))` and the new spec re-run:
**7 of 9 cases failed**, only the two deliberate no-op cases passing. (The handoff reported
6 of 9; the spec bites harder than claimed, not softer.) The revert was undone and the
file byte-restored before proceeding.

## Major — one finding, filed

**A transaction's rollback snapshot goes stale the moment a sibling transaction commits.**
Filed as `backlog/bug-coordinator-stamp-snapshots-go-stale-when-a-sibling-commits`,
`repro: verified`, severity `corruption`, likelihood `unusual`.

The coordinator keeps per-transaction bookkeeping (a snapshot, an action-batch list, an
`order`) on top of state that is collection-scoped, not transaction-scoped. Commit and
rollback both act at collection granularity while accounting at transaction granularity,
and nothing reconciles the two. Reproduced by running it, with a fresh reader opened on
the same storage after each step so the permanent history is read independently:

```
stage 'A' under transaction A; stage 'B' under transaction B
commit(A)            → permanent history reads ['A','B']   ← B's uncommitted action was written
rollback(B)          → history still ['A','B'], but the collection's queue holds A's
                       already-committed action again
stage 'C'; commit    → permanent history reads ['A','C']   ← A recorded a second time, B's record gone
```

Expected: `['A']`, then `['A','C']`.

Both symptoms — the commit draining a sibling's queue, and the stale snapshot rewinding
past the commit — resolve at the same representational fact, so they are one ticket with
two arms rather than two tickets. The ticket weighs three fixes (per-transaction staged
state; tag-scoped commit and rollback; or refusing a second concurrent transaction) and
recommends planning it alongside the two sibling coordinator tickets.

**Relationship to this change, stated honestly:** the corruption predates it. Pre-fix the
same sequence ended with the permanent history reading `['C']` — the committed record
silently dropped; post-fix it reads `['A','C']` — an already-committed action recorded
again. Different symptom, same defect; the fix neither causes nor removes it. It is not
reachable through the shipping adapter, which drives one transaction at a time per
connection and documents that constraint at `docs/transactions.md:~156-161`. It is
reachable through `db-core`'s exported `TransactionCoordinator` API, whose own design (the
`order` counter, the survivor-replay loop) advertises concurrent transactions — which is
why it is a latent defect and a ticket, not a tripwire.

## Minor — fixed in this pass

- **`session.ts:~178` documented the bug the change fixed.** `TransactionSession.rollback`'s
  doc still said the coordinator "restores collection **trackers**… to preserve their
  **transforms**" — precisely the half-restore that was wrong. The implement pass updated
  `coordinator.rollback`'s doc and missed the delegate's. Rewritten to describe both halves
  and why restoring both is load-bearing.
- **`ReturnType<Collection<any>['snapshotPending']>` repeated at five sites** (three from
  this change, two pre-existing) where the collection already exports the named
  `CollectionSnapshot<TAction>` interface — `Tree` imports it by name. Replaced with
  `CollectionSnapshot<any>` throughout and added to the type import. No behaviour change;
  the indirection was obscuring that all five name one contract.

## Verified — the implementer's five stated gaps

Each was probed; none needed a ticket.

- **Late-registered collections skipped** — confirmed by reading the restore loop, which
  iterates the snapshot map (a late-registered collection is in no map, so both halves are
  skipped now exactly as both were skipped before). Already filed and well-specified as
  `backlog/bug-coordinator-rollback-skips-late-registered-collections`; the claim that this
  change does not make it worse holds.
- **`restorePending` does not restore `context`** — real asymmetry, but not a defect:
  `context` exists to pin a read view (`ReadViewOptions.pinContext`) and no caller expects
  it restored; `Tree.restore` has the same shape. The coordinator now pays a small unused
  `structuredClone` of the action context per collection per transaction. Too small to
  warrant a code comment; recorded here as checked and dismissed rather than parked.
- **No test drives `TransactionSession.rollback`** — verified it is a pure delegate
  (`session.ts:193`) with no state of its own beyond flags, so the direct-coordinator tests
  cover the behaviour. Acceptable.
- **White-box `getPendingActions` spy** — the coupling is real, but it is guarded (the spy
  must fire at least once) and independently backed by a `selectLog()` assertion on the
  durable log. Left as is.
- **`snapshotPending` shallow-copies the pending array** — verified sound, not just
  asserted: every assignment to `Collection.pending` was read (lines 445, 511, 573, 632,
  642, 720, 1019) and all are push/slice/reassign; no code mutates a queued `Action` in
  place. The implementer is right that deep-cloning here would be a behaviour change to the
  commit path, not a cleanup.

## Tripwires

None recorded. The two conditional concerns considered — the unused `context` clone above,
and `getPendingActions` returning the live array by reference rather than a copy — are both
pre-existing, sub-noise in cost, and would have added comment weight at sites that already
carry three substantial `NOTE:` blocks. The one conditional-looking finding that turned out
*not* to be conditional (the stale-snapshot corruption) was filed as a ticket instead,
per the rule that a defect which is definitely wrong the moment a dormant path runs is not
a tripwire.

One `NOTE:` was added, but as a pointer rather than a tripwire: at the commit finalize loop
in `coordinator.ts`, where `this.stampData.delete(transaction.stamp.id)` drops only its own
entry while the reset-and-clear above it is collection-wide. It states the consequence, that
it is unreachable today and why, that it is a latent defect rather than an accepted
tradeoff, and names the ticket file.

## Accepted tradeoffs

The three `NOTE:` blocks the implement pass added or reworded (the `rollback` latch note,
the restore-loop note on discarding untracked actions, and the `applyActions` eager-capture
note) were each read against their sites. All three state what was decided, why, and the
condition to revisit; all three are accurate as written. None was re-litigated.

## Source hygiene

`coordinator.ts` is 1405 lines (`wc -l`), up 6 net from this review's edits — large, but it
was already large and this change did not meaningfully move it; no size ticket is warranted
by this diff. The comment-to-code ratio in the `rollback` restore loop is heavy (roughly
twelve comment lines over a five-line loop) but the content is decision-recording rather
than restatement, which is the right kind of density. The new spec's helpers
(`stage`, `stageMore`, `queuedValues`, `expectNoActionsFromStamp`, `logValues`,
`makeCoordinator`) are short, named for what they mean, and keep each case readable; the
provenance-based general guard is the right shape, since it asserts on the stamp tag rather
than on values and so is inherited by future rollback paths.

## Test coverage

The nine cases cover the happy path, the reproduction, three-way interleaving with a
lower-`order` transaction staging after a higher-`order` snapshot, multi-collection fan-out,
the rollback-then-commit symptom against the durable log, a collection with prior committed
state, the untracked-transaction no-op, the partial-landing no-op, and a rollback stacked on
a failed commit's own restore. The gap the review found (a sibling *committing* between
another transaction's staging and its rollback) is exactly the interaction none of them
reach, and is now specified in the new backlog ticket rather than tested here — a test for
it today would have to assert the corrupt behaviour, which would cement it.

# Follow-on tickets

- `backlog/bug-coordinator-stamp-snapshots-go-stale-when-a-sibling-commits` (new, this review)
- `backlog/bug-coordinator-rollback-skips-late-registered-collections` (open, filed during planning)

Both are symptoms of the coordinator modelling transaction-scoped state on top of
collection-scoped state, as is the defect this ticket fixed. Planning the three together is
likely cheaper than three separate fixes.
