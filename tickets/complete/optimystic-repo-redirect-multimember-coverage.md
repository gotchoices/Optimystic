description: A new integration test proves the "wrong node, here's the right one" redirect hand-off still works when the responsible group has two members instead of one. Reviewed and accepted.
prereq:
files: packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Complete: Multi-member cohort coverage for the repo redirect path

## What shipped

A single gated integration test was **added** (purely additive — no source changed) to
`packages/db-p2p/test/real-libp2p.integration.spec.ts`, after the existing `redirect round-trip`
test and built on the same helpers:

> `it('redirect round-trip with a multi-member cohort: hand-off lands on a genuine cohort member and members never self-redirect', ...)`

It hardens the `optimystic-repo-redirect-key-derivation` fix (previously only proven at
`clusterSize: 1`) by exercising the redirect hand-off when the responsible group has **two** members
(N=4, clusterSize 2). It proves: (1) a `get` dialed to a non-member entry E redirects to the 2-peer
cohort and the `RepoClient` follows it to a genuine cohort member that serves the committed block
(the commit reached both members via cluster consensus); (2) each cohort member handles the same
redirect question locally (no spurious redirect) and the live `getCluster ⊆ findCluster`
prefix-subset / benign-divergence invariant holds.

## How to validate

From `packages/db-p2p`:
- **Gated (executes):** `OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/real-libp2p.integration.spec.ts" --reporter spec --grep "multi-member"`
- **Ungated (skips):** same command without the env var → `0 passing, 1 pending`.

> Windows note (carried from implement): the `test:integration` npm script uses a bash-style inline
> env prefix that does not work under Windows `cmd.exe`. Run mocha directly with `$env:OPTIMYSTIC_INTEGRATION=1`
> (PowerShell) or use the env-prefixed form under git-bash, as above.

## Review findings

Adversarial pass over the implement-stage diff (commit `93e4d03`, test-only). Read the diff and the
full test file with fresh eyes, then verified every load-bearing source claim against the code.

### Source-claim verification (all confirmed against HEAD)
- **`checkRedirect` contract** (`repo/service.ts:202-233`): signature `(blockKey, opName, message)`,
  returns `RedirectPayload | null`; redirects only when `!smallMesh && !isMember`, with
  `peers = cluster.filter(p => !peersEqual(p, self))`. The test's `decision.redirect.peers` shape
  matches `redirect.ts`. ✓
