description: When a node couldn't check whether its copy of a shared table was current, it handed the copy out as if it were confirmed, so readers worked from out-of-date data forever with no error. Now the answer carries a doubt marker that triggers a retry against another node, and a read that still can't be confirmed fails loudly instead of silently serving stale data.
prereq:
files: packages/db-core/src/network/struct.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-integration.spec.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-core/test/collection.spec.ts, docs/internals.md
----

# Review: a coordinator no longer serves stale content as if it were confirmed

Implements `implement/coordinator-serves-stale-data-as-if-confirmed` (which carries the
full field evidence and design rationale — this is the distilled handoff). The defect: a
coordinator whose freshness consult heard a cohort peer claim a strictly higher revision,
but could not corroborate it (quorum declined) or could not acquire it, served its local
copy with no marker at all. `NetworkTransactor.get` accepted it as final, and the one read
that can unstick a lagging collection — the unpinned tail read in
`Collection.bootstrapContext` — silently seeded a frozen context from it.

## What was built

Confidence about *currency* now survives from the coordinator that formed it, through the
transactor merge, to the reader that acts on it:

- **`GetBlockResult.unconfirmedAheadRev`** (`struct.ts`) — optional; set when a repo served
  committed content it could not confirm is current because a cohort peer claimed a
  strictly higher revision the repair pass could not settle. Carries the claimed revision.
  Deliberately separate from `unavailable` (existence vs currency); absent = confirmed, so
  all existing producers keep their meaning. Crosses the wire for free (repo service JSON).
- **`BlockPossiblyStaleError`** (`struct.ts`) — sibling of `BlockUnavailableError`, not a
  `StaleFailure`, so `Collection.sync` surfaces it instead of retrying it.
- **`CoordinatorRepo`** — `queryClusterForLatest` returns the highest uncorroborated claim
  on its no-quorum path (`uncorroboratedRev`, evidence only, never adopted);
  `fetchBlockFromCluster` passes up `claimedAheadRev` from both non-converging shapes
  (failed quorum, and corroborated-but-not-acquired, including a partial advance that lands
  short of the corroborated revision); `get` stamps via new `flagUnconfirmedCurrency`,
  narrowly: entry has a committed revision, served revision strictly below the claim after
  the repair ran, and the requested view should contain the claim (unpinned, or pinned
  at/above it). A read pinned *below* the claim is never stamped — collection data reads
  stay quiet; the unpinned tail read speaks up.
- **`NetworkTransactor.get`** — `isAuthoritative` treats a marked entry as not-answered
  (earns the second-chance retry, like `unavailable`); `rankOf` now orders
  confirmed block(4) > unconfirmed block(3) > authoritative absent(2) > unconfirmed
  absent(1) > unavailable(0). The 4-vs-3 split is load-bearing: without it the stale marked
  entry ties the fresh confirmed one its own retry fetched, and first-arrival wins.
  `getStatus` also throws `BlockPossiblyStaleError` on a surviving marker (an action
  committed at the claimed revision would otherwise read as a definite `aborted`).
- **`TransactorSource.tryGet`** — an UNPINNED read whose surviving entry carries the marker
  throws `BlockPossiblyStaleError`; pinned reads keep working (belt-and-braces — the
  coordinator shouldn't stamp below-pin reads anyway). No read dependency recorded.
- **`Collection.bootstrapContext`** — same check for its direct (transactor-level,
  unpinned) tail read, the exact seam that froze in the field.
- **`docs/internals.md`** — new bullet documenting the currency marker alongside the
  existing three-valued existence answer, including the full merge ranking.

Verified assumption (recorded in the `flagUnconfirmedCurrency` doc comment):
`ActionContext.rev` and a block's `state.latest.rev` share the per-collection revision
counter (`bootstrapContext` seeds from the tail's `latest.rev`; `syncInternal` commits
every block at `context.rev + 1`), so the pin comparison is well-defined.

## How to validate

All run in the plain suites — full monorepo `yarn build` + `yarn test` green
(db-core 1364, db-p2p 1576 passing; lint clean).

- `packages/db-p2p/test/coordinator-repo-unavailable.spec.ts` — new describe
  "stale-present blocks": the ticket's reproducer (self rev 1, peer claims rev 2, third
  peer silent → served content stamped `unconfirmedAheadRev: 2`), the
  corroborated-but-unacquirable shape, and three narrowing pins (claim not ahead → no
  stamp; pinned below claim → no stamp; pinned at/above claim → stamp).
- `packages/db-p2p/test/coordinator-repo-integration.spec.ts` — new mesh-harness
  end-to-end: three peers, roles assigned by the transactor's real routing order so the
  STALE node is deterministically the first coordinator; asserts the stale coordinator
  itself answers marked, and a `NetworkTransactor.get` comes back with the confirmed rev 2
  (retry + merge), not the stale copy.
- `packages/db-core/test/network-transactor.spec.ts` — confirmed-beats-unconfirmed merge
  (the ticket's second reproducer), marker carry-through when every peer is unconfirmed,
  and the `getStatus` throw.
- `packages/db-core/test/transactor-source.spec.ts` — unpinned read throws (no read
  dependency), pinned read still serves.
- `packages/db-core/test/collection.spec.ts` — `Collection.open` throws
  `BlockPossiblyStaleError` when the log tail is served marked (the freeze seam).
- Load-bearing regression pins that stayed green: "keeps a merely-STALE block
  authoritative even when a cohort peer is silent" (silence with no claim never stamps)
  and the new-collection authoritative-absent probe.

## Behaviour change (deliberate, review this)

A node partitioned from every coordinator able to confirm currency used to read stale
data silently; it now raises `BlockPossiblyStaleError` on unpinned reads until the
partition heals or the claim is settled. Recorded as an accepted-tradeoff `NOTE:` at the
`TransactorSource.tryGet` throw site with a revisit condition (a serve-with-warning
degraded-read mode becoming a requirement).

## Known gaps / honest notes for the reviewer

- **Missing-block + uncorroborated claim + fully-answering cohort is still an
  authoritative absent.** The ticket scoped the stamp to present blocks (`!isMissing`);
  a locally-MISSING block where one peer claims a revision but quorum declines and nobody
  is silent still reads as authoritatively absent (the claim travels up but `get` ignores
  it on the missing path). Same lie-class as the fixed case, different arm — worth a
  reviewer opinion on whether it deserves its own ticket. The
  corroborated-missing shape IS covered (flagged `peers-unreachable`, pre-existing).
- **The mesh harness cannot express asymmetric reachability** (`silentPeers` silences a
  peer for every observer, not per-link), so the e2e models the field topology's
  observable equivalent: the third peer dark for everyone. A true "B can't reach C but A
  can" partition is not representable without a harness extension.
- **`yarn test:integration` (real-socket libp2p specs) was not run** — the new end-to-end
  case landed in the plain suite (mesh harness), not the gated integration file, and the
  gated suite's wall-clock is not agent-runnable per runner limits. Nothing in it touches
  the changed seams beyond what the mesh e2e covers, but a human/CI pass is the honest
  final check.
- The repo has no per-package `typecheck` script (root `yarn typecheck` matches nothing in
  db-core/db-p2p); `tsc` runs as the build, which is green.
- The stamp is also applied to a committed TOMBSTONE behind a claim (entry with
  `state.latest` and no block) — it ranks as "unconfirmed absent" (1) in the merge and
  throws on unpinned `tryGet` like any marked entry. Follows from checking the committed
  revision rather than block presence; flagging if the reviewer thinks tombstones deserve
  a pin of their own.
