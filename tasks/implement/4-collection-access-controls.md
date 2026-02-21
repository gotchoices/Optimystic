----
description: Add collection-level access controls and permissions
dependencies: signature-verification-implementation (soft), collection header blocks, cluster validator hook
----

# Collection-Level Access Controls

## Overview

Add a permission model to collections so that only authorized peers can perform specific operations (read, write, admin) on a collection. Permissions are stored in the collection header block and enforced during the cluster PEND validation phase.

## Architecture

### Identity Model

The principal is the peer's public key (derived from PeerId via libp2p's Ed25519 identity). The `ClusterPeers` record already carries `publicKey: Uint8Array` per peer. Until the signature-verification task is complete, enforcement is best-effort (peers are trusted to present their real identity); once signatures are live, access control becomes cryptographically bound.

### Permission Types

```
Permission = 'read' | 'write' | 'admin'
```

- **read** - Can fetch blocks belonging to this collection.
- **write** - Can propose (PEND) mutations to this collection. Implies read.
- **admin** - Can modify the collection's ACL itself (add/remove grants). Implies write + read.

### Policy Storage

The collection header block is extended with an optional `acl` field:

```typescript
type CollectionAcl = {
	/** Default permission for peers not explicitly listed. If absent, defaults to 'write' (open). */
	defaultPermission?: Permission;
	/** Per-peer grants. Key is the PeerId string. */
	grants: Record<string, Permission>;
};

type CollectionHeaderBlock = IBlock & {
	header: { type: CollectionHeaderType };
	acl?: CollectionAcl;
};
```

When `acl` is `undefined`, the collection is open (all peers have write access) -- this preserves backward compatibility.

### Enforcement Points

```
Client writes:  Collection.act() / Collection.sync()
                   |
                   v
Cluster PEND:   ClusterMember.validatePendOperations()
                   |  <-- NEW: check peer's write permission for target collection
                   v
Cluster COMMIT: handleConsensus()  (already validated)
```

**Primary enforcement: `ClusterMember.validatePendOperations()`**

During the PEND phase, each cluster member validates the incoming PendRequest. The new access control check:

1. Extract the `collectionId` from the PendRequest (the header block ID is the collection ID -- it is always in the transforms since the log tail is updated).
2. Look up the collection header block from local storage to read the ACL.
3. Identify the requesting peer from the `TransactionStamp.peerId` field (already present in `PendRequest.transaction.stamp.peerId`).
4. Check whether that peer has at least `write` permission.
5. If denied, reject with reason `access-denied: peer <id> lacks write permission on collection <id>`.

**Secondary (local) enforcement: `Collection.act()` and `TransactionCoordinator.applyActions()`**

Optionally, the local node can pre-check its own permissions before sending a PEND to the network. This avoids unnecessary round-trips but is not the security boundary (cluster validation is).

**Read enforcement**

Read access control is enforced at the `IRepo.get()` level. When a peer requests blocks, the coordinator (or storage repo) checks whether the requesting peer has `read` permission for the collection that owns those blocks. This requires mapping blockId -> collectionId, which can be done via the block's header metadata or a collection membership index.

Note: Read enforcement is a softer boundary -- in a P2P system, data is replicated across cluster members, so read restrictions only apply to the network protocol layer (peers that don't have the data can't be prevented from obtaining it through other channels). For strong read confidentiality, encryption-at-rest per collection is the long-term solution (out of scope here).

### ACL Modification

Modifying the ACL is itself a write operation to the collection header block. Only peers with `admin` permission can modify the ACL. The validator checks:

1. If the PendRequest transforms include changes to the collection header block's `acl` field...
2. Then the requesting peer must have `admin` permission.

The collection creator is implicitly the first admin. When a collection is created (`Collection.createOrOpen` with no existing header), the creating peer's ID is added as an `admin` grant.

## Key Files

| File | Role |
|------|------|
| `packages/db-core/src/collection/struct.ts` | Add `CollectionAcl` type and extend `CollectionHeaderBlock` |
| `packages/db-core/src/collection/collection.ts` | Add ACL to header on creation; optional local pre-check |
| `packages/db-p2p/src/cluster/cluster-repo.ts` | Add access control check in `validatePendOperations()` |
| `packages/db-core/src/transaction/validator.ts` | Extend `ITransactionValidator` or add ACL validation hook |
| `packages/db-core/src/collection/acl.ts` | New: ACL helper functions (checkPermission, hasAtLeast, etc.) |

## TODO

### Phase 1: Types and helpers
- Add `Permission` type and `CollectionAcl` type to `packages/db-core/src/collection/struct.ts`
- Create `packages/db-core/src/collection/acl.ts` with:
  - `checkPermission(acl: CollectionAcl | undefined, peerId: string, required: Permission): boolean`
  - `hasAtLeast(granted: Permission, required: Permission): boolean`
  - `createDefaultAcl(creatorPeerId: string): CollectionAcl`
- Export from `packages/db-core/src/collection/index.ts`

### Phase 2: Header block integration
- Update `Collection.createOrOpen()` to set initial ACL on the header block when creating a new collection (requires passing `peerId` into `createOrOpen`)
- Preserve existing `acl: undefined` semantics for backward compatibility

### Phase 3: Cluster enforcement
- In `ClusterMember.validatePendOperations()` (cluster-repo.ts), after stale-revision checks:
  - Extract collectionId from the PendRequest (from the transforms' block IDs -- the header blockId equals collectionId)
  - Fetch the collection header from local storage
  - Read the `acl` field
  - Get the requesting peer ID from `pendRequest.transaction?.stamp.peerId`
  - Call `checkPermission(acl, peerId, 'write')`
  - If ACL changes detected in transforms, require `admin` permission
  - Return rejection if denied

### Phase 4: Tests
- Unit tests for `acl.ts` helpers (permission hierarchy, default behavior, undefined ACL)
- Integration test: create collection with ACL, attempt write from unauthorized peer, verify rejection
- Integration test: admin modifies ACL, then previously-unauthorized peer succeeds
- Backward compatibility test: collections without ACL remain open
