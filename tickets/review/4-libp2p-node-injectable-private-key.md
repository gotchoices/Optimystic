priority: 4
description: Allow callers of `createLibp2pNode` to inject a stored Ed25519 private key so peer identity can persist across process restarts
dependencies: packages/db-p2p
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/injectable-private-key.spec.ts
----
## Summary

Added `privateKey?: PrivateKey` to `NodeOptions` in `libp2p-node-base.ts`. When provided, the libp2p node uses this identity instead of generating a fresh keypair. When omitted, behavior is unchanged (fresh key generated).

The single-line change `options.privateKey ?? await generateKeyPair('Ed25519')` replaces the unconditional `generateKeyPair` call. The same `nodePrivateKey` variable continues to flow into `clusterMember(...)` and `DisputeService`, so all subsystems use the injected key consistently.

`libp2p-node.ts` and `libp2p-node-rn.ts` re-export `NodeOptions` from the base module, so the new option is automatically available to all consumers with no changes needed.

## Use cases for testing

- **Persistent peer identity**: Call `createLibp2pNode` with a stored `PrivateKey` (e.g. deserialized via `privateKeyFromProtobuf`). The resulting node should have the same `peerId` as a fresh node started with the same key.
- **Default behavior preserved**: Call `createLibp2pNode` without `privateKey`. Two separate calls should produce different peer IDs.
- **Downstream consumers**: `cadre-core` can now pass its `CadreNodeConfig.privateKey` through to `createLibp2pNode`. Mobile apps can persist and restore identity across cold starts.

## Tests added

`packages/db-p2p/test/injectable-private-key.spec.ts`:
- Two nodes with the same serialized/deserialized private key produce identical peer IDs
- Two nodes without a private key produce different peer IDs

All 385 tests pass (including 2 new).
