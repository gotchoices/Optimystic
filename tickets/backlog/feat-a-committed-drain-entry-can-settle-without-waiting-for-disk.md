description: Every offline transaction waits for the disk three times on its way through the queue, and for one of those waits nothing would be lost if a crash undid it. Skipping that wait makes sending a queue somewhat faster on slow disks.
architecture: docs/offline-sync.md#write-ordering
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-journal.ts (`OfflineJournal.settled`, `OfflineJournal.write`), packages/db-p2p/src/storage/i-kv-store.ts (`IKVStore.flush`), packages/quereus-plugin-optimystic/test/offline-commit-cost.bench.mjs
tradeoffs: After a crash in the window the application could hear `committed` a second time for a transaction it already heard about, and the saving is one flush in three, on the send rather than on the commit, so a maintainer may reasonably keep the simpler promise.
----
Noticed measuring GitHub #53. The journal flushes three times per entry (docs/offline-sync.md §Write ordering): the entry record, which the commit waits for and which is what "acknowledged" means; the drive record before each send, the write-ahead that makes retries safe; and the outcome record.

Only the third could wait for a committed entry. Losing it in a crash leaves the state the design already handles: "a crash between the network commit and this step leaves an in-doubt record, which the next drain resolves by finding its own log entry". This does not apply to a `failed` outcome, whose loss would restore and re-send a transaction the application was told had failed.

Measured with the bench in `packages/quereus-plugin-optimystic`: at queue depth 1, a file journal costs about 5.8 ms per transaction over a memory one on this machine (`NODE=1 MODE=wait`, 17.8 against 12.0 ms), with 754 ms of idle across 200 transactions. So one flush is worth about 2 ms here. It is worth more on a slower disk, but no slower disk was measured: `FLUSH_MS=20` only simulates one.

The change would have the journal write a `committed` outcome and its deletes unflushed, leaving them to the next flush or the store's idle timer. A plain `IKVStore` has no relaxed flush, and needs none for this: a set with no flush is already relaxed.

It needs the restore path to report such an entry as already committed without a new submission, and `packages/quereus-plugin-optimystic/test/offline-restore.spec.ts`'s "reported committed once" promise reworded to cover the window. Decide that wording first, since it is what the application is told.
