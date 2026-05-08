---
description: Migrated `@optimystic/db-p2p-storage-rn` to the react-native-mmkv 4.x per-key-removal API. The local `MMKV` interface and four call sites moved from `delete(key): void` to `remove(key): boolean`, fixing the production `TypeError: undefined is not a function` on every `internalCommit` once bootstrap-mode writes routed through `MMKVRawStorage`. Locked the v4 contract in with a fake-backed unit suite and wired the package into the aggregate test target.
files:
  - packages/db-p2p-storage-rn/src/mmkv-storage.ts
  - packages/db-p2p-storage-rn/src/mmkv-kv-store.ts
  - packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts
  - packages/db-p2p-storage-rn/register.mjs
  - packages/db-p2p-storage-rn/package.json
  - package.json
---

## What was built

`react-native-mmkv` 4.x renamed per-key removal from `delete(key): void` to `remove(key): boolean`. The package's local `MMKV` shape still declared `delete`, and four call sites called the old method, so on a real v4 instance every `MMKVRawStorage.deletePendingTransaction` / `saveMaterializedBlock(undefined)` / `promotePendingTransaction` / `MMKVKVStore.delete` threw `TypeError: this.mmkv.delete is not a function` — surfaced in production as a crash on every `internalCommit` once bootstrap-mode writes started routing through this backend.

The fix is the mechanical API rename, plus a v4-pinned peer dep, a fake-backed unit suite that locks the contract, and root-level test wiring.

## Key files

- **`packages/db-p2p-storage-rn/src/mmkv-storage.ts`** — `MMKV` interface uses `remove(key): boolean`; call sites updated at `mmkv-storage.ts:58` (`deletePendingTransaction`), `:98` (`saveMaterializedBlock(undefined)` removal branch), and `:118` (`promotePendingTransaction`). The interface stays a structural subset (no runtime import of `react-native-mmkv`) so the package remains importable in non-RN contexts.
- **`packages/db-p2p-storage-rn/src/mmkv-kv-store.ts`** — `MMKVKVStore.delete` (the `IKVStore` method) forwards to `mmkv.remove(...)` at `mmkv-kv-store.ts:17`. Pulled into scope because dropping `delete` from the local `MMKV` interface made this site a typecheck error.
- **`packages/db-p2p-storage-rn/test/mmkv-storage.spec.ts`** (new) — `FakeMMKVv4` is a `Map`-backed fake implementing only the v4 shape, with **no** `delete` member, so a regression to `mmkv.delete(...)` reproduces the production `TypeError`. Five tests cover all four call sites plus the missing-pending-action error path. The fake counts `removeCalls` so each test asserts the v4 method was actually invoked, not just that the key disappeared.
- **`packages/db-p2p-storage-rn/register.mjs`** (new) — `ts-node/esm` loader hook (matches sibling packages) so `.spec.ts` runs under Node without a build step.
- **`packages/db-p2p-storage-rn/package.json`** — `peerDependencies.react-native-mmkv` pinned to `^4.0.0`; `test` / `test:verbose` scripts (mocha + ts-node/esm); devDeps `chai`, `mocha`, `ts-node`, `@types/chai` (mirrors other in-package suites).
- Root **`package.json`** — `test:db-p2p-storage-rn` and `:verbose` wired into the aggregate `test` and `test:verbose` chains.

## Testing notes

- **In-package**: `cd packages/db-p2p-storage-rn && yarn test` → 5 passing.
- **In-package build**: `yarn build` exits 0 (typecheck clean).
- **Aggregate test from repo root**: `yarn test` reaches `test:db-p2p-storage-rn` (verified in the stream — `5 passing (3ms)` mid-run). Other suites also pass: db-core 302, db-p2p 437 (5 pending), quereus-crypto 50, quereus-optimystic 185 (4 pending), reference-peer 4, demo 12.
- **Aggregate build from repo root**: `yarn build` exits 0.
- **Regression-guard sanity check** (done during implement): temporarily reverting one call site to `(this.mmkv as any).delete(...)` makes the suite fail with the exact production `TypeError: this.mmkv.delete is not a function`.

## Usage

The package now requires `react-native-mmkv@^4.0.0` as a peer. Consumers passing a host MMKV instance get the v4 API contract enforced at the boundary; the local `MMKV` type is structurally compatible with the real `react-native-mmkv` 4.x `MMKV` class (`getString`, `set`, `remove`, `getAllKeys`, `contains`).

`MMKVRawStorage` removes per-key state via `remove(key): boolean`; callers in this package ignore the return value (`removeFromPendingIndex` etc.), which is fine — the boolean is informational. Adapters wrapping a non-MMKV backend should implement `remove(key): boolean` accordingly.

## Reviewer checklist outcome

- All four call sites use `remove`. Only matches for `.delete(` in the package are: (a) `Map.delete` inside `FakeMMKVv4.remove` (correct — that's the JS Map API), (b) the `MMKVKVStore.delete` `IKVStore` method (the public KV API name, which forwards to `mmkv.remove`), and (c) a regression-intent comment in the spec.
- Local `MMKV` interface is a structural subset of v4 — return-value change is non-breaking for callers.
- `FakeMMKVv4` lacks any `delete` member or `as any` escape hatch; the suite genuinely guards against regression.
- Aggregate `yarn test` from repo root picks up the new package (re-verified).
- Aggregate `yarn build` from repo root is clean (re-verified).
- Peer dep `^4.0.0` is consistent with the host pin (`react-native-mmkv` 4.3.1 in production).
- No README/docs in the package reference the old `delete(key)` API.

## Out of scope (unchanged)

- Host-side `react-native-mmkv-v4-api-migration` work in `sereus-health` — already complete and untouched.
- v3 / v2 compatibility — package targets v4 exclusively.
- `IRawStorage` and other backends (`db-p2p-storage-fs`, `MemoryRawStorage`) — they don't go through MMKV.
