description: A refresh can now spot and log that its own copy of a collection and the stored one are different lineages — two copies counting the same revision numbers but built from different actions — which no existing diagnostic could see. Review the new comparison, its log line, and its tests.
files:
  - packages/db-core/src/collection/collection.ts (advanceContext — the new lineage check; reportShortfall — corrected doc comment)
  - packages/db-core/test/collection.spec.ts (new describe "a refresh whose log names a different action at the held revision", ~line 1505)
  - docs/debugging.md (§ "Did the refresh itself fail to close the gap?" — new `collection:lineage-divergence` line documented)
  - packages/db-core/test/two-handle-collection-fork.spec.ts (untouched negative control — must keep passing)
----

# Review: refresh now reports "my copy and the stored copy disagree"

## What was built

One seam, two arms, exactly as the implement ticket specified.

**Arm 1 — lineage check in `advanceContext`** (collection.ts). At the single point where a
collection adopts a freshly-read committed state, the refresh now compares the action id it
*holds* at its current revision against the action id the freshly-read log *names* at that same
revision. Both come from `ActionContext.committed` lists already in hand — no new read, no
network. A mismatch emits:

```
collection:lineage-divergence id=<collection> rev=<n> held=<actionId> read=<actionId>
```

on the `optimystic:db-core:collection` debug namespace. It **logs and does not throw** (same
rationale as the existing shortfall line: `update()` runs blanket-style over all registered
collections between commit retries), and adoption then proceeds unchanged. The two `find`s are
gated on `log.enabled` and look up the entry at ONE revision (the current one), per the ticket's
design note — no O(n·m) list diff on the refresh path.

**Arm 2 — `reportShortfall` doc corrected.** Its comment now states plainly that it detects
lag only — both its numbers come from one chain, so a forked replica (internally
self-consistent) keeps it silent forever — and cross-references the new line. `docs/debugging.md`
got a matching section: line format, field meanings, and three reading caveats.

## Semantics reviewers should challenge

- **Per-discovery, not per-refresh.** After the line fires, `advanceContext` adopts the log's
  context as it always has (equal revisions adopt `next`), so the held lineage marker then
  matches the log and later refreshes of that instance stay silent — even though block content
  materialized under the old lineage may still sit in the instance's caches. This is a deliberate
  consequence of "log, don't change behaviour": suppressing adoption would have changed the
  refresh's production behaviour. It is weaker than the shortfall line's per-call reporting (the
  originating field case was read by watching a line *keep coming*). Documented in the code
  comment, the docs, and pinned by a test. If review judges an operator needs repetition, the
  alternative — remembering the divergence on the instance and re-logging per refresh — is a
  scope call worth a explicit ticket, not a silent tweak.
- **Detection is debug-gated.** Behind `log.enabled` — when the namespace is off the comparison
  doesn't run at all. Defensible (the line would go nowhere anyway, and this matches
  `committedActionId`'s documented convention), but it means no counter/metric hook exists.
- **Silence has holes, stated not fixed:** no entry at the held revision on either side
  (invented collection, checkpoint or invalidation occupying that log slot) → no comparison,
  no line. Cross-node action-id comparison per docs/debugging.md remains ground truth.
- **False-positive audit done, worth re-checking:** every writer of the held context stamps the
  same id the log entry carries — `syncInternal`'s inline bump uses the `actionId` it passed to
  `addActions`; session mode's `recordCommitted(transaction.id)` matches the coordinator's
  `addActions(..., transaction.id, ...)`; `bootstrapContext` copies the tail's
  `state.latest.actionId`, written by the same commit as the entry. So one lineage can never
  self-report. The healthy-path tests assert this for the single-node paths; **no test drives the
  session-mode coordinator through the new check** — reviewer may want to confirm by reading
  coordinator.ts:339/384/619/636 against coordinator.ts:693.

## Tests (the floor, not the ceiling)

New describe in collection.spec.ts, modeled on the existing shortfall describe (own copies of the
log-capture helper and a lineage-rewriting `ITransactor` wrapper that rewrites reads of the tail
block — `state.latest.actionId` plus every entry's `action.actionId` — while armed, so a handle
opened through it holds the stored revision under a fake lineage marker; disarm, refresh, and
held ≠ read at the same revision):

- ordinary refresh of a current collection → **no** divergence line (the noise assertion —
  matters most);
- lagging same-lineage reader catching up past its held revision → **no** line (exercises the
  next.rev > current.rev overlap);
- diverged handle refresh → exactly one line; parses `id=`, `rev=`, `held=` (the fake id),
  `read=` (the stored id); `update()` returns normally; the shortfall line stays silent on the
  fork (proving the two diagnostics separate); collection still serves reads;
- three refreshes of a diverged handle → exactly one line (pins the per-discovery semantic).

`two-handle-collection-fork.spec.ts` untouched, still passing.

## Validation

`yarn workspace @optimystic/db-core test` — **1435 passing, 0 failing** (was 1431 before this
ticket; the 4 new tests account for the delta). No pre-existing failures observed. Log at
`tickets/.logs/1-make-a-refresh-able-to-say-the-two-copies-disagree.test.log`.

## Known gaps / out of scope (per the implement ticket)

- This is an **instrument, not a fix**: nothing merges a fork, and the downstream `sereus`
  reproducer that motivated the work is still switched off
  (`tickets/blocked/secondary-index-repro-exhausted-upstream.md` remains open — no seventh
  reproduction attempted).
- Commit-mode wiring (`commitDirtyTreesLegacy`, session-mode enablement) untouched;
  `tickets/backlog/feat-optimystic-legacy-commit-two-phase.md` owns that seam.
- Divergence does not throw; promoting it to a hard failure is a follow-on decision after a real
  firing.
- The check runs in `attachToLog` (open) as well as `updateInternal` (refresh) since both call
  `advanceContext` — at open both sides come from the same chain, so it cannot fire there
  (asserted indirectly by every open in the suite running with the namespace sometimes enabled);
  no dedicated open-path test.
