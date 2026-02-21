----
description: Review collection-level access controls and permissions
dependencies: none
----

# Collection-Level Access Controls — Review

## Summary

Added a permission model (read/write/admin) to collections, stored in collection header blocks and enforced during the cluster PEND validation phase.

## Changes

### New files
- `packages/db-core/src/collection/acl.ts` — ACL helper functions: `checkPermission`, `hasAtLeast`, `createDefaultAcl`
- `packages/db-core/test/acl.spec.ts` — 11 unit tests for ACL helpers

### Modified files
- `packages/db-core/src/collection/struct.ts` — Added `Permission`, `CollectionAcl` types; extended `CollectionHeaderBlock` with optional `acl` field
- `packages/db-core/src/collection/collection.ts` — Added optional `acl` field to `CollectionInitOptions`; merges ACL into header block on creation
- `packages/db-core/src/collection/index.ts` — Exports `acl.js`
- `packages/db-p2p/src/cluster/cluster-repo.ts` — Added `checkCollectionAcl()` and `isAclModified()` to `ClusterMember`; called during `validatePendOperations()` after stale-revision checks

### Test files modified
- `packages/db-core/test/collection.spec.ts` — 2 tests for header block ACL integration
- `packages/db-p2p/test/cluster-repo.spec.ts` — 6 tests for cluster-level ACL enforcement

## Testing

- `db-core`: 219 tests passing (was 206, +13 new)
- `db-p2p`: 124 tests passing (was 118, +6 new)
- Full build: all packages compile cleanly

## Test coverage

| Scenario | Test |
|----------|------|
| Permission hierarchy (read < write < admin) | `acl.spec.ts` |
| Undefined ACL → open collection (backward compat) | `acl.spec.ts`, `cluster-repo.spec.ts` |
| Default permission fallback | `acl.spec.ts` |
| Explicit grants honored | `acl.spec.ts` |
| createDefaultAcl grants admin to creator, read to others | `acl.spec.ts` |
| ACL set on header block at creation time | `collection.spec.ts` |
| ACL absent when not specified | `collection.spec.ts` |
| Unauthorized peer write rejected at cluster | `cluster-repo.spec.ts` |
| Authorized peer write accepted at cluster | `cluster-repo.spec.ts` |
| ACL modification requires admin | `cluster-repo.spec.ts` |
| Admin can modify ACL | `cluster-repo.spec.ts` |
| No transaction stamp → skip ACL (backward compat) | `cluster-repo.spec.ts` |

## Usage

```typescript
import { createDefaultAcl } from '@optimystic/db-core';

// Create a collection with access controls
const acl = createDefaultAcl(myPeerId);
const collection = await Collection.createOrOpen(transactor, id, {
  modules: { ... },
  createHeaderBlock: (id, store) => ({
    header: store.createBlockHeader('CH', id),
  }),
  acl, // Creator gets admin, everyone else gets read
});
```
