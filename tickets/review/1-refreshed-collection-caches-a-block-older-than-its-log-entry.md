description: After a shared table changed, a machine re-reading the changed record could be handed an old copy, keep it in memory, and never look again — showing stale data indefinitely. The machine now uses what it already knows (which revision the record must be at least as new as) and never remembers an answer that is provably too old. Two further ways the same thing could happen, found while doing this, are closed too.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/transactor/block-floors.ts (new — BlockFloors, BlockFloorCheck), packages/db-core/src/transactor/transactor-source.ts (tryGet, describeServed, mayRetain — both NOTEs live here), packages/db-core/src/transform/cache-source.ts (tryGet miss path, stillWanted, keep, handThrough, unkept, retains, peek, getCachedRevision, clear, transformCache), packages/db-core/src/transform/tracker.ts (sourceRetains, tryGet memo), packages/db-core/src/collection/collection.ts (newFloors, probeHeader, forgetAndAdopt, raiseFloors, revisionsByAction, createReadTracker, updateInternal), packages/db-core/test/refresh-below-floor.spec.ts (new), packages/db-core/test/block-floors.spec.ts (new), packages/db-core/test/capture-log.ts (new — lifted out of collection.spec.ts), packages/db-core/test/cache-source.spec.ts, packages/db-core/test/tracker-read-perf.spec.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-core/test/collection.spec.ts, docs/internals.md, docs/transactions.md, docs/debugging.md, packages/db-core/docs/collections.md
difficulty: hard
----

# Review: a collection never remembers a block older than the log entry that changed it

## What was wrong, in one paragraph

When a collection handle refreshes and finds a new log entry, it drops the blocks that entry names from its in-memory read cache so the next read fetches them again. If the machine answering that re-read had not caught up yet, it honestly returned the older block (labelled with its older revision). The cache kept it — for good, because the log entry that would have dropped it had just been consumed, and the cache has no expiry. Downstream this showed as a reader polling four times a second and returning the old row for 45 s, long after its own disk had been repaired. Reproduced in db-core before any change (`packages/db-core/test/refresh-below-floor.spec.ts`, first case, returned `value: 'old'`).

## Two words used throughout

