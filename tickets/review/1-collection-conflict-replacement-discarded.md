<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-03T01:00:52.463Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\1-collection-conflict-replacement-discarded.review.2026-07-03T01-00-52-463Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
----
description: A collection's conflict-merge hook could rewrite a pending change, but the rewrite was thrown away and the un-merged original kept instead — now fixed so the rewrite actually replaces the original and takes effect.
files: packages/db-core/src/collection/collection.ts, packages/db-core/test/collection.spec.ts, packages/db-core/docs/collections.md
----
## Summary

`filterConflict` is the conflict-merge extension point on a `Collection`. For each local pending action that may conflict with a remote one, the hook returns one of: the **same** instance (keep as-is), a **new** instance (apply this replacement instead), or `undefined` (discard). The replacement path was broken two ways:

1. `doFilterConflict` did `this.pending.push(replacement)` onto the array `map()` was iterating, past the range it walked; the mapped result then overwrote `this.pending`, so the pushed replacement was lost.
2. It returned `true` on the replacement path, so the *original* action was also kept — exact opposite of the contract (replace ended up as keep-original + lose-replacement).

There was also a subtler gap: `filterConflict` runs for every pending action against every remote entry, independent of whether the tracker reports a real block conflict. A replacement could happen while `anyConflicts` stayed `false`, so `replayActions()` never ran and the tracker's staged transforms still reflected the **original** action — pending said `merged` but block effects were still `local`.

## What changed (`collection.ts`)

- **`doFilterConflict`** now returns `Action<TAction> | undefined` (the effective action: original / replacement / discard) instead of a boolean. Body reduced to `return this.filterConflict ? this.filterConflict(action, potential) : action;`. Doc comment updated to describe the new return.
- **`updateInternal` map** (per remote entry) now maps each pending action to its effective form and drops `undefined`s in place — so a replacement replaces the original *and* is retained, preserving order:
  ```js
  const before = this.pending;
  const after = before.map(p => this.doFilterConflict(p, entry.actions))
      .filter((a): a is Action<TAction> => a !== undefined);
  const mutated = after.length !== before.length || after.some((a, i) => a !== before[i]);
  this.pending = after;
  this.sourceCache.clear(entry.blockIds);
  anyConflicts = anyConflicts || mutated || this.tracker.conflicts(new Set(entry.blockIds)).length > 0;
  ```
- **`mutated` forces a replay** whenever filtering changed the pending set (replacement or discard), so `replayActions()` re-stages the tracker against the effective actions. This also cleans up the prior discard-orphan wart (a discarded action used to leave an orphan block transform in the tracker because no replay ran).
- **`docs/collections.md`** update-process snippet brought in line with the new map.

## Validation performed

- Full db-core suite, from `packages/db-core/`:
  ```
  node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min
  ```
  → **1068 passing, 0 failing** (was 1067; +1 = the new replacement test).
- `yarn build` (tsc) in `packages/db-core/` → clean, exit 0. Confirms the `doFilterConflict` return-type change type-checks (single caller in `updateInternal`; only other reference is the illustrative snippet in `docs/collections.md`, updated).

## Use cases / tests to exercise (reviewer floor)

The four `conflict resolution (TEST-3.3.1)` cases in `test/collection.spec.ts` cover the hook's contract:

- **replace** (NEW, `filterConflict returns a rewritten action`) — rewrites `local` → `merged`, drives a conflict; asserts committed log includes `merged`, excludes `local`. Was failing (`expected [ 'remote', 'local' ] to include 'merged'`), now passes.
- **discard** (`returns undefined`) — local action dropped; log has only `remote`. Must stay green (it does).
- **keep-original** (`returns original action`) — remote + local both present.
- **no-filter** (`no filterConflict provided`) — both present.

Reviewer should treat these as a floor, not a ceiling. Angles worth probing:

- **Replacement's block effects, not just the log.** The tests assert via `selectLog` (log actions). Consider a hook whose replacement produces *different block transforms* than the original and assert the tracker/committed blocks reflect the replacement, not the original — that is the exact bug the `mutated`-forced replay guards, and no test currently drives block-level effects of a replacement.
- **Multiple remote entries in one update.** The map runs per entry; a replacement produced against entry N is itself re-filtered against entry N+1. Verify a replacement isn't re-rewritten or dropped unexpectedly across multiple entries.
- **Replacement + discard mix in one pending batch** (length stays equal but positions shift) — confirm `mutated` still trips (it does: any replacement makes `after[i] !== before[i]`; any drop makes lengths differ).

## Known gaps / honest notes

- **`mutated` uses reference identity** (`after[i] !== before[i]`), matching the documented contract (return same instance to keep, new instance to replace). A misbehaving hook that always allocates a fresh-but-equal instance would force a replay every update. Judged conditional, not a defect — parked as a `NOTE:` tripwire at the site (`collection.ts`, the `mutated` line). Recorded here per tripwire policy; the analysis lives at the code site, not in this ticket.
- **`filterConflict` is still invoked for every pending × every remote entry regardless of real block conflict** — pre-existing behavior, unchanged by this fix and out of scope. Only note is the tripwire above about replay cost.
- No new tests for the block-effects angle above — left as a deliberate gap for the reviewer to weigh (see "Use cases").
- No pre-existing test failures encountered; `.pre-existing-error.md` not written. (The circular-import error the ticket warns about only bites when loading a *single* spec file; the full `test/**/*.spec.ts` glob used for validation does not hit it.)
