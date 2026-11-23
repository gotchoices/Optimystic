description: Each of the four storage packages now has one call that opens everything a node persists — blocks, node-local records and blob pieces — over one place, instead of the host making three constructor calls and having to know they must all point at the same place.
architecture: packages/db-p2p/docs/storage.md, docs/blobs.md#the-local-store
files: packages/db-p2p-storage-fs/src/node-storage.ts, packages/db-p2p-storage-ns/src/node-storage.ts, packages/db-p2p-storage-web/src/node-storage.ts, packages/db-p2p-storage-rn/src/node-storage.ts, packages/db-p2p/src/storage/storage-monitor.ts, packages/db-p2p-storage-fs/test/file-store-identity.spec.ts, packages/reference-peer/src/cli.ts, packages/db-p2p/docs/storage.md, docs/blobs.md
----

# Each storage package opens a whole node's storage

## What landed

Four functions, one per storage package, each returning the `OpenNodeStorage` db-p2p declares and each named for its backend so a host importing two packages gets two distinct names:

| Package | Function | Location | Options type |
|---|---|---|---|
| `@optimystic/db-p2p-storage-fs` | `fileNodeStorage(basePath, options?)` | one base path | `FileNodeStorageOptions` |
| `@optimystic/db-p2p-storage-ns` | `sqliteNodeStorage(db, options?)` | one open SQLite database | `SqliteNodeStorageOptions` |
| `@optimystic/db-p2p-storage-web` | `indexedDbNodeStorage(db, options?)` | one open IndexedDB handle | `IndexedDBNodeStorageOptions` |
| `@optimystic/db-p2p-storage-rn` | `levelDbNodeStorage(db, options?)` | one open LevelDB handle | `LevelDBNodeStorageOptions` |

Each is in its own `src/node-storage.ts`, exported from its package index, synchronous (every store constructor is), and builds that package's three stores over the one location with their existing defaults — including each key-value store's default `optimystic:txn:` prefix, which is what keeps its rows clear of the identity helper's. Each options type is the intersection of what that package's three stores accept, and is passed to each store that accepts one; in all four cases the block store's own options type turns out to be the superset.

Each ends by asserting its own result, through **one shared helper in db-p2p** — `assertBlockStoreCountsPieces(blocks, pieces, location)` in `packages/db-p2p/src/storage/storage-monitor.ts`, beside the `blockStoreCountsPieces` predicate the node's storage monitor itself reads. That is the boundary check that keeps a future edit — a piece store moved to a sibling directory, a second handle opened inside a factory — from silently making the node double-count its blob pieces, and it is now stated in one place rather than copied per backend, so a fifth storage package inherits it instead of re-deriving it.

### Who closes what

`close()` releases what the factory opened and nothing else, in one order across all four: the piece store, then the key-value store, then the block store, each step in `try`/`finally` so a rejection still closes the stores under it.

- **fs** — the order is *required*: the last store over the directory is what checkpoints the shared write-ahead log and removes the lock, so the block store goes last. This is the order `openBackend` in `packages/upgrade-check/test/current-build.ts` still uses by hand.
- **ns** — the piece store and the key-value store have no `close` (both write by autocommit statement), so their `flush()` is called instead: a flush is the whole of what closing either would mean, and it is what this package's readme told hosts to do at shutdown. Then `SqliteRawStorage.close()`.
- **web, rn** — the key-value store's `close()`, then the block store's. Nothing is called on the piece store: each put is durable when it resolves, so it has neither a `close` nor a flush with work to do.
- **ns, web, rn all leave the handle alone.** The host opened it, may be sharing it with the identity helper or with Quereus, and closes it afterwards. Stated on each function and in each readme.

### The fs factory returns one storage per directory

`fileNodeStorage` keeps a process-wide map from resolved directory identity to the stores it opened and counts its holders: the stores close when the last holder closes, the entry is dropped then, and a later call over that path opens them afresh.

