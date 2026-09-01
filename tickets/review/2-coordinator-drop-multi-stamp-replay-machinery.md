description: Cancelling a transaction used to run an elaborate rewind-and-replay routine that protected other transactions open at the same time. Since the system no longer allows two open at once, that routine was deleted and replaced with the plain rewind it always reduced to.
files:
  - packages/db-core/src/transaction/coordinator.ts (`stampData` decl ~57-95; `applyActions` ~103-140; `captureUncaptured` ~150-183; `applyActionsRaw` ~185-210; `rollback` ~570-620; `execute` prose ~788, ~902, ~917)
  - packages/db-core/src/transaction/session.ts (~176-198 — `rollback` doc)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (~287 savepoint doc; ~770-786 `rollbackTransaction` comment)
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (untouched; all cases green)
difficulty: medium
----

# What landed

Pure deletion + comment rewrite. **No test file was touched**; no assertion was
changed or loosened. Net `-104 / +61` lines across three source files.

## `coordinator.ts`

- **`CollectionCapture` type deleted.** It wrapped a snapshot with a `seq` rank
  whose only purpose was ordering captures *across* sibling stamps. Per-stamp map
  is now `Map<Collection<any>, CollectionSnapshot<any>>` — the snapshot directly.
- **`stampData` value collapsed** from `{ order, preSnapshot, actionBatches }` to
  `{ preSnapshot }`. `nextStampOrder` and `nextCaptureSeq` fields deleted.
  `data.actionBatches.push(actions)` removed from `applyActions`.
- **`rollback` reduced to five statements**: look up the entry, return if absent,
  delete it, restore each captured snapshot through its captured instance.
  Gone: `toReplay`, `earliest`, `foldEarliest`, the survivor replay loop, and the
  `captureUncaptured(rebuilt)` snapshot rebuild inside it.
- **`captureUncaptured`** keeps its purpose and its `NOTE:` about per-call cost;
  only the parameter type changed.
- **`applyActionsRaw`** kept, including the `transaction: stampId` tagging. Its doc
  now states *why* it stays a separate method (the tag is the provenance the
  rollback tests assert on) rather than the now-false "used ... for replay during
  rollback".
- **`openStampOtherThan` untouched**, including its single-key early return.

Comments preserved and updated rather than deleted: the latch-free caveat at the
top of `rollback`, the note that restoring also discards actions staged outside
any tracked stamp (`Tree.stage` / deferred-DML), the both-halves snapshot
constraint, and the instance-keyed constraint.

## Stale prose fixed beyond the ticket's list

The ticket named two external sites; a `grep -rni replay` over the three files
found three more inside `coordinator.ts` that asserted the same dead premise:

