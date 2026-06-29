description: A write's helper group is no longer built from nodes that were never confirmed to belong to this database, so a write can't fail by accidentally pulling in a node from a different database that happens to share the same machines.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (findCluster — membership-scoping block, ~lines 565-611)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe 'network-membership scoping (protocolPrefix)')
  - packages/db-p2p/docs/cluster.md (Network-Membership Scoping note, ~line 619)
difficulty: medium
----

# Complete: `findCluster` no longer backfills `unknown` (possibly cross-network) peers into a write cohort

## Summary of the implemented change (verified)

When two Optimystic networks run coordinator-eligible nodes over a shared mesh, a peer from the
*other* network can land in this network's FRET routing ring. Its network-namespaced `identify` never
completes here, so its peerStore protocol list stays empty — classified `unknown`, indistinguishable
from a fresh same-network peer mid-`identify`. The old `findCluster` backfilled `unknown` peers to meet
a viability floor of `min(2, clusterSize)`; in the self-is-sole-server case this pulled a cross-network
peer into the cohort, whose `/optimystic/<other-network>/repo/1.0.0` dial could not negotiate, sinking
the write with a super-majority failure.

The fix (contained to `findCluster`, `libp2p-key-network.ts:578-611`): drop the `unknown` backfill
entirely. The cohort is now `self + (serves, nearest-first, capped at clusterSize-1)`. No `unknown`
peer is ever admitted. `findCoordinator` is untouched (it still ranks `serves` ahead of `unknown` and
retries; the coordinator-side hole is the sibling ticket `cross-network-coordinator-no-unknown-fallback`).

## Review findings

### What was checked

- **Implement diff read first, fresh** (`git show 8e521b9`): source, test, and docs changes.
- **Correctness of the cohort-composition logic** (`findCluster` membership block, `libp2p-key-network.ts:578-611`)
  and the surrounding classification (`membershipOf`, `filterByMembership`, `membershipOverfetch`).
- **The load-bearing safety claim** the implementer flagged: that a same-network peer's repo/cluster
  dial succeeds *before* its `identify` completes, so dropping `unknown` peers (and waiting for the
  caller's retry) does not permanently starve a legitimately-joining peer.
- **Edge cases**: `clusterSize == 1`, self-only cohort, `serves` present, `foreign` contaminant,
  `protocolPrefix` absent (filter disabled).
- **Docs**: `cluster.md` Network-Membership Scoping note, and every comment the diff touched.
- **Lint/type/tests**: ran the membership-scoping describe block and the full `@optimystic/db-p2p` suite.

### Correctness — confirmed sound

The change is correct and minimal. The load-bearing safety claim holds at the libp2p level: the write
path dials via `RepoClient.create` → `dialProtocol`, which runs multistream-select to negotiate the
protocol directly on a fresh stream, **independent of `identify`** (`identify` only asynchronously
populates the peerStore protocol list). So a same-network peer mid-`identify` is dialable and is
re-admitted as `serves` on the caller's retry once `identify` lands; a cross-network peer's dial fails
because the remote genuinely does not speak this network's protocol. Dropping `unknown` is therefore
the correct conservative choice when the two are indistinguishable — it trades a temporary
self-downsized cohort (which completes under the default `allowClusterDownsize`) for never admitting a
contaminant. No major findings; **no new fix/plan tickets filed.**

### Minor findings — all fixed inline in this pass

- **Stale "viability floor" references in tests.** The removed concept lingered in an inline comment
  (`"clusterSize 2 → floor min(2,2)=2 …"`) and a test name (`"… even below the viability floor"`).
  Rewrote both to describe the new self-only / serves-only behavior.
- **`describe`-block header comment** (the implementer flagged this as worth a second opinion) said
  "only fall back to 'unknown' when nothing serving exists" without scoping it. Split it per-function:
  `findCoordinator` falls back to `unknown`; `findCluster` never does.
- **`clusterSize == 1` coverage gap** (noted as unasserted in the handoff). Added a dedicated test:
  with `clusterSize 1`, `nonSelfTarget == 0`, so the cohort is self-only even when a positively-serving
  peer sits nearer the key. Closes the gap by assertion rather than by construction alone.

### Findings deliberately NOT actioned (with reasons)

- **No major (new-ticket) findings.** The logic, types, resource handling (no new resources; classify
  loop and over-fetch unchanged), and error paths are all correct and in-scope. The category is empty
  because the change is genuinely small and correct, not because review was shallow.
- **Mock-only coverage of the safety claim is acceptable here.** All `findCluster` tests drive a mock
  libp2p + mock peerStore and prove cohort *composition*, not real multistream-select-before-identify
  dial behavior. Verifying the latter needs a real libp2p stack (an integration/e2e concern), and the
  claim is sound by libp2p's documented `dialProtocol` semantics. Not worth a blocking ticket; flagged
  for whoever owns the cross-network e2e harness (the originating Sereus repro lives outside this repo).
- **`downsize: false` self-only rejection is out of scope and not a regression.** When
  `allowClusterDownsize` is false and a fresh same-network mesh is mid-`identify`, a self-only cohort is
  rejected by `minRequiredSize`. The fail-fast signal for that path is the sibling ticket
  `cross-network-coordinator-no-unknown-fallback`, not this one. This ticket fully fixes the default
  `downsize: true` config — the observed Sereus case.
- **Pre-existing, unrelated: `npx tsc --noEmit` in `packages/db-p2p` fails** with
  `tsconfig.json(19,3): error TS5101: Option 'downlevelIteration' is deprecated`. This is a toolchain
  config deprecation in a file this ticket never touched; it reproduces on a clean tree and reports no
  errors against `libp2p-key-network.ts`. The package's `test` script uses Node type-stripping (not
  `tsc`) and passes. Not filed as `.pre-existing-error.md` because it is a build-config deprecation, not
  a test failure — flagged here so CI/a human can address the config separately.

### Validation results

- Membership-scoping describe block: **11 passing** (was 10; added the `clusterSize == 1` test).
- Full `@optimystic/db-p2p` suite: **1056 passing, 37 pending, 0 failing** (~39s). The
  `cohort-topic cold-start: parent registration … failed` console line is a deliberately-logged error
  inside a passing error-path test, not a failure.

Run command (from `packages/db-p2p`):
```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/libp2p-key-network.spec.ts" \
  --reporter spec --grep "network-membership scoping"
# whole package:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min
```

## Acceptance (all met under default `downsize: true` config)

- ✅ Two-network shared-mesh write where the writer is the only serving peer reaches a self-only cohort;
  never a `could not negotiate /optimystic/<other-network>/repo/1.0.0` super-majority failure
  (cohort-composition tests; full e2e dial owned out-of-repo).
- ✅ Fresh same-network peer still admitted as `serves` on a later write once `identify` completes;
  single-network behavior and the `protocolPrefix`-absent no-op path unchanged.
- ✅ `@optimystic/db-p2p` suite passes, including the rewritten, added, and new `clusterSize == 1` tests.
