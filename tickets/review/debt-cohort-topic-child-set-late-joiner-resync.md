description: A node that joins the group overseeing a busy topic used to never learn how many sub-groups already existed under it. Each member now periodically re-announces the sub-groups it knows about, so a late joiner catches up within about 30 seconds.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (ChildRegistry doc + LinkedChild/linkedChildren ~L1548-1665; lastChildReadvertAt + resync block in gossipRound ~L2006-2050)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (child-set block: extended throttle assertions ~L648; four new tests + threeNodeCohort helper ~L691-820)
  - docs/cohort-topic.md (§Topic traffic signal ~L391; §Cohort gossip ~L1594)
difficulty: medium
----

# Child-set convergence for a late-joining / rotated-in parent member — implemented

## Vocabulary (repeated from the implement ticket so this reads standalone)

- **Cohort** — the small node set jointly responsible for one point on the ring; membership comes from the
  routing layer (FRET) and reshuffles as nodes join and leave.
- **Parent / child cohort** — a busy topic *promotes*: child cohorts are created beneath the parent to absorb
  load. The parent must know how many live children it has.
- **Child link** — the message a newly-promoted child sends up saying "you are my parent". FRET delivers it to
  **exactly one** parent member, so that member alone has first-hand knowledge.
- **Gossip round** — each cohort member periodically broadcasts a small frame to its cohort; state changes are
  queued as **deltas** between rounds and drained into the next frame.

## What was wrong, and what now happens

A child-link delta was broadcast exactly once and nothing re-advertised it. A parent member whose engine was
built *after* that delta drained (a membership rotation, or any FRET reshuffle adding a node to the parent
cohort) started with an empty child registry and read `childCohortCount == 0` for children that plainly
existed. Two consumers read that wrong number: the demotion gate
(`packages/db-core/src/cohort-topic/promotion.ts:327` blocks demotion while `childCohortCount > 0`, so a
rotated-in member could originate a demotion for a parent with live children), and matchmaking search
escalation (`childCohortCount > 0` is the "sweep the child tier" signal, so a seeker whose query landed on
that member was told the topic was not promoted and skipped the sweep).

Implemented exactly the design the ticket settled on — **periodic re-advertisement of the linked set**, not
the rejected snapshot-pull RPC:

- `ChildRegistry` gained `linkedChildren(): readonly LinkedChild[]` — every currently-**linked** child across
  **all** topics (tombstones excluded), each at its original `effectiveAt`. `ChildEntry` now retains the
  original `topicId` / `childCohortCoord` bytes (both already in hand at the single `apply` call site), so the
  accessor needs no key decode. All-topics, not per-topic, is load-bearing: `gossipRound` iterates only
  `residentTopics()`, and a parent whose participants sharded entirely down to its children holds child links
  for a topic it holds no records for.
- `gossipRound` gained a per-engine `lastChildReadvertAt` clock. Immediately **before** `pending.drain()`, if
  that clock is `undefined` or `ctx.willingnessHeartbeatMs` has elapsed, every `linkedChildren()` entry is
  enqueued via `pending.childLink(...)` at its stored `effectiveAt`; the clock advances only if at least one
  entry was enqueued (an engine parenting nothing stays silent, and re-advertises immediately once it does
  hold a child).
