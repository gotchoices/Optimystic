description: Review the protons-runtime v6 upgrade and dependency version bumps in db-p2p that eliminate the "streamMessage not found" bundler warnings from the autonat/dcutr nested packages.
prereq:
files: packages/db-p2p/package.json, package.json, yarn.lock
difficulty: easy
----

## What was implemented

### Changes made

1. **`packages/db-p2p/package.json` — dependency version bumps:**
   - `@libp2p/crypto`: `^5.1.13` → `^5.1.19` (eliminates nested copies under autonat/dcutr)
   - Added `"protons-runtime": "^6.0.0"` to dependencies (critical fix — makes v6 the direct dep)
   - `@libp2p/interface` was intentionally kept at `^3.1.0` (see deviation note below)

2. **`package.json` (root) — resolutions:**
   - Added `"protons-runtime": "^6.0.0"` to force gossipsub's `^5.5.0` requirement to resolve to v6 (gossipsub only uses `decodeMessage`/`encodeMessage`/`MaxLengthError`/`message` which are all present in v6)

3. **`yarn.lock`** — updated by yarn install (protons-runtime@5.6.0 removed, consolidated to 6.0.2)

### Verification

Ran `yarn workspaces focus @optimystic/db-p2p` (exits 0; regular `yarn install` exits 1 due to pre-existing quereus uint8arrays conflict — see note below) then confirmed:

- `packages/db-p2p/node_modules/protons-runtime`: **6.0.2** ✓
- `packages/db-p2p/node_modules/@libp2p/autonat/node_modules/protons-runtime`: **ABSENT** ✓
- `packages/db-p2p/node_modules/@libp2p/dcutr/node_modules/protons-runtime`: **ABSENT** ✓
- `packages/db-p2p/node_modules/@libp2p/autonat/node_modules/@libp2p/crypto`: **ABSENT** ✓
- `packages/db-p2p/node_modules/@libp2p/dcutr/node_modules/@libp2p/crypto`: **ABSENT** ✓
- `packages/db-p2p/node_modules/@libp2p/peer-id/node_modules/@libp2p/interface`: **ABSENT** ✓

Still nested (per ticket, these don't produce bundler warnings):
- `packages/db-p2p/node_modules/@libp2p/autonat/node_modules/@libp2p/interface`: `3.2.3`
- `packages/db-p2p/node_modules/@libp2p/dcutr/node_modules/@libp2p/interface`: `3.2.3`

Tests: **848 passing, 29 pending** (`yarn test:db-p2p`)

## Deviation from ticket spec

The ticket specified bumping `@libp2p/interface` from `^3.1.0` → `^3.2.3`. This bump was attempted but reverted because it causes a TypeScript type incompatibility in tests:

```
error TS2322: Type 'Ed25519PeerId' is not assignable to type 'PeerId'.
  Type '@libp2p/peer-id/node_modules/@libp2p/interface/.../Ed25519PeerId' not assignable to
  '@libp2p/interface/.../Ed25519PeerId'
```

Root cause: bumping to `^3.2.3` creates a split in yarn.lock — `^3.1.0` stays locked to 3.1.0 (peer-id's requirement), while db-p2p gets 3.2.3. This creates two incompatible @libp2p/interface instances, breaking TypeScript's structural typing.

A root resolution for `@libp2p/interface` cannot be used to fix this because gossipsub/pubsub require `@libp2p/interface@^2.x` — a blanket resolution to `^3.2.3` would break them.

The `@libp2p/interface` nested copies under autonat/dcutr remain (3.2.3 nested under each), which per the ticket "do NOT produce bundler warnings on their own." The critical fix (protons-runtime v6) is fully in place.

## Pre-existing issue: `yarn install` exits 1

Regular `yarn install` exits 1 with pre-existing YN0071 errors:
```
Cannot link @quereus/quereus into quereus-plugin-crypto: uint8arrays@6.1.1 conflicts with parent uint8arrays@5.1.0
Cannot link @quereus/quereus into quereus-plugin-optimystic: same
```
These errors existed before this ticket's changes (verified by testing with stashed changes). Use `yarn workspaces focus @optimystic/db-p2p` for a clean install of the db-p2p workspace.

## Review focus areas

- Confirm `"protons-runtime": "^6.0.0"` in both db-p2p dependencies and root resolutions is the correct approach for forcing gossipsub's nested v5 to use v6
- Confirm that the @libp2p/interface deviation (keeping ^3.1.0) is acceptable given the test-breaking nature of the bump
- Check whether `@libp2p/crypto: ^5.1.19` (bumped from ^5.1.13) is safe — it eliminated nested copies under autonat/dcutr and tests pass
- Verify gossipsub runtime safety with protons-runtime v6 (uses `decodeMessage`/`encodeMessage`/`MaxLengthError` — all present in v6; `streamMessage` is v6-only but gossipsub never calls it)
