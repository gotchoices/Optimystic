description: The database transaction coordinator now refuses to open a second transaction while one is still open, instead of silently mixing the two transactions' unsaved changes into permanent storage. Reviewed, tested across all dependent packages, and landed.
files:
  - packages/db-core/src/transaction/coordinator.ts (guards in `applyActions`, `commit`, `execute`; helper `openStampOtherThan`; invariant doc on `stampData`)
  - packages/db-core/src/transaction/errors.ts (`CoordinatorConcurrentStampError`)
  - packages/db-core/src/transaction/index.ts (export)
  - packages/db-core/test/coordinator-single-stamp.spec.ts (9 cases — 7 from implement, 2 added in review)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (multi-stamp cases retired)
  - packages/db-core/test/transaction.spec.ts (multi-session tests replaced by a refusal test)
  - docs/transactions.md ("The coordinator refuses a second open transaction stamp")
----

# What landed

`TransactionCoordinator` enforces **at most one open transaction stamp at a
time** (`stampData.size <= 1`, documented as an invariant on the map). A second
stamp is refused with `CoordinatorConcurrentStampError`, carrying `openStampId`
and `rejectedStampId` and a message that states both recoveries (commit or roll
back the open stamp).

Three guards:

- `applyActions` — throws, in the await-free prologue, so the check, the entry
  creation and the pre-stage capture are one atomic step.
- `commit` — throws, once, before the retry loop. This is what catches a caller
  that staged directly (`Tree.stage` / `Collection.act`, which opens no stamp)
  and commits while a sibling stamp is tracked.
- `execute` — returns `{ success: false, error }`, matching that method's local
  convention of reporting failures as results.

Two stale `NOTE:` blocks that named the old hazard (the commit success fold, and
the execute partial-commit delete, which had proposed a tombstone) now state the
enforced invariant instead. The tombstone plan is dead.

Deliberate, documented behaviour: a **clean** commit failure keeps its stamp
entry so `rollback(stampId)` stays a complete recovery — which means an
abandoned failed commit holds the coordinator against new stamps until someone
rolls it back. The error message names that recovery.

Two configurations remain the caller's contract, because the guard only sees
what opens a stamp: two coordinators sharing collection instances, and two
writers that stage only via `Tree.stage` / `Collection.act`.

# Review findings

## Verification the implement stage did not get to

- **`@optimystic/quereus-plugin-optimystic` — the flagged gap — now run and
  green**: 699 passing, 13 pending, smoke test ok. This is the package whose
  adapter sits directly on the narrowed API, so the gap mattered. Traced the
  bridge by hand first and it holds up: one `TransactionSession` per `BEGIN`
  with a stable stamp id (`session.ts` builds its commit transaction from the
  same `this.stamp`), so a normal commit never trips its own guard; the
  clean-failure path calls `rollbackTransaction()`, which drops the entry; the
  partial-commit path relies on the coordinator having dropped it already.
  `coordinator.rollback` deletes the entry *before* any throwing work, so even a
  failing rollback cannot leave the coordinator wedged.
- **`@optimystic/db-p2p`**: 2492 passing, 49 pending.
- **`@optimystic/db-core`**: 1594 passing (1592 from implement + the 2 cases
  added below).
- **`yarn lint`** clean; **`yarn lint:docs`** clean (45 documents, 71 anchored
  citations, 572 file mentions, 307 links all resolve).

## Fixed in this pass (minor)

- **An existing doc comment was orphaned onto the wrong function.** The new
  `openStampOtherThan` helper was inserted *between* `captureUncaptured`'s long
  doc comment and `captureUncaptured` itself, so tooling and readers attached
  the capture-reconcile documentation to the guard helper. Moved the helper
  above that comment.
- **The `execute` guard sat between a comment and the code it documented.** Its
  own comment had been appended to the tail of the pre-stage-snapshot comment
  block, leaving one run-on block with two subjects and the snapshot loop
  separated from its explanation. Moved the guard (with its comment) above that
  block. No behavioural change — it still sits below the empty-actions
  short-circuit.
- **That placement was undocumented, and it is load-bearing.** Sitting below the
  short-circuit is why a read-only transaction may still run alongside an open
  stamp; hoisting the guard to the top of `execute` would refuse those. Stated
  the reason at the site and locked it with a test (below).
- **The `applyActions` comment overstated its atomicity guarantee.** It claimed
  no second stamp can register "between a concurrent commit's guard and its log
  append". True for a *tracked* stamp, whose entry stays in the map for the whole
  commit span — but an *untracked* commit leaves the map empty, so the interlock
  does not exist there. Qualified the comment; the untracked case is the
  already-documented out-of-scope one, not a new hole.
- **The three places that state the contract disagreed** (the review pointer
  asked for this check). The error class doc, the `stampData` invariant, and
  `docs/transactions.md` all named only the two-coordinator gap and omitted the
  stage-only-via-`Tree.stage` gap, which the implement handoff listed as equally
  out of scope. All three now name both, in the same terms.

## Tests added (2)

