----
description: Added debug-based strategic instrumentation across db-core and db-p2p packages
dependencies: debug library (@types/debug added to db-core devDeps)
----

## Summary

Added `debug`-based instrumentation at key decision points across `db-core` and `db-p2p` packages, controlled via the `DEBUG` environment variable.

### Infrastructure
- Created `packages/db-core/src/logger.ts` with `createLogger('subNamespace')` producing `optimystic:db-core:<sub>` loggers (mirrors the existing `db-p2p/src/logger.ts` pattern)
- Added `@types/debug` to db-core devDependencies

### Instrumented files

**db-core:**
- `transactor/network-transactor.ts` — batch creation sizes, stale/missing summaries, cancel triggers, commit batch counts
- `utility/batch-coordinator.ts` — retry paths with excluded peer counts, batch creation stats
- `transform/cache-source.ts` — cache hit/miss with block IDs and cache sizes

**db-p2p:**
- `protocol-client.ts` — dial start/ok/fail with peer and protocol, first-byte timing, response timing
- `storage/storage-repo.ts` — pend/commit/cancel entry with action IDs, revs, block counts; stale detection
- `storage/block-storage.ts` — block-level pend/commit/cancel with block and action IDs
- `repo/service.ts` — converted `console.debug` calls to `createLogger('repo-service')` with structured format strings

### Already instrumented (not modified)
- `cluster/cluster-repo.ts` — already had extensive `cluster-member` logging
- `repo/cluster-coordinator.ts` — already had extensive `cluster` logging

### Documentation
- Created `docs/debugging.md` with namespace reference table and common DEBUG patterns

## Testing / Validation
- db-core: 206 tests passing
- db-p2p: 121 tests passing
- db-p2p-storage-fs: builds cleanly

## Usage

```bash
# Everything
DEBUG='optimystic:*' node app.js

# End-to-end request tracing
DEBUG='optimystic:db-core:network-transactor,optimystic:db-p2p:protocol-client' node app.js

# Cluster consensus
DEBUG='optimystic:db-p2p:cluster,optimystic:db-p2p:cluster-member' node app.js
```

See `docs/debugging.md` for full reference.
