description: In the default single-node mode, a save that writes a table plus its indexes could fail halfway and leave some trees written and others not, while lying that it "rolled back"; this makes that failure loud and honest instead of silent, and documents the remaining limit.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts, docs/transactions.md, tickets/backlog/feat-optimystic-legacy-commit-two-phase.md
difficulty: medium
----

# Review: legacy-mode commit atomicity across trees

## What this ticket was

Legacy (default, no-coordinator) commit flushes each dirty tree (main table + each
secondary index, or two tables in one SQL transaction) with an independent
`tree.sync()` — its own pend+commit against the transactor. If tree N+1's flush
fails after tree N already committed to storage, trees `1..N` stay durably written
and `N+1..` do not. The old failure path called `rollbackTransaction()`, which
restored the **in-memory** snapshot of **every** dirty tree — including the
already-committed ones. Two bugs resulted:
1. **Split persistence** on disk (unavoidable locally), AND
2. a **false "rolled back"** report: the committed trees' in-memory view was
   reverted so memory disagreed with storage, and the caller was told the
   transaction rolled back when it had not.

## What shipped (the honest-failure minimum)

Per the ticket's "Required (minimum, honest failure)" scope. The larger "preferred"
two-phase restructuring was evaluated and **deferred** — see Gaps below.

- **`txn-bridge.ts`** — new `commitDirtyTreesLegacy()` replaces the blanket
  `for (tree of dirtyTrees) await tree.sync()` loop. It tracks which trees have
  completed `sync()`:
  - **Failure on the first tree** (nothing persisted): re-throws so
    `commitTransaction`'s catch runs the ordinary clean snapshot-restore rollback.
    Unchanged behavior — still all-or-nothing.
  - **Failure after ≥1 tree synced**: restores **only** the trees that never
    touched storage (the failing tree included — its own pend was cancelled), leaves
    the durably-committed trees' in-memory state alone (it matches storage), tears
    down the transaction, and throws a new **`PartialCommitError`** naming persisted
    vs. unpersisted trees. `commitTransaction`'s catch detects `PartialCommitError`
    and skips `rollbackTransaction` (which would re-introduce the divergence).
- **`PartialCommitError`** — new exported error class (loud message: "…was not
  atomic…", lists persisted + unpersisted collection ids + underlying reason).
  Exported from `src/index.ts`.
- **`DirtyTree` interface** — gained optional `describe?()`; `db-core` `Tree` now
  implements `describe()` returning its collection id (used only to name trees in
  the error; falls back to `tree#<index>` if absent).
- **Docs** — loud blockquote at the top of `docs/transactions.md` (§ "Legacy
  (single-node) commit is not atomic across trees") + a loud comment at the
  `txn-bridge.ts` commit site.
- **Backlog** — `feat-optimystic-legacy-commit-two-phase.md` filed for the deferred
  narrowing, with the full feasibility analysis.

## How to validate

Build order matters — plugin tests run against `dist/`:
```
yarn workspace @optimystic/db-core run build
yarn workspace @optimystic/quereus-plugin-optimystic run build
```
Run the focused spec:
```
cd packages/quereus-plugin-optimystic
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/legacy-commit-atomicity.spec.ts" --reporter spec --exit
```
Full plugin suite (streams; ~3 min): swap the glob for `"test/**/*.spec.ts"`.

**Results observed:** focused spec 2/2 passing; full suite **293 passing, 11
pending, 0 failing**. Plugin `typecheck` exits 0.

### New test: `legacy-commit-atomicity.spec.ts`

Uses a real `FileRawStorage`-backed `StorageRepo` wrapped by an **injected
transactor** (registered under the `local:test` cache key via
`collectionFactory.registerTransactor`) that **throws** a targeted `commit` — keyed
off the log-tail block id so it targets a specific collection. Throwing (not
returning `{success:false}`) makes the sync fail fast instead of paying ~10 backoff
retries.

- **Second-tree failure** (main persists, index commit throws): asserts
  - `select count(*)` in-session = **2** (main NOT silently reverted; pre-fix = 1),
  - error message contains **"not atomic"** (survives the module's `Commit
    transaction failed: …` wrapping),
  - index tree still holds only 1 entry (reverted in-memory, never persisted),
  - **reopen** shows main = 2 (the honestly-surfaced split).
- **First-tree failure** (main commit throws, nothing persists): asserts clean
  rollback — count stays 1, error does **NOT** contain "not atomic", reopen = 1.

Why these are discriminating: on pre-fix code the second-tree case reverts main
in-memory → in-session count would be 1 and no `PartialCommitError` → both key
assertions fail. (I did not run pre-fix to confirm empirically — I must not revert
the working tree via git — but the assertions target exactly the two documented
bug symptoms.)

## Gaps / things a reviewer should scrutinize

- **Two-phase narrowing deferred, not done.** The residual window still exists: a
  commit-sweep failure after the first tree is still a real on-disk split (now
  loud). The common failures (conflict/validation at pend) are NOT yet moved before
  the first durable commit — that's the deferred `feat-` ticket. Confirm the
  deferral is acceptable and the backlog ticket captures it well.
- **Only the main-table + secondary-index shape is tested.** The ticket also names
  "two tables in one txn" — not covered by a dedicated test (the mechanism is
  identical: two dirty trees in `dirtyTrees`). Reviewer may want a two-table case.
- **Assumption: Quereus does not call `xRollback` after a failed `xCommit`.** My
  inline cleanup sets `isActive = false`; if Quereus DID call rollback afterward,
  `rollbackTransaction` would throw "No active transaction". The suite passing
  suggests it does not (and the pre-existing code had the same assumption), but this
  is worth a deliberate look — it's a control-flow assumption, not a proof.
- **Failure injection is tail-id based.** Robust as long as each collection's sync
  commits under a stable, distinct tail id (true today). If a single collection's
  sync ever issued commits under differing tails, the "second collection" targeting
  could mis-fire. Not a product concern — a test-harness caveat.
- **`PartialCommitError` carries `reason` (not the standard `Error.cause`).** Chose
  an explicit field to also expose `persisted`/`unpersisted` arrays for
  programmatic reconciliation. Confirm that's the desired shape for hosts.
- **No automatic reconciliation** of a surfaced split — by design (local mode can't
  un-commit). The error hands that to the caller/operator. Confirm that's the
  intended contract.

## Tripwire noted (parked, not a ticket)

- The savepoint snapshot cost note already living in `txn-bridge.ts` (`savepoints`
  doc: O(collections × staged-transforms) per statement) is untouched by this work
  and remains a valid conditional concern. No new tripwire was introduced by this
  change.
