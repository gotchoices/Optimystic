description: When the database asks this plugin for a read of only already-committed data, that read now gets its own clean, single-moment view — it no longer touches the writer's connection, refuses to answer when storage is in a half-committed state, and the module declares that concurrent reads on one connection are safe.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/committed-read-isolation.spec.ts, docs/transactions.md, docs/internals.md
----

# Complete: committed-read connection isolation

## What shipped

**Single-moment committed views** (`optimystic-module.ts`, `runQuery`). The access-strategy
parse (plan type, index name, legacy `idxNum >= 10` arm) runs first and is entirely
synchronous. For a committed read the main-tree view and — when the plan drives one — the
index-tree view are then built in one synchronous block, so no commit can land between the
two pins. `executeIndexScan` receives its sources rather than building them. The live path
is behaviourally unchanged (same `update()` calls, same order, same dispatch).

**No connection-registry mutation on the committed path.** `runQuery` calls
`ensureConnectionRegistered()` only for live reads. `OptimysticModule.connect` with
`_readCommitted: true` resolves and initializes the table but passes
`registerConnection: false` to `resolveConnectedTable`. `OptimysticCommittedTable` overrides
`createConnection()` (throws `MISUSE`) and `getConnection()` (returns `undefined`), so
nothing can enlist the committed view by accident.

**Degraded latch** (`txn-bridge.ts`). `degradedReason` is set when `commitTransaction`
surfaces `PartialCommitError` (legacy) or `CoordinatorPartialCommitError` (session), and
cleared on the next successful commit or rollback. Exposed as `isDegraded()` /
`getDegradedReason()`. `runQuery`'s committed arm throws at the first pull while latched,
embedding the persisted/unpersisted tree lists. Live reads are unaffected.

**Declarations.** `OptimysticModule.concurrencyMode = 'reentrant-reads'`, behind a
documented audit. `expectedLatencyMs` deliberately not declared (the module fronts
transactors from in-memory to libp2p cohorts and the hint is static per module; rationale in
code). `readCommittedSnapshot` deliberately not declared — it belongs to
`committed-read-snapshot-declaration`.

**Docs.** `docs/transactions.md` gained "One writer at a time on the shared
TransactionBridge" and "Committed reads refuse a degraded (partially-committed) store";
`docs/internals.md` § "Committed reads are pinned, not shared-cache" gained the
no-connection-registration property, the one-synchronous-block property, and the
`concurrencyMode` declaration.

## Validation

`yarn build` (root) clean. `yarn lint` (root, `eslint .`) clean. Plugin suite:
**346 passing, 11 pending, 0 failing**, plus the `test:smoke` engine-id check
(`smoke ok quereus@4.8.0`). No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

## Review findings

### Checked and correct — no action

- **Hoisted legacy `idxNum >= 10` condition.** The implementer flagged this as the
  restructure most worth an eyeball. It is equivalent to the old dispatch: `idxNum === 1`
  and `idxNum === 2` are mutually exclusive with `idxNum >= 10`, so removing them from the
  precedence chain changes nothing, and the two added guards
  (`!(planType === 2 && args.length > 0)`, `planType !== 3`) reproduce exactly the two
  else-if arms that previously ran ahead of it. Now covered by a test (below) rather than by
  reading.
- **The throwing `createConnection()` override cannot be reached by the engine.** Verified
  in the installed `@quereus/quereus@4.8.0` dist, not from the handoff: the only code that
  calls `vtab.createConnection` is `runtime/utils.js` `getVTableConnection`, and grepping the
  whole dist confirms that helper has no callers at all — and it throws on `ctx.readCommitted`
  before reaching the call anyway.
- **The `reentrant-reads` audit re-derived independently.** Every scan's mutable state
  (`yieldedKeys`, `lastKey`, `retryCount`, read views, iterators) is declared inside the
  generator; a grep for instance-field assignment across the whole vtab class finds only
  `initialize()`'s one-time setup, the connection memo, and `setErrorMessage`. The
  last-writer-wins `setErrorMessage` is diagnostics only, as the audit says.
- **Degraded-latch clearing sites.** Both are reachable and correct as specified: the legacy
  `PartialCommitError` path leaves the transaction inactive (`commitDirtyTreesLegacy` tears
  it down), so the latch is released by a *later* transaction's commit or rollback, which is
  what the tests drive.

### Found and fixed in this pass (minor)

- **Silent-fallthrough branch + duplicated schema lookup** (`optimystic-module.ts`). The
  dispatch guarded on `scanIndexName !== undefined && indexRead !== undefined`; if a source
  had ever been missing, an index-driven plan would have quietly executed as a full scan or
  point lookup instead of failing. Separately, `resolveIndexTree` fetched the index schema
  only to discard it, and `executeIndexScan` fetched it again (with its own duplicate
  "Index not found" throw). Both resolved by carrying the index schema, tree, and read view
  as one value: new `IndexScanTarget` / `IndexScanSource` types, `resolveIndexTree` →
  `resolveIndexTarget`, and `executeIndexScan` down from four parameters to three. The
  index-driven decision is now single-valued, so the impossible-state branch is gone.
