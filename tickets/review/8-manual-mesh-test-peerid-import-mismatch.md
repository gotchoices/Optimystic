# Review: manual-mesh-test.ts PeerId import swap

description: Type-only review of the one-line `import type { PeerId }` swap from `@libp2p/interface` → `@optimystic/db-core`. Verify the callback annotation matches `NetworkTransactor.getRepo`'s contract and confirm build + tests pass.
files:
  - packages/quereus-plugin-optimystic/test/manual-mesh-test.ts
  - packages/db-core/src/network/types.ts
  - packages/db-core/src/network/index.ts
  - packages/db-p2p/src/repo/client.ts
----

## What was implemented

Single import-type change at
`packages/quereus-plugin-optimystic/test/manual-mesh-test.ts:18`:

```ts
import type { PeerId } from '@optimystic/db-core';
```

Previously imported from `@libp2p/interface`, which exposes a discriminated
union (`Ed25519PeerId | Secp256k1PeerId | RSAPeerId | URLPeerId`) that is
structurally narrower than `NetworkTransactor.getRepo`'s declared parameter.
Function parameters are contravariant, so the assignment failed with TS2322.

The minimal structural `PeerId` exported by db-core
(`packages/db-core/src/network/types.ts:9-13`, re-exported via the network
barrel at `packages/db-core/src/network/index.ts:6`) defines only
`toString(): string` and `equals(other: PeerId): boolean` — the surface that
`NetworkTransactor` actually consumes. Concrete libp2p PeerIds satisfy this
structurally at runtime (they have both methods), and `RepoClient.create`
already takes the same db-core `PeerId` type, so the
`RepoClient.create(peerId, …)` call at line 69 type-checks cleanly.

## Verification

- `yarn workspace @optimystic/quereus-plugin-optimystic exec tsc --noEmit` →
  exit 0, no diagnostics.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` →
  185 passing, 4 pending (~2m wall time). No regressions.

## Review checklist

- Confirm line 18 imports from `@optimystic/db-core` (not `@libp2p/interface`).
- Confirm the `getRepo` callback at line 65 type-signature matches
  `NetworkTransactor`'s declared parameter (db-core's structural `PeerId`).
- Confirm the runtime usage inside the callback (`peerId.toString()`,
  `node.peerId.toString()`, `RepoClient.create(peerId, …)`) is unchanged and
  still satisfies the structural type — duck-typing on libp2p concrete
  PeerIds.
- No other `@libp2p/interface` PeerId imports remain in this file (the only
  PeerId reference is the one annotation at line 65).

## Out of scope

The hoisting smell — multiple installed copies of `@libp2p/interface` under
workspace `node_modules/` due to old transitive ranges (`^1.7.0`,
`^2.11.0`) — is unrelated to this type error. If reviewer wants to track
it, file a separate `backlog/` ticket; do not fold into this one.
