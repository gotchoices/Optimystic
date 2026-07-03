----
description: Clean up stale/missing package docs, rename a misleadingly-named source file, and replace the fragile hand-chained root build/test/publish scripts with automatic workspace iteration so no package can be silently dropped.
prereq:
files: package.json, scripts/publish-package.js, packages/db-p2p/README.md, packages/db-p2p-storage-rn/, packages/demo/, packages/db-p2p/src/storage/restoration-coordinator-v2.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/rebalance-reaction.spec.ts
difficulty: medium
----

Polish pass from review finding **eh-11** (assorted-polish portion; `docs/review.html` Section 9 "Cross-cutting engineering health"), cross-referencing **eh-7** (a package silently dropped from the root `test` chain). Four independent, mostly-mechanical items. No behavioral code changes.

Out of scope (owned by other tickets — do NOT touch):
- `db-p2p-storage-fs`'s README — owned by `storage-fs-tests-readme-ci`.
- Placeholder `'local'`/`''` metadata and unconditional `results: []` in `transaction/coordinator.ts` (~lines 355-357, 555) — owned by the transaction review finding (Txn #7).

---

## 1. Fix stale `db-p2p` README

`packages/db-p2p/README.md` still presents **filesystem storage as a built-in feature of `db-p2p`**, but that implementation moved to its own package, `@optimystic/db-p2p-storage-fs`. The README must reflect the current split: `db-p2p` provides the distributed layer (repo/cluster/coordination + storage *interfaces*); filesystem persistence is one pluggable backend living in a separate package (alongside `-storage-ns`, `-storage-rn`, `-storage-web`).

Concrete stale spots (non-exhaustive — read the whole file):
- Line 3 (intro): "concrete implementations … using **filesystem storage** and libp2p networking".
- Line 9: "**Filesystem storage** with serialization for persistent, versioned block storage" bullet.
- Lines 119-126 / 235-289: "Storage Layer" describes `StorageRepo` / `FileRawStorage` as filesystem-based components of `db-p2p`. Verify where `StorageRepo`, `BlockStorage`, `FileRawStorage`, `FileSystemBlockStorage` now actually live (check `packages/db-p2p/src` vs `packages/db-p2p-storage-fs/src`) and describe each in the package that owns it. If `StorageRepo`/`BlockStorage` remain in `db-p2p` but the raw filesystem I/O moved to `-storage-fs`, say exactly that.

Goal: a reader lands on the `db-p2p` README and correctly understands that filesystem storage is a **separate package**, not bundled here. Don't rewrite the whole architecture doc — retarget the storage claims and add a one-line pointer to `db-p2p-storage-fs` in "Related Packages".

## 2. Add missing package READMEs

Packages with no `README.md`: **`db-p2p-storage-rn`** and **`demo`** (`db-p2p-storage-fs` is excluded — owned elsewhere). Add a short README to each:
- `packages/db-p2p-storage-rn/README.md` — React Native LevelDB storage backend for `@optimystic/db-p2p` (see its `package.json` `description`/`keywords`: `rn-leveldb`-backed, `classic-level`). Cover: what it is, the `rn-leveldb` peer dependency, and a pointer back to `db-p2p`. Keep it short; mirror the tone/length of an existing sibling like `packages/db-p2p-storage-ns/README.md`.
- `packages/demo/README.md` — "Hello world demo app exercising the full Optimystic stack" (its `package.json` `description`). Cover: what it demonstrates, how to run (`yarn start` runs `src/run.ts`).

## 3. Rename `restoration-coordinator-v2.ts`

`packages/db-p2p/src/storage/restoration-coordinator-v2.ts` is suffixed `-v2` but there is **no v1** (glob confirms only this file). The exported class is already `RestorationCoordinator`. Rename the file to **`restoration-coordinator.ts`** and update all 6 importers (paths reference `restoration-coordinator-v2.js`):
- `packages/db-p2p/src/index.ts:20`
- `packages/db-p2p/src/rn.ts:15`
- `packages/db-p2p/src/libp2p-node-base.ts:37`
- `packages/db-p2p/src/cluster/block-transfer.ts:4`
- `packages/db-p2p/test/block-transfer.spec.ts:10`
- `packages/db-p2p/test/rebalance-reaction.spec.ts:10`

Use `git mv` so history follows. After editing, grep the whole repo for `restoration-coordinator-v2` — only tickets/docs (`docs/review.html`, `tickets/**`) should remain; leave those historical references alone.

## 4. Replace hand-chained root scripts with `yarn workspaces foreach`

`package.json` root `build`, `clean`, `test`, `test:verbose`, and `pub` are ~50 hand-maintained `cd <pkg> && yarn <task>` links plus per-package sub-scripts. This already silently dropped `db-p2p-storage-fs` from `test` (eh-7) **and** `substrate-simulator` from `test:verbose`. Replace with Yarn 4 `workspaces foreach` so the package list is derived, not hand-kept.

**Critical gotcha — root recursion.** The root workspace `@optimystic/optimystic` is `"private": true` and *defines these same script names*. `yarn workspaces foreach -A` includes the root workspace, so `build` calling `foreach … run build` would recurse into itself infinitely. **Every `run <task>` foreach MUST exclude the root:** `--exclude '@optimystic/optimystic'` (or equivalent). `pub` uses `--no-private`, which already excludes the private root — no extra exclude needed there.

Proposed replacements (verify flags against installed Yarn 4.12 — `yarn workspaces foreach --help`):

```jsonc
"build":        "yarn workspaces foreach -Apt --exclude '@optimystic/optimystic' run build",
"clean":        "yarn workspaces foreach -Ap  --exclude '@optimystic/optimystic' run clean",
"test":         "yarn workspaces foreach -Apt --exclude '@optimystic/optimystic' run test",
"test:verbose": "yarn workspaces foreach -Apt --exclude '@optimystic/optimystic' run test:verbose",
"pub":          "yarn build && yarn workspaces foreach -Apt --no-private npm publish --access public"
```

Flag notes:
- `-A` = all workspaces, `-t` = topological order (dependency before dependent — matches current build ordering), `-p` = parallel-safe interleaved output prefixed with the workspace name (keeps output streaming so a long build won't hit the runner's 10-min idle timeout — do NOT silently redirect). Confirm `-p` in Yarn 4 means "parallel"; if you want strictly sequential ordered output, drop `-p` and rely on `-t` alone. Ordered + streaming is the priority.
- `foreach` **skips workspaces that don't define the named script** (emits a warning, not an error). This is the desired self-healing behavior: `db-p2p-storage-fs` has no `test` script today, so it's skipped; once `storage-fs-tests-readme-ci` adds one, `foreach` picks it up automatically. Same for any package lacking `test:verbose`.
- `--no-private` on `pub` reproduces exactly the old 9-package publish set (the non-private packages: db-core, db-p2p, db-p2p-storage-{fs,ns,rn,web}, quereus-plugin-{crypto,optimystic}, reference-peer). `demo`, `substrate-simulator`, and root are private → correctly excluded.

**`pub` design note.** Old `pub` shelled out to `scripts/publish-package.js <dir>` which did `chdir + yarn clean + yarn build + yarn npm publish` per package. The replacement above does one repo-wide `yarn build` (now itself a foreach) then `foreach … npm publish`. Equivalent net effect (clean is implied by tsc overwrite; if you want an explicit clean, prepend `yarn clean &&`). Decide whether to **delete `scripts/publish-package.js`** (now unused) or keep it — grep for other callers first (`git grep publish-package`); the root `pub:*` sub-scripts that referenced it are being removed. If nothing else references it, delete it; otherwise leave it.

Delete the now-obsolete per-package sub-scripts (`build:db-core`, `clean:*`, `test:*`, `test:*:verbose`, `pub:*`, etc.) from root `package.json`. Keep `bump`, `release` (retarget `release` if it referenced the old `pub`), `lint`, `upgrade:*`.

---

## TODO

- [ ] **README — db-p2p**: retarget filesystem-storage claims in `packages/db-p2p/README.md` (lines ~3, 9, 119-126, 235-289 + Related Packages) to point at `@optimystic/db-p2p-storage-fs`; verify which storage classes actually live in `db-p2p` vs `-storage-fs` before rewording.
- [ ] **README — new**: add `packages/db-p2p-storage-rn/README.md` and `packages/demo/README.md` (short; mirror an existing sibling README). Do NOT add `db-p2p-storage-fs`'s (owned by `storage-fs-tests-readme-ci`).
- [ ] **Rename**: `git mv packages/db-p2p/src/storage/restoration-coordinator-v2.ts …/restoration-coordinator.ts`; update the 6 importers listed above; grep to confirm no non-ticket/doc reference to `restoration-coordinator-v2` remains.
- [ ] **Scripts**: replace root `build`/`clean`/`test`/`test:verbose`/`pub` with the `foreach` forms; **exclude `@optimystic/optimystic`** on the `run` ones to avoid recursion; delete obsolete per-package sub-scripts; resolve `scripts/publish-package.js` (delete if unreferenced).
- [ ] **Verify coverage**: run `yarn workspaces foreach -Apt --exclude '@optimystic/optimystic' run build 2>&1 | tee /tmp/build.log` and confirm every one of the 11 packages builds. Then `yarn test 2>&1 | tee /tmp/test.log` — confirm it now includes `db-p2p-storage-fs` if/once it has a test script, and that `substrate-simulator` runs under `test:verbose`. Cross-check the executed package set against the old hand-list so nothing is *lost* (only additions expected).
- [ ] **Typecheck/build green** before handoff. If a pre-existing failure surfaces outside this diff, follow the pre-existing-error procedure (`tickets/.pre-existing-error.md`) — don't chase it here.
