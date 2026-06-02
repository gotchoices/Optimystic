----
description: Review the Quereus external/remote-change → watch invalidation API (Database.notifyExternalChange) added in the sibling Quereus repo, consumed by the optimystic vtab reactive-watch bridge
files: ../quereus/packages/quereus/src/core/database.ts, ../quereus/packages/quereus/src/core/database-watchers.ts, ../quereus/packages/quereus/src/runtime/delta-executor.ts, ../quereus/packages/quereus/test/external-change-watch.spec.ts
----

# Review: Quereus external change → watch invalidation API

> **Cross-repo notice.** All implementation in this ticket lives in the **sibling
> Quereus repo** at `C:\projects\quereus` (branch `view-updates-lens`), consumed
> by optimystic via the portal resolution
> `@quereus/quereus: portal:../quereus/packages/quereus`. The change is additive
> and backward-compatible. The downstream consumer is
> `optimystic-vtab-reactive-watch-bridge` (ticket #2 in implement/), which calls
> `db.notifyExternalChange(tableName, schemaName)` from the vtab's
> collection-change subscription.

## What was built

A coarse, table-granular watch invalidation that fires every active watcher whose
scope includes a given base table **without a local commit**, so a vtab backed by
a replicated/external store can translate a remote write into a Quereus watch
invalidation. The local commit change-log path
(`runPostCommit` → `DeltaExecutor.runAll`) is bypassed entirely — the manager
synthesizes a global `apply` directly against each matching subscription.

### Public API (`Database`)

```ts
notifyExternalChange(tableName: string, schemaName?: string): Promise<void>;
```

- `schemaName` defaults to `schemaManager.getCurrentSchemaName()`.
- Lowercases + joins to the `schema.table` key (`main.t`) used throughout the
  watcher subsystem.
- A no-op when no subscription matches; never throws on handler errors (mirrors
  `runPostCommit`); async because handlers may be async and are awaited.
- Signature deliberately leaves room for a future optional 3rd `changedKeys` arg
  (precise key-scoped variant) without breaking callers — **not** implemented now
  (coarse-by-design; see ticket rationale).

### Implementation seam

- `delta-executor.ts` — **unchanged**. `DeltaSubscription` already exposes
  `relationToBase` and `apply`, and `DeltaApplyInput` is already exported, so no
  kernel change was needed.
- `database-watchers.ts`:
  - `ActiveSubscription` gained `readonly delta: DeltaSubscription`, captured in
    `watch()` from the `subscriptionFromChangeScope` result.
  - New `WatcherManager.notifyExternalTableChange(fqName)`: snapshots matching
    subscriptions (`tables.has(fqName)`), mints a txnId in a try/finally that
    resets it, and for each match builds a `DeltaApplyInput` where every relKey in
    `delta.relationToBase` mapping to `fqName` is in `globalRelations` (empty
    `perRelationTuples`), then `await delta.apply(input)` with per-subscription
    error isolation. Skips `entry.disposed` entries.
- `database.ts`: `notifyExternalChange` wrapper — `checkOpen()`, resolve schema,
  delegate to the manager.

This reuses the existing `apply` global branches in `subscriptionFromChangeScope`:
`full` ⇒ fires with empty `hits`; `rows`/`rowsByGroup` ⇒ surfaces all registered
`literalValues`; `groups` ⇒ fires with empty hits.

## Validation performed (this is the floor, not the ceiling)

- **Typecheck:** `yarn typecheck` (packages/quereus) — clean.
- **Lint:** `eslint` on the 3 changed/added files — clean.
- **Build:** `yarn build` (tsc) — clean; confirmed `notifyExternalChange` /
  `notifyExternalTableChange` present in `dist/src/core/database.{js,d.ts}` and
  `database-watchers.{js,d.ts}`.
- **New tests** (`test/external-change-watch.spec.ts`, 10 cases, all passing) —
  these are integration tests over a real `Database` + `db.watch`:
  - `full` watch fires once, empty `hits`, `matched` covers `t`, `txnId` matches `/^txn:/`.
  - `rows` watch (`id = 'x'`) surfaces `['x']` in `hits`.
  - watch on a different table `u` does NOT fire.
  - no watchers ⇒ no-op, no throw.
  - unmatched table name ⇒ no-op, no throw.
  - throwing (sync) handler isolated — promise does not reject.
  - rejecting (async) handler isolated AND a healthy peer still fires.
  - explicit `notifyExternalChange('t','main')` matches a watch over the current schema.
  - table-name matching is case-insensitive (`'T','MAIN'`).
  - two watchers on the same table both fire in one call.
- **Regression:** `delta-executor-watch.spec.ts`, `covering-structure.spec.ts`,
  `change-scope.spec.ts`, `core/database-options.spec.ts`, `exports.spec.ts` — all
  green (188 cases total across these).

## Reviewer focus / known gaps (treat tests as a floor)

- **`groups` / `rowsByGroup` global-apply paths are not exercised end-to-end
  through `notifyExternalChange`.** They are covered at the unit level for the
  global branch in the existing `delta-executor-watch.spec.ts` (`apply` with
  `globalRelations`), but a direct `notifyExternalChange` integration case for a
  `groups` watch would close the loop. Consider adding one.
- **`rows`/`rowsByGroup` watch with no literal values won't fire.** Sound by
  design: a row-scoped watch is defined by specific keys; the global fallback
  surfaces exactly those registered literals as possibly-changed (identical to the
  existing commit-path global-fallback behavior). Worth confirming this matches
  the consumer's expectation (the vtab uses whole-table invalidation, so `full`
  watches are the primary path).
