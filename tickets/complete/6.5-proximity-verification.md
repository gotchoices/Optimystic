# Proximity Verification for CoordinatorRepo — Complete

## What Was Built

Defense-in-depth proximity verification in `CoordinatorRepo`: nodes reject write requests for blocks they're not cluster members of. The routing layer (FRET) is the primary guard; this catches misrouted requests.

### Key Design Decisions

- **Write path (strict)**: `pend`, `cancel`, `commit` throw `Not responsible for block(s): ...` if any block fails the cluster membership check
- **Read path (soft)**: `get` logs a warning but still serves — reads are best-effort and the cluster-fetch fallback handles missing blocks
- **Fail-open**: If `findCluster` throws (network failure), the check assumes responsible to avoid false rejections
- **Backward compat**: If `localPeerId` is not set, all checks pass (single-node/test setups)
- **Caching**: `LruMap` with 1000 entries and 60s TTL avoids repeated `findCluster` lookups; errors are not cached (transient failures retry)

## Key Files

- `packages/db-p2p/src/repo/coordinator-repo.ts` — `isResponsibleForBlock`, `verifyResponsibility`, wired into all IRepo methods
- `packages/db-p2p/test/coordinator-repo-proximity.spec.ts` — 10 tests covering all verification paths
- `packages/db-p2p/test/mesh-harness.ts` — Mock `findCluster` includes self per-node (matches real `Libp2pKeyPeerNetwork` behavior)

## Testing

10 dedicated proximity tests + all 191 db-p2p tests pass. Coverage includes:

- Backward compatibility (no `localPeerId`)
- Responsible node — all operations succeed
- Non-responsible node — `get` succeeds with warning; `pend`/`cancel`/`commit` throw
- Cache hit verification (second call doesn't invoke `findCluster`)
- Fail-open on network errors
- Mixed blocks — error message lists only non-responsible block IDs

## Validation

```
yarn build         # full project — passes
yarn test:db-p2p   # 191 passing (0 failing)
```
