description: When a node newly joins a busy topic's parent group, it doesn't learn how many child groups the parent already has until one of those children next changes — so for a while it undercounts and could wrongly try to shrink the parent while children still exist.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (createChildRegistry, gossipRound child-delta drain)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (PendingDeltas child deltas, buildCohortGossip)
  - docs/cohort-topic.md (§Topic traffic signal, §Cohort gossip)
----

# Child-set convergence for a late-joining / rotated-in parent member

## Background

`cohort-topic-child-link-replicate-unlink` made a parent cohort's **child set** converge across its members
by gossiping per-change **deltas**: when a parent member records a child (a signed `ChildLinkV1` landed on
it) or unrecords one (the child demoted), it enqueues a `childLinks` / `childUnlinks` ref that the **next**
gossip round drains and broadcasts once. Every current parent member merges it, so after one round they all
hold the same converged union and `childCohortCount` is consistent cohort-wide.

The gap: the delta is broadcast **once**. There is no periodic re-advertisement (unlike registration records,
which stay alive because each renewal ping re-enqueues them — a child link has no equivalent renewal; the
child sends its `ChildLinkV1` once and flips to `serving`). So a parent member that joins the cohort **after**
a child's link delta already drained never learns that child.

This is reachable in production: a **parent membership rotation** (or any FRET reshuffle that adds a node to
the parent cohort) instantiates a fresh cohort engine on the newcomer with an **empty** child registry. It
reads `childCohortCount == 0` for children that already exist and stays wrong until the next time some member
locally records/unrecords one of those children (which re-broadcasts a delta).

## Why it matters (and why it's `debt-`, not `bug-`)

The stale `0` is the input to the demotion gate (`promotion.ts` blocks demotion while `childCohortCount > 0`).
A rotated-in member reading `0` could **originate** a demotion for a parent that still has live children —
the exact cross-cohort-disagreement failure the replication work set out to prevent, but for late joiners.

It is filed as `debt-` (not `bug-`) because it is **dormant** on the paths currently exercised in-agent:

- The mock/unit tiers never rotate a live-key parent cohort mid-flight, so no test hits it today.
- Demotion **origination** needs a live key and the full live-tier flow; and the demotion **endorsement**
  gate does not yet check child count anyway (parked in `cohort-topic-sign-endorsement-hotcold-refinement`),
  so the whole "child-count-aware demotion safety" story is already acknowledged as soft/incomplete. This is
  one more piece of that story, not an independently-shipping regression.

A `NOTE:` tripwire at `createChildRegistry` in `host.ts` points a future reader here.

## What to build

Make the child set converge for a member that missed the one-shot delta. Options to weigh (pick during plan):

- **Periodic re-advertisement of the linked set.** On a throttled cadence (e.g. the willingness-heartbeat
  interval), a parent member re-emits its currently-**linked** children as `childLinks` (carrying each child's
  original `effectiveAt`). Safe by construction: the merge is last-writer-wins by `effectiveAt`, so a
  re-advertised link is an idempotent no-op for members that already have it, cannot resurrect a child that a
  newer unlink released (its `effectiveAt` is older), and a still-linked child is exactly what a late joiner
  should learn. Unlinked children are *not* re-advertised — absent = uncounted, which is what a late joiner
  should see. Cost is `O(children)` per throttled round per parent; child counts are small.
  - Requires a `linkedChildren(topicId)` accessor on the child registry (coord + effectiveAt per linked entry)
    and a throttle so it doesn't ship every round.

- **Pull on instantiation.** A freshly-instantiated parent engine asks a co-member for the current child set
  (a snapshot RPC), analogous to the membership-cert / record inventory pulls. Heavier; only helps at join.

Re-advertisement is the lighter fit and mirrors how the rest of this soft-state layer converges.

## Acceptance

- A parent member that instantiates its engine *after* a child's link delta has drained converges on the
  correct `childCohortCount` within one re-advertisement interval (test: two-member parent cohort, member A
  records a child and drains it, THEN a third member B instantiates and — with no further local record on any
  member — converges to `count == 1`).
- Re-advertisement cannot resurrect an unlinked child (a demoted child stays released on every member,
  including one that only ever saw the re-advertised link but also the newer unlink).
- No unbounded traffic growth: the re-advertisement is throttled and `log()`s nothing per-round in steady state.
