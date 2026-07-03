description: In the distributed-consensus commit path, a failed or aborted SQL statement's partial rows are not undone, so they can wrongly end up committed; the recent savepoint fix only closed this hole for the single-node path.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts
difficulty: hard
----

# Session-mode statement-level savepoint atomicity

## Background (plain language)

The Optimystic Quereus plugin runs in two modes:

- **Legacy / single-node mode** — the default. DML is staged into an in-memory
  "tracker" and flushed to storage at `COMMIT`. This is what the tests exercise
  (`local` transactor + file storage).
- **Session / distributed-consensus mode** — a host explicitly wires a
  *transaction coordinator* + *engine* (via `TransactionBridge.configureTransactionMode`).
  Here a `TransactionSession` drives a coordinated, validated commit across peers,
  and the **coordinator** owns rollback: on a whole-transaction rollback it
  restores each registered collection's tracker from a snapshot it took at the
  transaction's first action (and replays any interleaved sessions).

## The gap

A companion fix (`optimystic-savepoint-noop-tracker-rollback`) made SQL savepoints
real, so that a failed or aborted statement actually discards the rows it partially
staged instead of leaving them to flush at the next commit. Quereus implements
statement- and row-level atomicity with *internal savepoints* — it wraps each
non-`FAIL` DML statement in a `__stmt_atomic` savepoint and each `OR FAIL` row in a
`__or_fail` savepoint, and rolls back to them on a mid-statement violation.

That fix was **scoped to legacy mode only.** The bridge's `createSavepoint` /
`rollbackToSavepoint` / `releaseSavepoint` are no-ops when a session is active
(gated on `!this.session`), mirroring how whole-transaction rollback defers to the
coordinator in session mode.

The consequence: **in session mode, statement-level atomicity is still broken.**
The coordinator only knows how to roll back a *whole transaction*, not an
individual failed statement. So a mid-statement abort (e.g. the multi-row
`INSERT (2),(1)` where `1` duplicates a PK, default ABORT) leaves the partial row
`2` staged in the tracker, and — because the coordinator reads `tracker.transforms`
at commit — that discarded row would be **pended and committed** by consensus.

This is the *same* defect the companion ticket fixed, surviving in the
distributed path. It is dormant only because session mode requires explicit host
wiring; any host that turns it on and issues a statement that aborts mid-way is
exposed.

## Why it's `debt-` and not `bug-`

Session mode is a supported but opt-in path (no default host in this repo wires it;
it's covered by `session-mode-commit.spec.ts`). The defect is real but only
reachable once a host configures the coordinator — hence dormant. Promote to a
`fix/bug-` if/when a shipping host depends on session mode.

## What a fix likely needs

Statement-level checkpoints inside the coordinator (or the session), so a
`rollbackToSavepoint(depth)` broadcast in session mode reverts the staged
transforms accumulated since that depth — without clobbering the coordinator's
own per-transaction snapshot or its multi-session replay. Two sketch directions:

- Teach the coordinator a depth-keyed checkpoint of each collection's
  `tracker.transforms` (parallel to its existing per-transaction snapshot), and
  restore to it on a savepoint rollback.
- Or let the bridge take over savepoint snapshot/restore in session mode too
  (the same `snapshotPending`/`restorePending` it uses in legacy mode) **iff** it
  can be proven not to corrupt the coordinator's snapshot-replay — the companion
  ticket flagged this interaction as the reason it stayed out of scope.

## Expected behavior once fixed

In session mode, with a unique PK:

```sql
BEGIN;
INSERT INTO t(id) VALUES (1);        -- ok
INSERT INTO t(id) VALUES (2), (1);   -- dup PK -> ABORT: whole statement undone
COMMIT;
SELECT count(*) FROM t;              -- must be 1 (row 2 must NOT be committed)
```

and the `OR FAIL` per-row analogue, must hold under the coordinator commit path,
not just the legacy flush path. Add session-mode regressions modeled on
`test/savepoint-rollback.spec.ts` + `test/session-mode-commit.spec.ts`.