- `~788` (`execute`'s disposition table): "rollback(stampId) ... also replays the
  other in-flight stamps, which a targeted restore cannot" → now says rollback is
  complete because its capture predates the staging and covers every registered
  collection.
- `~902` (`execute`'s partial-landing branch): "any OTHER stamp's actions staged
  on it ... It cannot be softened by replaying the other stamps here" → the
  discarded writer can no longer be a sibling stamp, only the untracked
  `Tree.stage` / `Collection.act` path. Conclusion unchanged.
- `~917`: "no sibling stamp exists whose later rollback could rebuild a replay set
  missing this entry" → simplified to the same conclusion without the replay-set
  premise.
- `txn-bridge.ts ~287`: "the coordinator's own snapshot replay" → "restore".

## `txn-bridge.ts` `rollbackTransaction` — justification rewritten, not deleted

The conclusion (session mode must NOT do a second per-tree restore) still holds.
The old justification was "it would clobber that careful replay against a
multi-session coordinator". **Reviewer: check my replacement claim, it is the one
judgement call in this diff.** I first wrote that `tree.restore()` rewinds only
the tracker half — that is *false* (`Tree.restore` → `Collection.restorePending`,
both halves), and I corrected it before committing. What I actually wrote is:

> markDirty snapshots a tree at its own first stage, which on this path always
> follows the coordinator's capture (optimystic-module.ts staging is gated behind
> an awaited applyActions). Replaying that later, dirtier snapshot over the
> already-rewound collection would re-install staged state the coordinator just
> discarded.

The ordering claim rests on the `optimystic-module.ts` "applyActions before any
`collection.stage`" invariant, which `captureUncaptured`'s own doc already cites.
I did **not** construct a test that exercises the double-restore path (it is
`if (!this.session)`-guarded and therefore unreachable in session mode), so the
claim is reasoned from the code, not observed. If a reviewer disagrees, the safe
fallback is the weaker "redundant at best" half of the sentence alone.

# Validation

All foreground, all from the repo root.

| Command | Result |
| --- | --- |
| `yarn workspace @optimystic/db-core typecheck` | exit 0 |
| `yarn workspace @optimystic/db-core build` | exit 0 |
| `yarn workspace @optimystic/db-core test` | **1594 passing**, 0 failing |
| `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` | exit 0 |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` | **699 passing, 13 pending**, 0 failing; smoke ok |
| `npx eslint <the 3 touched files>` | exit 0 |
| `yarn lint:docs` | 45 documents, 71 anchored citations — all resolve |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

# What a reviewer should re-check

The ticket enumerated the rollback cases that must keep working. All are covered
by `coordinator-rollback-pending.spec.ts`, which passes unmodified — but the
suite passing is the floor, not proof the removal was scoped right. Worth a
second pair of eyes:

- **The removal is total.** `grep -n "CollectionCapture\|actionBatches\|nextCaptureSeq\|nextStampOrder\|toReplay\|foldEarliest" packages/db-core/src/transaction/coordinator.ts` returns nothing. Confirm no other package reached into those (they were all `private`, so this should hold, but the grep is cheap).
- **`rollback` is now `async` with no `await` in the body.** Kept async
  deliberately — it is a public method every caller awaits, and narrowing it to
  sync would be a breaking signature change outside this ticket's scope. ESLint
  does not flag it here. Confirm that reading is right rather than an oversight.
- **`stampData`'s value is now a one-field wrapper** `{ preSnapshot }`. I left the
  wrapper rather than collapsing to `Map<string, Map<Collection, Snapshot>>`,
  because the ~35-line class doc refers to `preSnapshot` by name throughout and
  the wrapper costs nothing. A reviewer who prefers the flatter type should say
  so; it is a mechanical follow-up, not a correctness question.
- **The three `execute`-path comment rewrites** (~788, ~902, ~917) were not in the
  ticket's scope list. They are comment-only, but they now make *positive* claims
  about what can and cannot write to a collection mid-span. Verify those claims
  against the actual guard set rather than taking them from me.
- **Untracked-stamp asymmetry.** `rollback` on a stamp with no entry stays a no-op,
  and the accepted asymmetry about actions staged outside any tracked stamp is
  unchanged — same words, minus the "earliest" qualifier that no longer means
  anything. Worth confirming the surviving sentence still reads correctly now that
  there is exactly one capture per collection rather than a per-collection minimum.

# Known gaps

- **No new test was added.** This ticket is a deletion of code that the prereq's
  guards made unreachable; there is no new behaviour to cover, and the ticket
  explicitly forbade changing existing assertions. The consequence is that
  nothing in the suite would catch it if the removal *did* change behaviour on a
  path the suite does not exercise. The un-exercised paths I am aware of are the
  `txn-bridge` double-restore branch discussed above and the `execute`
  partial-landing branch at `~902` (comment-only change there).
- **The plugin suite's 13 pending tests** were pending before this change; I did
  not investigate them.
- **No integration run.** `yarn test:integration` was not run — it is out of the
  agent-runnable wall-clock budget. Comment-and-deletion-only diffs make an
  integration regression unlikely, but that is an argument, not a result.
