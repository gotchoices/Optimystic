description: A node records which recent group-resize instructions it has already carried out, but that record lives only inside a working set the node discards under memory pressure — so after discarding it, an old instruction replayed by anyone on the network gets carried out a second time, leaving the node acting on a group layout that no longer exists.
prereq: bug-coord-engine-eviction-exhaustive-liveness
files:
  - packages/db-p2p/src/cohort-topic/host.ts                          # DONE — all src edits landed (see status)
  - packages/db-core/src/cohort-topic/promotion.ts                    # DONE — all src edits landed (see status)
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts          # TODO — rename + new tests (item 14)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts  # TODO — headline regression test (item 15)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts               # TODO — origination-write assert in test 4 (item 16)
  - packages/db-core/test/cohort-topic/promotion.spec.ts              # TODO — seedTransition unit tests (item 17)
difficulty: hard
repro: static
----

# Give the promotion replay anchor a lifetime that outlives the engine

**STATUS: source implementation COMPLETE, tests NOT started, validation NOT run.** A prior run
implemented design items 1–13 exactly as specified (uncommitted working-tree edits to the two src files
above) and was stopped by a budget warning before writing any tests. The next run should:
verify the src diff compiles (`yarn build` — db-p2p resolves db-core's **built** `.d.ts`, so build
db-core first or the editor shows a phantom "`seedTransition` does not exist in PromotionDeps" error),
then implement the four test items below, then run full validation.

## What already landed (do not redo — verify with `git diff` on the two src files)

