description: Review implementation of the stale-cert refetch integration test fix — test now seeds via the membership source (TOFU path) instead of verifier.cache() (trusted path) so the trust-anchor gate no longer blocks the refetch assertion.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (CohortTopicHost interface L439-475, return object L875-890)
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (import L27, test L451-483)
difficulty: easy
----

## Path chosen: A (redesign)

The broken test primed the verifier via `verifier.cache(staleCert)`, which marks the cert `trusted: true`. The subsequent real `/membership` refetch returned a cert with no rotation attestation off the fabricated epoch, so `fallbackTrust` returned `"reject"` (the "no silent TOFU downgrade" invariant). `verifyMessage` correctly returned `"untrusted"`.

Path A was chosen: seed the stale cert through the membership **source** instead. The source feeds TOFU-cached entries (not trusted ones), so the refetch's genuine cert is permitted to replace it, and `verifyMessage` returns `"verified"`.

## Changes made

### `packages/db-p2p/src/cohort-topic/host.ts`

- Added `readonly membershipSource: { cache(coord: RingCoord, encoded: Uint8Array): void }` to the `CohortTopicHost` interface (same introspection spirit as `promoteGate`/`gossipTransport`). The structural type is satisfied by the existing `FretMembershipSource` local variable.
- Added `membershipSource` to the returned host object.

### `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`

- Added `encodeCohortMessage` to the `@optimystic/db-core` import.
- Rewrote the test: renamed to `"a stale cert in the membership source forces one real /membership refetch, then verifies"`, dropped `verifier.cache(staleCert)`, picks a fresh non-primary node (not the one test 1 TOFU-cached via verifier), seeds that node's membership source via `membershipSource.cache(coord0, encodeCohortMessage(staleCert))`, then asserts `verifyMessage(...)` → `"verified"`.
- The `staleMemberBytes()` helper is still referenced by the rewritten test, so it was left in place.

## Validation results

All commands run with streaming output (`tee`), no silent redirection.

### Gated stale test (Path A primary assertion)
```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.integration.spec.ts" --grep "stale" --reporter spec
```
Result: **1 passing (773ms)** — ✔ `a stale cert in the membership source forces one real /membership refetch, then verifies`

### Full §2 MembershipCertV1 block (cross-test regression check)
```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.integration.spec.ts" --grep "MembershipCertV1|membership|stale|threshold-signed" --reporter spec
```
Result: **3 passing (785ms)** — all three tests pass, no cross-test state regressions.

### db-core unit suite (stale-refetch unit test must remain passing)
```
# from packages/db-core
yarn test
```
Result: **996 passing (2s)** — stale-refetch unit test at `membership.spec.ts:77` untouched and passing.

### db-p2p default unit suite
```
# from packages/db-p2p
yarn test
```
Result: **1062 passing, 37 pending** — no regressions.

## Known gaps / reviewer notes

- The `membershipSource` shape on `CohortTopicHost` is a minimal structural shim (`{ cache(coord, encoded): void }`). A reviewer could consider promoting `IMembershipSource` to include `cache()` rather than exposing a one-off structural type, but that would change the port contract for all implementors (currently `cache` is implementation-detail on `FretMembershipSource`). The shim keeps the port contract clean.
- The real-libp2p mesh booted and ran the gated tests successfully in this environment (~785ms total), so the review handoff does not need to rely on code-read only.
