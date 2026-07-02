description: Every member of a parent group now agrees on how many child groups it has (converged by gossip, not just the one member a child registered with), and a shrinking child cleanly un-registers from its parent so the parent's child count drops and the parent can shrink in turn.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (ChildLinkRefV1; CohortGossipV1.childLinks/childUnlinks)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateChildLinkRefV1; gossip child-delta validation)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (cohortGossipSigningPayload covers child deltas)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (onChildDeltas merge callback, epoch-independent)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (PendingDeltas child link/unlink; buildCohortGossip)
  - packages/db-p2p/src/cohort-topic/host.ts (ChildRegistry unrecordChild + returns changed; engine record/unrecord enqueue deltas; onChildDeltas wiring; gossipRound drain; handleInboundNotice parent-unlink + applyDemotionUnlinkAtParent; NoticeApplyTarget.unrecordChild)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (child union / unlink / ordering / epoch-drift convergence; PendingDeltas + buildCohortGossip child deltas)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (parent-unlink: parent-only, dual-role, forged-rejected, high-water-independence, no-parent)
  - packages/db-core/test/cohort-topic/wire.spec.ts (child-delta round-trip + validation + signing-payload coverage)
  - packages/db-core/test/cohort-topic/gossip.spec.ts (onChildDeltas fires per our-coord, epoch-independent, routed)
  - docs/cohort-topic.md (§Topic traffic signal, §Demotion, §Cohort gossip, status footnotes)
----

# Review: cohort-topic child-link replication + unlink on demotion

## What this closes

The prereq (`cohort-topic-parent-child-link`) made a child cohort register with its parent — but FRET routes
that child-link to **one** parent member, so only that member's registry held the child; siblings read
`childCohortCount == 0`. And a child that demoted was never removed, so a parent that had ever parented a
child could never demote. Two gaps, both closed here:

1. **Cohort-wide convergence (union, not max).** The child set is *sharded* across parent members, so a
   per-member count is a shard. Each member now gossips its own child link/unlink **deltas**
   (`CohortGossipV1.childLinks` / `childUnlinks`) and merges inbound ones straight into its per-engine child
   registry (last-writer-wins by `effectiveAt`, keyed by child coord). After one gossip round every parent
   member holds the same **converged union**, so `childCohortCount` (→ demotion gate, gossip summary, traffic
   snapshot) is consistent cohort-wide.
2. **Unlink on demotion.** A demoting child threshold-signs a `DemotionNoticeV1` and fans it to both its own
   served coord (siblings adopt `promoted = false`) **and** its `parentCohortCoord`. At the parent,
   `handleInboundNotice` now runs a **second, independent apply**: it resolves the parent engine, verifies the
   notice against the **child** cohort cert (same threshold verify a sibling runs), and calls
   `unrecordChild`. That release gossips across the parent cohort exactly as the link does, so every member's
   count falls and the parent can shrink in turn.

## Mechanism (where to look)

- **Wire (db-core):** `ChildLinkRefV1` + `CohortGossipV1.childLinks` / `childUnlinks` (`types.ts`), validated
  in `validate.ts`, and — critically — **covered by `cohortGossipSigningPayload`** (`payloads.ts`) so a MITM
  cannot strip/inject a link/unlink. Gossip signatures are recomputed per verify (never persisted), so
  appending fields is safe.
- **Gossip bus (db-core):** `createCohortGossipBus` gained an `onChildDeltas(childLinks, childUnlinks)`
  callback, threaded like `onRecordsEvicted`. It fires for **our-coord** frames **regardless of epoch match**
  — the child set is keyed by child coord, not the parent epoch, so a parent rotation (epoch drift) must not
  skip the merge (record deltas *are* epoch-gated; child deltas are not).
- **Delta queue (db-p2p):** `PendingDeltas` gained `childLink` / `childUnlink` (one keyed queue, last-writer-
  wins by `effectiveAt`, a link+unlink for one child in a round collapses to the newest); `buildCohortGossip`
  packs them and treats a child delta as non-idle.
- **Registry (db-p2p `host.ts`):** `createChildRegistry` now has `unrecordChild`; both mutators are
  freshness-ordered and **return whether they changed state** (the engine re-gossips only real changes; a
  gossip-merged delta is a direct registry write, never re-enqueued — one broadcast reaches the whole cohort).
  A never-seen unlink writes a `linked = false` **tombstone** (never a negative count) so a later stale link
  cannot resurrect a demoted child.
- **Notice path (db-p2p `host.ts`):** `applyDemotionUnlinkAtParent` (exported, unit-testable) verifies against
  the child cohort cert then unrecords; `handleInboundNotice` runs it for every demotion, **independent of the
  sibling-adopt high-water** (that water is keyed by the child coord and would otherwise stale-drop the
  parent-coord copy of the frame after the child-coord copy advanced it). `unrecordChild` was added to the
  `NoticeApplyTarget` slice since the notice-apply path now needs it.

## How to validate

Build + test both packages (both green as handed off):

