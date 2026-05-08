---
description: Code review for the react-native-mmkv v4 API migration in `@optimystic/db-p2p-storage-rn` — `MMKV.delete(key): void` → `MMKV.remove(key): boolean`. Verifies correctness of the rename, the test suite that locks in the v4 contract, and the package metadata + root test wiring.
prereq:
files:
  - packages/db-p2p-storage-rn/src/mmkv-storage.ts
  - packages/db-p2p-storage-rn/src/mmkv-kv-store.ts
  - packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts
  - packages/db-p2p-storage-rn/register.mjs
  - packages/db-p2p-storage-rn/package.json
  - package.json
---

## What landed

`react-native-mmkv` 4.x renamed per-key removal from `delete(key): void` to `remove(key): boolean`. The package's local `MMKV` interface still declared `delete`, and four call sites called the old method, producing the production `TypeError: undefined is not a function` on every `internalCommit` once bootstrap-mode writes routed through `MMKVRawStorage`. The fix is the mechanical API rename, plus a v4-pinned peer dep, a unit-test suite that locks in the contract, and root-level test wiring.

## Surface area to review

### `packages/db-p2p-storage-rn/src/mmkv-storage.ts`

- The local `MMKV` interface (lines 8–14) is a structural subset of the real `react-native-mmkv` 4.x `MMKV` class: `getString`, `set`, `remove(key): boolean`, `getAllKeys`, `contains`. No runtime import — keeps the package importable in non-RN contexts.
- Three call sites use the new `remove`:
  - `deletePendingTransaction` (`mmkv-storage.ts:58`)
  - `saveMaterializedBlock(undefined)` removal branch (`mmkv-storage.ts:98`)
  - `promotePendingTransaction` (`mmkv-storage.ts:118`)

### `packages/db-p2p-storage-rn/src/mmkv-kv-store.ts`

- Fourth call site: `MMKVKVStore.delete` forwards to `mmkv.remove(...)` (`mmkv-kv-store.ts:17`). This was outside the original ticket scope but became a typecheck error once the local `MMKV` interface dropped `delete`, so it's part of the same migration.

### `packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts` (new)

`FakeMMKVv4` is a `Map`-backed fake that implements only the local `MMKV` shape — intentionally **no** `delete` member, mirroring the v4 nitro spec, so any regression to `mmkv.delete(...)` would surface as the production `TypeError`. Five tests:

- `deletePendingTransaction removes the pending key via remove()`
- `saveMaterializedBlock(undefined) removes the materialized key via remove()`
- `promotePendingTransaction moves pending → committed via remove()`
- `throws when promoting a missing pending action`
- `MMKVKVStore.delete() forwards to the v4 remove() method`

The fake counts `removeCalls` so each test asserts the v4 method was actually invoked, not just that the key disappeared.

### `packages/db-p2p-storage-rn/register.mjs` (new)

Tiny `ts-node/esm` loader hook (matches sibling packages); enables running `.spec.ts` directly under Node without a build step.

### `packages/db-p2p-storage-rn/package.json`

- `peerDependencies.react-native-mmkv`: `^4.0.0` (was `^3.0.0 || ^2.0.0`). v3/v2 compat is intentionally not preserved — matches the host pin and the ticket stance.
- New `test` / `test:verbose` scripts (mocha + ts-node/esm via `register.mjs`).
- New devDeps: `chai`, `mocha`, `ts-node`, `@types/chai` (mirrors what other packages in the repo use for in-package tests).

### Root `package.json`

- `test:db-p2p-storage-rn` and `:verbose` scripts wired into the aggregate `test` and `test:verbose` chains.

## Verification done in implement

- `yarn test` in `packages/db-p2p-storage-rn`: **5 passing**.
- `yarn build` in `packages/db-p2p-storage-rn`: exit 0 (typecheck clean).
- "Would have caught the bug" sanity check: temporarily reverting one call site to `(this.mmkv as any).delete(...)` causes the suite to fail with the exact production `TypeError: this.mmkv.delete is not a function`.

## Reviewer checklist

- [ ] All four call sites in `mmkv-storage.ts` and `mmkv-kv-store.ts` use `remove`, not `delete`. No stragglers anywhere in `packages/db-p2p-storage-rn/`.
- [ ] Local `MMKV` interface is a *structural* subset of v4 — adding the `remove` boolean return doesn't accidentally constrain callers (`removeFromPendingIndex` etc. ignore the return value, which is fine).
- [ ] `FakeMMKVv4` truly lacks a `delete` member (no `delete = ... as any` escape hatch) so the suite genuinely guards against regression.
- [ ] Aggregate `yarn test` from the repo root picks up the new package (re-run to confirm `test:db-p2p-storage-rn` is reached).
- [ ] Aggregate `yarn build` from the repo root is still clean.
- [ ] Peer dep range `^4.0.0` is consistent with the host app's pinned react-native-mmkv (4.3.1 in production).
- [ ] No documentation references the old `delete(key)` API in this package's README/docs.

## Out of scope

- Host-side `react-native-mmkv-v4-api-migration` work in `sereus-health` is already complete and untouched.
- v3 / v2 compatibility — package targets v4 exclusively.
- `IRawStorage` and other backends (`db-p2p-storage-fs`, `MemoryRawStorage`) — they don't go through MMKV and weren't touched.
