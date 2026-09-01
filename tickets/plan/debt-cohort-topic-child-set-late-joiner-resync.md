description: When a node newly joins the group that oversees a busy topic, it never learns how many sub-groups already exist under it — so it undercounts them, and can both wrongly agree to shut one down and give search queries a wrong answer about where to look.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (ChildRegistry / createChildRegistry ~L1567-1628; gossipRound ~L1976-2018; recordChild/unrecordChild ~L2072-2082)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (PendingDeltas.childLink/childUnlink, buildCohortGossip, DEFAULT_WILLINGNESS_HEARTBEAT_MS)
  - packages/db-core/src/cohort-topic/promotion.ts (L327 — the demotion gate that reads the count)
  - packages/db-core/src/cohort-topic/traffic.ts (L149-159 — the registry override that shadows the max-of-siblings fallback)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (L574+ — the existing two-member child-set convergence tests; the new test belongs here)
  - docs/cohort-topic.md (L391-398 §Topic traffic signal; L1594-1601 §Cohort gossip — both currently overclaim)
difficulty: medium
repro: static
severity: wrong-result
likelihood: unusual
----

# Child-set convergence for a late-joining / rotated-in parent member

## Vocabulary (read this first)

- **Cohort** — the small set of nodes jointly responsible for one point on the ring. Membership is derived
  from the routing layer (FRET) and reshuffles as nodes come and go.
- **Parent / child cohort** — when a topic gets busy, its cohort *promotes*: a tier of child cohorts is
  created beneath it to absorb the load. The cohort above is the **parent**; each cohort beneath is a
  **child**. A parent needs to know how many live children it has.
- **Child link** — the signed message a newly-promoted child sends up to say "you are my parent". FRET
  delivers it to **exactly one** member of the parent cohort, so that member alone has first-hand knowledge.
- **Gossip round** — every few seconds (`DEFAULT_GOSSIP_INTERVAL_MS`, 5 s) each cohort member broadcasts a
  small frame to its cohort. Deltas are appended to a queue between rounds and drained into the next frame.

## Background — what exists today

`cohort-topic-child-link-replicate-unlink` made the parent cohort's **child set** converge across members by
gossiping per-change **deltas**. When a parent member records a child (a signed child link landed on it) or
unrecords one (that child demoted), it enqueues a `childLinks` / `childUnlinks` ref; the next gossip round
drains and broadcasts it once. Every member merges inbound deltas straight into its own child registry
(last-writer-wins by `effectiveAt` per `(topic, childCohortCoord)`), so after one round all members hold the
same union and `childCohortCount` agrees cohort-wide.

## The gap

**A child-link delta is broadcast exactly once.** Nothing re-advertises it.

Registration records do not have this problem: each participant renewal ping re-enqueues the record, so a
late-joining member picks them up on the next ping. A child link has no equivalent renewal — the child sends
its link once and flips to `serving`.

So a parent member whose engine is instantiated **after** a child's link delta already drained never learns
that child. This is reachable in production: a parent membership rotation (or any FRET reshuffle adding a
node to the parent cohort) builds a fresh cohort engine with an **empty** child registry
(`createChildRegistry()` at `host.ts` ~L1643). It reads `childCohortCount == 0` for children that plainly
exist, and stays wrong until some member happens to locally record or unrecord one of those children.

Note this used to be self-healing by accident and no longer is. `traffic.ts` computes a max of siblings'
gossiped `childCohortCount` values, which would have pulled a late joiner up — but the child-registry
override now always wins (`childOverride ?? childCohortCount`, and the override returns `0`, not
`undefined`). That is deliberate and correct for the sharded-union case; it is called out here only so a
planner does not mistake the dormant fallback for a fix.

## Two consumers read the wrong number

1. **The demotion gate** (`promotion.ts:327`) blocks demotion while `childCohortCount > 0`. A rotated-in
   member reading `0` could **originate** a demotion for a parent that still has live children — exactly the
   cross-cohort disagreement the replication work set out to prevent, now via the late-joiner path.
