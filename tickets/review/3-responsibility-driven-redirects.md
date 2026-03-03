description: Hardened responsibility-driven redirect flow — DRY service, multiaddrs, cancel redirect, tests
dependencies: none
files:
  - packages/db-p2p/src/repo/service.ts
  - packages/db-p2p/test/redirect.spec.ts
----

## Summary

Refactored the responsibility-driven redirect mechanism in `RepoService` to be DRY, typed, and complete.

### Changes

**`packages/db-p2p/src/repo/service.ts`**:
- Extracted `checkRedirect(blockKey, opName, message)` helper method that encapsulates: sha256 key derivation, cluster lookup, membership check, and redirect payload construction. All four operation handlers (get, pend, commit, cancel) now call this single method.
- Added `NetworkManagerLike` interface (`{ getCluster(key: Uint8Array): Promise<PeerId[]> }`) to type the network manager access. Components can now provide `networkManager` directly instead of relying on `(this.components as any).libp2p?.services?.networkManager` (legacy path still supported as fallback).
- Added typed `peerId` and `getConnectionAddrs` fields to `RepoServiceComponents` for testability and type safety.
- **Cancel now redirects**: Previously the cancel handler had no responsibility check — it now uses `checkRedirect` like all other operations.
- **Multiaddrs included**: Redirect payloads now include known multiaddrs for each peer (from `getConnectionAddrs` or `libp2p.getConnections(peerId)`), so the client can connect to redirect targets.

**`packages/db-p2p/test/redirect.spec.ts`** (new):
- Tests `checkRedirect` returns redirect when node is NOT in cluster (K=1)
- Tests `checkRedirect` returns null when node IS in cluster
- Tests small-mesh bypass (cluster.length < responsibilityK)
- Tests null result when no networkManager
- Tests multiaddrs inclusion in redirect payload
- Tests self-exclusion from redirect peers
- Tests cluster info attachment to message
- Tests redirect for all operation types (get, pend, commit, cancel)
- Tests redirect payload structure

### Validation

- Build passes (full project build)
- All 170 db-p2p tests pass including 12 new redirect tests
- No changes to existing interfaces or behavior for get/pend/commit (only cancel gained redirect, which is additive)
