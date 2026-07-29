----
description: A node that reads a piece of data it does not have can now actually fetch it from the other nodes that do, instead of correctly working out which version it is missing and then doing nothing about it.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, docs/transactions.md
difficulty: hard
----

# Read-repair now transfers block content

Implemented from `fix/read-repair-cannot-transfer-block-content`. The fix stage reproduced the
defect at unit level and the correction was unambiguous once reproduced, so it was built in the
same pass — this ticket is the review handoff, not a second implementation brief.

## What was wrong

`CoordinatorRepo.fetchBlockFromCluster` established a quorum-corroborated `(rev, actionId)` for a
block and then threw that knowledge away. Its only "restoration" was
`storageRepo.get({ context: { committed: [corroborated], rev } })`, which promotes a pending the
node **already holds**. A node that never participated in the action has no pending, so nothing
moved, and `BlockStorage.getBlock` returns `undefined` for a block with no local metadata *before*
`ensureRevision` runs — the only place `restoreCallback` is reachable from. Net effect: **a node
that had never seen a block could never obtain it by reading, even knowing exactly which revision
the cohort held and which peers held it.**

Downstream this presented as a reader unable to open a collection at all: the collection header
block `default/CadrePeer` was committed solo on the writer during a cohort-formation race, and the
reader logged `cluster-fetch:not-restored { localRev: undefined, clusterRev: 1 }` 222 times in one
run without ever acquiring it.

## What was built

**Transfer mechanism — reuse `reconcile-block.ts` verbatim.** `CoordinatorRepo` gained an optional
`acquireBlockFromCohort` component, typed `AcquireBlockCallback = ReconcileBlockCallback`. In the
live node (`libp2p-node-base.ts`) it is *the same instance* already built for the commit path, so
the read path inherits the bounded per-peer archive fetch, the `(rev, actionId)` quorum, the
**content** quorum, the capacity cap that lets a genuine two-node cohort heal, the reputation
penalties, and the monotonic commit-latched `saveReplicatedBlock` funnel. The rejected alternative
was reworking `meta.ranges` semantics so `ensureRevision` fires for a forward revision — high blast
radius across load-bearing invariants in `block-storage.ts`, and it would still have needed a
content-trust gate built from scratch.

**Convergence path.** `restoreCorroborated` runs two mechanisms, cheapest first: promote a local
pending (free, no network — the pre-existing behavior, still the fast path for a node that saw the
pend and missed the commit), then acquire from the cohort if that moved nothing. `cluster-fetch:synced`
is emitted only against a revision re-read from storage, so it still cannot lie.

**Where the line is drawn.** Acquisition is reachable *only* after a corroborated `(rev, actionId)`
exists — exactly the `localRev: undefined/stale, clusterRev: N` case. A genuinely absent block (an
insert probing a fresh random id for a collision) is claimed by nobody, so `selectQuorumRev` declines,
`cluster-fetch:no-quorum` is logged, and the function returns *before* the archive fetch. A genuine
absence therefore costs exactly what it cost before: the latest-query round trip it already
performed. `BlockStorage.getBlock`'s early return is unchanged and its comment now explains that the
decision moved up a layer rather than being an unfixed gap — storage cannot distinguish "nobody has
this" from "I don't have this"; the coordinator can.

**Pending-only forward revision → absence, not error.** `promoteCorroborated` catches the
`revision N not found during restore attempt` throw from `ensureRevision`, logs
`cluster-fetch:promote-unavailable`, and falls through to acquisition — the mechanism that can
actually supply it. Previously that throw became `cluster-fetch:error` and short-circuited the pass.
`StorageRepo.get`'s behavior for other callers is deliberately unchanged.

**Deadlock check (the failure mode this was most likely to hit).** Verified the read path holds no
conflicting latch: `CoordinatorRepo.get` acquires nothing itself, and `StorageRepo.get` acquires and
releases `commitLatchKey` around its promotion loop before returning — so `saveReplicatedBlock`
re-acquiring that key from inside `acquireBlockFromCohort` cannot self-deadlock. Also verified no
reentrancy: `SyncService` serves with `skipClusterFetch: true`, and nothing in `cluster-repo.ts`
calls back into the coordinator. Acquisition is additionally bounded at `RECONCILE_TIMEOUT_MS`
(5s, now exported from `reconcile-block.ts` and shared with `ClusterMember.withReconcileTimeout` —
same operation, same bound) so a stalled peer cannot hang a caller's `get`.

