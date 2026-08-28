description: The browser storage backend just gained its first-ever schema version bump, but nothing tests that an existing browser database survives the upgrade, and if another tab still has the old version open the new tab's database open call waits forever with no log or error.
files: packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts
difficulty: easy
severity: edge-case
likelihood: unusual
tradeoffs: Nothing has shipped to real browsers yet and AGENTS.md says backwards compatibility is not a concern, so a maintainer could reasonably say the upgrade path has no users to protect and defer both arms until the first release.
----

# IndexedDB schema-version upgrades: no test, no blocked handler

`packages/db-p2p-storage-web/src/db.ts` bumped `DEFAULT_DB_VERSION` from 1 to 2 when
the `proofs` object store was added. That is the first time this package has ever
changed its schema version, which turns two previously-dormant paths live.

## Arm 1 — the upgrade path has no test

`openOptimysticWebDb` runs its `upgrade` hook only when the requested version is higher
than the stored one. Every case in `test/indexeddb-storage.spec.ts` opens a *fresh*,
uniquely-named database, so the hook always runs on an empty database at version 2 and
the version-1-to-version-2 transition is never executed. Each `createObjectStore` call is
guarded by `objectStoreNames.contains`, which makes the upgrade safe by construction —
but that is an argument, not a test, and the guard is exactly the kind of thing a future
schema change removes by accident.

Expected: a case that opens a database at version 1 with the version-1 store set, writes
a value, closes it, reopens it through `openOptimysticWebDb` (version 2), and asserts
both that the `proofs` store now exists and that the pre-existing value survived. The
suite already polyfills IndexedDB with `fake-indexeddb`, which supports version upgrades,
so no new dependency is needed.

## Arm 2 — a version upgrade blocked by another open tab hangs silently

When a browser tab holds a connection at the old version, the browser will not run the
upgrade until that connection closes. The new tab's open request simply waits. The
current code passes no `blocked` or `blocking` callback, so this surfaces as an
Optimystic browser peer that never finishes initializing storage, with nothing logged to
say why. A user with two tabs open across an app update hits this.

Two things to decide, and the second is a behaviour choice a maintainer should make
rather than a mechanical fix:

- **Diagnosis** — log from a `blocked` callback so the wait is visible instead of silent.
  Uncontroversial.
- **Resolution** — the standard remedy is a `blocking` callback on the *old* connection
  that closes it so the upgrade can proceed. But that handle is shared with
  `IndexedDBKVStore` and the identity helper, so closing it out from under a live tab
  breaks that tab's storage until it reloads. Whether the old tab should self-close, or
  surface something to the application instead, is the open question.

Both arms are dormant today: no build has shipped to real browsers, so no version-1
database exists in the wild. They become real at the first release.