- **Floor** of a block: the revision (and action id) of the newest log entry this handle has walked that names the block. Every block an action changes is committed at that action's revision, so a read of the block at a context at or above the floor must come back at the floor's revision or later.
- **Below-floor answer**: a served block whose reported revision (`servedRevision` — the answer's `materialized` revision) is under the floor that applied to the read.

## How it works now

- **Collection** (`collection.ts`). Each handle owns one `BlockFloors`, created in `probeHeader` and shared with every read source the handle builds. `raiseFloors` records a floor per block for each walked entry, taking the entry's revision from the context the same log walk built (`revisionsByAction`; `Log.getFrom` returns entries without revisions). Every below-floor answer is logged as `collection:block-below-floor id=… tag=… block=… floorRev=… floorAction=… servedRev=…`.
- **Source** (`transactor-source.ts`). `tryGet` judges each served block against the applicable floor (`mayRetain`) and records, per returned block *object*, `{ rev, mayRetain }` for `describeServed`. The block is returned either way — no throw. The accepted-tradeoff `NOTE:` (why return rather than throw, with its revisit condition) and the per-read-cost tripwire `NOTE:` are both on `mayRetain`.
- **Cache** (`cache-source.ts`). A below-floor answer is handed to the reader but not cached (`handThrough`), so the next read asks storage again. It *is* kept in a side slot (`unkept`) that only `peek`/`getCachedRevision` answer from — never a read — so a write staged over it can still say which base it was built on.
- **Tracker** (`tracker.ts`). It memoizes "source block + staged edits" and stamps the memo with the cache generation read *after* the load, so no generation bump during a hand-through can stop the memo being served. It now memoizes only over a base the source `retains`.
- **Read views** (`createReadTracker`). A pinned view shares the handle's floors but through `checkOnly()`: it judges and reports, never retires. A view pinned *below* a floor is untouched.

## Where I went beyond the ticket's TODO — please scrutinize these

1. **A view never retires a floor** (`BlockFloors.checkOnly`). The ticket says floors are shared and dropped once met; it does not say by whom. If a view's good answer retired the floor, the handle's own next read of the block — possibly answered by a different, lagging machine — would arrive unguarded and be kept for good. This matters more once the companion ticket lets a retry fetch the good answer from another machine. Spec: "a view never retires a floor on the collection's behalf".
2. **The `unkept` side slot.** The ticket says a below-floor answer must never enter `CacheSource` "(not `cache`, not `revisions`)". I kept that for reads and for read-dependency stamping, but added a third map used only to describe a staged write's base. Reason: without it a block updated over a below-floor base is *undeclared* at commit, and the storage-side guard that refuses edits applied to the wrong base (`internalCommit` in `packages/db-p2p/src/storage/storage-repo.ts`) abstains — turning today's loud refusal into edits silently applied over newer content. With it the commit declares the revision actually served. A reviewer who reads the ticket's sentence strictly may want this gone; please weigh that against the abstain path.
3. **Two concurrency holes, both reproduced before fixing** (scratch specs, deleted; permanent specs below):
   - *Two concurrent reads of one block.* Reads are not latched (the SQL layer runs reentrant scans over one handle). The first answer meets the floor and retires it; the second, from a machine still behind, arrives unjudged and was kept for good (`answers: new, old → kept: old`). Closed by (a) the per-object handshake `describeServed` — a by-id record read after an `await` pairs one answer's content with the other's verdict — and (b) `CacheSource.stillWanted`: if the id's generation moved while the read was in flight, the answer is kept only to replace strictly older content.
   - *A read landing mid-refresh, with storage fully current.* `updateInternal` forgot each changed block inside the entry loop, then awaited the invalidation read, then advanced the context. A read in that gap re-fetched the block at the *old* revision (no floor applies below it), the cache kept it, and the advance made it permanently stale (`during: old → after: old old`). This predates the ticket — HEAD has the same ordering; I reproduced it on this branch before reordering, not on a HEAD checkout. Closed by `forgetAndAdopt`: forget, floor and adopt in one synchronous step with no `await`. It relies on `TransactorSource.tryGet` reading its context when the answer *arrives*.
   `stillWanted` also closes a third, older race as a side effect (an in-flight read overwriting content the handle's own commit just folded in); that one is covered at the cache level only.
4. **The log line carries `floorAction=`** in addition to the fields the ticket listed, and is **not** `log.enabled`-gated: its arguments are already in hand, so there is nothing to skip computing.
5. **`packages/db-core/test/capture-log.ts`.** I needed log capture in a second spec file; rather than make a fourth copy (see `backlog/debt-three-copies-of-the-log-capture-test-helper`), I lifted the inline helper out of `collection.spec.ts` verbatim and import it from both. That ticket now carries a progress note; it decides nothing that ticket left open.

## The test double's pending overlay — what I chose, and what it costs

The ticket offered two options (accept an answer whose `state.pendings` names the floor's action, or make `TestTransactor` promote pendings on read like the real repo). I took **neither**: the floor check stays a pure revision comparison. Accepting on `state.pendings` would re-open the defect on a real repo in the (narrow) case where a pending is listed but the served content is the un-overlaid base; promoting would change the double's state machine under every suite that inspects pendings. Since a below-floor answer is *returned*, nothing is rejected: against the double, a block still pending under the entry's own action reads correctly (the overlay is the entry's content), is simply not kept until it commits, and emits one `collection:block-below-floor` line that would not appear against a real `StorageRepo` (which promotes and reports the entry's revision). Spec: "serves the entry's own content while its block is still pending…". Across the whole pre-existing db-core suite the line fired zero times, so no existing own-entry or torn-tail case combines a floor with the overlay. **Fidelity gap to weigh:** a future db-core spec that reads through the overlay under a floor will see a line and an extra fetch that production would not.

## Use cases to test and validate (all in `packages/db-core/test`)

`refresh-below-floor.spec.ts` — 13 cases, each mutation-checked where a mechanism is named:
- the ticket's repro: not kept once storage catches up;
- handed on once per read, nothing kept, recovers on the very next read with **no further refresh**, and is kept once it meets the floor;
- the log line's exact fields, and silence once the floor is met;
- the floor is retired once the handle holds an answer that meets it (reaches the private `floors` by bracket access — the only such reach);
- two concurrent reads, too-old answer second → the current row is what is remembered (killed by disabling `stillWanted`);
- a read landing mid-refresh (killed by moving the clear back into the entry loop). Its seam is a temporarily replaced `Log.prototype.getInvalidationsFrom`, restored in `finally` — deterministic, but it is a prototype patch; say if you would rather have a slower >128-log-block variant;
- view created after the refresh does not keep it (killed by giving views no floors); view never retires a floor (killed by making `checkOnly` retire); view pinned below the floor is served and cached as before, silently;
- a staged update does not freeze the too-old base (killed by memoizing regardless of `retains`); a write staged over a too-old base declares the revision it was *served* at (killed by making `peek` ignore `unkept`);
- an abandoned entry (blocks never landed — built with `TailLandsButReportsStale(inner, Infinity)` and a writer that gives up): reads keep succeeding with the correct row, the row can be **written** through the refreshed handle, and a fresh handle sees that write;
- the double's pending overlay.

Unit level: `block-floors.spec.ts` (10), `cache-source.spec.ts` (+14: nine on answers the source forbids keeping, five under "an answer overtaken while it was in flight"), `tracker-read-perf.spec.ts` (+2), `transactor-source.spec.ts` (+5, including per-object description with two reads in flight — killed by describing by id). 44 new cases in all.

## Known gaps — not papered over

- **The old content is still returned** while it is all the one transactor will serve — up to one read-repair window (10 s default) instead of forever. Asking another machine is the companion ticket `a-too-old-block-answer-is-retried-against-another-machine` (updated with the names this ticket landed).
- **A retired floor guards nothing.** Content kept, then evicted under cache pressure (128 blocks), then re-read from a machine still behind, is kept too old again with no report. Recorded as a tripwire `NOTE:` on `BlockFloors`, with the alternative (never retire — the memory bound is one `CacheSource.generations` already pays, and `checkOnly` would lose its job). The ticket specified retiring; I followed it. This is the decision I am least sure of.
- **A write staged over a below-floor read** — narrowed, not closed, as the ticket instructed. Appended as an arm to `backlog/bug-a-pended-transform-does-not-carry-its-base`, with what was run (db-core, in-memory double: committed leaf read back mis-ordered `1, 9, 5`; the commit declares the *older* base if the block is not re-read before committing, the *newer* one if it is) and what was only inferred (that a real storage node refuses the first and accepts the second). New behaviour to be aware of: the base under already-staged edits can now change when storage catches up, with no replay.
- **Costs are unmeasured.** While a floor is unmet every read of that block is a transactor request (tripwire `NOTE:` at `mayRetain`). The floors map grows by one small entry per distinct block named by walked entries and never re-read, including log blocks a pure reader never reads again (tripwire `NOTE:` on `BlockFloors`; same bound as `generations`).
- **`stillWanted` changes two small behaviours**: a second identical concurrent answer is no longer re-kept (so no redundant generation bump), and a good answer arriving just after a below-floor hand-through of the same block is dropped once (one extra fetch). Neither is covered beyond the cache-level cases.
- **The concurrency arguments are reasoned about microtask order** and tested only for the specific interleavings above.
- **Read from code, not run:** `TestTransactor`'s pinned read of a block a later action *deleted* returns the pre-delete content, which would read as below-floor. Nothing in the suite trips it (the line fired only in the new spec), but I did not write a case for it.
- **Out of scope by the ticket, unchanged:** blocks first read at open have no floor; blocks an invalidation entry reverts get no floor; an entry older than a log checkpoint sets no floor (`NOTE:` at `raiseFloors`; no checkpoints are written today); the db-p2p cause (`CoordinatorRepo.get`'s time-only test) is `backlog/feat-refresh-can-demand-a-revision-floor`.

## Validation run (2026-09-17, Windows, all foreground)

- `yarn workspace @optimystic/db-core build` clean; db-core suite **1774 passing** (1730 at HEAD plus the 44 new cases), including `refresh-read-cost.spec.ts` budgets.
- `yarn workspace @optimystic/db-p2p test` — **2964 passing**, 63 pending (env-gated). `yarn workspace @optimystic/quereus-plugin-optimystic test` — **987 passing**, 13 pending, smoke ok (includes the storage-op budget specs). Both run after the final code change, against a rebuilt db-core `dist`.
- `yarn lint`, `yarn lint:docs` (146 anchored citations resolve), root `yarn typecheck` — clean.
- **Not run:** `yarn test:integration`, `yarn check:rn`, the `reference-peer` suite, and the downstream `sereus` scenario (not agent-runnable from here; owned by the downstream ticket).
- **Pre-existing, not mine:** `yarn lint:deps` fails on a false positive in `scripts/check-undeclared-deps.mjs` (it reads `['--import', './register.mjs', …]` in `packages/db-p2p/test/module-load-globals.spec.ts` as an import of a package named `, `). Neither file is in this diff. Written up in `tickets/.pre-existing-error.md` for triage; nothing was skipped or loosened.

## Carried forward

- **After the release that contains this**, note the outcome in `../sereus/tickets/blocked/control-peer-row-refresh-invisible-to-third-node.md` so the downstream re-measurement gets scheduled. The release has not happened; carry this item into the `complete/` ticket.

## Board edits made alongside the code

- `backlog/bug-a-pended-transform-does-not-carry-its-base` — new arm (the writer-side instance above).
- `backlog/debt-three-copies-of-the-log-capture-test-helper` — progress note.
- `implement/a-too-old-block-answer-is-retried-against-another-machine` — a "what the prerequisite landed" section naming the API to build on, and which expectation in `refresh-below-floor.spec.ts` should flip.
