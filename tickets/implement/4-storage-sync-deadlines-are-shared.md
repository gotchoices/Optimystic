description: The file store keeps a list of write groups that are on disk but not yet synced, and syncs them by the earliest deadline any of them was given. The phone and browser stores need the same bookkeeping, so move it into the shared storage package as one small helper that the file store uses first, with no change in behaviour.
prereq: file-store-syncs-by-the-earliest-deadline
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/sync-deadlines.ts, packages/db-p2p/src/storage/write-group.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p-storage-fs/src/file-write-log.ts, packages/db-p2p-storage-fs/test/file-write-log.spec.ts, packages/db-p2p/docs/storage.md
difficulty: medium
----

# Storage sync deadlines are shared

First of five tickets from the plan `mobile-and-browser-storage-keep-the-durability-window` (GitHub #37). The rest: `nativescript-storage-syncs-by-the-window`, `journal-batch-backend`, `browser-storage-syncs-by-the-window`, `react-native-storage-commits-groups-through-the-journal`, and the blocked report `react-native-storage-syncs-once-rn-leveldb-can`.

`file-store-syncs-by-the-earliest-deadline` made `FileWriteLog` (`packages/db-p2p-storage-fs/src/file-write-log.ts`) defer its sync: a batch committed with `syncWithinMs` greater than 0 is appended and resolved at once, its `durable` promise is held in an in-order `unsynced` list with a deadline, a timer is armed for the earliest deadline, a strict commit or an overdue deadline syncs in the commit itself (the backpressure rule), a sync settles every batch it covered in order, a late sync logs `window-overrun` once per episode, and a failure rejects every pending `durable`.

The SQLite backend (`nativescript-storage-syncs-by-the-window`) and the shared journal backend (`journal-batch-backend`) need exactly this bookkeeping with a different sync step. Three copies of it would drift. This ticket extracts it.

**Read the landed `FileWriteLog` first.** The shape below is what the plan expects; where the landed code's bookkeeping differs, extract what landed and adapt the interface, keeping the three behaviours every consumer relies on: covered batches settle in commit order, a sync covers exactly the batches recorded before it started, and a deadline already passed makes the next commit sync.

## The helper

`packages/db-p2p/src/storage/sync-deadlines.ts`, exported from `src/index.ts` and `src/rn.ts` (the entry-parity spec checks `rn.ts`):

```ts
export interface SyncDeadlinesOptions {
	/** Called (from a timer) when the earliest deadline is due. The owner enqueues its sync step. */
	readonly onDue: () => void;
	/** Injectable for tests; unref'd by default, as `WriteGroup`'s idle timer is. */
	readonly setTimer?: SetTimer;
	/** Injectable clock for tests; `Date.now` by default. */
	readonly now?: () => number;
	/** Where `window-overrun` is logged: the owner's own channel. */
	readonly log: (formatter: string, ...args: unknown[]) => void;
}

/** The batches one sync covers, taken just before it starts. */
export interface SyncCover<T> {
	readonly items: readonly T[];
	/** The sync succeeded: resolve each item's `durable` in order, log an overrun if it finished late. */
	settle(): void;
	/** The sync failed: reject each item's `durable` with `StoreFailedError` carrying `cause`. */
	fail(cause: unknown): void;
}

export class SyncDeadlines<T> {
	constructor(options: SyncDeadlinesOptions);
	/** Whether a batch committing now with this window must be synced before its commit resolves: `syncWithinMs` 0, or a held batch's deadline has passed. */
	mustSyncNow(syncWithinMs: number): boolean;
	/** Hold a batch committed without its sync. Returns its `durable`. Arms the timer, or re-arms it when this deadline is earlier. */
	defer(item: T, syncWithinMs: number): Promise<void>;
	/** Everything held, in order, for a sync that starts now. Disarms the timer. Empty when nothing is held. */
	take(): SyncCover<T>;
	readonly size: number;
	/** Reject everything held with `StoreFailedError` carrying `cause` and disarm the timer (the owner latched failed, or closed). */
	failAll(cause: unknown): void;
}
```

The payload `T` is whatever the owner's sync step needs: the file log's batches for its tree apply, the journal backend's records, nothing at all (`void`) for SQLite.

The owner keeps its own serial queue and calls `take()` inside the queued sync step, so a sync covers exactly what was held when the step began. The helper does not queue anything itself.

`window-overrun`: logged once per episode by `settle()` when the sync finished after the earliest deadline it covered, with the lateness in ms and the count of batches. An episode ends at the next on-time settle. Keep the message text the file log uses today, so `docs/debugging.md` stays right.

## `FileWriteLog` uses it

Replace the file log's own list, timer and overrun state with a `SyncDeadlines<…>` whose payload is what the sync step applies to the tree. Behaviour must not change; `test/file-write-log.spec.ts` stays green without edits beyond construction details. The `NOTE:`s at the file log's commit and sync step that describe the deferral stay at the file log, pointing at the helper where they describe its rules.

## Edge cases & interactions

- `take()` with nothing held returns an empty cover whose `settle` and `fail` do nothing (by inspection).
- A timer firing after a strict commit already took everything finds nothing to do: `onDue` is called only while something is held, or the owner's step finds an empty cover (by inspection).
- `defer` after `failAll`: the owner refuses commits once latched, so this cannot happen; assert it at the helper (throw) rather than silently holding a promise nobody will settle.
- Re-arming: a later, longer deadline never pushes the timer back (test below).
- The default timer is unref'd, so a held batch never keeps a Node process alive (by inspection; same helper as `WriteGroup` uses).

## Tests

In `packages/db-p2p/test/sync-deadlines.spec.ts`, with an injected `setTimer`:

- **A later, longer deadline does not move the timer, and a shorter one does; the cover settles in order.** Defer A at 5000 ms, then B at 9000 ms: one timer at 5000. Defer C at 1000: re-armed at 1000. `take()` holds A, B, C in that order, and `settle()` resolves their promises in that order.
- **An overdue deadline makes the next commit sync.** Defer A at 1000 ms, advance the injected clock past it without firing the timer: `mustSyncNow(5000)` is true.

The file log's own spec covers the sync step end to end.

## TODO

- Read the landed `FileWriteLog` deferral code.
- `SyncDeadlines` in `src/storage/sync-deadlines.ts`; exports in `src/index.ts` and `src/rn.ts`.
- Move `FileWriteLog` onto it, behaviour unchanged.
- One sentence in `packages/db-p2p/docs/storage.md` Invariant 6, where the file backend's deferred sync is described, naming `SyncDeadlines` as the shared bookkeeping.
- Tests above. Build db-p2p and db-p2p-storage-fs; run both suites, `yarn lint`, `yarn lint:docs`, and `yarn check:rn` (an `rn.ts` export changed).
