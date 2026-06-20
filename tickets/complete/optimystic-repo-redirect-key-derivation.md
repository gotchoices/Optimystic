description: The peer-to-peer "you're not the right node, ask these other nodes" hand-off for data requests was computing the wrong target nodes, so it had been switched off; this fixes the math and turns it back on, with a live multi-node test proving a handed-off request still completes.
files: packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts
difficulty: medium
----

# Complete: reconcile repo-path redirect key derivation + un-inert RepoService.checkRedirect

## What shipped

`RepoService.checkRedirect` (the per-request "am I responsible for this block, or should I
redirect the caller to the nodes that are?" check) was inert: the node ref it needs was never
wired in, and its key derivation double-hashed the block id, which would have placed the
responsible-set on an unrelated ring coordinate. Both are now fixed and the path is live:

- **`packages/db-p2p/src/repo/service.ts`** — `checkRedirect` passes the **raw** `encode(blockId)`
  bytes to `getCluster` (which hashes internally) instead of pre-hashing with `sha256`. The cohort
  coordinate is now `hashKey(encode(blockId))` — byte-identical to the cluster coordinator's
  `findCluster(encode(blockId))`. A `setLibp2p()` injector + `getLibp2p()` resolver were added so
  the network-manager / self-id / addr lookups resolve through an explicitly injected node.
- **`packages/db-p2p/src/libp2p-node-base.ts`** — the `repo:` service is activated by injecting the
  running node post-construction (`services.repo.setLibp2p(node)`), mirroring how `networkManager`
  and `fret` get their node refs.
- **`packages/db-p2p/test/redirect.spec.ts`** — keyed-NM helpers re-keyed onto raw `encode(blockId)`
  bytes; doubles as a regression lock against re-introducing a pre-hash.
- **`packages/db-p2p/test/real-libp2p.integration.spec.ts`** — new gated 3-node TCP round-trip
  proving a `get` dialed to a non-responsible node redirects and completes on the responsible peer.

## Review findings

### Verification performed
- **Build:** `cd packages/db-p2p && yarn build` (tsc) → exit 0.
- **Default suite:** `yarn test` → **855 passing, 30 pending, 0 failing** (includes `redirect.spec.ts`;
  the integration spec self-skips without the env gate). One logged `parent unreachable` line is a
  deliberate failure-path assertion in `host-antidos-coldstart.spec.ts`, not a failure.
- **Gated round-trip:** `OPTIMYSTIC_INTEGRATION=1 … --grep "redirect round-trip"` → **1 passing (~900ms)**.
- **Lint:** no `lint` script exists in `packages/db-p2p`; `tsc` (the `build` script) is the type/lint
  gate and is green. Stated explicitly so the empty category is not mistaken for an omission.

### Correctness — checked, sound
- **Key-derivation equivalence (the core claim):** traced both routing paths to a single ring
  coordinate. Coordinator: `cluster-coordinator.ts:88 encode(blockId) → libp2p-key-network.ts:469
  findCluster → hashKey(coord)`. Repo: `service.ts:213 encode(blockKey) → network-manager-service.ts:308
  getCluster → hashKey(coord)`, with `blockKey === blockId` from `deriveBlockKey`. Both invoke the
  **same** `hashKey`, so what `hashKey` does internally is irrelevant to the equivalence — the inputs
  are byte-identical. The pre-fix double-hash (`hashKey(sha256(encode(id)))`) is genuinely gone.
- **`getCluster` (no-force-self) vs `findCluster` (force-self) membership asymmetry:** the implementer
  chose `getCluster` deliberately so a redirect reflects FRET's genuine placement of self. Verified
  this is correct and does not bounce legitimate requests.
- **`targetSize` residual divergence — investigated, proven BENIGN.** `getCluster` clamps the cohort to
  `min(clusterSize, networkSizeEstimate)` while `findCluster` uses `clusterSize` exactly, so during a
  transient estimate-*underestimate* window (cold-start / churn, network ≥ clusterSize) a boundary peer
  could be a coordinator-member yet excluded by `getCluster`. I read FRET's `assembleCohort`
  (`p2p-fret/src/service/cohort.ts`): it is a deterministic outward succ/pred walk returning the first
  `wants` peers, so `assembleCohort(coord, k)` is a **prefix-subset** of `assembleCohort(coord, k+m)`.
  Therefore `getCluster`'s cohort ⊆ `findCluster`'s cohort — a redirect can **never** target a
  non-responsible peer. Worst case is one extra, self-healing hop while the estimate converges; the
  request still lands on a genuine cohort member (consensus is re-derived via `findCluster` regardless
  of entry node). This is lower-severity than the implement handoff's cautious framing. No correctness
  fix required; not a blocker.

### Tests — adequate, with one deferred depth gap
- **Regression coverage is real:** if someone re-introduced a pre-hash, `redirect.spec.ts`'s keyed-NM
  map (keyed on raw `encode(id)`) would miss → fall back to the self-including cluster → no redirect →
  the redirect-expecting assertions fail. Verified the failure mode locks the fix in.
- **Integration coverage gap (deferred, not blocking):** end-to-end only exercises `clusterSize:1`,
  which collapses the `targetSize` gap to a no-op. A `clusterSize ≥ 2` multi-member variant would
  exercise the divergence directly. Given the prefix-subset proof above it would *confirm benign*
  behavior rather than chase a defect, so it is filed as a low-priority backlog item
  (`optimystic-repo-redirect-multimember-coverage`) rather than fixed inline.
- The integration test is robust for what it covers: FRET-derived block selection (not hard-coded),
  fresh ids per probe iteration to dodge `getCluster`'s per-key cache, full-mesh dial + two-sided ring
  stabilization probe, a no-local-copy precondition on the entry node, and a third driver node so
  neither hop self-dials. White-box (`checkRedirect`) and black-box (`RepoClient`) assertions both fire.

### Activation wiring — sound, deviation justified
- The implement-stage deviation from the ticket's suggested lazy `components.libp2p` fallback to an
  explicit `setLibp2p` injection is correct and mirrors the established `networkManager`/`fret`
  injection pattern. The `components.libp2p` proxy is unreliable from inside a service at request time;
  the injected-node approach is strictly more robust. The repo wrapper therefore forwards only
  `{ logger, registrar, repo }` and resolves self-id / addrs from the injected node.

### Scope / awareness (no action this ticket)
- **Concurrent dependency bumps committed in the implement commit** (`p2p-fret ^0.4→^0.5`,
  `@quereus/quereus ^3.2→^4.2` across several `package.json`s + `yarn.lock`). These rode in from a
  concurrent board process; per workflow rules they were left untouched. Build + full suite are green
  on the committed tree, so not a blocker — noted for traceability only.
- **Cluster service (`cluster/service.ts`) addr backfill** still reads `components.libp2p` at request
  time for redirect-target *addresses*. It is not broken — `peerId` is forwarded eagerly so the
  membership/redirect decision fires; only target-addr backfill is best-effort (and the client resolves
  addrs via its own peer network). Flagged for awareness; out of scope here.

### Disposition
No major defects found; no minor inline fixes were necessary (the diff is clean and the documented
deviation is justified). One low-priority test-depth follow-up filed to `backlog/`. Nothing blocks
completion.
