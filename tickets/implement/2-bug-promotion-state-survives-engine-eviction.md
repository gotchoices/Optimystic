description: A node records which recent group-resize instructions it has already carried out, but that record lives only inside a working set the node discards under memory pressure — so after discarding it, an old instruction replayed by anyone on the network gets carried out a second time, leaving the node acting on a group layout that no longer exists.
prereq: bug-coord-engine-eviction-exhaustive-liveness
files:
  - packages/db-p2p/src/cohort-topic/host.ts                          # PromoteGate (2484-2519), broadcastNotice (721-732), handleInboundNotice water gate (2745-2765), CoordEngineContext (548-614), promotion lifecycle wiring (1867-1890)
  - packages/db-core/src/cohort-topic/promotion.ts                    # PromotionState.lastEffectiveAt (94-111), isNewerTransition (~252), stateFor (~390), PromotionDeps (112-140)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts       # broadcastOver excludes self (51-60) — the reason a local origination never sets the water
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts          # highWater tests (~547-608); the test at ~562 encodes the reasoning this ticket corrects
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # "coord-engine registry cap" describe (~650) — home for the eviction+replay regression test
difficulty: hard
repro: static
----

# Give the promotion replay anchor a lifetime that outlives the engine

## Background for a reader with no context

Cohort-topic groups ("cohorts") split when they get busy and merge back when they go quiet. Each transition
is announced as a signed notice — a `PromotionNoticeV1` or `DemotionNoticeV1` — stamped with an
`effectiveAt` timestamp and broadcast to the other members. Because these notices travel in the clear over
a one-way protocol, anyone who saw one holds a permanently valid, correctly-signed copy. Ordering, not
signature validity, is what stops an old copy being re-applied later.

There are two ordering anchors, and each one's documentation cites the other as its backstop:

1. **Node-level** — `PromoteGate.highWater` (`host.ts:2484-2519`), an `LruMap` capped at 8192 keyed
   `` `${cohortCoord}|${tier}` ``, holding the last *applied* `effectiveAt`. `handleInboundNotice` drops an
   at-or-below-water notice before verification. Its doc comment justifies its own LRU eviction as safe:
   *"the engine's `PromotionLifecycle` is independently idempotent and `effectiveAt`-ordered
   (`PromotionState.lastEffectiveAt`), so an evicted-then-replayed older notice … no-ops at the engine."*
2. **Engine-level** — `PromotionState.lastEffectiveAt` (`promotion.ts:103-110`), documented as
   *"Monotonic and **never cleared**"*.

Anchor 1 cites anchor 2 as its backstop. Anchor 2 is inside a `CoordEngine`, which the registry evicts
under memory pressure — so it *is* cleared, and it has no backstop of its own.

## The reachable failure (static — read from the code, not yet run)

`FretCohortGossipTransport.broadcastOver` **excludes self**
(`cohort-gossip-transport.ts:52-56`), and `gate.highWater` is written at exactly one site — after a
verified *inbound* apply (`host.ts:2759`). Therefore **a notice this node originates itself never advances
the node-level water for its own coord.** For a coord whose transitions this node originated, anchor 2 is
the *only* anchor there has ever been.

Sequence, for node `M` at served coord `C`, topic `T`:

1. `M` originates a promotion at `effectiveAt = 100` (`promotion.ts` `promote()`): engine
   `lastEffectiveAt = 100`, `promoted = true`. Node water for `C`: **absent**.
2. Load falls; `M` originates a demotion at `effectiveAt = 200` (`demote()`): engine
   `lastEffectiveAt = 200`, `promoted = false`. Node water: still **absent**.
3. `T`'s participants shard down to the children and their records TTL-sweep; the topic budget evicts the
   drained topic and tears down its forwarder (`TopicBudget.onEvict` → `coldStart.remove` +
   `traffic.forget`). The engine now holds no records and no forwarder.
4. Memory pressure (or an attacker spraying distinct coords — the served coord is a hash over
   attacker-chosen inputs) evicts the engine. `lastEffectiveAt = 200` is gone.
5. Anything recreates the engine at `C` — a routed register, a child link, a co-member gossip frame.
   (`handleInboundNotice` resolves by `registry.findByCoord`, which does **not** create, so a replay
   arriving before recreation is merely `"dropped"`. Recreation happens on its own under normal traffic.)
6. Anyone replays the captured, genuinely-signed promotion notice from step 1. Water absent → no stale
   drop. Signature verifies (it always did). The fresh engine has `lastEffectiveAt === undefined`, so
   `isNewerTransition` returns true and it adopts `promoted = true`.

`M` now answers registrations for `T` with `Promoted(d+1)`, redirecting participants to a child tier that
was demoted away. The per-`(peer, topic)` rate limiter does not help: one replay is enough.

**A second, replay-free arm of the same loss.** Even with no attacker, step 4 discards a *correct*
`promoted = true`. Nothing restores it: the `promoted` flag gossiped in `CohortTopicSummary` lands in the
sibling `CohortView`, never in the local `PromotionLifecycle`. A recreated engine for a genuinely promoted
topic reports `promoted = false` and admits registrations directly at tier `d` instead of redirecting —
over-admission against a tree that has already split. So the fix must restore the transition's *direction*,
not only its timestamp.

