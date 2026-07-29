----
description: A node that reads a piece of data it does not have can now actually fetch it from the other nodes that do, instead of correctly working out which version it is missing and then doing nothing about it.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-p2p/test/mesh-sanity.spec.ts, docs/transactions.md, docs/internals.md
difficulty: hard
----

# Read-repair transfers block content

Implemented in commit `559df6a` (`fix(db-p2p): let a read acquire a block the node has never seen`),
reviewed and completed here.

## What was wrong

`CoordinatorRepo.fetchBlockFromCluster` established a quorum-corroborated `(rev, actionId)` for a
block and then discarded it. Its only "restoration" was `storageRepo.get({ context: { committed:
[corroborated], rev } })`, which promotes a pending the node **already holds**. A node that never
participated in the action has no pending, so nothing moved — and `BlockStorage.getBlock` returns
`undefined` for a block with no local metadata *before* `ensureRevision` runs, which is the only
place `restoreCallback` is reachable from. Net effect: a node that had never seen a block could
never obtain it by reading, even knowing exactly which revision the cohort held and which peers
held it. Downstream this presented as a reader unable to open a collection at all.

## What was built

**Transfer mechanism — reuse `reconcile-block.ts` verbatim.** `CoordinatorRepo` gained an optional
`acquireBlockFromCohort` component, typed `AcquireBlockCallback = ReconcileBlockCallback`. In the
live node (`libp2p-node-base.ts`) it is *the same instance* already built for the commit path, so
the read path inherits the bounded per-peer archive fetch, the `(rev, actionId)` quorum, the
content quorum, the capacity cap that lets a genuine two-node cohort heal, the reputation
penalties, and the monotonic commit-latched `saveReplicatedBlock` funnel.

**Convergence path.** `restoreCorroborated` runs two mechanisms, cheapest first: promote a local
pending (free, no network — still the fast path for a node that saw the pend and missed the
commit), then acquire from the cohort if that moved nothing. `cluster-fetch:synced` is emitted only
against a revision re-read from storage, so it still cannot lie.

**Where the line is drawn.** Acquisition is reachable *only* after a corroborated `(rev, actionId)`
exists. A genuinely absent block (an insert probing a fresh random id for a collision) is claimed by
nobody, so `selectQuorumRev` declines, `cluster-fetch:no-quorum` is logged, and the function returns
*before* the archive fetch. `BlockStorage.getBlock`'s early return is unchanged; its comment now
explains that the decision moved up a layer — storage cannot distinguish "nobody has this" from "I
don't have this", the coordinator can.

**Pending-only forward revision → absence, not error.** `promoteCorroborated` catches the
`revision N not found during restore attempt` throw from `ensureRevision`, logs
`cluster-fetch:promote-unavailable`, and falls through to acquisition. Previously that throw became
`cluster-fetch:error` and short-circuited the pass. `StorageRepo.get`'s behavior for other callers
is unchanged.

**Mesh harness de-faked.** `mesh-harness.ts`'s `clusterLatestCallback` used to write the queried
peer's block into local storage ("simulate data sync"), so every read-repair assertion on the
harness observed a convergence production did not provide. That is removed; the harness now wires a
real `acquireBlockFromCohort` built from the same shared `makeReconcileBlock` factory its cluster
member uses, mirroring the live node.

## Review findings

Read the implement diff (`git show 559df6a`) before the handoff summary. Everything below is what
the review pass checked and what it did.

### Verified as claimed

- **Boundary — "no corroboration ⇒ no archive fetch".** Confirmed by tracing the path and by the
  fetch-counting spec. The claim holds: `fetchBlockFromCluster` returns at `!corroborated` before
  `restoreCorroborated` is ever entered. The cost of a genuine absence is the latest-query round
  trip it already performed.
- **No deadlock.** `CoordinatorRepo.get` acquires no latch. `StorageRepo.get` acquires and releases
  `StorageRepo.commit:<id>` around its promotion loop *before* returning, so `saveReplicatedBlock`
  re-acquiring that key from inside `acquireBlockFromCohort` runs with nothing held.
  `BlockStorage.ensureRevision` uses a distinct key entirely. No reentrancy either: `SyncService`
  serves from `storageRepo` directly, never through the coordinator.
- **Config coupling.** Both the coordinator's `queryClusterForLatest` quorum and reconcile's two
  quorums read `clusterSize` and `simpleMajorityThreshold` from the *same* `consensusConfig` object
  in `libp2p-node-base.ts`, so the read and commit gates cannot drift apart by misconfiguration.
- **`withDeadline` omitting `unref`** — correct as written. `unref` does not exist on browser/RN
  timers; the timer is cleared in `finally` on both outcomes; and a late rejection of the raced
  promise still has a handler attached from `Promise.race`, so it cannot surface as an unhandled
  rejection.
- **`ReconcileTimeoutMs = RECONCILE_TIMEOUT_MS`** — keep the shared constant. It is one operation
  with one stall ceiling, and letting the two diverge would mean a read could outlive the bound the
  commit path considers acceptable for the identical call. `docs/internals.md` now says so.
- **`CoordinatorRepo`'s 11-position constructor** — agreed with the implementer, left alone. The
  factory plus the `CoordinatorRepoComponents` object is the real API; converting the constructor
  would churn every test construction for no caller benefit.
- **`restoreCorroborated`'s post-acquisition `readLocalRev`** — kept. It is a second full
  `storageRepo.get` on the repair path only, and it is what makes `cluster-fetch:synced` an
  observation rather than an assumption. Buying honest outcome logging with one extra read on a
  path that just did a network archive fetch is the right trade.

