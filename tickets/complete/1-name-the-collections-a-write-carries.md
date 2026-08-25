description: A row saved to a table that has a secondary index touches two separate pieces of storage, and until now no log said which ones a save actually reached. Two debug log lines were added, documented, and pinned by tests so a downstream bug report about a missing index update can be confirmed or ruled out from a log file.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/trace-helpers.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, docs/debugging.md, docs/optimystic.md
----

# Complete: make "which collections did this write carry?" answerable from a log

## What shipped

A table declared with a secondary index is stored as **two or more separate Optimystic
collections**: the main table tree at the table's `collectionUri`, and one index tree per
maintained index at `<collectionUri>/index/<indexName>`. A single SQL `insert` has to stage into
all of them and commit all of them. A downstream project reported that on a two-machine deployment
it does not, and repeated investigations could neither confirm nor refute that, because no log this
repository emitted could name the collections a commit carried.

Two `debug` lines now make it answerable. This is pure observability — **no behaviour changed, and
nothing here fixes or reproduces the downstream failure.**

- **`commit:collections`** (`optimystic:quereus-plugin:txn-bridge`), one line per commit naming
  every collection that commit is about to carry, with `mode=legacy` (the dirty set) or
  `mode=session` (the live collection registry the coordinator commits from), a `count=` that
  precedes the id list so truncation is detectable, and a `=staged`/`=clean`/`=unknown` marker per
  id. Emitted before the flush, ids sorted so two machines' lines compare by eye.
- **`index:tree-open`** (`optimystic:quereus-plugin:module`), one line per index tree opened,
  naming the table, the index, the derived URI, and the collection id that URI resolved to — the
  pair that separates "the index collection was absent from the commit" from "both machines
  committed, to *different* index collections".

Supporting change from implement: `DirtyTree` gained an optional `hasUnsyncedChanges?()` used only
by the trace (test doubles that omit it report `unknown`); the commit sweep does not branch on it.

## How a downstream operator uses this

`docs/debugging.md` § "Which collections did a write carry?" is now the authoritative reader's
guide — it carries the `DEBUG` invocations, a verbatim sample of both lines, and the field-by-field
reading rules, including the one an operator can most easily get wrong: in `mode=session` the id
list is the whole registry, so a collection being *listed* does not prove the write touched it;
only `=staged` says that. `docs/optimystic.md` § Operational Basics points at it.

Decisive check for a downstream re-run: find the `commit:collections` line for the insert into the
indexed table. If the `.../index/<name>` id is absent, the index collection was not in the write
transaction. If present on both machines, compare each machine's `index:tree-open` `collection=`
for the same logical index; different values mean two machines writing two different index
collections. If both are the same and both commits list the index, both hypotheses are dead and
the failure lies downstream of the write path.

## Review findings

**Read first:** the implement diff (`git show 9079d64`) before the handoff summary, then the
surrounding source — `txn-bridge.ts`'s commit paths, `optimystic-module.ts`'s index-tree open and
reconcile paths, `Tree.describe` / `Tree.hasUnsyncedChanges` in db-core, and `docs/debugging.md`.

### Fixed in this pass (minor)

- **`docs/debugging.md` was stale, and it is the file this ticket most needed to touch.** The
  quereus-plugin sub-namespace table had no `txn-bridge` row at all, and the `module` row did not
  mention `index:tree-open`. A downstream operator told "read the log" starts at that namespace
  list; without a row there, the two new lines were undiscoverable to anyone who had not read this
  ticket. Added the `txn-bridge` row, extended the `module` row, added a "Which collections did a
  write carry?" section with sample output and field-by-field reading rules, and added a `DEBUG=`
  recipe to the common-patterns block. Added a pointer from `docs/optimystic.md` § Operational
  Basics.
- **Session mode's trace line had no test pin** — the implementer's own largest declared gap. Added
  `emits a session-mode commit:collections line naming main + index collections` to
  `test/session-mode-commit.spec.ts`, reusing that suite's existing `enableSessionMode` harness. It
  asserts `mode=session`, that one line carries both the main and the index collection id, that
  both read `staged`, and that `count=` agrees with the ids listed. Confirmed it is a real pin:
  session mode never calls the legacy sweep, so dropping the line leaves no matching trace at all
  and the test fails rather than silently passing.
- **The trace capture/parsing helpers were buried inline in one spec**, which is what made the
  session case awkward to cover in the first place. Extracted `captureTrace`, `plain`,
  `commitTraces`, `indexOpenTraces`, and `collectionIdOf` into `test/trace-helpers.ts` — not a
  `.spec.ts`, so mocha's glob skips it, matching this package's existing `query-helpers.ts` /
  `commit-gate.ts` convention. Both specs import it.
- **The ANSI-stripping regex worked by accident.** `String.fromCharCode(27) + '\[[0-9;]*m'` — in a
  JS string literal `\[` collapses to a bare `[`, so the pattern was ESC followed by a *character
  class* `[[0-9;]`, not a literal bracket. It happened to match real ANSI sequences, and would also
  have matched a bare `ESCm`. Corrected to a properly escaped literal in the extracted helper.
