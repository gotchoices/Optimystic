description: Add a multi-node integration test proving the "you're not the right node" hand-off still works when the responsible group has more than one member, not just one.
prereq:
files: packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-key-network.ts
difficulty: medium
----

# Multi-member cohort coverage for the repo redirect path

## Why

The repo-redirect key-derivation fix (`optimystic-repo-redirect-key-derivation`, completed) is
proven end-to-end only with `clusterSize: 1` (the `redirect round-trip` test in
`real-libp2p.integration.spec.ts`). At size 1 the responsible group is a single peer, so the test
never exercises a request landing on one member of a **multi-peer** responsible group. This ticket
adds that coverage. It is hardening / defense-in-depth, not a bug hunt — keep it low priority.

## Background — the two responsibility code paths (already verified, included for the implementer)

Two code paths decide responsibility, and they diverge benignly:

- The cluster coordinator's `findCluster(encode(blockId))` assembles a cohort of exactly
  `clusterSize` peers (`libp2p-key-network.ts:466-520`; note it then *adds self*, so the
  coordinator view can be `cohort ∪ {self}`).
- The redirect check's `getCluster(encode(blockId))` clamps the cohort to
  `max(1, min(clusterSize, networkSizeEstimate))` (`network-manager-service.ts:311`).

During a transient window where FRET's network-size estimate **underestimates** (cold-start /
churn, in a network with at least `clusterSize` peers), `getCluster` returns a smaller cohort than
`findCluster`. A boundary peer ranked between the estimate and `clusterSize` would then be a
coordinator-recognised member yet excluded by its own redirect check. This is **benign**: FRET's
`assembleCohort(coord, wants)` is a deterministic outward walk returning the first `wants` peers, so
`assembleCohort(coord, k)` is a prefix-subset of `assembleCohort(coord, k+m)`. Hence `getCluster`'s
cohort is always a subset of `findCluster`'s — a redirect can never point at a non-responsible peer;
the worst case is one extra, self-healing hop while the estimate converges (well within the client's
max-2-hop budget, `client.ts:84`).

## Key facts that fix the test shape (verified during planning — do not re-derive)

- **`responsibilityK` is independent of `clusterSize` and defaults to 1**
  (`libp2p-node-base.ts:153,377,403`). `spawnNode` in the integration spec does not set it, so the
  redirect check `smallMesh = cluster.length < this.responsibilityK` (`service.ts:221`) is
  `cohort.length < 1` → always false for a non-empty cohort. **Therefore no `responsibilityK`
  override is needed**: a `clusterSize: 2` cohort drives the exact same redirect / no-redirect
  branches as the existing size-1 test. A non-member (cohort excludes self) redirects; any cohort
  member handles locally.

- **Self-dial avoidance dictates the mesh size.** `checkRedirect` returns the cohort minus self
  (`service.ts:224`). The `RepoClient` picks `peers.find(p => p.id !== this.peerId)` i.e. effectively
  `peers[0]`, then re-dials that target **through the driver's `keyNetwork`** (`client.ts:88-99`).
  For a 2-member cohort, the only way to guarantee neither hop is a self-dial is for the driver to be
  a node that is **neither the entry nor any cohort member**. With a 2-member cohort that needs a
  4th node:

  - **Use N=4 nodes, `clusterSize: 2`.** Then the FRET cohort for a probed block is a *proper
    subset* of membership: 2 members + 2 non-members. Entry `E` = one non-member; driver `D` = the
    *other* non-member (guaranteed `D ≠ E` and `D ∉ cohort`, so neither hop self-dials, mirroring the
    existing test's "distinct driver node" invariant).

- **`clusterSize: 2` commits require consensus across the cohort**, unlike the size-1 self-bypass
  fast path. Spawn nodes with `clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0,
  superMajorityThreshold: 0.51 }` (the same policy the existing `three-node mesh with one peer
  dropped` test at `clusterSize: 2` uses). Commit the block on the responsible node `R`'s
  `coordinatedRepo`; R coordinates the 2-member quorum and must end up holding the block in its own
  storage so the redirected `get` (which runs with `skipClusterFetch: true`, `service.ts:259`) serves
  it locally.

## What to build

One gated integration test added to `real-libp2p.integration.spec.ts`, alongside the existing
`redirect round-trip` test, following that test as the structural template:

- spawn N=4 nodes, `clusterSize: 2`, full-mesh dial + the two-sided FRET stabilization probe
  (`waitFor` over `assembleCohort(probeCoord, mesh.length)` agreeing on every node);
- probe entry `E`'s `getCluster` over fresh ids (to dodge the per-key cluster cache) for a block
  whose 2-peer cohort **excludes E**; pick `responsible R` = a cohort member, `driver D` = the
  non-member that is neither E nor in the cohort;
- commit the block on `R`'s `coordinatedRepo`;
- **Assertion 1 (non-member redirects & completes):** white-box, `E.services.repo.checkRedirect`
  returns a redirect whose peers include `R` and exclude `E`; then black-box, a `RepoClient` created
  with `E.peerId` + `D`'s `keyNetwork` `get`s the block and receives it (the redirect resolved to a
  multi-peer cohort member);
