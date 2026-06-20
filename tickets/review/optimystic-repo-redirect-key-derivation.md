description: The peer-to-peer "you're not the right node, ask these other nodes" hand-off for data requests was computing the wrong target nodes, so it had been switched off; this fixes the math and turns it back on, with a live multi-node test proving a handed-off request still completes.
files: packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Review: reconcile repo-path redirect key derivation + un-inert RepoService.checkRedirect

## What was implemented

Three production changes + two test changes. Build (`yarn build`) and the default test suite
(`yarn test`) are green in `packages/db-p2p` (**855 passing, 30 pending**). The new running-mesh
round-trip test was **run and passes** (gated; see Validation).

### 1. Key-derivation fix — `packages/db-p2p/src/repo/service.ts` (the required correctness change)
`RepoService.checkRedirect` no longer pre-hashes the block key. It now passes the **raw encoded
block-key bytes** to `nm.getCluster(...)`:

```ts
// before:  const mh = await sha256.digest(new TextEncoder().encode(blockKey)); nm.getCluster(mh.digest)
// after:   const key = new TextEncoder().encode(blockKey);                     nm.getCluster(key)
```

`getCluster` hashes internally (`hashKey == sha256.encode`, confirmed in
`node_modules/p2p-fret/src/ring/hash.ts:18`), so the cohort coordinate is now
`hashKey(encode(blockKey))` — **byte-identical** to the cluster coordinator's
`ClusterCoordinator.getClusterForBlock → findCluster(encode(blockId))` (`cluster-coordinator.ts:88`
→ `libp2p-key-network.ts:469`). The old code double-hashed (`hashKey(sha256(encode(blockKey)))`),
landing the cohort on an unrelated ring coordinate. The unused `sha256` import was dropped.

### 2. Activation — `packages/db-p2p/src/libp2p-node-base.ts` (the `repo:` wrapper, ~line 397)
The NOTE deferral comment is gone and the service is live. **Implementation deviates from the
ticket's suggested mechanism — reviewer please confirm this is acceptable:**