- **Duplicated tree-labelling logic in `txn-bridge.ts`** — the same "collection id, else positional
  label" expression appeared once in the new trace and once in `PartialCommitError`'s
  persisted/unpersisted lists. Extracted one `treeLabel(tree, index)` so both name the same tree the
  same way.
- **Comment blocks duplicating what now lives in `docs/debugging.md`.** The implement pass added
  ~30 lines of JSDoc on `logCommitCollections` and ~12 on `openIndexTree` explaining the log format
  to an operator. With the doc section in place that is two copies of one explanation, free to
  drift. Trimmed both to what a code reader actually needs (why ids and not labels, why sorted, why
  `count` precedes the list, the enabled-guard cost) plus a pointer to the doc section.

### Checked and found sound (no change)

- **`openIndexTree`'s unguarded `String(tree.getCollection().id)`** — flagged by the implementer as
  a possible per-write cost. It is not: both callers (`addIndex`'s build path and
  `reconcileMaintainedIndexes`) reach it only on a `manager.getIndexTree(name)` miss, so it runs
  once per index per table instance at bring-up. The decision to skip a guard stands.
- **`Tree.describe()` really does return the collection id** (`String(this.collection.id)`,
  `packages/db-core/src/collections/tree/tree.ts:251`), so the legacy line's ids genuinely join
  against `index:tree-open`'s `collection=` field. The handoff's central claim holds.
- **The `log.enabled` guard does reach loggers built at import time.** `debug` is at 4.4.3, where
  `enabled` is a getter that re-derives from the current namespaces; on an older 4.1-style `debug`
  it is a value fixed at construction and the guarded line would go silent under a post-import
  `enable()`. Not filed — the dependency is pinned `^4.4.3` and the new tests fail loudly if that
  ever regresses.
- **Legacy mode reporting the dirty set rather than the full registry** reads clearly enough for an
  operator once `mode=` is documented, which it now is. The line itself is unchanged.
- **Test cleanup** — both capture helpers restore `debug`'s namespaces and sink in a `finally`, and
  the restore is airtight: `enable('')` correctly disables, because debug filters empty namespaces
  out of its parse.

### Tripwires parked (not tickets)

- `test/trace-helpers.ts`, on `captureTrace` — a `NOTE:` recording that it mutates process-global
  `debug` state and is safe only while this package's mocha runs serially (no `--parallel` in the
  test script, none in `.mocharc.json`). If this package ever adopts a parallel runner, concurrent
  captures would steal each other's lines and it needs a per-run sink instead.

### Evidence appended to an existing ticket (not a new one)

- `optimystic-module.ts` now measures **3213 lines** (`wc -l packages/quereus-plugin-optimystic/src/optimystic-module.ts`),
  up from the 3000 recorded when `backlog/debt-optimystic-vtab-class-is-too-big-to-review` was
  filed — this ticket added to the already-oversized class. Appended as a re-measurement to that
  ticket rather than filed again.

### Nothing filed

No major findings, and that is a conclusion rather than a shrug: the change adds two log lines on
paths that already existed, the per-commit one behind an `if (log.enabled)` guard that builds
nothing when disabled, and no control flow branches on the new optional `DirtyTree` member — there
is no state it can put the system into that did not already exist. The one architectural weakness
within reach, session-mode bridge coverage, is already tracked by
`backlog/debt-session-mode-bridge-coverage`; the session test added above narrows it slightly
rather than duplicating it.

### Cross-package duplication noted, not acted on

`packages/db-p2p/test/support/capture-log.ts` already implements the same capture pattern for that
package's namespaces. It is not importable here — different package, hardcoded `optimystic:db-p2p:`
prefix, and it returns raw argument arrays where these specs want substituted text — so the
plugin's own copy stays. Two small per-package copies of a ~20-line test helper is the cheaper side
of the trade; a shared test-utility package would be a larger change than this observation
justifies.

## Validation

```
yarn lint                                            # repo root, eslint . — clean
yarn typecheck                                       # repo root, all workspaces — clean
yarn build                                           # repo root, all workspaces — clean
yarn test                                            # in packages/quereus-plugin-optimystic: 477 passing, 13 pending, 0 failing
OPTIMYSTIC_INTEGRATION=1 yarn test                   # in packages/quereus-plugin-optimystic: 482 passing, 8 pending, 0 failing
```

Both counts are one higher than the implement pass (476 / 481) — the added session-mode trace test.
The two trace specs were also run under `--reporter spec` to confirm the new cases execute rather
than sitting pending. No pre-existing failures surfaced.

Test scope: the diff is confined to `packages/quereus-plugin-optimystic/**` plus two `docs/` files,
so the plugin suite (unit + integration) is the relevant one; lint and typecheck ran repo-wide.

## Still true after review

- **Not reproduced, not fixed.** The downstream failure still does not reproduce in this repository
  — mock mesh and real libp2p both converge, unchanged by this ticket. Nothing here is progress on
  the root cause, only on the ability to diagnose it from a log.
- Index maintenance, the commit sweep, and the unmaintained-index guards are behaviourally
  untouched.
