description: Prove that a read of already-committed data still answers promptly and correctly while a write to the same table is stuck waiting on the network, then tell the database engine it is safe to run such reads at the same time as writes.
prereq: committed-read-connection-isolation
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/test/committed-read.spec.ts, packages/quereus-plugin-optimystic/test/, docs/transactions.md
difficulty: hard
----

# Prove the committed-read guarantee under a stalled commit, then declare it

## Why this ticket exists

A distributed commit in this plugin (`TransactionBridge.commitTransaction` →
`session.commit()`) can park for ~20 seconds against an unresponsive cohort
member. Today every read on that `Database` queues behind it, because Quereus
holds one execution mutex for all statements. Quereus 4.8 lifts that for
read-only statements — but only for modules that declare
`VirtualTableModule.readCommittedSnapshot`.

Tickets `committed-read-pinned-snapshot` and
`committed-read-connection-isolation` build the substrate. This ticket is the
proof and the declaration, in that order. The declaration must not land before
the proof passes.

The claim that this plugin's committed read answers promptly under a stall has
never been tested. A mutex-bypass probe in a downstream repo showed the *live*
read path answers with a pend outstanding, but the committed wrapper takes a
different route (transaction bridge → pre-stage snapshot → pinned read view) and
has only ever been exercised inside deferred constraint checks, where no commit
is in flight.

## Two proofs, not one

### A. The engine-level conformance harness (breadth)

Quereus 4.8 ships `runCommittedReadConformance` and `installCommitStall` from the
package root:

```ts
import { Database, installCommitStall, runCommittedReadConformance } from '@quereus/quereus';

const stall = installCommitStall(db);
const result = await runCommittedReadConformance({
  db,
  table: 'conf',
  keyColumn: 'id',
  valueColumn: 'v',
  stallCommit: () => stall.asStallCommit(),
});
```

It seeds rows, starts an unawaited writer that rewrites every seeded row *and*
appends new ones, parks it, then runs a full scan and an index-driven scan with
`readConcurrency: 'committed'` and asserts both equal the seeded snapshot and
agree row-for-row. It then releases and asserts a fresh read sees the post-write
state, so a view that pins and never advances also fails.

Two things it will not do for us, both important:

- It **refuses to run** unless the module declares `readCommittedSnapshot`. So
  the harness cannot be the gate for setting the flag. Sequence: land proof B
  first, set the flag, then add the harness as standing regression cover.
- `installCommitStall` parks at the **entry** of a registered
  `VirtualTableConnection.commit`, i.e. *before* this plugin's commit begins.
  Everything this plugin publishes — the coordinator's per-collection
  `applyCommittedToCache` fold, or legacy mode's tree-by-tree `sync()` sweep —
  happens downstream of that gate, so a tear inside it is invisible to the
  harness. Upstream says so explicitly and reports the same blind spot for its
  own isolation wrapper. Treat a harness pass as a full-stack smoke test.

Assert `result.observedCommitOverlap === true` and fail the test if it is false —
a pass without a provable overlap is not evidence. Report
`result.indexDrivenSkippedReason` if the index leg was skipped.

### B. The stalled-network commit (depth) — the one that matters here

Because the harness cannot park inside our publish window, drive it directly.

Register a delegating transactor via
`plugin.collectionFactory.registerTransactor(key, transactor)` (key form
`` `${transactor}:${keyNetwork}` ``, e.g. `test:test`; see
`test/catalog-hydration.spec.ts:53` and `test/adapter-integration.spec.ts:171`
for working examples). Wrap `TestTransactor` and make the commit-side call
(`transact`, and/or `pend`/`commit` depending on the mode under test) await a
gate the test controls; leave `get` passing straight through, so the stall models
an unresponsive *commit* cohort rather than a dead network.

Then:

1. Seed and commit rows.
2. Start an unawaited writer statement that mutates them; wait until the gate
   reports the commit has entered it (expose an `entered` promise from the gate —
   do not sleep).
3. While parked, run a committed read of the same table and assert it (a)
   resolves within a bounded number of event-loop turns — use
   `settleMacrotasks` from `@quereus/quereus`, not a wall-clock timeout — and (b)
   returns the pre-write values.
4. Run a second committed read driven through a secondary index and assert it
   agrees with the full scan row-for-row.
5. Release the gate, await the writer, assert a fresh read sees post-write state.

