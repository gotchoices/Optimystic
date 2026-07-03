----
description: Fix a collection's conflict-resolution hook so that a rewritten action it returns actually replaces the original instead of being silently thrown away.
files: packages/db-core/src/collection/collection.ts, packages/db-core/test/collection.spec.ts
difficulty: medium
----
## Problem (reproduced)

`filterConflict` is the documented conflict-merge extension point on a `Collection`. For each local pending action that may conflict with a remote one, the hook returns one of:

- the **same** action instance → keep it as-is,
- a **new** action instance → apply this replacement *instead of* the original,
- `undefined` → discard the action.

The replacement path is broken. In `updateInternal` (`collection.ts:132-134`):

```js
this.pending = this.pending.map(p => this.doFilterConflict(p, entry.actions) ? p : undefined)
    .filter(Boolean) as Action<TAction>[];
```

and `doFilterConflict` (`collection.ts:327-338`):

```js
protected doFilterConflict(action, potential) {
    if (this.filterConflict) {
        const replacement = this.filterConflict(action, potential);
        if (!replacement) {
            return false;
        } else if (replacement !== action) {
            this.pending.push(replacement);   // pushes onto the OLD array
        }
    }
    return true;
}
```

Two defects:

1. **Replacement discarded.** The `push` lands on the array `map` is iterating over, beyond the fixed range it walks; the mapped result then overwrites `this.pending`, so the pushed replacement is thrown away.
2. **Original wrongly retained.** Even ignoring (1), `doFilterConflict` returns `true` on the replacement path, so the *original* action `p` is kept in the mapped result. So a replacement should have *replaced* the original, but the code keeps the original and loses the replacement — the exact opposite of the contract.

Net effect: a hook that returns a rewritten action silently loses the merge — the log ends up with the original, unmerged action.

## Reproduction (already committed, currently failing)

Added to `packages/db-core/test/collection.spec.ts` in the `conflict resolution (TEST-3.3.1)` block:

> `should apply the replacement action when filterConflict returns a rewritten action`

It rewrites a `'local'` action into `'merged'`, drives a conflict, and asserts the committed log contains `'merged'` and not `'local'`. Current output:

```
AssertionError: expected [ 'remote', 'local' ] to include 'merged'
```

Run it with (from `packages/db-core/`):

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min --grep "filterConflict returns a rewritten"
```

Note: mocha must be pointed at the full `test/**/*.spec.ts` glob, not a single file — loading one spec alone hits a pre-existing circular-import error (`Cannot access 'collectionTypes' before initialization`) from the collection-type registry. Use `--grep` to isolate the case.

## Fix direction

`filterConflict` already returns exactly `Action | undefined` (original / replacement / discard), so the map can consume that value directly rather than a boolean. Simplify `doFilterConflict` to return the effective action, and have the map replace each pending element with its filtered result in place — this preserves ordering and both replaces the original and keeps the replacement:

```js
protected doFilterConflict(action: Action<TAction>, potential: Action<TAction>[]): Action<TAction> | undefined {
    return this.filterConflict ? this.filterConflict(action, potential) : action;
}
```

```js
this.pending = this.pending
    .map(p => this.doFilterConflict(p, entry.actions))
    .filter((a): a is Action<TAction> => a !== undefined);
```

(The ticket's original suggestion — return `{ keep, replacement }` and append replacements to a local array after the map — also works, but appends replacements at the end, shifting order; the in-place map above avoids that. Either is acceptable.)

Update the doc comment on `doFilterConflict` (`collection.ts:322-326`): it currently says "returns true if the action should be kept, false to discard" — change it to describe the `Action | undefined` return (original, replacement, or discard).

### Second concern — make the replacement actually take effect in the tracker

`filterConflict` is invoked for every pending action against every remote entry, independent of whether the tracker reports a real block conflict. So a replacement can occur while `anyConflicts` (driven by `tracker.conflicts(...)` at `collection.ts:136`) stays `false`. In that case `replayActions()` never runs, and the tracker's staged transforms still reflect the **original** action, not the replacement — pending says `'merged'` but the block effects are still `'local'`.

For the replacement to be genuinely "applied" (the ticket's stated expected behavior), force a replay whenever filtering changed the pending set. Track whether the map replaced or dropped any element and OR it into `anyConflicts` for that entry, e.g.:

```js
const before = this.pending;
const after = before.map(p => this.doFilterConflict(p, entry.actions))
    .filter((a): a is Action<TAction> => a !== undefined);
const mutated = after.length !== before.length || after.some((a, i) => a !== before[i]);
this.pending = after;
this.sourceCache.clear(entry.blockIds);
anyConflicts = anyConflicts || mutated || this.tracker.conflicts(new Set(entry.blockIds)).length > 0;
```

This also incidentally cleans up an existing wart on the discard path (a discarded action currently leaves an orphan block transform in the tracker because no replay runs) — verify the existing `should discard pending action when filterConflict returns undefined` test still passes; it should, since `selectLog` reads log actions, not tracker transforms.

## Validation

Run the full db-core suite from `packages/db-core/`, streaming output:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min 2>&1 | tee /tmp/dbcore-test.log
```

New replacement test must pass; the three other `conflict resolution (TEST-3.3.1)` tests (discard / keep-original / no-filter) must stay green. Also run `yarn build` (tsc) in the package to confirm the return-type change on `doFilterConflict` type-checks.

## TODO

- Change `doFilterConflict` to return `Action<TAction> | undefined` (effective action) instead of a boolean; update its doc comment.
- Rewrite the `updateInternal` map (`collection.ts:132-134`) to map each pending action to its filtered result and drop `undefined`s.
- Force `anyConflicts` for an entry when filtering mutated the pending set, so `replayActions()` re-stages the replacement (and clears the discard-orphan transform).
- Run the full `packages/db-core` test suite + `yarn build`; confirm the new replacement test passes and the other conflict-resolution tests stay green.
- Write a review/ handoff ticket that is honest about any residual gaps (e.g. the discard-orphan cleanup if left unaddressed).
