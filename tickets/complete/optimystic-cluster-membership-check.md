description: (COMPLETE) Restored cluster membership/responsibility scoping on the ClusterService update path via record.peers-authoritative redirect; reconciled dead init knobs.
files: packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/redirect.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts
----

# Complete: re-enable cluster membership/responsibility scoping on the update path

## Summary of what shipped (implement commit `1b2a415`)

- `ClusterService.checkRedirect(record): RedirectPayload | null` (public, unit-testable)
  scopes membership against **`record.peers`** — the authoritative set the coordinator
  already computed and embedded — rather than independently recomputing the cluster from
  the key. Returns `null` (process locally) when there is no self peerId, `record.peers`
  is empty, self is a member, or the peer set is smaller than `responsibilityK`
  (small-mesh bypass). Returns `encodePeers(others)` (`reason: 'not_in_cluster'`,
  reusing `repo/redirect.ts`) otherwise.
- Update path replaced the `TEMPORARY` unconditional `cluster.update` with
  `const redirect = this.checkRedirect(record); response = redirect ?? await this.cluster.update(record)`.
  Verbose pre/post-serialize debug logging removed.
- `responsibilityK` is now live (read in the constructor, used for the small-mesh bypass).
- Dead `ClusterServiceInit` knobs removed: `kBucketSize`, `configuredClusterSize`,
  `allowClusterDownsize`, `clusterSizeTolerance`.
- `ClusterServiceComponents` gained optional `peerId` and `getConnectionAddrs`, wired in
  `libp2p-node-base.ts`.
- New spec `test/cluster-service-redirect.spec.ts` (9 cases).

## Review findings

### What was checked

- **Central design claim — `record.peers` is authoritative.** VERIFIED against
  `repo/cluster-coordinator.ts`: every peer the coordinator dials is taken from
  `Object.keys(record.peers)` — `collectPromises` (line 357), `commitTransaction`
  (line 444/458), `broadcastMergedRecord` (`peerIds = Object.keys(record.peers)`,
  line 538), and `retryCommits` (pendingPeers ⊆ record.peers). The coordinator's own
  node executes via the in-process `localCluster.update`, bypassing the service/redirect
  entirely. So any peer that reaches `ClusterService.checkRedirect` over the wire is, by
  construction, a member of `record.peers` and is never redirected. This is exactly what
  avoids the original "empty promises" regression (the old gate recomputed the cohort via
  `getCluster` and redirected legitimately-dialed peers).
- **Redirect-following client.** VERIFIED `ClusterClient.update` (cluster/client.ts):
  follows `response.redirect.peers`, hop limit ≥ 2 throws, same-peer loop detection,
  excludes self. The redirect payload shape (`{ redirect: { peers, reason } }`) matches
  what `checkRedirect` returns and what the client reads. No client-side change needed.
- **Type safety.** VERIFIED `ClusterRecord.peers: ClusterPeers` keyed by
  `peerId.toString()` with `{ multiaddrs: string[], publicKey }`; `checkRedirect` reads
  `peers[id]?.multiaddrs ?? []`. Self-membership uses `peerIds.includes(selfId.toString())`
  — both sides use the canonical `.toString()` form (consistent with how the coordinator
  keys the map). `tsc` clean.
- **Dead-knob removal.** VERIFIED no dangling references to the removed `ClusterServiceInit`
  fields. The remaining `allowClusterDownsize`/`clusterSizeTolerance` references across the
  codebase belong to the separate `ClusterConsensusConfig` path (NetworkManagerService,
  coordinator-repo, mesh-harness, cluster-coordinator), which is unchanged and correct.
- **Docs.** Read `docs/cluster.md` and `docs/repo.md`. The removed knobs were never
  documented as cluster-*service* options (the doc's config tables are the consensus
  config). `cluster.md:617` ("Only peers returned by findCluster() participate in
  consensus") remains accurate. No stale doc content from this change.
- **Build + tests.** `yarn build` (tsc) exit 0. `yarn test` → **483 passing, 7 pending,
  0 failing** (~20s). The 7 pending are pre-existing env-gated cases. New
  `cluster-service-redirect.spec.ts` passes. No pre-existing failures surfaced.

### What was found

- **Minor (fixed inline):** the shared `responsibilityK` option doc-comment in
  `libp2p-node-base.ts` (CreateLibp2pNodeBaseOptions) described only the repo-path
  XOR-distance semantics; it did not reflect the cluster path's new small-mesh-bypass
  use of the same knob. **Fixed** in this review pass — the comment now describes both
  paths. (Comment-only; `tsc` re-verified clean.)

- **Observation (not a defect):** In the normal coordinator-driven flow the cluster
  `checkRedirect` gate **never fires**, precisely because the coordinator only ever dials
  members of `record.peers`. The restored gate is therefore *defensive* — it guards only
  against a buggy/malicious sender dialing a non-member — rather than an active router.
  This is the correct and intended outcome: any scenario where the embedded `record.peers`
  and a peer's independently-recomputed cohort diverge must resolve in favor of the
  coordinator's set, which is exactly what trusting `record.peers` does. The implementer's
  handoff was honest about this. No change.

- **Observation (not a defect):** `getSelfId()`/`getPeerAddrs()` retain a
  `(this.components as any).libp2p` fallback that is dead in the real wiring (peerId and
  getConnectionAddrs are always passed). It mirrors the identical pattern in
  `RepoService`, is purely a safety net, and is harmless. Left as-is for consistency.

- **Major (filed as follow-up, NOT fixed here):** the repo wrapper in `libp2p-node-base.ts`
  was deliberately left inert (peerId/networkManager not forwarded), so
  `RepoService.checkRedirect` does not redirect. VERIFIED the deferral rationale:
  `RepoService.checkRedirect` (repo/service.ts:143) derives the responsible set via
  `getCluster(sha256(blockKey))` — an extra sha256 over the raw bytes — whereas the
  coordinator forms the cluster via `findCluster(encode(blockId))` on raw bytes (no
  sha256, cluster-coordinator.ts:88-90). These coordinates differ, so activating the repo
  redirect without reconciling them would re-introduce the same divergence class as the
  empty-promises regression. The repo path was inert before this ticket and remains
  unchanged (no behavior change; the existing `test/redirect.spec.ts` exercises the logic
  in isolation only). Reconciling and activating it is its own unit of work →
  **`backlog/optimystic-repo-redirect-key-derivation`**.

### Net disposition

- Minor doc inaccuracy: **fixed inline.**
- Repo-path reconciliation: **deferred to a new backlog ticket** (latent, not an active
  bug — the path is inert today).
- No empty categories silently dropped: correctness, type-safety, error handling,
  resource cleanup (stream close/abort unchanged), and regression coverage were all
  reviewed; the only actionable items are the two above.