- The ticket suggested forwarding `libp2p: components.libp2p` and relying on `getNetworkManager()`'s
  lazy `(components as any).libp2p?.services?.networkManager` fallback. **That does not work.**
  Reading `components.libp2p` eagerly at service-construction throws `MissingServiceError: libp2p
  not set`; deferring it through a getter still returns undefined at *request* time — the libp2p
  components proxy does not reliably resolve `libp2p` from inside a service. With that approach the
  entry node's `checkRedirect` returned `null` (no redirect) even though its `getCluster` correctly
  excluded it — proven by the integration test before the fix (entry never redirected; the client
  got entry's empty local read).
- **Fix actually used:** `RepoService` gained a `setLibp2p(node)` method + a `getLibp2p()` resolver
  (`this.libp2pRef ?? (components as any).libp2p`), and the node is injected **post-construction**
  in `libp2p-node-base.ts` right beside the existing `fret`/`networkManager` injections
  (`try { ((node as any).services?.repo as any)?.setLibp2p?.(node); } catch {}`, before
  `node.start()`). `getNetworkManager`/`getSelfId`/`getPeerAddrs` all resolve through `getLibp2p()`.
  This mirrors how `networkManager` itself gets its node ref — the established, reliable pattern in
  this codebase — and is why the `networkManager`-based probe in the test works while the proxy
  fallback did not.
- The repo wrapper therefore forwards only `{ logger, registrar, repo }`; `peerId`/`getConnectionAddrs`
  are **not** forwarded (self id + addrs resolve from the injected node). `RepoServiceComponents`
  keeps an optional `libp2p?` / `peerId?` / `getConnectionAddrs?` surface as a best-effort fallback
  (used by the unit tests, which pass `peerId`/`networkManager` directly).

### 3. `targetSize` residual-divergence stance (documented decision)
Kept `NetworkManagerService.getCluster` for the membership check — its **no-force-self** semantics
are correct for a redirect (we want to know whether FRET genuinely places self in the cohort).
`findCluster` force-adds self, which would mask a real "not responsible" verdict. The `targetSize`
gap (`getCluster` clamps to `min(clusterSize, networkSizeEstimate)`; `findCluster` uses
`clusterSize` exactly) is handled as a **test-design constraint**: the round-trip test uses
`clusterSize: 1`, so both reduce to the single FRET-nearest peer and the gap is moot.

### 4. Unit tests — `packages/db-p2p/test/redirect.spec.ts`
Keyed-NM helpers now key on the **raw** `encode(blockKey)` bytes (`blockKeyMapKey`), matching what
`checkRedirect` now passes. Dropped the `sha256` import + the old digest helper. All existing
`deriveBlockKey` / explicit-key `checkRedirect` assertions are unchanged and pass.

### 5. Integration round-trip — `packages/db-p2p/test/real-libp2p.integration.spec.ts`
New test: `redirect round-trip: a repo op to a non-responsible node redirects and completes on the
responsible peer`. 3-node TCP mesh, `clusterSize: 1`. After full-mesh dial + FRET ring
stabilization it **probes** `entry.networkManager.getCluster` (the exact call `checkRedirect` makes)
with fresh block ids to find one whose size-1 cohort excludes the entry node E (FRET-derived, not
hard-coded). It commits the block on the responsible node R, then:
- white-box: asserts `entry.services.repo.checkRedirect(...)` returns a redirect targeting R and not E;
- black-box: drives a `RepoClient` from a third node D (≠E, ≠R, so neither hop self-dials) at E,
  and asserts the client follows the redirect to R and reads back the committed block.

It also asserts E holds no local copy, so a successful read can only have come via the redirect.

## Use cases for the reviewer to test / validate

1. **The bug class this prevents (primary):** a peer the coordinator legitimately routed a request
   to must NOT redirect it away. With the fix, that peer recomputes the *same* cohort coordinate and
   sees itself as a member → handles locally. Worth an adversarial read of the hash equivalence
   (`hashKey == sha256.encode`; coordinator and repo both `encode(...)` via `TextEncoder` utf8).
2. **Redirect actually fires + completes (round trip):** covered by the new gated integration test.
   Consider whether a `clusterSize > 1` variant (multi-member cohort, boundary peer) should also be
   exercised — see gaps.
3. **Per-op key derivation** (`get`/`pend`/`commit`/`cancel`) is unchanged and still covered by the
   `deriveBlockKey` + large-mesh keyed-NM tests in `redirect.spec.ts`.
4. **No-redirect paths:** member node, small mesh (`cluster.length < responsibilityK`), and
   missing-networkManager all still return `null` (unit tests).

## How validation was run

- `cd packages/db-p2p && yarn build` → exit 0 (stable; see note on transient failure below).
- `cd packages/db-p2p && yarn test` → **855 passing, 30 pending**, 0 failing (default suite;
  includes `redirect.spec.ts`; the integration spec self-skips without the env gate).
- Round-trip test (gated, **run and passing**, ~900 ms after boot):
  `OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
   "test/real-libp2p.integration.spec.ts" --grep "redirect round-trip" --reporter spec`
  Windows PowerShell: `$env:OPTIMYSTIC_INTEGRATION=1; yarn test:integration` (runs the whole gated
  suite — heavier; the targeted `--grep` above is faster).

## Known gaps / honest caveats (treat tests as a floor)

- **Integration test is gated** behind `OPTIMYSTIC_INTEGRATION=1`, so it is NOT in default `yarn
  test` / default CI. It was run locally and passes, but a CI lane must set the env var to cover it.
- **Only `clusterSize: 1` is exercised end-to-end.** The `targetSize` residual divergence (a
  boundary peer included by the coordinator's full `clusterSize` cohort but excluded by `getCluster`'s
  estimate-clamped cohort) is reasoned about but not tested with a real multi-member cohort. If a
  reviewer wants that covered, it needs a `clusterSize ≥ 2` mesh sized so the cohort is a proper
  subset — a candidate follow-up.
- **FRET-timing sensitivity:** the round-trip waits up to 60 s for the 3-node ring to stabilize and
  probes up to 200 block ids. It was fast and reliable in this run, but real-FRET small-N tests can
  be timing-sensitive; if it ever flakes in CI, suspect stabilization timing, not the redirect logic.
- **Deviation from the ticket's wiring suggestion** (lazy `components.libp2p` → explicit
  `setLibp2p` injection) is the main design call to sanity-check. The same latent
  `components.libp2p` unreliability likely also affects the **cluster** wrapper's
  `getSelfId`/`getConnectionAddrs` fallbacks (`cluster/service.ts`), but cluster forwards `peerId`
  eagerly so it is not currently broken; out of scope here, flagged for awareness.
- **Concurrent tree changes (not mine):** during this run another process bumped
  `p2p-fret ^0.4.0→^0.5.0` and `@quereus/quereus ^3.2.1→^4.2.0` in several `package.json`s plus
  `yarn.lock`. Mid-install, this briefly broke `tsc` with a duplicate-`@libp2p/interface` type
  clash in the unrelated `src/identity.ts`/`test/identity.spec.ts` (outside this diff); it cleared
  once `node_modules` settled and the build is now green. Per board rules these concurrent edits
  were left untouched. If a clean checkout still shows that `identity.ts` clash, it is a dependency
  issue, not this ticket.