- Routed through `PendingDeltas`, never straight into the frame: `queueChild` collapses last-writer-wins per
  `(topic, child)`, so a same-round unlink at a newer `effectiveAt` supersedes the re-advertisement. Sourcing
  from the registry rather than the queue means an unlinked child is never re-advertised, so the one hazard in
  that collapse (equal `effectiveAt`, where `queueChild`'s `effectiveAt < held` guard would let the link win)
  is unreachable.
- No new config knob — reuses `willingnessHeartbeatMs` (default 30 s, already injectable through
  `createCohortTopicHost` options). The coupling is documented in `docs/cohort-topic.md`.
- No `log()` on the re-advertisement path; no `canPublish` gate (a key-less / verify-only engine still
  gossips).

Safety is by construction, not by test luck: the receiving merge is last-writer-wins on `effectiveAt`, so a
re-advertisement is a strict no-op on a member that already holds the link (`apply` requires a *strictly*
newer `effectiveAt`) and cannot resurrect a released child (its `effectiveAt` is older than the unlink's, so
the tombstone's high-water drops it).

## Deliberate behaviours a reviewer should not "fix"

- **A re-advertising round is non-idle on purpose.** `idle` is computed from the drained arrays, so the resync
  builds and broadcasts a frame even for an engine that would otherwise emit nothing. The frame is the
  carrier. Bounded to one extra frame per engine per `willingnessHeartbeatMs` — the same order as the
  willingness heartbeat, and every frame already carries willingness/load.
- **Merged deltas are still never re-gossiped *as deltas*, but they ARE re-advertised.** The bus
  `onChildDeltas` writes the registry directly (no echo). Once merged, that child is part of this member's
  linked set and goes out on the next throttled round — that is how a late joiner's knowledge spreads onward,
  and it is not the echo the existing "a merged child link is not re-gossiped" test guards.
- **A missed *unlink* is not healed.** Absence is not advertised, so a member that dropped an unlink frame
  over-counts until it hears another delta for that child. Both consumers fail conservatively (demotion stays
  blocked; a seeker sweeps a no-longer-promoted tier — wasteful, not wrong). Parked as a `NOTE:` tripwire at
  the re-advertisement site, per the ticket. Deliberately not a ticket.
- **The max-of-siblings fallback in `packages/db-core/src/cohort-topic/traffic.ts:149-159` stays dormant.**
  The child-registry override always wins (`childOverride ?? childCohortCount`; the override returns `0`, not
  `undefined`). That is correct for the sharded-union case — re-enabling the fallback would be a regression.

## Tests — what is covered, and what is not

All in `packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts`, in the existing child-set block. Full
package suite: **2475 passing, 49 pending** (`yarn workspace @optimystic/db-p2p test`). Root `yarn build` and
`yarn typecheck` both clean. No pre-existing failures surfaced.

New / changed:

- *a parent member that joins AFTER the one-shot child link drained converges on the next re-advertisement* —
  the headline case. A new `threeNodeCohort()` helper builds three hosts over one coord. A records the child
  and drains it at `t0`; B (present) learns it; C's engine is instantiated only afterwards and reads `0`. With
  **no further local record/unrecord anywhere**, A's round at `t0 + 30_001` carries the re-advertised link at
  the original `effectiveAt`, and C converges to `1`.
- *the round that drains a fresh local child link does not double-advertise it* — exactly one `childLinks` ref
  in the round that drains a fresh link (the `queueChild` collapse).
- *a re-advertised child link cannot resurrect a released child, in either arrival order* — tombstone-first
  and re-advertisement-first, both settling at `0`. The tombstone-first arm carries a **positive control child
  in the same frame**, so the negative settles on a `waitFor` rather than a sleep.
- *re-advertisement is bounded to one frame per heartbeat and covers topics this engine holds no records for* —
  eight rounds spanning one interval; exactly two carry child links (`1_000`, the drain plus the immediate
  first resync collapsed into one ref, and `31_001`, the next boundary). The child is under `TOPIC2`, for
  which the engine holds **no** registrations, so this is the direct regression test both for the all-topics
  accessor and for the non-idle resync round building a frame at all.
- *the sharded child set converges to a UNION…* (existing test, extended) — the post-merge rounds now assert
  `g.childLinks` is `undefined`, not merely empty, at `2_000` and again at `11_500`. Without the throttle those
  rounds would carry both C1 and C2, so this is the throttle regression test.

**Known gaps — please probe these:**

- Everything is driven through explicit `gossipRound(now)` calls. The real periodic driver
  (`cohort-gossip-driver.ts`) is never exercised against a 30 s resync, so the interaction between
  `gossipIntervalMs` and `willingnessHeartbeatMs` — notably an interval **longer** than the heartbeat, which
  would make every round a resync round — is untested. Worth reasoning about even if not worth a test.
- No test asserts the re-advertisement path works on a **key-less / verify-only** engine (`ctx.signGossip`
  undefined). The code adds no key gate, so it should — but that is an argument, not evidence.
- No multi-tier / real-promotion integration test was added: the late joiner here acquires its child by a
  direct `recordChild` call, not via a real `ChildLinkV1` through FRET dispatch. The lifecycle spec covers the
  dispatch path; nothing covers dispatch **and** rotation together.
- `waitFor` covers the inbound merges; the throttle assertions are synchronous on the returned frame. The only
  async surface is `deliverGossip` → bus merge, which every existing test in the block already relies on.
- Tombstone accumulation is unchanged and unbounded (pre-existing). Recorded as a `NOTE:` at
  `createChildRegistry`, per the ticket. Tombstones cost memory only — `linkedChildren()` excludes them, so
  re-advertisement traffic is bounded by the *live* child count, not the churn history.

## Tripwires parked (index — the analysis lives at the sites)

- `packages/db-p2p/src/cohort-topic/host.ts`, inside the `gossipRound` resync block: a missed **unlink** is not
  healed by re-advertisement; if over-counting ever needs healing, advertise tombstones too.
- `packages/db-p2p/src/cohort-topic/host.ts`, above `createChildRegistry`: released children are kept forever
  as tombstones; if child churn on a long-lived parent ever makes that map large, age them out past a demotion
  horizon.

The stale `NOTE:` in the `ChildRegistry` doc comment that pointed at this ticket slug was removed and replaced
with a description of the actual mechanism. The one remaining occurrence of the slug in the tree is a
provenance marker on the new test section, matching the existing
`(cohort-topic-child-link-replicate-unlink)` marker on the block above it.

## Docs

Both overclaiming passages were rewritten. `docs/cohort-topic.md` §Topic traffic signal now says convergence is
two mechanisms (a one-shot delta on change **plus** re-advertisement of the linked set every
`T_willingness_heartbeat`) and states the missed-unlink asymmetry. §Cohort gossip dropped the bare "a
rotated-in member converges via gossip" claim and gained a paragraph naming the throttle, the knob it reuses,
the non-idle round, and the link-only asymmetry.
