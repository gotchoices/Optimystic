----
description: Reviewed and completed the fix that makes Tracker reads honor a delete-then-reinsert in the same transaction, returning the newly inserted block instead of the stale stored one.
files: packages/db-core/src/transform/tracker.ts, packages/db-core/test/transform.spec.ts
----

## Summary

`Tracker.tryGet` was reordered to check `transforms.inserts` first, then `transforms.deletes`, then fall through to `source` (with `transforms.updates` applied). Previously inserts were only consulted on a source miss, so a source block shadowed any pending insert — breaking delete-then-reinsert within one transaction. The fix is a straight reorder with no new logic. Tests pass; two coverage tests added in review.

## Review findings

### What was checked

- **Diff read first, fresh eyes** — `tracker.ts:14-27` reorder and both test edits.
- **Semantic precedence vs the canonical apply path** — cross-checked `tryGet` ordering against `struct.ts` (documented order: insert → update → delete) and `helpers.ts:132 applyTransform` (the commit-time truth).
- **All five reviewer use cases** — insert-shadows-source, delete-then-reinsert, plain-delete, update-on-source, insert-then-update.
- **Edge/malformed states** — insert+delete coexistence (phantom-delete bug), update-then-insert stale `updates[id]`.
- **Cleanup / type safety** — `structuredClone` on the insert path prevents caller mutation of stored inserts; no resource handles involved. `tsc --noEmit` clean apart from a pre-existing `tsconfig.json` deprecation (TS5101, line 19 — outside this diff).
- **Tests + build** — `npm test` in `packages/db-core`: **1105 passing**, 0 failing. Lint is a repo-wide no-op (`"lint": "echo ..."`).

### Findings and disposition

- **Core fix — correct.** For well-formed transforms an id is never in both `inserts` and `deletes` (each of `insert()`/`delete()` clears the other), so the reorder gives the right answer for every normal sequence. Delete-then-reinsert now returns the reinserted block; reinsert-then-delete still returns `undefined`. Confirmed by the flipped precedence test and the new reinsert test.

- **Minor (fixed inline) — thin test coverage of the reordered branches.** The implementer's two tests covered only use cases 1 and 2. Added two tests: plain-delete shadows a source block (`tryGet` → `undefined`, exercises the new delete-before-source branch), and insert-then-update reflects the update via in-place baking (asserts `transforms.updates[id]` stays empty and the op surfaces). 1103 → 1105 passing.

- **Tripwire (recorded, not a ticket) — `tryGet` read-view diverges from `applyTransform` commit-view in two malformed states.** (1) When an id is in both `inserts` and `deletes`, `tryGet` returns the insert but commit deletes (delete-last-wins per `struct.ts`). This state is only reachable via the separately-tracked phantom-delete bug (double-delete then reinsert leaves a stale delete). (2) update-then-insert on the same source id leaves a stale `updates[id]`; `tryGet` ignores it (arguably more correct, since insert replaces the block) but commit re-applies it. Both are conditional on malformed input that well-formed usage never produces, so they are knowledge, not queued work. Parked as a `NOTE:` comment at the `tryGet` site (`tracker.ts:14`) pointing at the real source bug rather than papering over it in the reader. The phantom-delete bug itself is already captured by the existing `"...(BUG: phantom delete)"` test and is out of scope here.

- **Major:** none.
- **Blocked/decision:** none.

### Not flagged as pre-existing

`tsc` emits TS5101 for a deprecated `downlevelIteration` option in `tsconfig.json:19`. It is a config deprecation outside this diff, not a test failure, and the test suite (which uses node type-stripping) is green — so no `.pre-existing-error.md` was written.
