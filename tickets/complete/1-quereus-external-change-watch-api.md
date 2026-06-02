description: COMPLETE — Quereus external/remote-change → watch invalidation API (Database.notifyExternalChange). Reviewed; one latent correctness bug found and fixed inline; docs + tests extended.
files: ../quereus/packages/quereus/src/core/database.ts, ../quereus/packages/quereus/src/core/database-watchers.ts, ../quereus/packages/quereus/src/runtime/delta-executor.ts, ../quereus/packages/quereus/test/external-change-watch.spec.ts, ../quereus/packages/quereus/test/runtime/delta-executor-watch.spec.ts, ../quereus/docs/change-scope.md
----

# Complete: Quereus external change → watch invalidation API

> **Cross-repo.** Implementation + all review edits live in the sibling Quereus
> repo at `C:\projects\quereus` (branch `view-updates-lens`), consumed by
> optimystic via `portal:../quereus/packages/quereus`. The optimystic runner only
> commits the optimystic repo; the Quereus changes are committed in the Quereus
> repo (see "Commit provenance" below).

## What shipped

`Database.notifyExternalChange(tableName, schemaName?)` — coarse, table-granular
watch invalidation that fires every active watcher whose scope includes a base
table **without** a local commit, so a vtab backed by a replicated/external store
can translate a remote write into a Quereus watch invalidation. It bypasses the
commit change-log path and drives each matching subscription through the existing
`DeltaSubscription.apply` global-relation branch.

- `database.ts` — public `notifyExternalChange` wrapper (`checkOpen()`, resolve
  schema, delegate).
- `database-watchers.ts` — `WatcherManager.notifyExternalTableChange(fqName)`:
  snapshots matching subscriptions, mints a txnId (try/finally reset), builds a
  global-relation `DeltaApplyInput` per subscription, per-subscription error
  isolation.
- `delta-executor.ts` — reuses existing `apply` global branches (no kernel API
  change for the original implementation).

## Review findings

Adversarial pass over the implement diff (Quereus `9046f76c` / originally swept
into `b28548c2`), read before the handoff summary. Scrutinized from SPP, DRY,
modularity, scalability, resource cleanup, error handling, type safety, and test
coverage angles. Lint + typecheck + build + tests all green at handoff.

### MAJOR (none filed as new tickets — the one substantive defect was a safe inline fix)

