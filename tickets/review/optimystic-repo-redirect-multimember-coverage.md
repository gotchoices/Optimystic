description: Review a new integration test proving the "wrong node, here's the right one" redirect hand-off still works when the responsible group has two members instead of one.
prereq:
files: packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Review: Multi-member cohort coverage for the repo redirect path

## What was built

A single gated integration test was **added** (purely additive — no source code changed) to
`packages/db-p2p/test/real-libp2p.integration.spec.ts`, immediately after the existing
`redirect round-trip` test and built on the same helpers (`spawnNode`, `fullMeshDial`, `waitFor`,
`pickLocalTcpMultiaddr`, the `fretOf`/`assembleCohort` two-sided stabilization probe):

> `it('redirect round-trip with a multi-member cohort: hand-off lands on a genuine cohort member and members never self-redirect', ...)`

It hardens the previously-completed `optimystic-repo-redirect-key-derivation` fix, which was only
proven at `clusterSize: 1` (single-peer responsible group). This test proves the hand-off when the
responsible group has **two** members.

### Shape (N=4, clusterSize 2)
- Spawn 4 nodes, `clusterSize: 2`, policy `{ allowDownsize: true, sizeTolerance: 1.0, superMajorityThreshold: 0.51 }`
  (the same policy the existing `three-node mesh with one peer dropped` clusterSize-2 test uses);
  bootstrap the latter three off node `a`.
- Full-mesh dial; wait `mesh.every(n => n.getPeers().length >= 3)`; run the FRET two-sided
  stabilization probe over `mesh.length` (4).
- Probe entry `E = a`'s `services.networkManager.getCluster` over **fresh** block ids
  (`mm-redirect-block-${i}`, to dodge the per-key cluster cache) until the **2-peer** cohort
  **excludes E**. The two cohort nodes are the responsible members; `E` and the one remaining
  non-member are the two non-members. Driver `D` = that remaining non-member
  (guaranteed `D !== E` and `D ∉ cohort` → neither redirect hop self-dials). These invariants are
  asserted explicitly.
- Commit the block on a responsible member `R`'s `coordinatedRepo` (pend + commit, rev 1) — a real
  2-member consensus commit.

### Assertions
- **Assertion 1 (non-member redirects & completes):**
  - white-box: `E.services.repo.checkRedirect(blockId,'get',msg)` returns a redirect whose peers
    include `R`, include **both** cohort members, exclude `E`, and have length 2;
  - precondition: neither `E` nor `D` holds the block locally (`storageRepo.get(..., {skipClusterFetch:true})` empty);
  - black-box: `RepoClient.create(E.peerId, D.keyNetwork, protocolPrefix).get(...)` returns the
    committed block (the redirect resolved to a real multi-peer cohort member).
- **Assertion 2 (every member handled locally + benign-divergence guard):** for **each** of the 2
  cohort members `M`:
  - `M.services.repo.checkRedirect(...)` returns `null` (no spurious redirect);
  - `M.services.networkManager.getCluster(encode(blockId))` includes `M` itself;
  - every id in `M`'s `getCluster` cohort is present in `M.keyNetwork.findCluster(encode(blockId))`'s
    cohort (the live `getCluster ⊆ findCluster` prefix-subset / benign-divergence guard).

## Why this is correct (verified during implementation, for the reviewer)

