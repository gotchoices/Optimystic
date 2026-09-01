description: A table whose very first read failed for a passing reason — a brief network hiccup, a storage node answering late — used to keep replaying that same stale error for the rest of the session. It now retries on the next statement, and this is the review of that fix.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/init-retry-after-transient-failure.spec.ts
----

## What landed

Three edits in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`, plus one new
spec. All of it is already committed — the runner committed the prior (interrupted) run's
work as `3985315f`; this run verified it and re-ran the full validation. `git diff` against
that commit is empty; review the commit, not the working tree.

**1. `initialize()` no longer memoizes its own rejection** (`~:347-393`). The body is now
built as a local `attempt`, chained with a `.finally()` that clears
`this.initializationPromise` (guarded by an identity check), and only then assigned and
returned. Same shape `initializeForCommittedRead` already used for its provisional pass.
Callers arriving while the attempt is in flight still share the one object; only the
settled-rejection case changed. Every cold-table entry point routes through this one
method — the live-read scan branch, DML, `addIndex` — so no per-caller change was needed.

**2. `declaredColumns` captured in the constructor** (`~:275-284`, `~:324`), read at the
branch selector in `doInitialize` (`~:500`) in place of `this.tableSchema.columns.length > 0`.
The load arm of `doInitialize` populates that column list itself, so re-reading its length
inside made a second pass take a *different* branch than the first — the local-DDL-wins arm,
which can write the schema where the first pass intended a read-only load.

**3. `setErrorMessage(undefined)` at the top of `doInitialize`'s `try`** (`~:467`), so a
successful retry leaves no trace of the failed attempt. Diagnostics only — confirmed again
that nothing in the Quereus engine reads `VirtualTable.errorMessage`.

Plus two comment-only changes: the accepted-tradeoff `NOTE:` for un-damped retry, at
`initialize()`; and the extended field-replacement `NOTE:` at `~:659` (tripwire, below).

Per the ticket's resolution, **no eviction was added to `resolveConnectedTable`** — in-place
retry re-enters `initialize()` on the cached instance and rebuilds, so there is no poisoned
instance to evict. `create()`'s pre-existing eviction is untouched.

## Validation actually run (this session, from `packages/quereus-plugin-optimystic`)

- `yarn build` — clean.
- The new spec alone: **7 passing**.
- `yarn test` (full package suite, ~3m): **690 passing, 13 pending, 0 failing**, plus
  `test:smoke` ok.
- `yarn typecheck`: exit 0.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

The prior run also did the negative half, which is the part worth trusting the spec on:
reverting **only** the memo-clearing turns 4 of the 7 into failures; reverting **only** the
`declaredColumns` capture turns the late-failure test into a failure. Both edits are pinned
by tests that fail without them. I did not re-run those revert experiments this session.

## How to exercise it by hand

The spec `test/init-retry-after-transient-failure.spec.ts` is the use-case document. Its
harness wraps a `MemoryRawStorage` + `StorageRepo` transactor in a gate whose `get` throws
while a predicate matches the block ids being read, then heals by clearing the predicate.
Because a collection's header lives under its own collection id (the URI path — `tree://x`
becomes `x`, an index tree becomes `x/index/ix`), the gate can choose the **depth** at which
initialization fails: before `this.collection` is assigned, or well after `collection` and
`rowCodec` already are.

The seven cases:

- **connect path heals** — the same `select` against the same table on the same `Database`
  fails, then succeeds after healing. Before the fix the second attempt replayed
  `Failed to initialize Optimystic table: <original error>`.
- **create path heals** — `create table` fails under the gate; re-issuing it after healing
  succeeds (that instance was evicted, so it recovers by a different mechanism than above).
- **two in-flight first touches share ONE successful initialization** — counted through a
  wrapper on `collectionFactory.createOrGetCollection`. This is the behaviour the memo
  exists for and the easiest thing to break while fixing the rejection case.
- **two in-flight first touches share ONE failing initialization, and a later touch
  retries** — both callers see the error, the memo is clear afterwards.
- **a healed table serves a committed read** without starting a redundant provisional pass
  (guards the `isInitialized`-before-`initializationPromise` ordering in
  `initializeForCommittedRead`).
- **a deterministic refusal fails identically on the retry** — a storage-adoption refusal
  does not become an accidental success on the second try.
- **a retry after a LATE failure keeps the load branch** — the `declaredColumns` regression
  test.

## Behaviour delta, stated explicitly (the implement ticket asked for this)

On the provisional-to-full upgrade of a **column-less** connect, the full pass used to see
the columns the provisional pass had loaded, take the local-DDL-wins arm, and potentially
write the schema back. With `declaredColumns` captured at construction it now takes the load
arm and writes nothing — matching what an ordinary (non-upgrade) hydrate open already does.

**No spec depended on that write.** The full 690-test package suite passes unchanged,
including the uniqueness-metadata specs that were the plausible candidate. I did not find a
spec asserting the write either directly or by side effect. A reviewer who wants to
double-check the migration angle should look at the one-time uniqueness-metadata migration
described around `optimystic-module.ts:530` and at `secondary-unique-hydrate.spec.ts`.

## Tripwire parked (no ticket, per the implement ticket's instruction)

Extended the existing field-replacement `NOTE:` at `optimystic-module.ts:~659` with the
failure face: a full pass that throws between the `indexManager` assignment and its
`initialize()` leaves an **uninitialized** `IndexManager` on a table a concurrent committed
scan may still be reading (scans re-read `rowCodec`/`indexManager` per row). Not reachable
today — it needs a successful provisional init, an in-flight committed scan, *and* a full
pass failing in exactly that window. The note names the fix (a scan capturing both as locals
alongside its pinned views), which closes the success face and the failure face at once.

## Known gaps — treat the tests as a floor

- **The late-failure regression test drives `module.connect(...)` by hand** with a
  column-less placeholder `TableSchema` built from the hydrated catalog entry, rather than
  reaching that branch through SQL. That is the only way I found to force a column-less open
  deterministically, but it means the test asserts the branch selector rather than a
  user-visible path. It spies on `SchemaManager.tableSchemaToStored` — the one call only the
  DDL-wins arm makes — because counting schema *writes* alone would be a symptom test that
  passes for the wrong reason whenever the persisted schema round-trips exactly.
- **No positive test for the upgrade delta itself.** Nothing asserts that a
  provisional-to-full upgrade of a column-less connect now writes no schema. The delta is
  argued from the branch selector and from a green suite, not pinned by a test.
- **Concurrency is single-process and cooperative.** The "in flight" tests issue two
  un-awaited statements and rely on Node's deterministic microtask ordering. They prove the
  memo is shared; they do not prove anything under real parallelism.
- **`initializeForCommittedRead`'s "same microtask" comment** (`~:440`) still holds — the
  async IIFE starts executing synchronously and `.finally()` is attached after it, so
  nothing was inserted before `doInitialize`'s `getCurrentTransaction()`. Worth a reviewer's
  eye since the fix touches exactly that construction.
- **Un-damped retry is a deliberate accepted tradeoff**, recorded as a `NOTE:` at
  `initialize()` with its revisit condition (initialization storms against a dead cohort
  showing up in profiles, and the damping belongs in the transactor layer). Do not re-file it.
- **Docs unchanged.** `docs/internals.md` and `docs/transactions.md` describe first-touch and
  provisional initialization but make no claim about failure memoization, so there was
  nothing to correct. A reviewer may still judge the retry rule worth a sentence in
  `docs/internals.md`.
