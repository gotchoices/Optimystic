description: Make every member of a parent cohort agree on how many child cohorts it has, and let a shrinking child cleanly un-register from its parent so the parent's child count drops and the parent can shrink in turn.
prereq: cohort-topic-parent-child-link
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (CohortGossipV1 childLinks/childUnlinks deltas; ChildLinkRefV1)
  - packages/db-p2p/src/cohort-topic/host.ts (child registry: unrecordChild + gossip merge; demotion-notice-as-unlink in handleInboundNotice; gossipRound drains child deltas)
  - packages/db-core/src/cohort-topic/registration/ (or wherever the gossip bus merges deltas — the child-set merge)
  - packages/db-p2p/src/cohort-topic/host.ts (noticeBroadcastCoords / verifyAndApplyNotice parent path)
  - packages/db-p2p/test (multi-tier e2e: 13-cohort-topic-e2e-mock-tier / 14-substrate-e2e-real-libp2p-tier)
  - docs/cohort-topic.md (§Promotion/demotion, §Topic traffic signal)
difficulty: hard
----

# Cohort-topic: child-link replication + unlink on demotion

## Background

`cohort-topic-parent-child-link` (the `prereq`) makes a child cohort register itself with its parent: the
FRET-routed parent member verifies the child-link and records the child in a per-CoordEngine child
registry, and the real per-topic child count feeds the promotion gate / gossip summary / traffic. Two gaps
remain, both called out in that ticket's `## Edge cases`:

1. **Single-member recording.** FRET routes the child-link to **one** parent member, so only that member's
   registry holds the child; sibling parent members read `childCohortCount == 0`. Because the demotion
   `/sign` endorsement gate does not check child count (parked in
   `cohort-topic-sign-endorsement-hotcold-refinement`), a sibling that never saw the child can originate a
   demotion the recording member would have blocked. The count must **converge across the parent cohort**.
2. **No unlink.** A child that demotes is never removed from the parent's registry, so a parent that has
   parented a child never demotes even after the child is gone.

This ticket closes both: gossip-replicate the child **set** (a converged union across the parent cohort),
and drive an **unlink** off the demotion notice the demoting child already fans to its parent coord.

## Design

### Replicate the child set across the parent cohort (gossip union)

The child set is **sharded** across parent members (different child coords route to different members), so
a per-member count is a shard, not the total — a max-across-siblings undercounts. The correct primitive is
a **converged union**: every parent member holds every child coord, so `count` is consistent everywhere.

Reuse the existing registration-replication shape (`CohortGossipV1.records` / `evicted`, merged by the
cohort gossip bus). Add two deltas to `CohortGossipV1`:

```ts
/** A child-cohort link/unlink advertised in cohort gossip, for cross-member convergence of the child set. */
export interface ChildLinkRefV1 {
	/** Topic id, 32 bytes, base64url. */
	topicId: string;
	/** The child cohort's served coord, 32 bytes, base64url. */
	childCohortCoord: string;
	/** Unix ms — the link/unlink effectiveAt; last-writer-wins per (topic, childCohortCoord). */
	effectiveAt: number;
}

// CohortGossipV1:
	childLinks?: ChildLinkRefV1[];    // children this member recorded (fresh)
	childUnlinks?: ChildLinkRefV1[];  // children this member released (demoted)
```

- A `recordChild` / `unrecordChild` on any parent member enqueues the corresponding ref in the per-touch
  delta queue (the same `pending` batch used for `records`/`evicted` at `host.ts:1361,1540`), drained into
  the next gossip round (`host.ts:1611`).
- The gossip bus merges inbound `childLinks` / `childUnlinks` into the receiving engine's child registry
  via the **same freshness rule** as the registry itself: apply a ref only if `effectiveAt >
  lastEffectiveAt` for that `(topic, childCohortCoord)`; a link sets `linked = true`, an unlink sets
  `linked = false`. Last-writer-wins by `effectiveAt` makes a link and a later unlink converge regardless
  of arrival order, and re-delivery is idempotent.
- After merge, every parent member's `childRegistry.count(topicId)` is the size of the converged union.
  The demotion gate, gossip summary, and traffic snapshot (all wired in the prereq) are now correct
  cohort-wide with **no further change**.