- **Snapshot semantics:** `notifyExternalTableChange` snapshots matching
  subscriptions before firing and guards `entry.disposed`, so a handler that
  unsubscribes a peer mid-pass is safe, and a handler that *registers* a new
  matching subscription mid-pass will NOT fire it this pass (intended — mirrors
  `DeltaExecutor.runAll`'s snapshot contract). No test asserts this; low risk.
- **Serial firing:** handlers fire serially (each awaited), same as
  `runPostCommit`. A hanging handler blocks subsequent ones — accepted contract.
- **Concurrency note (not a defect):** `currentTxnId` is shared with
  `runPostCommit`; the two are not designed to run concurrently. Unchanged from
  the existing watcher contract.

## Version bump / consumption status (action for the release owner)

- **No version bump was performed.** Quereus releases are cut as a **lockstep**
  `yarn bump` + `yarn pub` + `yarn gh-release` step (root script `release`,
  bumps every workspace package and publishes to npm + GitHub) — an
  outward-facing human/CI action, out of scope here. Recommended: a **minor**
  bump `3.3.0 → 3.4.0` (additive API) at the next release.
- **The consumer can use the API today regardless of version:** the optimystic
  `quereus-plugin-optimystic` declares `@quereus/quereus: ^3.2.1`, the root
  `resolutions` override forces the `portal:` local checkout, and `3.3.0` already
  satisfies `^3.2.1`. So no version change is required for the plugin ticket to
  build/run locally.
- **`dist` is gitignored in the Quereus repo.** I built it (so the portal-linked
  package currently exposes the API), but a fresh checkout or `yarn clean` would
  drop it — the consumer (ticket #2) should ensure `packages/quereus` is built
  (`yarn build`) before/after consuming. Ticket #2 already does a Quereus-aware
  build.

## Cross-repo commit note (FYI, not an action item)

The optimystic runner commits the **optimystic** repo only. My Quereus working-tree
changes were swept into a commit in the Quereus repo (`b28548c2`) by that repo's
own concurrent tess runner (a `git add` of the working tree under an unrelated
ticket message). The changes are intact and committed there (verified: HEAD source
matches what was tested; all checks pass). If the Quereus repo's history/attribution
matters for the release, the release owner may want to note this — but it does not
affect correctness or consumption.

## Suggested adversarial checks for the reviewer

- Re-run the suite fresh: `cd /c/projects/quereus && node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/external-change-watch.spec.ts" --colors`.
- Confirm `notifyExternalChange` is reachable on the exported `Database` type from
  the optimystic side (the downstream ticket asserts this) — build
  `packages/quereus` then `import { Database } from '@quereus/quereus'`.
- Sanity-check that a `full` watch registered via real SQL
  (`db.prepare('select * from t').getChangeScope()`) — not just a hand-built scope
  — fires (the new tests already do this, but verify against any planner changes on
  the `view-updates-lens` branch).