- **Assertion 2 (member handled locally, incl. boundary rank):** for **each** of the 2 cohort
  members `M`, `M.services.repo.checkRedirect(blockId, 'get', probeMsg)` returns `null` (no spurious
  redirect). Confirm the prefix-subset / benign-divergence property holds live: each member's own
  `getCluster(encode(blockId))` includes itself, and `getCluster`'s cohort ⊆ the coordinator's
  `findCluster(encode(blockId))` cohort.

Gate behind `OPTIMYSTIC_INTEGRATION=1` (the file's `before()` hook already does this). Budget
generous stabilization timeouts (`this.timeout(90_000)` like the existing redirect test); real-FRET
small-N rings are timing-sensitive.

Expected outcome: a passing test confirming the divergence is benign in a real multi-member ring and
the hand-off lands on a genuine cohort member.

## Edge cases & interactions

- **Self-dial on either hop** — the core reason for N=4. If the implementer is tempted to use N=3,
  the driver would have to be a cohort member, and whether the redirect's `peers[0]` equals that
  driver is nondeterministic w.r.t. cohort ordering → intermittent self-dial on hop 2. Stick to N=4
  with a non-member driver. Assert `driver !== entry` and `driver ∉ cohort` explicitly so a future
  refactor can't silently reintroduce the hazard.
- **Per-key cluster cache** (`network-manager-service.ts:294-298`) — use a *fresh* block id per probe
  iteration, exactly as the existing test does, so a pre-stabilization cohort is never served.
- **FRET estimate clamp at the boundary** — in a stabilized 4-node ring the estimate should be ≥ 2,
  so `getCluster` returns the full `clusterSize`-2 cohort with no clamping. The benign-divergence
  assertion (getCluster ⊆ findCluster) should hold trivially here; assert it anyway as the live
  regression guard.
- **`clusterSize: 2` consensus commit** — the commit on `R` must reach the other cohort member; the
  full mesh + stabilization probe should ensure connectivity, but if commit flakes, confirm both
  cohort members are connected before committing (the existing `waitFor(... getPeers().length >= 3)`
  pattern, adjusted for N=4).
- **Probe exhaustion** — loop a bounded number of fresh ids (the existing test uses 200). With
  `clusterSize: 2` over 4 nodes the fraction of blocks whose cohort excludes a fixed entry is ~1/2,
  so a hit is found quickly; keep the bound and `expect(chosen).to.exist` so a regression in cohort
  derivation fails loudly rather than hanging.
- **Cohort ordering nondeterminism** — do not assume which member is `peers[0]`; assert on set
  membership (`include` / `not.include`), never on positional identity, when checking the redirect
  target.
- **Driver/entry must not hold the block locally before the read** — replicate the existing test's
  precondition check (`entry.storageRepo.get({...}, { skipClusterFetch: true })` is empty) so a
  successful client read can only have come from following the redirect.

## TODO

### Phase 1 — test scaffolding
- Add a new `it(...)` to `real-libp2p.integration.spec.ts` after the `redirect round-trip` test,
  reusing `spawnNode`, `fullMeshDial`, `waitFor`, `pickLocalTcpMultiaddr`, and the `fretOf` /
  `assembleCohort` stabilization probe helpers already in the file.
- Spawn 4 nodes with `clusterSize: 2` and `clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0,
  superMajorityThreshold: 0.51 }`; bootstrap the latter three off node `a`.
- Full-mesh dial; wait for `mesh.every(n => n.getPeers().length >= 3)`; run the two-sided FRET
  stabilization probe over `mesh.length`.

### Phase 2 — block selection & commit
- Probe `entry = a`'s `getCluster` over fresh ids until the 2-peer cohort excludes `a`.
- Set `responsible R` = a cohort member; `driver D` = the mesh node that is neither `entry` nor in the
  cohort. Assert `D !== entry` and `D` is not in the cohort.
- Commit the block on `R.coordinatedRepo` (pend + commit, `rev: 1`).

### Phase 3 — assertions
- Assertion 1: `E.services.repo.checkRedirect` includes `R`, excludes `E`; precondition that `E`
  holds no local copy; then `RepoClient.create(E.peerId, D.keyNetwork, protocolPrefix).get(...)`
  returns the committed block.
- Assertion 2: for each cohort member `M`, `M.services.repo.checkRedirect(...)` is `null`; each
  member's `getCluster(encode(blockId))` includes itself; `getCluster` cohort ⊆ `findCluster` cohort
  (use `M.keyNetwork.findCluster(encode(blockId))` or `services.networkManager` as available — verify
  the accessor on the node object during implementation).

### Phase 4 — validate
- Type-check and run the gated suite locally, streaming output:
  `OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p 2>&1 | tee /tmp/mm-redirect.log`
  (PowerShell: `$env:OPTIMYSTIC_INTEGRATION=1; npm run test:integration --workspace @optimystic/db-p2p`).
  Also confirm the default (ungated) test run still skips it.

### Deferred (out of scope — do NOT block this ticket on it)
- The optional "deliberately drive the estimate-lag window to assert the extra-hop path resolves
  within the max-2-hop budget" case from the source plan: there is **no clean test seam** to force
  FRET to underestimate in a stabilized ring (`getDiagnostics().estimate` is read-only, set by FRET
  internals). Attempting it would require a FRET-internal mock or a contrived churn sequence whose
  timing is unreliable at small N. Leave it out; the prefix-subset assertion above already proves the
  divergence is benign. If a seam is later added to FRET, file a follow-up `backlog/` ticket then.
