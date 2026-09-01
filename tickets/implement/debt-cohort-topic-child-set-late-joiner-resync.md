description: When a node newly joins the group overseeing a busy topic, it never learns how many sub-groups already exist under it, so it undercounts them — it can wrongly agree to shut one down, and it gives search queries a wrong answer about where to look. Fix by having each member periodically re-announce the sub-groups it knows about.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (ChildRegistry / createChildRegistry ~L1548-1628; createCoordEngine ~L1643; gossipRound ~L1976-2018)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (PendingDeltas.childLink, DEFAULT_WILLINGNESS_HEARTBEAT_MS ~L51 — reference only, no change expected)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (L573+ — the existing child-set convergence block; the new tests belong here)
  - docs/cohort-topic.md (L391-398 §Topic traffic signal; L1594-1601 §Cohort gossip — both currently overclaim)
difficulty: medium
----

# Child-set convergence for a late-joining / rotated-in parent member

## Vocabulary (read this first)

- **Cohort** — the small set of nodes jointly responsible for one point on the ring. Membership comes from
  the routing layer (FRET) and reshuffles as nodes join and leave.
- **Parent / child cohort** — when a topic gets busy its cohort *promotes*: a tier of child cohorts is created
  beneath it to absorb the load. The cohort above is the **parent**, each cohort beneath a **child**. A parent
  must know how many live children it has.
- **Child link** — the message a newly-promoted child sends up to say "you are my parent". FRET delivers it to
  **exactly one** member of the parent cohort, so that member alone has first-hand knowledge.
- **Gossip round** — every 5 s (`DEFAULT_GOSSIP_INTERVAL_MS`) each cohort member broadcasts a small frame to
  its cohort. State changes are queued as **deltas** between rounds and drained into the next frame.

## The defect

A child-link delta is broadcast **exactly once**. Nothing re-advertises it.

Registration records do not have this problem — each participant renewal ping re-enqueues the record, so a
late-joining member picks records up on the next ping. A child link has no equivalent renewal: the child sends
its link once and flips to `serving`.

So a parent member whose engine is instantiated **after** a child's link delta already drained never learns
that child. Reachable in production: a parent membership rotation (or any FRET reshuffle adding a node to the
parent cohort) builds a fresh cohort engine with an **empty** child registry (`createChildRegistry()` at
`host.ts:1643`). It reads `childCohortCount == 0` for children that plainly exist, and stays wrong until some
member happens to locally record or unrecord one of those children.

Two consumers read the wrong number:

1. **The demotion gate** (`packages/db-core/src/cohort-topic/promotion.ts:327`) blocks demotion while
   `childCohortCount > 0`. A rotated-in member reading `0` could **originate** a demotion for a parent that
   still has live children.
2. **Matchmaking search escalation.** `childCohortCount > 0` is the "this topic is hot, sweep the child tier"
   signal (`matchmaking/seeker-walk.ts`, `matchmaking/voting-quorum.ts:294`, served from `topicTraffic()` →
   `traffic.snapshot()` → the same registry). A seeker whose query lands on the late-joining member is told the
   topic is not promoted and skips the multi-cohort sweep, finding fewer peers than it should.

The max-of-siblings fallback in `packages/db-core/src/cohort-topic/traffic.ts:149-159` would once have healed
this by accident, but the child-registry override now always wins (`childOverride ?? childCohortCount`, and
the override returns `0`, not `undefined`). That is deliberate and correct for the sharded-union case — do not
"fix" this by re-enabling the fallback.

## The design (settled — build this, not Option B from the plan ticket)

**Periodic re-advertisement of the linked set.** On a throttled cadence each parent member re-emits its
currently-**linked** children as `childLinks` deltas, each carrying that child's original `effectiveAt`.

Safe by construction, because the receiving merge is last-writer-wins on `effectiveAt`:

- a re-advertised link is an idempotent no-op on any member that already holds it (`apply` requires a
  *strictly* newer `effectiveAt` to change state);
- it **cannot resurrect** a child released by a newer unlink — the re-advertised `effectiveAt` is older than
  the unlink's, so the merge drops it against the tombstone's high-water;
- unlinked children are deliberately **not** re-advertised: absent means uncounted, which is exactly what a
  late joiner should see.

The plan-stage alternative (a snapshot-pull RPC on engine instantiation) is **rejected**: it adds protocol
surface and only helps at join — it does nothing for a member that was present but missed a frame.
Re-advertisement is the lighter fit and matches how the rest of this soft-state layer converges.

### Where each piece goes

**`ChildRegistry` gains a `linkedChildren()` accessor** (`host.ts:1567`), returning every **linked** entry
across **all** topics:

```ts
/** One linked child cohort, as re-advertised by the throttled resync round. */
interface LinkedChild {
	topicId: Uint8Array;
	childCohortCoord: Uint8Array;
	effectiveAt: number;
}

interface ChildRegistry {
	recordChild(topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): boolean;
	unrecordChild(topicId: Uint8Array, childCohortCoord: Uint8Array, effectiveAt: number): boolean;
	count(topicId: Uint8Array): number;
	/** Every currently-linked child across all topics (tombstones excluded). */
	linkedChildren(): readonly LinkedChild[];
}
```

Note it is **all topics**, not the per-topic signature the plan ticket sketched. `gossipRound` only iterates
`residentTopics()` (store records + cold-start forwarders), and a parent can hold child links for a topic it
holds no records for (participants sharded down to the children), so a per-topic accessor would silently miss
exactly the parents that matter. To keep the accessor total, have `apply` retain the original `topicId` /
`childCohortCoord` bytes on `ChildEntry` — both are already in hand at the one call site, so this costs no
decode and no extra key parsing.

**`gossipRound` re-advertises before it drains.** Add a per-engine clock beside `lastGossipAt`:

```ts
// Timestamp of the last round in which this engine re-advertised its linked child set, or `undefined` if it
// never has. Bounds child-set resync to one frame per `T_willingness_heartbeat`, not one per 5 s round.
let lastChildReadvertAt: number | undefined;
```

and, in `gossipRound` immediately **before** `pending.drain()`:

- if `lastChildReadvertAt === undefined || now - lastChildReadvertAt >= ctx.willingnessHeartbeatMs`, walk
  `childRegistry.linkedChildren()` and `pending.childLink(...)` each entry with its stored `effectiveAt`;
- set `lastChildReadvertAt = now` only if at least one entry was enqueued (an engine that parents nothing must
  not start its clock, and must stay silent).

**Route re-advertisements through `PendingDeltas`, do not bypass it.** Two reasons, both load-bearing:

- `queueChild` already collapses last-writer-wins per `(topic, child)`, so a genuine same-round unlink queued
  at a newer `effectiveAt` correctly supersedes the re-advertisement rather than racing it.
- Sourcing the re-advertisement from the **registry** (not from the queue) means an unlinked child is never
  re-advertised at all, so the one hazard in that collapse — a queued unlink and a re-advertised link at the
  *equal* `effectiveAt`, where `queueChild`'s `effectiveAt < held` guard would let the link win — is
  unreachable: a child with a queued unlink is not in `linkedChildren()`.

**A re-advertisement round is deliberately non-idle.** `idle` in `gossipRound` is computed from the drained
arrays, so a re-advertisement round builds and broadcasts a frame even for an engine that would otherwise emit
nothing. That is the point — the frame is the carrier. It is bounded to one frame per
`ctx.willingnessHeartbeatMs` per parent engine, the same order as the willingness heartbeat, and every frame
already carries willingness/load, so nothing else regresses.

**No new config knob.** Reuse the existing `willingnessHeartbeatMs` engine context field
(`DEFAULT_WILLINGNESS_HEARTBEAT_MS` = 30 s, already injectable via `createCohortTopicHost` options). The two
cadences are the same order and the same kind of thing (soft-state re-advertisement); lengthening one
lengthens child-set convergence equally, which is acceptable. Document the coupling; do not add a second
option.

**Silence in steady state.** No `log()` per round from the re-advertisement path.

## Edge cases & interactions

- **The first round after a local `recordChild`.** `lastChildReadvertAt` starts `undefined`, so the first
  round with linked children re-advertises immediately (mirroring the willingness heartbeat's immediate-first
  behaviour). That round already carries the real link delta at the same `effectiveAt`, and `queueChild`
  collapses them to one ref — verify no duplicate `childLinks` entry appears in that frame.
- **Throttle.** Rounds inside one `willingnessHeartbeatMs` window after a re-advertisement must carry no
  child deltas at all (assert `g.childLinks` is absent, not merely short).
