description: The browser's local database now has a test proving an older database survives gaining new tables with its data intact, both tabs report it when one tab's open is held up by another tab still on the old version, and forgetting to list a newly added table is now a compile error rather than a table that silently never gets created.
architecture: packages/db-p2p/docs/storage.md#5-a-store-is-owned-by-exactly-one-process
files: packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/db.spec.ts, packages/db-p2p-storage-web/README.md, docs/debugging.md
----

# Complete: IndexedDB schema upgrades and the visible blocked upgrade

Landed in `ticket(implement): debt-indexeddb-version-upgrade-is-untested-and-unhandled`, with the review's own fixes on top (same files, no new ones).

Both features are dormant until the first browser release: no shipped build means no older database exists anywhere, and two tabs over one database is a state `packages/db-p2p/docs/storage.md` §5 already forbids — the callbacks make that violation visible, they do not fix it.

## What the implementation does

**`packages/db-p2p-storage-web/src/db.ts`**

- `OBJECT_STORES` — one exported list of the ten object store names, replacing ten repeated `if (!contains) createObjectStore` blocks with one guarded loop. The `upgrade` hook is version-blind: it creates whatever an existing database lacks, so a database any earlier version wrote gains the rest empty and keeps every record.
- Drift between that list and the `OptimysticWebDB` schema interface is now a compile error in **both** directions — see *Review findings*.
- A `NOTE:` tripwire on `OBJECT_STORES`: the loop only ever creates, so a store dropped from the schema would linger in an existing database with its rows.
- `OptimysticWebDbLifecycle` and an optional third `lifecycle` parameter on `openOptimysticWebDb`, wiring `idb`'s `blocked` to `onUpgradeBlocked` (this open is waiting on an older connection), `blocking` to `onBlockingUpgrade` (this connection is the one in the way) and `terminated` to `onConnectionLost` (the browser closed this connection abnormally). Each event is also logged on `optimystic:db-p2p-storage-web:db` whether or not a callback is supplied.
- A `notifyHost` helper runs the host's callback, if any, and logs a throw or a rejection against the event name — these fire as DOM event listeners, where a failure would otherwise become an unattributed uncaught top-level error.

Behaviour with no `lifecycle` argument is exactly the browser's default, as before: the old connection keeps its handle and the new open waits. Nothing closes the handle from inside `openOptimysticWebDb` — the stores on that handle buffer writes and hold armed timers, and the host, not this function, constructs them and owns the close order.

**`packages/db-p2p-storage-web/README.md`** — under *Persistence semantics*: what a blocked upgrade looks like, the three callbacks, the recommended `onBlockingUpgrade` host handler (close the raw storage, then the KV store, then the handle, then prompt a reload), that nothing awaits a handler, and why the package does not do this itself.

**`docs/debugging.md`** — the `db` sub-namespace and its three line names added to the `db-p2p-storage-web` row.

## Tests

`packages/db-p2p-storage-web/test/db.spec.ts`, three cases:

| Test | What it pins |
|---|---|
| `upgrades a version-1 database, adding every store since and keeping its rows` | A version-1 database (its six original stores, created by hand through raw `openDB` so the current hook never touches it) reopened through `openOptimysticWebDb` reaches `DEFAULT_DB_VERSION`, holds exactly `OBJECT_STORES`, and still returns both rows written at version 1 — one `Uint8Array` and one string. |
| `an old connection told it is blocking can close so the upgrade proceeds` | `onBlockingUpgrade` fires on the older connection with `(1, 2)`, and closing from inside it lets the newer open resolve at version 2. |
| `an open blocked by an older connection reports instead of waiting silently` | With no `onBlockingUpgrade` supplied, the waiting open's `onUpgradeBlocked` fires with `(1, 2)` rather than hanging mutely. |

