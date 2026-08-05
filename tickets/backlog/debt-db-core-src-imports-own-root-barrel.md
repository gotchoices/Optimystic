----
description: Ten files inside the db-core package import from the package's own top-level export file, which makes the modules load in a circle. That circle already caused one crash that took a while to diagnose; removing it stops the next one from ever happening.
files: packages/db-core/src/index.ts, packages/db-core/src/chain/chain.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collections/tree/collection-trunk.ts, packages/db-core/src/log/log.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/test/registrar-import-cycle.spec.ts
difficulty: medium
tradeoffs: Nothing is broken today and the change touches ten files across most of db-core's subsystems for a purely structural payoff, so a maintainer could reasonably defer it until the next time the circular load order actually bites.
----

## What this is about

`packages/db-core/src/index.ts` is the package's public export file — it re-exports everything
under `src/`. Ten modules *inside* `src/` import from it, so those modules depend on the file
that depends on them. Node evaluates such a group in a circle, and whichever module happens to
be entered first determines which parts of the circle are half-built when the rest runs.

Measured — every non-type import of the package root export file from inside `src/`:

```bash
cd packages/db-core
grep -rn --include=*.ts -E "from \"(\.\./)+index\.js\"|from '(\.\./)+index\.js'" src \
  | grep -vE "^[^:]+:[0-9]+:import type"
```

Ten hits, listed in `files:` above.

## Why it matters

This exact circle already produced a real, hard-to-read failure. Three db-core spec files
crashed with `ReferenceError: Cannot access 'collectionTypes' before initialization` whenever
run on their own, and passed when run as part of the whole suite. Diagnosing it required
tracing module evaluation order by hand. It was fixed (ticket
`debt-db-core-single-spec-import-cycle`) by making the three affected modules import their
dependency directly instead of through the top-level export file, plus a guard test that keeps
those specific imports direct.

That fix removes the *symptom* for the two things that were vulnerable: the collection-type
registry and the block-type registry, both of which build a lookup table at module load time.
The circle itself is still there. Anything added later that does real work at module load time
— another registry, a plugin table, a self-registering handler — can land in the same trap,
and it will present the same way: an error message pointing at a variable in an apparently
unrelated file, reproducing only under some entry orders.

## Expected outcome

No module under `packages/db-core/src/` imports the package's own top-level export file at
runtime; each imports directly from the module (or the nearest sub-area export file) that
actually defines what it needs. Type-only imports are fine either way — they are erased before
the code runs and create no load-order dependency.

The existing guard spec `packages/db-core/test/registrar-import-cycle.spec.ts` already scans
`src/` for this shape and already resolves specifiers to decide whether they land on the top-level
export file; its first assertion is scoped to the two registry function names. Broadening that
assertion from "these two names" to "any runtime import at all" is the natural way to lock the
outcome in, and it should be broadened as part of this work so the condition cannot come back.

## Notes for whoever picks this up

- The mechanical part is straightforward: each of the ten imports is a named-import list that
  can be re-pointed at a more specific module. Some lists mix several names from different
  sub-areas and will split into two or three import lines.
- Some names may be genuinely awkward to reach directly if the defining module is itself deep
  in the circle; those are the interesting cases and may reveal a layering problem worth
  discussing rather than just re-pointing an import.
- Worth checking the other packages in the repo for the same pattern once db-core is clean —
  the guard test currently only covers db-core.