- **`groups` watches silently missed every external/global change — FIXED inline.**
  The handoff *documented* (in `database.ts` JSDoc, `database-watchers.ts` JSDoc,
  and the implementer's own "reviewer focus" notes) that a `groups` watch "fires
  with empty hits" on external change. It did **not**. In `subscriptionFromChangeScope`'s
  `apply`, the `groups` case computed `observable = hits.length > 0`, and the global
  branch sets `hits = []` — so `observable` was always `false` and a `groups` watch
  never fired. Confirmed empirically with a throwaway probe (fired 0 times).

  This violated the API's stated "never misses a change" contract and was **not
  exclusive to the new feature** — the same dead branch made `groups` watches miss
  the commit-path global fallbacks (`isGloballyChanged`, missing-PK fallback,
  cost-based fallback). Because no precise group tuples exist in those cases, firing
  with empty hits ("some group changed — re-query") is exactly correct, identical to
  the `full` case.

  **Fix:** `observable = isGlobal || hits.length > 0` in the `groups` branch
  (`delta-executor.ts`), with a comment explaining the never-miss rationale. Verified
  no existing test pinned the old (broken) behavior — the only prior `groups` apply
  test drives the non-global per-tuple path, which is unchanged and still passes.
  Judged a safe minor inline fix rather than a new ticket: one-line, no public-API
  change, no consumer impact (the optimystic vtab uses `full` whole-table watches),
  strictly improves correctness, and is now locked by tests at both the unit and
  integration level.

### MINOR (fixed inline)

- **Untested global paths the implementer flagged as a gap — now covered.** Added
  integration cases to `external-change-watch.spec.ts`: a `groups` watch fires once
  with empty hits on `notifyExternalChange`; a `rowsByGroup` watch surfaces its
  registered group literal. Added a unit case to `runtime/delta-executor-watch.spec.ts`
  pinning `groups` + `globalRelations` → fires with empty hits (regression guard for
  the fix above, placed where the bug lived).
- **DRY:** `notifyExternalTableChange` and `invalidateForTable` hand-rolled the same
  "subscriptions whose scope includes fqName" loop. Extracted
  `WatcherManager.subscriptionsForTable(fqName)` (returns a snapshot); both callers
  use it.
- **Docs were silent on the new API and stale on global-fallback semantics.**
  Updated `docs/change-scope.md`: the global-fallback paragraph now lists `full` and
  `groups` (empty hits) alongside `rows`/`rowsByGroup` (registered literals); added a
  new "External / out-of-band changes" subsection documenting `notifyExternalChange`
  (coarse-by-design, hits semantics, no-op/error-isolation/serial-await contract,
  future `changedKeys` room).

### Checked and found sound (no action)

- **Error handling / isolation:** per-subscription `try/catch` plus the outer
  `try/finally` that resets `currentTxnId`; `apply` also swallows handler errors.
  A throwing or rejecting handler never rejects into the caller and healthy peers
  still fire (tested).
- **Resource cleanup / re-entrancy:** matches are snapshotted before firing and
  `entry.disposed` is re-checked in the loop, so a handler that unsubscribes a peer
  mid-pass is safe; a subscription registered mid-pass fires next pass (mirrors
  `DeltaExecutor.runAll`'s snapshot contract).
- **`globalRelations.size === 0` guard** in `notifyExternalTableChange` is defensive
  (can't occur when `tables.has(fqName)`, since `tables` and `relationToBase` derive
  from the same `scope.watches`) — harmless, left as-is.
- **Type safety:** no `any`; `DeltaApplyInput`/`DeltaSubscription` used as exported.
- **`checkOpen()`** guards use-after-close; non-existent / unmatched table → no-op
  (tested); case-insensitive `schema.table` matching (tested).
- **`rows`/`rowsByGroup` with no literal values won't fire on global** — sound by
  design (a key-scoped watch with no keys is degenerate); documented.
- **Shared `currentTxnId` with `runPostCommit`** — accepted pre-existing contract
  (the two paths are not designed to run concurrently); unchanged.

### Validation performed

- `yarn typecheck` (packages/quereus) — clean.
- `eslint` on all changed src + test files — clean.
- `yarn build:engine` — clean; rebuilt the gitignored `dist` so the portal-linked
  package exposes the fixed runtime (`notifyExternalChange` /
  `notifyExternalTableChange` present in `dist`).
- Tests — **199 passing** across `external-change-watch`, `runtime/delta-executor-watch`,
  `incremental/delta-executor`, `logic/change-scope`, `core/database-options`,
  `covering-structure`; plus `documentation` + `exports` green. The new groups +
  rowsByGroup external-change integration cases and the groups-global unit case pass.

## Commit provenance (cross-repo, FYI)

The Quereus repo runs its own concurrent tess runner. Both the original implement
work and all of this review's edits were swept into Quereus commits under an
*unrelated* ticket message (`b28548c2` then `9046f76c`, both labelled
`lens-parent-side-fk-nullable-key-update-gap` / `...-review`) rather than under this
ticket's slug. Verified the changes are intact in `9046f76c` (groups fix, helper
refactor, docs, and all new tests present). The Quereus repo separately filed
`tickets/backlog/...external-change-watch-feature-untracked-provenance.md` tracking
this attribution gap. It does not affect correctness or consumption.

## Version / consumption status (release-owner action, unchanged from handoff)

- No version bump performed (Quereus releases are a lockstep `yarn bump`/`pub`/
  `gh-release` human/CI step). Recommended **minor** bump `3.3.0 → 3.4.0` (additive).
- The consumer (optimystic `quereus-plugin-optimystic`, `^3.2.1`) builds/runs against
  the portal-linked local checkout today regardless of version. Ticket #2
  (`optimystic-vtab-reactive-watch-bridge`) should ensure `packages/quereus` is built
  (it already does a Quereus-aware build) since `dist` is gitignored.

## End
