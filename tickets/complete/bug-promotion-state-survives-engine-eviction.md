description: A node used to forget which group-resize instructions it had already carried out whenever it ran low on memory, so an old instruction replayed by anyone could be carried out a second time; the record it keeps now lives outside the memory it discards, and is consulted whenever that memory is rebuilt.
files:
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-core/src/cohort-topic/promotion.ts
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts
  - packages/db-core/test/cohort-topic/promotion.spec.ts
  - docs/cohort-topic.md
----

# Complete: promotion replay ordering now outlives engine eviction

## Background for a reader with no context

Cohort-topics split into child groups when they get busy ("promotion") and merge back when they go
quiet ("demotion"). Each transition is announced on the network as a threshold-signed notice
(`PromotionNoticeV1` / `DemotionNoticeV1`) carrying an `effectiveAt` timestamp. Those signatures never
expire, so a notice captured off the wire stays valid forever — **the only defense against someone
replaying an old one is ordering**: a node must refuse a notice that is not strictly newer than the
last transition it already adopted for that group.

Before this work, the ordering lived in two places that each cited the other as backstop, leaving
three holes:

1. A node that **originated** a transition itself never wrote its own node-level mark (the broadcast
   path excludes self), so originate promote@100 → demote@200 → evict the engine → a replayed
   promote@100 re-promoted a cohort that had since demoted.
2. Eviction also discarded a **correct** `promoted = true`, so a node could silently forget it was
   promoted.
3. The node-level key was `coord|tier`, conflating topics: topic A's newer transition stale-dropped
   topic B's legitimate one at the same coordinate and tier.

## What landed (implement stage)

**db-p2p — `host.ts`**

- `PromoteGate.highWater: LruMap<string, number>` → `PromoteGate.transitions: LruMap<string, AdoptedTransition>`,
  where `AdoptedTransition = { readonly effectiveAt: number; readonly promoted: boolean }`. Constant
  renamed `PROMOTE_HIGHWATER_MAX_KEYS` → `PROMOTE_TRANSITIONS_MAX_KEYS` (still 8192, still LRU).
- Key now includes the topic: `transitionKey(cohortCoordB64, tier, topicIdB64)`.
  `noticeTransitionKey(notice)` derives it from either notice kind — a demotion's `tier` and a
  promotion's `fromTier` deliberately address the **same** key, so the two directions order against
  each other.
- New `recordAdoptedTransition(gate, notice)` — monotonic (strictly-newer only), direction from the
  notice kind. Called on **both** adopt paths: the verified-inbound path in `handleInboundNotice`, and
  the **origination** path in the host's `broadcastNotice` (the half previously missing entirely).
- `CoordEngineContext.adoptedTransition?(coord, tier, topicId)` reads that map; `createCoordEngine`
  wires it into the lifecycle as `seedTransition`.

**db-core — `promotion.ts`**

- New optional `PromotionDeps.seedTransition?(topicId)`.
- `stateFor(topicId, now)` seeds a freshly created per-topic state from that record; a seeded promotion
  re-arms `promotedAt = now` (the original sticky anchor is unrecoverable, so demotion is *delayed*,
  never made early). `applyDemotionNotice` changed `_now` → `now` to feed this.
- `isPromoted(topicId)` does a **seed peek** when no in-engine state exists — returning the record's
  direction without creating state, because it has no `now` with which to arm the sticky window.
- Data flow is one-way: node-level map → engine. The engine never writes back.

## Review findings

Reviewed the full implement diff (`git diff 8a18d9a2..HEAD`, 6 source/test files) against the notice
wire types, the `LruMap` implementation, the engine-eviction ranking, and both `isPromoted` consumers
in `member-engine.ts`, before reading the handoff summary.

### Verified correct (no action)

- **Notice-kind discriminator.** `"parentCohortCoord" in notice` is sound — only `DemotionNoticeV1`
  carries that field (`wire/types.ts:210`, `:235`). Confirmed against the interface definitions, not
  inferred.
- **Key derivation agrees across writer and reader.** `promote()` stamps `fromTier` and `demote()`
  stamps `tier` from `deps.treeTier(topicId)`, which `createCoordEngine` binds to the engine's
  constant `treeTier` — the same value `seedTransition` reads with. Write key and seed key match.
- **`LruMap.get` refreshes recency** (`db-core/src/utility/lru-map.ts:13-21`), so both consumers (the
  stale gate and engine seeding) keep an actively-transitioning entry resident. The doc comments now
  say so.
- **Forged notices still write nothing** — the inbound record write is inside the `"applied"` branch;
  origination requires a threshold signature, which the verify-only key-less signer cannot produce.
- **Parent-unlink stays outside the ordering.** Deliberate and unchanged; the dual-role test was left
  untouched and still passes.

### Found and fixed in this pass

- **`docs/cohort-topic.md` was not updated at all, and one claim in it is now inverted.** The
  anti-DoS section stated the map "is a strictly-weaker early-drop optimization, **not** the
  idempotency authority" — precisely backwards after this change, where the map *is* the node's
  replay-ordering authority and the engine layer is the in-process second layer. It also still named
  `PROMOTE_HIGHWATER_MAX_KEYS` and a `(topic, tier)` key. Rewrote that paragraph; added a
  "The ordering outlives the engine" paragraph to §Promotion covering the record, the origination
  write, seeding, and the sticky re-arm; corrected the gate pipeline diagram, the §Demotion
  parenthetical, the eviction-rank table row, and the spec-list wording.