**Mesh harness de-faked.** `mesh-harness.ts`'s `clusterLatestCallback` used to write the queried
peer's block into local storage ("simulate data sync"), so every read-repair assertion on the harness
observed a convergence production did not provide. That is removed; the harness now wires a real
`acquireBlockFromCohort` built from the same shared `makeReconcileBlock` factory its cluster member
uses, mirroring the live node.

## Testing

`packages/db-p2p` full unit suite: **1361 passing, 41 pending, 0 failing** (baseline 1359/41/0; net
+2 specs). Root `yarn lint` exit 0, `yarn build` clean.

`test/coordinator-repo-read-repair-content.spec.ts` is the acceptance spec. Its three convergence
cases were verified to genuinely reproduce the defect: with `acquireBlockFromCohort` withheld they
fail (`expected undefined to equal 'v2'`, `expected 1 to equal 2`, `the transfer is reported: -false
+true`); with it wired they pass. Cases:

- `converges the block content and the latest pointer` — the inverted `KNOWN GAP` spec. Asserts the
  repairing read *itself* serves `v2`, not merely that storage caught up afterwards.
- `acquires a block it has never seen once the cohort corroborates one` — the downstream blocker,
  reproduced at unit level (B has no metadata at all).
- `never fetches an archive for a block no peer claims` — the boundary. Counts archive fetches and
  asserts zero for an id nobody holds.
- `selects the peer's newer revision and reports a real sync` — `cluster-fetch:not-restored` flipped
  to `cluster-fetch:synced`, as the fix ticket's TODO required.

One pre-existing spec was corrected rather than loosened: `coordinator-repo-integration.spec.ts`
→ "context-driven pending block serving" passed **only** because of the harness fake — a single
holder in a 3-peer cohort cannot corroborate, so the real path correctly declines. It now pends on
two peers, which is what the honest mechanism requires, and additionally asserts the resulting
`latest.rev`.

## Not verified

**The downstream acceptance run could not be executed.** `sereus/packages/integration-tests`
aborted at its build-freshness guard (`@serfab/cadre-core: dist is stale`) because another agent is
actively editing that repo; per instruction nothing in sereus was rebuilt or edited. So the evidence
here is unit-level only. Three consecutive fixes to this subsystem each looked complete and each
uncovered another blocker — treat "the unit suite is green" as necessary, not sufficient, and re-run:

```
cd c:/projects/optimystic && yarn build
cd c:/projects/sereus/packages/integration-tests
npx vitest run src/scenarios/control-db-two-node-convergence.integration.ts
```

Also unrun: the wider ~20 related sereus convergence scenarios, and `yarn test:integration`
(real-TCP mesh specs) in this repo.

## Decisions deliberately left alone

- **`markBlocksSeen` still fires on a failed convergence.** Dropping it would make every read of a
  stale block re-poll the cohort. It does not suppress the case that mattered: `get` triggers on
  `isMissing` *before* consulting `shouldReadRepair`, so a missing block's acquisition already
  retries on every read regardless of the window. The residual cost (a persistently-failing
  acquisition re-fetching an archive per read — e.g. a two-node deployment left at the default
  `clusterSize: 10`) is recorded as a `NOTE:` tripwire at the site with the remedy if it ever shows.
- **`plan/4-collection-open-silently-invents-empty-collection`** — out of scope here by instruction.
  It is why this defect surfaced as "no rows" rather than an error, and it remains live.

## Review focus

- Is gating acquisition on "a corroborated revision exists" the right boundary, or does some caller
  reach `fetchBlockFromCluster` often enough with a corroborable-but-unwanted block that the archive
  fetch is a cost regression? The claimed invariant is: no corroboration ⇒ no fetch.
- `restoreCorroborated`'s post-acquisition `readLocalRev` is a second full `storageRepo.get`
  (materializes the block) on top of the one `CoordinatorRepo.get` performs immediately after. Only
  on the repair path, but confirm it is worth the honest outcome logging.
- `withDeadline` deliberately omits `unref` (cross-platform; the timer is always cleared in
  `finally`). Confirm that reading is right for the RN/browser targets.
- The `ReconcileTimeoutMs = RECONCILE_TIMEOUT_MS` indirection in `cluster-repo.ts` — is the shared
  constant worth the import, or should the two bounds be allowed to diverge?
- `CoordinatorRepo`'s constructor is now 11 positional parameters. Not touched (the
  factory + components object is the real API), but it is past the point where an options object
  would read better.
- Confirm no *other* spec was silently depending on the removed mesh-harness data-sync fake in a way
  that still passes for the wrong reason.
