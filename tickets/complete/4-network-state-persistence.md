description: Network state persistence and retry optimization for single-node startup
dependencies: p2p-fret SerializedTable API, libp2p-key-network, libp2p-node-base

---

## Summary

Implemented network state persistence in `Libp2pKeyPeerNetwork` to eliminate ~90s startup delays on single-node mobile apps. The retry loop in `findCoordinator()` now short-circuits when retrying is provably futile, while persisted high-water-mark (HWM) prevents unsafe self-coordination after restarts.

## Key Changes

### `packages/db-p2p/src/libp2p-key-network.ts`
- **Types**: `NetworkMode`, `PersistedNetworkState`, `NetworkStatePersistence` — platform-agnostic persistence interface
- **`canRetryImprove()`** — returns `false` when forming + HWM<=1 + FRET only knows self (retry is futile)
- **`initFromPersistedState()`** — restores HWM, lastConnectedTime, consecutiveIsolatedSessions, and FRET table from persistence
- **`persistState()`** — fire-and-forget save with error logging, called on connection events
- **HWM decay** — after 3+ consecutive isolated sessions, allows self-coordination with `hwm-decay` reason and warning
- **Retry short-circuit** — in `findCoordinator()`, breaks out of retry loop when `canRetryImprove()` returns false

### `packages/db-p2p/src/libp2p-node-base.ts`
- Added `persistence` to `NodeOptions`
- Derives `networkMode` from `bootstrapNodes` presence
- Passes both to `Libp2pKeyPeerNetwork` constructor and calls `initFromPersistedState()`

## Review Fixes Applied
- Added error logging to fire-and-forget `persistence.save()` call (was silently swallowing rejections)
- Added logging to FRET import catch block in `initFromPersistedState()`
- Distinguished `hwm-decay` reason from `extended-isolation` in `SelfCoordinationDecision`
- Updated `docs/transactions.md` checklist to mark self-coordination guard as complete

## Testing

21 unit tests in `packages/db-p2p/test/libp2p-key-network.spec.ts`:
- `canRetryImprove()`: forming+HWM<=1+self-only returns false; joining mode always true; forming+HWM>1 true; peers beyond self true
- `initFromPersistedState()`: no-op without persistence; restores HWM/sessions; increments isolated sessions when HWM>1 and empty FRET; no increment when HWM<=1 or FRET has entries
- `persistState()`: no-op without persistence; captures HWM/sessions; captures FRET table when available
- `shouldAllowSelfCoordination()`: bootstrap-node allow; disabled block; hwm-decay after 3+ sessions; blocks when sessions<3
- `consecutiveIsolatedSessions` resets on connection
- `networkMode` defaults to 'forming'

All 118 existing tests continue to pass.

## Backward Compatibility

All new constructor params are optional. Existing callers (`reference-peer`, `quereus-plugin-optimystic`) are unaffected. The `NetworkStatePersistence` interface is platform-agnostic — callers provide their own storage backend.
