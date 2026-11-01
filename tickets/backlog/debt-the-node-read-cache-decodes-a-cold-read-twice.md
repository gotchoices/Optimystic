description: When the node adds its read cache in front of a disk-backed store, every value read from disk is turned from bytes into an object, back into bytes, and into an object again; the cache could sit directly on the store's internal byte layer and skip the round trip.
architecture: packages/db-p2p/docs/storage.md#6-write-through-raw-storage-cache-cachedstoredriver--cachedrawstorage
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts
tradeoffs: Only cold misses pay the extra pass and the fs, NativeScript and web backends have native text decoders, so the saving is unmeasured and may be small; changing what `withReadCache` returns ripples into the lease type the node and the Quereus plugin hold.
----

`withReadCache` (the seam the node's `resolveStorage` and the Quereus plugin's collection factory both use) always builds a `CachedRawStorage`. That is a second `KvRawStorage` over a `CachedStoreDriver` over a `RawStorageDriverAdapter`, which wraps the backend's `IRawStorage`. For a backend that is itself a `KvRawStorage` (fs, NativeScript SQLite, IndexedDB), a cold read therefore decodes the stored bytes into an object in the inner kernel, re-encodes that object to bytes in the adapter, and decodes it again in the outer kernel. `RawStorageDriverAdapter`'s own doc comment already says so, and says that wrapping the backend's driver directly is preferred "when the driver is reachable". The seam never takes that path, because `IRawStorage` does not expose a kernel's driver.

Wanted: when the storage handed to `withReadCache` is kernel-backed, the shared cache fronts that kernel's own driver (with the kernel's value codec — see `storage-drivers-can-carry-values-as-text`). The per-store sharing, the leases and the release-on-last-lease behaviour stay as they are. A storage that is not kernel-backed keeps the adapter.

The React Native backend avoids the problem another way, by building its own cache (`react-native-reads-decode-utf8-in-native-code`), because there the extra decode runs in a slow JavaScript polyfill. This ticket covers the remaining backends.

Not measured. The claim is from reading the composition: one extra encode and one extra decode per cold miss, and nothing on a cache hit.
