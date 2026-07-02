----
description: A cleanup pass over stale and missing package documentation, a misleadingly named source file, and the fragile hand-written build and test scripts that have already silently dropped a package.
prereq:
files: packages/db-p2p/README.md, packages/db-p2p-storage-rn, packages/db-p2p/src/storage/restoration-coordinator-v2.ts, package.json
difficulty: medium
----

Review finding eh-11, assorted-polish portion (docs/review.html, Section 9 "Cross-cutting engineering health").

Several small hygiene items:

- The `packages/db-p2p` README still claims filesystem storage as a feature, but that moved out to its own package (`db-p2p-storage-fs`). Update it to reflect the current split.
- Some packages lack a README (for example `db-p2p-storage-rn`). Add short READMEs. (Note: `db-p2p-storage-fs`'s README is handled by the storage-fs testing/CI ticket `storage-fs-tests-readme-ci`; don't duplicate it here.)
- `packages/db-p2p/src/storage/restoration-coordinator-v2.ts` is named `-v2` but there is no `v1`. Rename it to a name that describes what it is, updating imports and any references.
- The root `package.json` `build`, `clean`, `test`, `pub`, and `test:verbose` scripts are long hand-chained `cd <pkg> && yarn <task>` sequences (~50 of them). This pattern already silently dropped `db-p2p-storage-fs` from the `test` chain (see finding eh-7). Replace the hand-chained scripts with `yarn workspaces foreach -At <task>` (topologically ordered) so no package can be accidentally omitted.

Expected end state: db-p2p README matches reality, packages lacking READMEs have them, the `-v2` file is renamed with references updated, and the root scripts iterate over workspaces automatically instead of an error-prone hand-maintained list. Verify `build`/`test`/`clean` still cover every package after the switch.

Out of scope (tracked elsewhere): the placeholder `'local'`/`''` metadata and unconditional `results: []` in `transaction/coordinator.ts` (~lines 355-357 and 555) that the review cross-references to the Transaction review finding (Txn #7) — leave that to the transaction-owned ticket rather than duplicating it here.
