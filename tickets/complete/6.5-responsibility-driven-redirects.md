description: Responsibility-driven redirect flow — DRY service, multiaddrs, cancel redirect, tests
status: complete
files:
  - packages/db-p2p/src/repo/service.ts
  - packages/db-p2p/src/repo/redirect.ts
  - packages/db-p2p/src/repo/client.ts
  - packages/db-p2p/test/redirect.spec.ts
----

## What was built

Refactored the responsibility-driven redirect mechanism in `RepoService` to be DRY, typed, and complete:

- **`checkRedirect(blockKey, opName, message)`**: Single helper encapsulating sha256 key derivation, cluster lookup, membership check, and redirect payload construction. All four operation handlers (get, pend, commit, cancel) call this one method.
- **`NetworkManagerLike` interface**: Typed DI for network manager (`{ getCluster(key: Uint8Array): Promise<PeerId[]> }`), with legacy fallback path.
- **`RedirectPayload` type** in `redirect.ts`: Clean `{ redirect: { peers: [{id, addrs}], reason } }` structure.
- **Cancel now redirects**: Previously had no responsibility check; now uses `checkRedirect` like all other operations.
- **Multiaddrs included**: Redirect payloads include known multiaddrs for each peer via `getConnectionAddrs` component.
- **Client redirect handling**: `RepoClient.processRepoMessage` follows redirects with max 2 hops, loop detection, and coordinator cache hint.

## Review fixes applied

- Fixed indentation inconsistency in `client.ts` redirect handling block (lines 78-83 were under-indented within the `if` block).
- Added `cancel` case to `extractKeyFromOperations` in `client.ts` so coordinator cache hints fire for cancel redirect hops.
- Trimmed trailing blank line in `redirect.ts`.

## Testing

- 12 redirect-specific tests in `test/redirect.spec.ts` covering:
  - Redirect when node is NOT in cluster (K=1)
  - No redirect when node IS in cluster
  - Small-mesh bypass (cluster.length < responsibilityK)
  - No redirect when no networkManager
  - Multiaddrs inclusion in redirect payload
  - Self-exclusion from redirect peers
  - Cluster info attachment to message
  - Redirect for all operation types (get, pend, commit, cancel)
  - Redirect payload structure validation
- All 191 db-p2p tests pass
- Full project build succeeds

## Usage

The redirect is transparent to callers. When `responsibilityK` is configured on `RepoService`, requests for keys this node isn't responsible for are automatically redirected. Clients follow redirects (up to 2 hops) and cache the coordinator for future requests.

```ts
// Service-side: configure responsibility
const service = repoService({ responsibilityK: 3 })

// Components provide typed DI for testability
const components: RepoServiceComponents = {
  networkManager: { getCluster: async (key) => [...] },
  peerId: selfId,
  getConnectionAddrs: (pid) => [...],
  // ...
}
```