- **Unsound justification for the 8192 cap.** The code comment claimed the cap is "deliberately above
  the 2048-engine registry cap, so seeding never misses for a resident engine". The cap counts
  `(coord, tier, topic)` triples, not engines — a node at the engine cap serving more than ~4 topics
  per coord overflows it. Replaced with what is actually true, plus a `NOTE:` stating the real bound
  and when to raise it.
- **Temporal-dead-zone hazard.** `broadcastNotice` (host.ts ~763) referenced `promoteGate`, declared
  ~45 lines below it, guarded only by a comment reasoning that the closure runs later. Hoisted
  `createPromoteGate` above `broadcastNotice` (it depends only on `options`) and dropped the apology.
- **Missing end-to-end coverage of the actual bug shape.** The promote → demote → evict → replay
  sequence was only covered piecewise (db-core unit for the seed direction, db-p2p for the promoted
  direction). Added `host-antidos-coldstart.spec.ts` — "a DEMOTED transition survives engine
  eviction…", running the whole sequence over the real host gate at tier 1 with a real parent coord.
  Its `isPromoted` assert is explicitly commented as a sanity check, not a seed assertion (a cold
  engine also reports `false`), so the test does not overclaim what it isolates.
- **Two pre-existing nits the handoff listed as untouched.** Removed the unused `bytesEqual` import
  (`live-tier.spec.ts`) and the unused `now` parameter threaded through
  `promotionTriggered` → `slopePredictsCrossing` (`promotion.ts`), documenting why the extrapolation
  needs no `now` (the caller stamps `(now, count)` as the last growth sample first, so
  `samples[last].t === now`).

### Recorded as tripwires (conditional — deliberately not tickets)

- **`hasAdoptedState()` reports only in-engine state**, so a recreated engine whose promoted mode is
  currently visible *only* through the `isPromoted` seed peek answers `false` and ranks 0 in the
  eviction ranking — as evictable as an engine holding nothing. Correctness is unaffected (the record
  survives and re-seeds again); a ranking preference is lost, not state. `NOTE:` at
  `promotion.ts` `hasAdoptedState`, with the fix if thrashing is ever observed.
- **Origination is not monotonic against its own ordering.** `promote()` / `demote()` stamp
  `effectiveAt = now` without consulting `lastEffectiveAt`, while `recordAdoptedTransition` is
  strictly-newer-only. A backwards wall clock (an NTP step) can therefore originate a transition the
  record refuses, leaving the record's direction stale relative to the engine until the next
  forward-clock transition. `NOTE:` at `recordAdoptedTransition` in `host.ts`.

### Considered and deliberately not filed

- **Durability across process restart.** The handoff flagged this as an open design question. It is
  genuinely one — but it is a *feature* decision ("should replay ordering be persisted?"), not a
  defect, and the ticket-filing rules route "should we do this at all" to a human, not to `backlog/`.
  No ticket filed; the tradeoff is now stated plainly in `docs/cohort-topic.md` §Promotion so the next
  person meets it where they are reading, and the transition-cap `NOTE:` names the one combination
  (engine evicted *and* map entry evicted) that reopens the window.
- **`host.ts` size.** 3224 lines, measured `wc -l packages/db-p2p/src/cohort-topic/host.ts`. Large,
  but pre-existing and barely moved by this diff (~+40 net non-comment lines). `grep -rl` over the
  open board found no ticket claiming the file for a split. Not filed: the review rules ask for the
  invariant that retires a class, and "this file is long" has no single root-cause site — a split
  ticket here would be a shape decision for a maintainer, not a defect.
- **Notice `tier` is not cross-checked against the target engine's `treeTier`.** A signed notice whose
  `fromTier` disagrees with the engine at its `cohortCoord` would write a key seeding never reads.
  Unchanged from before this diff (the old key used the same notice-derived `tier`), and it requires a
  valid `≥ minSigs` cohort threshold signature to reach the write, so a legitimate cohort cannot
  produce it. Not a regression and not reachable by an attacker.

### Validation

All from repo root on the reviewed tree. No test was skipped, disabled, or loosened.

| command | result |
| --- | --- |
| `yarn lint` | exit 0, no output |
| `yarn typecheck` (root, all workspaces) | exit 0 |
| `yarn build` (root, all workspaces) | exit 0 |
| `yarn workspace @optimystic/db-core test` | **1473 passing**, 0 failing |
| `yarn workspace @optimystic/db-p2p test` | **2489 passing**, 49 pending, 0 failing (was 2488 — the added test) |

**The handoff's "pre-existing build break" does not reproduce.** It reported root `yarn build` and
`yarn typecheck` red in `@optimystic/quereus-plugin-crypto` (tsup's DTS worker failing to resolve
`@quereus/quereus`). Re-ran `yarn workspace @optimystic/quereus-plugin-crypto build` — "DTS ⚡️ Build
success in 904ms" — then root `yarn build` and root `yarn typecheck`, both green. The
`tickets/.pre-existing-error.md` the handoff said it wrote is not in the tree and was never committed
(`git log` on that path stops at an unrelated older triage). Nothing to file; the tree is clean.

## Pre-existing failures

None encountered. Every suite run during this review passed.