2. **Matchmaking search escalation.** `childCohortCount > 0` is the "this topic is hot, descend / sweep the
   child tier" signal (`matchmaking/seeker-walk.ts`, `matchmaking/voting-quorum.ts:294`, served from
   `topicTraffic()` → `traffic.snapshot()` → the same registry). A seeker whose query happens to land on the
   late-joining member is told the topic is not promoted and skips the multi-cohort sweep, so it finds fewer
   peers than it should. Degraded results rather than corruption, but it is a second, independent symptom of
   the same one stale value.

## Why this was filed as debt rather than a bug

Dormant on every path currently exercised in-agent: no test rotates a live-key parent cohort mid-flight;
demotion **origination** needs a live key and the full live-tier flow; and the demotion **endorsement** side
does not check child count at all yet (parked in `cohort-topic-sign-endorsement-hotcold-refinement`). A
`NOTE:` tripwire on the `ChildRegistry` interface doc in `host.ts` points a reader here. The maintainer's
deferral argument, recorded when this was filed: the child-count-aware demotion-safety story is already
acknowledged as incomplete, so this could reasonably wait and land with the rest of it.

## What to build

Make the child set converge for a member that missed the one-shot delta. Two candidate designs — the plan
stage picks one and says why.

### Option A — periodic re-advertisement of the linked set (favoured)

On a throttled cadence (the willingness-heartbeat interval, `DEFAULT_WILLINGNESS_HEARTBEAT_MS` = 30 s, is the
natural peer), each parent member re-emits its currently-**linked** children as `childLinks`, each carrying
that child's original `effectiveAt`.

Safe by construction, because the merge is last-writer-wins on `effectiveAt`:

- a re-advertised link is an idempotent no-op on any member that already holds it;
- it **cannot resurrect** a child released by a newer unlink — the re-advertised `effectiveAt` is older, so
  the merge drops it;
- unlinked children are deliberately **not** re-advertised: absent means uncounted, which is exactly what a
  late joiner should see.

Cost is `O(linked children)` per throttled round per parent; child counts are small.

Needs: a `linkedChildren(topicId)` accessor on `ChildRegistry` (child coord + `effectiveAt` per linked entry
— the registry currently exposes only `count`), and a per-engine throttle clock so re-advertisement does not
ship every 5 s round.

Two details the plan should settle explicitly:

- **Route or bypass `PendingDeltas`?** Enqueuing re-ads via `pending.childLink` reuses the existing
  last-writer-wins collapse (a genuine same-round unlink correctly supersedes a re-ad). That looks right, but
  it also means a re-advertisement round makes an otherwise-idle engine non-idle in `buildCohortGossip` —
  decide whether that is acceptable or whether re-ads should ride only on frames that would be emitted anyway.
- **Does re-advertisement stay silent in steady state?** No `log()` per round, and no growth in frame count
  beyond one throttled frame per interval per parent engine.

### Option B — pull on instantiation

A freshly-instantiated parent engine asks a co-member for the current child set via a snapshot RPC, mirroring
the membership-cert / record-inventory pulls. Heavier (new protocol surface) and it only helps at join — it
does nothing for a member that was present but missed a frame. Re-advertisement is the lighter fit and
matches how the rest of this soft-state layer converges.

## Acceptance

- A parent member that instantiates its engine **after** a child's link delta has drained converges on the
  correct `childCohortCount` within one re-advertisement interval. Test shape, in
  `packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts` alongside the existing union test: members A and
  B form a parent cohort, A records a child and drains/delivers that round, **then** member C's engine is
  created — and with no further local record on any member, C converges to `count == 1`.
- Re-advertisement cannot resurrect an unlinked child: a demoted child stays released on every member,
  including one that saw the re-advertised link *and* the newer unlink, in either arrival order.
- No unbounded traffic growth: re-advertisement is throttled and logs nothing per round in steady state.
- `docs/cohort-topic.md` is corrected. Both §Topic traffic signal (L391-398) and §Cohort gossip (L1594-1601)
  currently assert "a rotated-in member converges via gossip" without qualification, which is only true once
  this lands. Update them to describe the actual convergence mechanism, and remove the `NOTE:` tripwire on
  `ChildRegistry` in `host.ts` that points at this ticket.
