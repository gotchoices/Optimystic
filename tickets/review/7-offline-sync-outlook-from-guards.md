description: When a transaction is committed offline, the application is now told whether anything another user does could make it fail — worked out from the checks the transaction carries and from two new table/column tags — and can ask the same question inside an open transaction with a SQL function. Review the implementation.
prereq: offline-sync-plugin-offline-mode
architecture: docs/offline-sync.md#predicting-whether-an-entry-will-commit
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/commit-outlook.ts (new), packages/quereus-plugin-optimystic/src/functions/commit-outlook.ts (new), packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-mode.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-status.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/index.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/offline/status.ts, packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts (new), packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/offline-sync.md, docs/internals.md
----

First half of stage 7 of [docs/offline-sync.md §Implementation stages](../../docs/offline-sync.md#implementation-stages): the `CommitOutlook` of a queued transaction, computed from its staged guards and the queue alone, delivered on the `queued` status, and answered for an open transaction by `CommitOutlook()`. No Quereus change. The second half (keeping the outlook current as earlier entries settle, `outlook-changed`, `offline:assured-entry-failed`) is `tickets/implement/7.1-offline-sync-outlook-follows-the-queue.md`, which builds on this.

## What was built

- **`commit-outlook.ts` (adapter)** — the public types (`CommitOutlook`, `Exposure`, `OutlookDependency`, `UncheckedDecision`, with `unchecked: … | 'not-computed'`), the collection descriptions a table publishes (`TableOutlookSource`, `MainTreeDescription`, `UniqueIndexDescription`), and one exported pure entry point `judgeTransaction(transaction, describe, ahead)`. Internally it is split into `ownJudgement` (exposures, each with its collection id, plus what each judged guard covers) and `outlookFrom` (dependencies and kind), with earlier entries' written keys indexed once per call. `renderCommitOutlook` produces the JSON (bigint safe→number else decimal string, bytes `0x…` hex, unknown key `null`).
- **`OfflineMode`** — `PublishedTable` gains `outlook: TableOutlookSource`; `setTablePolicy` takes it as a fourth argument. A per-transaction `outlooks` map is filled in `onQueueStatus` on the first `queued` of an entry (`judgeQueued`: its held segments read through the bridge's collection registry, earlier entries = those before it in `queue.entries()`, deferred = `OfflineRestore.records()` below its seq and not in the queue), read by `translateListed`, and dropped on a terminal status. `openTransactionOutlook()` judges the open segments of the bridge's staged collections behind everything queued (seq `Infinity`). `describeCollection` asks the published sources of the tables `TransactionBridge.tablesOf(id)` names, in turn, and falls back to `{ kind: 'unknown', table }`.
- **vtab** — publishes `outlookSource` with its policy; `describeCollection` reads the live `tableSchema` tags, `rowCodec` and `resolveEnforcingIndex` at call time (main tree / UNIQUE-enforcing index / other index). Tags `optimystic.fresh` (column) and `optimystic.single_writer` (table), read `=== true`.
- **`decodeIndexKey`** in `index-manager.ts` (rendering-only inverse of `serializeIndexValue`; numeric affinities → number, BLOB → bytes via `atob` after a base64 shape check, else string; never throws).
- **`Collection.openActions()`** in db-core (the open segment, latch-free).
- **`TransactionBridge.stagedCollections()`** — the dirty trees' collections.
- **`CommitOutlook()`** registered beside `StampId` (same flags, `numArgs: 0`, nullable TEXT); `NULL` outside an active transaction.
- **Status** — `queued` gains `outlook?`; types exported from both entries.
- **Docs** — README § Offline mode: new subsection on the outlook, the two tags, `CommitOutlook()`, and two "Not yet in this stage" bullets. docs/offline-sync.md: the `unchecked` type, when the outlook is computed and what is frozen, the judging rules, dependencies for every guard kind and for deferred records, `outlook?` absent while `'restore'`, the corrected db-core sentence, the `CommitOutlook()` details, and a stage-7 paragraph in §Test plan. docs/internals.md: one sentence in the plugin-offline paragraph. The stage list's "implemented" marker is left to the follow-up.

## Tests

`packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts` (one mesh node, a gate that never opens, so entries stay queued):

- insert then update in one transaction — assured under a `fresh` key (pins rule 1, covering), exactly one `primary-key` exposure under a natural key;
- update of a row an earlier queued entry inserted under a fresh key — own judgement clean (rule 4), `dependsOn` names that entry, assured; `entries()` lists the same outlook;
- update of a row committed before going offline — one `row` exposure with the decoded key;
- insert under a fresh key into a table with `email text unique, badge integer unique` — two `unique` exposures with column names and values decoded under each affinity (pins `decodeIndexKey` for text and integer), no `primary-key` exposure;
- `select CommitOutlook()` inside an open transaction (JSON of a natural-key insert) and `NULL` outside one.

`adapter-integration.spec.ts`: the registration test now expects `['StampId', 'CommitOutlook']`.

Validation run: plugin build + `typecheck` clean; full plugin suite once (1126 passing, 1 failing — the registration test above, then fixed); after the fix, the offline specs + `adapter-integration` (118 passing) and the smoke script; db-core `collection-segments` + `offline-queue` specs (53 passing); `yarn lint:docs` clean; eslint over every changed file clean. Not run: the full suite after the fix, the full db-core suite, `yarn check:rn`.

## Judgement calls a reviewer should look at

- **Covering (rule 1) is restricted to `absent`/`unchanged` guards being covered.** The ticket's wording would also let an exact-key write cover a later `absentRange` at the same key; that is unsound (a rival taking the unique value under another key refuses the range without touching the earlier key), so `absentRange` is never covered. SQL never stages that shape today.
- **An undecodable key is reported `rule: 'row'`, key undefined** — literally as the ticket says, even when the guard was a recognised `absent` or `absentRange`. Arguably the original rule with no key would inform an application better.
- **An earlier entry whose segment cannot be read** (no registry instance, or not sealed in the registered instance) counts as writing everything in that collection, so it becomes a dependency; the entry's own unreadable segment is an exposure plus a whole-collection span.
- **`outlook` absent for a restore-registered, not-yet-admitted entry.** `status(id)` during a restore's staging can return a `queued` status without an outlook; it is judged when `admitRestored` emits `queued`. Documented at `translateListed`; the doc says "absent exactly while `'restore'`", which this window arguably is.
- **The own judgement is not held**, only the outlook. The follow-up needs it ("drop exposures whose collection committed; recompute `dependsOn`"): export `ownJudgement`/`outlookFrom` (or have `judgeTransaction` return both) and hold `{ own, outlook }` per transaction.
- **Refused-but-not-yet-failed earlier entries** still count as dependencies (conservative).
- **Registry caveat**: segments are read from the one instance per collection id the bridge registered, so two tables over one URI can read the wrong instance — the caveat `assertNoQueuedEntries` already records; a `NOTE:` at `sealedWrites` says so.
- The §Test plan phrase the follow-up's TODO says to trim now reads "the rest of the outlook (stages 7 to 10)".

## Tripwires left (NOTE:)

- `writtenKeysOf` in `commit-outlook.ts`: the written-key index is rebuilt from every earlier entry on each judgement (enqueue linear in the queue; range checks scan linearly) — keep it incrementally if enqueue gets slow.
- `CollectionJudge.expose`: one exposure per judged guard, so a bulk write of N natural-key rows lists N — cap and mark truncated if statuses get heavy.

## Covered by inspection only (no test)

`single_writer` (update not exposed, natural-key insert still is); primary-key move (delete half `unchanged` on the old key, insert half `absent` on the new, judged independently); REPLACE / eviction (`unchanged` → `row`); a deferred journaled record in `dependsOn` making the entry exposed; a restored entry re-judged against entries restored before it; a segment already refused when judged; a savepoint rollback before `CommitOutlook()` (the open segment is replaced on restore, `openActions` reads the current one).
