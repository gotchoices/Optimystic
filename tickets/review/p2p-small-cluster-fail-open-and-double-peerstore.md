description: Review two independent db-p2p cluster fixes — a safety gate that used to wave through too-small clusters now refuses them by default, and a redundant peer-directory lookup on the write path was collapsed into one.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/cluster-coordinator.spec.ts
difficulty: medium
----

# Review: validateSmallCluster fails open + double peerStore read

Two unrelated fixes in the db-p2p cluster path landed together (they don't touch
the same code). Both are implemented, built, typechecked, and covered by tests.

## Background (for a reader without context)

A "cluster" is the small set of peers that must agree (super-majority) before a
write commits. If that set is too small, agreement is meaningless — a lone node
could rubber-stamp its own writes. `minAbsoluteClusterSize` is the floor below
which a cluster is considered unsafe (default 3; the node/harness configs use 2).

## (a) Fail-closed undersized-cluster gate

`ClusterCoordinator.validateSmallCluster` is the last check before an undersized
cluster (`peerCount < minAbsoluteClusterSize`) is allowed to proceed. It accepts
when FRET (the network-size estimator) is confident the small size is legitimate.
Previously, when FRET had **no** confident estimate — the normal state on a young
or churning network — it fell through to `return true`, admitting the write. That
"development/testing carve-out" was in fact the default production path: it failed
**open** exactly when it should fail **closed**.

Fix:
- New optional config flag `allowUnvalidatedSmallCluster?: boolean` on
  `ClusterConsensusConfig` (`db-core/src/cluster/structs.ts`), documented, default
  `false`.
- `validateSmallCluster` fallback now returns
  `this.cfg.allowUnvalidatedSmallCluster ?? false` instead of `true`. The
  FRET-confident acceptance branch is unchanged. Log line kept.
- `mesh-harness.ts` sets the flag `true` in **both** config blocks (the
  `clusterMember` consensusConfig ~line 143 and the coordinatorRepo factory config
  ~line 261) so integration tests that legitimately spin up small/single-node
  meshes keep passing.
- Production (`libp2p-node-base.ts`) leaves the flag unset → fails closed. This is
  the intended behavior change: a genuinely single-node network can no longer
  silently self-approve.

### DEVIATION FROM TICKET — read this

The original ticket said "`coordinator-repo.ts`: leave unset (false)" and did not
list any code change there. That was **not sufficient**, and I had to edit
`coordinator-repo.ts` anyway. Reason: the `coordinatorRepo` policy builder
(`coordinator-repo.ts:95-113`) reconstructs the config object with an **explicit
field list** and drops any field not named. So even though `mesh-harness` passes
`allowUnvalidatedSmallCluster: true` into the factory (as the ticket instructed),
the flag was silently discarded before reaching the `ClusterCoordinator` — and the
mesh-sanity suite failed with `Cluster size 2 below minimum 3 and not validated`.

I threaded the flag through with a fail-closed default:
`allowUnvalidatedSmallCluster: cfg?.allowUnvalidatedSmallCluster ?? false`. This
keeps the ticket's intent (default false; production node-base fails closed
because it never sets the flag) while letting a caller (the harness) opt in.
**Reviewer: confirm this threading is correct and that no production caller passes
the flag.** Grep: only `mesh-harness.ts` should set it true.

## (b) Single peerStore read on the scoped hot path

In `libp2p-key-network.ts findCluster`, when membership scoping is active
(`protocolPrefix != null`), each finally-selected cohort member was read from the
libp2p peerStore **twice** per write: once for protocols (membership
classification) and once for addresses (dial backfill).

Fix:
- New helper `getPeerStoreRecordsByPeer(ids)` does one `store.get` per peer and
  returns `{ protocols, addrs }`. Same guard/`Promise.all`/swallow-per-peer-error
  shape as the two existing helpers.
- Scoped branch calls it once into `peerStoreRecords`, classifies membership from
  `peerStoreRecords[id]?.protocols`, and reuses `peerStoreRecords[id]?.addrs` at
  backfill (no second read).