Not a convenience — for files the location is named by a path rather than held as an object, and a second `FilePieceStore` over one directory is *documented-unsupported* (its open deletes the first's in-flight temps and fails its next put), unlike the block and key-value stores, which already share one log and one lock per directory by design.

Two calls over one directory hand back two handle objects whose `blocks`, `kv` and `pieces` are the *same* store instances, each handle's `close` releasing its own holder at most once. That resolves the one place the implement ticket asked for both "two calls return the same value" and "close idempotent per holder", which cannot both hold of a single shared object: with one object there is no way to tell one holder closing twice from two holders each closing once. Reviewed and kept — the invariant that matters (one directory means one set of stores) holds exactly, and the spec asserts it by instance identity on all three fields.

### reference-peer

`openStores` is now one line — `fileNodeStorage(options.storagePath!)` for `--storage file`, `memoryNodeStorage()` for memory — and its hand-written three-step close chain is gone. The comment keeps both of its points: the CLI closes the storage because the node closes no store it was handed (after `stop()`, and on a failed `createLibp2pNode`), and memory storage is passed explicitly because a peer that asked for memory means it.

### Docs

Each storage package's readme section on handing stores to a node is replaced by the one call, each saying what the location is, that the three stores share it and therefore report one store identity so pieces are counted once, and who closes what. `packages/db-p2p/docs/storage.md` §8 gained two paragraphs naming the four functions, the shared assertion helper and the fs one-set-per-directory rule; `docs/blobs.md` §The local store names the four in its piece-store paragraph.

## Tripwires parked

- **Path spelling** — `NOTE:` above `openDirectories` in `packages/db-p2p-storage-fs/src/node-storage.ts`: two spellings that resolve differently (a symlink and its target; two cases of one directory on a case-insensitive volume off win32) are two map entries and two sets of stores over one directory, which double-counts pieces and breaks the piece store. The same under-approximation `identityForHandle` and the log registry make deliberately. Fix if ever reported: key on `fs.realpath`, which makes the factory asynchronous.
- **Options divergence is silent** — `NOTE:` above `fileNodeStorage`: the options are the first caller's, and a later call over a directory already open has its own options ignored without a word. The directory's log at least logs differing checkpoint settings; nothing here can, because a second caller constructs nothing for the log to compare.

## Tests

One case in `packages/db-p2p-storage-fs/test/file-store-identity.spec.ts` per behaviour, both in a file that already existed for this contract:

- **`gives a FilePieceStore over the same basePath one identity with the block store, so pieces are counted once`** — in the existing `FileRawStorage store identity` suite, over directly constructed stores, so it fails if `FilePieceStore` ever names the `optimystic-pieces/` directory inside the base path instead of the base path itself. No I/O, like its siblings there.
- **`opens one set of stores per directory, released by the last holder`** — the fs reference counting, using `store.lock` as the observable (present exactly while some holder has the directory): two calls hand back the same three store instances; the lock survives one holder closing, and that holder's write is still readable through the other; the lock survives the *same* holder closing twice, so a double close does not release another holder's stores; the lock is gone after the last holder closes; and a call after that opens a fresh set which reads what the released set flushed. Its own `fs.mkdtemp` directory, every storage closed, since the last close is what releases the lock.

No test for the three handle-taking factories, and none for `openStores` in reference-peer — see the findings below for why each is covered by composition rather than owed a case.

## Review findings

Reviewed the implement diff (`ticket(implement): each-storage-package-opens-a-whole-nodes-storage`) before its handoff summary, then read each store class the four factories build, `FileWriteLog`'s registry, `blockStoreCountsPieces` and its caller in `StorageMonitor`, every remaining direct piece-store construction in the repository, and the open/close balance in `packages/reference-peer/src/cli.ts`.

**Fixed in this pass (three, all minor).**

- **DRY — the identity assertion was copied into all four packages.** `assertOneLocation` existed four times with byte-identical bodies and an identical seven-line doc comment, differing only in the noun phrase in its message. Replaced by one `assertBlockStoreCountsPieces(blocks, pieces, location)` exported from `packages/db-p2p/src/storage/storage-monitor.ts`, directly beneath the predicate it asserts, with the four factories passing their location (`basePath`, or `'this SQLite handle'` and friends) — messages unchanged. This is the boundary-invariant rung rather than four point fixes: a fifth storage package now inherits the check instead of copying it, and the four factories keep only their own backend-specific prose. `packages/db-p2p/docs/storage.md` §8 names the helper.
- **A test that could never fail.** The new `fileNodeStorage` case `gives the block store and the piece store one identity` asserted `blockStoreCountsPieces(storage.blocks, storage.pieces)` on a storage the factory had just returned — but the factory throws on exactly that predicate, so the assertion was unreachable as a failure, and the refcounting case below it already opens the factory three times. Replaced with a case that *can* fail: the same contract over a directly constructed `FileRawStorage` and `FilePieceStore`, in the suite where the sibling identity cases live. Net zero cases, one of them now live.
- **A doc sentence that was wrong about ns.** `packages/db-p2p/docs/storage.md` §8 said the three handle-taking factories "close only the stores that hold writes in memory" — but `sqliteNodeStorage` *flushes* its piece store and key-value store (neither has a `close`, and the piece store holds no writes in memory; what it owes is a sync). Reworded to say they close or flush whichever stores still owe durability, naming the SQLite case.

**Checked and correct, no action.**

- **The fs refcount handover.** `release()` drops the map entry *before* awaiting the closes, so a call made during them opens a fresh set. The comment's claim that the directory's log serializes that handover is accurate: `FileWriteLog` keeps a `closing` map and a new `acquire` waits for a log still letting go of its handle and lock. A holder's closure keys on its own `OpenDirectory` object and `release` re-checks `openDirectories.get(held.identity) === held`, so a stale holder cannot delete a newer entry or double-decrement. Concurrent closes, a double close, and close-then-reopen are each correct, and the spec covers all three.
- **Close error handling.** Each factory's nested `try`/`finally` does close every store beneath a rejecting one, and the first rejection propagates unless a later close also rejects — which the docs state.
- **The two deviations from the implement ticket.** The per-holder handle (above) is the right reading of a self-contradictory requirement. Keying the map on `fileStoreIdentity(basePath)` rather than bare `path.resolve` is strictly better than the ticket's text: it is the same key `FileWriteLog.acquire` uses, so the factory's map and the directory's log agree exactly, and it folds case on win32 where two cases are one directory.
- **The handoff's "ns and web identity equality has no test" gap is not a gap.** In both packages the piece store imports the block store module's own scheme constant (`SQLITE_HANDLE_SCHEME`, `IDB_HANDLE_SCHEME`) and calls `identityForHandle` on the same handle object, so equality holds by construction and a test would be asserting a shared constant and a `WeakMap` — the same reason the ticket gave for not testing the three handle-taking factories. The one place identity equality is *derived* rather than structural is fs, where both stores call `fileStoreIdentity(basePath)` and the piece store could plausibly be changed to name its own subdirectory; that is the case added above.
- **`openStores` in reference-peer.** Still a one-line ternary typed by `tsc`, which the testing rules put on the do-not-test list, and the behaviour under it — write, close, reopen over one directory — is what the fs refcounting case covers. Read the CLI instead: `openStores` is called once per `startNetwork` (which early-returns when already connected) and the storage is closed once per `stopNetwork` and once on a failed `createLibp2pNode`, so holders balance and a stop/start cycle in one process correctly gets a fresh set. No manual CLI run was performed; nothing in the diff's behaviour is reachable only through it.
- **Nothing else in the repository should have been converted.** Every remaining direct construction of a piece store is a spec of its own store or `packages/upgrade-check/test/current-build.ts`, whose job is to reproduce each release's layout (two directories for `fs`) and which deliberately keeps building its three stores by hand.
- **`memoryNodeStorage` rightly does not assert.** Neither `MemoryStoreDriver` nor `MemoryPieceStore` reports a store identity, deliberately, so `blockStoreCountsPieces` is false and the monitor adds the piece bytes — which is correct for memory, and why the new helper is a factory-side check rather than something `memoryNodeStorage` owes.
- **Source hygiene.** The four modules are 132 / 53 / 50 / 58 lines after the shared helper landed, with no narrated statements left: every comment carries a why, a constraint or a consequence, at the density of the surrounding files.

**Major findings: none.** Nothing in the diff reached the filing bar — no new ticket, and no `backlog/` entry, because no latent defect was found whose anchor is deferred.

**Conditional/speculative: none new.** The two tripwires the implementer parked (path spelling, silent options divergence) are correctly placed as `NOTE:`s at their sites and were not re-filed. No accepted-tradeoff `NOTE:` at any site touched had its revisit condition trip.

## Validation run

All in the foreground, all green.

```
yarn build
yarn lint                                                  # clean
yarn lint:docs                                             # 49 documents, 895 anchored citations, 922 file mentions, 848 links - all resolve
yarn lint:deps                                             # 6 guarded packages on their expected majors; every import declared
yarn typecheck                                             # 13 packages
yarn workspace @optimystic/db-p2p-storage-fs test           # 133 passing, 1 pending
yarn workspace @optimystic/db-p2p-storage-ns test           # 86 passing
yarn workspace @optimystic/db-p2p-storage-web test          # 80 passing
yarn workspace @optimystic/db-p2p-storage-rn test           # 82 passing
yarn workspace @optimystic/db-p2p test                      # 3882 passing, 84 pending
yarn workspace @optimystic/reference-peer test              # 6 passing
yarn workspace @optimystic/upgrade-check test               # 341 passing
yarn workspace @optimystic/quereus-plugin-optimystic test    # 1457 passing, 15 pending, smoke ok
yarn check:rn                                               # Metro 50.7s, hermesc 43.1s
```

`db-p2p`, the four storage packages, `reference-peer`, `upgrade-check` and `quereus-plugin-optimystic` are every package this change touches plus every package that depends on one of them — the review-stage obligation in `tickets/rules/testing.md`. `yarn test:integration` was not run: the change touches storage only, not networking, cohort assembly, reactivity or matchmaking.

No pre-existing failure surfaced.
