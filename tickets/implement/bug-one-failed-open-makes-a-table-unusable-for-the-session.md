<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-09-01T06:32:06.267Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\bug-one-failed-open-makes-a-table-unusable-for-the-session.implement.2026-09-01T06-32-06-267Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: If a table's very first read fails for a passing reason — a brief network hiccup, a storage node that answers late — that table keeps failing with the same stale error for the rest of the session, even after everything is healthy again. Make the next statement free to try again.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/drop-table-orphan-rows.spec.ts (harness to copy), packages/quereus-plugin-optimystic/test/init-retry-after-transient-failure.spec.ts (new)
difficulty: medium
repro: verified
----

## The defect

`OptimysticVirtualTable` does its real setup lazily on first touch, and memoizes the
in-flight promise so the next hundred statements don't repeat it. The memo does not
distinguish success from failure: `initialize()` assigns `this.initializationPromise` once
(`optimystic-module.ts:325-350`) and never clears it, so once that promise REJECTS, the
rejection is the memoized answer for the life of the process. Every later statement on the
table replays the original error verbatim, including statements issued against a cohort
that has been healthy for minutes.

The sibling field on the same class, `provisionalInitPromise`, clears itself in a
`finally` (`~:406`) for exactly this reason. The two paths disagree and the less-travelled
one is the correct one.

Every entry point that touches a cold table routes through the same memoized
`initialize()` — the live-read branch of the scan path (`~:973`), DML (`~:2060`),
`addIndex` (`~:2366`) — so fixing `initialize()` fixes all of them. No per-caller change.

## The change

**One rule: a memoized promise must never memoize its own rejection.** Rework
`initialize()` to the same shape `initializeForCommittedRead` already uses for its
provisional pass — build the attempt, chain a `finally` that clears the field, then assign
and return the chained promise:

```ts
const attempt = (async () => { /* existing body, unchanged */ })()
  .finally(() => {
    // Cleared either way: on success `isInitialized` gates re-entry; on failure the
    // next statement is free to retry against a cohort that may have recovered.
    if (this.initializationPromise === attempt) {
      this.initializationPromise = undefined;
    }
  });
this.initializationPromise = attempt;
return attempt;
```

Concurrent callers arriving while the attempt is in flight still share it (they hold the
same object); only the SETTLED-rejection case changes. The identity check is defensive —
the `finally` runs before any awaiting caller resumes, so no newer attempt can exist yet —
but it costs nothing and survives future reordering.

### Resolved: no damping. Retry on every statement.

Un-damped. A statement against an unreachable cohort was going to make network calls and
fail regardless; one initialization attempt is the same order of cost as the read the
statement would have done anyway, and each attempt is user-driven (there is no background
poller re-entering `initialize`). Damping would add a timestamp, a window, and a clock, and
would reintroduce the exact bug being fixed in miniature — recovery delayed by up to the
window. It would also need a constant this module has no basis to pick: the same reasoning
that made this module decline to declare `expectedLatencyMs` (`~:2967` — transactors here
range from in-memory microseconds to libp2p cohorts at hundreds of milliseconds) applies
unchanged to a damping window. Backoff belongs in the transactor/network layer that already
models unreachable blocks; duplicating it at the vtab layer double-counts.

Record this as an accepted tradeoff at the site, in the required greppable form, e.g.:

```ts
// NOTE: accepted tradeoff — a table pointed at a genuinely dead cohort re-attempts
// initialization on every statement rather than caching the failure for a cooldown
// window; un-damped retry weighed over a window this layer has no basis to pick (see
// the expectedLatencyMs note below for the same reasoning). Revisit if initialization
// storms against a dead cohort ever show up in profiles — damp in the transactor, not
// here.
```

A deterministic, permanent failure (`Cannot create table without column definitions`, a
`guardStorageAdoption` refusal) simply fails again on the retry. That is the correct
outcome and costs exactly one retry.

### Resolved: no eviction from the module's `tables` map on the connect path.