> **Where the merge lives.** The child registry is a db-p2p host structure (per CoordEngine); the gossip
> bus is `createCohortGossipBus` (`host.ts:1339`), which already routes inbound frames per coord and
> merges `records`/`evicted` into the store. Thread a child-set merge callback into the bus the same way
> `onRecordsEvicted` is threaded (`host.ts:1350`), keyed by the frame's `coord` so a gossip for one cohort
> never pollutes a sibling cohort's registry.

### Unlink on child demotion (parent-side demotion-notice handling)

A demoting child already threshold-signs a `DemotionNoticeV1` and fans it to **both** its own served coord
(siblings adopt `promoted = false`) **and** its `parentCohortCoord` (`noticeBroadcastCoords`,
`host.ts:2154`). Today the parent-coord copy is **dropped**: `handleInboundNotice` resolves the target
engine by the notice's `cohortCoord` (the *child's* coord), which a parent-only node does not serve
(`host.ts:2122`, and the `NOTE:` at `host.ts:667`). Give the demotion notice a **second apply semantics at
the parent**:

- In `handleInboundNotice`, for a `demotion` notice, **additionally** resolve
  `parent = registry.findByCoord(parentCohortCoord)`. If found, this node parents the demoting child →
  verify the notice's threshold sig against the **child** cohort cert (same `verifyAndApplyNotice` verify —
  signers ⊆ child cohort cert at the notice's `tier`, keyed by the child's `cohortCoord`) and, on
  `verified`, call `parent.unrecordChild(topicId, cohortCoord /* the child's served coord */, effectiveAt)`.
- The two apply paths are **independent** and both may fire on one node (a node that serves both the child
  coord *and* the parent coord — possible at `d ≥ 1`): the `cohortCoord` target does the sibling-adopt
  (`applyDemotionNotice`), the `parentCohortCoord` target does the child-unlink. Neither is a substitute for
  the other.
- The unlink's effect is enqueued to the parent engine's gossip delta (`childUnlinks`) so the release
  converges across the parent cohort exactly as the link does (a demotion notice is broadcast to the whole
  parent cohort, so each parent member that holds the child unrecords directly; the gossip delta covers a
  parent member that learned of the child only via replication and gets the demotion frame slightly later,
  or vice-versa — last-writer-wins by `effectiveAt` reconciles either order).

**Freshness / high-water interaction.** The existing `promote`-gate high-water is keyed by the notice's
`cohortCoord|tier` (`host.ts:2132`) — the *child's* coord — and is advanced only on an `"applied"`
outcome. The parent-unlink path must not let the high-water on the sibling-adopt path stale-drop the
unlink or vice-versa. Key the unlink's per-child freshness off the child registry's own
`lastEffectiveAt` (per `(topic, childCohortCoord)`), independent of the promote-gate high-water, so a
demotion notice that is a no-op for the sibling-adopt target still applies the unlink at the parent (and
the reverse). Verify the ordering explicitly in a test.

### `unrecordChild`

Extends the prereq's child registry:

```
unrecordChild(topicId, childCoord, effectiveAt): apply only if effectiveAt > lastEffectiveAt → linked = false
```

Idempotent, freshness-ordered. Unrecording a never-seen child creates a `linked = false` entry (so a later
stale link cannot resurrect it) — a floor-safe tombstone, never a negative count.

## Edge cases & interactions

- **Sharded links converge to a union, not a max.** Two children C1, C2 route to different parent members
  M1, M2. After a gossip round each of M1/M2 holds `{C1, C2}` → `count == 2` everywhere. Assert this
  directly (the bug a naive max-count would hide).
- **Link/unlink arrival order.** For one `(topic, childCoord)`: link@t1 then unlink@t2 (t2 > t1) →
  `linked = false` regardless of which frame arrives first (last-writer-wins by effectiveAt). unlink@t2
  arriving *before* link@t1 → link@t1 dropped (t1 < t2), stays unlinked. Test both orders.
- **Demotion notice at a node that is both child-sibling and parent.** Both apply paths fire: sibling-adopt
  clears `promoted`, parent-unlink drops the child from the registry. Neither shadows the other.
