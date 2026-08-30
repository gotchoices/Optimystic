description: The transaction commit path can interleave with a concurrent collection refresh, letting a machine record its write at a revision number storage gave to someone else. Fix by carrying one revision number end-to-end through the commit and by making the commit hold the collection's lock for its whole span.
files:
  - packages/db-core/src/transaction/coordinator.ts (commitOnce, execute, applyActionsToCollection, pendCollection, pendPhase, commitCollection, commitPhase, coordinateTransaction)
  - packages/db-core/src/collection/collection.ts (latchId at :84,97; recordCommitted at :619; snapshotPending; the four latch holders at :287,316,630,753)
  - packages/db-core/test/coordinator.spec.ts (fakeCollections at :137-151; direct pendPhase/commitPhase calls need new signatures)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts:2944-2952 (concurrency audit comment to correct) and :2977 (fold-loop-has-no-await claim to preserve)
  - packages/db-core/src/testing/test-transactor.ts (CompetingWriterTransactor — the deadlock hazard that forces the latch-key decision)
difficulty: hard
repro: static
----

# Core fix: thread the pended revision + hold collection latches across the commit span

Continuation of `2-coordinator-mutates-collections-outside-their-latch` (Parts B and C of that
ticket), split out after a budget stop. **Investigation is complete; the design below is settled —
implement it.** Two sibling tickets carry the repro spec and the diagnostics work
(`2.2-coordinator-interleaving-spec`, `2.4-collection-divergence-report-fields`).

## Background (condensed from the original ticket)

A downstream two-machine deployment permanently disagrees about a shared secondary index. The
diagnostic lines `collection:lineage-divergence` (rev 1 and 2, different action ids) and
`collection:context-not-lowered held=4 read=3` fired on the index collection only. Mechanism, read
from code (still unobserved — the sibling spec ticket settles that): `TransactionCoordinator` never
takes the per-collection latch, yet its commit path reads and writes the same state the latch
protects. `pendCollection` pends at `getNextRev()`; the success loop calls
`collection.recordCommitted(transaction.id)` which **recomputes** `getNextRev()` after the network
round trips. If a reader-driven `collection.update()` adopted the newly committed revision in
between, the collection appends its own action at `held+1` — a revision storage never assigned —
and its held revision runs ahead of storage forever (`advanceContext` is one-way). The index
collection forks because every index seek/range-scan refreshes it
(`index-manager.ts:383,444`).

## Settled design decisions (do not re-derive)

**1. One revision number, captured once, threaded end-to-end.**
`applyActionsToCollection` already computes `newRev = collection.getNextRev()` and stamps the log
entry with it (`log.addActions(..., newRev, ...)`). That is the single legitimate capture point —
the log entry, the pend, the commit, and the local record must all name the same number. Thread it:

- `applyActionsToCollection` returns `rev` in its result object.
- `commitOnce` and `execute` collect `pendedRevs: Map<CollectionId, number>` from the apply loop.
- `coordinateTransaction` gains a `pendedRevs` parameter, passes it to `pendPhase` and
  `commitPhase`.
- `pendCollection` takes `rev` as a parameter instead of calling `collection.getNextRev()`
  (coordinator.ts:930).
- `commitCollection` takes `rev` instead of recomputing `getNextRev()` (coordinator.ts:1038) —
  **this is the same bug family**: the `CommitRequest.rev` is recomputed after the pend round trip
  today. Thread it too.
- All four `recordCommitted` call sites get the pended rev: commitOnce's success loop (:384),
  commitOnce's partial-commit loop (:339), execute's failure path (:619), execute's success path
  (:636). The partial-commit paths need `pendedRevs`, so `coordinateTransaction` must have it in
  scope at every return (it is a parameter, so it is).

**2. `Collection.recordCommitted(actionId: ActionId, rev: number): number` — throw on mismatch.**
```ts
recordCommitted(actionId: ActionId, rev: number): number {
    const expected = this.getNextRev();
    if (rev !== expected) {
        throw new Error(`Collection ${this.id}: action ${actionId} was pended at rev ${rev} ` +
            `but the collection now expects rev ${expected} — the collection was refreshed mid-commit`);
    }
    ...append {actionId, rev}, advance rev, as today...
}
```
Under decision 3 the mismatch cannot happen in `commitOnce`; the throw is the tripwire for any
path that still bypasses the latch. Update the doc comment on `recordCommitted` and keep the
mirror-note pointing at the inline bump in `syncInternal` (collection.ts:745-747; the inline bump
itself needs no change — it computes and uses `newRev` in one latched span already).

**3. Instance-scope the collection latch key, then hold it across the whole `commitOnce` span.**
This is the one place implementation must deviate from the original ticket's letter, and the reason
is a verified deadlock, not taste:

- `Collection.latchId` is `Collection:${id}` (collection.ts:97) — **process-global per collection
  id**, shared by every Collection instance over that id in one process.
- `Latches` is a plain FIFO promise-chain mutex, **not reentrant** (stated at
  db-p2p/src/storage/block-latch.ts:25).