- **Legacy `idxNum >= 10` arm had no coverage** (the implementer said so). Added
  `legacy index-scan dispatch (idxNum >= 10)` to `committed-read-isolation.spec.ts`: a
  bare-index-name plan at `idxNum = 10` must reach the committed index view (and exclude a
  staged row), and — at the same `idxNum` — `plan=2`-with-args and `plan=3` must still win
  over the legacy arm. That last pair is what pins the hoisted condition's precedence.
- **`docs/internals.md` was out of date.** Its § "Committed reads are pinned, not
  shared-cache" is the one place in `docs/` that describes this path, and it said nothing
  about the two properties this ticket added. Added the no-connection-registration rule, the
  single-synchronous-block rule, and the `concurrencyMode = 'reentrant-reads'` declaration
  with why `readCommittedSnapshot` stays off. (`docs/transactions.md`'s two new sections were
  read and are accurate; no other file under `docs/` references this code.)

### Found and filed (major)

- **A first-touch committed read still writes to shared state.** This ticket stopped a
  committed read from registering an engine *connection*, but a committed read of a table not
  yet in the module's cache still calls `OptimysticVirtualTable.initialize()`, and
  `doInitialize` uses the writer's in-flight transaction: it opens collections through the
  writer's transactor, writes the schema tree when the local shape does not match what is
  persisted, adds collections to the bridge registry (in session mode, the live map the
  in-flight coordinator was built from), and subscribes to change notifications. It is
  harmless today only because committed reads still run under Quereus's execution mutex —
  and the flag that removes that mutex is exactly what
  `committed-read-snapshot-declaration` sets. That ticket already claims
  `optimystic-module.ts`, so per the board rules this was **appended as an arm to
  `tickets/implement/3-committed-read-snapshot-declaration.md`** rather than filed fresh,
  with a TODO entry gating the flag on settling it.

### Recorded as a tripwire, not a ticket

- **The degraded latch's clearing rule is coarser than it reads.** It is an advisory
  signal, not a repair: an unrelated transaction's clean commit or rollback releases it
  while the durably-split trees are untouched, so after a legacy split that persisted the
  main table but not its index, a post-clear committed full scan and a committed
  index-driven scan of that table disagree — permanently, until the application-level
  reconciliation in `docs/correctness.md` § "Partial landing". That is pre-existing store
  divergence the latch never claimed to fix, so it is not a defect here; it becomes work
  only if something starts treating a cleared latch as proof of coherence — most obviously
  `readCommittedSnapshot`, which promises exactly full-scan/index agreement. Parked as a
  `NOTE:` on `TransactionBridge.degradedReason`.

### Observed, deliberately not filed

- **`optimystic-module.ts` is 2386 lines** (`wc -l`), holding three classes:
  `OptimysticVirtualTable` (110–1720), `OptimysticCommittedTable` (1721–1768),
  `OptimysticModule` (1769–end). Not filed as size debt: this diff added roughly 90 net
  lines to an already-large file and introduced no new seam, and the obvious split
  (three files) still leaves a ~1600-line vtab class, so it would be motion rather than a
  fix. Worth a real decomposition when someone has a reason to be in that class anyway.
- **`ensureConnectionRegistered` has a benign double-entry window** — two concurrent live
  scans can both enter, but `this.connection` is assigned before the `await`, so exactly one
  `registerConnection` happens and the second caller returns the same connection (possibly a
  tick before it is registered; `query()` does not use the connection object). Newly legal
  under `reentrant-reads`, and harmless. No change.
- **Session-mode degraded arm still has no end-to-end test** (the implementer's own honest
  note). Not filed separately: `committed-read-snapshot-declaration` already lists
  "`PartialCommitError` during the stall window must make committed reads *throw*" under its
  edge cases and builds the stall harness that makes a genuine session-mode partial commit
  stageable.
- **The "commit lands between the two view builds" race is closed by structure, not by an
  injected test.** Confirmed by reading: there is no `await` left in that block to interleave
  on, so the race is unscriptable without adding an artificial seam. Reviewed by eye as the
  implementer asked; no test added, because a passing test there would prove nothing the
  structure does not already.
- **`expectedLatencyMs` left undeclared.** Upstream suggests network-backed modules declare
  it so the fan-out rules can amortize latency, so this does forgo an optimization — but the
  hint is static per module and this one fronts everything from an in-memory transactor to
  libp2p cohorts. The rationale and the condition for revisiting (per-deployment
  configuration feeding a measured value) are already at the declaration site. No change.
- **Nothing found** under resource cleanup or error handling: the per-scan pinned views hold
  no handles beyond the cloned cache entries an abandoned iterator simply drops, and the
  degraded refusal throws a `QuereusError` from before `runQuery`'s try block, so it reaches
  the caller with its status code intact rather than being re-wrapped as a plain `Error`.