- **`responsibilityK` defaults to 1** (`service.ts:93`), and `spawnNode` never overrides it, so the
  redirect check `smallMesh = cluster.length < responsibilityK` is `len < 1` → always false for a
  non-empty cohort. A 2-member cohort therefore drives the **same** redirect/no-redirect branches as
  the size-1 test. No `responsibilityK` override was needed (matches the ticket's key fact).
- **Both cohort members hold the block after a clusterSize-2 commit.** `commitTransaction`
  broadcasts the merged commit record to **all** peers and `await`s completion before
  `executeClusterTransaction` (hence `coordinatedRepo.commit`) resolves
  (`cluster-coordinator.ts:526-553`, `broadcastMergedRecord`). So by the time the commit returns,
  each member has executed the op into its own local storage. The redirected `get` runs with
  `skipClusterFetch: true` (`service.ts:259`) and is served locally on **whichever** member the
  client lands on. This is the linchpin: the `RepoClient` picks `peers.find(p => p.id !== self)`
  i.e. effectively `peers[0]` (`client.ts:88`), which is the first cohort member in cohort order —
  **not necessarily** the commit coordinator `R`. The test does not assume which member is hit; it
  works because both hold the block.

## How to validate

From `packages/db-p2p`:

**Gated run (the test executes):**
```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/real-libp2p.integration.spec.ts" --reporter spec --grep "multi-member"
```
**Ungated run (the test must be skipped):**
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/real-libp2p.integration.spec.ts" --reporter spec --grep "multi-member"
```

> ⚠ **Windows note:** the `test:integration` npm script in `package.json` uses a bash-style inline
> env prefix (`OPTIMYSTIC_INTEGRATION=1 node ...`) that does **not** work under Windows `cmd.exe`
> (which npm uses to run scripts on Windows). I ran mocha directly with the env var set instead. On
> POSIX, `npm run test:integration --workspace @optimystic/db-p2p` works as written in the ticket.

### Results observed during implementation
- Gated, new test only: **passing**, ran 3× consecutively → 912ms / 1s / 2s (stable; some timing
  variance as expected for a real-FRET small-N ring, well within the `this.timeout(90_000)` budget).
- Full `real-libp2p.integration.spec.ts` gated: **7 passing** (solo×2, two-node, three-node-dropped,
  cold-restart, redirect round-trip, multi-member). No regression — the change is additive.
- Ungated: the new test reports **pending** (skipped by the file's `before()` gate). `0 passing, 1 pending`.
- Type-check: see the type-check caveat below — **0 errors** when types resolve correctly.

## Known gaps / things for the reviewer to scrutinize (honest floor, not a finish line)

1. **Stabilized-ring divergence is trivial, by design.** In a stabilized 4-node ring the FRET
   estimate is ≥ 2, so `getCluster`'s `targetSize = min(clusterSize, estimate) = 2` — no clamping.
   That means `getCluster`'s cohort **equals** `findCluster`'s cohort here, so the
   `getCluster ⊆ findCluster` assertion is a *guard that the invariant holds*, **not** an exercise
   of the actual underestimate/clamp window where the two genuinely differ. The source plan's
   optional "deliberately drive the estimate-lag window" case was **deferred out of scope**: there
   is no clean test seam to force FRET to underestimate in a stabilized ring
   (`getDiagnostics().estimate` is read-only, FRET-internal). If a seam is later added to FRET, a
   follow-up `backlog/` ticket should add that case. The reviewer may judge whether the prose
   reasoning (assembleCohort prefix-subset property) plus this invariant guard is sufficient
   coverage, or whether a contrived churn-based variant is worth the flakiness risk.

2. **Type-check tooling caveat.** Running `tsc` standalone against `packages/db-p2p/tsconfig.json`
   emits ~1800 spurious errors (`Cannot find name 'it'/'describe'/'setTimeout'/'TextEncoder'/'process'`,
   implicit-`this`) that hit **every** test file identically (including pre-existing ones) — an
   ambient-global auto-inclusion quirk, not real errors. It also trips TS5101 (`downlevelIteration`
   deprecation) at the config level. A clean type-check is:
   ```
   npx tsc --noEmit --ignoreDeprecations 6.0 --types node,mocha,chai --lib ES2022,DOM -p tsconfig.json
   ```
   → **0 errors** (whole package). Note also that the mocha runtime uses **Node experimental type
   stripping** (types stripped, *not* checked) — so the test run alone does not type-check; rely on
   the `tsc` invocation above. The reviewer may want to confirm whether the repo's CI type-checks
   this package cleanly, since the standalone invocation is noisy.

3. **Probe bound.** The block-selection loop is bounded at 200 fresh ids with
   `expect(chosen).to.exist`, so a regression in cohort derivation fails loudly rather than hanging.
   With clusterSize 2 over 4 nodes ~½ of blocks exclude a fixed entry, so a hit is found in the
   first few iterations in practice.

4. **Assertion strength on the redirect target.** Per the ticket, assertions use set membership
   (`include` / `not.include`) and `length === 2`, never positional identity, to stay robust to
   cohort-ordering nondeterminism. Worth a sanity check that no positional assumption crept in.

## Scope confirmation
- No production source changed — test-only addition.
- No `tickets/.pre-existing-error.md` written: the full suite is green; nothing pre-existing failed.