- Unscoped branch (`protocolPrefix == null`) is unchanged: `peerStoreRecords`
  stays `undefined` and the existing single `getPeerStoreAddrsByPeer(...)` call
  runs. `getPeerStoreProtocolsByPeer` is left in place (still used by
  `filterByMembership` for coordinator selection — out of scope).

Behavioral equivalence to verify: the reused-addrs map is filtered to non-empty
entries (`.filter(([, addrs]) => addrs.length > 0)`) to exactly match what the old
`getPeerStoreAddrsByPeer` produced; downstream reads use `peerStoreAddrs[id] ?? []`
so missing/empty are equivalent. `backfillIds` (= `ids` minus self) is always a
subset of `nonSelf` (the record-map query set), so every backfill id is in-domain.

## What to verify

- **Fail-closed default**: undersized cluster + no confident FRET estimate is
  REJECTED when the flag is off, ADMITTED when on. Covered by new suite
  `ClusterCoordinator undersized-cluster gate (validateSmallCluster)` in
  `test/cluster-coordinator.spec.ts` (single-peer, no FRET). Two cases:
  reject-when-off, admit-when-on.
- **No production caller opts in.** Confirm `allowUnvalidatedSmallCluster: true`
  appears ONLY in `mesh-harness.ts`. `libp2p-node-base.ts` and any other
  `coordinatorRepo`/`clusterMember` construction must leave it unset.
- **Scoped findCluster still classifies + backfills correctly** with the combined
  read — cross-network peers dropped, self-only cohort under downsize, addrs
  present for selected members.
- **Equivalence of the addrs map** on the scoped path vs. the old double-read.

## Known gaps / honest floor

- The new coordinator-spec tests use a single-peer cluster with **no FRET
  service**, so they exercise only the no-confident-estimate fallback (the whole
  point of fix (a)). They do NOT exercise the FRET-confident acceptance branch
  (`estimate.confidence > 0.5` + order-of-magnitude check) — that branch was
  unchanged, but there is no direct unit test for it either before or after. If
  the reviewer wants belt-and-suspenders, a test injecting a mock `fretService`
  with `confidence > 0.5` would lock the accept path.
- Fix (b)'s equivalence is verified indirectly: the membership-scoped path is
  exercised by the gated integration specs (below), which passed, but there is no
  dedicated unit test asserting "records-map addrs == old getPeerStoreAddrsByPeer
  addrs" byte-for-byte. Low risk (the map construction is a straight reuse of the
  same `addresses` field), but it's a floor, not a proof.
- The `allowUnvalidatedSmallCluster` flag defaulting false is a **production
  behavior change**: a real single-node deployment (no confident FRET estimate)
  will now have writes rejected at the undersized gate unless it sets the flag or
  runs enough peers. This is intended per the ticket, but it is a live semantics
  change operators should know about — worth a callout if there's an ops/config
  doc.

## Tests run (all from `packages/db-p2p`)

- `yarn build` in `db-core` and `db-p2p` — clean typecheck, exit 0.
- `test/cluster-coordinator.spec.ts` — 10 passing (incl. 2 new gate tests).
- Full non-integration suite (`test/**/*.spec.ts` minus `*.integration.spec.ts`)
  — **1146 passing, 11 pending, 0 failing**.
- Gated integration specs run with `OPTIMYSTIC_INTEGRATION=1` (they `this.skip()`
  otherwise): `multi-coordinator-cross-network-write` (1 passing — directly
  exercises the scoped `findCluster` peerStore path), `multi-coordinator-write`
  and `multi-coordinator-write-relay` (3 passing). The real-libp2p /
  substrate-real-libp2p integration tiers were NOT run (long/heavy — human/CI
  territory; they remain env-gated and skipped by default).

## Review findings

- (index) Deviation from ticket: had to edit `coordinator-repo.ts` (threaded
  `allowUnvalidatedSmallCluster` through the explicit policy builder with a
  fail-closed default) because the ticket's "leave unset" plan would have silently
  dropped the harness opt-in. Detail in section (a) above.
