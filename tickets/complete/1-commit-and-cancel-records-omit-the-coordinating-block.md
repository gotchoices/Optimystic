description: Machines that store data check for themselves whether the group of peers claiming to handle a write is really the right group. That check used to be skipped on two of the three steps of a write, which could leave a write half-finished; it now runs on all three, and a dishonest coordinator can no longer point the check at a group of its own choosing.
files: packages/db-core/src/cluster/structs.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/mesh-partition-admission.spec.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/test/support/capture-log.ts, docs/correctness.md, packages/db-p2p/docs/cluster.md
----

# Complete — the coordinating block reaches every cluster path, bound to the record's own operations

## What shipped

A cluster member votes on a write only after checking that the peer group the coordinator declared is
plausibly the right group for that block. To run that check the member looks the block's real cohort
up itself, which needs a block id — the *coordinating block*. Records carried that id on the first
step of a write (`pend`) but not on the two that follow (`commit`, `cancel`), so on those steps the
check silently degraded to a cruder rule that could refuse a group it had just approved, stranding a
write pended-but-never-committed.

Three arms landed in the implement stage (commit `ecc9403`):

1. **Derived at one choke point.** `ClusterCoordinator.executeClusterTransaction` stamps the cohort
   key it is already handed onto a *copy* of the message when the message carries none, so pend,
   commit and cancel all carry one and no future message builder can reintroduce the gap.
2. **One copy of the id, inside the hash.** The top-level `ClusterRecord.coordinatingBlockIds`
   duplicate — outside every hash, rewritable by any relaying peer — was removed outright. Every
   reader now uses `record.message.coordinatingBlockIds`, which `messageHash` covers.
3. **The id must be one the record's own operations name.** Otherwise a dishonest coordinator could
   shrink the declared peer group and point every member's own lookup at an unrelated block whose
   real cohort happens to match. A mismatch logs `cluster-member:coordinating-block-unbound` and
   falls to the pre-existing conservative branch rather than throwing.

Incidental fix: a multi-block `cancel` used to produce one identical `messageHash` for two blocks
with identical cohorts, colliding in the coordinator's `transactions` map and in
`wasTransactionExecuted`. Per-block coordinating ids separate them.

## Review findings

Reviewed the implement diff first, then the surrounding code. Verified by reading: every production
caller satisfies the binding (`NetworkTransactor.consolidateCoordinators` builds a batch's payload
*from* the same block list it declares, so `coordinatingBlockIds[0]` is always in the payload;
`commit` and `cancel` derive theirs from `commit.blockIds` / `actionRef.blockIds`, both of which the
binding check reads). Confirmed the wire path (`JSON.parse` of the whole record) carries the field,
and that `computeClusterMessageHash` canonicalises the *whole* message generically — so a peer on an
older build recomputes the new hash correctly from the record it received and mixed-version clusters
do not break on the changed preimage.

**Fixed in this pass (minor):**

- **Duplicated block-id extraction, 40 lines apart in the same class.** Arm 3 added a new
  `ClusterMember.operationBlockIds(message)` whose five operation arms were a near-copy of the
  existing `ClusterMember.getAffectedBlockIds(operations)` used by conflict detection. Deleted the
  new one; the binding check now calls `getAffectedBlockIds`, whose doc comment names both consumers
  and why they must not drift (if they did, a coordinator could name a block the record is not
  judged to touch). The dropped `?? []` defensiveness was not carried over deliberately: the other
  caller already runs unguarded on the same untrusted input after hash validation, and the type says
  `operations` is required — one posture, not two.
- **`coordinatingBlockIds: []` would have been preserved as "already present".** The choke point
  tested the field, not its length, so an empty list would survive and silently reproduce the
  fallback-floor downgrade the arm exists to prevent. Now tested on `?.length`. Not reachable today
  (`CoordinatorRepo.pend` would already have failed on `coordinatingBlockIds[0]!` upstream), so this
  is a totality fix, not a live bug.
- **Docs were stale in two places the implement grep missed** (it searched `docs/` only, not
  `packages/*/docs/`). `packages/db-p2p/docs/cluster.md` still published the removed
  `coordinatingBlockIds?: BlockId[]` field in its `ClusterRecord` interface — removed, and the
  admission-gate section now states where the id actually lives, that the coordinator stamps it on
  every path, and what the binding check does. `docs/correctness.md` Theorem 2 caveat (3) still read
  "**The gate is armed on PEND only, today**" and pointed at this very ticket as open — rewritten to
  the landed reality, including the two residual limits (below). The gate description at §112 gained
  one clause: the block `E` is derived from is not the coordinator's free choice. Also corrected
  "Two caveats:" introducing a list of three.
