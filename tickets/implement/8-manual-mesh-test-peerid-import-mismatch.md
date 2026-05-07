# manual-mesh-test.ts: retype getRepo callback with db-core's PeerId

description: One-line import swap so the `getRepo` callback annotation matches `NetworkTransactor`'s declared parameter type. Fix already applied during fix-stage; this ticket is a verification pass.
prereq: none
files:
  - packages/quereus-plugin-optimystic/test/manual-mesh-test.ts
----

## What changed

`packages/quereus-plugin-optimystic/test/manual-mesh-test.ts:18` previously
imported `PeerId` from `@libp2p/interface`. That type is a discriminated
union (including `URLPeerId` with required `type`, `publicKey`, `toMultihash`,
`toCID`) which is structurally *narrower* than `NetworkTransactor.getRepo`'s
declared parameter (db-core's minimal structural `PeerId` from
`packages/db-core/src/network/types.ts:9-13`). Function parameters are
contravariant, so the callback assignment failed with TS2322.

The import now points at `@optimystic/db-core` (re-exported via the network
barrel at `packages/db-core/src/network/index.ts:6` → `types.ts`). The
callback annotation at line 65 is unchanged structurally — it still takes
`PeerId` — but the type now matches what `NetworkTransactor` actually
delivers. Concrete libp2p PeerIds at runtime continue to satisfy the
structural type by duck-typing (`toString` and `equals` are both present).

`RepoClient.create` (`packages/db-p2p/src/repo/client.ts:15`) imports its
`PeerId` parameter type from `@optimystic/db-core` already, so the call
through `RepoClient.create(peerId, ...)` at line 69 type-checks cleanly with
the new annotation.

## Verification done in fix-stage

- `yarn tsc --noEmit` in `packages/quereus-plugin-optimystic` exits 0
  (previously failed with TS2322 at line 65). Confirmed locally.

## TODO

- [ ] Run the package's test suite to confirm no behavioral regression:
      `yarn workspace @optimystic/quereus-plugin-optimystic test`. The change
      is type-only (a `import type` swap), so tests should pass identically.
- [ ] Re-confirm `yarn tsc --noEmit` in `packages/quereus-plugin-optimystic`
      exits clean.
- [ ] Forward to `review/` once both checks pass.

## Out of scope (do not pursue here)

The hoisting smell flagged in the fix ticket — multiple installed copies of
`@libp2p/interface` under workspace `node_modules/` due to old transitive
ranges (`^1.7.0`, `^2.11.0`) — is real but unrelated to this error. File a
separate `backlog/` ticket if motivated; do not fold it into this fix.
