description: Cancelling a transaction used to run an elaborate rewind-and-replay routine that protected other transactions open at the same time. Since the system no longer allows two open at once, that routine was deleted and replaced with the plain rewind it always reduced to.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transaction/session.ts
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
  - packages/db-core/test/coordinator-rollback-pending.spec.ts (unchanged; all cases green)
----

# What landed

Pure deletion plus comment rewrites; no test file was touched and no assertion was changed or
loosened. Implement commit `26718f8a`, review commits `3e04a540` (partial, from an interrupted run)
and this one.

## `coordinator.ts`

- **`CollectionCapture` deleted.** It wrapped a snapshot with a `seq` rank whose only purpose was
  ordering captures *across* sibling transactions. The per-transaction map now holds the snapshot
  directly: `Map<Collection<any>, CollectionSnapshot<any>>`.
- **`stampData`'s value collapsed** from `{ order, preSnapshot, actionBatches }` to `{ preSnapshot }`;
  `nextStampOrder` and `nextCaptureSeq` deleted, and `applyActions` no longer accumulates action
  batches.
- **`rollback` reduced to five statements**: look up the entry, return if absent, delete it, restore
  each captured snapshot through its captured instance. Gone: `toReplay`, `earliest`, `foldEarliest`,
  the survivor replay loop, and the snapshot rebuild inside it.
- **`captureUncaptured`** keeps its purpose and its per-call-cost `NOTE:`; only the parameter type
  changed. **`applyActionsRaw`** and **`openStampOtherThan`** kept.
- Stale prose fixed in `execute`'s three comment blocks (the failure-disposition table, the
  partial-landing blind-overwrite note, the undo-handle drop) which all asserted the dead
  sibling-replay premise.

## `session.ts`, `txn-bridge.ts`

Comment-only. `session.rollback`'s doc now says the restore is coordinator-wide and safe because at
most one transaction is open. `txn-bridge.ts` drops "snapshot replay" wording and rewrites the
justification for skipping the second per-tree restore in session mode.

# Review findings

Reviewed the implement diff (`git show 26718f8a`) with fresh eyes before reading the handoff, then
the current state of all three files, the rollback spec, and `docs/transactions.md`.

## Fixed in this pass (minor)

Three comment-accuracy fixes, all applied and committed as `3e04a540`:

- **`applyActionsRaw`'s doc overstated its own necessity.** It read as if the method could not be
  inlined; the real reason it stays split is readability, while the `transaction: stampId` tag it
  applies is the contract. Reworded to say exactly that.
- **`txn-bridge.ts` `rollbackTransaction` made an over-strong claim.** The implementer flagged this as
  the one judgement call in the diff, and it did not survive. The original text asserted the two
  baselines *always* diverge with markDirty's being dirtier. In the ordinary case they **coincide** —
  markDirty snapshots a tree before its first stage, and the coordinator's `applyActions` capture
  lands at or before that same point (`optimystic-module.ts` stages only after an awaited
  `applyActions`). Rewritten to the accurate weaker form: redundant in the usual case, and where the
  two can diverge markDirty's is never the earlier, so restoring it could only re-install discarded
  state. Same conclusion (skip the second restore), sound justification. Verified against
  `markDirty`'s own doc (`txn-bridge.ts:230`) and the module's staging order.
- **`rollback` had no marker tying its simplicity to the invariant that permits it.** Added a `NOTE:`
  at the method doc stating that the plain rewind is complete only while at most one transaction may
  be open, and naming commit `26718f8a` as where to recover the per-collection-earliest-capture plus
  survivor-replay machinery if that guard is ever relaxed — rather than have someone re-derive it.

## Checked and clean

