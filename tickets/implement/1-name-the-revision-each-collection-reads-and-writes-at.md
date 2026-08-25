description: When two machines share a database, a row written on one of them cannot be found on the other if the lookup goes through an index. We can already see that the write carried the index, so the next thing we need to see is which version of the index each machine wrote to and which version the failing lookup read from.
prereq:
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/tree/tree.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, docs/debugging.md
difficulty: medium
----

# Name the revision each collection is read and written at

## Why this, and not the block id

The predecessor ticket (`fix/1-index-collection-is-written-and-still-unreadable-on-the-sibling`)
proposed printing "the block id and revision" of each collection at commit, to tell whether the two
machines committed into one lineage or two independently invented ones wearing the same name.

**The block-id half of that is already answered, by construction — do not build it.** A collection's
header block id *is* its collection id:

- `packages/db-core/src/collection/struct.ts:5` — `export type CollectionId = BlockId`.
- `Collection.probeHeader` (`collection.ts:145`) reads the header with `source.tryGet(id)` — the
  collection id, used directly as a block id.

So the string the `commit:collections` trace already prints
(`default/FormationUsage/index/FormationUsageByToken`) *is* the header block id. Two machines using
that URI address the same header block. Identity cannot fork. Printing the block id would print the
same characters a second time.

What is genuinely unknown is the **revision** — the `rev` field of the collection's `ActionContext`.
That is the discriminator, and it is not observable from outside `Collection` today.

## Why revision is the thing that matters

Every block a collection reads is materialized **at the revision the collection currently holds**:

- `TransactorSource.tryGet` (`transactor-source.ts:38-40`) calls
  `this.transactor.get({ blockIds: [id], context: this.actionContext })`.
- `actionContext` advances **only** through `Collection.update()` (via `advanceContext`, which is
  monotonic and never lowers a revision) or through `Collection.sync()`. Nothing advances it
  passively — not time, not another collection's commit, not a peer's notification.

So a collection sitting at a lagging revision silently serves an **old root**, with no error. For an
index collection that means a seek descends a stale index and finds nothing, while the main table
collection — refreshed by a different set of call sites — has moved on and can serve the same row
through a primary-key descent or a full scan. That is exactly the reported asymmetry.

`actionContext` being `undefined` is a distinct and even more interesting state: it means the
collection was **invented** (`createOrOpen` found no committed header and staged a fresh empty one —
`collection.ts:132-137`) and has never adopted a committed revision.

## The three-way this makes visible

Once the sibling's failing read names the revision it descended, and the writer's commit names the
revision it committed at, the remaining hypotheses separate cleanly:

| Sibling's index collection at the failing read | Reading |
| --- | --- |
| `rev=none` (invented, never committed) | The invention race. The sibling staged its own empty index and never adopted the committed log. |
| `rev` lower than the writer's commit rev | A refresh gap. The collection is real but stale; nothing called `update()` on it before the read. |
| `rev` equal to the writer's commit rev, seek still misses | The write's index action did not survive commit despite being staged — look at the sync/merge and `filterConflict` replay, not at refresh. |

The third row is the outcome the parent ticket anticipated and could not distinguish.

## Root site

**`Collection` exposes no way to report the revision it is reading at.** `source` is private and
`ActionContext` never escapes the class. Both arms below need that one accessor; it is the single
code site that must change to make either measurement possible.

Add to `Collection` (`packages/db-core/src/collection/collection.ts`):

```ts
/** The committed revision this collection currently reads and writes at, or
 *  `undefined` for an INVENTED collection that has never adopted a committed
 *  revision (createOrOpen found no header — see the invented branch above).
 *  Diagnostic only: every block read is materialized at this revision
 *  (TransactorSource passes it as the read context), so a collection lagging
 *  here silently serves an old root. */
committedRevision(): number | undefined {
  return this.source.actionContext?.rev;
}
```

and forward it from `Tree` (`packages/db-core/src/collections/tree/tree.ts`), right beside the
existing `describe()` at line 251, which forwards `collection.id` the same way.

