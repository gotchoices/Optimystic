description: Applications that reach blobs through the SQL plugin can now store a file straight from disk and write one straight back out, under exactly the pin rules an ordinary blob put gets, so a photo stored from a file is kept or released the same way one stored from bytes is.
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/sql-blob-service.ts, packages/quereus-plugin-optimystic/src/plugin.ts, docs/blobs.md, packages/quereus-plugin-optimystic/README.md, tickets/backlog/feat-a-sql-host-cannot-turn-on-blob-file-paths.md
----

# The SQL plugin's blob service puts and reads by path

`SqlBlobService` exposes the backend's file-path forms wrapped in its own pin rules, as `pathAccess()`.

## What was built

**`SqlBlobService.pathAccess(): Promise<BlobPathAccess | undefined>`** (`packages/quereus-plugin-optimystic/src/optimystic-adapter/sql-blob-service.ts`). Resolves the backend, captures it once, and answers `{ mode, putFile, readToFile }` when `backend.service.paths` is there — `undefined` when it is not. `mode` and `readToFile` are the backend's, passed through: a read pins nothing.

**`put` factored into `pinnedPut(explicitOwner, backendOf, store)`**, which holds the whole pin discipline — the default owner label chosen before anything is awaited, the backend resolved after, the store called, and the put recorded on the bridge only when the transaction that defaulted the label is still the open one. `put` passes `() => this.backendNow()`; `pathAccess`'s `putFile` passes `async () => backend`, the backend already captured. One method, two callers, so a stream put and a path put cannot drift.

**A method rather than the `BlobService.paths` property**, which this service therefore never sets: the backend resolves asynchronously, so nothing here can answer synchronously whether path access exists, and a present-but-throwing property would break the one thing that contract promises — present exactly when available.

**Documentation.** docs/blobs.md §SQL gained a bullet on what `pathAccess()` answers, why it is a method, that a path put follows `put`'s pin rules, and which networks offer it today; packages/quereus-plugin-optimystic/README.md § Large values gained the host-facing form; `plugin.ts`'s `blobs` jsdoc points at it. Review added the two docs/blobs.md edits listed under *Documentation* below.

## Review findings

Read the implement diff (`ticket(implement): sql-blob-service-puts-and-reads-by-path`) before the handoff summary, then the contract it wraps (`BlobPathAccess` in `packages/db-core/src/blob/service.ts`), both implementations of it (`LocalBlobService.pathAccess`/`putFile` and `pathAccessOverNetwork` in `packages/db-p2p/src/blob/`), the backend resolution the wrapper depends on (`CollectionFactory.resolveBlobBackend`), and what consumes a recorded put (`TransactionBridge.noteBlobPut`, `SqlBlobPins.releasePuts`).

### Correctness

- **The pin label is chosen in the host's own tick, through both routes.** Traced rather than taken from the handoff's assertion. `access.putFile(path)` invokes the arrow, which synchronously calls `pinnedPut`, whose body runs to its first `await` — `await backendOf()` — with `defaultPinOwner()` already called. The argument arrows are created, not invoked, so neither `this.backendNow()` nor the captured-backend promise can interleave before the label exists. A path put therefore names the transaction open when the put *started*, as `put` does.
- **`owner` reaches the pin.** `paths.putFile(path, { ...options, owner })` → `LocalBlobService.putFile` → `putPieces(options, …)`, which is the same owner-and-pin path a stream put takes; `pathAccessOverNetwork.putFile` forwards options unchanged. The claim that a path put is pinned exactly as `put` is holds by construction *and* through the two layers below the wrapper.
- **The recorded put names the right store.** `pinnedPut` notes `backend.key`, and in the `putFile` case `backendOf` returns the very object `paths` was read off, so the key cannot disagree with the store the bytes went into. `SqlBlobPins.releasePuts` reopens the store through that key to unpin, so a mismatch would silently release nothing — an invariant of `pinnedPut` that nothing stated. Recorded at the site, on `@param backendOf` (the only change review made to source).
- **No new failure mode on the `undefined` arm.** A backend with no `paths` returns before any closure is built. A backend resolution that fails rejects, as every other method on this service does.
- **No resource to clean up.** The returned object captures `this` and the backend; a `blobsFor(table)` wrapper the host drops after one `pathAccess()` holds no subscription unless the host subscribed, and the backend is the factory's to stop.

### Checked and already decided

