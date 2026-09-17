description: After a shared table changed, a machine re-reading the changed record could be handed an old copy, keep it in memory, and never look again — showing stale data indefinitely. The machine now uses what it already knows (which revision the record must be at least as new as) and never remembers an answer that is provably too old. Review found one more way the same thing could still happen and closed it.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/transactor/block-floors.ts (BlockFloors, BlockFloorCheck), packages/db-core/src/transactor/transactor-source.ts (tryGet, describeServed, mayRetain — both NOTEs live here), packages/db-core/src/transform/cache-source.ts (tryGet miss path, stillWanted, keep, handThrough, unkept, retains, peek, getCachedRevision), packages/db-core/src/transform/tracker.ts (sourceRetains, tryGet memo), packages/db-core/src/collection/collection.ts (newFloors, probeHeader, forgetAndAdopt, raiseFloors, revisionsByAction, createReadTracker, updateInternal), packages/db-core/test/refresh-below-floor.spec.ts, packages/db-core/test/block-floors.spec.ts, packages/db-core/test/capture-log.ts, packages/db-core/test/cache-source.spec.ts, packages/db-core/test/tracker-read-perf.spec.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-core/test/barrel-import-cycle.spec.ts, scripts/check-undeclared-deps.mjs, test-harness/undeclared-deps.test.mjs, docs/internals.md, docs/transactions.md, docs/debugging.md, packages/db-core/docs/collections.md
difficulty: hard
----

# A collection never remembers a block older than the log entry that changed it

## What was wrong

When a collection handle refreshes and finds a new log entry, it drops the blocks that entry names from its in-memory read cache so the next read fetches them again. If the machine answering that re-read had not caught up yet, it honestly returned the older block (labelled with its older revision). The cache kept it — for good, because the log entry that would have dropped it had just been consumed and the cache has no expiry. Downstream (`sereus`, ticket `control-peer-row-refresh-invisible-to-third-node`) this showed as a reader polling four times a second and returning the old row for 45 s, long after its own disk had been repaired.

## Two words used throughout

- **Floor** of a block: the revision (and action id) of the newest log entry this handle has walked that names the block. Every block an action changes is committed at that action's revision, so a read of the block at a context at or above the floor must come back at the floor's revision or later.
- **Below-floor answer**: a served block whose reported revision is under the floor that applied to the read.

## What was built

- **Collection** (`collection.ts`). Each handle owns one `BlockFloors`, created in `probeHeader` and shared with every read source the handle builds, pinned read views included. `raiseFloors` records a floor per block for each walked entry. Every below-floor answer is logged as `collection:block-below-floor id=… tag=… block=… floorRev=… floorAction=… servedRev=…`.
- **Source** (`transactor-source.ts`). `tryGet` judges each served block against the applicable floor and records, per returned block *object*, `{ rev, mayRetain }` for `describeServed`. The block is returned either way — no throw. The accepted-tradeoff `NOTE:` (why return rather than throw, with its revisit condition) and the per-read-cost tripwire `NOTE:` are both on `mayRetain`.
- **Cache** (`cache-source.ts`). A below-floor answer is handed to the reader but not cached, so the next read asks storage again. It is kept in a side slot (`unkept`) that only `peek`/`getCachedRevision` answer from — never a read — so a write staged over it still declares the base it was really built on. `stillWanted` re-validates a miss when its answer lands: if anything happened to the block while the read was in flight, the answer is kept only to replace strictly older content.
- **Tracker** (`tracker.ts`). Memoizes "source block + staged edits" only over a base the source retains.
- **Refresh ordering** (`forgetAndAdopt`). Forgetting changed blocks, raising their floors and adopting the new revision is one synchronous step with no `await`, so a read landing mid-refresh cannot re-fetch a just-forgotten block at the revision being left.
- **A floor, once raised, stands for the life of the handle** (changed in review — see findings).

Docs: `docs/internals.md` § "A block re-read after a refresh can be answered too old, and is never remembered", `docs/transactions.md` § Lazy read-repair window, `docs/debugging.md` § "Did a re-read come back older than the log says?", `packages/db-core/docs/collections.md` (update process).

## Known gaps — carried forward, not papered over

