description: Cancelling a transaction currently runs an elaborate rewind-and-replay routine designed to protect other transactions that were open at the same time. Since the system no longer allows two open at once, delete that routine and replace it with the simple rewind it now always reduces to.
prereq: bug-coordinator-refuses-concurrent-stamps
files:
  - packages/db-core/src/transaction/coordinator.ts (`CollectionCapture` ~49; `stampData` decl ~63-92; `applyActions` ~109-125; `captureUncaptured` ~127-161; `applyActionsRaw` ~168-180; `rollback` ~552-632)
  - packages/db-core/src/transaction/session.ts (~176-196 — `rollback`'s doc claim that it "replays any later sessions' actions")
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (~770-782 — `rollbackTransaction`'s "replays any interleaved sessions" / "against a multi-session coordinator" comment)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (surviving single-stamp cases must stay green)
difficulty: medium
----

# Why this exists

`bug-coordinator-refuses-concurrent-stamps` establishes the invariant
**`stampData.size <= 1` at all times** — a second stamp is refused at
`applyActions`, `commit`, and `execute`. Everything in `TransactionCoordinator`
that exists to reconcile *sibling* stamps is therefore unreachable, and it is
the subtlest code in the file: the per-collection earliest-capture walk, the
survivor replay loop, and the snapshot rebuild inside that loop have between
them produced three separate bug tickets.

Unreachable-but-subtle is worse than absent. Delete it, and let `rollback`
say plainly what it now always does: restore each captured snapshot.

This ticket is pure simplification. **No behaviour change is intended** — if
any surviving test needs its assertions altered to pass, that is a signal the
removal went too far, not licence to loosen the test.

# What goes

## `CollectionCapture` (~49)

The `seq` rank exists only to order captures *across* stamps. With one stamp
there is nothing to rank. Collapse the type to the snapshot itself, so the
per-stamp map becomes `Map<Collection<any>, CollectionSnapshot<any>>`.

## `stampData` and its counters (~63-92)

- `order` — documented as "replay ordering ONLY", and there is nothing left to
  order. Drop the field and `nextStampOrder`.
- `nextCaptureSeq` — drop with `seq`.
- `actionBatches` — accumulated solely so `rollback` could replay survivors
  (grep confirms `coordinator.ts:122` writes it and `coordinator.ts:627` is the
  only reader). Drop the field and the `data.actionBatches.push(actions)` in
  `applyActions`.

The remaining entry is just the pre-staging snapshot map. Rewrite the field's
doc comment accordingly, **keeping** the two constraints that are still
load-bearing and were each the subject of a landed fix:

- the snapshot holds **both** halves of a collection's staged state (tracker
  transforms *and* the pending action queue) as one `Collection.snapshotPending`
  value — restoring only the transforms leaves a rolled-back stamp's actions
  queued;
- the map is keyed by the `Collection` **instance**, not by `CollectionId`,
  because the caller's registry may replace the instance stored under an id.

## `rollback` (~552-632)

Reduces to: look up the entry; return if absent; delete it; restore each
captured snapshot through its captured instance. Everything else goes —
`toReplay`, `earliest`/`foldEarliest`, the replay loop, and the
`captureUncaptured(rebuilt)` snapshot rebuild inside it.

Keep these comments, updated to the new shape rather than deleted:

- the latch-free/no-concurrent-commit caveat at the top of the method;
- the note that restoring also discards actions staged **outside** any tracked
  stamp (the `Tree.stage` / deferred-DML path) that landed after that
  collection's capture — an accepted, deliberate asymmetry, not an oversight.

## `captureUncaptured` (~127-161)

Survives unchanged in purpose — it still reconciles collections registered
mid-transaction, which is a single-stamp concern (`bug-coordinator-rollback-skips-late-registered-collections`).
Only its signature changes with `CollectionCapture`, and its doc loses the
cross-stamp `seq` paragraph. Its `NOTE:` about per-call cost stays.

## Stale prose elsewhere

- `session.ts` `rollback` doc (~176-196): "replays any later sessions' actions
  to preserve their staged state" is no longer true.
- `txn-bridge.ts` `rollbackTransaction` (~770-782): "already restored every
  registered collection's tracker to the pre-session snapshot (and replays any
  interleaved sessions)" and "against a multi-session coordinator, would clobber
  that careful replay". The *conclusion* — session mode must not double-restore
  per tree — still holds; only the justification changes. Rewrite, don't delete.

# Edge cases & interactions

- **`applyActionsRaw` keeps tagging.** It is now called only from `applyActions`,
  but `Action.transaction` is still the provenance ground truth that
  `coordinator-rollback-pending.spec.ts`'s `expectNoActionsFromStamp` helper
  asserts on. Keep the tagging and keep the method; do not inline it away.
- **Untracked stamp rollback** stays a no-op (`coordinator-rollback-pending.spec.ts`
  ~339).
- **Rollback after a partial landing** stays a no-op, because the partial-commit
  branch already deleted the entry (~353).
- **Rollback after a failed commit** must still rewind cleanly — the failed
  commit restored its own pre-append snapshot, and the stamp's capture predates
  that (~382).
- **Late-registered collections** must still be rewound: `captureUncaptured` runs
  on every `applyActions`, so a collection registered mid-transaction is in the
  map and gets restored (~405, ~480, ~500, ~549).
- **Second rollback of the same stamp** is a no-op after the first deleted the
  entry. The old machinery had a *survivor* second-rollback case (~522, removed
  by the prereq ticket); do not reintroduce anything for it.
- **Two coordinators over one collection set** (`coordinator-latch-span.spec.ts`
  ~438) is unaffected — the removed code was never what made that work.
- **A never-synced collection stays readable** after rollback: `restorePending`
  restores the snapshot rather than clearing the tracker, so the header/root
  blocks that live uncommitted in the tracker survive (~549).

# TODO

- Collapse `CollectionCapture` to the bare snapshot; update the `stampData` map type.
- Drop `order`, `nextStampOrder`, `nextCaptureSeq`, and `actionBatches` (field, the
  push in `applyActions`, and the replay read).
- Rewrite `rollback` to "delete the entry, restore each captured snapshot",
  preserving the latch caveat and the untracked-staging note.
- Rewrite the `stampData` doc comment, keeping the both-halves and
  instance-keyed constraints.
- Update `captureUncaptured`'s signature and doc.
- Fix the stale prose in `session.ts` and `txn-bridge.ts`.
- Build and run the db-core suite in the foreground; every surviving
  `coordinator-rollback-pending.spec.ts` case must pass **without assertion
  changes**.
