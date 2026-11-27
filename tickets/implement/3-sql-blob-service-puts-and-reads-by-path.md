description: Applications that use blobs through the SQL plugin, like Sereus Chat, need the new store-from-a-file and write-to-a-file forms too, with the same transaction pin rules a normal blob put gets, so a photo stored from a file is kept or released exactly as one stored from bytes would be.
prereq: 1-blobs-put-and-read-by-file-path
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/sql-blob-service.ts (`SqlBlobService.put`, `defaultPinOwner`, `backendNow`), packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (`SqlBlobBackendService`, `BlobBackend`), packages/db-core/src/blob/service.ts (`BlobPathAccess`), docs/blobs.md
----

# The SQL plugin's blob service puts and reads by path

`1-blobs-put-and-read-by-file-path` adds `BlobService.paths` (`putFile`, `readToFile`), present only when the node's piece store offers file access and `blobs.paths` is not `'off'`. `SqlBlobService` is the blob service SQL applications hold; it resolves its backend (a node's `node.blobs`, or a single-machine service) lazily through `backendNow()`, and labels every put's pin by the transaction open when the put starts (`sql/<stampId>/put`, or `sql-unstaged/<ms>` outside a transaction), recording it on that transaction when it is still open at the end (`bridge.noteBlobPut`).

## The change

Because the backend is resolved asynchronously, `SqlBlobService` cannot know synchronously whether path access exists, so it does not set `paths` (leaving the `BlobService` contract — present exactly when available — true). It adds instead:

```ts
/** The backend's path access, wrapped with this service's pin rules; undefined when the backend has none. */
async pathAccess(): Promise<BlobPathAccess | undefined>
```

The returned object's `putFile(path, options)` is `put`'s body with `backend.service.paths.putFile(path, { ...options, owner })` in place of `backend.service.put(source, …)`: same default owner computed at the start, same `noteBlobPut` when the defaulting transaction is still the open one. Factor the shared part of `put` (owner choice before, noting after) into one private method taking the backend call, so the two cannot drift. `readToFile` delegates to the backend's. `mode` is the backend's.

Capture the backend once per `pathAccess()` call; a backend change afterwards (if the factory can change it) is the host's concern and is noted in the doc comment.

## Edge cases & interactions

- **Pin label and release** — identical to `put` by construction (shared method). By inspection.
- **Backend without path access** — `pathAccess()` resolves `undefined`. By inspection.
- **A put that outlives its transaction** — the same stray-pin rule `put` documents (`SqlBlobPins.reconcile`). By inspection.

## Tests

None beyond what ticket 1 pins: the pin rules are shared code with `put`, which `sql-blob-service` specs already cover. If the factoring of `put` changes its behaviour, those specs catch it.

## Docs

docs/blobs.md §SQL: one paragraph on `pathAccess()`, and that a path put follows the same pin rules as `put`. `yarn lint:docs`.

## TODO

- Factor `SqlBlobService.put` into owner choice → backend call → noting; add `pathAccess()`.
- Docs.
- Build db-core, db-p2p and the plugin; `yarn typecheck`; run the plugin's sql-blob-service specs by file; `yarn lint:docs`.