- **Removal is total.** `grep -rn "CollectionCapture\|actionBatches\|nextCaptureSeq\|nextStampOrder\|toReplay\|foldEarliest" packages/ --include=*.ts` returns nothing (exit 1). No other package reached into the deleted members.
- **The three rewritten `execute` comments** were re-derived from the code rather than accepted from
  the handoff. The failure-disposition claim ("rollback's capture predates this staging and covers
  every registered collection") holds: `execute` reaches the log-append only through `applyActions`,
  which runs `captureUncaptured` over the whole live collection map first. The partial-landing claim
  ("no sibling transaction can be that writer") holds within one coordinator, and the two documented
  out-of-scope writers — a second coordinator over the same instances, and the untracked
  `Tree.stage` / `Collection.act` path — are the ones the comment names.
- **`rollback` staying `async` with no `await`** is right, not an oversight. It is public API that
  every caller awaits; narrowing it to synchronous would be a breaking signature change out of scope
  here. ESLint agrees (clean).
- **Test coverage of the surviving behaviour.** `coordinator-rollback-pending.spec.ts` runs 12 cases
  across the happy path, both no-op paths (never-opened, already-released), a partial landing, a
  failed commit that restored its own snapshot, collections registered mid-transaction, idempotent
  re-registration, and a replacement instance under an existing id. The spec's own header already
  records that the retired multi-transaction cases were removed by the earlier guard ticket, so no
  test was left vacuous by this deletion. `coordinator-single-stamp.spec.ts` covers the guard itself.
- **Docs.** Read `docs/transactions.md` in full around the transaction sections and grepped every
  `replay` mention across `docs/`. None describe sibling-transaction replay — the remaining hits are
  a different mechanism entirely (sync-time action replay, validator re-execution, partition
  healing). No doc update was owed; `yarn lint:docs` passes with all 71 anchored citations resolving.
- **No accepted-tradeoff `NOTE:`** at any site this pass touched had a tripped revisit condition.

## Filed as a new ticket (one)

- `backlog/debt-coordinator-holds-one-transaction-in-a-many-transaction-map` — `stampData` is still a
  `Map<string, …>` whose documented invariant is "at most one entry". That many-slot shape is the
  last standing piece of the multi-transaction design this ticket dismantled: the guards that keep it
  to one entry are hand-written and duplicated across three sites, and a future edit inserting a
  second entry would type-check and fail far away. Filed at the representation rung rather than as a
  bug — nothing is broken, and the ticket carries the honest decline argument (the rule is already
  guarded, tested and documented, so this is churn on a file two tickets just stabilised). Site-claim
  grep found no open ticket touching `stampData`.

## Tripwires

None recorded. The two conditional concerns at these sites — `captureUncaptured`'s per-call cost and
`execute`'s unconditional pre-stage snapshot — already carry `NOTE:` tripwires from earlier passes,
both still accurate and neither with a tripped condition. The one conditional concern this pass
raised (rollback's completeness depending on the single-transaction guard) was recorded as the
`NOTE:` on `rollback` described above.

## Not fixed, deliberately

- **`stampData`'s value is a one-field wrapper** `{ preSnapshot }`. Left as is: the field's ~35-line
  doc refers to `preSnapshot` by name throughout, and the wrapper is where the follow-up ticket above
  will put the transaction id. Flattening it now would be undone by that ticket.
- **`coordinator.ts` is 1479 lines** (`wc -l`), down from 1583. Size debt predates this ticket, which
  only reduced it; not filed.

# Known gaps

- **No new test.** This was a deletion of code the guard made unreachable, so there is no new
  behaviour to cover, and the ticket forbade changing existing assertions. The consequence is that
  nothing in the suite would catch a behaviour change on a path the suite does not exercise. The
  un-exercised paths are `txn-bridge`'s double-restore branch (guarded by `if (!this.session)` and
  therefore unreachable in session mode — comment-only change) and `execute`'s partial-landing branch
  (also comment-only). Session-mode bridge coverage is already tracked by
  `backlog/debt-session-mode-bridge-coverage`.
- **The plugin suite's 13 pending tests** were pending before this change and were not investigated.
- **No integration run.** `yarn test:integration` is outside the agent wall-clock budget and was not
  run. Given a comment-and-deletion-only diff an integration regression is unlikely, but that is an
  argument, not a result.

# Validation

All foreground from the repo root, re-run in full after the review edits.

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