- **A test ran the same `cancel` twice** to capture the coordinator-side and member-side logs
  separately, so the member-side assertions were made against a cancel of an already-cancelled
  action. `captureLog` now accepts an array of namespaces (which is the direction
  `debt-three-copies-of-the-log-capture-test-helper` already wants it to go), and the test asserts
  both views over one cancel.

**Filed (major):**

- `backlog/debt-absent-coordinating-block-downgrades-the-admission-gate` — arm 3 closed the
  *unbound* case but not the *absent* one: a coordinator that omits `coordinatingBlockIds` entirely
  still gets judged against the permissive `assumedClusterSize` floor instead of the member's own
  measured cohort, so the sender still picks which of the two checks the receiver runs. Filed at the
  boundary-invariant rung rather than as a point bug — the fix is one rule at the member's seam, not
  a patch per path. This is newly worth closing *because* arm 1 landed: an absent field no longer
  means "an honest builder forgot". Site-claim grep over all open stages found no ticket claiming
  it (`feat-admission-floor-from-observed-cohort-high-water-mark` attacks the same weakness from the
  other side — making the fallback number trustworthy — and is cross-referenced, not duplicated).

**Checked and deliberately not filed:**

- **The arbitrator draw key changed** (`dispute-service.ts:173`): commit/cancel-originated disputes
  now draw by the block id rather than by `messageHash`. Traced the consumers —
  `selectArbitrators` has exactly one call site, the resulting set rides on the challenge and is
  bound into each vote, and no arbitrator recomputes the key independently — so nothing has to agree
  on it across peers. The new key is also the more meaningful draw. No defect.
- **`extractInvalidationTarget`'s commit arm takes a different branch but lands on the same id** —
  the coordinator derives the field from `commit.blockIds[0]`, exactly what the final fallback
  produced. Confirmed by reading.
- **A *confident* minority is admitted on the commit path.** The implement stage flagged this
  honestly; it is a design property, not a diff defect — a member that genuinely measures a 2-peer
  cohort cannot distinguish a partition from a small deployment, and Theorem 2's protection rests on
  a partition collapsing that confidence. The behaviour is pinned by a test; the reasoning is now
  also stated in `docs/correctness.md` caveat (3) rather than living only in a spec comment.
- **`cluster-repo.ts` grew from 2034 to 2067 lines.** `debt-cluster-member-race-logic-has-no-home`
  already owns this file's size; updated its measured count and named this ticket as the cause
  rather than filing a second size ticket.
- **Cost of the derived view** (one `findCluster` per inbound record, now on the commit and cancel
  paths too) — the accepted-tradeoff `NOTE:` at `deriveExpectedClusterView` already records the
  remedy and its trigger condition. Left alone.

**Tripwires:** none recorded. Nothing in this diff was of the "fine now, only matters if X later"
shape — the two conditional concerns that came up (derivation cost, and the reason-string-comparison
note at the admission reject) already carry `NOTE:` comments at their sites from earlier tickets.

**Known coverage gaps, stated rather than closed:**

- No test exercises the binding check's `invalidate` arm. There is no production builder for an
  `invalidate` `RepoMessage` today (`DisputeService.maybeInvalidate` goes through `onInvalidation`,
  not `executeClusterTransaction`), so the arm is dormant; it is handled correctly by inspection.
- The "preserve an already-present list" branch of arm 1 has no dedicated test, and cannot usefully
  have one: `executeClusterTransaction` is always called with `coordinatingBlockIds[0]` as its block
  id, so preserving the list and overwriting it with `[blockId]` differ only in the list's unread
  tail and in the resulting hash. Nothing reads past `[0]`.
- The unit-level `cluster-membership-admission.spec.ts` builds members from bare constructor
  defaults, exercising floors no real node runs on. That is the right level for gate arithmetic (and
  is where arm 3 is tested), but claims about commit-path behaviour should be read off the mesh spec.

## Verification

- `yarn build`, `yarn lint`, `yarn typecheck` (root) — all clean.
- `yarn workspace @optimystic/db-p2p test` — **1956 passing, 44 pending, 0 failing**.
- `yarn workspace @optimystic/db-core test` — **1393 passing**.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
