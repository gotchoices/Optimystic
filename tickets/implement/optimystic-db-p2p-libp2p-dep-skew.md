description: Eliminate nested dependency copies in db-p2p by bumping declared versions to match what autonat/dcutr need, and fix the protons-runtime v5/v6 skew that causes "streamMessage not found" bundler warnings.
prereq:
files: packages/db-p2p/package.json, package.json, .yarnrc.yml
difficulty: easy
----

## Root cause

`packages/db-p2p/package.json` declares dependency versions that are older than what `@libp2p/autonat@3.0.21` and `@libp2p/dcutr@3.0.21` require. Yarn therefore installs nested copies under each:

| Package | Top-level (db-p2p declares) | Autonat/dcutr require | Nested copy |
|---|---|---|---|
| `@libp2p/interface` | `^3.1.0` → `3.1.0` | `^3.2.3` | `3.2.3` under each |
| `@libp2p/crypto` | `^5.1.13` → `5.1.13` | `^5.1.19` | `5.1.19` under each |
| `protons-runtime` | `5.6.0` (hoisted from gossipsub `^5.5.0`) | `^6.0.1` | `6.0.2` under each |

The **`protons-runtime` v5 vs v6 skew is the critical one**. `streamMessage` is a new API added in v6. It is imported by:

- `@libp2p/autonat/dist/src/pb/index.js` (proto generated code)
- `@libp2p/autonat/node_modules/@libp2p/crypto/dist/src/keys/keys.js` (nested crypto@5.1.19)
- `@libp2p/dcutr/dist/src/pb/message.js` (proto generated code)
- `@libp2p/dcutr/node_modules/@libp2p/crypto/dist/src/keys/keys.js` (nested crypto@5.1.19)

When the downstream NS webpack (or metro) deduplicates `protons-runtime` to the top-level `5.6.0`, those four `streamMessage` imports produce "export not found" warnings. Setting `exportsPresence:'warn'` in sereus's NS webpack config suppresses these as warnings instead of errors.

The **`@libp2p/interface`/`@libp2p/crypto` skews** create unnecessary nested copies but do NOT produce bundler warnings on their own: autonat/dcutr only import symbols (`InvalidParametersError`, `serviceCapabilities`, `serviceDependencies`, `InvalidMessageError`) that exist in both v3.1.0 and v3.2.3.

## Gossipsub/pubsub @libp2p/interface v2 vs v3 (separate concern)

`@chainsafe/libp2p-gossipsub@14.1.2` (latest on npm) and `@libp2p/pubsub@10.1.18` require `@libp2p/interface@^2.x`. Their dist files import `StrictSign`, `StrictNoSign`, `TopicValidatorResult` — symbols removed from `@libp2p/interface` in v3. These generate warnings only when the bundler aliases ALL `@libp2p/interface` to a single v3 instance (e.g. via NativeScript's webpack resolve aliasing in sereus).

This is **not fixable from optimystic alone** without a yarn patch, since:
- No gossipsub version ≥15 exists yet that supports `@libp2p/interface@^3.x`
- Yarn patches applied in the optimystic workspace do NOT propagate to sereus when db-p2p is consumed as a portal or from npm

The gossipsub/pubsub warnings may be addressed either by a future upstream gossipsub release, or in the sereus-side fix ticket (`reference-app-ns-drop-exportspresence-override`) which can apply its own resolutions or webpack aliases.

## Fix

### 1. Bump `@libp2p/interface`, `@libp2p/crypto` in `packages/db-p2p/package.json`

Aligns declared versions with what autonat/dcutr need, enabling yarn to hoist their nested copies to the top-level and eliminate the redundant installs.

```diff
- "@libp2p/crypto": "^5.1.13",
+ "@libp2p/crypto": "^5.1.19",
- "@libp2p/interface": "^3.1.0",
+ "@libp2p/interface": "^3.2.3",
```

### 2. Add `protons-runtime: ^6.0.0` to `packages/db-p2p/package.json` dependencies

Makes v6 a direct dependency of db-p2p, so it becomes the top-level in db-p2p's node_modules (v6 satisfies autonat/dcutr's `^6.0.1`). This eliminates the nested `6.0.2` copies under autonat and dcutr and removes the `streamMessage` warnings.

Gossipsub requires `protons-runtime@^5.5.0`. v6 does NOT satisfy `^5.5.0`, so without a resolution override, gossipsub would still get a nested v5. The root resolution (step 3) handles this.

```json
"protons-runtime": "^6.0.0",
```

### 3. Add `protons-runtime` resolution to root `package.json`

The `.yarnrc.yml` has `nmHoistingLimits: workspaces`. Adding a root-level resolution forces gossipsub's `^5.5.0` to resolve to v6 within the workspace, eliminating the final nested v5 copy. v6 is backward-compatible with the v5 API surface gossipsub uses (`decodeMessage, encodeMessage, MaxLengthError, message` — all present in v6; `streamMessage` is v6-only but gossipsub never calls it).

```diff
  "resolutions": {
    "@quereus/quereus": "portal:../quereus/packages/quereus",
+   "protons-runtime": "^6.0.0"
  }
```

Note: this resolution only applies within the optimystic workspace. The db-p2p direct dep (`protons-runtime: ^6.0.0`) from step 2 is what propagates to downstream consumers (sereus).

### 4. Run `yarn install` and verify no nested copies remain

After the changes, run `yarn install` and verify:
- No `packages/db-p2p/node_modules/@libp2p/autonat/node_modules/` `@libp2p/interface`, `@libp2p/crypto`, or `protons-runtime` folders
- No `packages/db-p2p/node_modules/@libp2p/dcutr/node_modules/` `@libp2p/interface`, `@libp2p/crypto`, or `protons-runtime` folders
- `packages/db-p2p/node_modules/protons-runtime/` is v6.x

### 5. Run db-p2p tests

```
yarn test:db-p2p
```

## TODO

- Bump `@libp2p/interface` from `^3.1.0` → `^3.2.3` in `packages/db-p2p/package.json`
- Bump `@libp2p/crypto` from `^5.1.13` → `^5.1.19` in `packages/db-p2p/package.json`
- Add `"protons-runtime": "^6.0.0"` to the `dependencies` section of `packages/db-p2p/package.json`
- Add `"protons-runtime": "^6.0.0"` to the `resolutions` section of the root `package.json`
- Run `yarn install`
- Verify no nested `protons-runtime`, `@libp2p/interface@3.2.3`, `@libp2p/crypto@5.1.19` copies remain under autonat/dcutr in db-p2p's node_modules
- Run `yarn test:db-p2p` and confirm passing
- Note (to hand off to sereus ticket): gossipsub/pubsub `@libp2p/interface` v2-symbol warnings remain unfixable from optimystic; sereus's `reference-app-ns-drop-exportspresence-override` ticket should address them via its own approach (upstream gossipsub update, sereus-side patch, or continued suppression for those specific symbols)
