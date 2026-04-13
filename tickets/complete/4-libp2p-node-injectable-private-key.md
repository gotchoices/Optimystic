priority: 4
description: Allow callers of `createLibp2pNode` to inject a stored Ed25519 private key so peer identity can persist across process restarts
dependencies: packages/db-p2p
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/injectable-private-key.spec.ts
----
## What was built

Added `privateKey?: PrivateKey` to `NodeOptions`. When provided, the libp2p node uses this identity instead of generating a fresh keypair. The single-line change `options.privateKey ?? await generateKeyPair('Ed25519')` at `libp2p-node-base.ts:170` is the entire implementation. The key flows consistently to `createLibp2p`, `clusterMember`, and `DisputeService`.

Both `libp2p-node.ts` and `libp2p-node-rn.ts` re-export `NodeOptions`, so the option is available to all platform consumers with no additional changes.

## Testing

`packages/db-p2p/test/injectable-private-key.spec.ts` (2 tests):
- Serialize/deserialize roundtrip: two nodes with the same private key produce identical peer IDs
- Default behavior: two nodes without a private key produce different peer IDs

All 385 db-p2p tests pass including the 2 new ones. Build passes clean.

## Usage

```ts
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { createLibp2pNode } from '@optimystic/db-p2p';

// Generate and persist a key
const key = await generateKeyPair('Ed25519');
const serialized = privateKeyToProtobuf(key); // store this

// Restore and inject
const restored = privateKeyFromProtobuf(serialized);
const node = await createLibp2pNode({
  bootstrapNodes: [...],
  networkName: 'my-network',
  privateKey: restored
});
```