- **`does not refuse a second stamp that stages nothing`** — locks the `execute`
  guard's deliberate placement below the empty-actions short-circuit. Without
  it, a future reader hoisting the guard "for fail-fast" would silently start
  refusing read-only work alongside an open stamp with nothing failing.
- **`re-commits the same stamp after a clean commit failure`** — the refusal
  message advertises two recoveries, "commit or roll back". The implement spec
  covered only the rollback half; this covers the commit half (a new
  `PendFailsOnce` fixture fails the first pend, then lets the retry through) and
  asserts the action lands exactly once and the stamp is released afterwards.

## Checked and found correct — no change

- **Guard placement against the retry loop.** `commit`'s guard runs once before
  the loop, and the committing stamp's entry survives the whole span, so a
  second `applyActions` during an inter-attempt backoff is refused by
  `applyActions`' own guard. The single check is sufficient.
- **No mutation before refusal.** All three guards precede any staging, snapshot
  or entry creation, so a refused call leaves no partial state.
- **The retired multi-stamp tests.** Every deleted case (survivor replay,
  interleaved cross-stamp batches, the late-registration two-stamp pair, the
  second-rollback case) exercised a configuration that is now refused at the
  second stamp's first `applyActions`. Deleting rather than rewriting them is
  correct. The surviving single-stamp cases and
  `coordinator-latch-span.spec.ts`'s deliberate two-coordinator case all pass.
- **Production callers.** `TransactionCoordinator` is constructed only by the
  Quereus bridge outside tests, and `coordinator.execute()` has no production
  caller at all — the bridge drives `session.execute` / `session.commit`.
- **Documentation citations.** No document or source file referenced the deleted
  test cases by name.

## Filed as a new ticket (1)

- **`backlog/debt-transactions-doc-mixes-reference-with-frozen-design`** —
  reading `docs/transactions.md` end to end (this change touched it) surfaced
  that its second half is design-time material presented as reference, and it has
  drifted: the listing for coordinator rollback still shows a body that clears
  every tracker with a "TODO" about tracking affected collections, which several
  landed fixes ago stopped being true. Filed as one structural item rather than a
  list of corrections, because correcting the listings guarantees the same drift
  again — nothing keeps design-time example code in step with the code. Scoped
  explicitly to exclude the maintained prose at the top, which is correct,
  including this change's new subsection.

## Appended to an existing ticket (1)

- **`implement/2-coordinator-drop-multi-stamp-replay-machinery`** — that ticket
  instructs the next agent to delete everything reconciling sibling stamps.
  `openStampOtherThan` scans `stampData` for a sibling and reads exactly like
  that machinery, but it is the opposite: it is what *enforces* the invariant,
  and all three guards call it. Added an edge-case arm saying to keep it (and to
  keep its single-key early return, per the implement handoff's own pointer).
  No separate ticket — same site, same work.

## Tripwires recorded

None. Nothing in this change was of the "fine now, only matters if X later"
shape: the one conditional-sounding behaviour — the wedge after an abandoned
failed commit — is not conditional. It is reachable today, it is intended, and
it is already stated in the error message, the invariant comment, the error
class doc, `docs/transactions.md`, and a test.

## Considered and left alone

- **`TransactionSession.execute` flattens the typed error into a string**, so the
  bridge cannot distinguish a concurrent-stamp refusal from any other execute
  failure. That is the session's pre-existing return contract
  (`{ success, error?: string }`), no consumer needs the distinction (the bridge
  drives one writer), and changing it is a wider API question than this ticket.
- **`coordinator.ts` is 1516 lines, about 45% comment.** Real size debt, but
  pre-existing — this change added 62 net lines, nearly all comment — and no
  open ticket claims the file for a split. Filing a size ticket off a change
  this small would be noise; `implement/2` is about to remove a substantial
  block from it anyway.
- **The `CoordinatorConcurrentStampError` message is long** (roughly five
  sentences). Deliberate: it is the only place a caller who hits the wedge learns
  how to get out. The class doc carries the reasoning; the message carries the
  recovery.

## Known limitation carried forward, unchanged

The refusal-message assertions in `coordinator-single-stamp.spec.ts` match on
substrings (`/[Cc]ommit or roll back/` and the two stamp ids). The implement
handoff asked whether that is too tight. Judged fine and left as is: the stamp
ids are structured data the error exposes as fields anyway, and the recovery
phrase is the one part of the message that is load-bearing for a caller — a
rewording that drops it should fail a test.

# Validation

| Command | Result |
| --- | --- |
| `yarn workspace @optimystic/db-core build` | clean |
| `yarn workspace @optimystic/quereus-plugin-optimystic build` | clean |
| `yarn workspace @optimystic/db-core test` | 1594 passing, 0 failing |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` | 699 passing, 13 pending, smoke ok |
| `yarn workspace @optimystic/db-p2p test` | 2492 passing, 49 pending |
| `yarn lint` | clean |
| `yarn lint:docs` | clean |

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not
written. `packages/reference-peer`'s known intermittent concurrent-writes case
(tracked as `fix/2-all-lose-conflict-race-wedges-concurrent-first-appends`) was
not exercised — it is outside this diff's reach.
