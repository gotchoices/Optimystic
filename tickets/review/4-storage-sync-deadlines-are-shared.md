description: The file store's record of write groups that are on disk but not yet synced, and of the earliest deadline among them, now lives in the shared storage package as one small helper, so the phone and browser stores can use the same bookkeeping instead of copying it. The file store uses it with no change in what it does.
prereq: file-store-syncs-by-the-earliest-deadline
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/sync-deadlines.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/test/sync-deadlines.spec.ts, packages/db-p2p-storage-fs/src/file-write-log.ts, packages/db-p2p/docs/storage.md, tickets/implement/4.1-nativescript-storage-syncs-by-the-window.md, tickets/implement/4.2-journal-batch-backend.md
----

# Storage sync deadlines are shared

First of the five tickets from the plan `mobile-and-browser-storage-keep-the-durability-window` (GitHub #37). It extracts the deferred-sync bookkeeping that `file-store-syncs-by-the-earliest-deadline` put into `FileWriteLog` into `SyncDeadlines`, so `nativescript-storage-syncs-by-the-window` and `journal-batch-backend` can reuse it.

## What landed

**`SyncDeadlines<T>`** in `packages/db-p2p/src/storage/sync-deadlines.ts`, exported from both db-p2p entries (`src/index.ts`, `src/rn.ts`). It holds, for a store that defers its sync:

- the batches committed and not yet synced, in order, each with a payload `T` (the file log's is the batch's entries) and a pre-observed `durable`;
- the earliest deadline among them, with an unref'd timer (injectable `setTimer`) armed for it, re-armed only when a new deadline is earlier;
- the `window-overrun` episode, logged on the owner's channel with the file log's exact message text.

It queues nothing. The owner keeps its own serial queue and calls `take()` inside its queued sync step.

Interface, with what changed from the shape the ticket proposed and why:

- `deadlineFor(syncWithinMs)` (new): the deadline of a commit called now; `undefined` for 0 (strict). The landed file log counts a deadline from the commit's **call**, not from when its queue reached it, so the owner has to take the deadline before it enqueues. `defer(item, deadline)` and `mustSyncNow(deadline)` therefore take that deadline rather than `syncWithinMs`.
- `mustSyncNow(deadline)`: strict, or the batch's own deadline or a held one has passed. Checking its own deadline makes it order-independent with `defer`, which the journal and SQLite designs need (they sync a strict batch without ever holding it).
- `defer(item, deadline)`: holds the batch, returns its `durable`; a strict batch is held without a deadline and arms nothing. Throws after `failAll`.
- `onDue: (firedAt) => void` and `take(owedSince?)`: the timer's step hands the fire time to `take`, so timer slop is not read as lateness (what the landed `syncUnsynced(owedSince)` did). Every other `take()` passes nothing.
- `take()` returns a `SyncCover`: `items`, `settle()` (resolve in order, then judge the overrun from the moment `take` was called), `fail(cause)` (reject each with `StoreFailedError`). An empty cover's `settle`/`fail` do nothing, so they neither start nor end an overrun episode.
- `failAll(cause)`: rejects everything held, disarms, and makes later `defer` throw.
- `subject` option (new, required): what the `window-overrun` line names (`a sync of %s`); the file log passes its directory.
- `size`: present per the plan; nothing uses it yet.

**`FileWriteLog`** (`packages/db-p2p-storage-fs/src/file-write-log.ts`) drops its own `UnsyncedBatch` list, `settlement()` helper, `earliestDeadline`, `syncTimer`, `overrunning`, `deadlinePassed`, `armSyncTimer`, `disarmSyncTimer` and `reportOverrun`, and keeps one `unsynced: SyncDeadlines<readonly WriteLogEntry[]>`. The commit is now: take the deadline at the call; in the queued step `append` → `defer` → `mustSyncNow` → sync step. The sync step is `take` → sync handle → apply each batch → `settle`, or `fail` and latch. `latch` calls `failAll`. The overrun `NOTE:` about timer slop moved with `reportOverrun` into the helper; the file log's `commit` doc keeps the strict/relaxed/backpressure rules and names `SyncDeadlines` as where they live.

**Docs:** one sentence in `packages/db-p2p/docs/storage.md` Invariant 6's file-backend paragraph naming `SyncDeadlines` as the shared bookkeeping. `packages/db-p2p-storage-fs/README.md` needed nothing: the message text and channel are unchanged.

**Downstream tickets:** a section "`SyncDeadlines` as it landed" was appended to `tickets/implement/4.1-nativescript-storage-syncs-by-the-window.md` and `tickets/implement/4.2-journal-batch-backend.md`, listing the interface differences above, because both bodies call `mustSyncNow(syncWithinMs)` / `defer(x, syncWithinMs)`.

## Two behaviour differences in narrow paths (please check these)

The ticket asked for no change in behaviour. Both differences below are on fault or shutdown paths, and the normal paths are unchanged:

- **A commit whose append was in flight when a checkpoint failure latched the log is now refused.** A checkpoint syncs the tree outside the commit queue, so its failure can latch the log after a commit passed its `throwIfFailed` and while its append was writing. Before, that batch was still held: a strict one synced and succeeded; a relaxed one waited on its timer, and if the last `release()` came first (which disarmed the timer and skipped the final checkpoint because the log had latched) its `durable` never settled. Now `append` checks the latch again after the write and throws `StoreFailedError`, like every later commit. Its record is in the log and the next open replays it. This was needed because the helper's `defer` throws after `failAll`, as the ticket asked. No test covers this race (a failing checkpoint sync timed against an append in flight); I judged it not worth a dedicated test, so the reviewer may disagree.
- **`shutDown` no longer disarms the sync timer itself.** The final checkpoint's seal runs the sync step, and `take()` disarms the timer; a latched log has already disarmed it in `failAll`. A timer that fires between `release()` and the seal enqueues a sync step that runs before the seal (it covers the batches early), or after it, when it finds an empty cover and touches no handle. The end state is the same.

Also: the latch now rejects the covered `durable`s with a `StoreFailedError` built by the cover, not the same instance the commit throws. Both are `StoreFailedError` carrying the same cause.

## Tests

- `packages/db-p2p/test/sync-deadlines.spec.ts`, with an injected clock and timer:
  - **a later, longer deadline does not move the timer and a shorter one does; the cover settles in order**: A at 5000 ms, B at 9000 ms, one timer at 5000; C at 1000 re-arms it to 1000; `take()` holds A, B, C in order, disarms, and `settle()` resolves them in that order.
  - **an overdue deadline makes the next commit sync**: A at 1000 ms; `mustSyncNow` for a 5000 ms commit is false, then true once the clock passes 1000 without the timer firing.
- `packages/db-p2p-storage-fs/test/file-write-log.spec.ts` is unchanged and green. Its *deferred sync* block covers the helper end to end through the file log: one timer for the earliest deadline, a strict commit settling the waiting batches, backpressure, a checkpoint syncing first, and a failed deferred sync rejecting every waiting `durable`.

## Validation run

- `yarn build` in db-p2p and db-p2p-storage-fs: clean.
- db-p2p `yarn test`: 3421 passing, 72 pending (the same env-gated pendings as before).
- db-p2p-storage-fs `yarn test`: 106 passing, 1 pending (the existing win32 `this.skip()` in `file-storage.spec.ts`).
- `yarn lint`, `yarn lint:docs`, `yarn check:rn`: pass.

## Not done / for the reviewer

- The `window-overrun` text still says "the disk is behind the window". For an IndexedDB or SQLite owner, "disk" is loose wording; it was kept because the ticket said to keep the message text.
- No test pins the overrun logging itself (once per episode, ended by an on-time sync, `owedSince` excluding timer slop). It was untested before the move too. One helper-level test with an injected clock and `log` would pin it cheaply, if the reviewer thinks the diagnostic deserves one.