## Arm 1 — the write side gains one field

`TransactionBridge.logCommitCollections` (`txn-bridge.ts:487`) already emits one line per commit.
Each id currently carries `=staged` / `=clean` / `=unknown`. Add the revision as a second suffix on
the same token, so the line stays one line and the existing sort-and-compare-by-eye property holds:

```
commit:collections mode=legacy count=2 default/FormationUsage@7=staged default/FormationUsage/index/FormationUsageByToken@3=staged
```

`@none` for a collection with no committed revision. Follow the existing shape of
`DirtyTree.hasUnsyncedChanges` (`txn-bridge.ts:36-40`): the new method is **optional** on the
`DirtyTree` interface so test doubles need not implement it, and the trace prints `@unknown` when it
is absent. Both call sites already build their entry arrays inside an `if (log.enabled)` guard —
keep that.

## Arm 2 — the read side, which is the decisive end

This is the cheaper and more informative half, and it does not exist at all today. `runQuery`
(`optimystic-module.ts:~745-800`) resolves the index target and picks one of two arms:

- **committed** — `committedTreeView(...)` for both main tree and index tree. Deliberately never
  refreshes from the network.
- **live** — `await mainTree.update()` and `await indexTarget.tree.update()`.

Which arm ran is not currently recoverable from any log, and neither is the revision. Emit one line
per index-driven scan, in the `key=value` style of the existing `index:tree-open` trace
(`optimystic-module.ts:2301` — the only other structured trace in this file, so `index:seek` does not
collide):

```
index:seek table=FormationUsage index=FormationUsageByToken collection=default/FormationUsage/index/FormationUsageByToken arm=committed rev=3 main_rev=7 matched=0
```

- `arm=committed|live` — says directly whether this read was allowed to refresh.
- `rev=` — the index collection's revision, `none` when invented.
- `main_rev=` — the main table collection's revision at the same moment. The gap between the two is
  the refresh asymmetry, stated as a number rather than inferred.
- `matched=` — how many index entries the seek produced. Distinguishes "descended a stale index" from
  "descended a current index that genuinely has no entry".

Emit it where both views are already resolved — after the committed/live branch, before dispatching
into `executeIndexScan` — so one site covers both arms and neither view has to be rebuilt. `matched`
is only known once the scan has run, so either count it inside `executeIndexScan` and emit on
completion, or emit the pre-scan fields and a companion count; prefer whichever keeps it to a single
line. Guard the whole thing with `log.enabled` so a disabled namespace builds nothing.

## Documentation

`docs/debugging.md` § "Which collections did a write carry?" (line 97) documents the
`commit:collections` / `index:tree-open` pair and how to read them. Extend it:

- The `@rev` suffix and what `@none` means.
- A new short subsection for `index:seek` — the three-way table above is the useful content, since
  the whole point of the line is to let an operator on a failing machine classify the failure without
  reading the source.
- Say plainly that the collection id in these lines **is** the header block id, so nobody proposes
  printing it separately again.

## Scope, and honesty about what this is

This is observability, not a fix. It is the third such step on this thread, so it is worth being
explicit about why it is still the right move: the defect does not reproduce in this repo (only in
the sereus checkout), and the three surviving hypotheses are distinguished by exactly one value that
no log currently prints. The accessor is also not throwaway — a collection's revision being
unobservable from outside the class is a real gap, and the three-way table above is the reason.

