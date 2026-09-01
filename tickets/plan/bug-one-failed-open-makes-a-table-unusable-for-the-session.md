description: If a table's very first read fails for a passing reason — a brief network hiccup, a storage node that answers late — that table keeps failing with the same stale error for the rest of the session, even after everything is healthy again. Only restarting the process clears it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts
repro: verified
difficulty: medium
----

## What happens

A table backed by this plugin does its real setup lazily, on first touch. That setup
result is remembered so the next hundred queries don't repeat it. The remembering does
not distinguish success from failure: if the first touch fails, the FAILURE is what gets
remembered, and every later query on that table replays the original error verbatim —
including queries issued minutes later, against a cohort that has been healthy the whole
time. Nothing short of a new process (or a fresh `Database` with a fresh plugin
registration) recovers the table.

The setup can fail for entirely transient reasons — the storage layer here explicitly
models blocks being briefly unreachable — so this is not an exotic path.

## Verified

Reproduced against the in-memory harness by wrapping the shared test transactor so its
reads throw once, then healing it:

```
PROBE: first read failed as designed:  ... Failed to initialize Optimystic table: transient cohort failure
PROBE: retry after recovery STILL FAILS: ... Failed to initialize Optimystic table: transient cohort failure
```

The second read runs against a fully healthy transactor and still reports the original
error. (The probe was a throwaway spec, not committed; it is ~40 lines built on the same
`MemoryRawStorage` + `StorageRepo` harness as
`packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts`, with a boolean
gate in the transactor's `get`.)

## Root cause — one idea, two halves

Both halves live in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`:

- `OptimysticVirtualTable.initialize()` (~line 328) stores its in-flight promise in
  `initializationPromise` and returns that promise to every later caller. The field is
  assigned once and never cleared, so once the promise REJECTS, the rejection is the
  memoized answer forever. The sibling field on the same class, `provisionalInitPromise`,
  clears itself in a `finally` (~line 406) for exactly this reason — the two paths
  disagree, and the one that does it correctly is the less-travelled one.
- `OptimysticModule.resolveConnectedTable()` (~line 3215, the `connect` path) reaches
  `instantiateTable()`, which caches the instance in the module's `tables` map (~line
  3129) BEFORE anyone initializes it, and nothing removes it when initialization throws.
  So the retry finds the poisoned instance rather than building a fresh one.

Either half alone would be survivable; together they make the failure permanent. The
sibling `create` path (~line 3155) already evicts a failed instance from `tables` and
tears down its change subscription — the shape of the fix for the second half already
exists a few lines away in the same file.

Every other entry point that touches a cold table routes through the same memoized
`initialize()` — the live-read branch of the scan path (~line 975), the DML path (~line
2064), `addIndex` (~line 2366) — so all of them inherit the permanent failure. Fixing
`initialize()` fixes all of them; no per-caller change is expected.

## Expected behaviour

A failed first open is a failed attempt, not a permanent verdict. The next statement
against the table is free to try again and succeed if conditions have improved. A
deterministic, permanent failure (a declaration the stored data genuinely cannot support,
say) simply fails again on the retry, which is the correct outcome and costs only the
retry.

Concurrent callers that arrive while one attempt is still in flight must still SHARE that
attempt — the memoization has to keep doing its job for the success case and for the
in-flight case; only the settled-rejection case changes.

A successful retry must leave no trace of the failed attempt visible to the engine. Note
that `doInitialize`'s catch (~line 628) calls `setErrorMessage(...)` on the vtab; whether
that stale message survives a later successful open needs checking as part of the work.

## Design considerations for whoever plans this

- **Retry safety.** `doInitialize` already runs twice for one table on the
  provisional→full upgrade path, and its fields (`collection`, `rowCodec`,
  `indexManager`, `uniqueEnforcementIndexes`) are assigned wholesale rather than mutated
  incrementally; the change subscription has its own subscribe-once guard
  (`changeSubscribed`). A re-run after a failure should therefore be structurally safe,
  but confirm rather than assume — a failure can land at any of the awaits inside, and
  the module-level `tables` eviction option (mirroring `create`) is the alternative if
  in-place retry turns out not to be clean.
- **Damping — the one open decision.** Should the retry be immediate on every statement,
  or damped? Un-damped, a table pointed at a genuinely unreachable cohort turns each
  query into a fresh round of cohort traffic. Damped, recovery is delayed by up to the
  damping window. Decide this explicitly and say why; if damping is chosen, the window
  and its trigger belong in the plan.
- **Class check.** The general rule behind this instance: a memoized promise must never
  memoize its own rejection. A sweep of `packages/quereus-plugin-optimystic/src` found
  exactly two such fields — `initializationPromise` and `provisionalInitPromise`, both in
  this one file, one already correct. So the class is genuinely small here and this can
  be treated as a point fix plus a regression test, not a package-wide refactor.

## Test requirement

The regression test is the throwaway probe above, made permanent: a transactor that fails
its reads once and then heals, asserting the second statement against the same table
succeeds. Build it on the existing `MemoryRawStorage` + `StorageRepo` harness alongside
`packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts`. Cover both the
`create` and `connect` entry paths, and cover a concurrent pair of first touches so the
shared-in-flight behaviour stays pinned.