- **The captured backend outliving `CollectionFactory.dispose()`** is specified by the implement ticket ("a backend change afterwards is the host's concern and is noted in the doc comment") and is stated at the site and in both documents. Confirmed what it actually costs: a stale `putFile` writes into a stopped store, and a put recorded under a key the factory has since forgotten resolves a *fresh* backend in `releasePuts` and unpins nothing there. Left as decided; the jsdoc is the record.
- **`BlobService.paths` left unset** means a host writing generic `if (service.paths)` code against `plugin.blobs` sees no path access even where the backend has it. That is the deliberate half of the method-not-property choice, stated at the site; memoizing `paths` after the first resolution would break the contract in the other direction (absent, then present).

### Findings acted on

- **Documentation, two gaps, both fixed in this pass.** docs/blobs.md's status paragraph is the doc's own record of what is built, and each of the three tickets in this chain extended its file-path sentence; this one had not, so the record said the capability was "built in the service" and nothing about SQL. Fixed, naming the one route that works today and the backlog slug for the setting that does not exist. Separately, §Putting and reading by file path asserts "an optional property rather than methods that throw" as the design rule, which §SQL now departs from — a reader of that section would not find the SQL route and would read the two sections as contradicting each other. Fixed with one sentence pointing at §SQL and saying why that service is the exception. `yarn lint:docs` resolves both new links.

### No ticket filed

- Nothing in the diff is a defect, and nothing conditional survived that is not already recorded at its site — so no tripwire was added beyond the `@param` invariant above, and no ticket was filed. The one real gap, that no backend the plugin builds itself turns path access on, was already filed by the implementer as `tickets/backlog/feat-a-sql-host-cannot-turn-on-blob-file-paths`; review re-derived it from `resolveBlobBackend` (the `SingleMachineBlobService` built from `{ pieces, kv }` with no `paths`, and the `createLibp2pNode` call passing no `blobs` option) and confirms both arms and the framing. It is correctly a backlog feature rather than part of this ticket: it needs an option named, validated, documented and plumbed to two sites, which this ticket did not authorize, and both documents say plainly that the capability does not reach a plugin-built backend yet.
- The implementer's deviation — also touching the plugin README and `plugin.ts`'s jsdoc, which the ticket did not list — is the right call and was kept: a service method documented only in the architecture document is one no application author finds.

### Tests

- **None added, and none cut.** The implementer added none, and that holds up: the pin rules of a path put *are* `put`'s rules, one private method with two callers, and `test/blob-functions.spec.ts` drives that method through `put` in both of its branches (`pins a put made outside any transaction as unstaged`, and `pins a put made while a transaction is open under that transaction`, which also asserts the commit releases it). A regression in the factoring fails those two.
- **The positive arm is not reachable from a unit test today, and this was verified rather than accepted.** The only backend with path access is a node's, and the plugin's own specs reach a backend through `register(db, { default_transactor: 'test' })`, which yields a `SingleMachineBlobService` with `paths` off. The alternative is `CollectionFactory.registerLibp2pNode`, whose parameter is `Libp2p & Partial<OptimysticNodeAttachments>` — a real node, or a cast fake that `registerNodeCohortReachability` and the `network` transactor would then be run against. That is a worse test than none. The round trip belongs with `feat-a-sql-host-cannot-turn-on-blob-file-paths`, over `FilePieceStore`, and that ticket's expected behaviour already asks for it.
- The negative arm (`pathAccess()` resolves `undefined`) is a one-line guard the project's testing rules say not to test.

## Validation

- `yarn workspace @optimystic/quereus-plugin-optimystic build` — clean (tsup ESM + DTS)
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **1465 passing, 16 pending, 0 failing** (4m), then `test:smoke` ok. The full suite of the one package the change touches; nothing depends on it.
- `yarn typecheck` (root, all workspaces) — clean
- `yarn lint` — clean; `yarn lint:docs` — 49 documents, 919 anchored citations, 955 file mentions, 888 links, all resolve
- `yarn check:rn` — passed (Metro bundle 21.9s, hermesc 11.5s); run because the plugin is in the React Native bundle check's dependencies and the diff changed its imports, though the one added import is type-only and erased

Not run: `test:integration` (the change touches no networking, cohort assembly, reactivity or matchmaking) and `lint:deps` (no manifest changed). No pre-existing failures surfaced; the 16 pending cases are the suite's standing skips, which `debt-a-test-can-quietly-decide-not-to-run` already tracks.
