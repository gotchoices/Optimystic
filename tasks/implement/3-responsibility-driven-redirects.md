description: Harden responsibility-driven redirect flow — DRY service, include addrs, add cancel redirect, add tests
dependencies: responsibilityK, NetworkManagerService, RepoService, RepoClient, redirect.ts
files:
  - packages/db-p2p/src/repo/service.ts
  - packages/db-p2p/src/repo/client.ts
  - packages/db-p2p/src/repo/redirect.ts
  - packages/db-p2p/src/network/network-manager-service.ts
  - packages/db-p2p/test/redirect.spec.ts
----

## Context

The responsibility-driven redirect mechanism with responsibilityK=1 is already implemented:
- **RepoService** (service.ts) checks cluster membership for get/pend/commit, returns `RedirectPayload` when not a member.
- **RepoClient** (client.ts) detects redirect, follows single-hop (max 2), caches coordinator via `recordCoordinatorForOpsIfSupported`.
- **Caching**: `Libp2pKeyPeerNetwork.recordCoordinator()` and `NetworkManagerService.recordCoordinator()` both cache with TTL (30min). `findCoordinator()` checks cache first, so subsequent requests go directly to the right peer.

This task hardens the existing mechanism by addressing:

### 1. DRY the redirect check in RepoService

The responsibility/redirect check is copy-pasted across get, pend, and commit handlers (~15 lines each). Extract into a helper:

```typescript
private async checkRedirect(key: Uint8Array): Promise<RedirectPayload | null>
```

Returns a redirect payload if this node is not responsible, or null if it should handle locally. Each handler calls this first and short-circuits if non-null.

### 2. Include multiaddrs in redirect payloads

Currently `encodePeers` is called with `addrs: []` for every peer (service.ts lines 138, 162, 189). The service already has access to libp2p connections — populate addrs from connected peer addresses so the client can connect to redirect targets it doesn't yet have routes to.

Use `libp2p.getConnections(peerId)` to get known multiaddrs for each redirect peer.

### 3. Add redirect for cancel operations

Cancel (service.ts lines 170-173) skips the responsibility check entirely. Add the same redirect logic for consistency — if this node isn't responsible for the block, redirect to the responsible peer. Cancel is idempotent, so redirect behavior is safe.

### 4. Add redirect flow tests

Create `packages/db-p2p/test/redirect.spec.ts` covering:

- **Service redirect**: RepoService returns RedirectPayload when not a cluster member (responsibilityK=1)
- **Service passthrough**: RepoService handles locally when it IS a cluster member
- **Service small-mesh**: RepoService handles locally when cluster.length < responsibilityK
- **Client follow**: RepoClient follows redirect and returns result from target peer
- **Client cache**: RepoClient calls recordCoordinator after redirect
- **Client loop detection**: RepoClient throws on redirect loop (hop >= 2 or same peer)
- **Cancel redirect**: Cancel operation also redirects when not responsible

Tests should use mock components (mock NetworkManager, mock IRepo) rather than real libp2p — focus on the redirect decision logic and client follow behavior.

### 5. Type the networkManager access

Replace `(this.components as any).libp2p?.services?.networkManager` with a typed interface. Add an optional `networkManager` field to `RepoServiceComponents` (or a `getCluster` callback). This avoids deep `any` chains and makes the redirect logic testable.

## TODO

### Phase 1: Service refactor
- Extract `checkRedirect(key: Uint8Array)` helper in RepoService that encapsulates cluster lookup, membership check, and redirect payload construction
- Wire get/pend/commit/cancel handlers to use the helper
- Include multiaddrs from `libp2p.getConnections(peerId)` in redirect payloads
- Type the networkManager access — add optional `networkManager` (with `getCluster` method) to RepoServiceComponents

### Phase 2: Tests
- Create `packages/db-p2p/test/redirect.spec.ts`
- Test service redirect vs passthrough vs small-mesh for each operation type
- Test client redirect follow, caching, and loop detection
- Ensure build and existing tests pass