- **Merged deltas are never re-gossiped as deltas — but they *are* re-advertised.** The existing bus
  `onChildDeltas` writes the registry directly so a received link is not immediately echoed. Once merged, that
  child is part of this member's linked set and *will* be re-advertised on the next throttled round. That is
  correct (it is how a late joiner's knowledge spreads onward) and must not be mistaken for the echo the
  existing "a merged child link is not re-gossiped" test guards — keep that test passing by only enqueuing
  re-advertisements on the throttled boundary.
- **Resurrection, both arrival orders.** A member holding a tombstone (`unlink@2000`) must stay at `count == 0`
  when a re-advertised `link@1000` arrives; and a member that receives the re-advertised `link@1000` first and
  the `unlink@2000` after must also settle at `0`.
- **A missed *unlink* is not healed by this.** Absence is not advertised, so a member that was present and
  dropped an unlink frame keeps over-counting until it hears another delta for that child. Both consumers fail
  *conservatively* there (demotion is blocked, and a seeker sweeps a tier that is no longer promoted —
  wasteful, not wrong), so this is out of scope. Leave a `NOTE:` tripwire at the re-advertisement site saying
  so; do **not** file a ticket for it.
- **Tombstone accumulation.** `ChildRegistry` never prunes released children, so a long-lived engine's map
  grows with child churn. Tombstones are excluded from `linkedChildren()`, so they cost memory only, never
  traffic — re-advertisement volume is bounded by the count of *live* children. Pre-existing and unchanged by
  this ticket; record it as a `NOTE:` at `createChildRegistry`, not as a ticket.
- **Key-less / verify-only engines.** Re-advertisement must not depend on `canPublish` — a key-less engine
  still gossips (`ctx.signGossip` is optional and `gossipRound` handles its absence). Do not add a key gate.
- **Epoch drift.** Child deltas merge regardless of `cohortEpoch` (unlike record deltas). Re-advertisement
  inherits that; the existing epoch-drift test must keep passing.
- **Engine eviction.** The registry is per-engine, so an idle-evicted engine takes its child set with it and a
  re-instantiated one relearns via the next re-advertisement from a surviving member. No teardown work needed.

## Tests (`packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts`, in the existing child-set block)

The existing block's helpers — `twoNodeCohort()` (L423), `childCoord(seed)` (L574), `deliverGossip`,
`signedGossip`, `encodeCohortMessage` — cover everything needed. `gossipRound` takes an explicit `now`, so the
30 s throttle needs no clock injection and no `gossipIntervalMs` change: just call it at `t0` and `t0 + 30_001`.

- **Late joiner converges.** A and B form the parent cohort; A `recordChild(TOPIC, c1, 1_000)` and its round at
  `t0` drains the link and is delivered to B. **Then** create a third member C's engine (a third host over the
  same `coord0`, with `cohortFor` returning all three so C's inbound co-member gate passes) — C starts empty
  and `childCohortCount == 0`. With **no further local record on any member**, A's round at `t0 + 30_001`
  carries the re-advertised `childLinks`; deliver it to C and `waitFor` `eC.childCohortCount(TOPIC) === 1`.
- **Throttle holds.** In the same setup, A's round at `t0 + 10_000` (inside the window) has `childLinks`
  undefined. Extend the existing "a merged child link is not re-gossiped" assertion rather than duplicating it.
- **First round does not double-advertise.** The round that drains a fresh local link carries exactly **one**
  `childLinks` entry, not two.
- **Re-advertisement cannot resurrect, both orders.** On one engine: apply `unlink@2000` then deliver a
  hand-built re-advertisement frame carrying `link@1000` → `count` stays `0`. Reverse: deliver `link@1000`
  first, then `unlink@2000` → settles at `0`.
- **Bounded traffic.** Across several rounds spanning one interval, exactly one frame carries `childLinks`.

Run: `yarn workspace @optimystic/db-p2p test -- --grep "child"` for the inner loop, then the package's full
`yarn test` before handing off.

## Docs

- `docs/cohort-topic.md` §Topic traffic signal (L391-398) and §Cohort gossip (L1594-1601) both currently assert
  cohort-wide convergence — and the second says outright that "a rotated-in member converges via gossip" —
  without qualification. That is only true once this lands. Rewrite both to name the actual mechanism: one-shot
  deltas on change, plus a re-advertisement of the linked set every `T_willingness_heartbeat`, and state
  explicitly that a missed **unlink** is not re-advertised (absence means uncounted) and fails conservatively.
- Remove the `NOTE:` tripwire in the `ChildRegistry` doc comment (`host.ts:1563-1566`) that points at
  `debt-cohort-topic-child-set-late-joiner-resync`.

## TODO

- Add `LinkedChild` + `linkedChildren()` to `ChildRegistry`; retain the `topicId` / `childCohortCoord` bytes on
  `ChildEntry` in `apply` so the accessor is total across all topics.
- Add the `lastChildReadvertAt` clock to `createCoordEngine` and the throttled re-advertisement enqueue in
  `gossipRound`, immediately before `pending.drain()`; set the clock only when something was enqueued.
- Add the `NOTE:` tripwires: missed-unlink-not-healed at the re-advertisement site; tombstone accumulation at
  `createChildRegistry`.
- Remove the stale `NOTE:` tripwire from the `ChildRegistry` doc comment.
- Add the five tests above to the child-set block in `gossip-cadence.spec.ts`.
- Update both `docs/cohort-topic.md` sections.
- `yarn workspace @optimystic/db-p2p test`, then `yarn build && yarn typecheck` from root.
