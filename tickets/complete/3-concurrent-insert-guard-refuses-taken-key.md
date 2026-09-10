description: When two writers inserted a row with the same primary key at the same moment, both were told they succeeded and only one row survived. The losing insert now fails with the ordinary duplicate-key error so applications find out and can retry. Reviewed and complete.
files: packages/db-core/src/collections/tree/struct.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/collection.ts, packages/db-core/test/tree-guard.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/test/concurrent-insert-refusal.spec.ts, docs/internals.md
----

# Complete: concurrent insert guard refuses a taken key

## What landed

A staged tree entry can now carry a serializable guard stating the SQL statement's intent (`TreeEntryGuard` in `packages/db-core/src/collections/tree/struct.ts`): `absent` (INSERT — a present key throws the new `TreeKeyTakenError`), `keepExisting` (INSERT OR IGNORE — skip silently), `absentRange` (reserved for the secondary-unique follow-up; refused loudly until then). The tree's `replace` handler enforces the guard on every run — initial staging and every conflict replay — so the uniqueness decision is re-made against the newest adopted committed state, and a losing concurrent writer is refused instead of silently overwriting the winner. A missing guard keeps plain upsert semantics, so existing callers and previously committed log entries replay unchanged.

The Quereus vtab stages the guard from the resolved conflict action (ABORT/FAIL/ROLLBACK → `absent`; IGNORE → `keepExisting`; REPLACE → unguarded), including the insert half of a PK-moving UPDATE. The bridge (`mapCommitRefusal` in `txn-bridge.ts`) rewraps a `TreeKeyTakenError` at both commit modes' failure exits into the exact `UNIQUE constraint failed: <table>.<col>[, …]` message a sequential duplicate INSERT produces, keeping the structured error as `cause`, so downstream classifiers need no new arm.

One forced db-core fix: `Collection.restorePending` now detects that the committed boundary moved under the snapshot (a rival's commit adopted by a refresh mid-transaction) and, for an empty-pending snapshot, resets the tracker empty instead of reinstalling stale transforms — restoring them verbatim made every later read on the loser's handle descend an empty tree.

Docs: `docs/internals.md` § "Conflict replay re-makes the uniqueness decision (entry guards)". Follow-up `concurrent-secondary-unique-guard` sits in implement/ with a prereq on this slug and consumes the `absentRange` shape defined here.

## Review findings

**What was checked.** The full implement diff (`fd24a844`) read fresh before the handoff summary: the guard type and handler enforcement, the `TreeKeyTakenError` shape and its non-retryability, the `restorePending` boundary logic against every capture shape enumerable from `snapshotPending` (invented collection, committed-clean, pending-carrying), the vtab's INSERT and PK-move UPDATE guard resolution against `resolveConflictAction`/`resolvePkMoveDecision` (including the swallow/blocked early returns that never stage), the bridge mapping's idempotence and both commit-mode exits, both new test suites, the docs section, and the board arms the implementer filed. Validation re-run in this pass, all green: db-core 1613, quereus-plugin-optimystic 717 (+smoke), db-p2p 2646, root typecheck, `yarn lint:docs`. Env-gated integration and long-test tiers not run (repo convention: out of agent budget).

**Major findings: none.** The design landed as specified and the enforcement point (the replace handler, inside the all-or-nothing Atomic wrapper, not absorbed by any retry loop) is the right choke point; both refusal paths (leading refresh and stale-retry refresh) and the coordinator path are pinned by deterministic tests driven by a real competing writer.

**Minor findings, fixed in this pass:**
- The one untested mapped exit — a LEGACY multi-table transaction whose refusal fires mid-sweep, after an earlier table durably committed — now has an end-to-end test (`concurrent-insert-refusal.spec.ts`, "refusal MID-SWEEP"): the `PartialCommitError` reaches the client naming the mapped `UNIQUE constraint failed: T.id` as its underlying failure, the first-swept table's insert really persisted, and the rival's row survives.
- The handoff flagged (without a site marker) that a live SELECT inside a doomed transaction can surface the refusal early, wrapped as `Query failed: …` rather than the mapped UNIQUE message. That is a tripwire, not a defect (never silent; the commit would refuse anyway); a `NOTE:` now sits at the exact site (`optimystic-module.ts`, `runQuery`'s catch) saying when and how to map it if clients ever need the two shapes to match.

**Tripwires (recorded at their sites, indexed here):**
- Live-read early refusal message shape — `NOTE:` at `runQuery`'s catch (above).
- A snapshot carrying pending actions across a moved committed boundary still restores verbatim (rebasing needs an async replay a sync method cannot run) — `NOTE:` in `restorePending`'s doc comment; pre-existing shape, not a regression.

**Considered and not filed, with reasons:**
- Concurrent UPDATE lost-update / delete-resurrection: a non-moving UPDATE replays as an unguarded upsert, so a rival's concurrent UPDATE or DELETE of the same row is last-writer-wins at replay. Not filed: this is the system's documented merge-by-replay model (docs/internals.md states snapshot isolation is opt-in via `queryCommitted()`; docs/correctness.md covers write-write detection at block granularity), it violates no declared SQL constraint — unlike the INSERT case this ticket fixed — and the open decision ticket `feat-phantom-read-protection` already asks the neighbouring "is the current stale-read model the intended isolation level" question of a human.
- The `keepExisting` stale-index-entry anomaly on INSERT OR IGNORE: already appended by the implementer as an arm of backlog ticket `6-debt-index-sweep-misses-update-delete-and-orphans`, with a `NOTE:` at the staging site — verified present, nothing to add.
- Mixed-version peers silently ignoring guards: covered by the existing backlog ticket `debt-mixed-version-identify-incompatibility`, referenced from the `TreeEntryGuard` doc comment — verified present.
- The guard's extra `find(key)` before `upsert` costs one additional B-tree descent per guarded entry per handler run: per-row DML cost, not measured because there is no plausible profile where it registers; not even NOTE-worthy.

**Accepted test gaps (documented, deliberate):** the "writer several revisions behind" loop shape has no deterministic harness (`TestTransactor` refreshes fully in one round) and is bounded by the existing retry/stall budgets; an SQL-level concurrent delete+reinsert race is unassertable without flakiness (sequential cross-handle and deterministic db-core stale-view variants cover it); two session-mode handles over one directory are untested at the SQL level (the coordinator-vs-real-rival shape is pinned at the db-core level, and the rival's commit mode is irrelevant to the loser's refusal).

**Outside this repo (for the human):** `../sereus/tickets/blocked/optimystic-concurrent-same-pk-insert-silent-lww.md` unblocks on this landing — rebuild `../optimystic` there and re-run its measurement. The refusal reuses the existing `UNIQUE constraint failed:` message shape, so sereus's `control-write-retry.ts` classifier (permanent refusal, zero retries) should need no new arm — verify rather than assume.
