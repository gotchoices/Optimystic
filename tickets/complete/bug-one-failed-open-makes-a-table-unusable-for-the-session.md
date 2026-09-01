description: A table whose very first read failed for a passing reason — a brief network hiccup, a storage node answering late — used to keep replaying that same stale error for the rest of the session. It now retries on the next statement, and one further way a failed open could poison a table has been closed too.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/init-retry-after-transient-failure.spec.ts, docs/internals.md
----

## What shipped

**From the implement stage** (commit `3985315f`, three edits in
`packages/quereus-plugin-optimystic/src/optimystic-module.ts` plus a new spec):

- `initialize()` no longer memoizes its own rejection. The attempt is built as a local and
  chained with a `.finally()` that clears `initializationPromise` under an identity check,
  so callers already waiting still share the one attempt while the next *statement* is free
  to retry. Same shape `initializeForCommittedRead` already used for its provisional pass.
- `declaredColumns` is captured in the constructor and drives `doInitialize`'s schema
  branch, replacing a read of `this.tableSchema.columns.length` that the load branch itself
  populates — so a second pass could no longer take a different branch than the first.
- `setErrorMessage(undefined)` at the top of `doInitialize`, so a successful retry wears no
  message from the attempt that failed.

**Added during review** (see findings below):

- `doInitialize` builds `collection`, `rowCodec`, `indexManager` and
  `uniqueEnforcementIndexes` as locals and publishes them in one synchronous step after the
  last `await`, so a pass that throws part-way leaves the previous pass's state untouched.
- `guardStorageAdoption` takes the collection it probes as a parameter instead of reading
  `this.collection`, which it could only do because its caller happened to have assigned
  that field a few lines earlier.
- Two new tests, and a new `docs/internals.md` section stating the retry rule.

## Review findings

### Major — found and fixed in this pass

**A full initialization pass that failed part-way left a half-built `IndexManager` on the
table, and every index-driven plan against that table was then refused at plan time for the
rest of the session.** Reproduced, not inferred.

`doInitialize` assigned `this.rowCodec` and `this.indexManager` as it built them, so a pass
that threw inside `indexManager.initialize()` — which opens index trees over the network,
exactly the transient failure this ticket is about — left an `IndexManager` that was
constructed but whose trees never opened. `indexMaintenanceState` reads that as
`'unmaintained'`, and `OptimysticModule.assertIndexMaintained` refuses the plan:

```
QuereusError: Table 't' does not maintain index 'ix': the catalog offers it to query
planning, but this table instance's writes do not keep it up to date …
```

That refusal happens at **plan time**, before the vtab's `query()` runs, so no amount of
re-initialization downstream rescues it — the table stayed unusable through any index until
some non-index query happened to run a successful full pass.

