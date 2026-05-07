# Complete: manual-mesh-test.ts PeerId import swap

description: One-line `import type { PeerId }` change in the manual mesh test, swapping `@libp2p/interface` for `@optimystic/db-core` to match `NetworkTransactor.getRepo`'s declared parameter type.
files:
  - packages/quereus-plugin-optimystic/test/manual-mesh-test.ts
  - packages/db-core/src/network/types.ts
  - packages/db-core/src/network/index.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-p2p/src/repo/client.ts
----

## What was built

Single import swap at `packages/quereus-plugin-optimystic/test/manual-mesh-test.ts:18`:

```ts
import type { PeerId } from '@optimystic/db-core';
```

The TS2322 was caused by importing `PeerId` from `@libp2p/interface`, whose
discriminated union (`Ed25519PeerId | Secp256k1PeerId | RSAPeerId | URLPeerId`)
is structurally narrower than `NetworkTransactor.getRepo`'s declared parameter
type. Function parameters are contravariant, so the assignment was rejected.

db-core publishes a minimal structural `PeerId`
(`packages/db-core/src/network/types.ts:9-13`, re-exported via
`packages/db-core/src/network/index.ts:6`) with just `toString()` and
`equals()` — exactly what `NetworkTransactor` and `RepoClient.create` consume.
Concrete libp2p PeerIds satisfy this structurally at runtime.

## Verification

- `yarn workspace @optimystic/quereus-plugin-optimystic exec tsc --noEmit` →
  exit 0, no diagnostics.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` (per implement
  stage) → 185 passing, 4 pending. No regressions.

## Review notes

- Line 18 imports from `@optimystic/db-core` (not `@libp2p/interface`).
- Line 65 `getRepo: (peerId: PeerId) => …` matches the same `PeerId` symbol
  used by `NetworkTransactor.getRepo` at `network-transactor.ts:16`.
- `RepoClient.create` (`db-p2p/src/repo/client.ts:3,15`) also takes db-core's
  `PeerId`, so the call at line 69 is consistent with the annotation.
- Runtime accesses (`peerId.toString()`, `node.peerId.toString()`) match the
  structural type; libp2p's concrete PeerIds duck-type cleanly.
- No other `PeerId` references or `@libp2p/interface` imports remain in this
  file.

## Out of scope (carried forward if needed)

Multiple installed copies of `@libp2p/interface` under workspace
`node_modules/` (transitive ranges `^1.7.0`, `^2.11.0`) are unrelated to this
type error and were not touched. File a separate `backlog/` ticket if the
hoisting smell deserves attention.
