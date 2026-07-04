description: Reviewed two db-p2p cluster fixes — the undersized-cluster safety gate now refuses too-small clusters by default, and a duplicate peer-directory lookup on the write path was collapsed into one. Both verified correct; one misleading log line fixed inline.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/cluster-coordinator.spec.ts
----

# Complete: validateSmallCluster fails closed + single peerStore read

Two unrelated db-p2p cluster fixes reviewed together. Both build clean, typecheck,
and pass tests. One minor observability defect found and fixed inline. No major
findings; no new tickets.

## Fix (a) — undersized-cluster gate now fails closed

`ClusterCoordinator.validateSmallCluster` used to `return true` when FRET had no
confident network-size estimate — the normal state on a young/churning network —
so it failed **open** exactly when it should fail closed. Fixed: new config flag
`allowUnvalidatedSmallCluster` (default `false`), fallback returns
`this.cfg.allowUnvalidatedSmallCluster ?? false`.

## Fix (b) — single peerStore read on the scoped findCluster path

The membership-scoped `findCluster` path read each finally-selected cohort member
from the libp2p peerStore twice (protocols for classification, addrs for backfill).
New `getPeerStoreRecordsByPeer` reads both in one `store.get`; the scoped branch
reuses the addrs at backfill. Unscoped branch unchanged.

## Review findings

**What was checked:** config threading across every coordinator construction path;
production behavior-change blast radius; addrs-map behavioral equivalence on the
scoped path; log-line semantics; test coverage; DRY across the peerStore helpers;
full build + non-integration test suite.

- **Config threading (fix a) — CONFIRMED correct.** Traced all four construction
  paths: direct `new ClusterCoordinator(...)` (test spec) reads the flag straight
  off `cfg`; the `coordinator-repo.ts` policy builder now explicitly threads
  `allowUnvalidatedSmallCluster: cfg?.allowUnvalidatedSmallCluster ?? false`;
  production `libp2p-node-base.ts:603` `consensusConfig` omits the flag and spreads
  into the coordinatorRepo factory (line 728) → `?? false` fails closed as intended.
  Grep confirms `allowUnvalidatedSmallCluster: true` appears ONLY in
  `mesh-harness.ts` (two blocks) and the test spec. No production caller opts in.

- **Addrs-map equivalence (fix b) — CONFIRMED.** `backfillIds` (= `ids` minus self)
  reduces to `others = serves.slice(0, nonSelfTarget)`, and `serves ⊆ nonSelf` (the
  record-map query set), so every backfill id was read into `peerStoreRecords`. The
  reused map is filtered to non-empty addr lists, exactly matching what the old
  `getPeerStoreAddrsByPeer` produced (`out[id]` only set when `addrs.length > 0`);
  downstream `peerStoreAddrs[id] ?? []` makes missing/empty equivalent. Reading
  addrs at classification time vs. backfill time is separated only by synchronous
  CPU work (no dial/identify between), so no staleness delta. Behaviorally identical.

- **MINOR, FIXED INLINE:** the fallback log `cluster-tx:small-cluster-accepted-without-validation`
  fired on **both** outcomes — including when the flag is off and the write is then
  REJECTED — so it claimed "accepted" for a rejected write, and paired with the
  caller's `cluster-tx:reject-too-small` for a contradictory two-line trace. Renamed
  to `cluster-tx:small-cluster-no-confident-estimate` and added an `admit` field
  carrying the actual decision. No test asserted the old name.

- **Production behavior change — confirmed intended, blast radius narrow.** The gate
  `peerCount < minAbsoluteClusterSize` only trips for a genuinely undersized cluster
  (single-peer in the node-base config, `minAbsoluteClusterSize: 2`); a healthy
  multi-node network clears it, and a legitimate small network with a confident FRET
  estimate is still validated by the unchanged accept branch. Only a real single-node
  deployment with no confident estimate is newly rejected — the intended semantics.

- **DRY (tripwire, not filed):** three overlapping peerStore helpers now exist
  (`getPeerStoreAddrsByPeer`, `getPeerStoreProtocolsByPeer`, `getPeerStoreRecordsByPeer`);
  the records helper is a superset of the other two. The narrower two are still used
  (addrs on the unscoped path, protocols by `filterByMembership`), so this is
  acceptable duplication — not worth collapsing now. Parked here as an index note
  only; if a fourth peerStore-shape helper is ever needed, fold them onto the records
  helper then.

- **Known coverage gaps (unchanged by this work, low risk — no ticket):** the new
  gate tests use a single-peer cluster with no FRET service, exercising only the
  no-confident-estimate fallback (the point of fix a). The FRET-confident accept
  branch (`confidence > 0.5` + order-of-magnitude check) is unchanged and remains
  untested, as it was before. Fix (b)'s equivalence is covered indirectly by the
  gated `multi-coordinator-cross-network-write` integration spec, not a byte-for-byte
  unit assertion. Both are pre-existing floors, not regressions; not worth new
  tickets given the branches/logic are unchanged straight reuse.

**Empty categories:** no correctness, security, resource-cleanup, or type-safety
defects found beyond the log-line wart above. Error handling on the new peerStore
helper mirrors the two existing helpers (per-peer try/catch, swallow, leave absent).

## Tests run (from `packages/db-p2p`, plus `db-core` build)

- `yarn build` in `db-core` and `db-p2p` — clean, exit 0.
- `test/cluster-coordinator.spec.ts` — 10 passing (incl. 2 gate tests; reject test
  still green after the log-line edit).
- `yarn test` (full non-integration suite) — **1146 passing, 36 pending, 0 failing**
  (pending = env-gated `*.integration.spec.ts` calling `this.skip()` without
  `OPTIMYSTIC_INTEGRATION=1`). Real-libp2p / substrate integration tiers not run
  (long/heavy — CI/human territory).

## Changes made in this review pass

- `packages/db-p2p/src/repo/cluster-coordinator.ts`: renamed the fallback log event
  to reflect the actual admit/reject decision and added an `admit` field.