Version 1 is the only starting point tested because the hook is version-blind — versions 2, 3 and 4 are covered by construction, and four near-identical tests would pin the test, not the behaviour. No test for the log lines (wiring), for a downgrade (the browser's `VersionError`, documented in the README), or for `onConnectionLost` (see below).

## Review findings

**Fixed in this pass (minor):**

- **The drift guard only worked in the direction that does not matter.** `OBJECT_STORES` carried `satisfies readonly StoreNames<OptimysticWebDB>[]`, which rejects a listed name the schema does not declare — but a store *added* to the schema and forgotten in the list compiled fine, and the store would then simply never be created, surfacing as a runtime `NotFoundError` on first use. The test could not catch it either: it asserts the database's stores equal `OBJECT_STORES`, so an omission makes both sides agree. Added a type-level exhaustiveness assertion (`UnlistedStore` / `EveryStoreListed`) that makes a forgotten store a compile error naming it, and corrected the comment that overclaimed what `satisfies` was doing. Verified by temporarily dropping a store from the list in a throwaway probe file: `error TS2344: Type '"pieces"' does not satisfy the constraint 'never'`. Rung 1 of the architecture ladder — the bad state is now unrepresentable — rather than a ticket for the instance.
- **A rejecting host callback escaped the handler that was there to catch it.** `notifyHost` wrapped the call in `try`/`catch`, but the README's own recommended `onBlockingUpgrade` is `async`, and an `async` function's failure is a rejection the `catch` never sees — it would have become an unhandled rejection, the exact unattributed failure the helper exists to prevent. `notifyHost` now also attaches a `.catch` (logged as `handler rejected`), the three callback signatures declare `void | Promise<void>` so the async form is intended rather than merely tolerated, and the interface doc plus the README say plainly that nothing awaits a handler.
- **Three repeated guard-plus-non-null-assertion call sites.** `notifyHost` now takes the possibly-undefined handler and its arguments and narrows inside, removing all three `if (lifecycle.x)` guards and all three `!` assertions. This was the simplification the implement handoff itself flagged for a reviewer.
- **The one timing-dependent line in the tests is gone.** The third test slept one macrotask tick before asserting that `onUpgradeBlocked` had fired. It now awaits a promise the callback resolves, so the assertion does not depend on how many turns `fake-indexeddb` takes to queue the event; if the event never fires the test fails on mocha's timeout naming that line, rather than on a sleep that happened to be too short.

**Checked and found nothing to change:**

- The upgrade path itself. The version history in the `DEFAULT_DB_VERSION` comment agrees with the six stores the test creates at version 1, the hook's ignoring of `oldVersion` is correct for an idempotent create-what-is-missing, and `OBJECT_STORES` matches the schema interface's order and contents.
- `idb`'s actual `OpenDBCallbacks` signatures (version 8.0.3) against the three wired callbacks and the interface's parameter names: `blocked(currentVersion, blockedVersion)`, `blocking(currentVersion, blockedVersion)`, `terminated()` — all three match, including which side each version number describes.
- Every symbol the README's recommended handler names: `IndexedDBRawStorage.close` and `IndexedDBKVStore.close` both exist and both do what the example's comments claim (apply what is held, disarm the timers).
- Resource cleanup in the tests: every handle opened is closed, the two multi-handle tests in `finally`.
- Docs. `README.md`, `docs/debugging.md` and the `DEFAULT_DB_VERSION` comment were each read against the new code; the two doc files needed only the one-line additions above (the rejection wording), and no other document in the repo describes this hook.

**Not filed as tickets, deliberately:**

- **`onConnectionLost` has no test.** `idb` documents `terminated` as not called for an explicit `db.close()`, which is all the specs can do, and `fake-indexeddb` offers no way to provoke a genuine eviction. Testing it would mean driving the polyfill's internals — the wrong layer — so it stays correct by inspection of that documented contract.
- **The README's recommended handler is prose, not compiled code.** It names host-supplied symbols (`rawStorage`, `kvStore`, `showReloadPrompt`); the two package symbols it calls were verified by hand, above.
- **`freshDbName` is now duplicated in four spec files in this package.** Six lines, pre-existing in three of them, and a shared support module for it would be more indirection than it removes.

**Tripwires parked (not tickets):**

- `NOTE:` on `OBJECT_STORES` in `packages/db-p2p-storage-web/src/db.ts` — the upgrade loop only ever creates, so a store dropped from the schema would be left in place in an existing database with its rows; revisit if a store is ever dropped, since the right handling depends on whether its data needs migrating first.

**Not verified in a real browser.** The version-blind upgrade and all three lifecycle events are exercised only through `fake-indexeddb`. It does fire `versionchange` at open connections and then `blocked` at the request, which is the behaviour under test, but no browser has run this code — which is consistent with the feature being dormant until the first browser release.

## Commands run

- `yarn workspace @optimystic/db-p2p-storage-web build` — clean.
- `yarn workspace @optimystic/db-p2p-storage-web test` — 80 passing, 0 failing.
- `yarn lint`, `yarn lint:docs` (49 documents, all citations resolve), `yarn lint:deps` — all clean.

No other package depends on `@optimystic/db-p2p-storage-web`, so no downstream suite applies. No integration tests: the change touches neither networking, cohort assembly, reactivity nor matchmaking. No `check:rn`: this package is web-only and the change adds no imports.