### db-p2p `src/cohort-topic/host.ts`
- `AdoptedTransition` interface (exported, `{ effectiveAt, promoted }`), placed above `PromoteGate`.
- `PromoteGate.highWater` → `transitions: LruMap<string, AdoptedTransition>`;
  `PROMOTE_HIGHWATER_MAX_KEYS` → `PROMOTE_TRANSITIONS_MAX_KEYS` (still 8192); doc rewritten (map is the
  node's replay-ordering authority; engine is the same-process second layer).
- Exported helpers `transitionKey(cohortCoordB64, tier, topicIdB64)` (`` `${coord}|${tier}|${topic}` ``),
  `noticeTransitionKey(notice)` (demotion → `notice.tier`, promotion → `notice.fromTier`), and
  `recordAdoptedTransition(gate, notice)` (monotonic per key; direction from notice shape).
- `handleInboundNotice` stale gate now reads `gate.transitions.get(noticeTransitionKey(...))`, records
  via `recordAdoptedTransition` only on `"applied"`; log wording updated.
- `broadcastNotice` first line: `recordAdoptedTransition(promoteGate, notice)` (the origination write;
  `promoteGate` declared below the closure — precedented forward capture, commented).
- `CoordEngineContext.adoptedTransition?` reader added; wired **unconditionally** in the ctx literal;
  `createCoordEngine` promotion deps gained
  `seedTransition: (topicId) => ctx.adoptedTransition?.(servedCoord, treeTier, topicId)`.
- Doc renames: `CohortTopicHost.promoteGate` doc, host comment above `createPromoteGate` call,
  `InboundNoticeResult` `"stale"` entry, `handleInboundNotice` pipeline doc block,
  `applyDemotionUnlinkAtParent` doc + inline parent-unlink comment.

### db-core `src/cohort-topic/promotion.ts`
- `PromotionDeps.seedTransition?: (topicId) => { effectiveAt, promoted } | undefined` (inline structural
  type — db-core cannot import from db-p2p).
- `stateFor(topicId, now)`: on first creation seeds `lastEffectiveAt`/`promoted` from
  `deps.seedTransition`, re-arms `promotedAt = now` when seeded promoted (commented: only delays
  demotion), leaves `lowLoadSince` undefined. All three call sites updated
  (`applyDemotionNotice`'s `_now` renamed `now`).
- `isPromoted` seed peek: in-engine state wins; else `deps.seedTransition?.(topicId)?.promoted ?? false`
  (commented why the peek cannot create state).
- Docs updated: module header §Remote apply path (+seed sentence), `PromotionState.lastEffectiveAt`
  (in-engine layer, not the durable anchor), `hasAdoptedState` (ranking preference, not safety).

## Learnings for the next run
- **Pre-existing, not ours:** `slopePredictsCrossing(state, count, now)` in promotion.ts has an unused
  `now` param flagged by the editor. It predates this ticket — leave it.
- Rename scope confirmed by grep: only host.ts + promote-notice.spec.ts use the old
  `highWater`/`PROMOTE_HIGHWATER_MAX_KEYS` identifiers (libp2p-key-network's `highWaterMark` is
  unrelated).
- `validatePromotionNoticeV1` requires `toTier === fromTier + 1`, 32-byte b64url `topicId`/`cohortCoord`,
  and `thresholdSig` passing `b64urlField` — for gate-path fixtures reuse the known-good
  `DUMMY_SIG`/`signers: [<some b64>]` shape from `promotionNoticeAtCoord` (promote-notice.spec.ts ~324)
  rather than `thresholdSig: ''` (unverified whether empty string passes `b64urlField`; the existing
  `promoNoticeFor` helper in host-antidos-coldstart.spec.ts ~772 uses `''` but is only ever fed to
  `applyPromotionNotice` directly, never through `decodeInboundNotice`).
- The headline test's eviction choreography (prereq landed: promotion-holders are rank-1): adopting via
  `handleInboundNotice` bumps A's recency (`findByCoord`); B needs `recordChild` to be rank-1 too, else
  a spray never evicts A.

## Remaining work (test items 14–17 of the resolved design, then validation)

### 14. `promote-notice.spec.ts`
- Mechanical rename: import + uses of `PROMOTE_HIGHWATER_MAX_KEYS` → `PROMOTE_TRANSITIONS_MAX_KEYS`,
  `gate.highWater` → `gate.transitions`; cap test (~549) sets `{ effectiveAt: 1_000 + i, promoted: true }`
  objects; forged-flood test (~595) rename only; dual-role test comment ~729 ("advanced the COORD
  high-water") reword.
- Rewrite the ~563 test's COMMENT (assertions unchanged — no engine is evicted there): the MAP is the
  authority; the resident engine is the same-process second layer that idempotently no-ops the replay.
- Add `recordAdoptedTransition` unit tests: monotonic per key (older/equal effectiveAt never
  overwrites), direction recorded (promotion→true, demotion→false), demotion keys off `notice.tier`
  (equal to a promotion's `fromTier` at the same coord/tier/topic → same key).
- Add **two topics, one (coord, tier)** test in the anti-abuse-gate describe: apply topic-A notice via
  `handleInboundNotice` with the file's `trustAllVerifier` (~317), then a topic-B notice at the same
  coord with `effectiveAt <=` A's — must be `"applied"`, not `"stale"` (fails on the old key). Build a
  topic-parameterized variant of `promotionNoticeAtCoord`. Sanity: replay of A at the same effectiveAt
  is `"stale"`. Existing parent-unlink replay test (~704) must stay green.

### 15. `host-antidos-coldstart.spec.ts` — the headline regression test
In the `coord-engine registry cap` describe. Key-less harness; import `handleInboundNotice` (+
`transitionKey` if asserting the map write) from host.js and add `type MembershipVerifier` to the
db-core import; local ~5-line trust-all verifier stub (copy from promote-notice.spec.ts ~317). Use a
**validator-passing** promotion notice fixture at coord0/tier 0 (fromTier 0, toTier 1, DUMMY_SIG-style
sig — see learnings). Cap = 2:
1. `forCoord(A)`; adopt promotion for topic T at A (effectiveAt 10_000) through `handleInboundNotice`
   → `"applied"`; optionally assert `host.promoteGate.transitions` holds `{10_000, true}` under
   `transitionKey(b64(A), 0, b64(T))`.
2. `forCoord(B)`; `B.recordChild(...)` → rank-1 companion.
3. `forCoord(C)` → evicts A. Assert `findByCoord(A) === undefined`.
4. `forCoord(A)` again → recreates (evicts rank-0 C). Assert `engine.isPromoted(T) === true` with NO
   replay (the second arm), then replay the SAME notice via `handleInboundNotice` → `"stale"`, state
   unchanged.

### 16. `live-tier.spec.ts` test 4 (~173)
After the existing `waitFor(decidingEngine.isPromoted)`: `waitFor` on
`deciding.host.promoteGate.transitions.get(transitionKey(bytesToB64url(coord0), 0, bytesToB64url(TOPIC)))`
defined with `promoted === true` — proves the origination path writes the map (self-exclusion means
nothing else can have). `waitFor`, not a direct read: `onNotice` fires after the threshold-sign resolves.

### 17. `promotion.spec.ts` (db-core)
`lifecycleWith` gains an optional `seed` param feeding `deps.seedTransition`. Tests:
- seeded `{effectiveAt: 200, promoted: true}` → `isPromoted` true with zero prior calls (the peek);
- seeded promoted + `onParticipantCountChange(t0)` then `maybeDemote` inside `t0 + sticky` window with
  low count → undefined (promotedAt re-armed at seed);
- seeded `{effectiveAt: 200, promoted: false}` → `applyPromotionNotice(effectiveAt 100)` is a no-op;
- no seed / seed returning undefined → behavior identical to today (existing suite is the guard).
Also update the census comment block (~249-258) wording: node-level record now backstops eviction;
ranking is a preference.

### Validation
`yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test` (inner loop:
`--grep "promot"`), `yarn build` + `yarn typecheck` from root. Foreground, no redirection. Remember:
build db-core before typechecking db-p2p.

## Edge cases to preserve (all covered by the test plan above)
- Replay after eviction+recreation → `"stale"`, state unchanged (test 15).
- Correct `promoted = true` survives eviction with no replay (test 15 step 4).
- Locally-originated transitions write the map (test 16).
- Two topics at one coord: independent orderings (test 14).
- Two sibling cohorts for one `(topic, tier)`: coord stays in the key (existing test ~486, renamed).
- Forged notices write nothing (existing test ~595, renamed).
- Map LRU eviction beyond cap (existing test ~549 against new value type).
- Parent-unlink stays outside this ordering — `"unlinked"` must not regress to `"stale"` (existing ~704).
- Seeded demotion still rejects stale promotion replay (test 17).
- Key-less composition: `seedTransition`/`adoptedTransition` optional; anti-DoS harness is key-less and
  must work (test 15 relies on it).
- Prereq interaction: promotion-holders are rank-1 — eviction in tests must be forced via a rank-1
  companion, never assumed (test 15 step 2).

## Original problem statement (context, unchanged)

Cohort-topic groups split when busy, merge when quiet; each transition is a threshold-signed
`PromotionNoticeV1`/`DemotionNoticeV1` stamped `effectiveAt`. Signatures never expire — ordering is the
only replay defense. Pre-fix, two anchors each cited the other as backstop: the node-level
`PromoteGate.highWater` (written ONLY on verified inbound applies, keyed `coord|tier` — conflating
topics) and the engine-level `PromotionState.lastEffectiveAt` (living in a `CoordEngine` the registry
evicts under memory pressure). A node that ORIGINATES transitions never wrote its own water
(`broadcastOver` excludes self), so originate promote@100 / demote@200, evict the engine, and anyone
replaying the captured promote@100 re-promotes a demoted cohort; symmetrically, eviction discarded a
CORRECT `promoted = true`. The fix (now landed in src): the gate map stores `{effectiveAt, promoted}`
keyed `coord|tier|topic`, written on BOTH adopt paths, and seeds a freshly created engine's per-topic
state (one-way: map → engine).
