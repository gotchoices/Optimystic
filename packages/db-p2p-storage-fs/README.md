# @optimystic/db-p2p-storage-fs

Node.js filesystem storage backend for Optimystic peers. Provides:

- **`FileRawStorage`** — implements `IRawStorage` so a Node peer persists block
  metadata, revisions, pending transactions, committed transactions, and
  materialized blocks durably across restarts.
- **`FileKVStore`** — implements `IKVStore` for the persistent transaction state
  used to recover crashed two-phase commits.

This package targets plain Node.js. Use the sibling adapter for other
environments:

- `@optimystic/db-p2p-storage-ns` — NativeScript (iOS/Android, SQLite)
- `@optimystic/db-p2p-storage-rn` — React Native (MMKV)
- `@optimystic/db-p2p-storage-web` — Browser (IndexedDB)

## Install

```bash
yarn add @optimystic/db-p2p-storage-fs @optimystic/db-p2p @optimystic/db-core
```

## Usage

```ts
import { FileRawStorage, FileKVStore } from '@optimystic/db-p2p-storage-fs';
import { createLibp2pNode } from '@optimystic/db-p2p';

const rawStorage = new FileRawStorage('/var/lib/my-peer/data');
const kvStore    = new FileKVStore('/var/lib/my-peer/data');

const libp2p = await createLibp2pNode({
  bootstrapNodes: [/* … */],
  networkName: 'my-network',
  rawStorage,
  kvStore,
});
```

Both constructors take a single `basePath` — the directory under which all
data is stored. They can share the same `basePath` in practice because their
top-level names do not collide: block data lives under `<blockId>/`
subdirectories (block ids are content-address hashes), while KV data lives
under directories named by the first segment of each key (a `/`-separated key
becomes nested subdirectories — e.g. `coordinator/key1` → `coordinator/key1.json`).
Sharing is safe only as long as no block id equals a KV key's first segment;
give them separate `basePath`s if you cannot guarantee that.

## On-disk layout

```
<basePath>/
  <blockId>/
    meta.json                — BlockMetadata (JSON)
    revs/<rev>.json          — ActionId for that revision number
    pend/<id>.json           — pending Transform (two-phase commit, before promotion)
    actions/<id>.json        — committed Transform
    blocks/<id>.json         — materialized IBlock snapshot
  <key-segment>/
    <key-segment>.json       — FileKVStore value; key "/" separators become subdirectories
```

Action ids that contain a colon (e.g. `tx:abcd1234`) are percent-encoded in
filenames (`tx%3Aabcd1234.json`) for Windows compatibility; the storage layer
encodes and decodes transparently so callers always work with the canonical
id form.

## Atomic writes

Every write goes through `atomic-write.ts`: the new content is written to a
`.tmp` sibling, then renamed over the canonical path. A crash mid-write
therefore leaves either the complete old file or the complete new file — never
a partial/torn one.

## Identity

Unlike the `ns`/`rn`/`web` adapters, this package ships **no** identity module
and no `loadOrCreateFSPeerKey` helper. The reference peer that uses this adapter
does not persist its libp2p private key, so an fs-backed node gets a fresh
ephemeral peer id on every restart. Adding durable identity is a separate
feature — see Known limitations below.

## Tests

```bash
yarn test          # mocha, minimal reporter
yarn test:verbose  # mocha, spec reporter
```

Two layers run here, both over a per-test `fs.mkdtemp` fixture with `afterEach`
cleanup:

- **Shared conformance suite** — `runRawStorageConformance('FileSystem', …)` from
  `@optimystic/db-p2p/testing`, the one cross-backend parity target. It proves the
  fs backend (now `KvRawStorage` over a `FileStoreDriver`) behaves identically to
  every other backend: round-trips, `listRevisions` ordering, promote atomicity +
  the exact missing-pend error, clone-on-store/read (structural via the byte
  boundary), drain-before-yield iteration, and a `BlockStorage` parity slice.
- **fs-only tests** (`node:assert`) — the behaviors the shared suite can't cover:
  atomic writes + torn-file corruption tolerance, `readdir` error discrimination,
  colon-encoded filenames + the POSIX legacy raw-colon fallback, the directory-based
  `listBlockIds` meta-gate, and `FileKVStore.list`/`delete`.

## Known limitations

**No cross-process lock.** Two separate Node processes pointing at the same
`basePath` can interleave writes with no coordination. The constructor carries
a TODO (`file-storage.ts:52`) to integrate
[`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) along with
an explicit `dispose()` pattern. Until that lands, `FileRawStorage` is
single-process only.

**Ephemeral peer identity.** There is no `loadOrCreateFSPeerKey` equivalent.
A Node peer backed by `FileRawStorage` gets a new libp2p peer id each restart.
If your use case requires a stable, restart-surviving identity, a future
`feat-fs-peer-identity` feature should add the key-persistence helper — it is
deliberately out of scope here.