`bug-coord-engine-eviction-exhaustive-liveness` (prereq) makes such an engine the *last* eviction candidate
rather than an arbitrary one. That reduces how often step 4 happens; it does not make the anchor durable,
and under a large enough spray the engine is still evicted. This ticket makes it durable.

## Root cause

**The node's record of which transitions it has adopted is stored only in an object whose lifetime is a
memory-pressure decision.** The one structure that already outlives engines — `PromoteGate.highWater` —
is scoped as an inbound-replay optimisation rather than as the node's record, so it misses locally
originated transitions entirely and stores only a timestamp, not the adopted state.

## The fix

Promote `PromoteGate.highWater` from "early-drop optimisation for inbound frames" to **the node's record of
the last promotion/demotion transition adopted per served cohort, per topic** — written by every path that
adopts one, read by both the inbound stale gate and by a freshly created engine.

### 1. Store the transition, not just its timestamp

```ts
/** The last promotion/demotion transition this node adopted for one (cohort coord, tier, topic). */
export interface AdoptedTransition {
	/** The notice's `effectiveAt`. Monotonic per key: only a strictly-newer transition replaces it. */
	readonly effectiveAt: number;
	/** Which way it went — `true` for a promotion, `false` for a demotion. Restores direction, not just order. */
	readonly promoted: boolean;
}
```

`PromoteGate.highWater: LruMap<string, number>` becomes
`PromoteGate.transitions: LruMap<string, AdoptedTransition>`. Keep `PROMOTE_HIGHWATER_MAX_KEYS` (8192) as
the cap and rename it to match; the map is written only on an adopted transition, so it stays
attacker-ungrowable and its 8192 keys stay comfortably above the 2048-engine registry cap — which is the
real reason its own eviction is safe, and what its doc comment should say instead of citing the engine.

### 2. Key it by topic as well as coord

Today's key is `` `${cohortCoord}|${tier}` ``. A `CoordEngine` serves several topics (that is what its
`TopicBudget` bounds) and `PromotionState` is per topic, so one key conflates topics at one coord: an
applied notice for topic A stale-drops a legitimate notice for topic B at the same coord. Key it
`` `${cohortCoord}|${tier}|${topicId}` `` and build it in one exported helper —
`noticeTransitionKey(notice)` — used by every reader and writer, so the key can never drift between sites.
The map stays non-attacker-growable (still written only on an adopted transition).

### 3. Write it on local origination too