- The real-rival tests (transaction.spec.ts:4465-4830) run a second Collection/Tree instance over
  the SAME collection id from **inside** the loser's `transactor.pend` call
  (`CompetingWriterTransactor` fires the rival before delegating). If `commitOnce` held
  `Collection:<id>` across `pendPhase`, the rival's `act`/`updateAndSync` would wait on the very
  latch the parked pend holds → deadlock. The two-node sweep in `quereus-plugin-optimystic` shares
  collection ids across in-process nodes the same way.

Fix: make the key per-instance — `Collection:${id}#${instanceTag}` — where `instanceTag` is a new
short random tag on each Collection instance (4 random bytes as base64url, ~6 chars; generate with
the already-imported `randomBytes` + `uint8ArrayToString(bytes, 'base64url')`; same shape as
`randomNodeTag()` at quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:41).
Expose the tag (e.g. `readonly instanceTag`) — the diagnostics ticket
(`2.4-collection-divergence-report-fields`) prints it, and `attachToLog` runs before construction,
so generate the tag in `open`/`createOrOpen` and pass it to both `attachToLog` and the constructor
(or make it an optional trailing constructor arg defaulted from a static helper — the diagnostics
ticket needs it pre-construction either way).

Why instance-scoping is sound: the latch protects **per-instance** state only (tracker, pending
queue, source.actionContext — nothing is shared between two instances of one id); cross-instance
races go through the transactor's optimistic concurrency, which is the design. Cross-instance
serialization via the shared key was accidental. The audit comment's claim ("a live scan's
`collection.update()` serializes behind the collection's own per-collection latch",
optimystic-module.ts:2949) concerns one connected table = one instance, which instance-scoped keys
still satisfy. Document this rationale at the `latchId` assignment.

Then in `commitOnce`: acquire every participating collection's latch **in sorted collection-id
order** at the top (before `snapshotPending`), release all in a `finally`. Document at the
acquisition site that the ordering mirrors `StorageRepo.commit`'s sorted block-id latch discipline
(db-p2p/src/storage/block-latch.ts:64-65). Verified safe inside the span: `Log.open`/`addActions`
take no latch; the transactor never touches Collection instances (`TestTransactor` uses
`TestTransactor.commit:<blockId>` keys — distinct); `recordCommitted`/`applyCommittedToCache`/
`tracker.reset`/`clearPendingActions` take no latch. The retry loop's blanket
`collection.update()` (coordinator.ts:200-202) is **outside** `commitOnce` — it stays outside the
held span, which is required since `Latches` is non-reentrant. The existing real-rival retry tests
exercise exactly that commit-then-retry path and serve as the non-reentrancy regression test the
original ticket demanded — say so in the handoff.

Preserve the invariant claimed at optimystic-module.ts:2977: the success-path fold loop in
`commitOnce` (:383-388) has **no await** — keep it that way (latch acquisition happens before the
loop, release after; do not put an `await` inside the fold).

**4. `execute()` gets the same treatment.** It has the identical seam (recordCommitted at :619 and
:636 recompute). Thread `pendedRevs` there (required by the signature change). Also acquire the
same sorted latches around its span — but only **after** `applyActions` (which calls
`collection.act`, which takes the instance latch itself; latching earlier deadlocks). The
side-effect-engine path returns empty actions and short-circuits before the loop, so the latched
span only covers the pure-translator path. Release in `finally` — execute has early failure
returns.

**5. Outcome B (tracker rewritten under a parked pend) is closed by decision 3.** For the record:
`Tracker.reset()` (tracker.ts:163-168) **replaces** the `transforms` object rather than mutating
it, so the coordinator's captured reference stays stable — the pended bytes were never torn, but
the collection's staged state could silently diverge from what was pended. With the latch held,
`replayActions` cannot run mid-flight at all.

## TODO

- Change `recordCommitted` signature + throw; update its doc comment.
- Add `instanceTag` and instance-scope `latchId`, with the rationale comment.
- Thread `rev` per decision 1 (applyActionsToCollection → commitOnce/execute →
  coordinateTransaction → pendPhase/pendCollection → commitPhase/commitCollection →
  recordCommitted).
- Latch acquisition in `commitOnce` (top, sorted, finally-released) and `execute` (post-apply
  span), with the ordering-discipline comment.
- Correct the audit comment at optimystic-module.ts:2944-2952: the serialization claim now holds
  because the coordinator takes the same instance latch for the whole commit span.
- Update coordinator.spec.ts phase tests: `fakeCollections` (:137-151) and every direct
  `pendPhase`/`commitPhase` invocation must pass the new revs argument (`getNextRev` on the fakes
  becomes unused by pendCollection — harmless).
- Sweep other direct `recordCommitted` callers/tests (grep `recordCommitted(` across packages) and
  update signatures.
- `yarn build && yarn typecheck && yarn test` from root; the two-node sweep in
  `quereus-plugin-optimystic` is part of `yarn test` and must stay green. Watch specifically for
  hangs in transaction.spec.ts's "real competing writer" describe block — a hang there means the
  latch-key scoping was not applied or a new acquire slipped inside the held span.
