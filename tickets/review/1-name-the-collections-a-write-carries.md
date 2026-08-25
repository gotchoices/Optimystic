description: A row saved to a table that has a secondary index touches two separate pieces of storage, and until now no log said which ones a save actually reached. Two new debug log lines were added so a downstream bug report about a missing index update can finally be confirmed or ruled out from a log file.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts
difficulty: medium
----

# Review: make "which collections did this write carry?" answerable from a log

## What this change is, in one paragraph

A table declared with a secondary index is stored as **two or more separate Optimystic
collections**: the main table tree at the table's `collectionUri`, and one index tree per
maintained index at `<collectionUri>/index/<indexName>`. A single SQL `insert` has to stage into
all of them and commit all of them. A downstream project has reported for twelve days that on a
two-machine deployment it does not, and three investigations have failed to confirm or refute
that because **no log this repository emitted could name the collections a commit carried.**

This change adds two `debug` lines that make it answerable. It is pure observability: **no
behaviour changed, and nothing here claims to fix the downstream failure.** If the trace reveals
the defect, that is the next ticket.

## What landed

**Arm 1 — `commit:collections`**, in `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`.
One line per commit naming every collection that commit is about to carry, in both commit modes:

- **legacy** (`commitDirtyTreesLegacy`, ~line 384) — the set is the dirty set: a tree only lands
  there once `markDirty` saw DML stage into it, so an index collection *absent from the line* means
  the index was never staged into. That is exactly the downstream claim, now falsifiable.
- **session** (`commitTransaction`, before `this.session.commit()`) — the set is the whole live
  `collectionRegistry`, because the coordinator iterates its own collection map at commit.

New private method `TransactionBridge.logCommitCollections` does the formatting. `DirtyTree` gained
an **optional** `hasUnsyncedChanges?(): boolean` used only by this trace (test doubles that omit it
report `unknown`); the commit sweep does not branch on it.

**Arm 2 — `index:tree-open`**, in `OptimysticTable.openIndexTree`
(`packages/quereus-plugin-optimystic/src/optimystic-module.ts`, ~line 2283) — the single place an
index sub-collection URI is derived. One line per open naming the table, the index as this vtab
knows it, the derived URI, **and** the collection id that URI resolved to. Both are printed because
they genuinely differ: `CollectionFactory.parseCollectionId` strips the `tree://` scheme, so
`tree://default/Foo/index/bar` becomes collection id `default/Foo/index/bar`. Arm 1 prints ids; an
operator joining the two lines needs the pair.

