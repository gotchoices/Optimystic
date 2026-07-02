----
description: The filesystem-backed storage component, which is the durable store used by the reference node and the SQL plugin, has no automated tests, no documentation, and is left out of the project's test, build, and clean commands, so regressions in the on-disk store go completely uncaught.
prereq:
files: packages/db-p2p-storage-fs, packages/db-p2p-storage-ns/test/identity.spec.ts, packages/db-p2p-storage-fs/src/file-storage.ts, package.json
difficulty: medium
----

Review finding eh-7 (docs/review.html, Section 9 "Cross-cutting engineering health").

`packages/db-p2p-storage-fs` is the durable, filesystem-backed persistence adapter used by the reference peer and the SQL plugin, yet:

- It has no `test/` directory at all.
- The root `package.json` `test` script omits it (contrast: `test:db-p2p-storage-ns/rn/web` are all present; `build`/`clean`/`pub` scripts do list storage-fs, so the test omission is an inconsistency). Its three sibling storage packages each ship specs, including a shared `identity.spec.ts`.
- It has no README, unlike most sibling packages.

Expected end state:

- Port the identity / kv-store / storage spec trio from a sibling storage package (e.g. `db-p2p-storage-ns/test/identity.spec.ts` and its companions) to storage-fs, backing them with a temporary-directory fixture so each run is isolated and cleans up after itself.
- Add storage-fs to the root `test` (and `test:verbose`) script chain so it runs in CI alongside the other storage adapters.
- Add a README describing what the package is, its on-disk layout, and its intended use as the durable store.

Related but out of scope for this ticket: `file-storage.ts:21` carries a TODO to use `proper-lockfile` to guard concurrent-process access to `basePath` — known, unguarded, and untested. That cross-process locking gap, and the non-atomic-write concern tracked under the Storage review (st-2), should be handled by the storage-hardening work; this ticket's job is to get the package tested, documented, and into CI so those follow-ups have coverage to build on. Note the lockfile TODO in the new README/tests so it is not lost.
