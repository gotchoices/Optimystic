description: Fixed a bug where opening a database table partway through a SQL statement, then having that statement fail, left the rows it had already written in that table instead of discarding them.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`registerCollection` ~353-395; `savepoints` field doc ~256-300; `createSavepoint` ~940-965; `rollbackToSavepoint` ~975-990)
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts (describe `registerCollection tops up open savepoints for late-registered collections`, inside `savepoint operations`, ~680-880)
----

# What shipped

`TransactionBridge.createSavepoint(depth)` captures the staged state of every
collection registered *at that moment*. A collection registered afterwards — a
table that finishes initializing mid-statement — was invisible to that savepoint,
so a mid-statement failure left its rows staged to flush at the next commit
instead of being discarded. Legacy (staged-tracker) mode only, which is the
default.

`registerCollection` now tops up every currently-open savepoint with a capture of
the collection being registered. Sound because registration always precedes any
DML staged into that collection, so the capture never records dirty state as
"before". Keyed by object identity, not collection id, so a new instance
registered under an already-known id (a table re-initializing mid-transaction)
gets its own capture without disturbing the old instance's.

Session mode is unaffected — `createSavepoint` returns early there, so the top-up
loop runs over an empty map. Statement-level atomicity in session mode remains a
separately filed gap (`backlog/debt-optimystic-session-mode-statement-savepoint-gap`).

# Review findings

## Checked

- **Every ordering of the top-up.** First registration; late registration with one
  and with two open depths; repeat registration of the same instance after it
  staged rows; a different instance registered under a known id; a repeated
  `createSavepoint(depth)` broadcast landing after a late registration staged
  rows; release vs. rollback.
- **Interactions.** `createSavepoint`'s per-depth dedup, `rollbackToSavepoint`'s
  "restore target, drop savepoints above", `releaseSavepoint`, `dirtyTrees`, the
  session-mode early return, and the three teardown paths (commit, rollback,
  begin) — all of which clear `savepoints`, so no capture outlives its transaction.
- **Resource cleanup.** Savepoint maps hold `Collection` instances strongly. An
  instance swap adds at most one extra entry per re-initialization, and every
  teardown path clears the whole map, so there is no unbounded retention.
- **Docs.** `docs/transactions.md` and `docs/internals.md` are the only files that
  mention savepoints at all; neither makes a claim about *which* collections a
  savepoint covers (transactions.md lists `savepoints` in a thread-safety table,
  internals.md describes the broadcast path). Nothing went stale, so no doc file
  needed editing. `node scripts/check-doc-citations.mjs` clean.
- **Consistency with the sibling coordinator fix** (commit `5bae4df9`). Different
  mechanism — the coordinator reconciles lazily on every `applyActions`, the
  bridge pushes at registration — but the same invariant and the same
  instance-keyed snapshot map. The bridge has no per-operation hook to reconcile
  from, so push-at-registration is the right shape here rather than a shared
  helper.

## Found and fixed in this pass (minor)

- **The `known === collection` guard's doc comment overstated it.** The implement
  handoff flagged this as uncertain; it is confirmed redundant. Nothing anywhere
  removes an individual entry from an open savepoint's map, so a re-registered
  known instance always already has an entry at every open depth and the
  `!snapshots.has(collection)` check would skip it regardless. Kept the guard (it
  is a cheap fast path; `reconcileMaintainedIndexes` re-registers open index trees
  once per statement) but reworded the comment from "load-bearing" to "fast path
  only", and moved the actual rationale onto the `has` check where it belongs.
- **The `savepoints` field doc called the top-up capture "clean".** Misleading: a
  collection invented by `Collection.createOrOpen` carries header and log blocks
  in its tracker from construction, and both capture paths record those. Reworded
  to "holds no staged DML", with an explicit paragraph noting that a rollback
  therefore returns such a tree to readable-but-unwritten rather than destroying
  it.
- **Test gaps — three tests added.** The four implement-stage tests all assert
  only that the pending queue empties, which a broken `restorePending(EMPTY)`
  implementation would also satisfy; and neither the release path nor the repeated
  per-connection broadcast was exercised. Added:
  - `rewinds a late-registered collection to its capture, not to empty` — asserts
    the invented collection's structural baseline (`hasUnsyncedChanges()`)
    survives the rollback while the DML is discarded.
  - `keeps a late-registered collection staged when the savepoint is RELEASED` —
    release must absorb, never restore.
  - `does not re-capture a late-registered collection on a repeat createSavepoint
    at the same depth` — pins the interaction between the top-up and
    `createSavepoint`'s depth dedup, which is what stops the second connection's
    broadcast recording already-dirty state as "before".

## Major findings

None. No new tickets filed. The fix is minimal, the invariant it relies on
(registration precedes staging) holds at both call sites
(`optimystic-module.ts:1576` during init and `:2878` in
`reconcileMaintainedIndexes`), and no ordering was found in which the top-up
captures dirty state.

## Tripwire (recorded, not filed)

Rolling back to a savepoint does **not** un-create a tree that was invented while
that savepoint was open — `CREATE INDEX` inside an explicit transaction leaves the
new tree's structural blocks staged even if the statement rolls back. Not a
regression (before this fix the tree was not in the savepoint at all), and
harmless today because `addIndex`'s backfill flushes those trees eagerly, so the
create is already durable by the time a rollback could reach it. Parked as a
`NOTE:` on the `savepoints` field doc in `txn-bridge.ts`, with the condition that
would make it real: if DDL ever becomes savepoint-reversible, capture invented
trees as absent instead.

## Pre-existing, examined and deliberately left alone

- `rollbackToSavepoint` does not prune `dirtyTrees`, so a collection emptied by a
  savepoint rollback still appears in the legacy commit sweep. Verified harmless
  rather than assumed: `Collection.syncAttempts` loops on
  `while (this.hasUnsyncedChanges())`, so a collection with no remaining
  transforms syncs as a no-op. The one case where transforms *do* remain is the
  invented-tree case recorded as the tripwire above.
- `guardIndexAdoption` (`optimystic-module.ts:2618`) opens an index tree with the
  create-on-missing path and never registers it with the bridge. The tree is a
  throwaway probe that is never synced, so nothing it stages can reach storage.

Both predate this diff and neither produces a wrong result.

# Validation

Run from `packages/quereus-plugin-optimystic`, foreground, no redirection:

- `npx tsc --noEmit -p tsconfig.json` — clean.
- `yarn build` (tsup, ESM + DTS) — clean.
- `npx eslint` over both changed files — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min --timeout 20000 --exit` — **699 passing, 13 pending, 0 failing** (696 before this review's three added tests; the 13 pending are pre-existing and unrelated).
- `node scripts/check-doc-citations.mjs` from the repo root — all 45 documents resolve.

# Honest limits

No end-to-end SQL repro exists. Coverage stops at the bridge-level invariant,
because forcing the `initializeForCommittedRead` then `xUpdate` timing from actual
SQL is unreliable. The bridge tests faithfully reproduce the registration ordering
the bug report describes, but that the ordering occurs in production traffic
remains a static inference from reading the code, not something anyone has
observed live.