- **Demotion notice at a parent-only node with an empty registry** (never saw the link — pure replication
  lag): `unrecordChild` writes a `linked = false` tombstone; when the (late) link ref arrives with an
  earlier `effectiveAt` it is dropped, so the child never wrongly reappears.
- **Root parent.** A tier-0 root receiving a demotion notice from a tier-1 child unrecords the child;
  the root itself never demotes (`demotionTriggered` returns false at `treeTier ≤ 0`, `promotion.ts:316`),
  but its `childCohortCount` must still fall to 0 so §Topic-traffic reporting is honest.
- **Forged / under-quorum demotion at the parent.** The parent-unlink runs the *same* threshold verify as
  the sibling-adopt (against the child cohort cert); a forged notice → not `verified` → no unrecord. Rate
  limit + bounded refetch already gate the `promote` handler (`host.ts:2112,2021`).
- **cohortEpoch rotation of the parent cohort.** The child set is keyed by child coord, not parent epoch,
  so a parent membership rotation does not drop the child set (unlike `cohortEpoch`-reset counters). New
  parent members converge on the union via gossip. Confirm no reset-on-epoch is wired for the child
  registry.
- **Convergence timing.** Between a link landing on one member and the next gossip round, siblings read a
  stale (lower) count — soft state, bounded by one gossip round, matching the rest of the layer. A demotion
  cannot fire inside that window for an unrelated reason because `T_demote` (5 min) dominates.

## Key tests (TDD)

- **db-p2p** replication: two child engines link to the same parent cohort via two different routed parent
  members; after one gossip round assert every parent member's `childCohortCount == 2`.
- **db-p2p** unlink: a linked child demotes → its `DemotionNoticeV1` fanned to the parent coord →
  `handleInboundNotice` unrecords → after a gossip round every parent member's `childCohortCount` drops;
  with the last child gone and `T_demote` elapsed the parent's `maybeDemote` now fires (was blocked).
- **db-p2p** ordering: link@t1/unlink@t2 delivered in both orders converge to unlinked; a stale link
  (`effectiveAt` below the registry high-water) is a no-op.
- **db-p2p** dual-role node: a node serving both the child coord and the parent coord applies both the
  sibling-adopt and the parent-unlink from one demotion notice.
- **Multi-tier e2e** (`13-cohort-topic-e2e-mock-tier`, and `14-substrate-e2e-real-libp2p-tier` if runnable
  in-agent — else document the deferral per the ticket rules and let CI run it): drive a topic past
  `cap_promote` so a real tier-1 child instantiates and links to the tier-0 parent; assert the parent's
  `childCohortCount` reflects the real children and the depth-law shrink path releases them on demotion.
  This is the first exercise of a real parent recording *and releasing* real children rather than the
  single-tier-0 unit path.

## TODO

- Add `ChildLinkRefV1` + `CohortGossipV1.childLinks` / `childUnlinks` to `wire/types.ts` (+ validators).
- Add `unrecordChild` to the child registry; enqueue `childLinks`/`childUnlinks` refs into the `pending`
  delta queue on record/unrecord; drain them in `gossipRound`.
- Merge inbound child deltas in the gossip bus (freshness-ordered, keyed by frame coord), threaded like
  `onRecordsEvicted`.
- Extend `handleInboundNotice`: for a demotion, additionally resolve + verify + unrecord at
  `parentCohortCoord`; keep the sibling-adopt path independent; wire the child-registry freshness for the
  unlink separate from the promote-gate high-water. Update the stale `NOTE:` at `host.ts:667`.
- Remove the single-member `NOTE:` left by the prereq at the child-registry site (now converged).
- Multi-tier e2e (13, and 14 if agent-runnable).
- Update `docs/cohort-topic.md` §Promotion/demotion (demotion notice unlinks the parent's child count) and
  §Topic traffic signal (childCohortCount is a converged union, not a max).
- Run `packages/db-core` build+test and `packages/db-p2p` `yarn test 2>&1 | tee /tmp/dbp2p.log`; flag any
  pre-existing failure per the ticket rules.

## End
