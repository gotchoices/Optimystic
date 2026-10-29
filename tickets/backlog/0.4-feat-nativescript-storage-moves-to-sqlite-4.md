description: The NativeScript (phone) storage uses version 3 of its SQLite plugin, which copies every stored value between JavaScript and native code one byte at a time and runs every query on the same thread as the network; move to version 4, which copies in bulk and runs queries on a native thread.
architecture: packages/db-p2p-storage-ns/README.md
files: packages/db-p2p-storage-ns/package.json, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/sqlite-kv-store.ts, packages/db-p2p-storage-ns/src/identity.ts, packages/db-p2p-storage-ns/src/connection-mutex.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/README.md
tradeoffs: The 4.x line was published the day the issue was filed, so it may be worth letting it settle first, and the reporter already runs a patch for 3.x that removes the largest cost.
----

# NativeScript storage moves to `@nativescript-community/sqlite` 4.x

GitHub #38 (kjeib). `@optimystic/db-p2p-storage-ns` requires `@nativescript-community/sqlite` `^3.5.0`.

## What 3.x costs (measured by the reporter: NativeScript 8.9, V8, `openOptimysticNSDb` with its WAL / `synchronous = NORMAL` pragmas, a Galaxy S7 and an Android emulator)

- **Blobs cross between JavaScript and Java one element at a time.** The plugin's `arrayToNativeByteArray` fills a Java `byte[]` element by element for every bound blob, and its `byteArrayToBuffer` reads one back the same way; each element is a separate call into Java, about 10 µs on the S7. A 16 KB blob costs 109–170 ms each way, against about 1 ms copied in bulk. Every block, revision, action and proof this storage writes is a blob (the value columns in `SCHEMA_SQL`, `packages/db-p2p-storage-ns/src/db.ts`).
- **Every statement runs on the JavaScript thread.** 3.x is synchronous unless `threading` is on, and the opener does not turn it on: 2.9 ms per 1 KB autocommit write and 4.1 ms per 1 KB read on the S7, on the thread that also runs libp2p, Noise and yamux.
- **A bare database name needs an activity.** 3.x opens a bare name through the foreground activity; a node started at app launch intermittently fails with "Cannot read properties of undefined (reading 'openOrCreateDatabase')". The reporter passes a full path as a workaround.

## What 4.x changes (from its README and migration guide)

Every call runs on a native thread and returns a promise; blobs are bound and returned natively (`Uint8Array` out); a bare name goes to the databases folder without an activity; `batch()` sends many statements in one native call; `*Sync` variants exist on NativeScript 9.1+; NativeScript 8 is supported through `@nativescript-community/sqlite-bridge`.

## Migration points in this package

- The open is asynchronous: await `db.ready`, or use `openOrCreateAsync` (`openOptimysticNSDb` in `src/ns-opener.ts`).
- `threading` is ignored; `getVersion()` / `setVersion()` are async; `wrapDb` is gone.
- Calls made on the same `db` during a `transaction` join it. That changes the ground under `NSPluginDbWrapper`'s connection mutex and its `transaction(fn)` (the deadlock and cross-rollback reasoning in `src/connection-mutex.ts` and the `SqliteDb.transaction` comment in `src/db.ts`); re-derive both rather than port them.
- `SqliteBatchBackend.commit` applies a whole write group as one transaction, a natural `batch()` candidate.

## Interaction

`nativescript-storage-syncs-by-the-window` gives this backend a real `flush()`: one transaction per write group through `SqliteBatchBackend`, a `synced` option on `SqliteDb.transaction` that commits under `synchronous = FULL` and restores `NORMAL`, and `syncSqliteDb`, a synced one-row commit that syncs the shared write-ahead log for the key-value store, the identity helper and the deadline timer. Whichever lands second must keep the other's behaviour: the synced transaction has to survive 4.x's new transaction model (calls on the same `db` during a transaction join it), and one transaction or `batch()` per write group serves both.

The Node test driver (`test/node-sqlite-driver.ts`, over `node:sqlite`) stays the unit-test surrogate; the plugin itself is an uninstalled peer dependency in the Node test environment, so the migration needs a device or emulator check.