```
cd packages/db-core && yarn build && yarn test        # 1031 passing, 0 failing
cd packages/db-p2p  && yarn build && yarn test 2>&1 | tee /tmp/dbp2p.log   # 1097 passing, 36 pending, 0 failing
```

Key behaviors the tests assert (treat as the floor, not the ceiling):

- **Union across the cohort** (`gossip-cadence.spec.ts`, two real hosts sharing a gossip transport): two
  children route to two *different* parent members; after one gossip round each way, **both** members read
  `childCohortCount == 2` — the bug a naive max-across-siblings (which would read 1) would hide. Also asserts a
  merged delta is **not** re-gossiped.
- **Unlink convergence** (same file): a linked child is released on one member (effectiveAt newer than the
  link) and gossiped; every member's count returns to 0 (the demotion-gate input).
- **Ordering / tombstone** (same file, real registry): link@t1→unlink@t2 → released; a stale link below the
  high-water is a no-op; a never-seen unlink tombstones and the older link is dropped; a link newer than the
  tombstone re-links.
- **Epoch-drift convergence** (same file + `gossip.spec.ts`): a child link merges even when the frame's
  `cohortEpoch` differs from the receiver's.
- **Parent-unlink via the notice path** (`promote-notice.spec.ts`): parent-only node unrecords + returns
  `"unlinked"`; a **forged** (under-quorum) demotion does NOT unrecord (`"untrusted"`); a **dual-role** node
  applies both the sibling-adopt AND the parent-unlink from one frame, and a replay stale-drops the sibling
  path while the parent-unlink still runs (high-water independence); `"no-parent"` when the node doesn't serve
  the parent coord.
- **Wire** (`wire.spec.ts`): child-delta round-trip, `ChildLinkRefV1` validation, and the signing payload
  distinguishing link vs unlink vs absent.

## Known gaps / where to push (reviewer: treat my tests as a floor)

- **Late-joiner / rotation convergence is NOT closed — filed, not fixed.** A child link/unlink is broadcast
  **once** (drained from the delta queue); there is no periodic re-advertisement. A parent member that
  instantiates its engine *after* a child's delta drained (a membership rotation adds a node) reads a stale
  `childCohortCount` until the next local record/unrecord for that child re-broadcasts. This is
  production-reachable (rotation happens) and could let a rotated-in member originate a spurious demotion, so
  it is a real latent gap — filed as `tickets/backlog/debt-cohort-topic-child-set-late-joiner-resync.md`
  (dormant on in-agent paths: mock tiers don't rotate live-key cohorts, and demotion **endorsement** doesn't
  yet check child count either — parked in `cohort-topic-sign-endorsement-hotcold-refinement`). A `NOTE:`
  tripwire at `createChildRegistry` in `host.ts` points there. **Reviewer: judge whether this should block or
  ship-with-debt; I chose ship-with-debt to stay within the ticket's explicit delta-broadcast design.**
- **Live multi-tier e2e is deferred, not run.** The ticket asked to drive a topic past `cap_promote` so a real
  tier-1 child instantiates + links + later demotes over a live walk. That full path is not reliably driveable
  in the mock mesh — the routed parent member frequently cannot yet resolve the child cohort cert, so the
  live-key child-link RPC stays `awaiting_parent` (a known limitation the prereq documented). I did **not**
  un-skip the two `it.skip` multi-tier tests in `cohort-topic-scale-lifecycle.spec.ts`; I updated the
  demotion one's reason to reflect that the *mechanism* is now implemented + unit/integration-covered and only
  the live mesh instantiation is deferred to the real-libp2p tier / CI. The convergence + unlink logic itself
  is covered by the two-node integration + notice-path unit tests above. **Reviewer: if the real-libp2p tier
  is runnable in your environment, exercising a real record→release cycle end-to-end would be the highest-value
  addition.**
- **Redundant unlink gossip.** A demotion is broadcast to the whole parent cohort, so every parent member that
  holds the child unrecords directly AND enqueues a `childUnlinks` delta — N members re-broadcast the same
  unlink next round. Harmless (idempotent, freshness-protected) and it mirrors the records/evicted pattern
  (each member gossips its own view); noted so it doesn't read as a bug.
- **Two signature verifies on a dual-role node.** A node serving both the child and parent coords verifies the
  same demotion sig twice (sibling-adopt + parent-unlink). The bounded refetch dedups the network fetch;
  dual-role is a `d ≥ 1` rarity. Acceptable, called out for completeness.

## Tripwires (parked, not tickets)

- `NOTE:` at `createChildRegistry` in `host.ts` — the one-shot delta broadcast does not re-sync a member that
  joins after a delta drained; points at `debt-cohort-topic-child-set-late-joiner-resync`.
- (Pre-existing, still valid) `NOTE:` at the `childOverride` read in `traffic.ts` — the max-of-siblings loop
  stays dormant while the registry override is wired; now the override itself converges cohort-wide, so the
  doc's "authoritative on every member" is genuinely true.