Both origination paths funnel through one host-level function, `broadcastNotice(notice, servedCoord)`
(`host.ts:721`) — promotions via `onNotice` (`host.ts:1987`), demotions via `demotionTick`
(`host.ts:2106`). Record the transition there, keyed off `notice.cohortCoord` (**not** the parent coord a
demotion also fans to — the parent-unlink path is deliberately outside this ordering, ordered instead by
the child registry's own per-child `lastEffectiveAt`). Advance only on a strictly-newer `effectiveAt`, so
the map is monotonic per key regardless of which path writes it.

### 4. Seed a newly created engine from it

Add to `PromotionDeps` (`promotion.ts`):

```ts
/**
 * The transition this node last adopted for `topicId` at this engine's served coord, from a node-level
 * store that outlives the engine (the promote gate's adopted-transition map). Consulted once, lazily, when
 * per-topic state is first created — so an engine re-created after eviction neither re-applies a transition
 * the node already adopted nor forgets that it is promoted. `undefined` → no prior transition.
 */
seedTransition?: (topicId: Uint8Array) => { readonly effectiveAt: number; readonly promoted: boolean } | undefined;
```

`stateFor` seeds `lastEffectiveAt` and `promoted` from it on first creation. When it seeds
`promoted === true` it must also set `promotedAt` to the seeding `now`: `promotedAt` is the sticky-window
anchor and is not recoverable, and re-arming it is the conservative direction (it delays demotion rather
than allowing an early one). `lowLoadSince` is left `undefined` — it is rebuilt from the store on the next
`onParticipantCountChange`. Document both choices at the seed site.

Thread it through `CoordEngineContext` as a narrow reader (`adoptedTransition(coord, tier, topicId)`), wired
at the host to the promote gate — the engine must not hold the gate itself.

The direction is strictly one-way: node-level map → engine. No path writes the engine's `lastEffectiveAt`
back into the map except through the two adopt sites above, so the circular "each layer backstops the
other" reasoning is gone.

### 5. Correct the two comments that state the wrong reasoning

- `PromoteGate.highWater`'s doc comment (`host.ts:2498-2506`) claims eviction is safe because the engine
  no-ops a stale replay. Replace with: the map is the node's durable record, its cap exceeds the engine
  registry cap, and it is written only on adopted transitions so it is not attacker-growable.
- `promote-notice.spec.ts:562` — *"an evicted high-water lets a stale replay re-verify but the engine
  idempotently no-ops it (no regression)"* — its comment calls the engine "the idempotency authority".
  The assertions still hold (no engine is evicted in that test); rewrite the comment to describe the map as
  the authority and the engine as the same-process second layer.

## Edge cases & interactions

- **Replay after eviction + recreation** — the headline regression test. A stale promotion replayed at a
  recreated engine must be dropped, and `isPromoted` must remain what the newest transition said.
- **A correct `promoted = true` survives eviction.** Recreate an engine for a promoted topic with no replay
  at all; it must still report `isPromoted === true`.
- **Locally-originated transitions are covered.** The map must be non-empty for a coord whose only
  transitions this node originated — the case self-exclusion in `broadcastOver` leaves uncovered today.
- **Two topics at one coord do not share an ordering.** An applied notice for topic A must not stale-drop a
  legitimate notice for topic B at the same `(coord, tier)`.
- **Two sibling cohorts for one `(topic, tier)` still do not share one.** The existing coord-keying
  guarantee must survive the key change (this is why coord stays in the key).
- **Forged notices still write nothing.** The existing test (`promote-notice.spec.ts:593`) must stay green
  against the renamed map: only an adopted transition writes it.
- **Map eviction beyond the cap.** Overflow the 8192-key cap and confirm the LRU still evicts, and that the
  cap-behaviour test (`~547`) passes against the new value type.
- **The parent-unlink path stays outside this ordering.** A demotion fanned to the parent coord must still
  unrecord the child even when the sibling-adopt for the child coord already advanced the map — the
  existing `"unlinked"` outcome must not regress to `"stale"`.
- **Demotion seeding.** A seeded `promoted === false` with a real `lastEffectiveAt` must still reject a
  stale *promotion* replay — the ordering, not the direction, is what does the rejecting.
- **Key-less composition.** The remote-apply path needs no local key, so seeding and the map must work with
  no `privateKey`; `seedTransition` / `adoptedTransition` are optional for unit composition.
- **Interaction with the prereq.** With `bug-coord-engine-eviction-exhaustive-liveness` landed, an engine
  holding promotion state is rank-1 rather than rank-0. The regression tests here must force eviction
  explicitly (fill the cap with rank-1 engines, or drive enough new coords) rather than assuming the
  promotion-holding engine is picked first.

## Expected behaviour

- A promotion or demotion notice this node has already adopted — whether it originated it or learned it —
  is never applied a second time, no matter how many times its engine has been evicted and recreated.
- A recreated engine reports the same `isPromoted` the node last adopted for that topic.
- The node's record of adopted transitions is written by every adopt path and read by every ordering
  decision, through one key helper.

## TODO

- Rename `PromoteGate.highWater` → `transitions` and change its value type to `AdoptedTransition`; rename
  `PROMOTE_HIGHWATER_MAX_KEYS` to match and keep the 8192 cap.
- Add and export `noticeTransitionKey(notice)` building `` `${cohortCoord}|${tier}|${topicId}` ``; use it at
  every read and write site.
- Rewrite the stale gate in `handleInboundNotice` to read `transitions` through the helper and compare
  `effectiveAt`; keep the "advance only on an `applied` outcome" rule for the inbound path.
- Record the transition in the host's `broadcastNotice` (`host.ts:721`) for the notice's own
  `cohortCoord` only, advancing on a strictly-newer `effectiveAt`.
- Add `PromotionDeps.seedTransition` and seed `lastEffectiveAt` / `promoted` / `promotedAt` in `stateFor`
  (`promotion.ts`), with the documented `promotedAt = now` and `lowLoadSince = undefined` choices.
- Add `CoordEngineContext.adoptedTransition(coord, tier, topicId)`, wire it at the host to the promote gate,
  and pass it into `createPromotionLifecycle` in `createCoordEngine`.
- Update `PromotionState.lastEffectiveAt`'s doc comment: it is no longer the durable anchor — say it is the
  in-engine layer seeded from the node's record, and name that record.
- Fix the two wrong-reasoning comments (`host.ts:2498-2506`, `promote-notice.spec.ts:562`).
- Tests in `packages/db-p2p/test/cohort-topic/promote-notice.spec.ts`:
  - a locally-originated transition (driven through the host's `broadcastNotice` seam) writes the map;
  - two topics at one `(coord, tier)` keep independent orderings;
  - the existing cap / forged-notice / parent-unlink tests pass against the renamed map.
- Test in `packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts` (`coord-engine registry cap`
  describe — its harness drives `host.registry.forCoord` / `findByCoord` and small `coordEnginesMax`
  directly): adopt a promotion, evict the engine by filling the cap, re-resolve the coord, and assert both
  (a) `isPromoted` is still true, and (b) replaying the older notice through `handleInboundNotice` returns
  `"stale"` and leaves the state unchanged.
- Run `yarn test` in `packages/db-p2p` and `packages/db-core`, plus `yarn build` + `yarn typecheck` from
  root. Narrow with `yarn test -- --grep "promote"` for the inner loop.