- **`responsibilityK` defaults to 1** (`repo/service.ts:93`), never overridden by `spawnNode`, so
  `smallMesh = cluster.length < 1` is always false for a non-empty cohort → a 2-member cohort drives
  the same redirect / no-redirect branches as the size-1 test. ✓ (matches the ticket's key fact)
- **`getCluster` clamps to `min(clusterSize, estimate)`** (`network/network-manager-service.ts:311`):
  in a stabilized 4-node ring `estimate ≥ 2`, so `targetSize = 2` and `getCluster` returns exactly 2.
- **`findCluster` uses `assembleCohort(coord, clusterSize)` then unions in `selfId`**
  (`libp2p-key-network.ts:470-476`). For a cohort member M this yields the 2-member cohort ∪ {M} =
  the 2-member cohort, so `getCluster(M) ⊆ findCluster(M)` is **trivially** true — exactly as the
  implementer honestly flagged in "Known gaps #1". The "real 2-member consensus" claim is also
  accurate: `responsible ∈ cohort` ⇒ its `findCluster` is the 2-member set ⇒ `getClusterSize` = 2.
- **Client redirect-follow** (`repo/client.ts:88`): `peers.find(p => p.id !== self) ?? peers[0]`;
  with the client's own peerId = E (a non-member), it lands on the redirect's `peers[0]` (E's
  cohort-order first member). The test commits on `members[0]` in **mesh** order, which need not be
  the member the client lands on — but this is safe (see linchpin). ✓
- **Linchpin — both members hold the block before `commit` returns:** `commitTransaction` calls
  `await broadcastMergedRecord(...)` (`repo/cluster-coordinator.ts:538`); `broadcastMergedRecord`
  awaits each member's `update()` (`cluster/cluster-repo.ts:243`), which awaits `handleConsensus`
  (execution into local storage) at `cluster-repo.ts:343/357`. So by the time `coordinatedRepo.commit`
  resolves, **both** members have executed the op locally. The redirected `get` runs with
  `skipClusterFetch: true` (`service.ts:259`) and is served locally on whichever member the client
  hits — which is why the test's mesh-order-vs-cohort-order asymmetry on `responsible` is harmless. ✓

### Aspect scrutiny
- **Correctness / SPP / DRY:** Test reuses `spawnNode`, `fullMeshDial`, `waitFor`, `pickLocalTcpMultiaddr`
  and the FRET two-sided stabilization probe — consistent with the size-1 test. Assertions use set
  membership (`include`/`not.include`) and `length === 2`, never positional identity, so they are
  robust to cohort-ordering nondeterminism (confirmed — no positional assumption crept in).
- **Edge / error / self-dial:** Explicit guards assert `driver !== entry`, `driver ∉ cohort`, and
  `cohort.length === 2`, so neither redirect hop self-dials and a future refactor can't silently
  reintroduce the hazard. Both non-member preconditions (`entry`/`driver` hold no local copy) are asserted.
- **Robustness / bounded:** Block-selection loop is bounded at 200 fresh ids with
  `expect(chosen).to.exist`; FRET stabilization wait is bounded at 60s with an explicit assert — a
  regression fails loudly, never hangs (well within `this.timeout(90_000)`).
- **Resource cleanup:** All 4 nodes are registered via `spawnNode` and torn down by the file's
  `afterEach` (`Promise.allSettled(... n.stop())`). ✓

### Checks run
- **Gated test (new only):** passing, **5 consecutive runs** observed stable (732ms / 913ms / 938ms /
  ~1s / 981ms). No flakiness surfaced.
- **Full `real-libp2p.integration.spec.ts` (gated):** **7 passing**, no regression (additive change).
- **Ungated:** the new test reports **pending** (`0 passing, 1 pending`) — the `before()` gate skips it.
- **Lint:** repo-wide `lint` script is a no-op echo and there is no eslint config — nothing to run.
- **Type-check:** **clean (0 errors)** for the package under proper lib/types resolution. (Detail
  below.)
- **Docs:** no doc/README enumerates the individual integration tests; the test is self-documenting
  via its `describe`/`it` names and header comment. Nothing to update.

### Findings & disposition
- **Major:** none. No new tickets filed.
- **Minor (fixed in pass):** none required — the test was already correct, type-clean, and stable.
- **Minor (noted, not actioned):** the 2-line `fretOf` helper is defined inline in **both** redirect
  tests rather than hoisted to module scope — a trivial, pre-existing-style duplication that keeps
  each test self-contained. Not worth churn (hoisting would also touch the unrelated size-1 test).

### Type-check / toolchain note (resolved — not a defect)
The implement handoff worried that standalone `tsc` emits ~1800 "Cannot find name `it`/`setTimeout`/
`TextEncoder`/`Buffer`…" errors and trips `TS5101 (downlevelIteration deprecated)`. Root cause found:
the repo **declares** `typescript: "^5.9.3"` but this environment resolved **6.0.3**.
`downlevelIteration`'s `TS5101` deprecation only fires on TS ≥ 6.0; plain `tsc -p tsconfig.json`
aborts at that config-level error *before* type-checking files (hence the "only 1 error" reading),
and the global-resolution noise only appears once the deprecation is force-silenced on the CLI under
6.0.3. Under the **declared** TS 5.9.3 the package builds cleanly and globals auto-resolve. The
implementer's `npx tsc --noEmit --ignoreDeprecations 6.0 --types node,mocha,chai --lib ES2022,DOM -p
tsconfig.json` reproduces **0 errors**. `tsconfig.json` is untouched by this commit (verified via
`git diff HEAD~1 HEAD`). Conclusion: a local-toolchain artifact, pre-existing and orthogonal to this
test-only change — no fix needed and no `tickets/.pre-existing-error.md` written (all tests pass; this
is not a test failure).

## Scope confirmation
- No production source changed — test-only addition.
- No `tickets/.pre-existing-error.md`: the full suite is green; the type-check is clean under the
  repo's declared TypeScript.
