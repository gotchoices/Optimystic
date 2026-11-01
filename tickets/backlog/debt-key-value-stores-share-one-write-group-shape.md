description: The three key-value stores (file, browser and React Native) each re-implement the same in-memory overlay logic around a write group; one shared base in the storage kernel would let a new backend supply only how it reads and commits.
architecture: packages/db-p2p/docs/storage.md#6-a-write-survives-a-crash-once-a-flush-called-after-it-has-resolved
files: packages/db-p2p/src/storage/write-group.ts, packages/db-p2p/src/storage/i-kv-store.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-web/src/indexeddb-kv-store.ts, packages/db-p2p-storage-rn/src/leveldb-kv-store.ts
difficulty: easy
tradeoffs: Three copies of about forty shared lines each read fine as they are, and the file store differs enough (it opens its log on first use and passes the group's sync through to that log) that a base class needs two hooks beyond commit and listing; a maintainer may judge the indirection not worth it until a fourth backend arrives.
----

# Key-value stores share one write-group shape

Found while reviewing `react-native-storage-commits-groups-through-the-journal`, where `LevelDBKVStore` was rewritten over a `WriteGroup` and came out as a near copy of `IndexedDBKVStore`, which is itself a near copy of `FileKVStore`.

## What is repeated

Each of the three `IKVStore` implementations over a `WriteGroup<string>` carries the same code around the group, differing only in two places:

- `get`: consult the group's overlay first (`lookup`), decode a held value, treat a held `null` as a delete, and only then read the store.
- `set` and `delete`: record into the group and resolve at once.
- `list`: snapshot the overlay's entries **before** awaiting the store's listing, then add held puts and remove held deletes. The ordering is a correctness rule, not a style choice: a commit resolving during the await drops entries from the overlay that the store's listing was taken without. Each copy carries the same comment saying so.
- `flush`, `whenDurable` and `close` pass straight through to the group.
- The lazy `TextDecoder` and the UTF-8 encode of values.

What differs per backend is only `commit(entries)` (one LevelDB batch, one IndexedDB transaction, one write-log record) and `listStored(prefix)` (a range scan, an object-store cursor, a directory walk). The file store additionally opens its log on first use and forwards the group's `sync` to the log, where the other two give the group a no-op `sync` because every commit of theirs is already as durable as the store can make it.

Measured with `wc -l`: the file store is 148 lines, the browser store 119, the React Native store 107, and roughly forty lines of each are the shared part above.

## Shape proposed

An abstract `WriteGroupKVStore` in `packages/db-p2p/src/storage/` beside `WriteGroup`, owning the overlay reads, the string encoding and the pass-throughs, with two abstract methods, `commit(entries, options)` and `listStored(prefix)`, and an overridable `sync()` that defaults to resolved. The three stores become their two methods plus construction. The snapshot-before-await rule in `list` then lives at one site, and a fourth backend cannot get it wrong by omission.

## Why this is worth a ticket rather than a note

The repeated part contains an ordering rule that every copy has to restate and that a reviewer has to re-verify per backend. Lifting it is a representation change that retires the class of error for every backend at once, which is the first rung of the filing ladder.