Run this in **both** commit modes: session mode (coordinator, `session.commit()`)
and legacy mode (no coordinator, `commitDirtyTreesLegacy`'s tree-by-tree sweep).
They publish differently and both must hold. `test/session-mode-commit.spec.ts`
and `test/legacy-commit-atomicity.spec.ts` show how each mode is wired.

Note that until Quereus routes our reads concurrently (which needs the flag this
ticket sets last), proof B must drive the committed read *without* the engine's
concurrent path — i.e. against the module surface directly, or with the flag
temporarily on in the test. Say in the handoff which shape you used; a read that
silently went through the serialized path proves nothing.

## The declaration

Once B passes in both modes, add to `OptimysticModule`:

```ts
readonly readCommittedSnapshot = true;
```

Fail closed: if any arm of B does not hold — including the legacy multi-tree
sweep — leave the flag off, land the tests that do pass, and file what remains.
Declining is not a defect; over-declaring is.

## Edge cases & interactions

- **Legacy multi-tree sweep mid-flight.** Stall between tree 2 and tree 3 of
  `commitDirtyTreesLegacy` and read committed. With ticket 1's pinning the read
  must show none of trees 1–2's rows. This is the arm most likely to fail.
- **A stalled commit that then FAILS.** Release the gate into an error rather
  than a success, and assert the committed reads taken during the stall showed
  rows that are still correct after the rollback — i.e. the view never published
  anything that rolled back.
- **`PartialCommitError` during the stall window** must make committed reads
  *throw* (the degraded latch from ticket 2), not answer.
- **Read of a different table while table A's commit is stalled** must also
  answer promptly — the stall must not be table-global.
- **A committed read that outlives the commit.** Start the scan while parked,
  release mid-iteration, finish the scan: every row must still come from the
  pinned pre-commit state.
- **Cold block during a stall.** A committed scan touching a block not in cache
  must fetch it (the `get` path is not gated) and get the pinned revision, not
  head. Force this with a tree larger than the block cache.
- **`Database.close()` during a concurrent read.** Quereus tracks live
  `ConcurrentReadScope`s and `close()` awaits them; confirm our scan honours the
  abort signal and does not hang close. `runQuery` iterates an async generator —
  check the abort reaches it.
- **No engine-level end-to-end yet?** Upstream has shipped
  (`concurrencyMode`, `readCommittedSnapshot`, `getModuleReadCommittedSnapshot`,
  `Statement._iterateConcurrent`, `readConcurrency: 'committed'` are all present
  in the installed 4.8.0). So the end-to-end — a `readConcurrency: 'committed'`
  statement racing a real stalled write on one `Database` — IS writable now and
  is in scope. Write it.

## Expected outputs

- Proof B, session mode: committed scan resolves while the writer is parked and
  returns exactly the seeded rows; the writer's promise is still pending at that
  point (assert it, e.g. by racing it against a resolved sentinel).
- Proof B, legacy mode: same, with the stall placed mid-sweep.
- Harness: `observedCommitOverlap === true`, `fullScanRows` equals the seed
  count, `indexDrivenRows` equals it too (or a recorded skip reason).
- End-to-end: `db.eval(sql, { readConcurrency: 'committed' })` (check the exact
  option surface on `StatementOptions` in the installed package) completes while
  a stalled write is outstanding on the same `Database`.

## Added arm (from the review of `committed-read-connection-isolation`)

**A committed read of a table this process has not touched yet still writes to
shared state — and the flag this ticket sets is what makes that concurrent.**

`committed-read-connection-isolation` stopped a committed read from registering an
engine *connection*. It did not touch the other side effects of a **first touch**.
When `OptimysticModule.connect` is asked for a committed read of a table that is not
yet in the module's per-`schema.table` cache, it still calls
`OptimysticVirtualTable.initialize()`, and that method (`doInitialize`,
`optimystic-module.ts`) does all of the following using the **writer's** in-flight
transaction (`this.txnBridge.getCurrentTransaction()`):

- creates or opens the main collection and every index collection through the
  writer's transactor;
- **writes the table's schema to the schema tree** (`storeStoredSchema(...,
  txnState?.transactor)`) whenever the local column/PK/vtab-arg shape does not match
  what is persisted — a storage write performed on behalf of a read, staged into the
  writer's transaction;
- adds the main and index collections to the bridge's collection registry
  (`registerCollections()` → `TransactionBridge.registerCollection`), which in session
  mode is the same live map the in-flight `TransactionCoordinator` was built from;
- subscribes to collection-change notifications (`ensureChangeSubscription`).

Today this is serialized: committed reads still run under Quereus's execution mutex
because `readCommittedSnapshot` is off, so the first touch cannot interleave with the
writer. **Setting the flag in this ticket removes that mutex** and the first-touch
initialize becomes concurrent with an in-flight commit.

The first-touch-as-committed-read path is real and covered:
`test/committed-read-isolation.spec.ts` → "first-EVER touch of a table as a committed
read works and registers nothing".

What this arm needs to settle (design question, not a mechanical fix):

- Should a committed read be allowed to initialize a table at all, or should the
  committed connect fail / fall back to the serialized path when the table is cold?
- If it may initialize: initialization must not use the writer's transaction. A
  read-only initialize would need its own transactor and must not write the schema
  tree, must not mutate the bridge's collection registry mid-transaction, and must not
  fold new collections into a live coordinator.
- Whichever shape is chosen, add a test that drives a first-touch committed read while
  a writer transaction is open and asserts the bridge's transaction state and
  collection registry are unchanged by it. (Under the current serialized path such a
  test is already meaningful; under the flag it is required.)

Fail closed as the rest of this ticket does: if this cannot be settled, the flag stays
off, because the flag is what makes the hazard reachable.

## TODO

- Build the gated delegating transactor as a reusable test helper under
  `packages/quereus-plugin-optimystic/test/`, with an `entered` promise and an
  idempotent `release()`.
- Write proof B for session mode and legacy mode, plus every bullet under *Edge
  cases & interactions*.
- Write the engine-level end-to-end (concurrent committed read racing a stalled
  write on one `Database`).
- Settle the *Added arm* above (first-touch committed read's initialize side effects)
  before setting the flag — the flag is what makes it concurrent.
- Only then set `readCommittedSnapshot = true` on `OptimysticModule`.
- Add the `runCommittedReadConformance` + `installCommitStall` spec as standing
  regression cover; assert `observedCommitOverlap`.
- Document in `docs/transactions.md`: what a committed read guarantees under a
  stalled commit, both declarations and their reasons, and the harness blind spot
  (it parks before our publish window, so proof B is the real cover — do not
  delete it in favour of the harness).
- Build then test: `yarn build` at the repo root, then
  `yarn test 2>&1 | tee /tmp/opt-test.log` in
  `packages/quereus-plugin-optimystic`. Keep each stall test's gate release in a
  `finally` so a failing assertion cannot park the suite for the full timeout.