The implement stage's own `NOTE:` at the field-replacement site named this failure face and
judged it unreachable ("needs a successful provisional init, an in-flight committed scan,
AND a full pass failing in that window"). That judgement was correct *before* the diff and
stopped being correct *because of* it: clearing the rejected memo removed the rejected
promise that `initializeForCommittedRead` used to hand back, so a later committed read
arriving while a writer is active now short-circuits on `isProvisionallyInitialized` onto
whatever the failed pass left standing — no concurrent scan required.

Fixed by publishing the four fields in one synchronous step after the last `await`. Pinned
by a new test, `a committed read after a FAILED full pass is not poisoned by what that pass
half-built`, which fails on the pre-fix code with the error quoted above. The `NOTE:` was
rewritten to say the failure face is closed and the success face (a *successful* rerun
swapping the fields under an in-flight scan) is still the standing tripwire.

*Why fixed inline rather than filed:* the site is inside the diff under review, the defect
was introduced-and-widened by it, and the fix is one reordering in one method.

### Minor — found and fixed in this pass

**A hidden ordering dependency: `guardStorageAdoption` read `this.collection`.** It calls
`hasNoRowsToBackfill()`, which reads `this.collection` — and it runs mid-initialization,
relying on `doInitialize` having assigned that field a few lines earlier. Deferring the
assignment (above) turned the emptiness probe into "no collection, so no rows", which
silently disarmed the storage-adoption refusal. The existing `a deterministic refusal fails
identically on the retry` test caught it immediately. `guardStorageAdoption` now takes the
collection as a parameter and `hasNoRowsToBackfill` accepts one (defaulting to the published
field, so its two post-init callers are unchanged).

### Test gaps from the handoff — one closed, three left standing with reasons

The implement ticket was honest about four gaps. Disposition:

- **"No positive test for the upgrade delta itself."** *Closed.* Added `a provisional→full
  upgrade of a column-less open stays on the load branch and writes no schema`, which drives
  a provisional pass (committed read with a writer transaction active) and then the full
  upgrade, spying on `SchemaManager.tableSchemaToStored` — the one call only the DDL-wins
  branch makes. Verified it is not vacuous: reverting `declaredColumns` to the old
  `this.tableSchema.columns.length > 0` fails this test *and* the handoff's late-failure
  test, and nothing else.
- **The late-failure test drives `module.connect(...)` by hand** rather than reaching the
  column-less branch through SQL. *Left as is.* I could not construct a SQL path that
  reaches a column-less open deterministically either; the hand-driven connect is the honest
  way to pin a branch selector, and the spy asserts the branch rather than the symptom.
- **Concurrency is single-process and cooperative.** *Left as is.* The two "in flight" tests
  rely on Node's deterministic microtask ordering; they prove the memo is shared and prove
  nothing under real parallelism. Closing this needs a genuinely parallel harness, which is
  a different piece of work from this bug.
- **`initializeForCommittedRead`'s "same microtask" comment.** *Verified, unchanged.* The
  async IIFE still starts executing synchronously and `.finally()` is attached to it
  afterwards, so nothing was inserted before `doInitialize`'s `getCurrentTransaction()`.
  With no provisional pass to await, that call is still reached in the microtask that
  sampled `isTransactionActive()`.

### Checked and found nothing

- **Is `declaredColumns` ever stale?** `this.tableSchema` is reassigned twice
  (`attachPersistedUniqueConstraints`, `mirrorDerivedUniqueConstraint`); both spread the
  existing object and replace only `uniqueConstraints`, never `columns`. And
  `instantiateTable` returns a cached instance without adopting a later connect's schema, so
  a cached table's declaration cannot change under it. The capture is sound.
- **Are there other memoized promises that could memoize a rejection?** Grepped the whole
  repo: `initializationPromise` and `provisionalInitPromise` are the only two, and both
  clear in a `finally`. There is no wider class here, so nothing to file at the
  types/property/invariant rungs.
- **Does anything read `VirtualTable.errorMessage`?** Re-confirmed nothing in the Quereus
  engine does; clearing it is diagnostics-only, as the handoff said.
- **Does the schema-write delta lose the one-time uniqueness-metadata migration?** On a
  column-less open the first pass already took the load branch and wrote nothing, so that
  migration only ever ran on the accidental double-pass. `attachPersistedUniqueConstraints`
  derives the constraints in memory on every open, so enforcement never depended on the
  write. Full suite agrees.
- **`ensureChangeSubscription` self-isolation**, which the failed-pass reasoning leans on:
  it catches and logs internally, so it cannot throw after `isInitialized` is set.

### Accepted tradeoffs respected

The un-damped-retry `NOTE:` at `initialize()` records a deliberate decision with a revisit
condition (initialization storms against a dead cohort showing up in profiles; damp in the
transactor layer, not here). That condition has not tripped and nothing about the
surrounding facts changed, so it was not re-litigated or re-filed.

### Tripwires

- **Kept, rewritten:** the field-replacement `NOTE:` at the end of `doInitialize`. Its
  failure face is now closed by the atomic publish; its success face — a *successful* rerun
  swapping `rowCodec`/`indexManager` under a committed scan that is still iterating — stands
  as before, harmless while both passes resolve the same schema, with the fix named (a scan
  capturing both as locals alongside its pinned views) for whenever concurrent DDL becomes
  real.
- No new tripwires were opened.

### New tickets filed

**None.** Both findings resolved at sites inside the diff under review, and neither has a
class behind it that a type, property test or boundary invariant would retire — the
"publish rebuilt state atomically" rule now lives as a comment at the one method that
rebuilds state and as a paragraph in `docs/internals.md`.

Evidence *was* appended to an existing open ticket:
`tickets/backlog/debt-optimystic-vtab-class-is-too-big-to-review` (found by the site-claim
grep) now records `wc -l` = **3782** for `optimystic-module.ts`, up from the 3691 measured
on 2026-08-30, along with the observation that this review's central question — whether a
failed pass leaves coherent state — required reading four concerns that live in that one
class, and that one of them was the hidden `this.collection` dependency fixed above.

### Docs

Docs were treated as out of date until read. `docs/internals.md` and `docs/transactions.md`
describe first-touch and provisional initialization accurately and made no claim about
failure memoization, so nothing was wrong — but the retry rule is a durable behavioural
contract with two non-obvious consequences, so `docs/internals.md` gained a section, **"A
failed first open is retried, not remembered"**, covering the memo's in-flight-only
lifetime, the deliberate absence of damping, and the rule that a rerun must be
indistinguishable from a first run (which is what both the `declaredColumns` capture and the
atomic publish exist to hold).

## Validation

All from `packages/quereus-plugin-optimystic` unless noted, all in the foreground:

- `yarn lint` (repo root, `eslint .`) — clean.
- `yarn build` — clean.
- `yarn typecheck` — exit 0.
- `yarn test` — **692 passing, 13 pending, 0 failing**, plus `test:smoke` ok. Baseline
  before any review edit was 690/13/0; the two added tests account for the difference.

Negative checks run this session, not just asserted:

- Reverting `this.declaredColumns` to `this.tableSchema.columns.length > 0` fails both
  branch tests and nothing else.
- The new poisoned-state test fails on the pre-atomic-publish code with the
  `does not maintain index 'ix'` error.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

Not run: the other workspaces' suites and `test:integration`. The change is confined to
`quereus-plugin-optimystic`, and repo-wide lint and this package's full suite cover it.