### Minor — fixed in this pass

- **`docs/internals.md` was stale.** The "*behind* member actively reconciles" bullet still said
  reconcile repairs "the under-replication that lazy read-repair alone cannot". That is exactly
  what stopped being true. Rewritten to state that the read path is handed the same callback
  instance and heals by identical rules, and that `ReconcileTimeoutMs` is the shared bound.
  (`docs/transactions.md` was already updated correctly by the implement pass.)
- **The `promote-unavailable` fall-through had no test.** The change deliberately converts a throw
  that used to abort the pass into a logged absence, and nothing pinned it — the existing specs all
  take paths where the promotion either succeeds or never throws. Added
  `falls through to acquisition when no local promotion can reach the revision`: node B holds
  metadata from an unrelated pend (so it is past `getBlock`'s no-metadata early return) with no
  storage-layer restore callback, which makes rev 2 genuinely unreachable by promotion. Asserts
  `cluster-fetch:promote-unavailable` fires, `cluster-fetch:error` does not, and acquisition
  supplies the content anyway. Required a `restoreB` option on the fixture.
- **The archive-fetch counter was never shown to move.** `never fetches an archive for a block no
  peer claims` asserted the counter is 0 — which would also hold if the acquisition callback were
  unwired entirely. Added a positive control in the same fixture: a corroborated read afterwards
  must drive the counter above zero.
- **`mesh-sanity.spec.ts` → "non-responsible node discovers revision exists via cluster callback"
  asserted a tautology** (`get` returns an entry for every id requested, always) and its comment
  gave a reason that the change had just invalidated ("full cross-node block replication requires
  restoreCallback on BlockStorage"). Tightened to assert the reader gets **no block**, with the
  real reason: at `responsibilityK: 1` the cohort view holds one peer while the mesh's
  `clusterSize` is its node count, so the corroboration floor stays at two and the pass correctly
  declines. Verified empirically, not assumed.

This was also the answer to the handoff's own question — *did another spec depend on the removed
harness fake and still pass for the wrong reason?* One did, in the weaker sense of asserting
nothing that could fail. Nothing was found that asserted a convergence the harness fake had been
supplying.

### Major — none filed

No defect found that warrants a new ticket. The one real gap in this area is that the mesh
harness's `makeReconcileBlock` stand-in is first-peer-wins rather than quorum-gated — so mesh-level
convergence assertions still cannot prove the quorum gates work, and the read path now inherits
that blindness alongside the commit path. That is already filed as
`backlog/debt-mesh-harness-reconcile-double-bypasses-quorum`, whose text already names both paths.
Not re-filed.

### Tripwires — recorded, not ticketed

- **A soft-served read now stores a block this node is not responsible for.**
  `CoordinatorRepo.get`'s proximity check warns and serves anyway; before this change the most
  that could follow was promoting a pending the node already had, so nothing new landed on disk.
  Now the same path can durably acquire a replica, and nothing sweeps it — ring-shift sheds a
  keyspace *range*, not "blocks outside my cohort". Fine while soft serves stay what they are meant
  to be (a rare degradation during routing churn, where routing has already placed this node near
  the block). `NOTE:` at the proximity-check site in `coordinator-repo.ts`, with the remedy: gate
  acquisition, not the serve, on `isResponsibleForBlock`.
- **The 5s acquisition bound is per block, not per `get`.** `get` walks its block ids sequentially,
  so a multi-block read missing N blocks against a wholly stalled cohort waits N × `RECONCILE_TIMEOUT_MS`.
  Not a concern today — the underlying per-peer archive fetch is itself 1s-bounded and runs the
  cohort in parallel, so 5s is a stall ceiling rather than a typical cost. `NOTE:` folded into the
  existing deadline comment in `restoreCorroborated`, with the remedy: repair the block ids
  concurrently rather than shortening the bound.
- The implement pass's own `NOTE:` about `markBlocksSeen` not damping a *missing* block's repeated
  acquisition attempts was reviewed and left in place as written.

### Validation run

| Gate | Result |
| --- | --- |
| `yarn lint` (root) | exit 0 |
| `yarn build` (root) | exit 0 |
| `yarn test` (root, all packages) | 0 failing |
| `yarn test` (`packages/db-p2p`) | **1417 passing, 41 pending, 0 failing** (1416 before this review's added spec) |
| `yarn test:integration` (root, real-TCP meshes) | 27 + 329 passing, 10 pending, 0 failing |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Still not verified

`yarn test:integration` — listed as unrun in the handoff — was run here and passes. What remains
unverified is the **cross-repo downstream acceptance run**: `sereus/packages/integration-tests`
(`control-db-two-node-convergence.integration.ts` and the ~20 related convergence scenarios) still
cannot be built from here. That blocker is tracked by
`blocked/two-node-convergence-acceptance-cross-repo-build`. Three consecutive fixes to this
subsystem each looked complete and each uncovered another blocker, so treat this repo's green
suites as necessary, not sufficient, until that run happens:

```
cd c:/projects/optimystic && yarn build
cd c:/projects/sereus/packages/integration-tests
npx vitest run src/scenarios/control-db-two-node-convergence.integration.ts
```

## Related, deliberately out of scope

`plan/4-collection-open-silently-invents-empty-collection` is why this defect surfaced as "no rows"
rather than an error. It remains live and was not touched.
