description: The browser's local database now has a test proving an older database survives gaining new tables with its data intact, and both tabs report it when one tab's open is held up by another tab still on the old version.
architecture: packages/db-p2p/docs/storage.md#5-a-store-is-owned-by-exactly-one-process
files: packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/db.spec.ts, packages/db-p2p-storage-web/README.md, docs/debugging.md
difficulty: easy
----

# Review: IndexedDB schema upgrades and the visible blocked upgrade

Implemented as specified by the implement ticket, with no deviations. Both parts are dormant until the first browser release — no shipped build means no older database exists anywhere, and two tabs over one database is a state `packages/db-p2p/docs/storage.md` §5 already forbids.

## What changed

**`packages/db-p2p-storage-web/src/db.ts`**

- `OBJECT_STORES` — one `as const satisfies readonly StoreNames<OptimysticWebDB>[]` list of the ten store names, replacing the ten repeated `if (!contains) createObjectStore` blocks with one guarded loop. The `satisfies` bound is what prevents the list drifting from the schema interface: a name not in `OptimysticWebDB` is a compile error. Exported (`src/index.ts` is `export * from './db.js'`), so the test asserts against it rather than a hardcoded list and a future bump updates one array.
- A `NOTE:` tripwire on `OBJECT_STORES`: the loop only ever creates, so a store dropped from the schema would linger in an existing database with its rows; revisit if a store is ever dropped.
- The `DEFAULT_DB_VERSION` comment's parenthetical no longer defers to this ticket — it now points at `test/db.spec.ts`.
- `OptimysticWebDbLifecycle` and a third, optional `lifecycle` parameter on `openOptimysticWebDb`, wiring `idb`'s `blocked` to `onUpgradeBlocked`, `blocking` to `onBlockingUpgrade`, and `terminated` to `onConnectionLost`. `onConnectionLost` was kept (the implement ticket offered it as cuttable) — same site, same three lines, and an abnormally terminated connection is as silent today as a blocked one.
- A `notifyHost` helper runs each host callback inside `try`/`catch` and logs a throw against the event name, because these fire as DOM event listeners where a throw would otherwise become an unattributed uncaught top-level error.
- `createLogger('db')` from `src/logger.ts`, giving `optimystic:db-p2p-storage-web:db` with `upgrade-blocked`, `blocking-upgrade` and `connection-lost` lines. Logged unconditionally, whether or not a callback is supplied.

**Behaviour with no `lifecycle` argument is exactly as before** — the old connection keeps its handle, the new open waits — except both sides now log. Nothing closes the handle from inside this function; the implement ticket's reasoning (the stores buffer writes and hold armed timers, and the host, not this function, owns them and the close order) is recorded in the interface's doc comment and in the README.

**`packages/db-p2p-storage-web/README.md`** — under *Persistence semantics*, beside the existing version-5 / `VersionError` paragraph: what a blocked upgrade looks like, the three callbacks, the recommended `onBlockingUpgrade` host handler (`rawStorage.close()`, then `kvStore.close()`, then `db.close()`, then a reload prompt), and why the package does not do this itself. Placed immediately above the existing "two tabs over one database" note, which it now explains: the callbacks make that violation visible, they do not fix it.

**`docs/debugging.md`** — the `db` sub-namespace and its three line names added to the `db-p2p-storage-web` row of the namespace table.

## Tests added

`packages/db-p2p-storage-web/test/db.spec.ts` (new; the `fake-indexeddb/auto` import and a local `freshDbName()` copied from `test/indexeddb-storage.spec.ts` — six lines, not worth a shared support module). Three cases, one per behaviour:

| Test | What it pins |
|---|---|
| `upgrades a version-1 database, adding every store since and keeping its rows` | A version-1 database (its six original stores, created by hand through raw `openDB` so the current hook never touches it) reopened through `openOptimysticWebDb` reaches `DEFAULT_DB_VERSION`, holds exactly `OBJECT_STORES`, and still returns both rows written at version 1 — one `Uint8Array` and one string. |
| `an old connection told it is blocking can close so the upgrade proceeds` | `onBlockingUpgrade` fires on the older connection with `(1, 2)`, and closing from inside it lets the newer open resolve at version 2. No timing dependence: the open can only resolve if the whole chain worked. |
| `an open blocked by an older connection reports instead of waiting silently` | With no `onBlockingUpgrade` supplied, the waiting open's `onUpgradeBlocked` fires with `(1, 2)` rather than hanging mutely. |

No test for the log lines (wiring; the callbacks are the contract), for a downgrade (the browser's `VersionError`, already documented), or for versions 2, 3 and 4 (the hook is version-blind, so version 1 is the worst case — the implement ticket is explicit that four tests would be wrong here).

## Commands run

- `yarn workspace @optimystic/db-p2p-storage-web build` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/db.spec.ts` — 3 passing.
- `yarn workspace @optimystic/db-p2p-storage-web test` — 80 passing, 0 failing (small suite, 150ms; the implement ticket called for it explicitly).
- `yarn lint:docs` — 49 documents, all citations resolve.
- `yarn lint:deps` — every import declared.

Root `yarn typecheck` not run: neither `quereus-plugin-optimystic` nor `quereus-plugin-crypto` changed.

## Known gaps and things worth a reviewer's eye

- **The one-macrotask tick in the third test.** `fake-indexeddb` queues `blocked` as a database task rather than firing it synchronously, so the test awaits a `setTimeout(resolve, 0)` before asserting. It passed on every run here, but it is the only timing-dependent line in the file. The implement ticket's guidance if it ever proves flaky: poll for `blocked.length > 0` against a short deadline rather than lengthening the sleep.
- **Everything is verified against `fake-indexeddb`, not a browser.** The version-blind upgrade and the three lifecycle events are all exercised through the polyfill. `fake-indexeddb` does fire `versionchange` at open connections and then `blocked` at the request, which is the behaviour under test, but no real browser has run this code.
- **`onConnectionLost` is untested.** `idb` documents `terminated` as not called for an explicit `db.close()`, which is what the specs do dozens of times, and there is no way to provoke a genuine eviction under the polyfill. Correct by inspection of that contract only.
- **The host callback `try`/`catch` is untested** — by inspection, as the implement ticket specified.
- **The README's recommended handler is prose, not exercised code.** It names `rawStorage.close()`, `kvStore.close()` and `showReloadPrompt()` on symbols the host supplies; nothing compiles it.
- **`notifyHost`'s signature** takes a thunk plus an event name, so each call site reads as a guard on the optional callback followed by a thunk with a non-null assertion. A reviewer may prefer passing the possibly-undefined callback in and narrowing inside; it is three sites either way.

## Review findings

- Tripwire parked as a `NOTE:` on `OBJECT_STORES` in `packages/db-p2p-storage-web/src/db.ts`: the upgrade loop only ever creates, so a store dropped from the schema would be left in place in an existing database with its rows; revisit if a store is ever dropped, since the right handling depends on whether its data needs migrating first.