Arm 2 exists because Arm 1 alone cannot distinguish **"the index collection was not in the commit"**
from **"both machines committed, to *different* index collections"**. Two machines resolving
different index-tree ids for one logical index would produce exactly the reported symmetric symptom
(each machine's index holding only its own rows) while leaving the main table fine. Neither shape is
claimed here to be the cause; the point of the pair is that one downstream run eliminates one.

## Phase 3 hand-off — how to read this downstream

Enable **both** namespaces (or the whole plugin namespace):

```
DEBUG='optimystic:quereus-plugin:*'
```

Narrower, if the log is noisy:

```
DEBUG='optimystic:quereus-plugin:txn-bridge,optimystic:quereus-plugin:module'
```

Verbatim output, captured from a real run of the mock-mesh spec in this repo:

```
2026-08-25T01:37:23.857Z optimystic:quereus-plugin:txn-bridge commit:collections mode=legacy count=2 default/FormationUsage=staged default/FormationUsage/index/formation_usage_by_token=staged
2026-08-25T01:37:23.776Z optimystic:quereus-plugin:module index:tree-open table=FormationUsage index=formation_usage_by_token uri=tree://default/FormationUsage/index/formation_usage_by_token collection=default/FormationUsage/index/formation_usage_by_token
```

Reading it:

- `mode=` is `legacy` (no coordinator wired — what the downstream host runs today) or `session`
  (distributed consensus path).
- `count=` is emitted **before** the id list so a truncated line still says how many collections
  there were. If `count=` and the number of listed ids disagree, the line was truncated.
- Each id carries `=staged` (had unflushed changes at commit time) / `=clean` / `=unknown`. The
  line is emitted *before* the flush, so `staged` is the pre-flush state.
- Ids are sorted, so two machines' lines compare directly by eye.
- `count=0` lines are normal and appear often — a commit whose bridge had no dirty trees (DDL and
  schema-catalog writes route through a different bridge instance).

**The decisive check for the downstream re-run of `strand-formation-concurrent-redemption.integration.ts`:**

1. Find the `commit:collections` line for the insert into the indexed table. Does it list the
   `.../index/<name>` collection id at all? *No* → the index collection was absent from the write
   transaction, which is the downstream project's own hypothesis, confirmed.
2. If it *is* listed on both machines, compare the `index:tree-open` `collection=` value on machine A
   against machine B for the same logical index. Different → the two machines are writing to two
   different index collections.
3. If both are the same and the index collection is in both commits, both hypotheses are dead and
   the failure is downstream of the write path (read/repair/visibility), which redirects the next
   investigation.

## Use cases / what to exercise when reviewing

- `insert` into a table with a secondary index → `commit:collections` lists **both** the table and
  the index collection, both `staged`.
- `insert` into a table with **no** index → one collection listed, `count=1`.
- Session mode (`session-mode-commit.spec.ts` wiring) → `mode=session` lines, sets drawn from the
  live registry rather than the dirty set.
- Debug namespace **off** → nothing emitted, and no list/string is built (see gaps below).
- Two nodes on one mesh → identical `collection=` in each node's `index:tree-open`.

## Validation actually run

```
yarn lint                                                   # clean
yarn build                                                  # clean
yarn typecheck                                              # clean
yarn workspace @optimystic/quereus-plugin-optimystic test    # 476 passing, 13 pending, 0 failing
OPTIMYSTIC_INTEGRATION=1 …  test:verbose                     # 481 passing, 8 pending, 0 failing
```

Both trace lines were also observed by hand with `DEBUG=` set — legacy via the mock-mesh
convergence spec, session via `session-mode-commit.spec.ts` — and the verbatim samples above come
from those runs. No pre-existing failures surfaced.

## New tests (Phase 2)

Two cases appended to
`packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts`, plus a
`captureTrace` helper that swaps `debugFactory.log` for a capturing sink and turns the plugin
namespace on for the duration (`debug` is an unbundled dependency of this package, so the test and
`dist/` share one instance — that is what makes `enable()` reach loggers built at import time):

- **`commit trace names the index collection alongside the table for an indexed insert`** — asserts
  a single `commit:collections` line carries both the table collection id and the index collection
  id, that the index entry reads `staged`, that `count=` agrees with the ids listed, and that
  `mode=legacy`.
- **`both nodes resolve the same index collection id for the same logical index`** — asserts each
  node's `index:tree-open` lines resolve to exactly one id, that both nodes resolve the *same* id,
  and that the table/index/URI fields are right.

## Known gaps — please probe these

- **Session mode's line is not asserted by any test.** It was verified by hand (see above) but the
  Phase 2 cases both run legacy mode, so a change that stopped emitting the `mode=session` line
  would not fail the suite. The ticket asked for both modes to emit, which they do; only the *pin*
  is one-sided. This is the biggest hole in the handoff.
- **Both new tests mutate global `debug` state** (`disable()` / `enable()` / replacing
  `debugFactory.log`) and restore in a `finally`. Mocha runs serially here so this is safe today; a
  parallel runner would make it racy. Worth a reviewer's eye on whether the restore is airtight.
- **The trace-parsing helpers strip ANSI codes with a hand-rolled regex** built via
  `String.fromCharCode(27)` (to keep a literal escape byte out of the source). If `debug` decides
  the sink is a TTY the message body is still plain, but the `+1ms` suffix is coloured; the parser
  drops any token that is not `id=state`, so that suffix is ignored. Confirm that reasoning holds.
- **`openIndexTree`'s line is not `log.enabled`-guarded.** All four arguments already exist, so
  nothing is constructed — but `String(tree.getCollection().id)` is evaluated even when the
  namespace is off. It is one call per index-tree open (bring-up, not per-write), so this was judged
  not worth a guard. Arm 1, which fires per commit, *is* guarded and builds nothing when disabled.
- **Legacy mode reports the dirty set, not the full registry.** That is deliberate — in legacy mode
  the dirty set *is* the commit set — but it means the line cannot distinguish "the index collection
  exists but was clean" from "the index collection was never opened". Arm 2's line covers the
  second. A reviewer should decide whether that split reads clearly enough for an operator who has
  only the log.
- **Not reproduced, not fixed.** The downstream failure still does not reproduce in this repository
  (mock mesh and real libp2p both converge, unchanged by this ticket). Nothing here should be read
  as progress on the root cause — only on the ability to diagnose it.
- **No tripwires were parked** during this work; nothing conditional came up that needed a `NOTE:`.

## Explicitly out of scope (unchanged from the implement ticket)

- Any behavioural change to index maintenance, the commit sweep, or the unmaintained-index guards.
- Widening the guards from `index-maintenance-must-track-the-declared-index-set` — their
  precondition is provably absent on this path.
- Reproducing the downstream host's wiring (catalog hydration, write-through raw-storage cache,
  asymmetric node roles, batch schema script, many-table schema) in this repository.