- **The old content is still returned** while it is all the one transactor will serve — up to one read-repair window (10 s default) instead of forever. Asking another machine is `implement/a-too-old-block-answer-is-retried-against-another-machine`.
- **A write staged over a below-floor read** — narrowed, not closed, as the fix ticket instructed. This is the most serious residue; see the first "major" finding below. Tracked as an arm of `backlog/bug-a-pended-transform-does-not-carry-its-base`.
- **Costs are unmeasured.** While a floor is unmet every read of that block is a transactor request (tripwire `NOTE:` at `mayRetain`). The floors map holds one small entry per distinct block named by walked entries (tripwire `NOTE:` on `BlockFloors`; same bound as `CacheSource.generations`).
- **Out of scope by the fix ticket, unchanged:** blocks first read at open have no floor; blocks an invalidation entry reverts get no floor; an entry older than a log checkpoint sets no floor (`NOTE:` at `raiseFloors`; no checkpoints are written today); the db-p2p cause (`CoordinatorRepo.get`'s time-only test) is `backlog/feat-refresh-can-demand-a-revision-floor`.
- **Test-double fidelity gap:** `TestTransactor` serves a block still pending under the entry's own action at the *base* revision, which reads as below-floor; a real `StorageRepo` promotes and reports the entry's revision. A db-core spec that reads through that overlay under a floor sees a log line and an extra fetch production would not. Pinned by the spec "serves the entry's own content while its block is still pending…".

## Carried forward — action for a human after release

- **After the release that contains this**, note the outcome in `../sereus/tickets/blocked/control-peer-row-refresh-invisible-to-third-node.md` so the downstream re-measurement gets scheduled. The release has not happened as of 2026-09-17.

## Review findings

Reviewed 2026-09-17. Read the implement diff (`94553aba`) and the triage commit (`9cfa83b0`) before the handoff; then every source, spec and doc file the change touched.

### Major — fixed in this pass

**A floor that was removed when first met re-opened the very defect, under the concurrency the implementer had already established exists.** As implemented, `BlockFloors` dropped ("retired") a floor the moment `TransactorSource` saw an answer that met it. But the source cannot know whether the cache went on to *keep* that answer, and `CacheSource.stillWanted` (added by the same ticket) drops a good answer that was overtaken in flight. Interleaving, two concurrent reads of one block plus one more: (1) a too-old answer lands first and is handed through, which moves the block's generation; (2) the current answer lands second, meets the floor — removing it — and is then dropped by the cache as overtaken; (3) the next read, answered too old by a machine still behind, is judged against nothing and kept for good. **Reproduced before fixing** (scratch spec, then made permanent): the handle returned the old row after storage had caught up. The implementer had flagged floor removal as "the decision I am least sure of" and left a tripwire naming the alternative; its revisit condition is what tripped.

Fix, at the class level rather than the instance: **floors are never removed.** "An answer met the floor" is not "the cache holds that answer", and no bookkeeping at the source can make it so; a standing floor is always true of a correct answer (a block never goes back below a revision it was committed at) and costs one map lookup per fetched block. This also closes the second hole the implementer had recorded only as a tripwire (content kept, evicted under cache pressure, re-read too old from a machine still behind), and deletes code: `BlockFloors.checkOnly()` and the retire flag are gone, and pinned read views now share the handle's `BlockFloors` directly. This deviates from one sentence of the fix ticket ("the floor is dropped once an answer meets it — that is what bounds the map"); the map's bound is now the distinct blocks walked entries named, identical to the never-pruned `CacheSource.generations` map that every `raise` already sits beside. Recorded as a tripwire `NOTE:` on `BlockFloors` (prune the two maps together if it ever matters).

- New regression spec: `refresh-below-floor.spec.ts` "a current answer the cache dropped as overtaken does not leave the next too-old answer unguarded". Mutation-checked: restoring remove-on-met fails it (and the view case).
- Confirmed no false positives from standing floors: ran the 1,759 pre-existing db-core cases with `DEBUG=optimystic:db-core:collection` — 480 collection log lines, zero `block-below-floor`.
- The two-reads-at-once test double was rebuilt (`TwoAtOnceTransactor`, `twoReadsAtOnce`): the original flipped `lagAt` around an `await` while the lagging double read `lagAt` *after* its own `await`, so which read was served current depended on microtask luck. `LaggingDataTransactor` now decides the lag when the read is asked, and the double forces landing order explicitly.
- Updated to match: `block-floors.spec.ts` (−3 retire/`checkOnly` cases, +1 standing-floor case), `transactor-source.spec.ts` (the "meets the floor" case now also proves a too-old answer *after* a good one is still caught), `docs/internals.md` (two paragraphs rewritten, one removed), and `implement/a-too-old-block-answer-is-retried-against-another-machine` (its "names to build on" section said views get `checkOnly()` and that a retry's good answer retires a floor — both now wrong; it says not to reintroduce removal-on-met).

### Major — not fixed here, already ticketed (weigh this one)

**A write staged over a below-floor read can now commit silently-wrong content, where before it failed loudly.** Before this ticket the too-old block stayed cached, staged edits stayed consistent with it, the commit declared the older base, and storage refused it (loud, and stuck). Now the too-old block is not kept, so if the block is read again after storage catches up — a second statement in the same transaction touching the same leaf is enough — positional edits computed against the old content are applied over the new content, the commit declares the *new* base, and the storage-side guard passes. The implementer ran this in db-core against the in-memory double: a B-tree leaf committed in the order `1, 9, 5`. Window: a write staged inside one machine's lag (one read-repair window, 10 s default) over a block another writer just changed. The fix ticket explicitly said not to close this here. It is a class-level defect (a staged edit does not carry the version it was computed against) and is filed as the third arm of `backlog/bug-a-pended-transform-does-not-carry-its-base` (`severity: corruption`, `likelihood: unusual`), with what was run and what was only inferred. I checked that arm reads correctly and did not file a duplicate. No new ticket; but a human triaging that backlog ticket should know this ticket changed that arm from "loud and stuck" to "silent in a narrow window".

### Minor — fixed in this pass

- `cache-source.ts`: the `unkept` doc linked `{@link sourceMayRetain}`, a function that does not exist; it is `sourceServed`.
- `docs/debugging.md`: added the third reading of a `block-below-floor` line — a single line right at a refresh with storage fully current is a read that was in flight when the refresh adopted the new revision (asked at the old revision, judged at the new). Verified from `TransactorSource.tryGet`, which sends the old context and judges with the current one.
- `barrel-import-cycle.spec.ts` (from the triage commit's flagged follow-up): its statement-start anchors had the same latent hole — a file opening with a UTF-8 byte-order mark would have its first import missed. `moduleEdges` now drops a leading mark, with a detection case added. Unexposed today (no file under `packages/db-core/src` carries one), which is why it is a fix here and not a ticket.

### Tripwires — recorded, not ticketed

- Floors map is never pruned — `NOTE:` on `BlockFloors` in `block-floors.ts`.
- Per-read cost while a floor is unmet — `NOTE:` at `TransactorSource.mayRetain` (wording updated: "drop a floor after repeated below-floor answers…").
- Entries older than a log checkpoint set no floor — `NOTE:` at `Collection.raiseFloors` (no checkpoints are written today).

### Considered and left alone

- **Returning a below-floor answer instead of throwing** — carries an accepted-tradeoff `NOTE:` at `mayRetain` with a revisit condition (log entries becoming proof their blocks landed). The condition has not tripped; the abandoned-entry spec shows why a throw would make a correct row unreadable and unwritable.
- **The `unkept` side slot** (beyond the fix ticket's literal "not `cache`, not `revisions`"). Kept: it is never served to a read or to read-dependency stamping, and without it a block updated over a below-floor base goes undeclared at commit and the storage-side base guard abstains. The spec "a write staged over a too-old base still declares the base it was really built on" pins it.
- **The mid-refresh test patches `Log.prototype.getInvalidationsFrom`.** Restored in `finally`, deterministic, and mocha runs spec files serially in one process; a >128-log-block variant would be slower and no more faithful. Left.
- **`floorAction=` on the log line and no `log.enabled` gate** — every argument is already in hand, so a gate would skip no computation. Fine.
- **`collection.ts` is 1,807 lines** (`wc -l`), about +60 from this ticket. Already owned by `backlog/debt-collection-write-retry-logic-outgrew-its-file`; not re-filed.
- **`stillWanted` side effects** (a second identical concurrent answer is not re-kept; a good answer right after a hand-through is dropped once, costing one fetch). Correct and cheap; with standing floors the second is no longer dangerous.

### The triage commit `9cfa83b0` (undeclared-dependency scanner)

- **No real import is now missed — confirmed by re-running the comparison**, not by reading the claim: old versus new extraction over all 904 scanned files loses exactly one specifier, the bogus `", "` in `packages/db-p2p/test/module-load-globals.spec.ts`, and gains none. Two scanned files carry a byte-order mark; both keep all their imports.
- **Anchors accept every real shape:** indented, after `;` on the same line, consecutive statements (the anchor consumes the newline, and the next search still finds the following line), multi-line brace lists, `export … from`; dynamic `import()` and `require()` stay unanchored on purpose. CRLF files are unaffected (`\r` precedes the `\n` the anchor takes).
- **Byte-order-mark stripping shifts no offset that matters:** findings carry a file path and a message only — no line or column is reported anywhere in the script.
- `test-harness/undeclared-deps.test.mjs` runs under `yarn test:harness`: 57 passing across the harness, 0 failing.
- `yarn lint:deps` now passes, so the `.pre-existing-error.md` the implementer wrote is resolved; nothing new to report.

### Validation (2026-09-17, Windows, all foreground, after the final code change)

- `yarn workspace @optimystic/db-core build` clean; db-core suite **1772 passing** (1774 at handoff, −3 retire/`checkOnly` cases, +1 standing-floor case; the refresh spec swapped one case for one).
- `yarn workspace @optimystic/db-p2p test` — **2964 passing**, 63 pending (env-gated). `yarn workspace @optimystic/quereus-plugin-optimystic test` — **987 passing**, 13 pending, smoke ok. Both against the rebuilt db-core `dist`.
- `yarn lint`, `yarn lint:docs` (146 anchored citations resolve), `yarn lint:deps`, root `yarn typecheck`, `yarn test:harness` — all clean.
- **Not run:** `yarn test:integration`, `yarn check:rn`, the `reference-peer` suite, and the downstream `sereus` scenario (not agent-runnable from here; owned by the downstream ticket).
- **Still reasoned, not exhaustively tested:** the concurrency arguments rest on microtask ordering and are tested for the specific interleavings named above. Read from code and not run: `TestTransactor`'s pinned read of a block a later action *deleted* returns pre-delete content, which would read as below-floor; nothing in the suite trips it.