Do **not** attempt a speculative fix (e.g. "just call `update()` on index trees in the committed
arm") in this ticket. The committed arm's refusal to refresh is deliberate and documented at
`committedTreeView` (`optimystic-module.ts:~880`); changing it before knowing which of the three
cases holds would paper over the invention race if that is what this is.

## Reproduction, for whoever runs the instrumented build

Not reproducible in this repo. In the sereus checkout:

```bash
cd packages/integration-tests
DEBUG='optimystic:quereus-plugin:txn-bridge,optimystic:quereus-plugin:module' \
  npx vitest run src/scenarios/strand-formation-concurrent-redemption.integration.ts
```

Deterministic there — all 3 cases fail, every run since 2026-08-20.

## Already ruled out — do not re-derive

Carried forward from `fix/1-index-collection-is-written-and-still-unreadable-on-the-sibling` and its
predecessors:

- Not the write transaction's collection set — every write to the failing table carries both the
  table collection and its index collection, both `staged`. Measured, not inferred.
- Not the read-repair corroboration floor (a two-machine cohort relaxes to one voter).
- Not the maintained-index guards (each machine maintains the index it serves rows through).
- Not a forked *data* collection (primary-key descent and full scan both converge on the same sibling
  in the same window).
- Not the mock transport, write concurrency, cluster-size configuration, or composite text primary
  keys — all covered by the two-real-node spec in
  `packages/db-p2p/test/two-node-convergence-invention-race.spec.ts`, which converges.
- **New here:** not a fork by collection identity — `CollectionId = BlockId` and the header block id
  is the collection id, so two machines using one URI address one header block.

Two things checked during this investigation that turned out **not** to be leads, recorded so nobody
re-walks them:

- The main table collection is *not* re-opened per transaction while index trees are held — both are
  long-lived per table instance (`this.collection` is assigned once in `doInitialize`; index trees are
  held by the `IndexManager`). The factory's collection cache is keyed per active transaction and does
  not cause a re-open of either.
- `openIndexTree` passing a synthetic transaction state with a fresh empty `collections` map does not
  produce a duplicate `Tree` instance over one index collection at the `addIndex` call site — that
  site registers its tree with the manager *before* calling `reconcileMaintainedIndexes`, precisely so
  reconcile does not open a second one.

## TODO

**Phase 1 — the accessor**

- [ ] Add `Collection.committedRevision(): number | undefined` to
      `packages/db-core/src/collection/collection.ts`, documented as diagnostic-only and explaining
      that `undefined` means an invented collection.
- [ ] Forward it from `Tree` in `packages/db-core/src/collections/tree/tree.ts`, beside `describe()`.
- [ ] Export nothing new from the package barrel unless the plugin needs it — `Tree` is already public.

**Phase 2 — write-side trace**

- [ ] Add an optional `committedRevision?(): number | undefined` to the `DirtyTree` interface in
      `txn-bridge.ts`, matching how `hasUnsyncedChanges?()` is declared optional there.
- [ ] Extend `CommitCollectionTrace` with the revision and render `id@rev=state` in
      `logCommitCollections`, using `@none` for no committed revision and `@unknown` for a double that
      omits the method.
- [ ] Populate the field at both call sites that build the entry array, inside the existing
      `log.enabled` guards.

**Phase 3 — read-side trace**

- [ ] Emit `index:seek` in `runQuery` covering both the committed and live arms, with `table`,
      `index`, `collection`, `arm`, `rev`, `main_rev`, and `matched`.
- [ ] Make sure `matched` reflects index entries produced by the seek, not rows surviving later
      filtering — the distinction is the whole point of the field.
- [ ] Guard construction behind `log.enabled`.

**Phase 4 — docs and validation**

- [ ] Extend `docs/debugging.md` § "Which collections did a write carry?" per the section above,
      including the three-way reading table and the note that the collection id *is* the block id.
- [ ] Build and run the db-core and quereus-plugin test suites; confirm nothing regressed.
- [ ] Confirm the traces still join by collection id — `commit:collections`, `index:tree-open`, and
      `index:seek` must all print the same id string for the same collection.
- [ ] Sanity-check the new lines against
      `packages/db-p2p/test/two-node-convergence-invention-race.spec.ts` (which converges here), so the
      shape of a *healthy* run is on record for comparison against the failing sereus run.

## Secondary observation, not required work

In the sereus run, 123 of 136 `commit:collections` lines were `count=0`. Presumably read-only or
no-op transactions, and `docs/debugging.md:122` already documents `count=0` as normal — but nobody has
confirmed that every one of those is legitimate. If the `mode=` field on those lines makes the answer
obvious while you are in this code, say so in the handoff. Do not go build anything for it.
