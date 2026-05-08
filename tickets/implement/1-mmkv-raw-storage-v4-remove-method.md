---
description: Migrate `@optimystic/db-p2p-storage-rn` to react-native-mmkv 4.x — replace `MMKV.delete(key): void` with `MMKV.remove(key): boolean`. Production app on RN + react-native-mmkv 4.3.1 throws `TypeError: undefined is not a function` on every `internalCommit` once bootstrap-mode writes route through `MMKVRawStorage`.
prereq:
files:
  - packages/db-p2p-storage-rn/src/mmkv-storage.ts
  - packages/db-p2p-storage-rn/src/mmkv-kv-store.ts
  - packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts
  - packages/db-p2p-storage-rn/register.mjs
  - packages/db-p2p-storage-rn/package.json
  - package.json
---

## Summary

react-native-mmkv v4 renamed per-key removal: `delete(key): void` → `remove(key): boolean`. `MMKVRawStorage` declared a local `MMKV` interface with `delete`, and three call sites (`deletePendingTransaction`, `saveMaterializedBlock` removal branch, `promotePendingTransaction`) called `this.mmkv.delete(...)`. A fourth call site lived in `MMKVKVStore.delete` (out-of-scope of the original ticket but same root cause and now a typecheck error once the interface was updated). The fix is the mechanical API rename.

## Use cases / verification

In-package unit tests in `packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts` exercise all four call sites against a hand-rolled v4-shaped `FakeMMKVv4` (matches the nitro spec — `remove(key): boolean`, no `delete` member). Confirmed:

- With the old `mmkv.delete(...)` calls in place, the test fails with the exact production error: `TypeError: this.mmkv.delete is not a function`.
- With the fix in place, all five tests pass:
  - `deletePendingTransaction removes the pending key via remove()`
  - `saveMaterializedBlock(undefined) removes the materialized key via remove()`
  - `promotePendingTransaction moves pending → committed via remove()`
  - `throws when promoting a missing pending action`
  - `MMKVKVStore.delete() forwards to the v4 remove() method`

End-to-end (host app, out-of-band): in a host RN app pinned to react-native-mmkv 4.x with strand bootstrap mode, schema apply completes, inserts succeed, and rows survive `am force-stop` + relaunch with the seed guard skipping production-seeds on second launch.

## Changes landed

- `packages/db-p2p-storage-rn/src/mmkv-storage.ts`: `MMKV.delete` → `MMKV.remove(key): boolean`; three call sites swapped to `this.mmkv.remove(...)`.
- `packages/db-p2p-storage-rn/src/mmkv-kv-store.ts`: same rename for the fourth call site.
- `packages/db-p2p-storage-rn/package.json`: `peerDependencies.react-native-mmkv` → `^4.0.0` (was `^3.0.0 || ^2.0.0`); added `test` / `test:verbose` scripts and devDeps (`chai`, `mocha`, `ts-node`, `@types/chai`).
- `packages/db-p2p-storage-rn/register.mjs`: new — `ts-node/esm` loader hook (matches sibling packages).
- `packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts`: new unit-test suite.
- Root `package.json`: added `test:db-p2p-storage-rn` and `test:db-p2p-storage-rn:verbose`, wired into the aggregate `test` and `test:verbose` chains.

## Out of scope / parking lot

- The host-side `react-native-mmkv-v4-api-migration` work in sereus-health is already complete and untouched.
- v3 / v2 compatibility is not preserved — the package targets v4 exclusively (matches the host pin and the ticket's "v4 is the only supported version" stance).
- `IRawStorage` and other backends (e.g. `db-p2p-storage-fs`, `MemoryRawStorage`) were not changed; they don't go through MMKV.

## Notes for review

- The new local `MMKV` interface in `mmkv-storage.ts:8-14` is intentionally a structural subset of the real `react-native-mmkv` 4.x `MMKV` class — only the members this package uses are declared. No runtime `react-native-mmkv` import, so the package keeps importing cleanly in non-RN contexts.
- The test fake is a `Map`-backed implementation of the same local `MMKV` shape, so the spec doesn't pull in `react-native-mmkv` (which would require nitro modules / a JSI runtime). The "would have caught the bug" sanity-check was confirmed by temporarily reverting one call site to `(this.mmkv as any).delete(...)` and re-running the suite — it failed with `TypeError: this.mmkv.delete is not a function`.
