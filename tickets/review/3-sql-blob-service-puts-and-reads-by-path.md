description: Applications that reach blobs through the SQL plugin can now store a file straight from disk and write one straight back out, under exactly the pin rules an ordinary blob put gets, so a photo stored from a file is kept or released the same way one stored from bytes is.
architecture: docs/blobs.md#sql
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/sql-blob-service.ts, packages/quereus-plugin-optimystic/src/plugin.ts, docs/blobs.md, packages/quereus-plugin-optimystic/README.md, tickets/backlog/feat-a-sql-host-cannot-turn-on-blob-file-paths.md
----

# The SQL plugin's blob service puts and reads by path

`SqlBlobService` now exposes the backend's file-path forms, wrapped in its own pin rules. Implemented as specified by `3-sql-blob-service-puts-and-reads-by-path`; one deviation and one gap, both below.

## What landed

**`SqlBlobService.pathAccess(): Promise<BlobPathAccess | undefined>`** (`packages/quereus-plugin-optimystic/src/optimystic-adapter/sql-blob-service.ts`). Resolves the backend, captures it once, and answers `{ mode, putFile, readToFile }` when `backend.service.paths` is there — `undefined` when it is not. `mode` and `readToFile` are the backend's, passed straight through: a read pins nothing. `putFile` goes through the same private method `put` does.

**`put` factored into `pinnedPut(explicitOwner, backendOf, store)`**, which holds the whole pin discipline: the default owner label chosen BEFORE anything is awaited, the backend resolved after, the store called, and the put recorded on the bridge only when the transaction that defaulted the label is still the open one. `put` passes `() => this.backendNow()`; `pathAccess`'s `putFile` passes `async () => backend`, the backend already captured. The ordering is load-bearing and the method's doc comment says so — a reviewer should confirm the label is still chosen in the same tick as the `put()` call (it is: `pinnedPut`'s body runs synchronously up to its first `await`, and the argument arrows are created, not invoked).

**Documentation.** docs/blobs.md §SQL gained a bullet: what `pathAccess()` answers, why it is a method rather than the `paths` property the `BlobService` contract carries, that a path put follows `put`'s pin rules because the two share one method, and which networks actually offer it today. packages/quereus-plugin-optimystic/README.md § Large values gained the host-facing bullet under *Putting and reading the bytes*. `plugin.ts`'s `blobs` jsdoc gained three lines pointing at `pathAccess()`.

## Deviation from the ticket

The ticket listed only docs/blobs.md §SQL. I also touched the plugin README and `plugin.ts`'s jsdoc, because those are the two places a host actually reads before reaching for a service method, and a capability documented only in the architecture document is one no application author finds. Argue with it if the README bullet is too long for that list — it is the longest thing I added.

## The gap worth a reviewer's attention

**Nothing reachable through the SQL plugin's own configuration offers path access today.** `pathAccess()` is correct and honest, but it answers `undefined` for every backend the plugin builds itself:

- `resolveBlobBackend` in `collection-factory.ts` constructs `SingleMachineBlobService` with `{ pieces, kv }` and no `paths`, so every non-`network` transactor (`local`, `test`, `mesh-test`, custom) leaves it `off` — and that is the plain phone configuration.
- The `createLibp2pNode` call in the same file passes no `blobs` option at all, so a node the PLUGIN builds leaves `NodeOptions.blobs.paths` at its default `off` too.
- The one route that does work: a host builds its own node with `blobs: { paths: 'verify' | 'trust' }` over a store that can reach files and registers it through `registerLibp2pNode`; `resolveBlobBackend` then takes `node.blobs` and `pathAccess()` answers it. That is the React Native host's situation (GitHub #69), which is why this ticket is not blocked on the setting.

Filed as `tickets/backlog/feat-a-sql-host-cannot-turn-on-blob-file-paths.md` (anchor `docs/blobs.md#sql`) rather than built here: it needs a registration option named, validated and documented, and plumbed to two sites — which is a design choice the ticket did not authorize. Both documents I touched state the limitation plainly and name that backlog slug, so neither over-promises. **Check that framing** — if a reviewer thinks the setting belongs in this ticket, it is a small change and the backlog ticket says exactly what it would be.

## Tests

**None added**, as the ticket specified, and the reasoning survived scrutiny rather than being taken on faith:

- The pin rules of a path put are the rules of `put` *by construction* — one private method, two callers — and two existing cases in `test/blob-functions.spec.ts` drive that method through `put`: `pins a put made outside any transaction as unstaged` and `pins a put made while a transaction is open under that transaction` (which also asserts the commit releases it). A regression in the factoring fails those.
- The only arm of the new code a test could reach end-to-end today is the negative one (`pathAccess()` resolves `undefined`), because no plugin-reachable backend offers path access — see the gap above. That is a one-line guard, and a test for it would be the wiring test the project's testing rules tell us not to write.
- The positive arm — a path put through SQL carrying the `sql/<stampId>/put` label, and a `readToFile` round-trip — becomes testable the moment the backlog ticket lands the setting, over `FilePieceStore` from `@optimystic/db-p2p-storage-fs` (which offers the capability as of `2-file-piece-store-imports-and-exports-files`). That test belongs with that ticket, which says so in its expected behaviour. A reviewer who wants it sooner would have to double the plugin's `storageFactory` and its backend, which is mocking the repository's own seams.

What a reviewer should verify by inspection instead: that `pathAccess`'s `putFile` cannot drift from `put` (same method, same arguments, only `store` differs); that capturing the backend once per `pathAccess()` call is right for the key `noteBlobPut` is given (it must be the store the bytes went into, not whatever `backendNow()` would resolve later); and that leaving `BlobService.paths` unset on `SqlBlobService` keeps the contract's "present exactly when available" true rather than quietly breaking it.

## Validation

Per `tickets/rules/testing.md` — the changed package's specs by file, not its full suite:

- `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`, `yarn workspace @optimystic/quereus-plugin-optimystic build` — all clean
- `yarn typecheck` (root, all workspaces) — clean
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/blob-functions.spec.ts` in `packages/quereus-plugin-optimystic` — 8 passing (the specs that cover `SqlBlobService`, its owner-label branching included)
- the same runner over `test/blob-pins-*.spec.ts` — 27 passing (the pin lifecycle downstream of `noteBlobPut`)
- `yarn lint` — clean; `yarn lint:docs` — 49 documents, 919 anchored citations, 886 links, all resolve

Not run, deliberately: the package's full `yarn test`, `test:integration` and `check:rn`, which the testing rules reserve for review. `lint:deps` was not run either — no manifest changed and the one new import (`BlobPathAccess`) is a type from `@optimystic/db-core`, already a dependency.

No pre-existing failures surfaced.
