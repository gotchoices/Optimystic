description: If a table's very first read fails for a passing reason — a brief network hiccup, a storage node that answers late — that table keeps failing with the same stale error for the rest of the session, even after everything is healthy again. Only restarting the process clears it.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The failure is loud and a restart clears it, so a maintainer may reasonably rank it below silent-corruption work — and retrying a failed open needs care not to hammer an already-struggling cohort.
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

- `OptimysticVirtualTable.initialize()` stores its in-flight promise in
  `initializationPromise` and returns that promise to every later caller. The field is
  assigned once and never cleared, so once the promise REJECTS, the rejection is the
  memoized answer forever. Note that the sibling field on the same class,
  `provisionalInitPromise`, clears itself in a `finally` for exactly this reason — the
  two paths disagree, and the one that does it correctly is the less-travelled one.
- `OptimysticModule.resolveConnectedTable()` (the `connect` path) caches the table
  instance in the module's `tables` map before initializing it, and leaves it there when
  initialization throws. So the retry finds the poisoned instance rather than building a
  fresh one.

Either half alone would be survivable; together they make the failure permanent. Note
that the sibling `create` path already evicts a failed instance from `tables` and tears
down its subscription — so the shape of the fix for the second half already exists a few
lines away in the same file.

## Expected behaviour

A failed first open should be exactly that — a failed attempt. The next statement against
the table should be free to try again and succeed if conditions have improved. A
deterministic, permanent failure (a declaration the stored data genuinely cannot support,
say) will simply fail again on the retry, which is the correct outcome and costs only the
retry.

Worth deciding as part of the work: whether a retry should be immediate on every
statement, or damped, so a table pointed at a genuinely unreachable cohort does not turn
each query into a fresh round of cohort traffic.

## Scope note

There is a general rule behind this instance — a memoized promise must never memoize its
own rejection. This file holds two such fields and gets it right in one of them, so the
class is small here; whoever picks this up should still check whether the same pattern
has spread elsewhere in the package before treating it as a pure one-off.