The plan ticket flagged a second half — `instantiateTable` caches the instance
(`~:3129`) before anyone initializes it, and `resolveConnectedTable` (`~:3215`) does not
remove it when initialization throws, so a retry finds the poisoned instance. With
in-place retry working, that is no longer a poisoned instance: the retry re-enters
`initialize()` on the cached table and rebuilds. Evicting instead would be worse — it
would drop an instance a concurrent caller may already hold and rebuild the SchemaManager
for no gain. **Do not add eviction to the connect path.** `create()`'s existing eviction
(`~:3155`) stays as it is: it exists for a different reason (its own "already exists"
check would reject the user's re-declare retry), not for retry safety.

Verified while resolving this: `resolveConnectedTable`'s warm branch never calls
`ensureConnectionRegistered()`, so a table whose first connect failed is not connection-
registered by the retry either. That is not a hole — the live scan path (`~:973`) and the
DML path (`~:2060`) each call `ensureConnectionRegistered()` themselves before use, and it
is idempotent (guarded by `this.connection`).

### Retry safety of `doInitialize` — one real order-dependence to close

`doInitialize` already runs twice for one table on the provisional→full upgrade path, and
assigns `collection`, `rowCodec`, `indexManager`, `uniqueEnforcementIndexes` wholesale
rather than mutating incrementally. Checked, and safe to re-run:

- `ensureChangeSubscription` (`~:778`) has a subscribe-once guard and swallows its own
  failure (logs, resets the guard) — it never throws out of `doInitialize`.
- `registerCollections` (`~:1496`) is idempotent: `TransactionBridge.registerCollection`
  is a `Map.set` keyed by collection id. It also runs after every await that can fail, so
  a failed attempt cannot leave a half-registered registry.
- `attachPersistedUniqueConstraints` (`~:1541`) is documented and coded idempotent
  (dedupes by `uniqueConstraintKey`).

**The exception, and the second edit this ticket requires:** the branch selector
`const hasLocalColumns = this.tableSchema.columns.length > 0` (`~:485`) reads state that
`doInitialize` ITSELF mutates. The `else if (persistedSchema)` arm (the hydrate / connect-
without-columns open) populates `this.tableSchema.columns` from the persisted schema. So an
attempt that gets that far and then fails at a later await (`indexManager.initialize`,
`setUniqueEnforcementIndexes` — both of which reach the network) leaves the table looking
like it was declared WITH columns, and the retry takes the DDL-wins arm instead: a
different branch, one that can call `guardStorageAdoption` and `storeStoredSchema` — a
schema WRITE where the first attempt intended a read-only load. Usually `schemasEqual`
short-circuits it, but round-trip equality is not guaranteed and "usually" is not a
contract.

Fix by making the branch a function of the declaration rather than of mutated state:
capture it once in the constructor —

```ts
/** Whether the DDL that declared this table supplied columns (`CREATE TABLE` / a
 *  connect carrying columns) as opposed to a hydrate/connect that must load them from
 *  storage. Captured at construction: doInitialize populates `tableSchema.columns` on
 *  the load arm, so re-reading the length inside would make a re-run (a retry after a
 *  failed attempt, or the provisional→full upgrade) take a different branch than the
 *  first pass. */
private readonly declaredColumns: boolean;
```

— and read `this.declaredColumns` in `doInitialize`.

**Known behaviour delta, intended:** on the provisional→full upgrade of a column-less
connect, the full pass today sees the columns the provisional pass loaded and takes the
DDL arm, which can write the schema back. With the captured flag it takes the load arm and
writes nothing — matching what an ordinary (non-upgrade) hydrate open already does. That
write was an accident of ordering, not a design. If a spec turns out to depend on it (the
one-time uniqueness-metadata migration described at `~:530` is the plausible candidate),
**stop and say so in the review handoff** rather than reverting the flag quietly or
loosening the test.

### Stale error message

`doInitialize`'s catch (`~:628`) calls `setErrorMessage(message)`. Confirmed against the
engine: `VirtualTable.errorMessage` is a plain public field on Quereus's base class
(`@quereus/quereus/src/vtab/table.ts:86,107`) and nothing in the engine reads it — it is
diagnostics only, as this module's own note at `~:2961` says. It should still not outlive a
successful open: clear it at the top of `doInitialize`'s `try` (`this.setErrorMessage(undefined)`),
so a fresh attempt starts with no stale message and a successful retry leaves no trace of
the failed one.

## Edge cases & interactions

Cover these; the reviewer will check for them.

- **Concurrent first touches, in flight.** Two callers arriving before the attempt settles
  must share the ONE attempt (no second initialization). Pin this with a test — it is the
  behaviour the memo exists for, and the easiest thing to break while fixing the rejection
  case.
- **Concurrent first touches, both failing.** Both callers must receive the error; the
  memo must be clear afterwards so a third caller retries.
- **Both entry paths.** `create()` (which evicts and tears down on failure, so its retry
  arrives as a fresh instance) and `connect()`/`resolveConnectedTable` (which keeps the
  instance, so its retry re-enters `initialize()` on the same object). They recover by
  different mechanisms and both must work.
- **Failure at different depths.** A transactor that fails the very first `get` (before
  `this.collection` is assigned) and one that fails later (after `collection` and
  `rowCodec` are assigned) must both recover. The second is the case the `declaredColumns`
  capture exists for.
- **Deterministic failure retries deterministically.** A `guardStorageAdoption` refusal or
  a genuinely missing column list must fail the same way on the retry — no state left over
  that turns a refusal into an accidental success on the second try.
- **Committed-read path unaffected.** `initializeForCommittedRead` checks `isInitialized`
  BEFORE `initializationPromise`, so clearing the field on SUCCESS cannot make a committed
  read start a redundant provisional pass. Keep that ordering; a test that does a committed
  read after a healed failure is cheap insurance.
- **Provisional state surviving a failed full pass.** `isProvisionallyInitialized` is only
  cleared immediately before `isInitialized = true`, so a failed full pass leaves a
  previously-successful provisional state intact and committed reads keep working. That is
  correct; do not "clean up" the flag in the catch.
- **Tripwire, pre-existing, do not expand scope:** a full pass that fails midway after
  replacing `rowCodec`/`indexManager` leaves an UNINITIALIZED `IndexManager` on a table a
  concurrent committed scan may still be reading (scans re-read both fields per row). This
  needs a successful provisional init, an in-flight committed scan, AND a full pass failing
  between the `indexManager` assignment and its `initialize()`. The existing NOTE at
  `~:612` already documents the field-replacement hazard for the success case — extend it
  with one sentence naming the failure case and the condition under which it becomes real
  (concurrent DDL, or committed scans that outlive an upgrade), and index it in the review
  handoff. Do not file it and do not fix it here.

## Tests

New spec `packages/quereus-plugin-optimystic/test/init-retry-after-transient-failure.spec.ts`,
built on the `MemoryRawStorage` + `StorageRepo` harness in
`test/drop-table-orphan-rows.spec.ts` (copy `buildSharedLocalTransactor` /
`registerWithSharedTransactor` — the plugin is registered with
`default_transactor: 'local'`, `default_key_network: 'test'`, `enable_cache: false`, and
the transactor is injected via `plugin.collectionFactory.registerTransactor('local:test', …)`).

The failure injection is a boolean gate in the wrapping transactor's `get` that throws once
and then heals:

- **connect path, heals.** Storage already holds a table (write it with a healthy
  transactor, then open a second `Database` whose transactor is gated). First statement
  fails; heal the gate; the SAME statement against the SAME table on the SAME `Database`
  succeeds and returns the expected rows. Expected before the fix: second attempt reports
  `Failed to initialize Optimystic table: <original error>`.
- **create path, heals.** `create table` fails under the gate; heal; re-issuing the
  `create table` (the instance was evicted) succeeds and the table is usable.
- **shared in-flight attempt.** Two statements issued without awaiting the first, against a
  transactor whose `get` is counted: assert the initialization work happened once (count
  `createOrGetCollection`-driven gets, or wrap the table's collection factory) and that both
  callers see the same outcome. Run it for both the success case and the both-fail case.
- **deterministic failure stays deterministic.** A table whose declaration the storage-
  adoption guard refuses fails with the same message on the second statement — not a
  different one, and not a success.
- **failure after partial assignment.** Gate the transactor to succeed for the schema read
  but fail for the index-tree read, against a hydrate-style (column-less) open; assert the
  retry succeeds and does not rewrite the persisted schema. This is the `declaredColumns`
  regression test — it fails without that capture only if the round-trip is lossy, so also
  assert the branch outcome directly (no schema write on the retry) rather than only the
  end state.

Run from the package: `yarn build` first (specs import `../dist/plugin.js`), then
`yarn test`. The package suite is ~2m46s — well inside the idle window; run it in the
foreground with no redirection. Also `yarn typecheck` in the package (its build strips
types without checking them).

## TODO

- Capture `declaredColumns` in the `OptimysticVirtualTable` constructor and read it in
  `doInitialize` in place of `this.tableSchema.columns.length > 0`; document why with the
  comment above.
- Clear `setErrorMessage(undefined)` at the top of `doInitialize`'s `try`.
- Rework `initialize()` to clear `initializationPromise` in a `finally` on the chained
  attempt, with the identity guard; keep the provisional-await preamble unchanged.
- Add the accepted-tradeoff `NOTE:` for un-damped retry at `initialize()`.
- Extend the field-replacement `NOTE:` at `~:612` with the mid-failure sentence (tripwire —
  no ticket).
- Write `test/init-retry-after-transient-failure.spec.ts` covering every bullet under
  **Tests**.
- `yarn build && yarn test && yarn typecheck` in `packages/quereus-plugin-optimystic`,
  foreground, no redirection. Report any pre-existing failure per the pre-existing-test
  rules rather than skipping it.
- Review handoff: state the provisional→full upgrade behaviour delta explicitly, whether
  any spec depended on the removed schema write, and where the mid-failure tripwire was
  parked.
