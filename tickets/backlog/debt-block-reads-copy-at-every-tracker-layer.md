description: Reading a block makes several full copies of it as it passes through internal layers, even when the caller only looks at it. A way to read without copying would speed up every transaction, online and offline.
architecture: docs/internals.md#mutation-contracts
files: packages/db-core/src/transform/tracker.ts (`Tracker.tryGet`), packages/db-core/src/transform/cache-source.ts (`CacheSource.tryGet`), packages/db-core/src/btree/btree.ts (`BTree.getPath`, `BTree.leafEdit`), packages/db-core/src/transform/helpers.ts (`apply`), packages/quereus-plugin-optimystic/test/offline-commit-cost.bench.mjs
tradeoffs: The copies are what stop a caller corrupting the cache, and the write path applies operations to what a read returns, so a read-only path adds a way to get that wrong for a saving of perhaps a quarter of a small transaction's time.
----
Noticed measuring GitHub #53, and not specific to offline mode. One B-tree step reads through `Atomic` → `Tracker` → `CacheSource`, and each layer holding staged operations clones: the cache's copy, the tracker's memo copy, and the atomic's. Each copy has a single owner, so none can simply be dropped; `docs/internals.md` §Mutation Contracts explains why they exist.

Measured with `NODE=1 MODE=online N=200 node test/offline-commit-cost.bench.mjs` in `packages/quereus-plugin-optimystic`: about 180 `structuredClone` calls per transaction, 1.8 to 3.6 ms of a 7.8 ms transaction, the time rising as leaves fill. The wrapper timing each call adds some overhead, so treat that as an upper bound.

A saving needs either proof that a caller does not change what it reads, or a separate read-only path for callers that only read. `BTree.getPath` cannot simply take one: `BTree.leafEdit` later applies operations to the blocks on the path, so a write's descent needs writable copies. A point lookup or scan that never writes could.

Worth doing if clones still lead a profile once the offline work under GitHub #53 has landed. Weigh it against that profile, not this one.
